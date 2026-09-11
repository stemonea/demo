import type { SystemId } from './systems'

export type Verdict = 'match' | 'partial' | 'broken'

export interface SystemOutput {
  /** tagged transcript exactly as reported in the source table */
  text: string
  verdict: Verdict
  /** one-line reading of what this system did on this turn */
  note: string
}

export interface Example {
  id: string
  /** short heading, e.g. "Example 1" */
  index: string
  /** the failure mechanism the example illustrates */
  title: string
  /** longer commentary from the qualitative analysis */
  commentary: string
  gold: string
  outputs: Record<SystemId, SystemOutput>
}

/**
 * Representative test-set outputs of the reference model and of the two
 * sequential pipelines, illustrating the two failure mechanisms of sequential
 * composition.
 */
export const EXAMPLES: Example[] = [
  {
    id: 'ex1',
    index: 'Example 1',
    title: 'Each pipeline recovers exactly one layer',
    commentary:
      'Each pipeline recovers precisely the layer its final stage was trained to produce, while the joint model recovers both. The two <location> tags destroyed by the AM stage of DNER → AM are exactly the two lying inside the claim it wrapped: when the argument stage wraps a span, the entity tags nested within it are lost.',
    gold: "<person>TRUMP</person>: <claim><location>Iran</location> is taking over <location>Iraq</location></claim>.",
    outputs: {
      joint: {
        text: "<person>TRUMP</person>: <claim><location>Iran</location> is taking over <location>Iraq</location></claim>.",
        verdict: 'match',
        note: 'Both layers recovered, nesting preserved.',
      },
      'am-dner': {
        text: "<person>TRUMP</person>: <location>Iran</location> is taking over <location>Iraq</location>.",
        verdict: 'partial',
        note: 'The claim produced by the AM stage is silently dropped by the DNER stage.',
      },
      'dner-am': {
        text: "<person>TRUMP</person>: <claim>Iran is taking over Iraq</claim>.",
        verdict: 'partial',
        note: 'The AM stage wraps the claim and destroys the two entities nested inside it.',
      },
    },
  },
  {
    id: 'ex2',
    index: 'Example 2',
    title: 'The second stage destroys what the first stage got right',
    commentary:
      'AM → DNER emits </person> before any <person> opens, producing crossing markup and leaving both claims unclosed. DNER → AM is even more revealing: its entity stage tags both persons correctly, and its argument stage then keeps <person>Barack Obama</person>, which lies outside the claim it failed to produce, and destroys <person>Ahmadinejad</person>, which lies inside the claim it did produce.',
    gold:
      "<person>BIDEN</person>: Can I clarify this? <claim>That's just simply not true about <person>Barack Obama</person></claim>. <claim>He did not say sit down with <person>Ahmadinejad</person></claim>.",
    outputs: {
      joint: {
        text:
          "<person>BIDEN</person>: Can I clarify this? <claim>That's just simply not true about <person>Barack Obama</person></claim>. <claim>He did not say sit down with <person>Ahmadinejad</person></claim>.",
        verdict: 'match',
        note: 'Matches gold.',
      },
      'am-dner': {
        text:
          "<person>BIDEN</person>: Can I clarify this? <claim>That's just simply not true about</person><person>Barack Obama</person>. <claim>He did not say sit down with</person><person>Ahmadinejad</person>.",
        verdict: 'broken',
        note: 'Crossing, ill-formed markup: closers without openers and two unclosed claims.',
      },
      'dner-am': {
        text:
          "<person>BIDEN</person>: Can I clarify this? That's just simply not true about <person>Barack Obama</person>. <claim>He did not say sit down with Ahmadinejad</claim>.",
        verdict: 'broken',
        note: 'One claim never produced; the entity inside the claim it did produce is deleted.',
      },
    },
  },
  {
    id: 'ex3',
    index: 'Example 3',
    title: 'Both pipelines return entities and no argumentative structure',
    commentary:
      'Both pipelines tag <date>, <role> and <person> correctly, yet emit zero argument components, whereas the joint model recovers both the premise and the claim.',
    gold:
      "<person>ROMNEY</person>: <date>2014</date>. <premise>When you come out in <date>2014</date> I presume I'm going to be <role>president</role></premise>. <claim>I'm going to make sure you get a job</claim>. Thanks <person>Jeremy</person>.",
    outputs: {
      joint: {
        text:
          "<person>ROMNEY</person>: <date>2014</date>. <premise>When you come out in <date>2014</date> I presume I'm going to be <role>president</role></premise>. <claim>I'm going to make sure you get a job</claim>. Thanks <person>Jeremy</person>.",
        verdict: 'match',
        note: 'Matches gold.',
      },
      'am-dner': {
        text:
          "<person>ROMNEY</person>: <date>2014</date>. When you come out in <date>2014</date>, I presume I'm going to be <role>president</role>. I'm going to make sure you get a job. Thanks <person>Jeremy</person>.",
        verdict: 'partial',
        note: 'Entities correct, zero argument components.',
      },
      'dner-am': {
        text:
          "<person>ROMNEY</person>: <date>2014</date>. When you come out in <date>2014</date>, I presume I'm going to be <role>president</role>. I'm going to make sure you get a job. Thanks <person>Jeremy</person>.",
        verdict: 'partial',
        note: 'Identical to AM → DNER: entities only.',
      },
    },
  },
  {
    id: 'ex4',
    index: 'Example 4',
    title: 'Type confusion the joint model avoids',
    commentary:
      'A statistic advanced as a position is a claim, not a premise. Both pipelines mislabel it, while the joint model does not - an illustration of the lack of comprehensive signal between the two stages.',
    gold:
      '<person>ROMNEY</person>: <claim>Production on government land of oil is down 14 percent</claim>.',
    outputs: {
      joint: {
        text:
          '<person>ROMNEY</person>: <claim>Production on government land of oil is down 14 percent</claim>.',
        verdict: 'match',
        note: 'Correct component type.',
      },
      'am-dner': {
        text:
          '<person>ROMNEY</person>: <premise>Production on government land of oil is down 14 percent</premise>.',
        verdict: 'partial',
        note: 'Boundary right, type wrong: premise instead of claim.',
      },
      'dner-am': {
        text:
          '<person>ROMNEY</person>: <premise>Production on government land of oil is down 14 percent</premise>.',
        verdict: 'partial',
        note: 'Same type confusion as AM → DNER.',
      },
    },
  },
]

export const EXAMPLE_BY_ID = new Map(EXAMPLES.map((example) => [example.id, example]))
