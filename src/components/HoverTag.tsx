import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { noise, TEXT_GLYPHS } from '../lib/glyphs'
import './HoverTag.css'

interface Props {
  /** the text as it reads when nothing is happening */
  children: string
  /** the tag it is revealed as; `text` for anything the schema has no name for */
  tag?: string
  /** what the text turns into while it is tagged, when that differs */
  expand?: string
  /**
   * Selector of the ancestor whose hover drives the effect — a card, a nav
   * pill — so the whole area is the target and there is no dead margin around
   * the words. Defaults to the text itself.
   */
  zone?: string
  /**
   * Show the resting text as a self-closing tag — `<ArguStream/>` — instead of as
   * bare words. The markers are then part of how it reads at rest, and hovering
   * opens them into the real tag around the expanded text.
   */
  selfClosing?: boolean
  className?: string
}

/**
 * How long the front takes to cross the text, and how long one character
 * spends as noise while it passes.
 *
 * The animation is a wave, not a curtain. It used to replace the whole string
 * with noise on its first frame and then reveal it back left to right, which
 * meant every hover began with the title *gone* — one frame of nothing legible
 * is exactly what a flicker is. Here each character is only noise while the
 * front is over it: the head of the word has settled while the tail has not
 * been touched yet, and at no moment is the whole of it unreadable.
 *
 * Both are durations rather than frame counts, because the clock is the only
 * thing that keeps an animation honest when the main thread is busy — which on
 * a live page it is, every time a turn lands. A dropped frame then costs only
 * itself: the next one works out where the wave should have got to by now,
 * instead of a backlog of timer fires arriving at once and jumping it forward.
 */
const SWEEP_MS = 430
const HOLD_MS = 170
/**
 * One position of the run: the letter that belongs there, and whatever is
 * standing in for it this frame.
 */
interface Cell {
  rest: string
  now: string
}

/**
 * The run, cut into words and then into characters.
 *
 * Each character keeps a box of its own, and a word is unbreakable, so the
 * line still wraps exactly where the words allow and nowhere else — which a
 * flat run of per-character boxes would not do.
 */
function lay(rest: string, now: string): { space: boolean; cells: Cell[] }[] {
  const runs: { space: boolean; cells: Cell[] }[] = []
  const span = Math.max(rest.length, now.length)
  let at = 0

  while (at < span) {
    const here = rest[at] ?? now[at]
    const space = here === ' '
    const cells: Cell[] = []
    while (at < span && ((rest[at] ?? now[at]) === ' ') === space) {
      cells.push({ rest: rest[at] ?? now[at] ?? ' ', now: now[at] ?? rest[at] ?? ' ' })
      at += 1
    }
    runs.push({ space, cells })
  }

  return runs
}

/**
 * The run, drawn.
 *
 * Both the copy that holds the box and the copy that is painted over it go
 * through here, and that is the whole point of it being a component: the two
 * have to lay out identically to the pixel. When only the painted one had its
 * characters in boxes it set a little wider than the box did — per-character
 * boxes cannot kern across their edges — so the last word of a title crossed
 * the width the box had reserved, wrapped to a second line, and was cut off by
 * the clip that keeps the noise inside the words. "Live debate" lost "debate";
 * "Why joint?" lost "joint?".
 */
function Run({ rest, now }: { rest: string; now: string }) {
  return (
    <>
      {lay(rest, now).map((run, index) =>
        run.space ? (
          <span key={index}>{run.cells.map((cell) => cell.rest).join('')}</span>
        ) : (
          <span className="ht__word" key={index}>
            {run.cells.map((cell, at) => (
              <span className="ht__cell" key={at}>
                <span className="ht__slot">{cell.rest}</span>
                <span className="ht__glyph" aria-hidden="true">
                  {cell.now}
                </span>
              </span>
            ))}
          </span>
        ),
      )}
    </>
  )
}

