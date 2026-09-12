import { ApiError, type FailureKind } from './api'

/**
 * What the app says when something has gone wrong - all of it, in one place.
 *
 * Every failure is put the same way, because a tool that explains itself
 * differently on every screen reads as several tools:
 *
 *   title    what happened, named by what it means for the reader
 *   message  what that means here, in one sentence
 *   hint     the one thing to do next
 *
 * Three rules hold the voice together. A failure is never named by the address
 * that failed, by a status code, or by the shape of a payload - where the
 * service lives and what it answered with are deployment detail, and they are
 * already on the `ApiError` for whoever is debugging it. Nothing is blamed on
 * the reader. And every failure ends with something to do, even when that is
 * only to try again in a moment, because a message that stops at the bad news
 * leaves somebody staring at a screen with no move left.
 *
 * `ApiError` keeps its own precise pair beneath this - the expected payload
 * shape, the configuration pointer - so nothing is lost by wording the surface
 * for the person reading it.
 */

export interface Failure {
  /** what happened, with no full stop: it is a heading */
  title: string
  /** what it means here */
  message: string
  /** what to do next */
  hint: string
}

const FAILURE_COPY: Record<FailureKind | 'unknown', Failure> = {
  config: {
    title: 'No annotation service is configured',
    message: 'New text has to be computed by a service, and this build has no address for one.',
    hint: 'Set VITE_API_URL in .env and start the service. What ships with the site works without it.',
  },
  network: {
    title: 'The service could not be reached',
    message: 'The request never got an answer.',
    hint: 'It may be starting up or briefly down. Try again in a moment.',
  },
  timeout: {
    title: 'The service did not answer in time',
    message: 'The turn was sent, and nothing came back before the deadline.',
    hint: 'Long turns take longer to compute. Try again, or shorten the text.',
  },
  http: {
    title: 'The service refused the request',
    message: 'The turn arrived and was not annotated.',
    hint: 'Try again with a shorter turn. If it keeps happening the service needs a look.',
  },
  payload: {
    title: 'The answer could not be read',
    message: 'The service replied with something this app cannot display.',
    hint: 'Try again. If it persists, the service is answering in an unexpected shape.',
  },
  unknown: {
    title: 'The request could not be completed',
    message: 'Something stopped the turn on its way to the service.',
    hint: 'Try again in a moment.',
  },
}

/** Whatever was thrown, as the three parts a panel explains it in. */
export function failureOf(cause: unknown): Failure {
  if (cause instanceof ApiError) return FAILURE_COPY[cause.kind] ?? FAILURE_COPY.unknown
  return FAILURE_COPY.unknown
}

/**
 * The same failure on one line, for the places that have a line rather than a
 * panel: the notice under the microphone, the strip over a run.
 *
 * A message this app wrote itself is kept as it was written - `demo.ts` and
 * `textFile.ts` say something specific about a file, and a general sentence
 * about the service would be a worse answer than the one they already have.
 * Anything else is worded by the table above.
 */
export function noticeOf(cause: unknown): string {
  if (cause instanceof ApiError) {
    const said = failureOf(cause)
    return `${said.message} ${said.hint}`
  }
  const own = cause instanceof Error ? cause.message.trim() : ''
  if (own) return own
  return `${FAILURE_COPY.unknown.message} ${FAILURE_COPY.unknown.hint}`
}
