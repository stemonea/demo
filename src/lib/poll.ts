import { useCallback, useEffect, useState } from 'react'
import { voteInRoom } from './api'
import { isRoom, watchRoomVotes } from './room'

/**
 * Where the room stands, while the debate is going on.
 *
 * A spectator is given one thing to do — say who they are with, or that they
 * are with nobody — and may change their mind as often as the debate gives
 * them reason to. That is the measurement: not the final tally, which any poll
 * can produce, but *when* people moved and which way, laid against the turn
 * that moved them.
 *
 * Every ballot is kept, not just the standing one. A count of who leads can be
 * derived from the last vote of each person; how many changed their mind, and
 * how many gave up on both sides, cannot be derived from anything but the
 * history — and those are the two numbers a moderator actually wants.
 *
 * The transport is the one the live view already uses between tabs: each voter
 * writes their own key, so two of them cannot overwrite each other, and posts
 * on a channel so the room updates at once. It is the same limit stated
 * everywhere else — same browser, same machine — and the same thing a service
 * would replace with an endpoint.
 */

const POLL = 'jaet.poll.'
const VOTER = 'jaet.voter'

/** Standing aside from both — a position, not the absence of one. */
export const NEUTRAL = '__neutral__'

export const isNeutral = (choice: string) => choice === NEUTRAL

/**
 * How many people can be told apart by colour before the rest are one line.
 *
 * The series palette is six hues assigned in a fixed order and validated as a
 * set; a seventh is not a new hue, because a generated one would land wherever
 * it landed and there is no way to check it. Past six, the remainder is drawn
 * as "others" — which on a ballot is honest rather than dismissive: a poll with
 * seven people on it is a poll about the leaders and the field.
 */
const HUES = 6

/**
 * The colour of one position, by its place on the ballot.
 *
 * Keyed to the ballot, not to rank: somebody who slips from first to third
 * keeps their colour, and taking a name off does not repaint the ones that are
 * left. Standing aside is a grey, so it reads as the absence of a side rather
 * than as one more of them.
 */
export function choiceColour(choice: string, ballot: string[]): string {
  if (isNeutral(choice)) return 'var(--series-neutral)'
  const at = ballot.indexOf(choice)
  if (at < 0 || at >= HUES) return 'var(--series-other)'
  return `var(--series-${at + 1})`
}

/** One expression of preference, and the moment in the debate it was made. */
export interface Ballot {
  /** the speaker being backed, or NEUTRAL */
  choice: string
  /** how many turns had gone by when it was cast */
  turn: number
  at: number
}

/** One voter's whole history, which is what is relayed and what is stored. */
export interface VoterRun {
  voter: string
  ballots: Ballot[]
}

const keyOf = (session: string, voter: string) => `${POLL}${session}.${voter}`
const channelOf = (session: string) => `${POLL}${session}`

/**
 * Who this browser tab is, for the length of the tab.
 *
 * `sessionStorage`, not `localStorage`: a second tab is a second voter, which
 * is both what a demonstration needs — three windows, three people — and what
 * a real audience looks like, one device at a time. Reloading keeps the id, so
 * a refresh is not a new person and does not double-count.
 */
export function voterId(): string {
  try {
    const kept = window.sessionStorage.getItem(VOTER)
    if (kept) return kept
    const minted = Math.random().toString(36).slice(2, 10)
    window.sessionStorage.setItem(VOTER, minted)
    return minted
  } catch {
    /* storage refused: the tab still votes, it just will not be remembered */
    return 'anon'
  }
}

/* ------------------------------------------------------------------ *
 * Casting                                                             *
 * ------------------------------------------------------------------ */

/** The vote this tab has cast so far, and the way to change it. */
export function useBallot(session: string | null, turn: number) {
  const [voter] = useState(voterId)
  const [ballots, setBallots] = useState<Ballot[]>(() => read(session, voter))

  const cast = useCallback(
    (choice: string) => {
      if (!session) return
      setBallots((history) => {
        /* saying again what you already said is not a change of mind, and must
           not show up as one in the moderator's count */
        if (history.at(-1)?.choice === choice) return history
        const next = [...history, { choice, turn, at: Date.now() }]
        write(session, voter, next)
        /*
         * A room is told the whole history, not the ballot just cast, and it
         * replaces what this voter had. That is what makes voting from a phone
         * on a bad network safe: a re-post after a dropped connection cannot
         * turn one person into two, and cannot invent a change of mind — which
         * is the figure whoever is running the debate is actually watching.
         *
         * `write` still runs above it, and deliberately: the copy in this
         * browser is what puts the choice back on screen after a reload without
         * waiting for the stream to say so.
         */
        if (isRoom(session)) {
          void voteInRoom(session, voter, next).catch(() => {
            /* the room did not take it. The choice stands here, and the next
               one sends this history again — there is nothing to queue */
          })
        }
        return next
      })
    },
    [session, voter, turn],
  )

  return { voter, ballots, choice: ballots.at(-1)?.choice ?? null, changes: switchesIn(ballots), cast }
}

function read(session: string | null, voter: string): Ballot[] {
  if (!session) return []
  try {
    const raw = window.localStorage.getItem(keyOf(session, voter))
    return raw ? (JSON.parse(raw) as VoterRun).ballots : []
  } catch {
    return []
  }
}

function write(session: string, voter: string, ballots: Ballot[]) {
  const run: VoterRun = { voter, ballots }
  try {
    window.localStorage.setItem(keyOf(session, voter), JSON.stringify(run))
  } catch {
    /* out of quota: the channel still carries it to whoever is listening */
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(channelOf(session))
    channel.postMessage(run)
    channel.close()
  }
}

