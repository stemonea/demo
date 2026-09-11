import { memo, useMemo, useState } from 'react'
import { Cooccurrence, EntityProfiles, MentionTimeline } from './charts/Charts'
import { narrow, type DebateStats } from '../lib/analytics'
import './LiveCharts.css'

/**
 * How many entities each figure draws.
 *
 * A real debate names a couple of hundred things and most of them once. A
 * figure that tried to draw all of them would be unreadable at any size, so it
 * draws the ones that carry the debate - and says, in its own caption, how
 * many it left out, which is the part that keeps it honest against the totals
 * above it.
 *
 * Ten is where it opens and no longer where it ends: which names carry a
 * debate is the reader's question, not the figure's, and the answer changes
 * between a debate twenty turns in and one that has run its course. Five is a
 * glance, twenty is the tail, and the caption says what each of them leaves
 * out.
 */
const ROWS = [5, 10, 20] as const
const TOP = 10

interface Props {
  /** the same aggregation the panels above are drawn from */
  stats: DebateStats
  /** the entity keys the explorer above is currently holding */
  picked: ReadonlySet<string>
  /** add or remove one entity from that filter */
  onPickEntity: (key: string) => void
  /** hold both halves of a pair, so the components that contain both are shown */
  onPickPair: (a: string, b: string) => void
}

/**
 * The figures the analytics deck draws, under the live debate.
 *
 * They used to exist only on the Analytics page, over a transcript that had
 * already finished - which meant the one view where the numbers are actually
 * moving was the one view that could not show them. Nothing here is a second
 * computation: `analyse` is already recomputed on every turn for the panels
 * above, and these are further readings of the same object, so they cannot
 * disagree with it and they land at the same moment the turn does.
 *
 * The speakers × entities heatmap that used to open the band is not here. It
 * needs a column per entity and a row per speaker, and in half the width of
 * this band that is a grid of cells too small to read a number in - a figure
 * that has to be squinted at is not a figure. It stays on the Analytics page,
 * which gives it a full slide.
 */
function LiveCharts({ stats, picked, onPickEntity, onPickPair }: Props) {
  /* how many rows every figure draws */
  const [rows, setRows] = useState<number>(TOP)
  /* drop the tail of things named exactly once */
  const [repeated, setRepeated] = useState(false)
  /* count a name only where it was put inside an argument */
  const [argued, setArgued] = useState(false)

  /*
   * The figures' own reading of the debate.
   *
   * Memoised on the aggregation and the three switches rather than recomputed
   * per figure: all three draw from one list, and filtering it once is what
   * keeps them saying the same thing as each other.
   */
  const drawn = useMemo(
    () => narrow(stats, { argumentativeOnly: argued, minMentions: repeated ? 2 : 1 }),
    [stats, argued, repeated],
  )

  /* the controls are offered against the debate, not against what the switches
     have left of it, so a lens that empties a figure can still be undone */
  const enough = stats.entities.length > 0 && stats.turns > 0

  return (
    <section className="deep" aria-label="Deeper statistics">
      <header className="deep__head">
        <div>
          <span className="eyebrow">The same numbers, cut three more ways</span>
          <h3 className="display deep__title">Who argues what</h3>
        </div>
        <p className="deep__lead">
          Recomputed on every turn, from the annotations above - the whole debate so far, not the filtered list.
          Press an entity or a pair to send it up to the explorer.
        </p>
      </header>

      {/*
        What the figures are asked to draw, above all three of them.

        The switches belong here and not on each cell: they are one reading of
        one list, and three copies of them would invite three figures that
        disagree. Each says what it does rather than what it hides, so a figure
        that has been narrowed reads as an answer to a question somebody asked.
      */}
      {enough && (
        <div className="deep__controls">
          <span className="deep__control">
            <span className="deep__control-label">rows</span>
            {ROWS.map((count) => (
              <button
                type="button"
                key={count}
                className={`toggle${rows === count ? ' is-on' : ''}`}
                onClick={() => setRows(count)}
                aria-pressed={rows === count}
                title={`Draw the ${count} names each figure ranks highest`}
              >
                {count}
              </button>
            ))}
          </span>

          <button
            type="button"
            className={`toggle${repeated ? ' is-on' : ''}`}
            onClick={() => setRepeated((on) => !on)}
            aria-pressed={repeated}
            title="Leave out every name the debate has said exactly once"
          >
            Said more than once
          </button>

          <button
            type="button"
            className={`toggle${argued ? ' is-on' : ''}`}
            onClick={() => setArgued((on) => !on)}
            aria-pressed={argued}
            title="Count a name only where it sits inside a claim or a premise, never where it is merely mentioned"
          >
            Argued with, not named
          </button>

          {(repeated || argued || rows !== TOP) && (
            <button type="button" className="deep__reset" onClick={() => { setRows(TOP); setRepeated(false); setArgued(false) }}>
              reset
            </button>
          )}
        </div>
      )}

      {!enough ? (
        <p className="deep__empty">
          Nothing to aggregate yet - the figures appear as soon as the first entity is named inside an argument.
        </p>
      ) : (
        <div className="deep__grid">
          <section className="cell deep__cell" data-steady>
            <h4 className="cell__head">
              How each entity is used
              <span className="cell__count">
                {Math.min(rows, drawn.entities.length)}
                <span className="cell__count-of">of {drawn.entities.length}</span>
              </span>
            </h4>
            <EntityProfiles stats={drawn} limit={rows} picked={picked} onPick={onPickEntity} />
          </section>

          <section className="cell deep__cell" data-steady>
            <h4 className="cell__head">
              Invoked together
              <span className="cell__count">
                {Math.min(rows, drawn.cooccurrence.length)}
                <span className="cell__count-of">of {drawn.cooccurrence.length}</span>
              </span>
            </h4>
            {/*
              The figure the joint schema exists to produce: two names inside
              one claim. A sequential pipeline knows the debate mentioned both
              and cannot know they were asserted together, because it has lost
              the span by the time it has the entities.
            */}
            <Cooccurrence stats={drawn} limit={rows} picked={picked} onPick={onPickPair} />
          </section>

          <section className="cell deep__cell deep__cell--wide" data-steady>
            <h4 className="cell__head">
              Turn by turn
              <span className="cell__count">
                {stats.turns}
                <span className="cell__count-of">turns so far</span>
              </span>
            </h4>
            {/* the whole debate, scrolling: it rides the newest turn on its own
                and lets go the moment the reader scrolls back, so a paused
                debate can be read from turn one */}
            <MentionTimeline stats={drawn} limit={rows} />
          </section>
        </div>
      )}
    </section>
  )
}

/*
 * Memoised on the aggregation it draws.
 *
 * The explorer above these figures has state of its own - a search box, a tab,
 * a set of filters - and none of it changes what they show: they are the whole
 * debate, narrowed by nothing but their own row of switches. Without this,
 * every keystroke in the entity search redrew three charts and two thousand
 * timeline cells for no change at all.
 */
export default memo(LiveCharts)
