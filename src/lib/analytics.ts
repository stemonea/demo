import { parseTaggedText, type TagNode } from './parseTags'
import { canonicalTag, getTagSpec } from './tags'

/**
 * Debate analytics.
 *
 * No model is involved: everything here is arithmetic over annotations the
 * tagger already produced. The one relation that generates every view is where
 * an entity mention sits - inside a claim, inside a premise, or outside any
 * argumentative span - which is exactly what the nesting of the joint markup
 * preserves and what a sequential pipeline loses.
 */

export interface AnalysedTurn {
  /** 0-based position in the transcript */
  index: number
  speaker: string
  tagged: string
}

export type Grounding = 'claim' | 'premise' | null

export interface Mention {
  turn: number
  speaker: string
  /** entity type, e.g. PERSON */
  type: string
  /** the text as it appeared */
  surface: string
  /** normalised key, so "Obama" and "Barack Obama" count as one entity */
  key: string
  inside: Grounding
}

export interface EntityStat {
  key: string
  /** most frequent surface form */
  label: string
  type: string
  total: number
  claim: number
  premise: number
  outside: number
}

export interface SpeakerStat {
  speaker: string
  turns: number
  claims: number
  premises: number
  mentions: number
  /** mentions that sit inside one of this speaker's argument components */
  grounded: number
}

export interface DebateStats {
  mentions: Mention[]
  entities: EntityStat[]
  speakers: SpeakerStat[]
  /** speaker x entity counts, argumentative mentions only */
  matrix: { speaker: string; key: string; count: number }[]
  /** entity pairs invoked inside the same argument component */
  cooccurrence: { a: string; b: string; count: number }[]
  turns: number
  components: number
  totalMentions: number
  groundedMentions: number
}

/** One argument component, as it was said and where. */
export interface Component {
  /** 0-based position in the transcript */
  turn: number
  speaker: string
  kind: 'claim' | 'premise'
  /** the words inside the component, tags removed */
  text: string
  /** the entities named inside it */
  mentions: { type: string; surface: string }[]
}

/**
 * Every claim and premise in order, with who said it and when.
 *
 * `analyse` counts components because that is what the totals need; this
 * returns them, because a total is where a question starts and the answer is
 * always "which ones?". The two walk the same markup and agree by construction:
 * the count of what comes back here is the `components` the summary reports.
 */
export function components(turns: AnalysedTurn[]): Component[] {
  const found: Component[] = []

  for (const turn of turns) {
    walkComponents(parseTaggedText(turn.tagged), null, (kind, node) => {
      const mentions: { type: string; surface: string }[] = []
      collectMentions(node.children, mentions)
      found.push({
        turn: turn.index,
        speaker: turn.speaker,
        kind,
        text: textOf(node).trim(),
        mentions,
      })
    })
  }

  return found
}

/** Argument components, outermost first; a nested one is reported too. */
function walkComponents(
  nodes: TagNode[],
  inside: 'claim' | 'premise' | null,
  onFound: (kind: 'claim' | 'premise', node: TagNode & { type: 'tag' }) => void,
) {
  for (const node of nodes) {
    if (node.type !== 'tag') continue
    const spec = getTagSpec(node.name)
    if (spec?.kind === 'argument') {
      const kind = node.name === 'premise' ? 'premise' : 'claim'
      onFound(kind, node)
      walkComponents(node.children, kind, onFound)
      continue
    }
    walkComponents(node.children, inside, onFound)
  }
}

/** The entities named inside one component, in the order they were said. */
function collectMentions(nodes: TagNode[], into: { type: string; surface: string }[]) {
  for (const node of nodes) {
    if (node.type !== 'tag') continue
    const spec = getTagSpec(node.name)
    if (spec?.kind === 'entity') {
      const surface = textOf(node).trim()
      /* canonical, not raw: the model writes `<organization>` and this app
         knows the tag as `org`. Left raw, the same entity type would be two
         rows in every table and two separate things to filter by. */
      if (surface) into.push({ type: canonicalTag(node.name).toUpperCase(), surface })
    }
    collectMentions(node.children, into)
  }
}

/* ------------------------------------------------------------------ *
 * Collection                                                          *
 * ------------------------------------------------------------------ */

/** Composite map keys: entity keys and speaker names both contain spaces. */
const SEP = '\u241f'

