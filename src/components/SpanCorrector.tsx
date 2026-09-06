import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Strip from './Strip'
import {
  canAdd,
  editSpan,
  layerOf,
  newSpanId,
  nudgeSpan,
  tokenize,
  type Edge,
  type Layer,
  type ManualSpan,
  type ManualToken,
} from '../lib/manual'
import './TaggedText.css'
import './SpanCorrector.css'

/**
 * How wide the popover is allowed to get — the `max-width` its stylesheet
 * gives it, repeated here because the position has to be worked out before
 * there is anything to measure.
 */
const MENU_WIDTH = 320
/** how close to the pane's edge the popover may come */
const MENU_MARGIN = 8

export interface PaletteItem {
  label: string
  layer: Layer
}

interface Props {
  /** the untouched text every span is an offset into */
  text: string
  spans: ManualSpan[]
  onChange: (spans: ManualSpan[]) => void
  /** the classes that can be assigned, in shortcut order */
  palette: PaletteItem[]
  colourOf: (label: string) => string
  /**
   * Which span is lit, and which one has its editor open. Both are held by the
   * host rather than here, because a list of spans beside the text points at
   * the same span as the text does: hovering a row lights the words, and
   * opening a row opens the same editor the popover would.
   */
  activeSpan: string | null
  onActiveSpan: (id: string | null) => void
  editing: string | null
  onEditing: (id: string | null) => void
  /** why an edit was refused, said in the host's own message line */
  onMessage?: (message: string | null) => void
  /** what stands in for the text before there is any */
  empty?: ReactNode
  /** what the host puts at the right end of the label bar, after Undo and Clear */
  barExtra?: ReactNode
  /** said under the text, inside the pane — the host's own message line */
  note?: ReactNode
  /**
   * The instruments beside the sheet: the export column, the span list.
   *
   * Handed the correction's own tools rather than left to rebuild them, so a
   * row in that list opens the very editor the popover opens and moves the
   * span the same way. A second implementation of a nudge is a second set of
   * rules about what a legal annotation is.
   */
  side?: (tools: SpanTools) => ReactNode
  className?: string
}

/**
 * Correcting an annotation, wherever it came from.
 *
 * Selecting words and giving them a class, moving an edge a word at a time,
 * changing a class, taking a span off — the same surface serves a transcript
 * annotated from nothing and a turn the tagger has just answered, because in
 * both cases the work is the same: the classes are usually right and the
 * boundaries usually are not.
 *
 * Nothing here knows where the annotation came from. It is handed text, spans
 * as character offsets, and the classes that may be assigned; it hands back
 * spans. That is what lets the hand annotator and the playground share one
 * implementation instead of drifting apart — and it is why the correction pass
 * looks and behaves identically on the two pages rather than merely similarly.
 *
 * It renders as a fragment, not as a box of its own: the label bar and the
 * sheet are siblings in the layout that holds them, and a wrapper around the
 * pair would put a division in the middle of a height chain that both pages
 * measure from the outside.
 */
