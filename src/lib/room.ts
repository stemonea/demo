import { roomStream, roomVotesStream } from './api'
import type { SharedRun, WatchTurn } from './localSession'
import type { Ballot } from './poll'

/**
 * A room: the same relay, with a network under it.
 *
 * `localSession.ts` shares a running debate between tabs of one browser, which
 * is honest and useless in a room full of people — the link cannot leave the
 * machine it was copied on. When there is a service to hold the room, this is
 * the transport instead: the browser running the debate publishes each turn as
 * it is annotated, and everyone watching is pushed it over `EventSource`.
 *
 * Nothing here decides *which* transport is used. The four hooks keep that
 * decision, in one place each, on `isLocalSession`: a `local-` id is relayed
 * between tabs and anything else is a room the service minted. This file is
 * only the second of those two paths.
 *
 * The rule that makes both streams safe to reconnect is the same rule the
 * service publishes under: **a turn is appended only when its index is the one
 * next expected**. `EventSource` reconnects by itself and reopens the URL it was
 * given, so a dropped connection replays turns already held; ignoring the ones
 * that do not extend the run turns that replay into a no-op, with no cursor to
 * keep and no gap to notice.
 */

/** A room the service minted, as opposed to one relayed between tabs. */
export const isRoom = (session: string) => session.startsWith('r-')

/**
 * What the service says about a room, apart from its turns and its votes.
 * `watching` is people who have the debate open — not tabs of the browser
 * running it, which opens the votes stream and never this one.
 */
interface RoomState {
  total: number
  ballot: string[]
  playing: boolean
  complete: boolean
  watching: number
}

interface RoomTurnEvent {
  index: number
  speaker: string
  tagged: string
  source: string
  elapsed_ms: number
}

const readState = (data: string): RoomState | null => {
  try {
    const payload = JSON.parse(data) as Partial<RoomState>
    return {
      total: typeof payload.total === 'number' ? payload.total : 0,
      ballot: Array.isArray(payload.ballot) ? payload.ballot.filter((name) => typeof name === 'string') : [],
      playing: payload.playing !== false,
      complete: payload.complete === true,
      watching: typeof payload.watching === 'number' ? payload.watching : 0,
    }
  } catch {
    return null
  }
}

/**
 * Watch a room: the state first, then every turn as it is published.
 *
 * `onRun` is handed the whole run each time it changes, in exactly the shape
 * the local relay posts on its channel, so the view watching it cannot tell the
 * two transports apart — which is the point, and what keeps the demo build and
 * the served build the same page.
 *
 * `onLost` says the connection has dropped. It is not an error to report and
 * give up on: `EventSource` is already trying again, and the run stays on
 * screen while it does. The view says the feed is not live rather than pretending
 * a paused debate.
 */
export function watchRoom(
  room: string,
  onRun: (run: SharedRun) => void,
  onLost: (lost: boolean) => void,
): () => void {
  const url = roomStream(room, 0)
  if (!url) return () => {}

  const turns: WatchTurn[] = []
  let state: RoomState = { total: 0, ballot: [], playing: true, complete: false, watching: 0 }

  const publish = () =>
    onRun({
      session: room,
      turns: [...turns],
      total: state.total,
      ballot: state.ballot,
      playing: state.playing,
      complete: state.complete,
      updated: Date.now(),
    })

  const source = new EventSource(url)

  source.addEventListener('state', (event) => {
    const next = readState((event as MessageEvent<string>).data)
    if (!next) return
    state = next
    onLost(false)
    publish()
  })

  source.addEventListener('turn', (event) => {
    try {
      const turn = JSON.parse((event as MessageEvent<string>).data) as RoomTurnEvent
      /* only ever extends the run, so a reconnect that replays is harmless */
      if (turn.index !== turns.length) return
      turns.push({
        index: turn.index,
        speaker: turn.speaker,
        tagged: turn.tagged,
        source: (turn.source as WatchTurn['source']) ?? 'backend',
        elapsedMs: typeof turn.elapsed_ms === 'number' ? turn.elapsed_ms : 0,
      })
      onLost(false)
      publish()
    } catch {
      /* a half-delivered event; the next one carries the run forward */
    }
  })

  source.onerror = () => onLost(true)

  return () => source.close()
}

/** Everyone's votes, replaced whole on every change, and the head count with them. */
export function watchRoomVotes(
  room: string,
  onVotes: (votes: Map<string, Ballot[]>, watching: number) => void,
): () => void {
  const url = roomVotesStream(room)
  if (!url) return () => {}

  const source = new EventSource(url)

  source.addEventListener('votes', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        votes?: Record<string, Ballot[]>
        watching?: number
      }
      const votes = new Map<string, Ballot[]>()
      for (const [voter, ballots] of Object.entries(payload.votes ?? {})) {
        if (Array.isArray(ballots)) votes.set(voter, ballots)
      }
      onVotes(votes, typeof payload.watching === 'number' ? payload.watching : 0)
    } catch {
      /* the next change sends the floor again in full */
    }
  })

  return () => source.close()
}
