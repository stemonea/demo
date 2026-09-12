import { useEffect, useMemo, useRef, useState } from 'react'
import HoverTag from '../components/HoverTag'
import TaggedText from '../components/TaggedText'
import TagFilter, { type TagCount } from '../components/TagFilter'
import SourceBadge from '../components/SourceBadge'
import VerdictBadge from '../components/VerdictBadge'
import ExportMenu from '../components/ExportMenu'
import SpanCorrector, { type PaletteItem } from '../components/SpanCorrector'
import { annotate, ApiError, checkService, type ServiceStatus, type Source } from '../lib/api'
import { failureOf, type Failure } from '../lib/failure'
import { countTags, parseTaggedText, serializeNodes } from '../lib/parseTags'
import { checkNesting } from '../lib/wellformed'
import { filterTags } from '../lib/view'
import {
  forgetCorrection,
  loadCorrection,
  openCorrection,
  saveCorrection,
  type Correction,
} from '../lib/corrections'
import { ARGUMENT_LABELS, diffSpans, toTagged, type ManualSpan, type SpanDiff } from '../lib/manual'
import { tagsOfKind, tagColour } from '../lib/tags'
import { FIXTURES, findFixture } from '../data/fixtures'
import { buildReplay, type ReplayPhase, type ReplayStep } from '../lib/replay'
import './PlaygroundPage.css'

type Status = 'idle' | 'replaying' | 'loading' | 'done' | 'error'

/** What the replay says it is doing, while it does it. */
const PHASE_LABEL: Record<ReplayPhase, string> = {
  reading: 'reading the turn',
  argument: 'marking argument components',
  entity: 'marking entities',
}

/** What is on screen, and where it came from. */
interface Shown {
  tagged: string
  source: Source
  /** only for answers that were actually computed by the service */
  elapsedMs?: number
}

const SERVICE_LABEL: Record<ServiceStatus['state'], string> = {
  checking: 'checking…',
  ready: 'service ready',
  unreachable: 'service unreachable',
  offline: 'offline mode',
}

/**
 * What each state means for what the page can do.
 *
 * It used to be a sentence beside the badge at the top of the page, which is a
 * paragraph of standing explanation for a fact that changes once a session and
 * matters to nobody until it goes wrong. The badge now says the state on the
 * rail and carries the sentence with it, so the answer is a hover away from the
 * thing that raised the question rather than always on screen.
 */
const SERVICE_HINT: Record<ServiceStatus['state'], string> = {
  checking: 'Looking for the annotation service.',
  ready: 'Examples are replayed in the browser; your own text is computed by the service.',
  unreachable: 'The examples still work; your own text needs the service.',
  offline: 'No annotation service is running, so only the pre-computed examples can be shown.',
}

/**
 * The bundled turns of the paper. They are examples, not requests: picking one
 * shows the reported output straight away and nothing is sent anywhere.
 */
const EXAMPLE_TURNS = FIXTURES.map((fixture, i) => ({
  id: fixture.id,
  label: `Turn ${i + 1}`,
  text: fixture.text,
  tagged: fixture.outputs.joint,
}))

/**
 * The playground has two ways in. The bundled turns are pre-computed examples,
 * replayed locally and labelled as such. "Yours" empties the editor: that text -
 * and only that text - is sent to the annotation service to be computed. Once a
 * result is on screen, the component filter reads the layers apart client-side.
 */
