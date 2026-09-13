/**
 * Manual annotation: building JOINT-shaped data by hand.
 *
 * Independent of the tag registry in `lib/tags.ts`, because here the entity set
 * is whatever the user declares. Spans are kept as character offsets over the
 * untouched text, which is the representation every export can be derived from.
 */

export type Layer = 'argument' | 'entity'

/**
 * The argument layer is fixed - the CoNLL export writes one column per layer, so
 * the two components it can name are known ahead of time. The entity layer is
 * whatever the user declares, or whatever an imported annotation turns out to
 * contain.
 */
export const ARGUMENT_LABELS = ['CLAIM', 'PREMISE']

/** The layer a label belongs to, which is the one thing a label implies. */
export function layerOf(label: string): Layer {
  return ARGUMENT_LABELS.includes(label.toUpperCase()) ? 'argument' : 'entity'
}

/**
 * Span identity, handed out by a counter rather than derived from the span's own
 * offsets: an id has to survive the span being moved, which is the whole point
 * of editing one.
 */
let issued = 0
export function newSpanId(): string {
  issued += 1
  return `span-${issued}`
}

/**
 * Takes ids that already exist out of circulation.
 *
 * A counter that starts at zero on every page load is fine while every span is
 * minted in that load. Spans that come back from storage were minted in another
 * one, and the next `newSpanId()` would hand out an id one of them already
 * holds - two different spans under one identity, which is exactly what the id
 * exists to prevent. Restoring an annotation therefore pushes the counter past
 * everything it restored.
 */
export function reserveSpanIds(spans: ManualSpan[]): void {
  for (const span of spans) {
    const match = /^span-(\d+)$/.exec(span.id)
    if (match) issued = Math.max(issued, Number(match[1]))
  }
}

export interface ManualSpan {
  id: string
  start: number
  end: number
  /** upper-case label, e.g. CLAIM or PRODUCT */
  label: string
  layer: Layer
}

export interface ManualToken {
  text: string
  start: number
  end: number
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu

export function tokenize(text: string): ManualToken[] {
  return [...text.matchAll(WORD)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }))
}

const layerDepth = (layer: Layer) => (layer === 'argument' ? 0 : 1)

/**
 * The order spans nest in, outermost first: the earlier start, then the longer
 * span, and on the very same words the argument component outside the entity.
 *
 * That last rule is the schema's rather than a tie-break of convenience: a
 * premise that is nothing but a date is `<premise><date>2022</date></premise>`,
 * and an argument component never sits inside an entity. The markup, the
 * import and the sheet all read the order from here, so they cannot disagree
 * about which of two spans is the container.
 */
export function outerFirst(a: Omit<ManualSpan, 'id'>, b: Omit<ManualSpan, 'id'>): number {
  return a.start - b.start || b.end - a.end || layerDepth(a.layer) - layerDepth(b.layer)
}

/**
 * Two spans may nest or sit apart, whatever their layers - an entity inside a
 * claim, or a claim and an entity on the very same words - but they may never
 * partially overlap. Inline markup cannot write a half-overlap, because tags
 * close in the reverse of the order they opened, and one BIO column cannot
 * either; so it is refused at the point of creation rather than repaired later.
 * The same words carry at most one span of each layer.
 */
export function canAdd(
  spans: ManualSpan[],
  candidate: Omit<ManualSpan, 'id'>,
  /** the span being edited, which must not be compared against itself */
  ignoreId?: string,
): string | null {
  if (candidate.end <= candidate.start) return 'Select some text first.'

  for (const span of spans) {
    if (span.id === ignoreId) continue
    const sameLayer = span.layer === candidate.layer
    const identical = span.start === candidate.start && span.end === candidate.end
    if (identical && sameLayer) return `That span is already tagged ${span.label}.`
    const nested = (span.start <= candidate.start && span.end >= candidate.end) || (candidate.start <= span.start && candidate.end >= span.end)
    const disjoint = span.end <= candidate.start || span.start >= candidate.end
    if (nested || disjoint) continue
    /* across layers this used to be let through, and came out as crossing tags
       in the export and as a span the sheet could not draw */
    return sameLayer
      ? 'Spans of the same layer cannot partially overlap. Put one inside the other, or keep them apart.'
      : `That would cut across the ${span.label} span. Put one inside the other, or keep them apart.`
  }

  return null
}

/**
 * Rebuilds the inline markup.
 *
 * Every span is given its place in the nesting, and tags open in that order and
 * close in the reverse of it. Length alone used to decide, which says nothing
 * when two spans cover the very same words: `<premise><date>2022</date></premise>`
 * came back as `<date><premise>2022</date></premise>`, crossed.
 */
export function toTagged(text: string, spans: ManualSpan[]): string {
  const marks: { at: number; open: boolean; rank: number; label: string }[] = []
  const nesting = [...spans].sort(outerFirst)
  nesting.forEach((span, rank) => {
    const label = span.label.toLowerCase()
    marks.push({ at: span.start, open: true, rank, label })
    marks.push({ at: span.end, open: false, rank, label })
  })

  marks.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    if (a.open !== b.open) return a.open ? 1 : -1 // closes before opens
    // opening: outer first; closing: inner first
    return a.open ? a.rank - b.rank : b.rank - a.rank
  })

  let out = ''
  let cursor = 0
  for (const mark of marks) {
    out += text.slice(cursor, mark.at)
    out += mark.open ? `<${mark.label}>` : `</${mark.label}>`
    cursor = mark.at
  }
  return out + text.slice(cursor)
}

