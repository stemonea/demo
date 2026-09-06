import { countTags, parseTaggedText, stripTags } from './parseTags'
import { getTagSpec } from './tags'

/**
 * The transcript format the live view reads.
 *
 * Plain text, one turn per block, blocks separated by a blank line, each turn
 * opening with the speaker in capitals followed by a colon. It is the shape a
 * debate transcript already has, and it is what a live feed emits one turn at a
 * time — which is why the same file can be replayed as if it were arriving.
 *
 * A turn may already carry its annotation: if the block contains inline tags of
 * the schema, that annotation is taken as the answer for that turn and no call
 * is made for it. That is what makes a demo possible with no service running,
 * and it is labelled as coming from the file wherever a source is shown.
 */
export interface FeedTurn {
  id: string
  /** position in the transcript, 0-based */
  index: number
  speaker: string
  /** the turn as plain text, tags removed — what would be sent for annotation */
  text: string
  /** the annotation the file already carried, if it carried one */
  tagged?: string
}

/** `SPEAKER:` at the head of a turn, before or after an opening tag. */
export const SPEAKER_PREFIX = /^(?:<[a-zA-Z][\w-]*>)*([A-Z][A-Z'.\- ]{1,40}?)\s*:/

/** The rules shown on the intake screen, so the copy cannot drift from the parser. */
export const FORMAT_RULES = [
  'A .txt file, UTF-8, up to 400 KB.',
  'One turn per block, blocks separated by a blank line — a turn may run over several lines.',
  'Every turn opens with the speaker in capitals, then a colon: SPEAKER: text.',
  'A turn that already carries inline tags is replayed as it is; a plain turn is sent to the service.',
]

export const FORMAT_SAMPLE = `MODERATOR: Welcome. Tonight's first question is on the economy.

HARRIS: Inflation is down because we passed the Inflation
Reduction Act in 2022.

TRUMP: The Senate blocked that bill, and prices went up anyway.`

/** The same three turns, already annotated — replayed without calling anything. */
export const FORMAT_SAMPLE_ANNOTATED = `<person>HARRIS</person>: <premise>Inflation is down because we passed
the <law>Inflation Reduction Act</law> in <date>2022</date></premise>.

<person>TRUMP</person>: <claim>The <org>Senate</org> blocked that bill</claim>.`

/**
 * Splits a loaded transcript into turns.
 *
 * A blank line ends a turn, and so does a new `SPEAKER:` prefix — so a file
 * written one turn per line, with no blank lines at all, still comes out right.
 */
export function parseTranscript(text: string): FeedTurn[] {
  const blocks: string[] = []
  let broken = true

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) {
      broken = true
      continue
    }
    if (broken || !blocks.length || SPEAKER_PREFIX.test(line)) {
      blocks.push(line)
      broken = false
    } else {
      blocks[blocks.length - 1] += ` ${line}`
    }
  }

  return blocks.map((block, index) => {
    const annotated = isAnnotated(block)
    const text = annotated ? stripTags(block) : block
    return {
      id: `turn-${index + 1}`,
      index,
      speaker: text.match(SPEAKER_PREFIX)?.[1].trim() ?? `TURN ${index + 1}`,
      text,
      ...(annotated ? { tagged: block } : {}),
    }
  })
}

/** True when a block carries inline tags of the schema — an answer, not a question. */
function isAnnotated(block: string): boolean {
  if (!block.includes('<')) return false
  for (const name of countTags(parseTaggedText(block)).keys()) {
    if (getTagSpec(name)) return true
  }
  return false
}

/** How many turns of a transcript arrived already annotated. */
export function countAnnotated(turns: FeedTurn[]): number {
  return turns.reduce((n, turn) => (turn.tagged === undefined ? n : n + 1), 0)
}
