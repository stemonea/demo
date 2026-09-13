/**
 * Project-level copy and headline numbers.
 * Anonymous by design: no author, affiliation or venue is referenced anywhere
 * in the app, so the demo can be shared during blind review.
 */
export const PROJECT = {
  name: 'ArguStream',
  system: 'JOINT',
  dataset: 'DNE-ElecDeb',
  tagline:
    'A real-time debate analyzer that identifies arguments and entities as the discussion unfolds, while preserving the original transcript.',
}

/** The two structural reasons why sequential composition fails. */
export const FAILURE_MECHANISMS = [
  {
    title: 'Each stage is blind to the layer the other predicts',
    body:
      'An entity in subject position signals a predication, and hence a claim; conversely, a claim constrains which entity types are plausible inside it. Neither module can exploit the other’s signal, since each is trained in isolation.',
  },
  {
    title: 'The second stage rewrites already-tagged text',
    body:
      'The second stage must insert its own tags into text that already carries the tags of the first one - a condition it is never supervised on. This produces crossing, ill-formed markup and, more insidiously, the silent deletion of tags the first stage had produced correctly.',
  },
]