export default function SpanCorrector({
  text,
  spans,
  onChange,
  palette,
  colourOf,
  activeSpan,
  onActiveSpan,
  editing,
  onEditing,
  onMessage,
  empty,
  barExtra,
  note,
  side,
  className,
}: Props) {
  /** the words waiting for a class, and where to hang the popover */
  const [selection, setSelection] = useState<Picked | null>(null)
  const [menu, setMenu] = useState<{ ids: string[]; x: number; y: number; above: boolean } | null>(null)
  /** the text those two were read off, so a new turn drops both */
  const [annotating, setAnnotating] = useState(text)
  const textRef = useRef<HTMLDivElement>(null)

  const tokens = useMemo(() => tokenize(text), [text])
  const say = useCallback((message: string | null) => onMessage?.(message), [onMessage])

  /* The text is the one thing a selection cannot survive: a new turn, a new
     file. Adjusted during the render that brings the new text in, rather than
     in an effect afterwards, so no frame is ever drawn with a selection that
     points into text that is gone. */
  if (annotating !== text) {
    setAnnotating(text)
    setSelection(null)
    setMenu(null)
  }

  /* ---- selection --------------------------------------------------- */

  const readSelection = useCallback(() => {
    const dom = window.getSelection()
    const panel = textRef.current
    if (!dom || dom.isCollapsed || !panel || !dom.rangeCount) return

    const range = dom.getRangeAt(0)
    if (!panel.contains(range.commonAncestorContainer)) return

    /* Read the covered tokens off a clone of the selection: this catches
       selections that start or end in the whitespace between two tokens, which
       walking up from the anchor node alone would miss. */
    const covered = [...range.cloneContents().querySelectorAll('[data-token]')].map((element) =>
      Number(element.getAttribute('data-token')),
    )
    if (!covered.length) {
      const single = tokenIndexOf(range.startContainer)
      if (single === null) return
      covered.push(single)
    }

    const first = Math.min(...covered)
    const last = Math.max(...covered)
    const rect = range.getBoundingClientRect()
    const frame = panel.getBoundingClientRect()

    setSelection({
      start: tokens[first].start,
      end: tokens[last].end,
      x: rect.left - frame.left + rect.width / 2,
      y: rect.top - frame.top + panel.scrollTop,
    })
    onActiveSpan(null)
    say(null)
  }, [tokens, onActiveSpan, say])

  const clearSelection = useCallback(() => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  const assign = useCallback(
    (label: string, layer: Layer) => {
      if (!selection) {
        say('Select some words first.')
        return
      }
      const candidate = { start: selection.start, end: selection.end, label, layer }
      const problem = canAdd(spans, candidate)
      if (problem) {
        say(problem)
        return
      }
      onChange([...spans, { ...candidate, id: newSpanId() }])
      clearSelection()
      say(null)
    },
    [selection, spans, onChange, clearSelection, say],
  )

  /* ---- refining a span by hand -------------------------------------- */

  /**
   * Moves one edge of one span by a single word. This is the whole point of
   * correcting an annotation someone — or something — else made: the classes
   * are usually right and the boundaries usually are not.
   */
  const nudge = useCallback(
    (span: ManualSpan, edge: Edge, direction: -1 | 1) => {
      const moved = nudgeSpan(tokens, span, edge, direction)
      if (!moved) return
      const { spans: next, error } = editSpan(spans, moved)
      say(error)
      onChange(next)
      onActiveSpan(span.id)
    },
    [tokens, spans, onChange, onActiveSpan, say],
  )

  /** Same span, different class — the other half of a correction pass. */
  const relabel = useCallback(
    (span: ManualSpan, label: string) => {
      if (label === span.label) return
      const { spans: next, error } = editSpan(spans, { ...span, label, layer: layerOf(label) })
      say(error)
      onChange(next)
    },
    [spans, onChange, say],
  )

  const removeSpan = useCallback(
    (id: string) => {
      onChange(spans.filter((span) => span.id !== id))
      setMenu(null)
      onActiveSpan(null)
      if (editing === id) onEditing(null)
    },
    [spans, onChange, onActiveSpan, editing, onEditing],
  )

  /* number keys assign, Escape drops the selection, Backspace undoes, and the
     arrow keys move the edge of whichever span is open in an editor */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (target instanceof HTMLSelectElement) return

      if (event.key === 'Escape') {
        clearSelection()
        onActiveSpan(null)
        onEditing(null)
        setMenu(null)
        return
      }

      const open = editing ? spans.find((span) => span.id === editing) : null
      if (open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        /* the end edge by default, the start edge with Shift — one hand, four
           moves, which is what a correction pass is made of */
        event.preventDefault()
        event.stopPropagation()
        nudge(open, event.shiftKey ? 'start' : 'end', event.key === 'ArrowLeft' ? -1 : 1)
        return
      }

      if ((event.key === 'Backspace' || event.key === 'z') && (event.metaKey || event.ctrlKey || event.key === 'Backspace')) {
        if (!spans.length) return
        event.preventDefault()
        onChange(spans.slice(0, -1))
        return
      }
      const digit = Number(event.key)
      if (selection && digit >= 1 && digit <= palette.length) {
        event.preventDefault()
        const choice = palette[digit - 1]
        assign(choice.label, choice.layer)
      }
    }

    /* capture, so the deck's own arrow-key navigation never steals a nudge */
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [assign, clearSelection, editing, nudge, onChange, onActiveSpan, onEditing, palette, selection, spans])

  /* ---- rendering ---------------------------------------------------- */

  /**
   * Spans carrying the token range they cover, ordered so that a container
   * comes before what it contains. That is all the renderer needs to nest the
   * boxes the way `TaggedText` does on the other pages.
   */
  const placed: Placed[] = useMemo(() => {
    const withBounds = spans.flatMap((span) => {
      const covered = tokens
        .map((token, index) => ({ token, index }))
        .filter(({ token }) => token.start >= span.start && token.end <= span.end)
      if (!covered.length) return []
      return [{ ...span, first: covered[0].index, last: covered[covered.length - 1].index }]
    })

    return [...withBounds].sort((a, b) => a.first - b.first || b.last - b.first - (a.last - a.first))
  }, [spans, tokens])

  /**
   * Clicking a tagged span opens it for editing. An entity inside an argument
   * component is a click on both, so the menu lists the whole chain, innermost
   * first, and the visitor says which one is being corrected.
   */
  function openSpanMenu(span: Placed, event: React.MouseEvent) {
    const dom = window.getSelection()
    if (dom && !dom.isCollapsed) return // the click ended a selection, not a pick

    /* the pane is reached through the event, not the ref: this runs from a
       click, but the callback itself is handed out during render */
    const pane = (event.currentTarget as HTMLElement).closest('.workspace__pane')
    if (!pane) return
    const frame = pane.getBoundingClientRect()

    const chain = [
      span,
      ...placed.filter(
        (other) => other.id !== span.id && other.first <= span.first && other.last >= span.last,
      ),
    ].sort((a, b) => a.last - a.first - (b.last - b.first))

    /*
     * Kept inside the pane it is drawn in.
     *
     * The popover used to be centred on the click and left where that put it,
     * which is fine on a sheet that has the width of a slide and wrong
     * anywhere narrower: on half a card, a span near either edge opened a
     * panel that hung outside the box — and the box clips, so what hung out
     * was simply not there. It is clamped instead, and flipped above the
     * click when it is nearer the foot of the pane than the head.
     */
    const x = event.clientX - frame.left
    const y = event.clientY - frame.top

    setMenu({
      ids: chain.map((item) => item.id),
      x: Math.max(
        MENU_MARGIN,
        Math.min(x - MENU_WIDTH / 2, frame.width - MENU_WIDTH - MENU_MARGIN),
      ),
      y,
      above: y > frame.height * 0.55,
    })
    onActiveSpan(span.id)
    onEditing(span.id)
  }

  /** the rows the open menu is showing, read fresh so an edit is reflected */
  const menuRows = menu ? menu.ids.map((id) => spans.find((span) => span.id === id)).filter(isSpan) : []

  const instruments = side?.({ tokens, nudge, relabel })

  return (
    <>
      <div className={`labelbar${selection ? ' is-armed' : ''}`}>
        <span className="labelbar__state">
          {selection ? (
            <>
              <span className="labelbar__quote">“{text.slice(selection.start, selection.end)}”</span>
              <button type="button" className="labelbar__clear" onClick={clearSelection} title="Clear selection">
                ×
              </button>
            </>
          ) : (
            <span className="labelbar__hint">Select words to tag, or click a span to correct it</span>
          )}
        </span>
        <Strip className="labelbar__group" aria-label="Classes">
          {palette.map((item, i) => (
            <button
              key={item.label}
              type="button"
              className="labelbar__btn"
              style={{ ['--chip' as string]: colourOf(item.label) }}
              onClick={() => assign(item.label, item.layer)}
              disabled={!selection}
              title={selection ? `Assign ${item.label}` : 'Select some words first'}
            >
              <span className="labelbar__key">{i + 1}</span>
              {item.label}
            </button>
          ))}
        </Strip>
        <span className="labelbar__right">
          <button
            type="button"
            className="toggle"
            onClick={() => onChange(spans.slice(0, -1))}
            disabled={!spans.length}
          >
            Undo
          </button>
          <button
            type="button"
            className="toggle"
            onClick={() => {
              onChange([])
              onEditing(null)
              setMenu(null)
            }}
            disabled={!spans.length}
          >
            Clear
          </button>
          {barExtra}
        </span>
      </div>

      <div className={`workspace${instruments ? '' : ' workspace--alone'}${className ? ` ${className}` : ''}`}>
        <div className="workspace__pane">
          {/* data-no-drag: dragging here selects text instead of panning the deck */}
          <div
            className="workspace__text tagged"
            ref={textRef}
            onMouseUp={readSelection}
            onClick={() => setMenu(null)}
            data-scroll
            data-no-drag
          >
            {!text && empty}

            {renderSpans(tokens, text, placed, 0, tokens.length - 1, {
              colourOf,
              activeSpan,
              onActive: onActiveSpan,
              onPick: openSpanMenu,
            })}
          </div>

          {menu && menuRows.length > 0 && (
            <div
              className={`spanmenu${menu.above ? ' spanmenu--above' : ''}`}
              style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
              role="menu"
              data-no-drag
              onClick={(event) => event.stopPropagation()}
            >
              {menuRows.map((span) => (
                <div
                  className={`spanmenu__row${editing === span.id ? ' is-editing' : ''}`}
                  key={span.id}
                  style={{ ['--chip' as string]: colourOf(span.label) }}
                  onMouseEnter={() => onActiveSpan(span.id)}
                >
                  <div className="spanmenu__top">
                    <button
                      type="button"
                      className="spanmenu__pick"
                      onClick={() => onEditing(span.id)}
                      title="Correct this span"
                    >
                      <span className="spanmenu__label">{span.label}</span>
                      <span className="spanmenu__text">{text.slice(span.start, span.end)}</span>
                    </button>
                    <button
                      type="button"
                      className="spanmenu__remove"
                      onClick={() => removeSpan(span.id)}
                      title={`Remove ${span.label}`}
                      aria-label={`Remove ${span.label}`}
                    >
                      <TrashIcon />
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
                </div>
              ))}
            </div>
          )}

          {note}
        </div>

        {instruments}
      </div>
    </>
  )
}

