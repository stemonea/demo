import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { annotate, ApiError, type Source } from './api'
import type { FeedTurn } from './transcript'

/**
 * The streaming pipeline behind the live view.
 *
 * A debate arrives faster than a tagger answers, so the feed is not driven by
 * the requests: two things run at once.
 *
 *   producer - annotates turns in order, `concurrency` requests in flight, and
 *              never further than `lookAhead` turns past what the reader sees,
 *              so a long transcript does not flood the service in one burst;
 *   consumer - reveals one buffered turn at a time, as soon as it is an answer.
 *
 * A turn is never held back for a turn that does not exist yet: the reader is
 * already waiting for the tagger, and adding reading time on top of that is
 * waiting twice. So the pace follows the buffer. With nothing queued behind it,
 * a turn appears the moment it arrives - the model sets the rhythm. With turns
 * already waiting, which is what a transcript that arrived annotated looks like,
 * each one is held long enough to be read: `msPerWord` per word, never less than
 * `minPace` and never more than `maxPace`.
 *
 * A turn that arrived already annotated in the file costs the producer nothing:
 * it fills the buffer straight away, marked as coming from the file. A
 * transcript annotated end to end therefore replays with no service at all,
 * which is what makes a demo possible before the backend exists.
 *
 * Between them sits the buffer: turns already computed but not shown yet. While
 * the reader is on turn 4, turns 5-10 are being computed behind it. The buffer
 * only runs dry when the service is slower than the reading pace, and that is
 * exactly what the "waiting" state reports instead of hiding it.
 *
 * The transport is a detail the rest of this file does not know about. By
 * default the producer issues one `POST` per turn - no streaming server needed.
 * Given `annotateTurn`, it waits on that instead: `useLiveSession` hands it a
 * turn pushed over SSE by a service that is annotating the whole debate. The
 * buffer, the consumer and everything the UI reads are the same either way,
 * which is exactly what a replaceable producer is for.
 *
 * One replay is one mount: the hook holds a single transcript for its lifetime,
 * and restarting means remounting the caller with a new `key`. That keeps the
 * session state honest - there is no half-reset replay to reason about.
 */
export interface AnnotatedTurn extends FeedTurn {
  tagged: string
  source: Source
  elapsedMs: number
}

export type PipelineStatus = 'idle' | 'warming' | 'streaming' | 'waiting' | 'paused' | 'error' | 'done'

/** Turns ready and waiting before the feed slows down to reading speed. */
const PACE_FROM = 2

export interface PipelineOptions {
  /**
   * Where an annotation comes from. The default sends the turn to the service
   * and waits for the answer; a live session resolves it when the service
   * pushes that turn instead.
   */
  annotateTurn?: (turn: FeedTurn, signal: AbortSignal) => Promise<{ tagged: string; source: Source; elapsedMs: number }>
  /** turns computed before the first one is shown - one, so none is batched */
  warmup?: number
  /** how far past the visible turn the producer may run */
  lookAhead?: number
  /** requests in flight at once */
  concurrency?: number
  /** reading time granted per word of the turn on screen */
  msPerWord?: number
  /** floor and ceiling on that reading time */
  minPace?: number
  maxPace?: number
}

export interface Pipeline {
  /** the turns on screen, in transcript order */
  shown: AnnotatedTurn[]
  status: PipelineStatus
  /** turns computed so far, shown or still buffered */
  annotated: number
  /** computed turns waiting their turn to appear */
  buffered: number
  /** indices of the turns being computed right now */
  active: number[]
  /** ms the turn on screen is held before the next one arrives */
  hold: number
  /** reveal the next buffered turn now, without waiting out the hold */
  step: () => void
  /** true while there is a computed turn waiting to be shown */
  canStep: boolean
  error: string | null
  playing: boolean
  setPlaying: (playing: boolean) => void
  retry: () => void
}

