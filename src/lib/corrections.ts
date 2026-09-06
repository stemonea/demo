import { fromInlineMarkup } from './annotated'
import { reserveSpanIds, type Layer, type ManualSpan } from './manual'
import { stripTags } from './parseTags'

/**
 * A pass by hand over an annotation, and where it is kept between them.
 *
 * Correcting a turn is work, and work that disappears when a panel is closed is
 * work nobody will do twice. So a correction outlives the view it was made in:
 * closing the workbench, picking another turn, coming back tomorrow — the
 * annotation is still the one that was left, and the turn it belongs to is what
 * finds it again.
 *
 * It is kept in `localStorage`, which is to say on this browser and nowhere
 * else: nothing is uploaded, nothing is shared, and a visitor on another
 * machine has their own. That is the same limit the local live session states
 * about itself, and it is stated on the panel rather than assumed.
 */

export interface Correction {
  /** the plain text every span is an offset into */
  text: string
  /** the annotation as the model wrote it */
  base: ManualSpan[]
  /** the annotation as the visitor left it */
  spans: ManualSpan[]
  /** defects in the markup that had to be resolved to read it as spans */
  warnings: string[]
}

const STORE = 'jaet.corrections'
/** how many corrected turns are kept before the oldest is let go */
const KEPT = 40

/**
 * The turn a correction belongs to.
 *
 * Keyed on the words, not on the markup over them: a correction is of a turn,
 * and it should still be there when the same turn is annotated a second time —
 * including by a service that answers it slightly differently. The base it was
 * made against travels with it, so what the pass changed stays exactly as
 * measurable as it was.
 */
export function correctionKey(tagged: string): string {
  const text = stripTags(tagged).trim().replace(/\s+/g, ' ')
  /* FNV-1a: a few lines, stable across loads, and enough to tell turns apart —
     the value is a key in this browser's own store, never an identifier */
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length.toString(36)}-${hash.toString(36)}`
}

/** The model's answer, read as spans: the first draft of a pass. */
export function openCorrection(tagged: string): Correction {
  const read = fromInlineMarkup(tagged)
  return { text: read.text, base: read.spans, spans: read.spans, warnings: read.warnings }
}

/* ---- what is kept ---------------------------------------------------- */

interface Stored extends Correction {
  updated: number
}

type Record_ = { [key: string]: Stored }

function read(): Record_ {
  try {
    const raw = window.localStorage.getItem(STORE)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record_) : {}
  } catch {
    /* unreadable, disabled, or written by an older version: start clean rather
       than take the page down over a cache */
    return {}
  }
}

function write(all: Record_): boolean {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(all))
    return true
  } catch {
    /* private windows, a full quota, storage switched off: the pass still works
       for as long as the page is open, and the panel says it is not being kept */
    return false
  }
}

/** The pass left on this turn, if there is one and it can still be read. */
export function loadCorrection(tagged: string): Correction | null {
  const kept = read()[correctionKey(tagged)]
  if (!kept || typeof kept.text !== 'string') return null

  const base = spansOf(kept.base)
  const spans = spansOf(kept.spans)
  if (!spans.length && !base.length) return null

  /* the ids came from another page load; the counter must not hand them out */
  reserveSpanIds([...base, ...spans])

  return {
    text: kept.text,
    base,
    spans,
    warnings: Array.isArray(kept.warnings) ? kept.warnings.filter((line): line is string => typeof line === 'string') : [],
  }
}

/** Keeps the pass, and answers whether this browser actually took it. */
export function saveCorrection(tagged: string, correction: Correction): boolean {
  const all = read()
  all[correctionKey(tagged)] = { ...correction, updated: Date.now() }

  /* bounded: a playground open all afternoon should not grow without end */
  const keys = Object.keys(all).sort((a, b) => (all[b].updated ?? 0) - (all[a].updated ?? 0))
  for (const key of keys.slice(KEPT)) delete all[key]

  return write(all)
}

/** Forgets the pass on this turn — what *Reset* leaves behind. */
export function forgetCorrection(tagged: string): void {
  const all = read()
  if (!(correctionKey(tagged) in all)) return
  delete all[correctionKey(tagged)]
  write(all)
}

/** Spans that survived being written down: anything malformed is dropped. */
function spansOf(raw: unknown): ManualSpan[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isSpan)
}

function isSpan(value: unknown): value is ManualSpan {
  const span = value as Partial<ManualSpan> | null
  return (
    Boolean(span) &&
    typeof span?.id === 'string' &&
    typeof span.label === 'string' &&
    Number.isFinite(span.start) &&
    Number.isFinite(span.end) &&
    (span.layer as Layer) !== undefined &&
    (span.layer === 'argument' || span.layer === 'entity')
  )
}
