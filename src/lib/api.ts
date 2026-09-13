import { SYSTEMS, type SystemId } from '../data/systems'
import { tagNames, tagsOfKind } from './tags'
import { findFixture } from '../data/fixtures'
import { BACKEND, endpoint, liveStreamUrl, liveTranscriptUrl, requestHeaders, roomUrl } from '../config/backend'
import type { LayerView } from './view'

/**
 * The client. Every request this app makes goes through here, and every address
 * it uses comes from `config/backend.ts` - so a page never touches fetch, a URL
 * or a retry policy, and pointing the demo at another service is one file.
 *
 *   annotate(text, view)   one turn      -> the playground, the live feed, analytics
 *   compare(text, view)    one turn, three systems -> "Why joint?"
 *   checkService()         is anyone listening
 *
 * What can go wrong comes back as an `ApiError` that says which failure it was:
 * a service that is not configured, one that cannot be reached, one that took
 * too long, one that answered with an error, one that answered with something
 * this app cannot read. The fix differs in each case, and "request failed" tells
 * whoever runs the demo nothing.
 *
 * The address points at `jaet-be` by default, so a turn typed into the
 * playground is annotated by the model. With no address configured, or with one
 * that is not up, the four turns of the paper fall back to their pre-computed
 * answers - labelled as such, never passed off as a prediction - while anything
 * else is reported as what it is: a turn nobody computed. `config/backend.ts`
 * says which of those fallbacks are allowed.
 */

/**
 * The one sentence every "nothing is configured" failure ends with. There is
 * only one fix, so there is only one way of saying it.
 */
const CONFIG_HINT = 'Set VITE_API_URL in .env, or baseUrl in src/config/backend.ts, and start jaet-be.'

export const apiBase = BACKEND.baseUrl || null

/** Where an answer came from - the UI shows this next to every result. */
export type Source = 'backend' | 'precomputed' | 'heuristic' | 'file'

export type FailureKind = 'config' | 'network' | 'timeout' | 'http' | 'payload'

export class ApiError extends Error {
  readonly kind: FailureKind
  /** what to do about it, in one sentence */
  readonly hint: string
  readonly url: string | null
  readonly status?: number

  constructor(kind: FailureKind, message: string, hint: string, url: string | null, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.hint = hint
    this.url = url
    this.status = status
  }
}

export interface AnnotateResult {
  tagged: string
  source: Source
  elapsedMs: number
  /** attempts it took, so a flaky service is visible rather than hidden */
  attempts: number
}

export interface CompareResult {
  outputs: Record<SystemId, string>
  source: Source
  elapsedMs: number
}

/** What one system made of one turn, and what it cost to make it. */
export interface SystemRun {
  tagged: string
  /**
   * What the service reported this system spent, or null when nobody measured
   * it - a turn replayed from the fixtures was not computed here, and printing
   * a number for it would be inventing the very figure this view compares.
   */
  elapsedMs: number | null
  source: Source
  /**
   * What actually ran this system, as the service reports it.
   *
   * A pipeline can be served by two trained stage taggers or, where those are
   * not configured, by the joint model asked each stage's own instruction -
   * one layer, with nothing said about the other. Both reproduce the
   * pipeline's structure; only the first reproduces a second model's accuracy,
   * and a time from one must never be read as a time from the other. `null` is
   * a service that does not say.
   */
  servedBy: string | null
}

export interface DoubleResult {
  runs: Record<SystemId, SystemRun>
  /** the whole round trip, network included: the page shows it apart */
  elapsedMs: number
  source: Source
}

/* ------------------------------------------------------------------ *
 * One turn                                                            *
 * ------------------------------------------------------------------ */

export async function annotate(
  text: string,
  view: LayerView = 'all',
  signal?: AbortSignal,
): Promise<AnnotateResult> {
  const started = performance.now()
  const url = endpoint('annotate')

  if (!url) return await offlineAnnotate(text, started, signal)

  let payload: unknown
  let attempts: number
  try {
    ;({ payload, attempts } = await send(url, BACKEND.bodies.annotate(text, view), signal))
  } catch (cause) {
    /* a bundled turn can still be shown when the service is down; a turn the
       visitor typed is the model's to answer, so that failure is reported */
    const spare = spareAnswer(cause, text)
    if (spare) return { tagged: spare, source: 'precomputed', elapsedMs: performance.now() - started, attempts: 1 }
    throw cause
  }

  const tagged = readTagged(payload)
  if (tagged === null) {
    throw new ApiError(
      'payload',
      'The service answered with something this app cannot read.',
      `Expected JSON holding a string under one of: ${BACKEND.responseKeys.join(', ')}.`,
      url,
    )
  }
  return { tagged, source: 'backend', elapsedMs: performance.now() - started, attempts }
}

