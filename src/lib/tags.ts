/**
 * Central registry of the inline tags used by the annotation schema.
 * Add a tag here (plus its colour token in `styles/tokens.css`) and it is
 * automatically parsed, coloured and shown in the legend everywhere.
 */
export type TagKind = 'argument' | 'entity'

export interface TagSpec {
  /** tag name as it appears in the transcript markup, e.g. `<claim>` */
  name: string
  kind: TagKind
  /** human readable label shown in the legend */
  label: string
  /** the code printed on the annotation itself, where a full label would not fit */
  short: string
  /**
   * Other names the same tag arrives under. The model writes
   * `<organization>`, this app's own colour token is `--tag-org`, and both have
   * to mean one thing: an alias is recognised, coloured and counted as the tag
   * it is, and is never rewritten in the markup itself.
   */
  aliases?: string[]
}

export const TAG_SPECS: TagSpec[] = [
  { name: 'claim', kind: 'argument', label: 'Claim', short: 'CLAIM' },
  { name: 'premise', kind: 'argument', label: 'Premise', short: 'PREMISE' },
  { name: 'person', kind: 'entity', label: 'Person', short: 'PER' },
  { name: 'location', kind: 'entity', label: 'Location', short: 'LOC' },
  { name: 'date', kind: 'entity', label: 'Date', short: 'DATE' },
  { name: 'role', kind: 'entity', label: 'Role', short: 'ROLE' },
  { name: 'org', kind: 'entity', label: 'Organization', short: 'ORG', aliases: ['organization'] },
  { name: 'party', kind: 'entity', label: 'Party', short: 'PARTY' },
  { name: 'event', kind: 'entity', label: 'Event', short: 'EVENT' },
  { name: 'law', kind: 'entity', label: 'Law', short: 'LAW' },
]

const BY_NAME = new Map<string, TagSpec>()
for (const spec of TAG_SPECS) {
  BY_NAME.set(spec.name, spec)
  for (const alias of spec.aliases ?? []) BY_NAME.set(alias, spec)
}

export function getTagSpec(name: string): TagSpec | undefined {
  return BY_NAME.get(name.toLowerCase())
}

/**
 * The name this app knows a tag by: `organization` in the markup is `org` here,
 * which is what the colour tokens and the counters are keyed on. Unknown names
 * are returned as they came — they are still shown, just not as one of ours.
 */
export function canonicalTag(name: string): string {
  const lower = name.toLowerCase()
  return BY_NAME.get(lower)?.name ?? lower
}

/** The colour of a tag, by any of its names. */
export function tagColour(name: string, fallback = 'var(--tag-fallback)'): string {
  return `var(--tag-${canonicalTag(name)}, ${fallback})`
}

/** Every name a tag can arrive under, its own included. */
export function tagNames(spec: TagSpec): string[] {
  return [spec.name, ...(spec.aliases ?? [])]
}

export function tagsOfKind(kind: TagKind): TagSpec[] {
  return TAG_SPECS.filter((spec) => spec.kind === kind)
}
