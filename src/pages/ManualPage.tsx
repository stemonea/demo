import { useCallback, useMemo, useState } from 'react'
import HoverTag from '../components/HoverTag'
import SlideDeck, { type SlideItem } from '../components/SlideDeck'
import Strip from '../components/Strip'
import FileDrop from '../components/FileDrop'
import SpanCorrector, { SpanEditor } from '../components/SpanCorrector'
import { readTextFile } from '../lib/textFile'
import { download } from '../lib/export'
import { ANNOTATED_EXTENSIONS, parseAnnotated, type AnnotatedFormat } from '../lib/annotated'
import { ARGUMENT_LABELS, toConll, toJson, toTagged, type Layer, type ManualSpan } from '../lib/manual'
import './ManualPage.css'

const DEFAULT_ENTITIES = ['PERSON', 'ORG', 'DATE']

/** Colours handed out in order to user-declared entity types. */
const ENTITY_COLOURS = [
  'var(--tag-person)',
  'var(--tag-location)',
  'var(--tag-date)',
  'var(--tag-role)',
  'var(--tag-org)',
  'var(--tag-party)',
  'var(--tag-event)',
  'var(--tag-law)',
]

/** How a loaded annotation describes itself in the interface. */
const FORMAT_NAMES: Record<AnnotatedFormat, string> = {
  inline: 'inline markup',
  json: 'JSON spans',
  conll: 'two-layer CoNLL',
}

/** What the file that is loaded turned out to be, once it had been read. */
interface Loaded {
  name: string
  format: AnnotatedFormat
  /** how many spans came out of it, before anything was edited */
  imported: number
  warnings: string[]
}