/**
 * How often a character that is currently noise is drawn again.
 *
 * Glyphs churning at sixty a second strobe rather than scramble, and this is
 * the only thing pacing the repaints — so the component renders about thirty
 * times a second instead of on every frame.
 */
const CHURN_MS = 34
/** how often a running effect re-checks that the cursor is still on it */
const WATCH_MS = 250

/**
 * Text that annotates itself under the cursor.
 *
 * Hovering it dissolves the words into generated glyphs — the same alphabet the
 * hero field is drawn from — which then resolve, left to right, into the tagged
 * form: `<text>…</text>` for ordinary writing, and the tag of the thing itself
 * where there is one, as `ArguStream` resolving into `<argustream>Joint Argument
 * and Entity Tagging</argustream>`. Leaving it plays the same move backwards.
 *
 * The animation is pointer-driven only, and skipped entirely under
 * `prefers-reduced-motion`, where the tagged form simply appears.
 *
 * `zone` widens what counts as "over it": the effect then starts the moment the
 * cursor enters the surrounding card or button, not only when it finds the
 * letters themselves. A watchdog checks, while the effect is running, that the
 * cursor really is still there — a `pointerleave` that never arrives, because
 * the deck scrolled the element away or the pointer left the window, would
 * otherwise leave the text tagged for good.
 */
