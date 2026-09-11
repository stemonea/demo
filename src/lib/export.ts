import { parseTaggedText, type TagNode } from './parseTags'
import { getTagSpec, type TagKind } from './tags'

/**
 * Turning a tagged turn into the formats other tools read.
 * One traversal produces both the token stream (for BIO/CoNLL) and the character
 * spans (for JSON), so the two exports can never disagree.
 */

export interface Token {
  text: string
  start: number
  end: number
  /** BIO tag of the argument layer, e.g. `B-CLAIM` */
  argument: string
  /** BIO tag of the entity layer, e.g. `I-PERSON` */
  entity: string
}

export interface Span {
  start: number
  end: number
  label: string
  layer: TagKind
}

export interface Extraction {
  plain: string
  tokens: Token[]
  spans: Span[]
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu

export function extract(tagged: string): Extraction {
  const state = { plain: '', tokens: [] as Token[], spans: [] as Span[] }
  walk(parseTaggedText(tagged), { argument: null, entity: null }, state)
  return state
}

interface Context {
  argument: { label: string; fresh: boolean } | null
  entity: { label: string; fresh: boolean } | null
}

function walk(nodes: TagNode[], context: Context, state: Extraction & { plain: string }) {
  for (const node of nodes) {
    if (node.type === 'orphan') continue

    if (node.type === 'text') {
      for (const match of node.value.matchAll(WORD)) {
        const start = state.plain.length + (match.index ?? 0)
        state.tokens.push({
          text: match[0],
          start,
          end: start + match[0].length,
          argument: bio(context.argument),
          entity: bio(context.entity),
        })
        if (context.argument) context.argument.fresh = false
        if (context.entity) context.entity.fresh = false
      }
      state.plain += node.value
      continue
    }

    const spec = getTagSpec(node.name)
    if (!spec) {
      walk(node.children, context, state)
      continue
    }

    const layer = spec.kind
    const label = node.name.toUpperCase()
    const previous = context[layer]
    context[layer] = { label, fresh: true }

    const start = state.plain.length
    walk(node.children, context, state)
    state.spans.push({ start, end: state.plain.length, label, layer })

    context[layer] = previous
  }
}

function bio(active: Context['argument']): string {
  if (!active) return 'O'
  return `${active.fresh ? 'B' : 'I'}-${active.label}`
}

/* ---------------- serialisers ---------------- */

/** Two-layer CoNLL: token, argument BIO, entity BIO. */
export function toConll(tagged: string): string {
  const { tokens } = extract(tagged)
  const header = '# token\targument\tentity'
  return [header, ...tokens.map((t) => `${t.text}\t${t.argument}\t${t.entity}`)].join('\n') + '\n'
}

/** Character-offset spans over the untouched transcript. */
export function toJson(tagged: string): string {
  const { plain, spans, tokens } = extract(tagged)
  return JSON.stringify(
    {
      text: plain,
      spans: spans.sort((a, b) => a.start - b.start || a.end - b.end),
      tokens: tokens.map(({ text, start, end, argument, entity }) => ({ text, start, end, argument, entity })),
    },
    null,
    2,
  )
}

/** The inline markup itself, as the model emits it. */
export function toXml(tagged: string): string {
  return tagged.trim() + '\n'
}

/**
 * What was said, with the annotation taken back off.
 *
 * The transcript is the one artefact somebody reads rather than parses - it
 * gets pasted into a report, mailed to a speaker, searched for a sentence -
 * and every other format here is unreadable at that job. It is `extract`'s
 * `plain`, not a regex over the markup, so what comes out is exactly the text
 * the character offsets in the JSON export are counted against: the two can
 * never drift, and a span from one always lands on the right words in the
 * other.
 */
export function toText(tagged: string): string {
  return extract(tagged).plain.trim() + '\n'
}

export const FORMATS = [
  { id: 'txt', label: 'Plain text', extension: 'txt', mime: 'text/plain', run: toText },
  { id: 'xml', label: 'Inline XML', extension: 'xml', mime: 'application/xml', run: toXml },
  { id: 'conll', label: 'BIO / CoNLL', extension: 'tsv', mime: 'text/tab-separated-values', run: toConll },
  { id: 'json', label: 'JSON spans', extension: 'json', mime: 'application/json', run: toJson },
] as const

export type FormatId = (typeof FORMATS)[number]['id']

/**
 * Hands the file to the browser.
 *
 * The object URL is released on a later tick, not on the next line. Revoking it
 * the instant after `click()` is a race the browser sometimes loses: the click
 * only *starts* the download, and a URL pulled out from under it before it has
 * been read gives an empty file or nothing at all - intermittently, and more
 * often on a slow machine, which is the worst way for a bug like this to
 * behave. A minute is longer than any browser needs and still frees it.
 */
export function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