/* ------------------------------------------------------------------ *
 * One turn, three systems                                             *
 * ------------------------------------------------------------------ */

export async function compare(text: string, view: LayerView, signal?: AbortSignal): Promise<CompareResult> {
  const started = performance.now()
  const url = endpoint('compare')
  const systems = SYSTEMS.map((system) => system.id)

  if (!url) {
    const fixture = findFixture(text)
    await wait(fixture ? 700 : 420, signal)
    if (fixture && BACKEND.offline.fixtures) {
      return { outputs: fixture.outputs, source: 'precomputed', elapsedMs: performance.now() - started }
    }
    if (!BACKEND.offline.heuristic) throw noService(text)
    const tagged = heuristic(text)
    return {
      outputs: { joint: tagged, 'am-dner': dropLayer(tagged, 'argument'), 'dner-am': dropLayer(tagged, 'entity') },
      source: 'heuristic',
      elapsedMs: performance.now() - started,
    }
  }

  const { payload } = await send(url, BACKEND.bodies.compare(text, view, systems), signal)
  const outputs = readOutputs(payload)
  if (!outputs) {
    throw new ApiError(
      'payload',
      'The service answered with something this app cannot read.',
      'Expected { outputs: { joint, "am-dner", "dner-am" } }.',
      url,
    )
  }
  return { outputs, source: 'backend', elapsedMs: performance.now() - started }
}

/* ------------------------------------------------------------------ *
 * One turn, three systems, three clocks                               *
 * ------------------------------------------------------------------ */

/**
 * The same turn through the three systems, each of them timed.
 *
 * `compare` asks what they produce; this asks what they cost. The two are kept
 * apart rather than folded together because the answers are wanted in different
 * places and at different moments: the comparison is read one turn at a time by
 * somebody looking at markup, the timing is read down a whole transcript by
 * somebody looking for the price of a pipeline.
 *
 * The clock that counts is the service's. Timing the round trip here would be
 * timing this machine's network as much as the tagger, and on a conference wifi
 * that is not a figure anybody should put in a table - so each system is
 * expected to report its own, and a system that reports none is shown as
 * unmeasured instead of being given the round trip to wear.
 *
 * With no service, the four turns of the paper still answer, out of the
 * fixtures and labelled as pre-computed: the view can be walked through with
 * nothing running, and the times are honestly absent rather than fabricated.
 */
export async function annotateAcross(
  text: string,
  view: LayerView = 'all',
  signal?: AbortSignal,
): Promise<DoubleResult> {
  const started = performance.now()
  const url = endpoint('double')
  const systems = SYSTEMS.map((system) => system.id)

  if (!url) return offlineAcross(text, started)

  let payload: unknown
  try {
    ;({ payload } = await send(url, BACKEND.bodies.double(text, view, systems), signal))
  } catch (cause) {
    if ((cause as Error).name === 'AbortError') throw cause
    /* the service is down and this is a turn of the paper: it still has an
       answer, and saying so beats stopping a run halfway down a transcript */
    if (BACKEND.fixturesWhenUnreachable && findFixture(text)) return offlineAcross(text, started)
    throw cause
  }

  const runs = readRuns(payload)
  if (!runs) {
    throw new ApiError(
      'payload',
      'The service answered with something this app cannot read.',
      'Expected { outputs: { joint: { text, elapsed_ms }, "am-dner": …, "dner-am": … } }.',
      url,
    )
  }

  return { runs, elapsedMs: performance.now() - started, source: 'backend' }
}

/**
 * The three reported answers for a turn of the paper, with no time on them.
 *
 * Exported as `replayAcross` below, because the demonstration build has to
 * reach it without going near the network: a service is configured by default
 * and, when nothing is listening on it, every turn of a run would spend its
 * timeout finding that out again.
 */
