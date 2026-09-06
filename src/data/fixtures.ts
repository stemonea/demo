import { stripTags } from '../lib/parseTags'
import { EXAMPLES } from './examples'
import type { SystemId } from './systems'

/**
 * Pre-computed answers, used while no backend is configured.
 *
 * They are not invented: every string is a reported model output for that turn,
 * so what the interface shows offline is exactly what the three systems produced.
 * The UI always labels these as pre-computed — see `lib/api.ts`.
 */
export interface Fixture {
  id: string
  label: string
  /** the raw turn, i.e. the tagged output with every tag removed */
  text: string
  outputs: Record<SystemId, string>
}

export const FIXTURES: Fixture[] = EXAMPLES.map((example) => ({
  id: example.id,
  label: example.index,
  text: stripTags(example.gold),
  outputs: {
    joint: example.outputs.joint.text,
    'am-dner': example.outputs['am-dner'].text,
    'dner-am': example.outputs['dner-am'].text,
  },
}))

/** Loose matching, so retyped whitespace or a trailing period still hits. */
export function findFixture(text: string): Fixture | undefined {
  const needle = normalise(text)
  if (!needle) return undefined
  return (
    FIXTURES.find((fixture) => normalise(fixture.text) === needle) ??
    FIXTURES.find((fixture) => normalise(fixture.text).startsWith(needle) && needle.length > 40)
  )
}

function normalise(text: string): string {
  return text
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** The excerpt played back by the live view, one entry per debate turn. */
export interface TranscriptTurn {
  id: string
  speaker: string
  /** raw turn as it would arrive from a live feed */
  text: string
  /** pre-computed annotation for that turn */
  tagged: string
}

export const TRANSCRIPT: TranscriptTurn[] = FIXTURES.map((fixture, i) => {
  const tagged = fixture.outputs.joint
  return {
    id: `turn-${i + 1}`,
    speaker: speakerOf(tagged),
    text: fixture.text,
    tagged,
  }
})

function speakerOf(tagged: string): string {
  return tagged.match(/^<person>([^<]+)<\/person>\s*:/)?.[1] ?? 'SPEAKER'
}
