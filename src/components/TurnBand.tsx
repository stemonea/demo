import { useState } from 'react'
import TaggedText from './TaggedText'
import TokenStream from './TokenStream'
import { SYSTEMS, type SystemId } from '../data/systems'
import { SPEAKER_PREFIX, type FeedTurn } from '../lib/transcript'
import type { SystemRun } from '../lib/api'
import { ms } from '../lib/duration'
import type { LayerView } from '../lib/view'
import './TurnBand.css'

/**
 * The ways of being run that a reader could take for something they are not,
 * and what each one actually means. A system served by its own trained model is
 * absent on purpose: it needs no caveat, and marking every cell would turn a
 * warning into wallpaper.
 */
const MISREADABLE: Record<string, string> = {
  composed:
    'Both stages of this pipeline were run by the joint model asked one layer at a time \u2014 each stage given its own instruction, with nothing said about the other layer. The structure of the loss is real; the accuracy and the time are not a trained stage\u2019s.',
  mixed:
    'One stage of this pipeline has a model of its own; the other was the joint model asked that stage\u2019s instruction alone, so this time is part measurement and part stand-in.',
  stub: 'Answered by the rule-based stand-in, not by a model.',
}

/**
 * What one turn cost, across the three systems.
 *
 * The map is partial because a row is on screen before it is finished: the
 * bench reveals one column at a time, and a system that has not answered yet has
 * no entry rather than an empty one.
 */
export interface TurnRow {
  turn: FeedTurn
  runs: Partial<Record<SystemId, SystemRun>>
}

/**
 * One turn across the three columns.
 *
 * The turn itself is written once, above the three, because it is the one thing
 * they have in common and repeating it three times would make the row about the
 * transcript rather than about what the systems did with it. Each cell carries
 * its own time and a bar drawn against the slowest of the three *on this row* —
 * the comparison being made is within the turn, not against the whole run, so
 * the scale is the row's.
 *
 * Shared by the two views that make this measurement: the one that works a
 * transcript through on its own, and the one the reader steps by hand. They ask
 * the same question and must not answer it in two different-looking ways.
 */
export default function TurnBand({
  row,
  view,
  mode = 'rendered',
  numbered = true,
  generating = null,
}: {
  row: TurnRow
  view: LayerView
  /** the annotation as marked-up prose, or as the markup itself */
  mode?: 'rendered' | 'raw'
  /** off for a single typed turn, where "01" is a count of one */
  numbered?: boolean
  /**
   * The system still producing, if one is: its cell shows the field of symbols
   * settling into tags instead of an answer. `'all'` is a service answering the
   * three in one call, where none of them can be shown before the others.
   */
  generating?: SystemId | 'all' | null
}) {
  /*
   * The turn is folded away, not printed.
   *
   * It is the one thing the three columns have in common, and it is also the
   * longest thing on the row: a debate turn runs to a paragraph, and printed in
   * full above every band it would push the readings — which are what the row
   * is for — off the screen. So the head keeps who is speaking and how long the
   * turn is, and the words themselves are one press away for whoever wants to
   * check an annotation against its source.
   */
  const [open, setOpen] = useState(false)
  const source = row.turn.text.replace(SPEAKER_PREFIX, '').trim()
  const times = SYSTEMS.map((system) => row.runs[system.id]?.elapsedMs).filter(
    (value): value is number => typeof value === 'number',
  )
  const slowest = times.length ? Math.max(...times) : 0
  const quickest = times.length ? Math.min(...times) : 0

  return (
    <article className="band">
      <header className="band__head">
        {numbered && <span className="band__index">{String(row.turn.index + 1).padStart(2, '0')}</span>}
        {row.turn.speaker && <span className="band__speaker">{row.turn.speaker}</span>}
        <span className="band__size">{source.length} characters</span>
        <button
          type="button"
          className={`band__peek${open ? ' is-open' : ''}`}
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
        >
          {open ? 'Hide the turn' : 'Show the turn'}
        </button>
      </header>

      {open && (
        /* the source, once, and only when it was asked for. The speaker prefix
           is dropped: the name is already in the head, and printing it again
           makes the line read as a stutter */
        <p className="band__source">{source}</p>
      )}

      <div className="band__cells">
        {SYSTEMS.map((system) => {
          const answer = row.runs[system.id]
          const elapsed = answer?.elapsedMs ?? null
          const quickestHere = elapsed !== null && elapsed === quickest && times.length > 1
          const working = generating === 'all' || generating === system.id

          if (working) {
            return (
              <div className="band__cell band__cell--working" key={system.id}>
                <div className="band__clock">
                  <span className="band__working">generating</span>
                </div>
                {/* this system's own field, in this system's own column: three
                    columns sharing one animation would say that one thing is
                    happening, and three separate things are */}
                <TokenStream fit="width" rows={4} tickMs={120} className="stream--cell" />
              </div>
            )
          }

          return (
            <div className={`band__cell${quickestHere ? ' is-quickest' : ''}`} key={system.id}>
              <div className="band__clock">
                {elapsed === null ? (
                  /*
                   * Never a zero. A turn replayed from the reported answers was
                   * not computed here, and printing a number for it would be
                   * inventing the very figure these columns exist to compare.
                   */
                  <span className="band__unmeasured">not measured</span>
                ) : (
                  <>
                    <span className="band__ms">{ms(elapsed)}</span>
                    <span className="band__bar" aria-hidden="true">
                      <span
                        className="band__fill"
                        style={{ width: `${slowest ? (elapsed / slowest) * 100 : 0}%` }}
                      />
                    </span>
                  </>
                )}
              </div>
              {answer ? (
                <div className="band__reading" data-scroll>
                  <TaggedText text={answer.tagged} mode={mode} view={view} />
                </div>
              ) : (
                <p className="band__missing">no answer</p>
              )}
              {/*
                * Said on the cell, never in a banner: a pipeline the service ran
                * by composing the joint model with itself reproduces the shape
                * of the loss but not a second model's accuracy, and its time is
                * not a trained stage's time. Only the cases that could be
                * misread are named — a system served by its own model says
                * nothing, because there is nothing to warn about.
                */}
              {answer && MISREADABLE[answer.servedBy ?? ''] && (
                <span className="band__served" title={MISREADABLE[answer.servedBy ?? '']}>
                  {answer.servedBy}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </article>
  )
}
