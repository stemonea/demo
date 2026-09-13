import { useRef, useState } from 'react'
import './FileDrop.css'

interface Props {
  /** name of the file currently loaded, if any */
  fileName: string | null
  /** line under the title: what is loaded, or what is accepted */
  hint: string
  onFile: (file: File | undefined | null) => void
  title?: string
  /** what the picker offers, as an `accept` list; defaults to plain text */
  accept?: string
}

/**
 * Loading a plain-text transcript, by picker or by drag and drop. Shared by the
 * annotator and the analytics view so both refuse the same things in the same
 * words - see `readTextFile` for the check itself.
 */
export default function FileDrop({
  fileName,
  hint,
  onFile,
  title = 'Drop a .txt transcript here',
  accept = '.txt,text/plain',
}: Props) {
  const [hot, setHot] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div
      className={`drop${hot ? ' is-hot' : ''}${fileName ? ' is-loaded' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setHot(true)
      }}
      /* `dragleave` bubbles from the children too, so moving the pointer from
         the box onto the button inside it used to read as leaving and the
         highlight flickered all the way across. It has only really been left
         when what the pointer moved onto is outside the box. */
      onDragLeave={(event) => {
        const to = event.relatedTarget
        if (to instanceof Node && event.currentTarget.contains(to)) return
        setHot(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setHot(false)
        onFile(event.dataTransfer.files?.[0])
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="drop__input"
        onChange={(event) => {
          onFile(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <span className="drop__mark" aria-hidden="true">
        {fileName ? '✓' : '↓'}
      </span>
      <div className="drop__body">
        <p className="drop__title">{fileName ?? title}</p>
        <p className="drop__hint">{hint}</p>
      </div>
      <button type="button" className="btn btn--accent" onClick={() => inputRef.current?.click()}>
        {fileName ? 'Replace file' : 'Choose file'}
      </button>
      {/* the button is the way in for a pointer that would rather click; the
          box has accepted a dropped file all along and now says so */}
      {!fileName && <span className="drop__or">or drop it anywhere in this box</span>}
    </div>
  )
}
