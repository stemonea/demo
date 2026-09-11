import { NEUTRAL, type Ballot } from './poll'

/**
 * A room that is not there.
 *
 * The floor in `poll.ts` is real: every ballot on it was pressed by somebody,
 * and it is carried between tabs of one browser or, where there is a service,
 * between everyone in the room. Neither reaches across devices on a build with
 * nothing behind it - a phone that scans the code can count its own vote and
 * nobody else's, so the bars under the answers would read 100% of one person
 * for every person in the room, which is a poll that says nothing.
 *
 * So the published demonstration puts a room there, and says that it has. Every
 * device derives the same audience the same way the turns are derived: a seeded
 * generator, the session id as the seed, the turn count as the clock. Nothing
 * is exchanged and nothing is stored, and yet two phones open on the same code
 * show the same floor moving the same way - because they are computing it, not
 * receiving it.
 *
 * Two things keep this honest and both matter more than the effect:
 *
 *  - the numbers are labelled as simulated wherever they are shown, on the
 *    voter's page and on the moderator's board. Invented figures presented as a
 *    measured room would be a different thing entirely, and not one worth
 *    shipping to make a chart livelier.
 *  - a real vote is never displaced by one of these. The people here are
 *    additional; whoever presses a button on their own phone is counted, and
 *    counted as themselves.
 *
 * Everything is a pure function of `(session, ballot, turns)`, so it cannot
 * drift between devices and cannot drift between renders.
 */

/** How many people the simulated room holds. */
const CROWD = 31

/** Turns over which they arrive, rather than all at once at the opening. */
const ARRIVE_OVER = 9

/** How readily somebody who has voted moves, at any one turn. */
const SWITCH = 0.055

/** How much of the room is standing aside at any moment, roughly. */
const ASIDE = 0.09

/* ------------------------------------------------------------------ *
 * Seeded, so that every device gets the same room                     *
 * ------------------------------------------------------------------ */

function seedOf(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32: small, fast, and identical everywhere it is run. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Which way the room is leaning at a given turn.
 *
 * Without this the audience is a random walk, and a random walk drawn as shares
 * is a flat line with noise on it - which is the one thing the moderator's
 * chart exists to show *not* happening. Two slow waves of unrelated period,
 * phased off the session, give a room that swings and comes back: turns where
 * one side gains, turns where it gives it up again, and no repeat inside the
 * length of a debate.
 */
function tiltAt(seed: number, turn: number): number {
  const phase = (seed % 1000) / 1000
  const slow = Math.sin(turn / 11 + phase * 6.283)
  const slower = Math.sin(turn / 23 + phase * 3.141)
  return 0.5 + 0.17 * slow + 0.11 * slower
}

/** One decision: stand aside, back the leader, or back one of the others. */
function choose(draw: number, tilt: number, ballot: string[]): string {
  if (draw < ASIDE) return NEUTRAL
  const rest = (draw - ASIDE) / (1 - ASIDE)
  if (ballot.length === 1) return ballot[0]
  if (rest < tilt) return ballot[0]
  const others = ballot.length - 1
  const at = Math.min(others - 1, Math.floor(((rest - tilt) / (1 - tilt)) * others))
  return ballot[at + 1]
}

/**
 * The simulated floor, as of `turns` turns into the debate.
 *
 * Each person is walked forward one turn at a time from the turn they arrived
 * at, drawing once per turn. That order is what makes the room *stable as the
 * debate grows*: turn 40 draws what turn 40 was always going to draw, so
 * recomputing at every landing extends the history rather than rewriting it,
 * and the chart behind the newest turn never moves.
 *
 * The ballot is the one exception, and it is a small one. The names come from
 * whoever has argued so far, so a speaker joining the ballot mid-debate
 * redistributes some of the room - which is the right behaviour for a real
 * poll that has just gained a candidate, and in this transcript happens in the
 * opening minute or not at all.
 */
export function simulatedFloor(session: string, ballot: string[], turns: number): Map<string, Ballot[]> {
  const floor = new Map<string, Ballot[]>()
  if (!ballot.length || turns <= 0) return floor

  const seed = seedOf(session)

  for (let person = 0; person < CROWD; person += 1) {
    const roll = prng(seedOf(`${session}:${person}`))

    /* they arrive over the opening turns rather than all at the first one:
       a room that is complete at turn one is a room nobody walked into */
    const joined = Math.floor(Math.pow(roll(), 1.6) * ARRIVE_OVER)
    if (joined >= turns) continue

    const ballots: Ballot[] = []
    let standing: string | null = null

    for (let turn = joined; turn < turns; turn += 1) {
      const draw = roll()
      if (standing === null) {
        standing = choose(draw, tiltAt(seed, turn), ballot)
        ballots.push({ choice: standing, turn, at: turn })
        continue
      }
      if (draw >= SWITCH) continue
      /* a move is a second draw, so the decision to move and where to move are
         not the same number - otherwise everyone who moves moves the same way */
      const next = choose(roll(), tiltAt(seed, turn), ballot)
      if (next === standing) continue
      standing = next
      ballots.push({ choice: next, turn, at: turn })
    }

    if (ballots.length) floor.set(`sim-${person}`, ballots)
  }

  return floor
}

/**
 * The simulated room folded in under the real one.
 *
 * Real first, always: the keys here are `sim-…` and a real voter's id is eight
 * characters of base 36, so nothing can collide - but the order says the rule
 * even so. What comes back is what the tally is run on.
 */
export function withCrowd(votes: Map<string, Ballot[]>, crowd: Map<string, Ballot[]> | null): Map<string, Ballot[]> {
  if (!crowd?.size) return votes
  const merged = new Map(crowd)
  for (const [voter, ballots] of votes) merged.set(voter, ballots)
  return merged
}
