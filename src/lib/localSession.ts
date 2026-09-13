import { useCallback, useEffect, useRef, useState } from 'react'
import { publishToRoom } from './api'
import type { Source } from './api'
import { isReplaySession, watchReplay } from './replaySession'
import { isRoom, watchRoom } from './room'

/**
 * A live debate shared between tabs of one browser.
 *
 * The service-backed share link needs a service: the session id belongs to it,
 * and the stream is its. The demonstration has neither - it replays a
 * transcript that shipped with the site, on this machine, with nothing behind
 * it - and yet it is the build that gets shown to people. A published demo
 * whose one shareable feature is the one that cannot be shown is not much of a
 * demo.
 *
 * So a run with no service mints a local session and relays itself: every turn
 * it shows is posted on a `BroadcastChannel` and written to `localStorage`.
 * The channel is what makes a second tab live; the snapshot is what lets that
 * tab be opened at any point and still see the debate from turn one, because a
 * channel carries nothing that was said before it was listening.
 *
 * The limit is stated wherever the link is, and it is a real one: same browser,
 * same machine. Nothing here crosses a network - that is what the service and
 * its stream are for.
 */

const PREFIX = 'jaet.live.'
/** what marks a session as this rather than the service's */
const LOCAL = 'local-'
/** how long a snapshot of a finished run is worth keeping */
const STALE_MS = 60 * 60 * 1000

/** One turn, as either transport hands it over. */
export interface WatchTurn {
  index: number
  speaker: string
  tagged: string
  source: Source
  elapsedMs: number
}

/** A run as it stands, which is the whole of what is relayed. */
export interface SharedRun {
  session: string
  turns: WatchTurn[]
  /** turns in the transcript, so a watcher knows how much is still to come */
  total: number
  /**
   * Who is on the ballot, as the person running the debate set it.
   *
   * It travels with the run rather than being worked out on each side: the
   * speaker list holds whoever chaired the debate as well as whoever ran in
   * it, and no rule tells them apart. One decision, made once, seen by
   * everybody watching.
   */
  ballot: string[]
  /** whether the run is advancing or has been paused by whoever is running it */
  playing: boolean
  complete: boolean
  updated: number
}

/**
 * What publishing a run reports back.
 *
 * `watching` is people who have the debate open - a figure only a room can
 * know, and 0 for a run relayed between tabs, where the browser has no way of
 * counting anybody. `lost` says the room stopped answering: the debate is still
 * being run and annotated here, it is only the watching that has stopped.
 */
export interface Published {
  watching: number
  lost: boolean
}

/** A run being watched, and whether the transport carrying it is still up. */
export interface WatchedRun {
  run: SharedRun | null
  lost: boolean
}

export const isLocalSession = (session: string) => session.startsWith(LOCAL)

/** A new local session, short enough to read out of a URL. */
export function newLocalSession(): string {
  return `${LOCAL}${Math.random().toString(36).slice(2, 8)}`
}

const keyOf = (session: string) => `${PREFIX}${session}`

/** Snapshots of runs nobody is watching any more do not need keeping. */
function sweep() {
  try {
    const now = Date.now()
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      const kept = raw ? (JSON.parse(raw) as SharedRun).updated : 0
      if (!kept || now - kept > STALE_MS) window.localStorage.removeItem(key)
    }
  } catch {
    /* a browser that refuses storage has nothing to sweep */
  }
}

/**
 * The running side: publish what is on screen.
 *
 * The whole run goes out on every turn rather than a turn at a time. It is
 * about a hundred kilobytes at the very end of the longest debate here, and it
 * makes receiving an assignment rather than an accumulation: no ordering to
 * get right, no gaps to fill, nothing to catch up on after a missed message.
 */
/** How often the snapshot is rewritten, however fast the turns arrive. */
const SNAPSHOT_MS = 1500

