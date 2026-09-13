import type { Verdict } from '../data/examples'
import './VerdictBadge.css'

const LABELS: Record<Verdict, string> = {
  match: 'matches gold',
  partial: 'one layer lost',
  broken: 'structurally broken',
}

/**
 * `note` is what the badge says when it is pointed at. The curated examples
 * carry one written by hand; a verdict worked out from the markup carries the
 * line `checkNesting` composed, so a reader who wants to know *what* is broken
 * does not have to go looking for it.
 */
export default function VerdictBadge({ verdict, note }: { verdict: Verdict; note?: string | null }) {
  return (
    <span className={`verdict verdict--${verdict}`} title={note ?? undefined}>
      {LABELS[verdict]}
    </span>
  )
}
