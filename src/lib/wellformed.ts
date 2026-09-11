import type { Verdict } from '../data/examples'
import { getTagSpec } from './tags'

/**
 * Is this annotation legally nested?
 *
 * `parseTags.ts` is deliberately forgiving: it takes whatever the model emitted
 * and builds a tree out of it, because the interface has to render a defective
 * answer rather than refuse it. That leaves nobody saying the answer *was*
 * defective - and a turn whose markup crosses itself is exactly the failure the
 * curated examples in `data/examples.ts` were picked to show. So the same
 * judgement those examples carry by hand is made here by machine, in the same
 * vocabulary: a `Verdict`, and one line saying what was wrong with it.
 *
 * Only `'broken'` is ever returned. `'match'` and `'partial'` are claims about a
 * gold annotation, and at the moment a turn is annotated there is no gold to
 * compare it against - asserting either from the structure alone would be
 * inventing a result. Well-formed markup therefore gets no badge at all.
 *
 * The schema being checked is the one the joint model writes:
 *
 *   - an argument component - `<claim>` or `<premise>` - holds text and any
 *     number of entity tags, which is the nesting the joint annotation exists
 *     to produce;
 *   - an entity tag holds text and nothing else;
 *   - an argument component never sits inside another span;
 *   - every closer comes after its opener, and closes the span that is open.
 *
 * Everything else is a defect, and each one is reported where it happened.
 */

export type Malformation =
  /** `</claim>` with no `<claim>` open anywhere before it */
  | { kind: 'stray-closer'; tag: string; at: number }
  /** `</claim>` while `<person>` is the span actually open: the two cross */
  | { kind: 'crossing'; tag: string; open: string; at: number }
  /** opened and never closed */
  | { kind: 'unclosed'; tag: string; at: number }
  /** an argument component inside another span, of either layer */
  | { kind: 'argument-inside'; tag: string; inside: string; at: number }
  /** an entity inside another entity */
  | { kind: 'entity-inside'; tag: string; inside: string; at: number }

export interface Wellformedness {
  ok: boolean
  /** `'broken'` when the nesting is illegal, null when there is nothing to say */
  verdict: Verdict | null
  issues: Malformation[]
  /** one line in the voice the examples use, or null when `ok` */
  note: string | null
}

const TOKEN = /<(\/?)([a-zA-Z][\w-]*)>/g

/** What the stack holds: a span that is open, and where it was opened. */
interface Open {
  name: string
  layer: 'argument' | 'entity' | 'unknown'
  at: number
}

const layerOf = (name: string): Open['layer'] => {
  const kind = getTagSpec(name)?.kind
  return kind === 'argument' || kind === 'entity' ? kind : 'unknown'
}

/**
 * The last few hundred answers, kept.
 *
 * Same reason as the parse cache next door: a live debate re-reads every turn
 * already on screen on every new turn, and this walk is a pure function of the
 * string it is given.
 */
const CACHE = new Map<string, Wellformedness>()
const CACHE_MAX = 512

export function checkNesting(tagged: string): Wellformedness {
  const kept = CACHE.get(tagged)
  if (kept) return kept
  const checked = check(tagged)
  CACHE.set(tagged, checked)
  if (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next()
    if (!oldest.done) CACHE.delete(oldest.value)
  }
  return checked
}

function check(tagged: string): Wellformedness {
  const issues: Malformation[] = []
  /* the tag state, innermost last: what is open right now, and in what order */
  const stack: Open[] = []

  let match: RegExpExecArray | null
  TOKEN.lastIndex = 0

  while ((match = TOKEN.exec(tagged)) !== null) {
    const [, slash, rawName] = match
    const name = rawName.toLowerCase()
    const at = match.index
    const layer = layerOf(name)

    if (slash) {
      const top = stack[stack.length - 1]
      if (top && top.name === name) {
        stack.pop()
        continue
      }
      /* a closer that does not close the open span: either it belongs to
         something further down - the two spans cross - or to nothing at all */
      if (stack.some((open) => open.name === name)) {
        issues.push({ kind: 'crossing', tag: name, open: top!.name, at })
        /* taken as closing the one it names, so the rest of the turn is read
           against the state the model evidently believed it was in */
        while (stack.length && stack[stack.length - 1].name !== name) stack.pop()
        stack.pop()
      } else {
        issues.push({ kind: 'stray-closer', tag: name, at })
      }
      continue
    }

    /* an opener is legal by what it is opened inside of */
    const inside = stack[stack.length - 1]
    if (inside) {
      if (layer === 'argument') {
        issues.push({ kind: 'argument-inside', tag: name, inside: inside.name, at })
      } else if (layer === 'entity' && inside.layer === 'entity') {
        issues.push({ kind: 'entity-inside', tag: name, inside: inside.name, at })
      }
    }
    stack.push({ name, layer, at })
  }

  for (const open of stack) issues.push({ kind: 'unclosed', tag: open.name, at: open.at })

  const ok = issues.length === 0
  return {
    ok,
    verdict: ok ? null : 'broken',
    issues,
    note: ok ? null : describe(issues),
  }
}

/**
 * The defects as one line, counted by kind.
 *
 * Counted rather than listed: a pipeline that loses its footing on a long turn
 * produces the same defect a dozen times, and a badge whose tooltip is a dozen
 * near-identical clauses says less than one that says how many.
 */
function describe(issues: Malformation[]): string {
  const tally = new Map<Malformation['kind'], number>()
  for (const issue of issues) tally.set(issue.kind, (tally.get(issue.kind) ?? 0) + 1)

  const said = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const parts: string[] = []

  const crossing = tally.get('crossing')
  if (crossing) parts.push(said(crossing, 'crossing closer', 'crossing closers'))

  const stray = tally.get('stray-closer')
  if (stray) parts.push(said(stray, 'closer without an opener', 'closers without an opener'))

  const unclosed = tally.get('unclosed')
  if (unclosed) parts.push(said(unclosed, 'unclosed span', 'unclosed spans'))

  const argument = tally.get('argument-inside')
  if (argument) parts.push(said(argument, 'argument component nested inside another span', 'argument components nested inside another span'))

  const entity = tally.get('entity-inside')
  if (entity) parts.push(said(entity, 'entity inside another entity', 'entities inside another entity'))

  return `Ill-formed markup: ${parts.join(', ')}.`
}