export function usePublishRun(
  session: string | null,
  turns: WatchTurn[],
  total: number,
  ballot: string[],
  playing: boolean,
  complete: boolean,
): Published {
  const channel = useRef<BroadcastChannel | null>(null)
  const wrote = useRef(0)

  /* the room's side: what it has confirmed it holds, whether a call is in
     flight, whether one is owed, and the run as it stood when it was. Refs,
     because none of it is anything to re-render for - only `reach` is, and
     that is what the panel shows. */
  const held = useRef({ session: '', count: 0 })
  const sending = useRef(false)
  const pending = useRef(false)
  const current = useRef<{
    session: string | null
    turns: WatchTurn[]
    total: number
    ballot: string[]
    playing: boolean
    complete: boolean
  }>({ session: null, turns: [], total: 0, ballot: [], playing: true, complete: false })
  const [reach, setReach] = useState<Published>({ watching: 0, lost: false })
  const [publishing, setPublishing] = useState(session)

  /* a new session is a new room, and it starts empty: read here rather than in
     an effect, the way the watching side reads its snapshot, because this is a
     value derived from a prop that changed and not a synchronisation with
     anything outside React */
  if (publishing !== session) {
    setPublishing(session)
    setReach({ watching: 0, lost: false })
  }

  useEffect(() => {
    sweep()
  }, [])

  useEffect(() => {
    /* a new session is a new room: its first turn is worth a snapshot at once
       rather than whenever the throttle from the previous one runs out */
    wrote.current = 0
    if (!session || isRoom(session) || isReplaySession(session) || typeof BroadcastChannel === 'undefined') return
    const open = new BroadcastChannel(keyOf(session))
    channel.current = open
    return () => {
      open.close()
      channel.current = null
    }
  }, [session])

  /*
   * A room takes what is new, not the run.
   *
   * The channel below posts the whole run every time because it is free, and
   * because that makes receiving an assignment rather than an accumulation.
   * Over the network the same habit would be a hundred and fifty kilobyte POST
   * per turn by the end of a long debate, so the room is sent only the turns
   * past what it has said it holds - and it is the room's own count that is
   * believed, so nothing here has to work out what arrived.
   *
   * One call at a time, and a flag rather than a queue. A turn that lands while
   * a call is in flight raises `pending`, and the pump goes round again the
   * moment the call returns: nothing waits for the next turn to be carried, and
   * the last turn of a debate is published even if it landed mid-call.
   */
  const pump = useCallback(async () => {
    if (sending.current) return
    sending.current = true
    try {
      while (pending.current) {
        pending.current = false
        const room = current.current.session
        if (!room) break
        const { turns: run, total: length, ballot: names, playing: going, complete: over } = current.current
        /* the cursor names the room it counts for, so a new room starts from
           nothing without anything having to remember to reset it */
        const from = held.current.session === room ? held.current.count : 0
        try {
          const answer = await publishToRoom(room, {
            turns: run.slice(from),
            total: length,
            ballot: names,
            playing: going,
            complete: over,
          })
          held.current = { session: room, count: answer.held }
          setReach((was) =>
            was.watching === answer.watching && !was.lost ? was : { watching: answer.watching, lost: false },
          )
        } catch {
          /* the service went away mid-debate. The debate is not the room's -
             it carries on in this browser - so this is said rather than thrown,
             and the next turn is what tries again */
          setReach((was) => (was.lost ? was : { ...was, lost: true }))
          break
        }
      }
    } finally {
      sending.current = false
    }
  }, [])

  useEffect(() => {
    if (!session || !isRoom(session)) return
    current.current = { session, turns, total, ballot, playing, complete }
    pending.current = true
    void pump()
  }, [session, turns, total, ballot, playing, complete, pump])

  useEffect(() => {
    /* a replayed room is derived from the clock in its link, not relayed: there
       is nobody to post to, and a hundred and fifty kilobytes written to
       storage on every turn for a reader that will never open it is work spent
       on nothing */
    if (!session || isRoom(session) || isReplaySession(session)) return
    const state: SharedRun = { session, turns, total, ballot, playing, complete, updated: Date.now() }

    channel.current?.postMessage(state)

    /*
     * The channel every time, the snapshot at a walking pace.
     *
     * By the end of a long debate the run is a hundred and fifty kilobytes,
     * and `localStorage` is synchronous: writing all of it on every turn puts
     * that on the main thread in the middle of the commit that shows the turn.
     * The channel is what makes a second tab live, and it is free; the
     * snapshot only exists for a tab opened later, which can perfectly well
     * start a second behind and be caught up by the next message.
     */
    const now = Date.now()
    if (!complete && now - wrote.current < SNAPSHOT_MS) return
    wrote.current = now

    try {
      window.localStorage.setItem(keyOf(session), JSON.stringify(state))
    } catch {
      /* out of quota, or storage refused: the channel still carries the run to
         a tab that is already listening - only opening one late is lost */
    }
  }, [session, turns, total, ballot, playing, complete])

  return reach
}

/**
 * The watching side: the snapshot first, then every update.
 *
 * `storage` fires in the *other* tabs, which is what this is, so it doubles as
 * the path for a browser without `BroadcastChannel` and as a second chance for
 * a message that arrived while this tab was being set up.
 */
/** What the run has already published, for a tab that arrives late. */
function snapshot(session: string | null): SharedRun | null {
  if (!session) return null
  try {
    const raw = window.localStorage.getItem(keyOf(session))
    return raw ? (JSON.parse(raw) as SharedRun) : null
  } catch {
    /* nothing kept, or unreadable: the channel is the other way in */
    return null
  }
}

export function useWatchRun(session: string | null, startedAt: number | null = null): WatchedRun {
  const [run, setRun] = useState<SharedRun | null>(() => snapshot(session))
  const [lost, setLost] = useState(false)
  const [watching, setWatching] = useState(session)

  /* a different session is a different run, and the snapshot for it is read
     here rather than in an effect: this is a value derived from a prop that
     has changed, not a synchronisation with anything outside React */
  if (watching !== session) {
    setWatching(session)
    setRun(snapshot(session))
    setLost(false)
  }

  useEffect(() => {
    if (!session) return

    /* a room the service is holding: pushed over the network, and reaching
       whoever is watching wherever they are rather than only in this browser */
    if (isRoom(session)) {
      return watchRoom(session, setRun, setLost)
    }

    /* a room with no service under it: the debate is not sent here, it is
       worked out here, from the transcript this build ships and the moment the
       run started - which is the one thing the link had to carry. Without that
       moment there is nothing to derive, and the view says as much rather than
       showing an empty debate that will never fill. */
    if (isReplaySession(session)) {
      if (startedAt === null) return
      return watchReplay(session, startedAt, setRun, () => setLost(true))
    }

    const key = keyOf(session)

    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(key)
      channel.onmessage = (event) => setRun(event.data as SharedRun)
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== key || !event.newValue) return
      try {
        setRun(JSON.parse(event.newValue) as SharedRun)
      } catch {
        /* a half-written value: the next turn replaces it */
      }
    }
    window.addEventListener('storage', onStorage)

    return () => {
      channel?.close()
      window.removeEventListener('storage', onStorage)
    }
  }, [session, startedAt])

  return { run, lost }
}