/** Two-layer BIO, computed straight from the spans so custom labels survive. */
export function toConll(text: string, spans: ManualSpan[]): string {
  const tokens = tokenize(text)
  const argument = bioColumn(tokens, spans.filter((span) => span.layer === 'argument'))
  const entity = bioColumn(tokens, spans.filter((span) => span.layer === 'entity'))

  return (
    ['# token\targument\tentity', ...tokens.map((token, i) => `${token.text}\t${argument[i]}\t${entity[i]}`)].join(
      '\n',
    ) + '\n'
  )
}

/**
 * One BIO column. Spans are written outermost first so a nested span overwrites
 * its parent - BIO can only name one span per token, and the innermost is the
 * informative one.
 */
function bioColumn(tokens: ManualToken[], spans: ManualSpan[]): string[] {
  const column = tokens.map(() => 'O')
  const outermostFirst = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start))

  for (const span of outermostFirst) {
    let position = 0
    tokens.forEach((token, i) => {
      if (token.start < span.start || token.end > span.end) return
      column[i] = `${position === 0 ? 'B' : 'I'}-${span.label.toUpperCase()}`
      position += 1
    })
  }

  return column
}

export function toJson(text: string, spans: ManualSpan[]): string {
  return JSON.stringify(
    {
      text,
      spans: spans
        .map(({ start, end, label, layer }) => ({ start, end, label: label.toUpperCase(), layer }))
        .sort((a, b) => a.start - b.start || b.end - a.end),
    },
    null,
    2,
  )
}

/* ---- refining a span by hand ----------------------------------------- *
 * An imported annotation is a first draft: the interesting work is moving a
 * boundary one token at a time until it sits where a human would have put it.
 * Every edit is token-aligned, because a span that ends inside a word has no
 * reading in BIO - which is what the export has to produce.
 * --------------------------------------------------------------------- */

/** The first and last token a span covers, or null if it covers none. */
export function spanRange(tokens: ManualToken[], span: ManualSpan): { first: number; last: number } | null {
  let first = -1
  let last = -1
  tokens.forEach((token, index) => {
    if (token.start < span.start || token.end > span.end) return
    if (first === -1) first = index
    last = index
  })
  return first === -1 ? null : { first, last }
}

export type Edge = 'start' | 'end'

/**
 * Moves one edge of a span by a single token: `-1` pulls the edge to the left,
 * `+1` pushes it to the right. Growing past the text, or shrinking a span down
 * to nothing, is refused rather than clamped - the button is what tells the
 * visitor there is nowhere left to go.
 */
export function nudgeSpan(
  tokens: ManualToken[],
  span: ManualSpan,
  edge: Edge,
  direction: -1 | 1,
): ManualSpan | null {
  const range = spanRange(tokens, span)
  if (!range) return null
  const { first, last } = range

  if (edge === 'start') {
    const target = first + direction
    if (target < 0 || target > last) return null
    return { ...span, start: tokens[target].start }
  }

  const target = last + direction
  if (target < first || target > tokens.length - 1) return null
  return { ...span, end: tokens[target].end }
}

/* ---- what a correction pass changed ---------------------------------- *
 * A draft that came from a model is worth exporting as gold only if it is
 * clear what a person did to it. Ids are handed out once and survive every
 * edit, so the two annotations can be compared span by span rather than
 * guessed at by overlap.
 * ---------------------------------------------------------------------- */

export interface SpanDiff {
  added: number
  removed: number
  /** kept spans whose boundaries were moved */
  moved: number
  /** kept spans given a different class */
  relabelled: number
  /** spans touched in any way: what the footer counts */
  edits: number
}

export function diffSpans(base: ManualSpan[], current: ManualSpan[]): SpanDiff {
  const before = new Map(base.map((span) => [span.id, span]))
  const diff: SpanDiff = { added: 0, removed: 0, moved: 0, relabelled: 0, edits: 0 }

  for (const span of current) {
    const was = before.get(span.id)
    if (!was) {
      diff.added += 1
      continue
    }
    const moved = was.start !== span.start || was.end !== span.end
    const relabelled = was.label !== span.label
    if (moved) diff.moved += 1
    if (relabelled) diff.relabelled += 1
    if (moved || relabelled) diff.edits += 1
  }

  const kept = new Set(current.map((span) => span.id))
  diff.removed = base.filter((span) => !kept.has(span.id)).length
  diff.edits += diff.added + diff.removed

  return diff
}

/**
 * Applies an edit to one span, keeping the annotation legal: a move that would
 * make two spans of the same layer half-overlap is refused, and the reason is
 * handed back so the interface can say it.
 */
export function editSpan(
  spans: ManualSpan[],
  next: ManualSpan,
): { spans: ManualSpan[]; error: string | null } {
  const problem = canAdd(spans, next, next.id)
  if (problem) return { spans, error: problem }
  return { spans: spans.map((span) => (span.id === next.id ? next : span)), error: null }
}
