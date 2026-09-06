import { getTagSpec, tagColour } from '../lib/tags'
import './TagFilter.css'

export interface TagCount {
  name: string
  count: number
}

interface Props {
  /** every annotated component the result actually contains, with its frequency */
  counts: TagCount[]
  /** the components currently shown */
  active: ReadonlySet<string>
  onToggle: (name: string) => void
  onSetAll: (on: boolean) => void
}

/**
 * Post-hoc filter over a computed annotation: one chip per annotated component
 * found in the result, switched on or off to read the layers apart. It works on
 * what came back, so it never needs another round-trip to the service.
 */
export default function TagFilter({ counts, active, onToggle, onSetAll }: Props) {
  if (counts.length === 0) {
    return <p className="counts__empty">The service returned no annotated component for this turn.</p>
  }

  const allOn = counts.every((entry) => active.has(entry.name))

  return (
    <div className="filter" role="group" aria-label="Filter annotated components">
      <div className="filter__head">
        <span className="eyebrow">Components</span>
        <button type="button" className="filter__all" onClick={() => onSetAll(!allOn)}>
          {allOn ? 'Hide all' : 'Show all'}
        </button>
      </div>

      <ul className="filter__list">
        {counts.map(({ name, count }) => {
          const on = active.has(name)
          return (
            <li key={name}>
              <button
                type="button"
                className={`filter__chip${on ? ' is-on' : ''}`}
                style={{ ['--tag-color' as string]: tagColour(name) }}
                aria-pressed={on}
                onClick={() => onToggle(name)}
              >
                <span className="filter__count">{count}</span>
                {getTagSpec(name)?.label ?? name}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
