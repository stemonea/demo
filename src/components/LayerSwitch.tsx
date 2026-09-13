import { LAYER_VIEWS, type LayerView } from '../lib/view'
import './LayerSwitch.css'

interface Props {
  value: LayerView
  onChange: (view: LayerView) => void
  label?: string
}

/** Segmented control choosing which annotation layer is displayed. */
export default function LayerSwitch({ value, onChange, label = 'Show' }: Props) {
  return (
    <div className="layers" role="group" aria-label={label}>
      <span className="layers__label">{label}</span>
      <div className="layers__track">
        {LAYER_VIEWS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`layers__option${option.id === value ? ' is-active' : ''}`}
            aria-pressed={option.id === value}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
