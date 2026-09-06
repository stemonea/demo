import { getTagSpec, type TagKind } from './tags'

/**
 * A deliberately forgiving parser for the inline markup produced by the joint
 * model and by the sequential pipelines. Sequential pipelines emit *ill-formed* markup
 * (crossing tags, stray closers, unclosed spans): those defects are the point of
 * the comparison, so instead of throwing we keep them as first-class nodes and
 * let the UI highlight them.
 */
export type TagNode =
  | { type: 'text'; value: string }
  | { type: 'tag'; name: string; kind: TagKind | 'unknown'; unclosed: boolean; children: TagNode[] }
  /** a closing tag with no matching opener, e.g. `</person>` appearing alone */
  | { type: 'orphan'; name: string; raw: string }

const TOKEN = /<(\/?)([a-zA-Z][\w-]*)>/g

interface Frame {
  name: string
  children: TagNode[]
}

/**
 * The last few hundred parses, kept.
 *
 * A live debate re-reads its whole transcript on every turn: the totals, the
 * components, the tagged text of every turn already on screen. The parse is
 * deterministic and the trees are never mutated — `filterLayer` and
 * `filterTags` copy the nodes they change, and everything else only reads — so
 * the same string can hand back the same tree, and a debate that walked its
 * own past on every turn stops costing the square of its own length.
 *
 * Bounded, because the playground types new strings all day: past the cap the
 * oldest entry goes. A Map iterates in insertion order, which is all the
 * bookkeeping that needs.
 */
const CACHE = new Map<string, TagNode[]>()
const CACHE_MAX = 512

export function parseTaggedText(input: string): TagNode[] {
  const kept = CACHE.get(input)
  if (kept) return kept
  const parsed = parse(input)
  CACHE.set(input, parsed)
  if (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next()
    if (!oldest.done) CACHE.delete(oldest.value)
  }
  return parsed
}

function parse(input: string): TagNode[] {
  const root: TagNode[] = []
  const stack: Frame[] = []
  const current = () => (stack.length ? stack[stack.length - 1].children : root)

  let cursor = 0
  let match: RegExpExecArray | null

  TOKEN.lastIndex = 0
  while ((match = TOKEN.exec(input)) !== null) {
    const [raw, slash, rawName] = match
    const name = rawName.toLowerCase()

    if (match.index > cursor) {
      current().push({ type: 'text', value: input.slice(cursor, match.index) })
    }
    cursor = match.index + raw.length

    if (!slash) {
      stack.push({ name, children: [] })
      continue
    }

    const openIndex = findOpen(stack, name)
    if (openIndex === -1) {
      // stray closer: no opener anywhere on the stack
      current().push({ type: 'orphan', name, raw })
      continue
    }
    // close everything above the match; those spans were never closed properly
    while (stack.length - 1 > openIndex) {
      closeTop(stack, root, true)
    }
    closeTop(stack, root, false)
  }

  if (cursor < input.length) {
    current().push({ type: 'text', value: input.slice(cursor) })
  }
  while (stack.length) {
    closeTop(stack, root, true)
  }

  return root
}

function findOpen(stack: Frame[], name: string): number {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].name === name) return i
  }
  return -1
}

function closeTop(stack: Frame[], root: TagNode[], unclosed: boolean) {
  const frame = stack.pop()
  if (!frame) return
  const parent = stack.length ? stack[stack.length - 1].children : root
  parent.push({
    type: 'tag',
    name: frame.name,
    kind: getTagSpec(frame.name)?.kind ?? 'unknown',
    unclosed,
    children: frame.children,
  })
}

export interface MarkupIssues {
  orphanClosers: number
  unclosedTags: number
}

/** Counts the structural defects in a parsed output, for the "well-formed" badge. */
export function collectIssues(nodes: TagNode[], acc: MarkupIssues = { orphanClosers: 0, unclosedTags: 0 }): MarkupIssues {
  for (const node of nodes) {
    if (node.type === 'orphan') acc.orphanClosers += 1
    if (node.type === 'tag') {
      if (node.unclosed) acc.unclosedTags += 1
      collectIssues(node.children, acc)
    }
  }
  return acc
}

/** Tag frequencies of a parsed output, keyed by tag name. */
export function countTags(nodes: TagNode[], acc: Map<string, number> = new Map()): Map<string, number> {
  for (const node of nodes) {
    if (node.type !== 'tag') continue
    acc.set(node.name, (acc.get(node.name) ?? 0) + 1)
    countTags(node.children, acc)
  }
  return acc
}

/** The plain transcript behind a tagged string: every tag removed, text intact. */
export function stripTags(text: string): string {
  return collectText(parseTaggedText(text))
}

function collectText(nodes: TagNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if (node.type === 'tag') out += collectText(node.children)
  }
  return out
}

/**
 * Writes parsed nodes back to inline markup — the inverse of the parser, used
 * when a filtered view has to travel on as text (raw markup, copy, export).
 * A span the model never closed is serialised as it arrived, opener only, so
 * the round-trip never silently repairs a defect.
 */
export function serializeNodes(nodes: TagNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if (node.type === 'orphan') out += node.raw
    else {
      out += `<${node.name}>${serializeNodes(node.children)}`
      if (!node.unclosed) out += `</${node.name}>`
    }
  }
  return out
}
