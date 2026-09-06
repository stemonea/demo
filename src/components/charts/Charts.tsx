import { useEffect, useRef, useState } from 'react'
import type { DebateStats, EntityStat } from '../../lib/analytics'
import './Charts.css'

/**
 * Three small inline-SVG charts, no library.
 *
 * Colour carries one job only: the two argument components are the categorical
 * pair (claim / premise, validated for colour-vision deficiency against the page
 * surface), and "outside an argument" is a deliberate neutral that is always
 * spelled out in the legend and in the numbers, never left to colour alone.
 */

const CLAIM = 'var(--tag-claim)'
const PREMISE = 'var(--tag-premise)'
const OUTSIDE = 'var(--chart-neutral)'

/* ------------------------------------------------------------------ *
 * Who argues what: speaker x entity heatmap                           *
 * ------------------------------------------------------------------ */

interface HeatmapProps {
  stats: DebateStats
  /** how many entities to show before the tail is dropped */
  limit?: number
}

/** A chart the page around it can turn into a filter. */
interface PickableProps extends HeatmapProps {
  /** called with the entity key of the row that was pressed */
  onPick?: (key: string) => void
  /** the keys currently being held, so the chart can mark them */
  picked?: ReadonlySet<string>
}

export function WhoArguesWhat({ stats, limit = 8 }: HeatmapProps) {
  const entities = stats.entities.filter((entity) => entity.claim + entity.premise > 0).slice(0, limit)
  const speakers = stats.speakers.map((speaker) => speaker.speaker)
  const value = (speaker: string, key: string) =>
    stats.matrix.find((cell) => cell.speaker === speaker && cell.key === key)?.count ?? 0
  const max = Math.max(1, ...stats.matrix.map((cell) => cell.count))

  if (!entities.length || !speakers.length) return <Empty />

  return (
    <figure className="chart">
      <figcaption className="chart__caption">
        Times each speaker puts an entity <strong>inside</strong> one of their argument components.{' '}
        <Shown count={entities.length} of={stats.entities.length} />
      </figcaption>

      <div className="matrix" style={{ ['--cols' as string]: entities.length }}>
        <span className="matrix__corner" />
        {entities.map((entity) => (
          <span className="matrix__col-label" key={entity.key} title={entity.label}>
            {entity.label}
          </span>
        ))}

        {speakers.map((speaker) => (
          <Row key={speaker} speaker={speaker} entities={entities} value={value} max={max} />
        ))}
      </div>

      <div className="chart__legend">
        <span className="chart__ramp" aria-hidden="true" />
        <span className="chart__legend-text">
          0 mentions to {max} — cells carry their own number, so the shade is only a second reading.
        </span>
      </div>
    </figure>
  )
}