export default function PlaygroundPage() {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<Shown | null>(null)
  /** id of the example on screen, or 'yours' while the reader writes their own */
  const [picked, setPicked] = useState<string>('yours')
  const [active, setActive] = useState<Set<string>>(new Set())
  const [failure, setFailure] = useState<Failure | null>(null)
  const [copied, setCopied] = useState(false)
  const [service, setService] = useState<ServiceStatus>({ state: 'checking', url: null })
  /** the frame the replay of an example is currently on, null when not replaying */
  const [frame, setFrame] = useState<ReplayStep | null>(null)
  /**
   * The pass by hand on the turn on screen, and whether the workbench is open.
   *
   * The two are separate on purpose: closing the workbench goes back to reading
   * the annotation, it does not throw the annotation away. The pass outlives
   * the panel, the turn and the visit - `lib/corrections` keeps it.
   */
  const [correction, setCorrection] = useState<Correction | null>(null)
  const [pass, setPass] = useState(false)
  /** whether this browser is actually keeping the pass, so the panel can say so */
  const [kept, setKept] = useState(true)
  const [activeSpan, setActiveSpan] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  /** why the workbench refused an edit, said under the text */
  const [note, setNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const replayRef = useRef<number | null>(null)

  /** Stops a replay in flight - a new pick, your own text, or leaving the page. */
  function stopReplay() {
    if (replayRef.current !== null) {
      window.clearInterval(replayRef.current)
      replayRef.current = null
    }
  }

  useEffect(
    () => () => {
      abortRef.current?.abort()
      stopReplay()
    },
    [],
  )

  /* ask the service whether it is up before anyone types a turn into it */
  useEffect(() => {
    const controller = new AbortController()
    checkService(controller.signal)
      .then(setService)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  /** the pass as markup - what the page shows, copies and exports once it exists */
  const corrected = useMemo(
    () => (correction ? toTagged(correction.text, correction.spans) : ''),
    [correction],
  )

  /** what the pass has changed so far, against the answer the model gave */
  const diff = useMemo(
    () => (correction ? diffSpans(correction.base, correction.spans) : null),
    [correction],
  )

  /**
   * The annotation this page is about.
   *
   * The model's answer until somebody corrects it, and the correction from then
   * on. Reading and correcting are two views of one annotation rather than two
   * annotations, which is what stops the pass from being lost every time the
   * workbench closes - and what makes the component filter, the copy and the
   * export all show the same thing.
   */
  const answer = correction && diff?.edits ? corrected : (result?.tagged ?? '')

  /* every annotated component the answer contains, most frequent first */
  const counts = useMemo<TagCount[]>(
    () =>
      answer
        ? [...countTags(parseTaggedText(answer)).entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name, count }))
        : [],
    [answer],
  )

  /* the answer with the switched-off components dropped, tags only - text intact */
  const shown = useMemo(
    () => (answer ? serializeNodes(filterTags(parseTaggedText(answer), active)) : ''),
    [answer, active],
  )

  /**
   * Leaves the turn: the pass on screen goes, what was written down stays.
   *
   * Called when the answer itself is replaced - another example, your own text,
   * a fresh request - because a correction is spans over one turn's words and
   * means nothing over another's. The store keeps it under that turn, so coming
   * back to the turn brings it back.
   */
  function closePass() {
    setCorrection(null)
    setPass(false)
    setActiveSpan(null)
    setEditing(null)
    setNote(null)
  }

  /**
   * Opens the workbench on the turn on screen.
   *
   * A pass already made - this visit or an earlier one - is opened as it was
   * left. A first pass starts from the model's answer, read through the same
   * reader a loaded file goes through, so a defect the model left is reported
   * here rather than carried silently into an export.
   */
  function openPass() {
    if (!result) return
    if (!correction) setCorrection(openCorrection(result.tagged))
    setActiveSpan(null)
    setEditing(null)
    setNote(null)
    setMode('rendered')
    setPass(true)
  }

  /**
   * Every edit is written down as it is made.
   *
   * Not on closing the panel, and not on leaving the page: neither is something
   * a browser can be relied on to let happen, and the one thing the visitor
   * must never be told is that their pass was kept when it was not. A pass that
   * has been reset back to the model's own answer is not a correction, so it is
   * forgotten rather than stored as a copy of what the model said.
   */
  function changeSpans(spans: ManualSpan[]) {
    if (!correction || !result) return
    const next = { ...correction, spans }
    setCorrection(next)
    /* a class the pass introduced is switched on, or the reading view would
       filter out the very span that was just added */
    setActive((current) => new Set([...current, ...spans.map((span) => span.label.toLowerCase())]))

    if (diffSpans(next.base, spans).edits) setKept(saveCorrection(result.tagged, next))
    else {
      forgetCorrection(result.tagged)
      setKept(true)
    }
  }

  /** Puts the model's answer back, and forgets the pass that was on it. */
  function resetPass() {
    if (!correction || !result) return
    setCorrection({ ...correction, spans: correction.base })
    forgetCorrection(result.tagged)
    setActive(new Set(countTags(parseTaggedText(result.tagged)).keys()))
    setKept(true)
  }

  /**
   * Puts a finished answer on screen and opens every component it contains.
   *
   * If this turn was corrected before, the correction comes back with it and is
   * what the page shows: the annotation as it was left, not the draft it was
   * made from. The workbench itself stays closed until it is asked for.
   */
  function present(answer: Shown) {
    const saved = loadCorrection(answer.tagged)
    setCorrection(saved)
    setPass(false)
    setActiveSpan(null)
    setEditing(null)
    setNote(null)
    setKept(true)
    setResult(answer)
    setActive(
      new Set(countTags(parseTaggedText(saved ? toTagged(saved.text, saved.spans) : answer.tagged)).keys()),
    )
    setFailure(null)
    setFrame(null)
    setStatus('done')
  }

  /**
   * Plays a stored answer back the way the model would have produced it, then
   * settles on the finished annotation. Nothing is computed and nothing is sent:
   * the result keeps its `pre-computed` badge throughout.
   */
  function replay(tagged: string) {
    stopReplay()
    closePass()
    const { steps, intervalMs } = buildReplay(tagged)
    if (!steps.length) {
      present({ tagged, source: 'precomputed' })
      return
    }

    setResult(null)
    setFailure(null)
    setFrame(steps[0])
    setStatus('replaying')

    let next = 1
    replayRef.current = window.setInterval(() => {
      if (next >= steps.length) {
        stopReplay()
        present({ tagged, source: 'precomputed' })
        return
      }
      setFrame(steps[next])
      next += 1
    }, intervalMs)
  }

  /** An example: replayed from the bundled output, never sent to the service. */
  function pickExample(example: (typeof EXAMPLE_TURNS)[number]) {
    abortRef.current?.abort()
    setPicked(example.id)
    setText(example.text)
    replay(example.tagged)
  }

  /** Your own turn: an empty editor, and the service does the work. */
  function pickYours() {
    abortRef.current?.abort()
    stopReplay()
    setPicked('yours')
    closePass()
    setText('')
    setResult(null)
    setFrame(null)
    setFailure(null)
    setStatus('idle')
    inputRef.current?.focus()
  }

  function edit(value: string) {
    setText(value)
    /* editing an example makes it your text: the answer on screen is no longer
       the annotation of what is in the editor, so it goes */
    if (picked !== 'yours') {
      stopReplay()
      closePass()
      setPicked('yours')
      setResult(null)
      setFrame(null)
      setStatus('idle')
    }
  }

  async function submit() {
    const trimmed = text.trim()
    if (!trimmed || status === 'loading' || status === 'replaying') return

    /* a bundled turn is answered from its pre-computed output, whatever route it
       arrived by - pasted, retyped or picked - and never leaves the browser */
    const example = findFixture(trimmed)
    if (example) {
      replay(example.outputs.joint)
      return
    }

    abortRef.current?.abort()
    stopReplay()
    const controller = new AbortController()
    abortRef.current = controller

    setStatus('loading')
    setFailure(null)
    try {
      const response = await annotate(trimmed, 'all', controller.signal)
      present({ tagged: response.tagged, source: response.source, elapsedMs: response.elapsedMs })
      /* a call that went through says more about the service than any probe */
      if (response.source === 'backend') setService({ state: 'ready', url: null })
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') return
      setFailure(failureOf(cause))
      setStatus('error')
      if (cause instanceof ApiError && (cause.kind === 'network' || cause.kind === 'timeout')) {
        setService({ state: 'unreachable', url: null })
      }
    }
  }

  /**
   * The classes a correction may assign: the schema the tagger writes, plus
   * anything its answer turned out to carry that the registry does not know -
   * an unknown tag can still be moved and relabelled, and dropping it from the
   * list would be the one way to lose it.
   */
  const palette = useMemo<PaletteItem[]>(() => {
    const schema: PaletteItem[] = [
      ...ARGUMENT_LABELS.map((label) => ({ label, layer: 'argument' as const })),
      ...tagsOfKind('entity').map((spec) => ({ label: spec.name.toUpperCase(), layer: 'entity' as const })),
    ]
    const extra = new Map<string, PaletteItem>()
    for (const span of correction?.spans ?? []) {
      if (!schema.some((item) => item.label === span.label)) extra.set(span.label, { label: span.label, layer: span.layer })
    }
    return [...schema, ...extra.values()]
  }, [correction])

  function toggle(name: string) {
    setActive((current) => {
      const next = new Set(current)
      if (!next.delete(name)) next.add(name)
      return next
    })
  }

  function setAll(on: boolean) {
    setActive(on ? new Set(counts.map((entry) => entry.name)) : new Set())
  }

  async function copyOutput() {
    const text = pass ? corrected : shown
    if (!text) return
    await navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  /**
   * Where what is on screen came from. Once a span has moved, the annotation is
   * no longer the model's and the badge that says where it came from would be a
   * lie - so it is replaced by what it is, and by what was done to it.
   */
  /* the annotation read as structure: whether its tags nest the way the schema
     says they must. A hand-corrected pass is checked too - the editor refuses a
     partial overlap, but a turn that arrived broken stays broken until the span
     that broke it is dealt with */
  const nesting = checkNesting(answer)

  const source = diff?.edits ? (
    <span
      className="pg__hand"
      title={`Against the model's answer: ${changes(diff)}. Export writes the annotation as it stands.`}
    >
      corrected by hand
      <span className="pg__hand-count">{changes(diff)}</span>
    </span>
  ) : result ? (
    <SourceBadge source={result.source} elapsedMs={result.elapsedMs} />
  ) : null

  /* the verdict first: where an answer is ill-formed, that is the thing to know
     about it before where it came from */
  const badge = (
    <>
      {nesting.verdict && <VerdictBadge verdict={nesting.verdict} note={nesting.note} />}
      {source}
    </>
  )

  return (
    <div className="page">
      <div className="page__inner">
        <div className="pg shell">
          <header className="pg__head">
            <div>
              <span className="eyebrow">Try it!</span>
              <h1 className="display pg__title"><HoverTag>Playground</HoverTag></h1>
            </div>
            <div className="pg__intro">
              <p className="pg__lead">
                Pick an example to watch it tagged, or write your own. Either way the annotation can be corrected by
                hand, and yours is the one the page keeps.
              </p>
            </div>
          </header>

          {/* The working area, and the state of the service stood on its edge.
              The rail costs the page width rather than height, which is what the
              two cells were short of. */}
          <div className="pg__work">
            <aside className="pg__rail">
              <span
                className={`pg__service pg__service--${service.state}`}
                title={SERVICE_HINT[service.state]}
              >
                {SERVICE_LABEL[service.state]}
              </span>
            </aside>

            <div className="pg__grid" data-scroll>
              {/* ---- input ---- */}
              <div className="card">
                <header className="card__head">
                  <span className="eyebrow">Your text</span>
                  <div className="samples">
                    <span className="samples__hint">examples</span>
                    {EXAMPLE_TURNS.map((example) => (
                      <button
                        key={example.id}
                        type="button"
                        className={`samples__btn${picked === example.id ? ' is-on' : ''}`}
                        onClick={() => pickExample(example)}
                      >
                        {example.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`samples__btn samples__btn--yours${picked === 'yours' ? ' is-on' : ''}`}
                      onClick={pickYours}
                    >
                      Yours
                    </button>
                  </div>
                </header>

                <textarea
                  ref={inputRef}
                  className="pg__input"
                  value={text}
                  onChange={(event) => edit(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void submit()
                    }
                  }}
                  spellCheck={false}
                  rows={8}
                  placeholder="SPEAKER: type or paste a turn here…"
                  aria-label="Text to annotate"
                  autoFocus
                />

                <footer className="card__foot">
                  <span className="pg__chars">
                    {text.trim().length} characters
                    {text !== '' && (
                      <button type="button" className="pg__clear" onClick={pickYours}>
                        Clear
                      </button>
                    )}
                  </span>
                  <button
                    type="button"
                    className="btn btn--accent"
                    onClick={submit}
                    disabled={status === 'loading' || status === 'replaying' || !text.trim()}
                  >
                    {status === 'loading' ? 'Annotating…' : status === 'replaying' ? 'Tagging…' : 'Annotate'}
                  </button>
                </footer>
              </div>

              {/* ---- output ---- */}
              <div className={`card card--output${status === 'loading' ? ' is-loading' : ''}`}>
                <header className="card__head">
                  <span className="eyebrow">Annotation</span>
                  <div className="pg__output-tools">
                    <button
                      type="button"
                      className={`toggle${pass ? ' is-on' : ''}`}
                      onClick={() => (pass ? setPass(false) : openPass())}
                      disabled={status !== 'done' || !result}
                      aria-pressed={pass}
                      title={
                        pass
                          ? 'Go back to reading; the pass is kept and stays what the page shows'
                          : correction
                            ? 'Reopen the pass left on this turn'
                            : 'Open this answer as spans and correct it by hand'
                      }
                    >
                      Correct
                    </button>
                    <button
                      type="button"
                      className={`toggle${mode === 'raw' ? ' is-on' : ''}`}
                      onClick={() => setMode((value) => (value === 'raw' ? 'rendered' : 'raw'))}
                      aria-pressed={mode === 'raw'}
                      disabled={pass}
                      title={pass ? 'Rendered while you correct - Export writes the markup' : undefined}
                    >
                      Raw markup
                    </button>
                    <button type="button" className="toggle" onClick={copyOutput} disabled={!result}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </header>

                {pass && correction ? (
                  /* One cell, not two. Above 901px the two cards are subgrids
                     sharing a head / editor / foot track, and the pass is two
                     elements - a bar and a sheet - where the reading was one.
                     Left loose they take a track each, which puts the sheet in
                     the footer's row. So they travel in the editor's cell. */
                  <div className="pg__bench">
                  <SpanCorrector
                    className="pg__corrector"
                    text={correction.text}
                    spans={correction.spans}
                    onChange={changeSpans}
                    palette={palette}
                    colourOf={(label) => tagColour(label)}
                    activeSpan={activeSpan}
                    onActiveSpan={setActiveSpan}
                    editing={editing}
                    onEditing={setEditing}
                    onMessage={setNote}
                    barExtra={
                      <button
                        type="button"
                        className="toggle"
                        onClick={resetPass}
                        disabled={!diff?.edits}
                        title="Put the model's own answer back, and forget the pass on this turn"
                      >
                        Reset
                      </button>
                    }
                  />
                  </div>
                ) : (
                  <div className={`pg__output${status === 'replaying' ? ' pg__output--replaying' : ''}`} data-scroll>
                    {status === 'idle' && (
                      <p className="pg__placeholder">
                        Nothing on screen yet. Pick an example above, or write a turn on the left and press{' '}
                        <strong>Annotate</strong>.
                      </p>
                    )}
                    {status === 'replaying' && frame && <TaggedText text={frame.text} mode={mode} />}
                    {status === 'loading' && <p className="pg__placeholder">Computing this turn…</p>}
                    {status === 'error' && failure && (
                      <div className="failure" role="alert">
                        <p className="failure__title">{failure.title}</p>
                        <p className="failure__message">{failure.message}</p>
                        <p className="failure__hint">{failure.hint}</p>
                        <div className="failure__actions">
                          <button type="button" className="btn btn--accent failure__retry" onClick={submit}>
                            Try again
                          </button>
                        </div>
                      </div>
                    )}
                    {status === 'done' && result && <TaggedText text={shown} mode={mode} />}
                  </div>
                )}

                {!pass && (
                  <footer className={`card__foot${status === 'done' && result ? ' card__foot--stacked' : ''}`}>
                    {status === 'replaying' && frame && (
                      <>
                        <span className="replay">
                          <span className="replay__dot" aria-hidden="true" />
                          {PHASE_LABEL[frame.phase]}…
                        </span>
                        <span className="replay__note">pre-computed example, replayed</span>
                      </>
                    )}

                    {status === 'done' && result && (
                      <>
                        <TagFilter counts={counts} active={active} onToggle={toggle} onSetAll={setAll} />
                        <div className="pg__meta">
                          <ExportMenu tagged={shown} filename={diff?.edits ? 'gold' : 'annotation'} />
                          {badge}
                        </div>
                      </>
                    )}
                  </footer>
                )}

                {pass && correction && diff && (
                  <footer className="card__foot card__foot--stacked">
                    {/* the bar above the text says what to do; this says what becomes of it,
                        with the badge beside it rather than under the exports, where the two
                        together are wider than the cell and cost the card a whole line */}
                    <div className="pg__passline">
                      <p className="pg__pass">
                        <kbd>Esc</kbd> clears, <kbd>⌫</kbd> undoes ·{' '}
                        {kept ? <>kept on this browser</> : <>not kept on this browser - export first</>}
                      </p>
                      {badge}
                    </div>

                    {note && <p className="pg__note">{note}</p>}

                    {correction.warnings.length > 0 && (
                      <ul className="pg__warnings">
                        {correction.warnings.slice(0, 3).map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                        {correction.warnings.length > 3 && <li>…and {correction.warnings.length - 3} more.</li>}
                      </ul>
                    )}

                    <div className="pg__meta">
                      <ExportMenu tagged={corrected} filename={diff.edits ? 'gold' : 'annotation'} />
                    </div>
                  </footer>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * What a correction pass has changed, in the words the footer uses. Nothing is
 * printed for a kind of edit that was not made, so the line says what happened
 * rather than reciting four counters, three of them zero.
 */
function changes(diff: SpanDiff): string {
  const parts = [
    diff.added && `${diff.added} added`,
    diff.removed && `${diff.removed} removed`,
    diff.moved && `${diff.moved} moved`,
    diff.relabelled && `${diff.relabelled} relabelled`,
  ].filter(Boolean)
  return parts.join(' · ')
}

