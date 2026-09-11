import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { withCrowd } from '../lib/audience'
import { NEUTRAL, choiceColour, isNeutral, tally, useVotes, type Ballot } from '../lib/poll'
import './PollBoard.css'

interface Props {
  /** the run the votes belong to */
  session: string
  /** everyone who has spoken, in the order they first did */
  speakers: string[]
  /** who is standing, which the person running the debate decides */
  ballot: string[]
  onBallot: (next: string[]) => void
  /** turns gone by, which is the axis the room is read against */
  turns: number
  /**
   * A room that is not there, for the published build that cannot pool one.
   *
   * Null wherever there is a service or a second tab to count real people
   * with. Where it is set it is said on the board, because a chart of invented
   * figures presented as a measured room would be a different thing entirely.
   */
  crowd?: Map<string, Ballot[]> | null
}

/**
 * The room, for whoever is running the debate.
 *
 * Three numbers and one chart. The numbers are the ones a tally cannot give
 * you — how many people moved, and how many gave up on both sides — and the
 * chart is where they moved, laid against the turn that moved them. A final
 * result says who won the room; this says which minute won it.
 */
export default function PollBoard({ session, speakers, ballot, onBallot, turns, crowd = null }: Props) {
  const { votes } = useVotes(session)
  const [showing, setShowing] = useState(false)

  /* real votes over the simulated ones, never the other way about */
  const floor = useMemo(() => withCrowd(votes, crowd), [votes, crowd])

  /* neutral is a line like any other, and always the last one */
  const choices = useMemo(() => [...ballot, NEUTRAL], [ballot])
  const report = useMemo(() => tally(floor, turns, choices), [floor, turns, choices])

  const moved = report.changed
  const open = ballot.length >= 2

  return (
    <section className="poll" aria-label="Where the room stands">
      <header className="poll__head">
        <div>
          <span className="eyebrow">The floor</span>
          <h2 className="display poll__title">Where the room stands</h2>
        </div>
        <p className="poll__lead">
          Everyone watching this debate can say who they are with, or that they are with nobody, and change their
          mind as often as the debate gives them reason to. Every ballot is kept, so it is
          when the room moved, against the turn that moved it.
        </p>
        {/* said before the chart rather than under it: whoever reads these
            numbers has to know what they are before they read them */}
        {!!crowd?.size && (
          <p className="poll__simulated" role="note">
            <strong>{crowd.size} of these voters are simulated.</strong> This build has no service behind it, so real
            votes cannot be pooled between devices — every phone in the room counts only its own. The simulated floor
            is derived from the session id and the turn count, so it is the same on every device watching, and it
            moves as the debate does. Anybody voting here is counted as themselves, on top of it.
          </p>
        )}
      </header>

      {/* who is standing: it opens as the speakers who have argued — a
          moderator asks and does not assert, so the annotation separates them
          without anyone having to say so — and the toggles are the correction */}
      <div className="poll__ballot">
        <span className="poll__ballot-label">
          On the ballot
          <span className="poll__ballot-note">everyone who has argued, unless you say otherwise</span>
        </span>
        <ul className="poll__names">
          {speakers.map((speaker) => {
            const on = ballot.includes(speaker)
            return (
              <li key={speaker}>
                <button
                  type="button"
                  className={`poll__name${on ? ' is-on' : ''}`}
                  style={{ ['--series' as string]: choiceColour(speaker, ballot) } as CSSProperties}
                  aria-pressed={on}
                  onClick={() =>
                    onBallot(on ? ballot.filter((name) => name !== speaker) : [...ballot, speaker])
                  }
                  title={on ? `Take ${speaker} off the ballot` : `Put ${speaker} on the ballot`}
                >
                  <span className="poll__swatch" aria-hidden="true" />
                  {speaker}
                </button>
              </li>
            )
          })}
          {!speakers.length && <li className="poll__empty">Nobody has spoken yet.</li>}
        </ul>
      </div>

      {!open ? (
        <p className="poll__empty poll__empty--wide">
          Two names are needed before anyone can take a side. {speakers.length === 1 ? 'One has' : `${speakers.length} have`}{' '}
          spoken so far.
        </p>
      ) : (
        <>
          <ul className="tallies poll__tallies">
            <Tally value={report.voters} label="watching" of="people who have voted at all" />
            <Tally
              value={moved}
              label={moved === 1 ? 'changed' : 'changed'}
              of={`${report.switches} ${report.switches === 1 ? 'change' : 'changes'} of mind in all`}
            />
            <Tally value={report.toNeutral} label="stood aside" of="backed somebody, then nobody" />
            <Tally value={report.fromNeutral} label="took a side" of="stood aside, then backed somebody" />
          </ul>

          <div className="poll__chart cell">
            <div className="cell__top">
              <h3 className="cell__head">
                Share of the room
                <span className="cell__count">
                  {report.voters}
                  <span className="cell__count-of">voting</span>
                </span>
              </h3>
              <button type="button" className="toggle" onClick={() => setShowing((was) => !was)} aria-pressed={showing}>
                {showing ? 'Hide the numbers' : 'Show the numbers'}
              </button>
            </div>

            <Standing report={report} ballot={ballot} turns={turns} />

            {showing && <Numbers report={report} ballot={ballot} />}
          </div>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * The chart                                                           *
 * ------------------------------------------------------------------ */

/* drawn at its own size and scaled to the cell: one coordinate system to
   reason about, whatever the window is doing */
const W = 1200
const H = 260
const PAD = { top: 16, right: 150, bottom: 28, left: 46 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom
/** the closest two direct labels may sit before one is pushed off the other */
const LABEL_GAP = 15

const GRID = [0, 0.25, 0.5, 0.75, 1]

function label(choice: string) {
  return isNeutral(choice) ? 'Neutral' : choice
}

/**
 * One line per position, over the turns.
 *
 * Share rather than heads, because the room fills up while the debate runs: a
 * count that climbs because two more people arrived says the same thing as a
 * count that climbs because somebody was convinced, and only one of those is
 * worth a moderator's attention. The heads are in the tooltip and in the table,
 * where they cannot be mistaken for the trend.
 *
 * A voter counts from the turn they first voted and not before, so a line
 * starts where its first backer did rather than at a zero nobody had said.
 */
function Standing({ report, ballot, turns }: { report: ReturnType<typeof tally>; ballot: string[]; turns: number }) {
  const svg = useRef<SVGSVGElement>(null)
  const [at, setAt] = useState<number | null>(null)

  const span = Math.max(turns, 1)
  const x = (turn: number) => PAD.left + (span === 1 ? PLOT_W / 2 : (turn / (span - 1)) * PLOT_W)
  const y = (share: number) => PAD.top + (1 - share) * PLOT_H

  /* a line begins at the first turn anyone had voted at all: before that there
     is no room to be a share of */
  const opened = report.votedBy.findIndex((count) => count > 0)

  const drawn = useMemo(
    () =>
      report.series
        .map((series) => ({
          series,
          colour: choiceColour(series.choice, ballot),
          d:
            opened < 0
              ? ''
              : series.shares
                  .slice(opened)
                  .map((share, i) => `${i === 0 ? 'M' : 'L'}${x(opened + i).toFixed(1)},${y(share).toFixed(1)}`)
                  .join(' '),
        }))
        .filter((line) => line.d),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, ballot, span, opened],
  )

  /* direct labels, pushed apart so two close lines do not print over each
     other — the one thing a validator cannot check for you */
  const labels = useMemo(() => {
    const placed = drawn
      .map((line) => ({
        choice: line.series.choice,
        colour: line.colour,
        share: line.series.shares[span - 1] ?? 0,
        at: y(line.series.shares[span - 1] ?? 0),
      }))
      .sort((a, b) => a.at - b.at)

    for (let i = 1; i < placed.length; i += 1) {
      const gap = placed[i].at - placed[i - 1].at
      if (gap < LABEL_GAP) placed[i].at = placed[i - 1].at + LABEL_GAP
    }

    /* pushing them apart can push the last one off the bottom — which with
       every line at the same height is not the rare case, it is what a debate
       looks like before anybody has voted differently. The stack moves up as
       one, so the spacing survives and the labels stay on the sheet. */
    const over = (placed.at(-1)?.at ?? 0) - (PAD.top + PLOT_H)
    if (over > 0) for (const entry of placed) entry.at -= over
    const under = PAD.top - (placed[0]?.at ?? PAD.top)
    if (under > 0) for (const entry of placed) entry.at += under

    return placed
  }, [drawn, span])

  function track(event: React.MouseEvent<SVGSVGElement>) {
    const box = svg.current?.getBoundingClientRect()
    if (!box || opened < 0) return
    const inside = ((event.clientX - box.left) / box.width) * W
    const turn = Math.round(((inside - PAD.left) / PLOT_W) * (span - 1))
    setAt(Math.min(span - 1, Math.max(opened, turn)))
  }

  if (opened < 0) {
    return <p className="poll__empty poll__empty--wide">Nobody watching has voted yet.</p>
  }

  return (
    <div className="standing">
      <svg
        ref={svg}
        className="standing__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Share of the watching room backing each position, turn by turn"
        onMouseMove={track}
        onMouseLeave={() => setAt(null)}
      >
        {/* the grid is a reference, not a subject: it sits under everything
            and never competes with a line for attention */}
        {GRID.map((step) => (
          <g key={step}>
            <line
              className="standing__grid"
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={y(step)}
              y2={y(step)}
            />
            <text className="standing__tick" x={PAD.left - 10} y={y(step) + 4} textAnchor="end">
              {Math.round(step * 100)}%
            </text>
          </g>
        ))}

        <text className="standing__tick" x={PAD.left} y={H - 8}>
          turn {opened + 1}
        </text>
        <text className="standing__tick" x={PAD.left + PLOT_W} y={H - 8} textAnchor="end">
          turn {span}
        </text>

        {at !== null && (
          <line className="standing__cross" x1={x(at)} x2={x(at)} y1={PAD.top} y2={PAD.top + PLOT_H} />
        )}

        {drawn.map((line) => (
          <path
            key={line.series.choice}
            className="standing__line"
            d={line.d}
            stroke={line.colour}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* the head of each line, and the point under the crosshair */}
        {drawn.map((line) => (
          <circle
            key={`head-${line.series.choice}`}
            className="standing__head"
            cx={x(span - 1)}
            cy={y(line.series.shares[span - 1] ?? 0)}
            r={4.5}
            fill={line.colour}
          />
        ))}

        {at !== null &&
          drawn.map((line) => (
            <circle
              key={`at-${line.series.choice}`}
              className="standing__head"
              cx={x(at)}
              cy={y(line.series.shares[at] ?? 0)}
              r={4}
              fill={line.colour}
            />
          ))}

        {/* identity is never the colour alone: every line is named at its own
            head, in ink, with its mark beside it */}
        {labels.map((entry) => (
          <g key={`label-${entry.choice}`}>
            <rect x={PAD.left + PLOT_W + 10} y={entry.at - 5} width={9} height={9} fill={entry.colour} />
            <text className="standing__label" x={PAD.left + PLOT_W + 25} y={entry.at + 3}>
              {label(entry.choice)}
            </text>
            <text className="standing__value" x={W - 6} y={entry.at + 3} textAnchor="end">
              {Math.round(entry.share * 100)}%
            </text>
          </g>
        ))}
      </svg>

      {at !== null && (
        <div
          className={`standing__tip${x(at) > PAD.left + PLOT_W * 0.6 ? ' is-left' : ''}`}
          style={{ ['--at' as string]: `${(x(at) / W) * 100}%` }}
        >
          <span className="standing__tip-head">
            Turn {at + 1} · {report.votedBy[at]} voting
          </span>
          <ul className="standing__tip-rows">
            {report.series.map((series) => (
              <li key={series.choice}>
                <span
                  className="standing__tip-key"
                  style={{ ['--series' as string]: choiceColour(series.choice, ballot) } as CSSProperties}
                  aria-hidden="true"
                />
                <span className="standing__tip-name">{label(series.choice)}</span>
                <span className="standing__tip-n">
                  {Math.round((series.shares[at] ?? 0) * 100)}% · {series.counts[at] ?? 0}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* a legend is always here: two series or twenty, identity never rests
          on the colour of a line somebody has to trace across a chart */}
      <ul className="standing__key">
        {report.series.map((series) => (
          <li
            key={series.choice}
            className="standing__key-item"
            style={{ ['--series' as string]: choiceColour(series.choice, ballot) } as CSSProperties}
          >
            {label(series.choice)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The same thing, read rather than looked at.
 *
 * Not the chart transcribed turn by turn — two hundred columns is not a table
 * anybody reads — but what the chart is being asked: where each position
 * stands now, and the best it ever did.
 */
function Numbers({ report, ballot }: { report: ReturnType<typeof tally>; ballot: string[] }) {
  const rows = report.series.map((series) => {
    const peak = series.shares.reduce((best, share, turn) => (share > series.shares[best] ? turn : best), 0)
    return { series, peak }
  })

  return (
    <table className="numbers">
      <thead>
        <tr>
          <th scope="col">Position</th>
          <th scope="col">Now</th>
          <th scope="col">Share</th>
          <th scope="col">Highest</th>
          <th scope="col">At turn</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ series, peak }) => (
          <tr key={series.choice}>
            <th scope="row">
              <span
                className="numbers__key"
                style={{ ['--series' as string]: choiceColour(series.choice, ballot) } as CSSProperties}
                aria-hidden="true"
              />
              {label(series.choice)}
            </th>
            <td>{series.now}</td>
            <td>{Math.round((series.shares.at(-1) ?? 0) * 100)}%</td>
            <td>{Math.round((series.shares[peak] ?? 0) * 100)}%</td>
            <td>{peak + 1}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Tally({ value, label: name, of }: { value: number; label: string; of: string }) {
  return (
    <li className="tally">
      <span className="tally__value">{value}</span>
      <span className="tally__label">{name}</span>
      <span className="tally__of">{of}</span>
    </li>
  )
}
