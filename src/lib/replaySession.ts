import { analyse, type AnalysedTurn } from './analytics'
import { loadDemoTranscript } from './demo'
import type { SharedRun, WatchTurn } from './localSession'
import type { FeedTurn } from './transcript'

/**
 * A room with no service under it: the same debate, derived twice.
 *
 * The other two transports move state. `localSession.ts` posts the run on a
 * `BroadcastChannel`, `room.ts` pushes it down an `EventSource` - and both need
 * something in the middle, which is exactly what a build published to a static
 * host does not have. A QR code drawn there scans perfectly and opens a page
 * that will never be told anything.
 *
 * This is the third answer, and it does not move state at all. The published
 * build ships the debate it plays (`public/demo/tagged.txt`, fetched by
 * `loadDemoTranscript`), and the pace it plays it at is a pure function of the
 * words in each turn - no randomness, no network, nothing local to the machine.
 * Two devices holding the same file and the same function need one number
 * between them to be showing the same turn at the same moment: when the run
 * started. That number fits in a link, so it travels on the QR code itself.
 *
 * So nothing is synchronised here. Both sides evaluate the same schedule
 * against the wall clock and arrive at the same answer independently, the way
 * two people with the same timetable arrive at the same platform without
 * having spoken. What that buys is precisely what a static host cannot
 * otherwise have: a code a room full of people can scan, and turns that land
 * on their phones as they land on the screen.
 *
 * What it cannot do is carry anything that was not decided in advance. A
 * schedule is not a channel: whoever is running the debate can re-issue the
 * clock - which is what pausing does, and why the code is redrawn - but a phone
 * that has already scanned cannot be told. That limit is stated where the link
 * is, and it is the honest shape of a room with no service in it.
 */

/** A replayed room, as against `r-` for a real one and `local-` for a relayed one. */
const PREFIX = 'live-'

export const isReplaySession = (session: string) => session.startsWith(PREFIX)

/**
 * A new replayed room.
 *
 * The id says what it is - it is shown to whoever scans in, and `live-4f2a1c`
 * is a more honest thing to read at the top of a page than an opaque token.
 * The clock is deliberately *not* in it: votes are counted against the session,
 * so an id that changed whenever the debate was paused would empty the floor
 * every time somebody stopped to explain a turn.
 */
export function newReplaySession(): string {
  return `${PREFIX}${Math.random().toString(36).slice(2, 8)}`
}

/** The clock, small enough to sit in a link and on a code. */
export const clockParam = (startedAt: number) => startedAt.toString(36)

/** The clock as it comes back off the address bar, or null if there is none. */
export function readClock(raw: string | null): number | null {
  if (!raw) return null
  const at = Number.parseInt(raw, 36)
  return Number.isFinite(at) && at > 0 ? at : null
}

/* ------------------------------------------------------------------ *
 * The schedule                                                        *
 * ------------------------------------------------------------------ */

/**
 * How fast the shipped debate is fed in, when there is no service to speak to.
 *
 * By the length of the turn, the way a real one takes as long as it takes to
 * say: the opening statements run a minute, the interruptions go by in a
 * second. A flat interval would make the two the same thing, and the point of
 * playing a debate rather than dumping it is that it has a rhythm.
 *
 * It lives here rather than beside the view that plays it because it is now the
 * one thing two devices have to agree on. The session page imports it; so does
 * every phone watching. A number changed in one place and not the other would
 * not break anything visibly - it would just quietly put the room a turn behind
 * the stage.
 */
const PER_WORD = 55
const MIN_MS = 700
const MAX_MS = 4200

export function fedPace(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.min(MAX_MS, Math.max(MIN_MS, words * PER_WORD))
}

/**
 * When each turn lands, as milliseconds from the start of the run.
 *
 * Cumulative, because that is how the session plays it: a turn is handed over,
 * it is worked on for as long as its own length earns, it lands, and only then
 * is the next one begun. `marks[i]` is therefore the moment turn `i` appears,
 * and the span before it is the turn being annotated.
 */
export function schedule(script: FeedTurn[]): number[] {
  const marks: number[] = []
  let at = 0
  for (const turn of script) {
    at += fedPace(turn.text)
    marks.push(at)
  }
  return marks
}