function offlineAcross(text: string, started: number): DoubleResult {
  const fixture = findFixture(text)
  if (!fixture || !BACKEND.offline.fixtures) throw noService(text)

  const runs = Object.fromEntries(
    SYSTEMS.map((system) => [
      system.id,
      {
        tagged: fixture.outputs[system.id],
        elapsedMs: DEMO_MS[system.id],
        source: 'precomputed' as Source,
        servedBy: null,
      },
    ]),
  ) as Record<SystemId, SystemRun>

  return { runs, elapsedMs: performance.now() - started, source: 'precomputed' }
}

/**
 * How long each system takes on a demonstration build.
 *
 * Fixed figures, chosen for the demonstration rather than measured: the four
 * turns are replayed from the table the paper reports, which gives their
 * annotations and not their latencies. They are here so the bench has something
 * to show and so the single pass reads as the quick one against two stages that
 * are not - which is the finding - and they are the same for every turn, so
 * nothing about them should be read as varying with the input.
 *
 * Anything published from this view on a build with no service behind it is
 * showing these numbers, not a measurement. Against a running service the
 * figures come from the service, timed around each system's own work.
 */
const DEMO_MS: Record<SystemId, number> = {
  joint: 2_000,
  'am-dner': 3_000,
  'dner-am': 3_500,
}

/**
 * The reported answers for one turn, without asking anybody.
 *
 * What the comparison views run on in demo mode. It is the same fallback the
 * call itself uses when there is no service, reached directly so that a build
 * with nothing behind it does not spend a timeout per turn discovering that.
 */
export function replayAcross(text: string): DoubleResult {
  return offlineAcross(text, performance.now())
}

/**
 * The three runs, out of whatever shape the service answered with.
 *
 * A system may come back as `{ text, elapsed_ms }` or as a bare string; the
 * string is accepted so a service can be pointed at this view before it has
 * been taught to time itself, and its time is then null rather than zero -
 * "not measured" and "took no time" are not the same claim.
 */
function readRuns(payload: unknown): Record<SystemId, SystemRun> | null {
  const outputs = (payload as { outputs?: unknown } | null)?.outputs
  if (!outputs || typeof outputs !== 'object') return null

  const runs = {} as Record<SystemId, SystemRun>
  for (const system of SYSTEMS) {
    const entry = (outputs as Record<string, unknown>)[system.id]
    if (typeof entry === 'string') {
      runs[system.id] = { tagged: entry, elapsedMs: null, source: 'backend', servedBy: null }
      continue
    }
    if (!entry || typeof entry !== 'object') return null

    const row = entry as Record<string, unknown>
    const tagged = readTagged(row)
    if (tagged === null) return null

    const reported = row.elapsed_ms ?? row.elapsedMs
    const served = row.served_by ?? row.servedBy
    runs[system.id] = {
      tagged,
      elapsedMs: typeof reported === 'number' && Number.isFinite(reported) ? reported : null,
      source: 'backend',
      servedBy: typeof served === 'string' && served ? served : null,
    }
  }

  return runs
}

/* ------------------------------------------------------------------ *
 * One debate                                                          *
 * ------------------------------------------------------------------ */

/**
 * A debate is not a turn: it is uploaded once, as the file it already is, and
 * the service answers with the whole queue - every turn's speaker and text, the
 * first few already annotated - plus a session to stream the rest from. What
 * the service says about the file (`warnings`) is shown as it came.
 */
export interface LiveTurnPayload {
  index: number
  speaker: string
  text: string
  tagged: string | null
  /** model: computed there · file: arrived annotated · pending · error */
  source: 'model' | 'file' | 'pending' | 'error'
  elapsed_ms: number
  error: string | null
}

export interface LiveSessionStart {
  session: string
  file: string
  total: number
  ready: number
  done: boolean
  turns: LiveTurnPayload[]
  warnings: string[]
  elapsedMs: number
}

/** True when the service is configured to take a whole debate. */
export const liveDebateSupported = () => endpoint('livedebate') !== null