export default function ManualPage() {
  const [entityLabels, setEntityLabels] = useState<string[]>(DEFAULT_ENTITIES)
  const [draft, setDraft] = useState('')
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [spans, setSpans] = useState<ManualSpan[]>([])
  /* which span is lit, and which one has its editor open. Held here rather
     than inside the corrector because the list beside the sheet points at the
     same span the text does: hovering a row lights the words, and opening a
     row opens the editor the popover would have opened. */
  const [activeSpan, setActiveSpan] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const tagged = useMemo(() => toTagged(text, spans), [text, spans])

  /** every label the visitor can currently assign, in shortcut order */
  const palette = useMemo(
    () => [
      ...ARGUMENT_LABELS.map((label) => ({ label, layer: 'argument' as Layer })),
      ...entityLabels.map((label) => ({ label, layer: 'entity' as Layer })),
    ],
    [entityLabels],
  )

  const colourOf = useCallback(
    (label: string): string =>
      ARGUMENT_LABELS.includes(label)
        ? label === 'CLAIM'
          ? 'var(--tag-claim)'
          : 'var(--tag-premise)'
        : ENTITY_COLOURS[Math.max(0, entityLabels.indexOf(label)) % ENTITY_COLOURS.length],
    [entityLabels],
  )

  /* ---- the file: a transcript, or an annotation to be corrected ----- */

  /**
   * One door for both jobs. A plain `.txt` yields no spans and the visitor
   * annotates it from nothing; a file that already carries an annotation — the
   * tagger's inline markup, this tool's own JSON, a two-layer CoNLL — arrives
   * with its spans already on the text, ready to be pushed around by hand.
   */
  async function loadFile(file: File | undefined | null) {
    if (!file) return
    const read = await readTextFile(file, ANNOTATED_EXTENSIONS)
    if (read.error) {
      setMessage(read.error)
      return
    }

    const { value, error } = parseAnnotated(read.text, file.name)
    if (!value) {
      setMessage(error)
      return
    }

    /* an imported entity type joins the palette, or the annotation could be
       read but not relabelled — and the export column would lose it */
    setEntityLabels((current) => [...current, ...value.entityLabels.filter((label) => !current.includes(label) && !ARGUMENT_LABELS.includes(label))])
    setText(value.text)
    setSpans(value.spans)
    setLoaded({ name: file.name, format: value.format, imported: value.spans.length, warnings: value.warnings })
    setEditing(null)
    setMessage(null)
  }

  /* ---- the pass by hand -------------------------------------------- */

  /**
   * Taking a span off, from the list beside the sheet.
   *
   * The popover on the text has its own, inside the corrector; this is the
   * same act reached from the other side, and it clears the two marks the page
   * holds so a removed span does not stay lit or stay open.
   */
  const removeSpan = useCallback((id: string) => {
    setSpans((current) => current.filter((span) => span.id !== id))
    setActiveSpan(null)
    setEditing((current) => (current === id ? null : current))
  }, [])

  /* ---- tag set ----------------------------------------------------- */

  function addLabel(raw: string) {
    const label = raw.trim().toUpperCase().replace(/\s+/g, '_')
    if (!label) return
    if (ARGUMENT_LABELS.includes(label) || entityLabels.includes(label)) {
      setMessage(`${label} is already in the set.`)
      return
    }
    setEntityLabels((current) => [...current, label])
    setDraft('')
    setMessage(null)
  }

  function removeLabel(label: string) {
    setEntityLabels((current) => current.filter((item) => item !== label))
    setSpans((current) => current.filter((span) => span.label !== label))
  }

  /* ---- rendering ---------------------------------------------------- */


  const slides: SlideItem[] = [
    {
      id: 'manual-set',
      label: 'Setup',
      node: (
        <div className="manual shell">
          <header className="manual__head">
            <div>
              <span className="eyebrow">Manual</span>
              <h1 className="display manual__title"><HoverTag>Build the data by hand</HoverTag></h1>
            </div>
            <p className="manual__lead">
              Load a transcript and annotate it from nothing, or load an annotation someone — or something — else
              made and correct it word by word. Export two-layer CoNLL either way: the format the tagger is trained
              and evaluated on.
            </p>
          </header>

          {/* The two things a pass needs before it can start: the text, and the
              set of types it will be marked with. They are a pair, so they are
              set as one — side by side and stretched to a single height, rather
              than one short box above a tall one. */}
          <div className="setup">
            <section className="setbox">
              <h2 className="eyebrow">1 · Text — plain, or already annotated</h2>
              <FileDrop
                fileName={loaded?.name ?? null}
                title="Drop a transcript or an annotation here"
                accept=".txt,.xml,.json,.tsv,.conll,text/plain,application/json"
                hint={
                  loaded
                    ? `${text.length.toLocaleString()} characters · ${loaded.imported} span${loaded.imported === 1 ? '' : 's'} read as ${FORMAT_NAMES[loaded.format]}`
                    : '.txt, .xml, .json, .tsv or .conll, up to 400 KB'
                }
                onFile={loadFile}
              />
              <p className="setbox__note setbox__note--formats">
                Recognised as annotated: inline markup (<code>&lt;claim&gt;…&lt;/claim&gt;</code>), this tool's JSON
                spans, and two-layer CoNLL. Anything else loads as plain text.
              </p>
              {loaded && loaded.imported > 0 && (
                <p className="setbox__ok">
                  {loaded.imported} span{loaded.imported === 1 ? '' : 's'} are on the text and can be moved, relabelled
                  or removed on the next slide.
                </p>
              )}
              {loaded && loaded.warnings.length > 0 && (
                <ul className="setbox__warnings">
                  {loaded.warnings.slice(0, 6).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                  {loaded.warnings.length > 6 && <li>…and {loaded.warnings.length - 6} more.</li>}
                </ul>
              )}
            </section>

            <section className="setbox">
              <h2 className="eyebrow">2 · Entity set — yours</h2>
              <Strip className="chips" aria-label="Entity set">
                {entityLabels.map((label) => (
                  <span className="chip" key={label} style={{ ['--chip' as string]: colourOf(label) }}>
                    {label}
                    <button
                      type="button"
                      className="chip__remove"
                      onClick={() => removeLabel(label)}
                      title={`Remove ${label}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {!entityLabels.length && <span className="setbox__empty">No entity type declared yet.</span>}
              </Strip>

              <form
                className="setbox__add"
                onSubmit={(event) => {
                  event.preventDefault()
                  addLabel(draft)
                }}
              >
                <input
                  className="setbox__input"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Add an entity type, e.g. POLICY"
                  aria-label="New entity type"
                  maxLength={24}
                />
                <button type="submit" className="btn btn--accent" disabled={!draft.trim()}>
                  Add type
                </button>
              </form>

              <p className="setbox__note">
                The argument layer is fixed —
                {ARGUMENT_LABELS.map((label) => (
                  <span className="chip chip--inline" key={label} style={{ ['--chip' as string]: colourOf(label) }}>
                    {label}
                  </span>
                ))}
                — because the CoNLL export writes one column for each layer.
              </p>
            </section>
          </div>

          {message && <p className="manual__message">{message}</p>}
        </div>
      ),
    },
    {
      id: 'manual-annotate',
      label: 'Annotate',
      node: (
        <div className="manual shell">
          <header className="manual__head">
            <h2 className="display manual__section"><HoverTag>Annotate</HoverTag></h2>
            <p className="manual__lead">
              Select words and pick a class to add a span — number keys work too, <kbd>Esc</kbd> clears and{' '}
              <kbd>⌫</kbd> undoes. Click a span that is already there to correct it: move either edge a word at a
              time with the arrows, or with <kbd>←</kbd> <kbd>→</kbd> for the end and <kbd>⇧</kbd> for the start.
            </p>
          </header>

          <SpanCorrector
            text={text}
            spans={spans}
            onChange={setSpans}
            palette={palette}
            colourOf={colourOf}
            activeSpan={activeSpan}
            onActiveSpan={setActiveSpan}
            editing={editing}
            onEditing={setEditing}
            onMessage={setMessage}
            empty={<p className="workspace__empty">Load a file on the previous slide to start.</p>}
            note={message ? <p className="manual__message">{message}</p> : null}
            side={({ tokens, nudge, relabel }) => (
              <aside className="workspace__side" data-scroll>
                <section className="workspace__panel">
                  <h3 className="eyebrow">Export</h3>
                  <div className="workspace__exports">
                    <button
                      type="button"
                      className="export__btn"
                      disabled={!spans.length}
                      onClick={() => download(basename(loaded?.name ?? null, 'tsv'), toConll(text, spans), 'text/tab-separated-values')}
                    >
                      BIO / CoNLL
                    </button>
                    <button
                      type="button"
                      className="export__btn"
                      disabled={!spans.length}
                      onClick={() => download(basename(loaded?.name ?? null, 'json'), toJson(text, spans), 'application/json')}
                    >
                      JSON spans
                    </button>
                    <button
                      type="button"
                      className="export__btn"
                      disabled={!spans.length}
                      onClick={() => download(basename(loaded?.name ?? null, 'xml'), `${tagged}\n`, 'application/xml')}
                    >
                      Inline XML
                    </button>
                  </div>
                </section>

                <section className="workspace__panel">
                  <h3 className="eyebrow">Spans · {spans.length}</h3>
                  <ul className="spanlist" data-scroll>
                    {!spans.length && <li className="spanlist__empty">Nothing tagged yet.</li>}
                    {spans.map((span) => (
                      <li
                        className={`spanlist__item${activeSpan === span.id ? ' is-active' : ''}${editing === span.id ? ' is-editing' : ''}`}
                        key={span.id}
                        style={{ ['--chip' as string]: colourOf(span.label) }}
                        onMouseEnter={() => setActiveSpan(span.id)}
                        onMouseLeave={() => setActiveSpan(null)}
                      >
                        <div className="spanlist__top">
                          <button
                            type="button"
                            className="spanlist__pick"
                            onClick={() => setEditing((current) => (current === span.id ? null : span.id))}
                            aria-expanded={editing === span.id}
                            title="Correct this span"
                          >
                            <span className="spanlist__label">{span.label}</span>
                            <span className="spanlist__text">{text.slice(span.start, span.end)}</span>
                          </button>
                          <button
                            type="button"
                            className="spanlist__remove"
                            onClick={() => removeSpan(span.id)}
                            title="Remove this span"
                          >
                            ×
                          </button>
                        </div>
                        {editing === span.id && (
                          <SpanEditor
                            span={span}
                            tokens={tokens}
                            palette={palette}
                            colourOf={colourOf}
                            onNudge={nudge}
                            onRelabel={relabel}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="workspace__panel">
                  <h3 className="eyebrow">Raw view</h3>
                  <pre className="workspace__code" data-no-drag>
                    {tagged || '—'}
                  </pre>
                </section>
              </aside>
            )}
          />
        </div>
      ),
    },
  ]

  return <SlideDeck slides={slides} />
}

function basename(fileName: string | null, extension: string): string {
  const stem = fileName ? fileName.replace(/\.[^.]+$/, '') : 'manual'
  return `${stem}.${extension}`
}