/**
 * Everything a host needs to draw a row of its own that behaves like one of
 * the popover's: the same editor, the same removal, the same lit span.
 *
 * The span list beside the sheet on the hand annotator is exactly that — a
 * second way into the same correction — so it is given the instruments rather
 * than a second implementation of them.
 */
export interface SpanTools {
  tokens: ManualToken[]
  nudge: (span: ManualSpan, edge: Edge, direction: -1 | 1) => void
  relabel: (span: ManualSpan, label: string) => void
}

/** the words waiting for a class, and where to hang the popover over them */
interface Picked {
  start: number
  end: number
  /** where to anchor the label popover, in pixels inside the text pane */
  x: number
  y: number
}

/** Maps a DOM node back to the token it belongs to. */
function tokenIndexOf(node: Node | null): number | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement
  const index = element?.closest('[data-token]')?.getAttribute('data-token')
  return index === null || index === undefined ? null : Number(index)
}

function isSpan(span: ManualSpan | undefined): span is ManualSpan {
  return Boolean(span)
}

/* ---- correcting one span --------------------------------------------- */

interface EditorProps {
  span: ManualSpan
  tokens: ManualToken[]
  palette: PaletteItem[]
  colourOf: (label: string) => string
  onNudge: (span: ManualSpan, edge: Edge, direction: -1 | 1) => void
  onRelabel: (span: ManualSpan, label: string) => void
}

