import { useMemo, type CSSProperties } from 'react'
import { analyse, type AnalysedTurn } from '../lib/analytics'
import { withCrowd } from '../lib/audience'
import { NEUTRAL, choiceColour, tally, useBallot, useVotes, type Ballot } from '../lib/poll'
import './PollVote.css'

interface Props {
  /** the run being watched */
  session: string
  /** who is standing, as the person running the debate set it */
  ballot: string[]
  /** the debate so far - what a voter is deciding on */
  turns: AnalysedTurn[]
  /**
   * A room that is not there, for the published build that cannot pool one.
   *
   * A phone watching a replayed debate can count its own vote and nobody
   * else's, which would put every bar at 100% of one person. This is what puts
   * a room under the answers - and it is said, under them, that it is one.
   */
  crowd?: Map<string, Ballot[]> | null
}

/**
 * The mark that stands for a candidate wherever there is no room for a name.
 *
 * The first two letters of the last word, which is the surname: "VICE
 * PRESIDENT HARRIS" and "FORMER PRESIDENT TRUMP" become HA and TR. Taking one
 * letter from each of the last two words would have given PH and PT - both
 * starting from the title they have in common, which is the half that
 * identifies nobody.
 */
function initials(name: string): string {
  const last = name.split(/[\s.]+/).filter(Boolean).at(-1)
  return last ? last.slice(0, 2).toUpperCase() : '?'
}

/**
 * The one thing a spectator can do, and what the room did with it.
 *
 * Everything else on their page is read-only on purpose, and this is the
 * exception that makes watching worth doing: say who you are with, or that you
 * are with nobody, and say something different later if the debate gives you
 * reason to. Changing your mind is the point rather than a failure of the
 * form - the board the moderator sees counts the changes, not just the totals.
 *
 * The room's own standing is shown here too, under each answer. It is a
 * deliberate choice and not an oversight: a poll that shows a voter nothing
 * back is a form, and watching your side move while somebody is still talking
 * is the whole reason this is worth doing during a debate rather than after
 * one. The moderator keeps what a voter does not get - the evolution, turn by
 * turn, and who changed their mind.
 *
 * Standing aside is a position and is offered as one, in the same row as the
 * names. A poll that only lets you pick a side reports a room with no
 * undecided people in it, which is not a room anybody has ever moderated.
 */
