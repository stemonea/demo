/**
 * A duration as a person reads one: milliseconds until they are seconds.
 *
 * Under ten milliseconds it keeps a decimal. A rule-based stand-in answers a
 * turn in a fraction of one, and rounding that to `0 ms` reads as a broken
 * clock rather than as a tagger that cost nothing.
 *
 * It lives here rather than beside the one view that first needed it because
 * the comparison of the three systems is now made in two places, and a figure
 * printed two ways is a figure two readers will disagree about.
 */
export function ms(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`
  if (value < 10) return `${value.toFixed(1)} ms`
  return `${Math.round(value)} ms`
}