export default function HoverTag({ children, tag = 'text', expand, zone, selfClosing, className }: Props) {
  const reduced = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const [display, setDisplay] = useState(children)
  const [on, setOn] = useState(false)
  const frame = useRef<number | null>(null)
  const selfRef = useRef<HTMLSpanElement>(null)
  /* what is on screen, readable from inside a running animation without
     waiting for a render to hand it over */
  const shown = useRef(children)

  const show = useCallback((next: string) => {
    shown.current = next
    setDisplay(next)
  }, [])

  /* what the cursor has to be over: the surrounding area, or the text itself */
  const hostOf = useCallback((): HTMLElement | null => {
    const self = selfRef.current
    if (!self) return null
    return (zone && self.closest<HTMLElement>(zone)) || self
  }, [zone])

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])

  useEffect(() => stop, [stop])

  /*
   * The wave: a front crosses the text, and each character is noise only while
   * it is under it.
   *
   * Before the front reaches a character it is still whatever was there;
   * behind it, it is what it is becoming. A space is never touched, so the
   * words keep their edges and the run does not appear to shuffle sideways
   * while it is being read.
   */
  const scramble = useCallback(
    (target: string) => {
      stop()
      if (reduced) {
        show(target)
        return
      }

      const from = shown.current
      const span = Math.max(1, target.length)
      const started = performance.now()
      let churned = 0

      const run = (now: number) => {
        const elapsed = now - started
        if (elapsed >= SWEEP_MS + HOLD_MS) {
          stop()
          show(target)
          return
        }

        /* the front moves every frame; what it is passing over is only redrawn
           often enough to read as churning rather than as strobing */
        if (now - churned < CHURN_MS) {
          frame.current = requestAnimationFrame(run)
          return
        }
        churned = now

        let out = ''
        for (let index = 0; index < target.length; index += 1) {
          const letter = target[index]
          if (letter === ' ') {
            out += ' '
            continue
          }
          const reaches = (index / span) * SWEEP_MS
          if (elapsed < reaches) out += from[index] ?? letter
          else if (elapsed < reaches + HOLD_MS) out += noise(1, TEXT_GLYPHS)
          else out += letter
        }
        show(out)

        frame.current = requestAnimationFrame(run)
      }

      frame.current = requestAnimationFrame(run)
    },
    [reduced, show, stop],
  )

  /*
   * Whether the effect is running, held in a ref as well as in state.
   *
   * `pointerenter` can arrive again while the tag is already open — the
   * watchdog below and a layout that shifts under the cursor both produce it —
   * and re-entering would restart the scramble from the noise every time,
   * which is a tag that never finishes resolving. Both transitions are
   * therefore made idempotent at the door rather than inside the animation.
   */
  const running = useRef(false)

  const enter = useCallback(() => {
    if (running.current) return
    running.current = true
    setOn(true)
    scramble(expand ?? children)
  }, [children, expand, scramble])

  /**
   * Leaving closes the tag. It only re-runs the wave if there is something for
   * it to change back.
   *
   * Where the tagged form is the same words as the resting one — which is
   * every heading on the site — scrambling on the way out was the text taking
   * itself apart and putting itself back exactly as it was, for no reason a
   * reader could see. It read as the title being yanked, because that is what
   * it was. The markers folding away is the whole of what leaving means there,
   * and that is a CSS transition already.
   */
  const leave = useCallback(() => {
    if (!running.current) return
    running.current = false
    setOn(false)
    const resting = expand ?? children
    if (resting === children) show(children)
    else scramble(children)
  }, [children, expand, scramble, show])

  /* listen on the area, which is the element itself when no zone is given */
  useEffect(() => {
    const host = hostOf()
    if (!host) return
    host.addEventListener('pointerenter', enter)
    host.addEventListener('pointerleave', leave)
    return () => {
      host.removeEventListener('pointerenter', enter)
      host.removeEventListener('pointerleave', leave)
    }
  }, [hostOf, enter, leave])

  /* the watchdog: no leave event can be relied upon, so verify it periodically */
  useEffect(() => {
    if (!on) return
    const watch = setInterval(() => {
      const host = hostOf()
      if (host && !host.matches(':hover')) leave()
    }, WATCH_MS)
    return () => clearInterval(watch)
  }, [on, hostOf, leave])

  /* at rest a self-closing tag closes itself; open, it is the tag it names */
  const openMark = !selfClosing || on ? `<${tag}>` : '<'
  const closeMark = !selfClosing || on ? `</${tag}>` : '/>'

  return (
    <span
      ref={selfRef}
      className={`ht${on ? ' is-on' : ''}${selfClosing ? ' ht--self' : ''}${className ? ` ${className}` : ''}`}
      style={{ ['--tag-color' as string]: `var(--tag-${tag}, var(--accent))` }}
    >
      {/* Keeps the resting box in the layout for the floating variant, where the
          tagged form is lifted out of the flow; `display: none` otherwise.
          It mirrors the body exactly — the same markers, folded or open by the
          same rules — so whatever the variant does to them, the box the layout
          sees and the thing drawn over it are the same width. */}
      <span className="ht__ghost" aria-hidden="true">
        <span className="ht__mark">{selfClosing ? '<' : openMark}</span>
        <Run rest={children} now={children} />
        <span className="ht__mark">{selfClosing ? '/>' : closeMark}</span>
      </span>
      <span className="ht__body">
        <span className="ht__mark" aria-hidden="true">{openMark}</span>
        {/*
          Every character in a box the width of the letter that belongs there.

          This is what the animation kept catching on. The glyphs it is drawn
          from are not the widths of the letters they stand in for, so in a run
          of ordinary text every character to the right of the ones being
          scrambled was shifted a little on every frame — and at heading size,
          with the rest of the word still perfectly legible beside it, that is
          a title visibly shuddering rather than an effect.

          Sized by the resting letter and never by what is standing in for it,
          nothing can move: a glyph wider than its box simply overhangs it. The
          boxes are there at rest too, so there is no moment of relaying out
          when the pointer arrives or leaves — the one thing left that could
          still have produced a jump.

          The letter itself stays in the box, transparent: it is what carries
          the selection and what a screen reader is given, so the title copies
          and reads as the words it is, whatever the animation is doing to it.
        */}
        <span className="ht__text">
          <Run rest={children} now={display} />
        </span>
        <span className="ht__mark" aria-hidden="true">{closeMark}</span>
      </span>
    </span>
  )
}