export default function PollVote({ session, ballot, turns: debate, crowd = null }: Props) {
  const turns = debate.length
  const { voter, ballots, choice, changes, cast } = useBallot(session, Math.max(0, turns - 1))
  const { votes } = useVotes(session)

  /*
   * What each candidate has actually done so far.
   *
   * A ballot of bare names asks somebody to choose between two strings. The
   * tool already knows how much each of them has asserted and how much of that
   * they gave a reason for, and that is exactly what a viewer is weighing
   * while they decide - so it is on the card they press.
   */
  const argued = useMemo(() => {
    const stats = analyse(debate)
    return new Map(stats.speakers.map((speaker) => [speaker.speaker, speaker]))
  }, [debate])

  /*
   * This tab's own vote, folded in.
   *
   * `useVotes` hears the other tabs and not itself: a `BroadcastChannel` does
   * not deliver to the context that posted, and a `storage` event fires
   * everywhere except the window that wrote. Left as it came, a voter would
   * watch the room move for everybody but themselves - the count would be
   * right on the moderator's board and wrong in front of the person who had
   * just pressed the button.
   */
  const room = useMemo(() => {
    const floor = withCrowd(votes, crowd)
    if (!ballots.length) return floor
    const merged = new Map(floor)
    merged.set(voter, ballots)
    return merged
  }, [votes, crowd, voter, ballots])

  const choices = useMemo(() => [...ballot, NEUTRAL], [ballot])
  const report = useMemo(() => tally(room, turns, choices), [room, turns, choices])
  const voting = report.votedBy.at(-1) ?? 0

  if (ballot.length < 2) {
    return (
      <section className="ballot" aria-label="Where do you stand">
        <header className="ballot__head">
          <div>
            <span className="eyebrow">Your say</span>
            <h2 className="display ballot__title">Where do you stand?</h2>
          </div>
        </header>
        <p className="ballot__closed">
          The floor is not open yet - whoever is running the debate has not put two names on the ballot.
        </p>
      </section>
    )
  }

  return (
    <section className="ballot" aria-label="Where do you stand">
      <header className="ballot__head">
        <div>
          <span className="eyebrow">Your say</span>
          <h2 className="display ballot__title">
            Where do you stand?
            {/* which turn an answer given now is stamped with: the whole point
                of keeping every ballot is that it has a moment attached */}
            <span className="ballot__turn">turn {Math.max(1, turns)}</span>
          </h2>
        </div>
        <p className="ballot__lead">
          Pick a side, or stand aside, and change it whenever the debate changes it for you. Every answer is kept
          against the turn it was given at - so what the room does <em>during</em> the debate is the finding, not the
          final count.
        </p>
      </header>

      {/*
        Two columns, not one row.
        
        Three names side by side across a desktop stretch each card into a
        banner: wide, shallow, and read left to right like a toolbar rather
        than compared against each other. Two columns puts the rivals next to
        one another at a size a card can actually hold, and stacks to one
        column on a narrow screen, which is the only place a single row was
        ever right.

        Nothing is ever left with a hole beside it: an odd last candidate
        takes the whole of its row, and standing aside always does - it is the
        answer that is not one of them, and sitting apart underneath is what
        says so.
      */}
      <ul className="ballot__options">
        {choices.map((option, i) => {
          const mine = choice === option
          const neutral = option === NEUTRAL
          const wide = neutral || (ballot.length % 2 === 1 && i === ballot.length - 1)
          const line = report.series.find((series) => series.choice === option)
          const share = line?.shares.at(-1) ?? 0
          const heads = line?.now ?? 0

          return (
            <li
              key={option}
              className={`ballot__option${wide ? ' ballot__option--wide' : ''}${mine ? ' is-mine' : ''}${
                neutral ? ' ballot__option--aside' : ''
              }`}
              style={{ ['--series' as string]: choiceColour(option, ballot) } as CSSProperties}
            >
              <button
                type="button"
                className="ballot__pick"
                aria-pressed={mine}
                onClick={() => cast(option)}
                title={mine ? 'This is where you stand' : `Stand with ${neutral ? 'neither' : option}`}
              >
                <span className="ballot__mark" aria-hidden="true" />
                {/* the tile carries the colour this candidate is drawn in on
                    the moderator's chart, so the two views name them the same
                    way without either having to spell it out */}
                <span className="ballot__tile" aria-hidden="true">
                  {neutral ? '-' : initials(option)}
                </span>
                <span className="ballot__who">
                  <span className="ballot__name">{neutral ? 'Neither of them' : option}</span>
                  <span className="ballot__made">
                    {neutral ? (
                      'no side, for now'
                    ) : (
                      <Made stat={argued.get(option)} />
                    )}
                  </span>
                </span>
                {mine && <span className="ballot__you">you</span>}
              </button>

              {/* what the room has done with it, under the answer itself */}
              <div className="ballot__room">
                <span className="ballot__track" aria-hidden="true">
                  <span className="ballot__bar" style={{ width: `${share * 100}%` }} />
                </span>
                <span className="ballot__figures">
                  <strong>{Math.round(share * 100)}%</strong>
                  <span className="ballot__heads">
                    {heads} of {voting}
                  </span>
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="ballot__note">
        {choice === null ? (
          <>
            Nothing counted from you yet - {voting} {voting === 1 ? 'person is' : 'people are'} voting.
          </>
        ) : changes === 0 ? (
          <>
            Counted. Press another at any point and it will be counted from that turn - {voting}{' '}
            {voting === 1 ? 'person is' : 'people are'} voting.
          </>
        ) : (
          <>
            Counted - you have changed your mind {changes} {changes === 1 ? 'time' : 'times'}, and {voting}{' '}
            {voting === 1 ? 'person is' : 'people are'} voting.
          </>
        )}{' '}
        <span className="ballot__where">
          {crowd?.size ? (
            <>
              {crowd.size} of the voters in these figures are simulated: this build has no service behind it, so votes
              cannot be pooled between the phones watching. The simulated room is worked out from the session and the
              turn count, so everyone scanning this code sees the same one. Your own answer is real, and it is counted
              on top of it.
            </>
          ) : (
            <>
              The room is counted between the tabs of this browser, so a second window is a second voter. Whoever is
              running the debate sees the same figures turn by turn, and who moved.
            </>
          )}
        </span>
      </p>
    </section>
  )
}

/** What one candidate has put on the record, in the words the tool uses. */
function Made({ stat }: { stat: { turns: number; claims: number; premises: number } | undefined }) {
  if (!stat || !stat.turns) return <>has not spoken yet</>
  return (
    <>
      {stat.turns} {stat.turns === 1 ? 'turn' : 'turns'} · <strong>{stat.claims}</strong>{' '}
      {stat.claims === 1 ? 'claim' : 'claims'} · <strong>{stat.premises}</strong>{' '}
      {stat.premises === 1 ? 'premise' : 'premises'}
    </>
  )
}
