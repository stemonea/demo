import { useState } from 'react'
import { FORMATS, download, type FormatId } from '../lib/export'
import './ExportMenu.css'

interface Props {
  /** tagged text to serialise */
  tagged: string
  /** basename of the downloaded file, without extension */
  filename: string
  /** compact renders icons-only sized buttons for panel footers */
  compact?: boolean
}

/** Download the annotation as inline XML, two-layer BIO/CoNLL, or JSON spans. */
export default function ExportMenu({ tagged, filename, compact }: Props) {
  const [done, setDone] = useState<FormatId | null>(null)

  function save(format: (typeof FORMATS)[number]) {
    download(`${filename}.${format.extension}`, format.run(tagged), format.mime)
    setDone(format.id)
    setTimeout(() => setDone(null), 1400)
  }

  return (
    <div className={`export${compact ? ' export--compact' : ''}`}>
      <span className="export__label">Export</span>
      {FORMATS.map((format) => (
        <button
          key={format.id}
          type="button"
          className="export__btn"
          onClick={() => save(format)}
          disabled={!tagged.trim()}
          title={`Download ${format.label}`}
        >
          {done === format.id ? 'saved' : format.label}
        </button>
      ))}
    </div>
  )
}