/* ------------------------------------------------------------------ *
 * Collecting                                                          *
 * ------------------------------------------------------------------ */

/**
 * The floor: everything every voter has said, as it comes in.
 *
 * `present` is how many people have the debate open, which only a room can
 * know — a run relayed between tabs has no way of counting anybody, and reports
 * 0. It arrives on the votes stream rather than with the turns because whoever
 * is running the debate opens only this one, and they are the one who needs to
 * see that somebody has scanned in.
 */
export interface Floor {
  votes: Map<string, Ballot[]>
  present: number
}

export function useVotes(session: string | null): Floor {
  const [votes, setVotes] = useState<Map<string, Ballot[]>>(() => sweepIn(session))
  const [present, setPresent] = useState(0)
  const [watching, setWatching] = useState(session)

  /* a different session is a different room, read here rather than in an
     effect: it is a value derived from a prop that changed */
  if (watching !== session) {
    setWatching(session)
    setVotes(sweepIn(session))
    setPresent(0)
  }

  useEffect(() => {
    if (!session) return

    /* a room the service is holding: everyone's history, pushed, and replaced
       whole on every change — nothing to reconcile and no gap after a drop */
    if (isRoom(session)) {
      return watchRoomVotes(session, (floor, here) => {
        setVotes(floor)
        setPresent(here)
      })
    }

    const take = (run: VoterRun) =>
      setVotes((current) => {
        const next = new Map(current)
        next.set(run.voter, run.ballots)
        return next
      })

    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(channelOf(session))
      channel.onmessage = (event) => take(event.data as VoterRun)
    }

    /* the same event the run itself uses, and the path for a browser with no
       channel: a vote written in another tab lands here as a storage change */
    const onStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith(`${POLL}${session}.`) || !event.newValue) return
      try {
        take(JSON.parse(event.newValue) as VoterRun)
      } catch {
        /* a half-written value; the next vote replaces it */
      }
    }
    window.addEventListener('storage', onStorage)

    return () => {
      channel?.close()
      window.removeEventListener('storage', onStorage)
    }
  }, [session])

  return { votes, present }
}

/** Every vote already cast for this session, for a board opened late. */
function sweepIn(session: string | null): Map<string, Ballot[]> {
  const found = new Map<string, Ballot[]>()
  if (!session) return found
  try {
    const prefix = `${POLL}${session}.`
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      const run = JSON.parse(raw) as VoterRun
      if (run.ballots?.length) found.set(run.voter, run.ballots)
    }
  } catch {
    /* nothing readable: the board fills from the channel instead */
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Reading the room                                                    *
 * ------------------------------------------------------------------ */

function switchesIn(ballots: Ballot[]): number {
  let count = 0
  for (let i = 1; i < ballots.length; i += 1) if (ballots[i].choice !== ballots[i - 1].choice) count += 1
  return count
}

export interface PollSeries {
  choice: string
  /** voters standing here, turn by turn */
  counts: number[]
  /** the same as a share of everyone who had voted by that turn */
  shares: number[]
  /** where it stands now */
  now: number
}

export interface PollReport {
  /** people who have voted at all */
  voters: number
  /** how many of them had voted, turn by turn */
  votedBy: number[]
  series: PollSeries[]
  /** voters who have moved at least once */
  changed: number
  /** every move any of them made */
  switches: number
  /** standing aside now, having backed somebody before */
  toNeutral: number
  /** backing somebody now, having stood aside before */
  fromNeutral: number
}

/**
 * The room, turn by turn.
 *
 * A voter counts from the turn they first voted and not before: the room fills
 * up as the debate goes on, and pretending everyone was present from turn one
 * would draw a line that starts at a number nobody had said yet.
 */
export function tally(votes: Map<string, Ballot[]>, turns: number, choices: string[]): PollReport {
  const span = Math.max(turns, 1)
  const counts = new Map<string, number[]>()
  for (const choice of choices) counts.set(choice, new Array<number>(span).fill(0))
  const votedBy = new Array<number>(span).fill(0)

  let changed = 0
  let switches = 0
  let toNeutral = 0
  let fromNeutral = 0

  for (const ballots of votes.values()) {
    if (!ballots.length) continue
    const ordered = [...ballots].sort((a, b) => a.turn - b.turn || a.at - b.at)

    const moves = switchesIn(ordered)
    if (moves > 0) changed += 1
    switches += moves

    const first = ordered[0].choice
    const last = ordered.at(-1)!.choice
    if (isNeutral(last) && !isNeutral(first)) toNeutral += 1
    if (!isNeutral(last) && isNeutral(first)) fromNeutral += 1

    /* one walk down the turns, carrying whatever this voter last said */
    let at = 0
    let standing: string | null = null
    for (let turn = 0; turn < span; turn += 1) {
      while (at < ordered.length && ordered[at].turn <= turn) {
        standing = ordered[at].choice
        at += 1
      }
      if (standing === null) continue
      votedBy[turn] += 1
      const line = counts.get(standing)
      if (line) line[turn] += 1
    }
  }

  const series = choices.map((choice) => {
    const line = counts.get(choice) ?? new Array<number>(span).fill(0)
    return {
      choice,
      counts: line,
      shares: line.map((value, turn) => (votedBy[turn] ? value / votedBy[turn] : 0)),
      now: line[span - 1] ?? 0,
    }
  })

  return { voters: votes.size, votedBy, series, changed, switches, toNeutral, fromNeutral }
}