function Row({
  speaker,
  entities,
  value,
  max,
}: {
  speaker: string
  entities: EntityStat[]
  value: (speaker: string, key: string) => number
  max: number
}) {
  return (
    <>
      <span className="matrix__row-label">{speaker}</span>
      {entities.map((entity) => {
        const count = value(speaker, entity.key)
        return (
          <span
            key={entity.key}
            className={`matrix__cell${count ? '' : ' is-empty'}`}
            style={{ ['--weight' as string]: count ? 0.14 + (count / max) * 0.86 : 0 }}
            title={`${speaker} — ${entity.label}: ${count} argumentative mention${count === 1 ? '' : 's'}`}
          >
            {count || ''}
          </span>
        )
      })}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Entity profiles: claim / premise / outside                          *
 * ------------------------------------------------------------------ */

export function EntityProfiles({ stats, limit = 7, onPick, picked }: PickableProps) {
  const entities = stats.entities.slice(0, limit)
  const max = Math.max(1, ...entities.map((entity) => entity.total))

  if (!entities.length) return <Empty />

  return (
    <figure className="chart">
      <figcaption className="chart__caption">
        How each entity is used: advanced <strong>inside a claim</strong>, offered <strong>inside a premise</strong>,
        or merely mentioned. <Shown count={entities.length} of={stats.entities.length} />
      </figcaption>

      <ul className="bars">
        {entities.map((entity) => {
          const on = picked?.has(entity.key) ?? false
          const bar = (
            <>
              <span className="bars__label" title={`${entity.label} · ${entity.type}`}>
                {entity.label}
              </span>
              <span className="bars__track" style={{ ['--fill' as string]: `${(entity.total / max) * 100}%` }}>
                <Segment width={entity.claim / entity.total} color={CLAIM} label={`in claims: ${entity.claim}`} />
                <Segment
                  width={entity.premise / entity.total}
                  color={PREMISE}
                  label={`in premises: ${entity.premise}`}
                />
                <Segment width={entity.outside / entity.total} color={OUTSIDE} label={`outside: ${entity.outside}`} />
              </span>
              <span className="bars__value">{entity.total}</span>
            </>
          )

          /* the chart is also a control wherever the page that holds it has
             somewhere to send the pick: reading a row and then having to find
             the same name again in a list is the step worth removing */
          return onPick ? (
            <li key={entity.key}>
              <button
                type="button"
                className={`bars__row bars__row--pick${on ? ' is-on' : ''}`}
                onClick={() => onPick(entity.key)}
                aria-pressed={on}
                title={on ? `Stop filtering by ${entity.label}` : `Read the components that mention ${entity.label}`}
              >
                {bar}
              </button>
            </li>
          ) : (
            <li className="bars__row" key={entity.key}>
              {bar}
            </li>
          )
        })}
      </ul>

      <Legend />
    </figure>
  )
}

function Segment({ width, color, label }: { width: number; color: string; label: string }) {
  if (width <= 0) return null
  return <span className="bars__seg" style={{ width: `${width * 100}%`, background: color }} title={label} />
}

/* ------------------------------------------------------------------ *
 * Timeline: mentions turn by turn                                     *
 * ------------------------------------------------------------------ */

/**
 * When each entity enters the debate, and how it is used at that moment.
 *
 * The grid is the whole debate, always — a running debate used to be drawn as
 * a window on its last stretch, which kept the newest turns in view at the
 * price of the early ones being unreachable. A reader who pauses to look at
 * how something started could not get back to turn one at all, which is the
 * opposite of what a timeline is for. So every turn is drawn, the row scrolls,
 * and the scroll follows the end on its own until the reader takes it
 * somewhere else.
 */
/**
 * How near the right-hand end still counts as following the debate.
 *
 * It has to be wider than one turn column, because the timeline snaps: asking
 * it for the far end leaves it resting on the last column's edge, a few pixels
 * short of the true maximum. Measured against the old 24px, that shortfall read
 * as the reader having scrolled away, and a live debate silently stopped
 * following itself after the first turn. One column is 34px plus the 2px gap,
 * so this clears it with room to spare — and it doubles as the slack a reader
 * needs before a nudge of the wheel is taken for leaving the front.
 */
const FOLLOW_SLACK = 48

export function MentionTimeline({ stats, limit = 7 }: HeatmapProps) {
  const scroller = useRef<HTMLDivElement>(null)
  /*
   * Whether the view is riding the end of the debate.
   *
   * It is a ref as well as state because the two are needed at different
   * moments: the ref is what the arrival of a turn consults, the state is what
   * the button renders. Keeping only the state would mean the effect reading
   * whatever value was captured when the turn count last changed, which is not
   * the same as what the reader has since done with the scrollbar.
   */
  const following = useRef(true)
  const [follow, setFollow] = useState(true)
  /* the turn count as of the last look, so a mount is not mistaken for a new
     turn: a finished transcript opens at its beginning, not at its end */
  const seen = useRef(stats.turns)

  const entities = stats.entities.slice(0, limit)
  const turns = Array.from({ length: stats.turns }, (_, i) => i)

  function sync(node: HTMLDivElement) {
    const atEnd = node.scrollWidth - node.clientWidth - node.scrollLeft < FOLLOW_SLACK
    following.current = atEnd
    setFollow((was) => (was === atEnd ? was : atEnd))
  }

  useEffect(() => {
    const node = scroller.current
    if (!node) return
    if (stats.turns > seen.current && following.current) node.scrollLeft = node.scrollWidth
    seen.current = stats.turns
    sync(node)
  }, [stats.turns])

  function onScroll() {
    const node = scroller.current
    if (node) sync(node)
  }

  function jump(to: 'start' | 'end') {
    const node = scroller.current
    if (!node) return
    node.scrollTo({ left: to === 'start' ? 0 : node.scrollWidth, behavior: 'smooth' })
  }

  /*
   * The mentions, indexed once.
   *
   * This chart is redrawn on every turn of a live debate, and a cell that
   * scans the whole mention list to find its own dots is an entities x turns x
   * mentions sweep on each of those redraws. One pass building the index costs
   * what a single cell used to.
   */
  const byCell = new Map<string, DebateStats['mentions']>()
  for (const mention of stats.mentions) {
    const id = `${mention.key}\u241f${mention.turn}`
    const found = byCell.get(id)
    if (found) found.push(mention)
    else byCell.set(id, [mention])
  }

  if (!entities.length || !turns.length) return <Empty />

  return (
    <figure className="chart">
      <figcaption className="chart__caption">
        When each entity enters the debate, and how it is used at that moment.{' '}
        <Shown count={entities.length} of={stats.entities.length} />
      </figcaption>

      {/* the way back to the beginning, and the way back to the front: a
          timeline of a debate in progress is read from both ends */}
      <div className="chart__nav">
        <button type="button" className="chart__jump" onClick={() => jump('start')}>
          ⇤ first turn
        </button>
        <button
          type="button"
          className={`chart__jump${follow ? ' is-on' : ''}`}
          onClick={() => jump('end')}
          title={follow ? 'The view is following the newest turn' : 'Go back to the newest turn and follow it again'}
        >
          latest ⇥
        </button>
        <span className="chart__nav-note">
          {follow ? 'following the debate' : `holding still — ${turns.length} turns in all`}
        </span>
      </div>

      <div className="timeline" style={{ ['--turns' as string]: turns.length }} ref={scroller} onScroll={onScroll}>
        <span className="timeline__corner" />
        {turns.map((turn) => (
          <span className="timeline__head" key={turn}>
            {turn + 1}
          </span>
        ))}

        {entities.map((entity) => (
          <TimelineRow key={entity.key} entity={entity} turns={turns} byCell={byCell} />
        ))}
      </div>

      <Legend />
    </figure>
  )
}

/**
 * The most dots one cell draws before it starts counting instead. Three is what
 * fits a turn column at its narrowest without touching its neighbour.
 */
const DOTS_PER_CELL = 3

function TimelineRow({
  entity,
  turns,
  byCell,
}: {
  entity: EntityStat
  turns: number[]
  byCell: Map<string, DebateStats['mentions']>
}) {
  return (
    <>
      {/* the box is the whole row, so it can hide what travels under it; the
          name inside it is what carries the truncation */}
      <span className="timeline__label" title={entity.label}>
        <span className="timeline__name">{entity.label}</span>
      </span>
      {turns.map((turn) => {
        const here = byCell.get(`${entity.key}\u241f${turn}`) ?? []
        /*
         * A cell is one turn wide, and a turn that named the same entity five
         * times would lay five dots across a column that has room for three.
         * They used to simply overrun: on to the neighbouring turns, and — at
         * the left edge of a scrolled timeline — underneath the column of
         * names, where a dot reappeared as a half circle past the rule and
         * read as belonging to the name rather than to a turn. So the row
         * draws what fits and counts the rest, which is the same bargain the
         * figures above make when they show ten entities out of two hundred.
         */
        const drawn = here.slice(0, DOTS_PER_CELL)
        const rest = here.length - drawn.length
        return (
          <span className="timeline__cell" key={turn}>
            {drawn.map((mention, i) => (
              <span
                key={i}
                className={`timeline__dot timeline__dot--${mention.inside ?? 'outside'}`}
                title={`Turn ${turn + 1} · ${mention.speaker}: “${mention.surface}” ${
                  mention.inside ? `inside a ${mention.inside}` : 'outside any argument'
                }`}
              />
            ))}
            {rest > 0 && (
              <span
                className="timeline__more"
                title={`${here.length} mentions in turn ${turn + 1}: ${here
                  .map((mention) => `“${mention.surface}”`)
                  .join(', ')}`}
              >
                +{rest}
              </span>
            )}
          </span>
        )
      })}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Invoked together: entity pairs inside one argument component        *
 * ------------------------------------------------------------------ */

/**
 * The pairs of entities that turn up inside the same claim or premise.
 *
 * This is the figure the joint schema exists to produce. A sequential pipeline
 * can tell you that a debate mentioned a person and a date; it cannot tell you
 * that they were named *in the same assertion*, because the argument spans are
 * gone by the time it does the entities. Every pair below is one component
 * that held both.
 */
export function Cooccurrence({
  stats,
  limit = 6,
  onPick,
  picked,
}: HeatmapProps & {
  /** called with both entity keys of the pair that was pressed */
  onPick?: (a: string, b: string) => void
  picked?: ReadonlySet<string>
}) {
  const pairs = stats.cooccurrence.slice(0, limit)
  const nameOf = (key: string) => stats.entities.find((entity) => entity.key === key)?.label ?? key

  if (!pairs.length) return <p className="chart__empty">No two entities have shared a component yet.</p>

  return (
    <section className="pairs">
      <ul className="pairs__list">
        {pairs.map((pair) => {
          const on = Boolean(picked?.has(pair.a) && picked?.has(pair.b))
          const body = (
            <>
              <span>{nameOf(pair.a)}</span>
              <span className="pairs__link" aria-hidden="true" />
              <span>{nameOf(pair.b)}</span>
              <span className="pairs__count">{pair.count}×</span>
            </>
          )

          /* pressing a pair asks for exactly the components that hold both,
             which is the question the pair raises and the one the explorer
             above can answer */
          return onPick ? (
            <li key={`${pair.a}-${pair.b}`}>
              <button
                type="button"
                className={`pairs__item pairs__item--pick${on ? ' is-on' : ''}`}
                onClick={() => onPick(pair.a, pair.b)}
                aria-pressed={on}
                title={`Read the ${pair.count} component${pair.count === 1 ? '' : 's'} that name both`}
              >
                {body}
              </button>
            </li>
          ) : (
            <li className="pairs__item" key={`${pair.a}-${pair.b}`}>
              {body}
            </li>
          )
        })}
      </ul>
      <p className="pairs__note">Entities that appear inside the same argument component.</p>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Shared pieces                                                       *
 * ------------------------------------------------------------------ */

function Legend() {
  return (
    <div className="chart__legend">
      <span className="chart__key" style={{ ['--key' as string]: CLAIM }}>
        In a claim
      </span>
      <span className="chart__key" style={{ ['--key' as string]: PREMISE }}>
        In a premise
      </span>
      <span className="chart__key" style={{ ['--key' as string]: OUTSIDE }}>
        Outside any argument
      </span>
    </div>
  )
}

function Empty() {
  return <p className="chart__empty">Nothing to aggregate yet.</p>
}

/**
 * How much of the debate a figure is actually drawing.
 *
 * A chart that quietly shows the top eight of a hundred and eighty names is a
 * chart that disagrees with the totals above it, and the reader has no way of
 * telling. Saying so is one clause and settles it.
 */
function Shown({ count, of }: { count: number; of: number }) {
  if (of <= count) return null
  return (
    <span className="chart__shown">
      The {count} most-named of {of}, by how often they are said.
    </span>
  )
}