export function useAnnotationPipeline(turns: FeedTurn[], options: PipelineOptions = {}): Pipeline {
  const {
    annotateTurn,
    warmup = 1,
    lookAhead = 6,
    concurrency = 2,
    msPerWord = 260,
    minPace = 4000,
    maxPace = 14000,
  } = options

  /* a live session pushes turns as they are annotated, so the producer may wait
     on all of them at once: there is no request of ours to pace */
  const inFlight = annotateTurn ? Math.max(concurrency, lookAhead) : concurrency

  const [results, setResults] = useState<(AnnotatedTurn | undefined)[]>(() =>
    new Array<AnnotatedTurn | undefined>(turns.length).fill(undefined),
  )
  const [active, setActive] = useState<number[]>([])
  const [revealed, setRevealed] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /* which turns have been picked up, which are in flight, and the handle that
     cancels everything when the replay is left */
  const startedRef = useRef<Set<number>>(new Set())
  const activeRef = useRef<Set<number>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

  /* The session handle. It is created here rather than lazily, so a remount -
     including the one StrictMode simulates in development - always gets a live
     controller and empty bookkeeping instead of the aborted ones it left. */
  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    startedRef.current = new Set()
    activeRef.current = new Set()
    return () => controller.abort()
  }, [])

  const total = turns.length
  const warmTarget = Math.min(warmup, total)
  const buffered = useMemo(() => contiguousFrom(results, revealed), [results, revealed])

  /* One request, and the state it produces: it is the request that drives the
     pipeline, so this is where the buffer grows. */
  const run = useCallback(async (turn: FeedTurn, controller: AbortController) => {
    /* already annotated in the file: nothing to compute, nothing to wait for */
    if (turn.tagged !== undefined) {
      const tagged = turn.tagged
      setResults((current) => {
        const next = current.slice()
        next[turn.index] = { ...turn, tagged, source: 'file', elapsedMs: 0 }
        return next
      })
      return
    }

    activeRef.current.add(turn.index)
    setActive([...activeRef.current])

    try {
      const result = annotateTurn
        ? await annotateTurn(turn, controller.signal)
        : await annotate(turn.text, 'all', controller.signal)
      if (controller.signal.aborted) return
      setResults((current) => {
        const next = current.slice()
        next[turn.index] = { ...turn, tagged: result.tagged, source: result.source, elapsedMs: result.elapsedMs }
        return next
      })
    } catch (cause) {
      if ((cause as Error).name === 'AbortError' || controller.signal.aborted) return
      /* forget it was started, so a retry picks the same turn up again */
      startedRef.current.delete(turn.index)
      setError(cause instanceof ApiError ? `${cause.message} ${cause.hint}` : (cause as Error).message)
    } finally {
      if (!controller.signal.aborted) {
        activeRef.current.delete(turn.index)
        setActive([...activeRef.current])
      }
    }
  }, [annotateTurn])

  /* Producer: keep the buffer full, never more than `lookAhead` turns ahead. */
  useEffect(() => {
    const controller = abortRef.current
    if (!controller || error || !total) return

    const horizon = Math.min(total, Math.max(revealed + lookAhead, warmTarget))
    while (activeRef.current.size < inFlight) {
      const next = firstPending(startedRef.current, results, horizon)
      if (next < 0) break
      startedRef.current.add(next)
      void run(turns[next], controller)
    }
  }, [turns, total, results, revealed, active, error, run, inFlight, lookAhead, warmTarget])

  /*
   * How long the turn on screen stays there.
   *
   * Only as long as there is something to move on to: with the next turn still
   * being computed, holding this one changes nothing except how late the next
   * one appears. The reading pace applies when the feed is ahead of the reader,
   * which is where it was always meant to apply.
   */
  const hold = useMemo(() => {
    if (revealed === 0) return 0
    if (buffered < PACE_FROM) return 0
    const current = results[revealed - 1]
    const words = current ? current.text.trim().split(/\s+/).length : 0
    return Math.min(maxPace, Math.max(minPace, words * msPerWord))
  }, [results, revealed, buffered, msPerWord, minPace, maxPace])

  /*
   * Consumer: one turn at a time, as long as the buffer has something in it.
   *
   * The hold is read from a ref rather than taken as a dependency, and the
   * buffer is reduced to whether there is anything to move on to at all. Both
   * for the same reason: a turn landing in the background used to re-run this
   * effect, which cleared the pending timer and started the wait again from
   * the top. With a service pushing several turns during one hold - which is
   * exactly what a live session does - the turn on screen was held for as long
   * as turns kept arriving, so the feed stalled precisely when the service was
   * keeping up best. Now the timer is set when a turn is revealed and left
   * alone until it fires.
   */
  const holdRef = useRef(hold)
  /* declared before the timer below, so that within one commit the timer reads
     this commit's hold rather than the previous one's */
  useEffect(() => {
    holdRef.current = hold
  }, [hold])

  const ready = buffered >= (revealed === 0 ? warmTarget : 1)

  useEffect(() => {
    if (!playing || total === 0 || revealed >= total || !ready) return
    const timer = setTimeout(() => setRevealed((current) => current + 1), holdRef.current)
    return () => clearTimeout(timer)
  }, [playing, revealed, total, ready])

  const shown = useMemo(() => results.slice(0, revealed).filter(Boolean) as AnnotatedTurn[], [results, revealed])
  const annotated = useMemo(() => results.reduce((n, entry) => (entry ? n + 1 : n), 0), [results])

  /* the reader jumping ahead: only ever into a turn that is already computed */
  const step = useCallback(() => {
    if (buffered > 0) setRevealed((current) => current + 1)
  }, [buffered])

  const status: PipelineStatus = error
    ? 'error'
    : total === 0
      ? 'idle'
      : revealed >= total
        ? 'done'
        : !playing
          ? 'paused'
          : revealed === 0 && buffered < warmTarget
            ? 'warming'
            : buffered === 0
              ? 'waiting'
              : 'streaming'

  return {
    shown,
    status,
    annotated,
    buffered,
    active,
    hold,
    step,
    canStep: buffered > 0 && revealed < total,
    error,
    playing,
    setPlaying,
    retry: useCallback(() => setError(null), []),
  }
}

/** Lowest turn before `horizon` that is neither computed nor already picked up. */
function firstPending(
  started: ReadonlySet<number>,
  results: (AnnotatedTurn | undefined)[],
  horizon: number,
): number {
  for (let index = 0; index < horizon; index += 1) {
    if (!started.has(index) && !results[index]) return index
  }
  return -1
}

/** How many turns are ready in an unbroken run starting at `from`. */
function contiguousFrom(results: (AnnotatedTurn | undefined)[], from: number): number {
  let count = 0
  while (results[from + count]) count += 1
  return count
}
