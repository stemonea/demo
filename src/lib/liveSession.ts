import { useCallback, useEffect, useRef, useState } from 'react'
import { liveStream, type LiveTurnPayload, type Source } from './api'

/**
 * The live debate, as it is pushed.
 *
 * The transcript was uploaded once; from then on the service annotates it and
 * sends each turn the moment it becomes an answer. This hook holds the open
 * `EventSource` and turns that stream into something the feed can wait on: an
 * annotation per turn, resolved when it arrives - or straight away when it has
 * already arrived.
 *
 * That is what keeps the rest of the view unchanged. The producer in
 * `useAnnotationPipeline` no longer issues a request per turn: it waits on this
 * session instead, and the pacing, the buffer and the panels behave exactly as
 * they did.
 *
 * The stream is opened from the first turn still missing, so a remount -
 * restarting the replay - replays everything already computed at once instead of
 * asking for it again, and a connection that drops is reopened from the turn it
 * had reached: no turn arrives twice, and none is skipped.
 */

export interface TurnAnswer {
  tagged: string
  source: Source
  elapsedMs: number
}

export type LiveStatus = 'idle' | 'open' | 'closed' | 'error'

export interface LiveSession {
  /** resolves when the service has annotated that turn */
  waitFor: (index: number) => Promise<TurnAnswer>
  status: LiveStatus
  /**
   * The turns as they were pushed, in order.
   *
   * The replay does not need these - it has the transcript already and only
   * waits here for the markup. A second reader does: somebody opening the
   * share link has no file and no upload, only the stream, and the stream
   * replays from the first turn it has not sent, so the whole debate arrives
   * on connection. Keeping the payloads is what lets that reader be shown the
   * debate rather than only told how much of it exists.
   */
  turns: LiveTurnPayload[]
  /** turns the service has pushed so far */
  received: number
  /** true once the service says the debate is fully annotated */
  complete: boolean
  error: string | null
}

/** What has arrived, and who is waiting for what. Never read while rendering. */
interface Store {
  answers: Map<number, TurnAnswer>
  /** the turns as they came, by index, for a reader who has no transcript */
  pushed: Map<number, LiveTurnPayload>
  waiting: Map<number, ((answer: TurnAnswer) => void)[]>
  /** the lowest turn not yet received: where a reconnection resumes from */
  next: number
}

const emptyStore = (): Store => ({ answers: new Map(), pushed: new Map(), waiting: new Map(), next: 0 })

/**
 * The state carries the session it describes, so the numbers of a debate that
 * has been left never show against the one that replaced it.
 */
interface StreamState {
  session: string | null
  status: LiveStatus
  turns: LiveTurnPayload[]
  received: number
  complete: boolean
  error: string | null
}

const blank = (session: string | null): StreamState => ({
  session,
  status: session ? 'idle' : 'closed',
  turns: [],
  received: 0,
  complete: false,
  error: null,
})

/** The stream's own vocabulary, mapped onto the one the UI already speaks. */
function sourceOf(payload: LiveTurnPayload): Source {
  return payload.source === 'file' ? 'file' : 'backend'
}

export function useLiveSession(session: string | null): LiveSession {
  const [stream, setStream] = useState<StreamState>(() => blank(session))
  const store = useRef<Store>(emptyStore())

  useEffect(() => {
    if (!session) return

    /* a different debate is a different stream, and a different buffer */
    store.current = emptyStore()

    let source: EventSource | null = null
    let retry: number | null = null
    let finished = false

    /* every update stamps the session it belongs to, so a late event from the
       previous stream cannot write into this one */
    const update = (change: Partial<StreamState>) =>
      setStream((current) => ({ ...(current.session === session ? current : blank(session)), ...change }))

    const deliver = (index: number, answer: TurnAnswer, payload: LiveTurnPayload) => {
      const held = store.current
      held.answers.set(index, answer)
      held.pushed.set(index, payload)
      if (index >= held.next) held.next = index + 1
      const pending = held.waiting.get(index)
      held.waiting.delete(index)
      pending?.forEach((resolve) => resolve(answer))
      /* sorted, not appended: a reconnection resumes from the lowest turn
         still missing, so what arrives is not always what comes next */
      update({
        received: held.answers.size,
        turns: [...held.pushed.values()].sort((a, b) => a.index - b.index),
      })
    }

    const open = () => {
      const url = liveStream(session, store.current.next)
      if (!url) return

      source = new EventSource(url)

      source.addEventListener('open', () => update({ status: 'open', error: null }))

      source.addEventListener('turn', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as LiveTurnPayload
        /* a turn the service could not annotate arrives without markup: the feed
           shows it as it came rather than losing the rest of the debate */
        deliver(
          payload.index,
          {
            tagged: payload.tagged ?? payload.text,
            source: payload.tagged === null ? 'file' : sourceOf(payload),
            elapsedMs: payload.elapsed_ms,
          },
          payload,
        )
      })

      source.addEventListener('done', () => {
        finished = true
        source?.close()
        update({ status: 'closed', complete: true })
      })

      /* the browser would reconnect on its own, but from the start of the
         stream: close it and reopen from the turn we reached */
      source.onerror = () => {
        if (finished) return
        source?.close()
        update({ status: 'error' })
        retry = window.setTimeout(open, 1200)
      }
    }

    open()

    return () => {
      finished = true
      if (retry !== null) window.clearTimeout(retry)
      source?.close()
    }
  }, [session])

  /** The pipeline's producer: one turn, whenever the service gets to it. */
  const waitFor = useCallback((index: number) => {
    const held = store.current
    const arrived = held.answers.get(index)
    if (arrived) return Promise.resolve(arrived)
    return new Promise<TurnAnswer>((resolve) => {
      const queue = held.waiting.get(index) ?? []
      queue.push(resolve)
      held.waiting.set(index, queue)
    })
  }, [])

  /* state belonging to a session that has been left is not this session's */
  const live = stream.session === session ? stream : blank(session)

  return {
    waitFor,
    status: live.status,
    turns: live.turns,
    received: live.received,
    complete: live.complete,
    error: live.error,
  }
}
