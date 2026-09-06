import type { Verdict } from '../data/examples'
import './VerdictBadge.css'

const LABELS: Record<Verdict, string> = {
  match: 'matches gold',
  partial: 'one layer lost',
  broken: 'structurally broken',
}

export default function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`verdict verdict--${verdict}`}>{LABELS[verdict]}</span>
}
