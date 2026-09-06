export type SystemId = 'joint' | 'am-dner' | 'dner-am'

export interface SystemSpec {
  id: SystemId
  name: string
  kind: 'joint' | 'pipeline'
  tagline: string
  /** short description of the processing order */
  flow: string[]
}

/** The three columns of the comparison view, in display order. */
export const SYSTEMS: SystemSpec[] = [
  {
    id: 'joint',
    name: 'JOINT',
    kind: 'joint',
    tagline: 'Single pass: argument and entity tags are predicted together.',
    flow: ['turn', 'JOINT', 'arguments + entities'],
  },
  {
    id: 'am-dner',
    name: 'AM → DNER',
    kind: 'pipeline',
    tagline: 'Argument mining first, then entity recognition over tagged text.',
    flow: ['turn', 'AM', 'DNER', 'output'],
  },
  {
    id: 'dner-am',
    name: 'DNER → AM',
    kind: 'pipeline',
    tagline: 'Entity recognition first, then argument mining over tagged text.',
    flow: ['turn', 'DNER', 'AM', 'output'],
  },
]

export const SYSTEM_BY_ID = new Map(SYSTEMS.map((system) => [system.id, system]))
