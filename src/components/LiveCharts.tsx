import { memo } from 'react'
import { Cooccurrence, EntityProfiles, MentionTimeline } from './charts/Charts'
import type { DebateStats } from '../lib/analytics'
import './LiveCharts.css'

/**
 * How many entities each figure draws.
 *
 * A real debate names a couple of hundred things and most of them once. A
 * figure that tried to draw all of them would be unreadable at any size, so it
 * draws the ones that carry the debate — and says, in its own caption, how
 * many it left out, which is the part that keeps it honest against the totals
 * above it.
 */
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
 * already finished — which meant the one view where the numbers are actually
 * moving was the one view that could not show them. Nothing here is a second
 * computation: `analyse` is already recomputed on every turn for the panels
 * above, and these are further readings of the same object, so they cannot
 * disagree with it and they land at the same moment the turn does.
 *
 * The speakers × entities heatmap that used to open the band is not here. It
 * needs a column per entity and a row per speaker, and in half the width of
 * this band that is a grid of cells too small to read a number in — a figure
 * that has to be squinted at is not a figure. It stays on the Analytics page,
 * which gives it a full slide.
 */
function LiveCharts({ stats, picked, onPickEntity, onPickPair }: Props) {
  const enough = stats.entities.length > 0 && stats.turns > 0

  return (
    <section className="deep" aria-label="Deeper statistics">
      <header className="deep__head">
        <div>
          <span className="eyebrow">The same numbers, cut three more ways</span>
          <h3 className="display deep__title">Who argues what</h3>
        </div>
        <p className="deep__lead">
          Recomputed on every turn, from the annotations above — the whole debate so far, not the filtered list.
          Press an entity or a pair to send it up to the explorer.
        </p>
      </header>

      {!enough ? (
        <p className="deep__empty">
          Nothing to aggregate yet — the figures appear as soon as the first entity is named inside an argument.
        </p>
      ) : (
        <div className="deep__grid">
          <section className="cell deep__cell">
            <h4 className="cell__head">
              How each entity is used
              <span className="cell__count">
                {Math.min(TOP, stats.entities.length)}
                <span className="cell__count-of">of {stats.entities.length}</span>
              </span>
            </h4>
            <EntityProfiles stats={stats} limit={TOP} picked={picked} onPick={onPickEntity} />
          </section>

          <section className="cell deep__cell">
            <h4 className="cell__head">
              Invoked together
              <span className="cell__count">
                {Math.min(8, stats.cooccurrence.length)}
                <span className="cell__count-of">of {stats.cooccurrence.length}</span>
              </span>
            </h4>
            {/*
              The figure the joint schema exists to produce: two names inside
              one claim. A sequential pipeline knows the debate mentioned both
              and cannot know they were asserted together, because it has lost
              the span by the time it has the entities.
            */}
            <Cooccurrence stats={stats} limit={8} picked={picked} onPick={onPickPair} />
          </section>

          <section className="cell deep__cell deep__cell--wide">
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
            <MentionTimeline stats={stats} limit={TOP} />
          </section>
        </div>
      )}
    </section>
  )
}

/*
 * Memoised on the aggregation it draws.
 *
 * The explorer above these figures has state of its own — a search box, a tab,
 * a set of filters — and none of it changes what they show: they are the whole
 * debate, always. Without this, every keystroke in the entity search redrew
 * three charts and two thousand timeline cells for no change at all.
 */
export default memo(LiveCharts)
