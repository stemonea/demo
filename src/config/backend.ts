/**
 * The backend — the one file to edit.
 *
 * Everything the app needs to reach the service lives here: the address, the
 * routes, what a call is allowed to cost, and how the answer is read out of the
 * response. Nothing else hard-codes a URL — every request goes through
 * `lib/api.ts`, which reads this — so pointing the demo at another machine is a
 * change in this file alone.
 *
 * Every value can also come from the environment, which is what `.env` is for —
 * useful when the same build is deployed against different services:
 *
 *   VITE_API_URL=https://jaet.example.org/api
 *   VITE_API_KEY=…                     (optional, sent as a bearer token)
 *   VITE_API_TIMEOUT_MS=30000          (optional)
 *   VITE_DEMO=1                        (play the shipped debate, call nothing)
 *   VITE_DEMO_MS_PER_WORD=45           (how slowly the demo pretends to think)
 *
 * The environment wins when it is set; the literals below are the fallback.
 */

const env = import.meta.env

/** `https://host/api/` and `https://host/api` are the same base. */
const trim = (value: string) => value.replace(/\/+$/, '')

const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value)

/**
 * Demo mode: the site as it is published, with nothing behind it.
 *
 * A build hosted on a static host — GitHub Pages and its like — has no service
 * to call, so the live debate would end at "could not be reached" for anyone who
 * dropped a file on it. With this on, the live view plays one debate that is
 * shipped with the site and already annotated, whatever file is handed to it,
 * and says plainly that this is what it is doing. It is the difference between
 * a page that cannot work and a page that works without a machine behind it.
 *
 * On by default, because the published build is the common case. The literal
 * below is the switch; `VITE_DEMO` overrides it when it is set, and it is only
 * read from a real `.env` file — `.env.example` is a sample, nothing loads it —
 * so a developer working against `jaet-be` wants either
 *
 *   VITE_DEMO=0 npm run dev
 *
 * or the same line in a `.env` of their own.
 */
export const DEMO = 1

/**
 * The debate the demo plays, and where it is kept.
 *
 * It lives in `public/`, so it is copied to the build as it is rather than
 * bundled into the JavaScript — 125 KB of transcript has no business inside the
 * app's code — and it is fetched at the moment the debate is started. `BASE_URL`
 * is what makes it survive being published in a subfolder, which is exactly what
 * a project page on GitHub Pages is.
 */
export const DEMO_TRANSCRIPT = {
  /** what it is called when the page names the file it is playing */
  name: 'tagged.txt',
  url: `${trim(env.BASE_URL || '/')}/demo/tagged.txt`,
}

/**
 * How slowly the demonstration pretends to think. These are the numbers to
 * change to make it faster or slower.
 *
 * A turn takes `perWordMs` for every word it is about to produce, never less
 * than `minMs` and never more than `maxMs` — a model's time goes with its
 * output, and so does this. `holdMs` is the pause *after* a turn has landed,
 * before the next one is asked for: without it every turn arrives the instant
 * the last finished and the feed reads as a machine rather than as a debate.
 *
 * Each can also come from the environment, which is what makes them tunable
 * without a rebuild of the file:
 *
 *   VITE_DEMO_MS_PER_WORD=45   VITE_DEMO_MIN_MS=1800
 *   VITE_DEMO_MAX_MS=9000      VITE_DEMO_HOLD_MS=1200
 */
export const DEMO_PACE = {
  /** per word of the turn being produced */
  perWordMs: number(env.VITE_DEMO_MS_PER_WORD as string | undefined, 45),
  /** the shortest a turn can take, however brief it is */
  minMs: number(env.VITE_DEMO_MIN_MS as string | undefined, 1800),
  /** the longest, however long it runs */
  maxMs: number(env.VITE_DEMO_MAX_MS as string | undefined, 9000),
  /** the beat after a turn lands, before the next is started */
  holdMs: number(env.VITE_DEMO_HOLD_MS as string | undefined, 1200),
}