/** How long the run has been going by the time turn `at` is begun. */
export function elapsedBefore(script: FeedTurn[], at: number): number {
  let total = 0
  for (let i = 0; i < at && i < script.length; i += 1) total += fedPace(script[i].text)
  return total
}

/**
 * The clock to publish so that the turn about to be played lands at the same
 * instant here and on every phone.
 *
 * It is written as a start in the past rather than as "turn 4, now": a single
 * origin is the whole of what the other side needs, and it stays correct while
 * nobody is listening. Resuming after a pause anchors it again from wherever
 * the run had got to, which is why the code has to be redrawn - the schedule
 * has not changed, but its origin has.
 */
export function clockFor(script: FeedTurn[], at: number, now: number): number {
  return now - elapsedBefore(script, at)
}

/** How many turns have landed by `elapsed` into the run. */
function landedBy(elapsed: number, marks: number[]): number {
  let landed = 0
  while (landed < marks.length && marks[landed] <= elapsed) landed += 1
  return landed
}

/**
 * Who is on the ballot, worked out the way the session works it out.
 *
 * The session opens the ballot to whoever has argued - a moderator asks and
 * does not assert, and the annotation separates the two without anybody having
 * to say so. The rule is applied here to the same turns, so a watcher is
 * offered the same names without the ballot ever having been sent.
 */
export function arguedIn(turns: AnalysedTurn[]): Set<string> {
  const stats = analyse(turns)
  return new Set(
    stats.speakers.filter((speaker) => speaker.claims + speaker.premises > 0).map((speaker) => speaker.speaker),
  )
}

/** The run as it stands after `landed` turns, in the shape both other transports post. */
function runAt(session: string, script: FeedTurn[], landed: number): SharedRun {
  const turns: WatchTurn[] = []
  for (let i = 0; i < landed; i += 1) {
    const turn = script[i]
    turns.push({
      index: i,
      speaker: turn.speaker,
      tagged: turn.tagged ?? turn.text,
      /* the annotation is the file's and is marked as the file's, here as
         everywhere else: only the waiting is staged */
      source: 'file',
      elapsedMs: 0,
    })
  }

  const arguing = arguedIn(turns.map((turn) => ({ index: turn.index, speaker: turn.speaker, tagged: turn.tagged })))
  const ballot: string[] = []
  for (const turn of turns) {
    if (!ballot.includes(turn.speaker) && arguing.has(turn.speaker)) ballot.push(turn.speaker)
  }

  return {
    session,
    turns,
    total: script.length,
    ballot,
    playing: landed < script.length,
    complete: landed >= script.length,
    updated: Date.now(),
  }
}

/**
 * How often the schedule is read against the clock.
 *
 * Not how often anything is drawn: the run is handed over only when the number
 * of landed turns has actually changed, so this is the resolution of the
 * arrival rather than a render loop. A quarter of a second is inside the
 * shortest turn by a factor of three and costs nothing.
 */
const TICK_MS = 250

/**
 * Watch a replayed room: the same signature as `watchRoom`, and no connection.
 *
 * The view above it cannot tell the three transports apart - it is handed a
 * `SharedRun` and does not ask where from - which is what keeps the published
 * build and the served build the same page rather than two that have to be
 * kept in step.
 */
export function watchReplay(
  session: string,
  startedAt: number,
  onRun: (run: SharedRun) => void,
  onFailed: (message: string) => void,
): () => void {
  let live = true
  let timer = 0

  void loadDemoTranscript()
    .then((script) => {
      if (!live) return
      const marks = schedule(script)
      let shown = -1

      const tick = () => {
        const landed = landedBy(Date.now() - startedAt, marks)
        if (landed === shown) return
        shown = landed
        onRun(runAt(session, script, landed))
        if (landed >= script.length) window.clearInterval(timer)
      }

      tick()
      timer = window.setInterval(tick, TICK_MS)
    })
    .catch((cause: Error) => {
      if (live) onFailed(cause.message)
    })

  return () => {
    live = false
    window.clearInterval(timer)
  }
}
