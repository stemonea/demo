/**
 * Reading an annotation back in.
 *
 * The annotator can already write three things out - inline markup, JSON spans
 * and two-layer CoNLL - and this is the inverse of all three, so a file that
 * left the tool, or came out of the tagger, can be loaded and corrected by hand
 * instead of being annotated again from nothing.
 *
 * Everything is normalised to the one representation the workbench edits:
 * character offsets over plain text. What a format cannot express is dropped
 * rather than guessed at, and what it expresses illegally - a stray closer, two
 * spans of one layer that half-overlap - is reported instead of repaired
 * silently, because a correction pass is exactly where the visitor wants to be
 * told.
 */

import { parseTaggedText, type TagNode } from './parseTags'
import { canonicalTag, getTagSpec } from './tags'
import { canAdd, layerOf, newSpanId, tokenize, type Layer, type ManualSpan } from './manual'

export type AnnotatedFormat = 'inline' | 'json' | 'conll'

export interface Annotated {
  text: string
  spans: ManualSpan[]
  /** the entity types the file turned out to use, so the palette matches it */
  entityLabels: string[]
  format: AnnotatedFormat
  /** what had to be dropped to make the annotation legal, in plain words */
  warnings: string[]
}

export interface AnnotatedResult {
  value: Annotated | null
  error: string | null
}

/**
 * Extensions the annotator opens. A plain transcript and an annotated one arrive
 * through the same door: a `.txt` with no tags in it simply yields no spans, so
 * there is one way in rather than two the visitor has to choose between.
 */
export const ANNOTATED_EXTENSIONS = ['txt', 'xml', 'json', 'tsv', 'conll']

/**
 * Inline markup straight into spans, with no file in between.
 *
 * The tagger answers a turn as `<claim>… <person>…</person></claim>`, and the
 * playground hands that answer to the same workbench a loaded file goes to:
 * the format is known here, so it is read as inline markup rather than guessed
 * at from a name no file ever had.
 */
export function fromInlineMarkup(tagged: string): Annotated {
  return finish(fromInline(tagged))
}

export function parseAnnotated(source: string, fileName: string): AnnotatedResult {
  const text = source.replace(/\r\n?/g, '\n').trim()
  if (!text) return { value: null, error: 'That file is empty.' }

  try {
    const draft = pick(text, fileName)
    return { value: finish(draft), error: null }
  } catch (cause) {
    return { value: null, error: (cause as Error).message }
  }
}

interface Draft {
  text: string
  spans: Omit<ManualSpan, 'id'>[]
  format: AnnotatedFormat
  warnings: string[]
}

/**
 * Which of the three formats this is. The extension is a hint, never the
 * answer: the annotator's own inline export is a `.txt`, and a `.txt` is also
 * what a plain transcript arrives as.
 */
function pick(text: string, fileName: string): Draft {
  const extension = fileName.toLowerCase().split('.').pop() ?? ''

  if (extension === 'json' || text.startsWith('{')) return fromJson(text)
  if (extension === 'tsv' || extension === 'conll' || looksLikeConll(text)) return fromConll(text)
  return fromInline(text)
}

/** Two or three tab-separated columns on the first line that carries content. */
function looksLikeConll(text: string): boolean {
  const line = text.split('\n').find((candidate) => candidate.trim() && !candidate.startsWith('#'))
  return Boolean(line && line.split('\t').length >= 2)
}

/* ---- inline markup --------------------------------------------------- */

/**
 * `<claim>Iran <person>Trump</person> said</claim>` - the format the tagger
 * emits. The parser is the forgiving one the comparison pages use, so a file
 * with defects still loads; the defects are just reported.
 */
function fromInline(source: string): Draft {
  const spans: Omit<ManualSpan, 'id'>[] = []
  const warnings: string[] = []
  let text = ''

  const walk = (nodes: TagNode[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        text += node.value
        continue
      }
      if (node.type === 'orphan') {
        warnings.push(`Dropped a closing </${node.name}> that opened nowhere.`)
        continue
      }

      const start = text.length
      walk(node.children)
      if (node.unclosed) warnings.push(`<${node.name}> was never closed; it was closed at the end of the text.`)

      const name = canonicalTag(node.name)
      spans.push({
        start,
        end: text.length,
        label: name.toUpperCase(),
        layer: getTagSpec(name)?.kind ?? layerOf(name),
      })
    }
  }

  walk(parseTaggedText(source))

  return { text, spans, format: 'inline', warnings }
}

/* ---- JSON spans ------------------------------------------------------- */

/** The annotator's own `{ text, spans: [{ start, end, label, layer }] }`. */
function fromJson(source: string): Draft {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    throw new Error(`That JSON could not be read: ${(cause as Error).message}`, { cause })
  }

  const root = parsed as { text?: unknown; spans?: unknown }
  if (typeof root?.text !== 'string') {
    throw new Error('That JSON has no "text" field - expected { text, spans: [...] }.')
  }
  if (!Array.isArray(root.spans)) {
    throw new Error('That JSON has no "spans" array - expected { text, spans: [...] }.')
  }

  const text = root.text
  const warnings: string[] = []
  const spans: Omit<ManualSpan, 'id'>[] = []

  root.spans.forEach((raw, i) => {
    const entry = raw as { start?: unknown; end?: unknown; label?: unknown; layer?: unknown }
    const start = Number(entry.start)
    const end = Number(entry.end)
    const label = String(entry.label ?? '').trim().toUpperCase()

    if (!label || !Number.isFinite(start) || !Number.isFinite(end)) {
      warnings.push(`Span ${i + 1} has no usable start, end or label; it was dropped.`)
      return
    }
    if (start < 0 || end > text.length || end <= start) {
      warnings.push(`Span ${i + 1} (${label}) falls outside the text; it was dropped.`)
      return
    }

    const layer: Layer = entry.layer === 'argument' || entry.layer === 'entity' ? entry.layer : layerOf(label)
    spans.push({ start, end, label, layer })
  })

  return { text, spans, format: 'json', warnings }
}