export async function startLiveDebate(
  file: File,
  view: LayerView = 'all',
  signal?: AbortSignal,
): Promise<LiveSessionStart> {
  const url = endpoint('livedebate')
  if (!url) {
    throw new ApiError(
      'config',
      'No annotation service is configured, so a transcript cannot be annotated.',
      'The bundled excerpt still plays: it arrives annotated and is replayed as it is.',
      null,
    )
  }

  const started = performance.now()
  const body = new FormData()
  body.append('file', file, file.name)
  body.append('view', view)

  const controller = new AbortController()
  const release = link(controller, signal, BACKEND.timeoutMs)

  let response: Response
  try {
    /* no Content-Type of our own: the browser has to set the multipart boundary */
    const headers = requestHeaders()
    delete headers['Content-Type']
    response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
  } catch {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw new ApiError(
      'network',
      'The annotation service could not be reached, so the transcript was not sent.',
      'Check that the service is running and that it allows this origin.',
      url,
    )
  } finally {
    release()
  }

  if (!response.ok) {
    /* the service checks the file too, and its reason is the useful one */
    throw new ApiError('http', 'The service refused the transcript.', await httpHint(response), url, response.status)
  }

  const payload = (await response.json().catch(() => null)) as LiveSessionStart | null
  if (!payload || typeof payload.session !== 'string' || !Array.isArray(payload.turns)) {
    throw new ApiError(
      'payload',
      'The service answered the upload with something this app cannot read.',
      'Expected { session, total, turns: [...] }.',
      url,
    )
  }
  return { ...payload, elapsedMs: performance.now() - started }
}

export interface Transcription {
  text: string
  language: string
  /** how long the recording was */
  seconds: number
  elapsedMs: number
}

/**
 * One spoken turn, as the line the annotator reads.
 *
 * The recording is converted before it gets here - 16 kHz mono PCM, which is
 * what the service will accept and what Whisper wants - so this only has to
 * carry it. There is no offline stand-in: a turn nobody transcribed is not a
 * turn, and pretending otherwise would put words in a speaker's mouth.
 */
export async function transcribe(
  wav: Blob,
  language = 'en',
  signal?: AbortSignal,
): Promise<Transcription> {
  const url = endpoint('transcribe')
  if (!url) {
    throw new ApiError(
      'config',
      'No annotation service is configured, so nothing can be transcribed.',
      CONFIG_HINT,
      null,
    )
  }

  const started = performance.now()
  const body = new FormData()
  body.append('file', wav, 'turn.wav')
  body.append('language', language)

  const controller = new AbortController()
  const release = link(controller, signal, BACKEND.timeoutMs)

  let response: Response
  try {
    /* no Content-Type of our own: the browser has to set the multipart boundary */
    const headers = requestHeaders()
    delete headers['Content-Type']
    response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
  } catch {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw new ApiError(
      'network',
      'The service could not be reached, so what was said was not transcribed.',
      'Check that the service is running and that it allows this origin.',
      url,
    )
  } finally {
    release()
  }

  if (!response.ok) {
    throw new ApiError('http', 'The service could not transcribe that turn.', await httpHint(response), url, response.status)
  }

  const payload = (await response.json().catch(() => null)) as
    | { text?: unknown; language?: unknown; seconds?: unknown }
    | null
  if (!payload || typeof payload.text !== 'string') {
    throw new ApiError(
      'payload',
      'The service answered the recording with something this app cannot read.',
      'Expected { text, language, seconds }.',
      url,
    )
  }

  return {
    text: payload.text.trim(),
    language: typeof payload.language === 'string' ? payload.language : language,
    seconds: typeof payload.seconds === 'number' ? payload.seconds : 0,
    elapsedMs: performance.now() - started,
  }
}

/** The address the browser opens to be pushed the rest of the debate. */
export function liveStream(session: string, since: number): string | null {
  return liveStreamUrl(session, since)
}

/**
 * Where the service keeps this debate's annotation, as a file.
 *
 * The whole debate, not the part that has gone by on screen: the session holds
 * every turn the model has produced, so saving it costs nothing and does not
 * depend on the reader having watched it to the end.
 */
export function liveTranscript(session: string): string | null {
  return liveTranscriptUrl(session)
}

/* ------------------------------------------------------------------ *
 * Rooms - a spoken session other people can watch                     *
 * ------------------------------------------------------------------ */

/** One turn as it is handed to the room, and as it comes back out of it. */
export interface RoomTurnPayload {
  index: number
  speaker: string
  tagged: string
  source: Source
  elapsedMs: number
}

