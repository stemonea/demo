import type { Source } from '../lib/api'
import './SourceBadge.css'

const COPY: Record<Source, { label: string; title: string }> = {
  backend: { label: 'annotation service', title: 'Live answer from the configured backend' },
  precomputed: {
    label: 'pre-computed',
    title: 'A bundled example: the reported output for this turn, replayed in the browser - nothing was sent to the annotation service',
  },
  heuristic: {
    label: 'offline heuristic',
    title: 'No backend configured and no fixture for this text: rough local tagger, not a model prediction',
  },
  file: {
    label: 'from the file',
    title: 'This turn arrived already annotated in the loaded transcript: replayed as it is, nothing was computed',
  },
}

/** Says where an answer came from. Never let a stub look like a prediction. */
export default function SourceBadge({ source, elapsedMs }: { source: Source; elapsedMs?: number }) {
  const copy = COPY[source]
  return (
    <span className={`source source--${source}`} title={copy.title}>
      {copy.label}
      {elapsedMs !== undefined && <span className="source__time">{Math.round(elapsedMs)} ms</span>}
    </span>
  )
}