/**
 * The last aggregation, kept against the list it was made from.
 *
 * Two blocks of a live page ask for the same reading of the same debate on
 * every turn — the ballot, to say what each candidate has actually put on the
 * record, and the running totals underneath it — and the list they are both
 * handed is one array. Answering it twice is a second pass over the whole
 * transcript for a result that cannot differ from the first.
 *
 * Keyed on identity and not on contents, which is what makes it safe: this is a
 * pure function of the turns it is given, so the same array is the same answer,
 * and a list that has changed at all is a different array. One entry is enough
 * — the callers ask within the same render — and holding a single debate costs
 * nothing worth reclaiming.
 */
let lastAsked: AnalysedTurn[] | null = null
let lastAnswer: DebateStats | null = null

export function analyse(turns: AnalysedTurn[]): DebateStats {
  if (lastAnswer && turns === lastAsked) return lastAnswer

  const answer = aggregate(turns)
  lastAsked = turns
  lastAnswer = answer
  return answer
}

function aggregate(turns: AnalysedTurn[]): DebateStats {
  const mentions: Mention[] = []
  /* the mentions of each argument component, kept as they are found and
     counted into pairs only after the aliases have been folded together */
  const inComponents: Mention[][] = []
  let components = 0

  for (const turn of turns) {
    const nodes = parseTaggedText(turn.tagged)
    const byline = leadingSpeaker(nodes)
    const speaker = turn.speaker || byline || 'UNKNOWN'
    const collected: Mention[] = []

    visit(nodes, null, {
      turn: turn.index,
      speaker,
      onMention: (mention) => collected.push(mention),
      onComponent: (inside) => {
        components += 1
        inComponents.push(inside)
      },
    })

    mentions.push(...collected)
  }

  mergeAliases(mentions)

  /*
   * Pairs are counted after the merge, not during the walk.
   *
   * `mergeAliases` rewrites a mention's key in place once it has seen the
   * fuller form of the name — "obama" becomes "barack obama" — and every other
   * table here is built on the key it leaves behind. Counting the pairs while
   * walking meant counting them under the keys the merge was about to
   * replace: the figure came out keyed to entities that no longer existed, so
   * its labels fell back to the raw string and pressing a pair asked for
   * something nothing could match. The mention objects are the same ones the
   * merge has just corrected, so reading them now is all it takes.
   */
  const pairs = new Map<string, number>()
  for (const inside of inComponents) {
    const keys = [...new Set(inside.map((mention) => mention.key))].sort()
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const id = `${keys[i]}${SEP}${keys[j]}`
        pairs.set(id, (pairs.get(id) ?? 0) + 1)
      }
    }
  }

  return {
    mentions,
    entities: entityStats(mentions),
    speakers: speakerStats(turns, mentions),
    matrix: matrixOf(mentions),
    cooccurrence: [...pairs.entries()]
      .map(([id, count]) => {
        const [a, b] = id.split(SEP)
        return { a, b, count }
      })
      .sort((x, y) => y.count - x.count),
    turns: turns.length,
    components,
    totalMentions: mentions.length,
    groundedMentions: mentions.filter((mention) => mention.inside !== null).length,
  }
}

interface VisitOptions {
  turn: number
  speaker: string
  onMention: (mention: Mention) => void
  onComponent: (inside: Mention[]) => void
}

/** Tracks the leading `<person>NAME</person>:` byline, which is not a mention. */
interface Seen {
  byline: boolean
}

function visit(nodes: TagNode[], inside: Grounding, options: VisitOptions, seen: Seen = { byline: false }) {
  for (const node of nodes) {
    if (node.type !== 'tag') continue

    const spec = getTagSpec(node.name)
    if (!spec) {
      visit(node.children, inside, options, seen)
      continue
    }

    if (spec.kind === 'argument') {
      const grounding: Grounding = node.name === 'premise' ? 'premise' : 'claim'
      const collected: Mention[] = []
      visit(
        node.children,
        grounding,
        {
          ...options,
          onMention: (mention) => {
            collected.push(mention)
            options.onMention(mention)
          },
        },
        seen,
      )
      options.onComponent(collected)
      continue
    }

    const surface = textOf(node).trim()
    const isByline = node.name === 'person' && !seen.byline && inside === null
    if (node.name === 'person') seen.byline = true

    if (!isByline && surface) {
      options.onMention({
        turn: options.turn,
        speaker: options.speaker,
        /* the same canonicalisation the component mentions get, so the two
           counts of one type can never disagree */
        type: canonicalTag(node.name).toUpperCase(),
        surface,
        key: normalise(surface),
        inside,
      })
    }

    visit(node.children, inside, options, seen)
  }
}