export const BACKEND = {
  /**
   * Where the service lives — `jaet-be` on its default port unless `.env` says
   * otherwise. Every turn typed into the playground is sent here.
   *
   * Blank it (or set VITE_API_URL='') to run with no service at all: the demo
   * then replays the bundled turns and says so, and any other text is reported
   * as what it is — a turn nobody computed.
   */
  baseUrl: trim((env.VITE_API_URL as string | undefined) ?? 'http://192.168.1.169:8000'),

  /**
   * Routes, appended to `baseUrl`. Change these to match your service — these
   * are the ones `jaet-be/main.py` serves.
   */
  routes: {
    /** POST — annotate one turn. `playground()` in jaet-be/main.py. */
    annotate: '/playground',
    /** POST — the same turn through the three systems, for the comparison */
    compare: '/compare',
    /**
     * POST — one turn through the three systems, each timed separately.
     *
     * `/compare` answers with what the three produced; this answers with what
     * each of them cost, which is a different question and the one the double
     * view is about. The service is expected to time each system around its own
     * work only — not around the request — because the figure being compared is
     * the tagger's, not the network's.
     *
     * Request:  { text, view, systems: ["joint", "am-dner", "dner-am"] }
     * Response: { outputs: { joint: { text, elapsed_ms }, … } }
     *
     * A system that answers with a bare string instead of an object is still
     * read; its time is then reported as unmeasured rather than guessed at.
     * `double()` in jaet-be/main.py.
     */
    double: '/double',
    /**
     * POST — a whole transcript, as a file. Answers with the queue and the first
     * turns already annotated; `livedebate/{session}/stream` then pushes the
     * rest as they are computed. `livedebate()` in jaet-be/main.py.
     */
    livedebate: '/livedebate',
    /**
     * POST — one spoken turn, as WAV, answered with what was said.
     * `transcribe()` in jaet-be/main.py.
     */
    transcribe: '/transcribe',
    /**
     * POST — mint a room: a spoken session other people can watch and vote in.
     *
     * The one route of the five, because the rest hang off the id it answers
     * with — `/room/{id}/publish`, `/room/{id}/stream`, `/room/{id}/vote` and
     * `/room/{id}/votes/stream`, built in `lib/room.ts` from this. Nothing is
     * uploaded: the debate is annotated in the browser running it and arrives
     * here a turn at a time, so the service is a relay rather than the source.
     * `room_open()` in jaet-be/main.py.
     */
    room: '/room',
    /** GET — cheap liveness probe; set to '' to disable the check entirely */
    health: '/health',
  },

  /** Sent on every request. A key here becomes `Authorization: Bearer …`. */
  apiKey: (env.VITE_API_KEY as string | undefined) ?? '',
  headers: {} as Record<string, string>,

  /** How long one attempt may take before it is given up on. */
  timeoutMs: number(env.VITE_API_TIMEOUT_MS as string | undefined, 30_000),
  /** Shorter, because the probe only says whether anyone is listening. */
  healthTimeoutMs: 4_000,

  /**
   * Retries apply only to failures that a second attempt can plausibly fix — a
   * dropped connection, a timeout, 429, 502, 503, 504. A 400 or a 404 is
   * answered once and reported.
   */
  retries: 1,
  retryDelayMs: 700,

  /**
   * What happens when there is no service to ask.
   *
   * `fixtures` replays the reported answers for the four turns of the paper —
   * they are real outputs, labelled as pre-computed wherever they are shown.
   * `heuristic` answers anything else with a rough local tagger: useful to show
   * the interface with nothing running, misleading the moment someone reads it
   * as a prediction, so it is off. With both off, text nobody has an answer for
   * is reported as such instead of being invented.
   */
  offline: {
    fixtures: true,
    heuristic: false,
  },

  /**
   * A configured service that cannot be reached still gets its error — except
   * for the four bundled turns, which fall back to their pre-computed answer so
   * a demo survives a backend that is not up. Never applies to anything else:
   * text you typed is answered by the model or not at all.
   */
  fixturesWhenUnreachable: true,

  /** The request bodies. Change these if your service expects other fields. */
  bodies: {
    annotate: (text: string, view: string) => ({ text, view }),
    compare: (text: string, view: string, systems: readonly string[]) => ({ text, view, systems }),
    double: (text: string, view: string, systems: readonly string[]) => ({ text, view, systems }),
  },

  /**
   * Where the annotated text is read from in the response, in order —
   * `annotated_text` is what jaet-be answers with. A service that replies with a
   * bare JSON string is accepted as well.
   */
  responseKeys: ['tagged', 'annotated_text', 'annotation', 'annotated', 'output', 'text'],
} as const

/** Absolute URL of one route, or null when no service is configured. */
export function endpoint(route: keyof typeof BACKEND.routes): string | null {
  const path = BACKEND.routes[route]
  if (!BACKEND.baseUrl || !path) return null
  return `${BACKEND.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Where a live debate is pushed from: the session's stream, from `since` on.
 * `EventSource` cannot carry headers, so an API key travels in the query — the
 * service reads either.
 */
export function liveStreamUrl(session: string, since: number): string | null {
  const base = endpoint('livedebate')
  if (!base) return null
  const query = new URLSearchParams({ since: String(since) })
  if (BACKEND.apiKey) query.set('key', BACKEND.apiKey)
  return `${base}/${encodeURIComponent(session)}/stream?${query}`
}

/**
 * The annotated debate the service is holding for this session, as a file to
 * save. It is a plain GET, so a link is enough — the service names the file.
 */
export function liveTranscriptUrl(session: string): string | null {
  const base = endpoint('livedebate')
  if (!base) return null
  const query = BACKEND.apiKey ? `?key=${encodeURIComponent(BACKEND.apiKey)}` : ''
  return `${base}/${encodeURIComponent(session)}/transcript${query}`
}

/**
 * One route of a room, by the id the service minted.
 *
 * A room has five of them and they all hang off the same id, so they are built
 * here rather than written out one by one — and, like everything else, only
 * where there is a service to reach. `EventSource` cannot carry headers, so the
 * two streams take the API key in the query the way the live one does.
 */
export function roomUrl(room: string, path: '' | 'publish' | 'stream' | 'vote' | 'votes/stream', since?: number): string | null {
  const base = endpoint('room')
  if (!base) return null

  const query = new URLSearchParams()
  if (since !== undefined) query.set('since', String(since))
  /* the key belongs in the query only where a header cannot go */
  if (BACKEND.apiKey && path.endsWith('stream')) query.set('key', BACKEND.apiKey)

  const tail = query.toString()
  return `${base}/${encodeURIComponent(room)}${path ? `/${path}` : ''}${tail ? `?${tail}` : ''}`
}

export function requestHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain',
    ...(BACKEND.apiKey ? { Authorization: `Bearer ${BACKEND.apiKey}` } : {}),
    ...BACKEND.headers,
  }
}