/** What the room says it holds after being published to. */
export interface RoomPublished {
  /** turns it now has - the `since` for the next call */
  held: number
  /** how many people have the debate open, which is not tabs of this browser */
  watching: number
}

/**
 * Mint a room.
 *
 * Nothing is uploaded: a spoken debate has no transcript to hand over. The
 * service answers with an id short enough to live in a link that gets read off
 * a QR code, and every other call is built from it.
 */
export async function openRoom(signal?: AbortSignal): Promise<string> {
  const url = endpoint('room')
  if (!url) {
    throw new ApiError('config', 'No service is configured, so no room can be opened.', CONFIG_HINT, null)
  }

  const payload = (await post(url, {}, BACKEND.timeoutMs, signal)) as { room?: unknown } | null
  if (!payload || typeof payload.room !== 'string' || !payload.room) {
    throw new ApiError('payload', 'The service did not answer with a room.', 'Expected { room }.', url)
  }
  return payload.room
}

/**
 * Hand the room what is new.
 *
 * Only the turns past what it already holds: the room appends by index and
 * drops one it has, so a retry after a dropped connection cannot duplicate a
 * turn. The answer is how many it now holds, which is what the next call sends
 * from - the sender never has to work that out for itself.
 */
export async function publishToRoom(
  room: string,
  body: { turns: RoomTurnPayload[]; total: number; ballot: string[]; playing: boolean; complete: boolean },
  signal?: AbortSignal,
): Promise<RoomPublished> {
  const url = roomUrl(room, 'publish')
  if (!url) {
    throw new ApiError('config', 'No service is configured, so there is no room to publish to.', CONFIG_HINT, null)
  }

  const payload = (await post(
    url,
    {
      turns: body.turns.map((turn) => ({
        index: turn.index,
        speaker: turn.speaker,
        tagged: turn.tagged,
        source: turn.source,
        elapsed_ms: turn.elapsedMs,
      })),
      total: body.total,
      ballot: body.ballot,
      playing: body.playing,
      complete: body.complete,
    },
    BACKEND.timeoutMs,
    signal,
  )) as { held?: unknown; watching?: unknown } | null

  return {
    held: typeof payload?.held === 'number' ? payload.held : 0,
    watching: typeof payload?.watching === 'number' ? payload.watching : 0,
  }
}

/** One person's whole history of preference, which is what replaces theirs. */
export async function voteInRoom(
  room: string,
  voter: string,
  ballots: { choice: string; turn: number; at: number }[],
  signal?: AbortSignal,
): Promise<void> {
  const url = roomUrl(room, 'vote')
  if (!url) {
    throw new ApiError('config', 'No service is configured, so there is no room to vote in.', CONFIG_HINT, null)
  }
  await post(url, { voter, ballots }, BACKEND.timeoutMs, signal)
}

/** Ending a room deliberately, rather than leaving it to the service's TTL. */
export async function closeRoom(room: string): Promise<void> {
  const url = roomUrl(room, '')
  if (!url) return
  try {
    await fetch(url, { method: 'DELETE', headers: requestHeaders() })
  } catch {
    /* the room expires on its own; failing to say so early is not worth reporting */
  }
}

/** The addresses the browser opens to be pushed a room's turns, and its votes. */
export const roomStream = (room: string, since: number) => roomUrl(room, 'stream', since)
export const roomVotesStream = (room: string) => roomUrl(room, 'votes/stream')

/* ------------------------------------------------------------------ *
 * Is anyone listening?                                                *
 * ------------------------------------------------------------------ */

export type ServiceState = 'offline' | 'checking' | 'ready' | 'unreachable'

export interface ServiceStatus {
  state: ServiceState
  url: string | null
  /** why it is unreachable, when it is */
  detail?: string
}

/**
 * A cheap GET on the health route, so a view can say the service is down before
 * the visitor has typed a turn rather than after. A service with no health route
 * (or with `routes.health` blanked) is reported ready: the probe is a
 * convenience, never a gate on the real call.
 */
export async function checkService(signal?: AbortSignal): Promise<ServiceStatus> {
  const base = endpoint('annotate')
  if (!base) return { state: 'offline', url: null }

  const url = endpoint('health')
  if (!url) return { state: 'ready', url: base }

  const controller = new AbortController()
  const release = link(controller, signal, BACKEND.healthTimeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', headers: requestHeaders(), signal: controller.signal })
    if (!response.ok) return { state: 'unreachable', url, detail: `${response.status} ${response.statusText}` }
    return { state: 'ready', url: base }
  } catch (cause) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return { state: 'unreachable', url, detail: reason(cause) }
  } finally {
    release()
  }
}