/**
 * The refinement pass, in one small control: which class this is, and where its
 * two edges sit. Each arrow moves an edge by exactly one word, and is disabled
 * when there is no word left to move it onto — the button is what says the span
 * has reached the end of the text, or the last word it can give up.
 *
 * It is rendered in two places, the popover on the text and the row in the span
 * list, because both are places a visitor reasonably reaches for a correction;
 * it is the same control in both.
 */
export function SpanEditor({ span, tokens, palette, colourOf, onNudge, onRelabel }: EditorProps) {
  const can = (edge: Edge, direction: -1 | 1) => Boolean(nudgeSpan(tokens, span, edge, direction))

  return (
    <div className="editor" data-no-drag onClick={(event) => event.stopPropagation()}>
      <label className="editor__group">
        <span className="editor__caption">Class</span>
        <select
          className="editor__select"
          value={span.label}
          style={{ ['--chip' as string]: colourOf(span.label) }}
          onChange={(event) => onRelabel(span, event.target.value)}
          aria-label="Class of this span"
        >
          {palette.map((item) => (
            <option key={item.label} value={item.label}>
              {item.label}
            </option>
          ))}
          {!palette.some((item) => item.label === span.label) && (
            <option value={span.label}>{span.label}</option>
          )}
        </select>
      </label>

      <div className="editor__group">
        <span className="editor__caption">Start</span>
        <div className="editor__pair">
          <button
            type="button"
            className="editor__step"
            onClick={() => onNudge(span, 'start', -1)}
            disabled={!can('start', -1)}
            title="Take in the word before"
            aria-label="Move the start one word left"
          >
            ←
          </button>
          <button
            type="button"
            className="editor__step"
            onClick={() => onNudge(span, 'start', 1)}
            disabled={!can('start', 1)}
            title="Give up the first word"
            aria-label="Move the start one word right"
          >
            →
          </button>
        </div>
      </div>

      <div className="editor__group">
        <span className="editor__caption">End</span>
        <div className="editor__pair">
          <button
            type="button"
            className="editor__step"
            onClick={() => onNudge(span, 'end', -1)}
            disabled={!can('end', -1)}
            title="Give up the last word"
            aria-label="Move the end one word left"
          >
            ←
          </button>
          <button
            type="button"
            className="editor__step"
            onClick={() => onNudge(span, 'end', 1)}
            disabled={!can('end', 1)}
            title="Take in the next word"
            aria-label="Move the end one word right"
          >
            →
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---- rendering the annotation --------------------------------------- */

interface Placed extends ManualSpan {
  /** first and last token index the span covers */
  first: number
  last: number
}

interface RenderOptions {
  colourOf: (label: string) => string
  activeSpan: string | null
  onActive: (id: string | null) => void
  onPick: (span: Placed, event: React.MouseEvent) => void
}

/**
 * Renders the text with one nested element per span, exactly as `TaggedText`
 * does for model output — same classes, and the type written in the same place:
 * an argument component opens with its label, an entity carries its own after
 * it — so a turn corrected by hand looks like a turn that came back from the
 * tagger. Tokens are the leaves and carry `data-token`, which is what the
 * selection is resolved against.
 */
function renderSpans(
  tokens: ManualToken[],
  text: string,
  placed: Placed[],
  from: number,
  to: number,
  options: RenderOptions,
  skipLeadingGap = false,
): ReactNode[] {
  const out: ReactNode[] = []
  const gapBefore = (index: number) =>
    index === 0 ? '' : text.slice(tokens[index - 1].end, tokens[index].start)

  let i = from
  while (i <= to) {
    const gap = i === from && skipLeadingGap ? '' : gapBefore(i)
    const span = placed.find((candidate) => candidate.first === i && candidate.last <= to)

    if (!span) {
      out.push(
        <span key={`t${i}`} data-token={i}>
          {gap}
          {tokens[i].text}
        </span>,
      )
      i += 1
      continue
    }

    const inner = placed.filter(
      (candidate) => candidate !== span && candidate.first >= span.first && candidate.last <= span.last,
    )

    out.push(gap)
    out.push(
      <span
        key={span.id}
        className={`tagged__span tagged__span--${span.layer}${options.activeSpan === span.id ? ' is-active' : ''}`}
        style={{ ['--tag-color' as string]: options.colourOf(span.label) }}
        onMouseEnter={() => options.onActive(span.id)}
        onMouseLeave={() => options.onActive(null)}
        onClick={(event) => {
          /* the innermost span wins: an entity inside a claim is a click on the
             entity, and its containers are offered by the menu itself */
          event.stopPropagation()
          options.onPick(span, event)
        }}
      >
        {span.layer === 'argument' && <span className="tagged__label">{span.label}</span>}
        {renderSpans(tokens, text, inner, span.first, span.last, options, true)}
        {span.layer !== 'argument' && <span className="tagged__code">{span.label}</span>}
      </span>,
    )
    i = span.last + 1
  }

  return out
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.1c.05.5.5.9 1 .9h4.6c.5 0 .95-.4 1-.9L12 4M6.6 6.6v5M9.4 6.6v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