function textOf(node: TagNode): string {
  if (node.type === 'text') return node.value
  if (node.type === 'tag') return node.children.map(textOf).join('')
  return ''
}

function leadingSpeaker(nodes: TagNode[]): string | null {
  for (const node of nodes) {
    if (node.type === 'tag' && node.name === 'person') return textOf(node).trim()
    if (node.type === 'text' && node.value.trim()) return null
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Normalisation                                                       *
 * ------------------------------------------------------------------ */

const TITLES = /\b(mr|mrs|ms|dr|sen|senator|governor|president|vice|congressman|congresswoman)\b/g

export function normalise(surface: string): string {
  const base = surface
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  /*
   * Titles come off a name, but they are not taken off a title.
   *
   * `<role>President</role>` is a whole entity whose surface is nothing but an
   * honorific: stripping it left the empty string, so every bare role in the
   * debate — president, senator, governor — merged into one nameless entity
   * that no filter could tell apart and no chart could label. Dropping the
   * titles only when something survives keeps "Mr Obama" folding into "obama"
   * while leaving a role its own name.
   */
  const stripped = base.replace(TITLES, ' ').replace(/\s+/g, ' ').trim()
  return stripped || base
}

/**
 * Collapses short forms into the fullest form seen: "obama" folds into
 * "barack obama". Crude on purpose - real deployments want entity linking, and
 * the alias table is the first thing a demo should let a visitor inspect.
 */
function mergeAliases(mentions: Mention[]) {
  const keys = [...new Set(mentions.map((mention) => mention.key))]
  const canonical = new Map<string, string>()

  for (const key of keys) {
    const longer = keys
      .filter((other) => other !== key && (other.endsWith(` ${key}`) || other.startsWith(`${key} `)))
      .sort((a, b) => b.length - a.length)[0]
    if (longer) canonical.set(key, longer)
  }

  for (const mention of mentions) {
    mention.key = canonical.get(mention.key) ?? mention.key
  }
}

/* ------------------------------------------------------------------ *
 * Aggregation                                                         *
 * ------------------------------------------------------------------ */

function entityStats(mentions: Mention[]): EntityStat[] {
  const byKey = new Map<string, Mention[]>()
  for (const mention of mentions) {
    const list = byKey.get(mention.key)
    if (list) list.push(mention)
    else byKey.set(mention.key, [mention])
  }

  return [...byKey.entries()]
    .map(([key, list]) => ({
      key,
      label: commonest(list.map((mention) => mention.surface)),
      type: commonest(list.map((mention) => mention.type)),
      total: list.length,
      claim: list.filter((mention) => mention.inside === 'claim').length,
      premise: list.filter((mention) => mention.inside === 'premise').length,
      outside: list.filter((mention) => mention.inside === null).length,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
}

function speakerStats(turns: AnalysedTurn[], mentions: Mention[]): SpeakerStat[] {
  const names = [...new Set(turns.map((turn) => turn.speaker).filter(Boolean))]

  return names.map((speaker) => {
    const own = mentions.filter((mention) => mention.speaker === speaker)
    const spoken = turns.filter((turn) => turn.speaker === speaker)
    let claims = 0
    let premises = 0
    for (const turn of spoken) {
      claims += (turn.tagged.match(/<claim>/g) ?? []).length
      premises += (turn.tagged.match(/<premise>/g) ?? []).length
    }
    return {
      speaker,
      turns: spoken.length,
      claims,
      premises,
      mentions: own.length,
      grounded: own.filter((mention) => mention.inside !== null).length,
    }
  })
}

function matrixOf(mentions: Mention[]) {
  const counts = new Map<string, number>()
  for (const mention of mentions) {
    if (mention.inside === null) continue
    const id = `${mention.speaker}${SEP}${mention.key}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()].map(([id, count]) => {
    const [speaker, key] = id.split(SEP)
    return { speaker, key, count }
  })
}

function commonest(values: string[]): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0]
}
