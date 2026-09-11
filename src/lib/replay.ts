import { parseTaggedText, serializeNodes, type TagNode } from './parseTags'

/**
 * Replaying a stored annotation as if it were being computed.
 *
 * The bundled turns are pre-computed: their answer is already in the bundle and
 * nothing is sent anywhere. Dropping it on screen in one frame hides what the
 * model actually does, so the playground plays it back instead - the turn is
 * revealed a few words at a time and each span closes around its text the moment
 * it is reached, which is the shape of the real output as it arrives.
 *
 * Every intermediate string is well-formed markup: a span is only ever shown
 * already closed, so the forgiving parser never has to report a defect that the
 * stored answer does not have.
 */

export type ReplayPhase = 'reading' | 'argument' | 'entity'

export interface ReplayStep {
  /** the markup revealed so far - always parseable on its own */
  text: string
  /** what the model is doing at this point, for the caption */
  phase: ReplayPhase
}

export interface Replay {
  steps: ReplayStep[]
  intervalMs: number
}

/** How long a whole replay should take, and the beat it is cut into. */
const TOTAL_MS = 2100
const MAX_STEPS = 44
const MIN_INTERVAL_MS = 40
const MAX_INTERVAL_MS = 130
/** words revealed per step inside plain, untagged stretches */
const WORDS_PER_STEP = 2

export function buildReplay(tagged: string): Replay {
  const steps = sample(reveal(parseTaggedText(tagged)), MAX_STEPS)
  const beat = Math.round(TOTAL_MS / Math.max(steps.length, 1))
  const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, beat))
  return { steps, intervalMs }
}

/** Every intermediate serialisation on the way to the full markup, in order. */
function reveal(nodes: TagNode[]): ReplayStep[] {
  const steps: ReplayStep[] = []
  let done = ''

  for (const node of nodes) {
    if (node.type === 'text') {
      for (const chunk of chunks(node.value)) {
        done += chunk
        push(steps, { text: done, phase: 'reading' })
      }
      continue
    }

    if (node.type === 'orphan') {
      done += node.raw
      push(steps, { text: done, phase: 'reading' })
      continue
    }

    const phase: ReplayPhase = node.kind === 'entity' ? 'entity' : node.kind === 'argument' ? 'argument' : 'reading'
    const open = `<${node.name}>`
    const close = node.unclosed ? '' : `</${node.name}>`

    /* the span grows around its own text, opened and closed at every step */
    for (const inner of reveal(node.children)) {
      push(steps, { text: `${done}${open}${inner.text}${close}`, phase })
    }
    done += open + serializeNodes(node.children) + close
    push(steps, { text: done, phase })
  }

  return steps
}

/** A step that reveals nothing new is not a step. */
function push(steps: ReplayStep[], step: ReplayStep) {
  if (steps[steps.length - 1]?.text === step.text) {
    steps[steps.length - 1] = step
    return
  }
  steps.push(step)
}

/** Splits text into whitespace-preserving chunks of a couple of words. */
function chunks(value: string): string[] {
  const words = value.split(/(?<=\s)(?=\S)/)
  const out: string[] = []
  for (let i = 0; i < words.length; i += WORDS_PER_STEP) {
    out.push(words.slice(i, i + WORDS_PER_STEP).join(''))
  }
  return out.length ? out : [value]
}

/**
 * Thins a long reveal down to `max` steps so a long turn does not take longer to
 * replay than a short one. The last step is always kept: it is the full answer.
 */
function sample(steps: ReplayStep[], max: number): ReplayStep[] {
  if (steps.length <= max) return steps
  const stride = steps.length / max
  const out: ReplayStep[] = []
  for (let i = 0; i < max - 1; i += 1) out.push(steps[Math.floor(i * stride)])
  out.push(steps[steps.length - 1])
  return out
}