/* ---- two-layer CoNLL --------------------------------------------------- */

/**
 * `token \t argument \t entity`, one token per line, BIO in each column.
 *
 * The original spacing is gone by the time a file is in columns, so the text is
 * rebuilt from the tokens with the one rule that keeps it readable: no space in
 * front of punctuation that closes rather than opens.
 */
function fromConll(source: string): Draft {
  const rows = source
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split('\t'))

  if (!rows.length) throw new Error('That file has no token rows.')

  const words = rows.map((row) => row[0])
  const { text, offsets } = detokenize(words)
  const warnings: string[] = []
  const spans: Omit<ManualSpan, 'id'>[] = []

  /* every column after the token is a layer of BIO; which layer it is comes
     from the labels it carries, not from its position, so a one-column file
     and a swapped-column file both load */
  const columns = Math.max(...rows.map((row) => row.length))
  for (let column = 1; column < columns; column += 1) {
    spans.push(...fromBio(rows.map((row) => row[column] ?? 'O'), offsets, warnings))
  }

  return { text, spans, format: 'conll', warnings }
}

/** Character offsets of each rebuilt token, and the text they point into. */
function detokenize(words: string[]): { text: string; offsets: { start: number; end: number }[] } {
  const NO_SPACE_BEFORE = new Set([',', '.', ';', ':', '!', '?', ')', ']', '}', '”', '’', '%', '…'])
  const NO_SPACE_AFTER = new Set(['(', '[', '{', '“', '‘', '$', '#'])

  let text = ''
  let previous = ''
  const offsets: { start: number; end: number }[] = []

  for (const word of words) {
    const joined =
      !text || NO_SPACE_BEFORE.has(word) || NO_SPACE_AFTER.has(previous) || word === "'" || previous === "'"
    if (!joined) text += ' '
    const start = text.length
    text += word
    offsets.push({ start, end: text.length })
    previous = word
  }

  return { text, offsets }
}

/** One BIO column back into spans. An `I-` with no `B-` in front opens one. */
function fromBio(
  column: string[],
  offsets: { start: number; end: number }[],
  warnings: string[],
): Omit<ManualSpan, 'id'>[] {
  const spans: Omit<ManualSpan, 'id'>[] = []
  let open: { label: string; first: number; last: number } | null = null

  const close = () => {
    if (!open) return
    spans.push({
      start: offsets[open.first].start,
      end: offsets[open.last].end,
      label: open.label,
      layer: layerOf(open.label),
    })
    open = null
  }

  column.forEach((raw, i) => {
    const cell = (raw ?? 'O').trim()
    if (!cell || cell === 'O' || cell === '_' || cell === '-') {
      close()
      return
    }

    const match = /^([BIES])[-_](.+)$/i.exec(cell)
    const prefix = match ? match[1].toUpperCase() : 'B'
    const label = (match ? match[2] : cell).toUpperCase()
    if (!match) warnings.push(`“${cell}” is not BIO; it was read as the start of a ${label} span.`)

    /* E and S come from IOBES files; they behave as I and B respectively */
    const continues = (prefix === 'I' || prefix === 'E') && open?.label === label
    if (continues && open) {
      open.last = i
      if (prefix === 'E') close()
      return
    }

    close()
    open = { label, first: i, last: i }
    if (prefix === 'S' || prefix === 'E') close()
  })

  close()
  return spans
}

/* ---- shared tail ------------------------------------------------------- */

/**
 * Turns a draft into something the workbench can edit: spans get ids, are
 * dropped if they cover no whole token, and are admitted one by one so that an
 * illegal pair is refused here rather than half-way through an export.
 */
function finish(draft: Draft): Annotated {
  const tokens = tokenize(draft.text)
  const warnings = [...draft.warnings]
  const spans: ManualSpan[] = []

  /* outermost first, so a container is admitted before what it contains -
     nesting is legal and both survive, while a genuine half-overlap is refused
     at the point it is reached and named in the warnings */
  const ordered = [...draft.spans].sort((a, b) => a.start - b.start || b.end - a.end)

  for (const candidate of ordered) {
    const covered = tokens.some((token) => token.start >= candidate.start && token.end <= candidate.end)
    if (!covered) {
      warnings.push(`${candidate.label} at ${candidate.start}–${candidate.end} covers no whole word; it was dropped.`)
      continue
    }
    const problem = canAdd(spans, candidate)
    if (problem) {
      warnings.push(`${candidate.label} at ${candidate.start}–${candidate.end} was dropped: ${problem.toLowerCase()}`)
      continue
    }
    spans.push({ ...candidate, id: newSpanId() })
  }

  const entityLabels = [...new Set(spans.filter((span) => span.layer === 'entity').map((span) => span.label))]

  return { text: draft.text, spans, entityLabels, format: draft.format, warnings }
}
