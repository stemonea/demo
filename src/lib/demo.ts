import { DEMO_PACE, DEMO_TRANSCRIPT } from '../config/backend'
import { parseTranscript, type FeedTurn } from './transcript'

/**
 * The debate the published site plays.
 *
 * A build on a static host has no service behind it, so the live view cannot
 * annotate anything: what it can do is replay a debate that was annotated
 * already. That is what this is - one transcript, shipped with the site, every
 * turn carrying its markup - and in demo mode it is what the live view plays
 * whatever file it is handed.
 *
 * It is fetched rather than imported so it stays out of the bundle, and read
 * once: a visitor who restarts the debate should not download it again.
 */
let cached: FeedTurn[] | null = null

/**
 * The transcript carries a `[12] SPEAKER` line above each turn - an index the
 * file was written with, not part of what was said. Left in, it becomes the
 * first words of the turn and takes the speaker's name with it, because the
 * name the feed shows is read off the beginning of the turn. Dropping those
 * lines is the whole of the normalisation, and it is done here rather than in
 * the file so the transcript stays exactly as it was given.
 */
const INDEX_LINE = /^\s*\[\d+\]\s/

/**
 * How long the demonstration pretends a turn took to generate.
 *
 * A model's time goes with what it produces, so this does too: a floor, then a
 * few milliseconds a word, then a ceiling so a long answer does not become a
 * long wait. What it buys is not the number itself but the state the pipeline
 * is in while it counts - the turn is *in flight*, so the feed shows it being
 * annotated, the queue shows it running, and the buffer fills behind it,
 * exactly as on a real run.
 */
export function demoDelay(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.min(DEMO_PACE.maxMs, Math.max(DEMO_PACE.minMs, words * DEMO_PACE.perWordMs))
}

/**
 * The annotation the file already carries, handed over as if it had just been
 * produced.
 *
 * The turns go into the pipeline stripped of their markup - see
 * `withheldAnnotations` - so the pipeline has to ask for each one, which is the
 * only way it will show the work happening. This is what answers, after a wait.
 */
export function demoAnnotator(annotations: Map<number, string>) {
  return (turn: FeedTurn, signal?: AbortSignal) =>
    new Promise<{ tagged: string; source: 'file'; elapsedMs: number }>((resolve, reject) => {
      const started = performance.now()
      const wait = demoDelay(turn.text)
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', stop)
        /* the annotation is the file's; only the waiting is staged, and the
           page says as much before a single turn is played */
        resolve({ tagged: annotations.get(turn.index) ?? turn.text, source: 'file', elapsedMs: performance.now() - started })
      }, wait)

      function stop() {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', stop, { once: true })
    })
}

/**
 * The turns as the pipeline should receive them, and the markup held back.
 *
 * A turn that arrives carrying its annotation is taken straight into the feed -
 * there is nothing to compute - and that is exactly why the demonstration
 * looked frozen: everything was ready at once, so nothing was ever seen being
 * worked on. Holding the markup back and giving it up one turn at a time is
 * what puts the run back on screen.
 */
export function withheldAnnotations(turns: FeedTurn[]): {
  turns: FeedTurn[]
  annotations: Map<number, string>
} {
  const annotations = new Map<number, string>()
  const stripped = turns.map((turn) => {
    if (turn.tagged === undefined) return turn
    annotations.set(turn.index, turn.tagged)
    const bare: FeedTurn = { id: turn.id, index: turn.index, speaker: turn.speaker, text: turn.text }
    return bare
  })
  return { turns: stripped, annotations }
}

export async function loadDemoTranscript(): Promise<FeedTurn[]> {
  if (cached) return cached

  const response = await fetch(DEMO_TRANSCRIPT.url)
  if (!response.ok) {
    throw new Error(
      `The transcript could not be read (${response.status}). ` +
        `It should be published at ${DEMO_TRANSCRIPT.url}.`,
    )
  }

  const raw = await response.text()
  const turns = parseTranscript(
    raw
      .split('\n')
      .filter((line) => !INDEX_LINE.test(line))
      .join('\n'),
  )

  if (!turns.length) throw new Error('The transcript has no turn in it.')

  cached = turns
  return turns
}