/* ------------------------------------------------------------------ *
 * Transport                                                           *
 * ------------------------------------------------------------------ */

/** POSTs a body, retrying only what another attempt could fix. */
async function send(url: string, body: unknown, signal?: AbortSignal) {
  const attempts = Math.max(1, BACKEND.retries + 1)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { payload: await post(url, body, BACKEND.timeoutMs, signal), attempts: attempt }
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') throw cause
      const error =
        cause instanceof ApiError
          ? cause
          : new ApiError('network', 'The service could not be reached.', 'Try again in a moment.', url)
      if (attempt === attempts || !worthRetrying(error)) throw error
      await wait(BACKEND.retryDelayMs, signal)
    }
  }

  /* unreachable: the loop either returns or throws */
  throw new ApiError('network', 'The service could not be reached.', 'Try again in a moment.', url)
}

async function post(url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timedOut = { value: false }
  const release = link(controller, signal, timeoutMs, () => {
    timedOut.value = true
  })

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (timedOut.value) {
      throw new ApiError(
        'timeout',
        `The service did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        'Try a shorter turn, or raise timeoutMs in src/config/backend.ts.',
        url,
      )
    }
    throw new ApiError(
      'network',
      'The service could not be reached.',
      'Check the address in src/config/backend.ts, that the service is running, and that it allows this origin.',
      url,
    )
  } finally {
    release()
  }

  if (!response.ok) {
    throw new ApiError(
      'http',
      'The service refused the request.',
      await httpHint(response),
      url,
      response.status,
    )
  }

  const text = await response.text().catch(() => '')
  if (!text.trim()) {
    throw new ApiError('payload', 'The service answered with nothing at all.', 'Expected the annotated turn.', url)
  }

  try {
    return JSON.parse(text)
  } catch {
    /* a plain-text answer is fine too, as long as it carries the markup */
    return text
  }
}

/** Aborts `controller` when the caller aborts, or when the time is up. */
function link(controller: AbortController, signal: AbortSignal | undefined, timeoutMs: number, onTimeout?: () => void) {
  const timer = setTimeout(() => {
    onTimeout?.()
    controller.abort()
  }, timeoutMs)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward)
  return () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

function worthRetrying(error: ApiError): boolean {
  if (error.kind === 'network' || error.kind === 'timeout') return true
  return error.kind === 'http' && [429, 500, 502, 503, 504].includes(error.status ?? 0)
}

/** FastAPI puts the useful part in `detail`; show it rather than the bare code. */
async function httpHint(response: Response): Promise<string> {
  const detail = await response
    .clone()
    .json()
    .then((body: unknown) => {
      const value = (body as Record<string, unknown> | null)?.detail
      return typeof value === 'string' ? value : null
    })
    .catch(() => null)

  /* FastAPI's generic details ("Not Found") say less than the pointer below */
  if (detail && detail !== response.statusText) return detail
  const status = response.status
  if (status === 401 || status === 403) return 'The credentials were rejected. Check VITE_API_KEY.'
  if (status === 404) return 'That route is not there. Check the routes in src/config/backend.ts.'
  if (status === 413) return 'The turn is too long for the service. Send a shorter one.'
  if (status === 422) return 'The request body was refused. Check bodies in src/config/backend.ts.'
  if (status === 429) return 'The service is rate limiting. Wait a moment and try again.'
  if (status >= 500) return 'The failure is on the service side. Its logs will say more.'
  return 'Check that the request body matches what the service expects.'
}

/** No address at all: the bundled turns, or an honest refusal. */
async function offlineAnnotate(text: string, started: number, signal?: AbortSignal): Promise<AnnotateResult> {
  const fixture = findFixture(text)
  await wait(fixture ? 420 : 260, signal)

  if (fixture && BACKEND.offline.fixtures) {
    return {
      tagged: fixture.outputs.joint,
      source: 'precomputed',
      elapsedMs: performance.now() - started,
      attempts: 1,
    }
  }
  if (BACKEND.offline.heuristic) {
    return { tagged: heuristic(text), source: 'heuristic', elapsedMs: performance.now() - started, attempts: 1 }
  }
  throw noService(text)
}

/**
 * The pre-computed answer for a turn of the paper, when the service that should
 * have answered could not be reached. Anything the visitor typed returns null:
 * it is the model's to annotate, and a failure has to say so.
 */
function spareAnswer(cause: unknown, text: string): string | null {
  if (!BACKEND.fixturesWhenUnreachable) return null
  if (!(cause instanceof ApiError) || (cause.kind !== 'network' && cause.kind !== 'timeout')) return null
  return findFixture(text)?.outputs.joint ?? null
}

function noService(text: string): ApiError {
  return new ApiError(
    'config',
    findFixture(text)
      ? 'No annotation service is configured.'
      : 'Only the bundled turns can be answered without a service, and this is not one of them.',
    CONFIG_HINT,
    null,
  )
}

function readTagged(payload: unknown): string | null {
  if (typeof payload === 'string') return payload.trim() ? payload : null
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  for (const key of BACKEND.responseKeys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function readOutputs(payload: unknown): Record<SystemId, string> | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const source = (record.outputs ?? record) as Record<string, unknown>
  const outputs = {} as Record<SystemId, string>
  for (const system of SYSTEMS) {
    const value = source[system.id]
    if (typeof value !== 'string') return null
    outputs[system.id] = value
  }
  return outputs
}

function reason(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause)
}

/**
 * A pause that can be cut short.
 *
 * The listener is taken off again whichever way the wait ends. It used to be
 * left on: one signal serves a whole replay - the pipeline holds a single
 * controller for every turn of the debate - so a wait per turn meant a
 * listener per turn accumulating on it, each holding a timer and a settled
 * promise. An already-aborted signal is answered directly, because attaching
 * to one that has already fired hears nothing.
 */
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const done = () => signal?.removeEventListener('abort', stop)

    const timer = setTimeout(() => {
      done()
      resolve()
    }, ms)

    function stop() {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }

    signal?.addEventListener('abort', stop, { once: true })
  })
}

/* ------------------------------------------------------------------ *
 * Offline stand-ins                                                   *
 * ------------------------------------------------------------------ */

const SPEAKER = /^([A-Z][A-Z'.\- ]{2,}):/
const KNOWN: [RegExp, string][] = [
  [/\b(19|20)\d{2}\b/g, 'date'],
  [/\b(Senate|Congress|White House|Supreme Court|NATO|United Nations)\b/g, 'org'],
  [/\b(Democrats?|Republicans?|Democratic Party|Republican Party)\b/g, 'party'],
  [/\b(president|vice president|senator|governor|secretary)\b/gi, 'role'],
]

/** Rough local tagger, used only for text no fixture covers. */
function heuristic(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => {
      let out = line.trim()
      if (!out) return ''

      const speaker = out.match(SPEAKER)
      let prefix = ''
      if (speaker) {
        prefix = `<person>${speaker[1]}</person>: `
        out = out.slice(speaker[0].length).trim()
      }

      const body = out
        .split(/(?<=[.?!])\s+/)
        .filter(Boolean)
        .map((sentence) => {
          let marked = sentence
          for (const [pattern, tag] of KNOWN) {
            marked = marked.replace(pattern, (match) => `<${tag}>${match}</${tag}>`)
          }
          const trailing = marked.match(/[.?!]$/)?.[0] ?? ''
          const core = trailing ? marked.slice(0, -1) : marked
          const label = /\bbecause\b|\bsince\b|\bpercent\b|\bdata\b/i.test(core) ? 'premise' : 'claim'
          return core.split(/\s+/).length < 4 ? marked : `<${label}>${core}</${label}>${trailing}`
        })
        .join(' ')

      return prefix + body
    })
    .filter(Boolean)
    .join('\n')
}

/** Removes one layer, the way a pipeline stage silently drops the other's tags. */
function dropLayer(tagged: string, layer: 'argument' | 'entity'): string {
  /* every name a tag can arrive under, so `<organization>` goes with `<org>` */
  const names = tagsOfKind(layer).flatMap(tagNames)
  return names.reduce((text, name) => text.replace(new RegExp(`</?${name}>`, 'g'), ''), tagged)
}
