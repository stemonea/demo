import { useEffect, useMemo, useRef, useState } from 'react'
import { noise, TEXT_GLYPHS } from '../lib/glyphs'
import './TokenLabel.css'

/**
 * A label that rebuilds itself out of the noise.
 *
 * The same alphabet the hero field is drawn from, resolving left to right into
 * the words: the button is generated the way a turn is, which is the one thing
 * this whole demo is about. It runs on `run` - the caller bumps that on hover
 * and on focus - and always ends on the real text, however it is interrupted.
 *
 * The text is laid out twice: an invisible copy holds the width, so a run of
 * glyphs wider than the letters cannot make the button breathe, and the visible
 * one is the label itself. That copy is not selectable and not exposed, so the
 * button still reads and copies as the one string it is - the name for anything
 * not looking at pixels belongs on the control, and the caller puts it there.
 */

/**
 * How long the front takes to cross the label, and how long one character
 * spends as noise while it passes.
 *
 * The same wave the hovered headings use, for the same reason: replacing the
 * whole label with noise and revealing it back meant every hover began with
 * the button's name gone, which is a flicker rather than a rebuild. Here the
 * label is legible throughout - the front has settled the start of it before
 * it has reached the end.
 *
 * Durations, not counts of timer fires: an interval that does not divide into
 * the frame lands its steps unevenly, and one that misses its slot while the
 * main thread is busy fires twice in a row to catch up.
 */
const SWEEP_MS = 280
const HOLD_MS = 130
/** how often a character under the front is drawn again: churning, not strobing */
const CHURN_MS = 34

export default function TokenLabel({ text, run }: { text: string; run: number }) {
  const reduced = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  const [display, setDisplay] = useState(text)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    /* nothing to rebuild until the first hover, and nothing at all if the
       reader asked for less movement */
    if (run === 0 || reduced) return

    const span = Math.max(1, text.length)
    const started = performance.now()
    let churned = 0

    const step = (now: number) => {
      const elapsed = now - started
      if (elapsed >= SWEEP_MS + HOLD_MS) {
        frame.current = null
        setDisplay(text)
        return
      }

      if (now - churned < CHURN_MS) {
        frame.current = requestAnimationFrame(step)
        return
      }
      churned = now

      /* each character is noise only while the front is over it, and a space
         is never touched, so the words keep their edges */
      let out = ''
      for (let i = 0; i < text.length; i += 1) {
        const letter = text[i]
        const reaches = (i / span) * SWEEP_MS
        out += letter === ' ' || elapsed < reaches || elapsed >= reaches + HOLD_MS ? letter : noise(1, TEXT_GLYPHS)
      }
      setDisplay(out)

      frame.current = requestAnimationFrame(step)
    }

    frame.current = requestAnimationFrame(step)

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      setDisplay(text)
    }
  }, [run, text, reduced])

  return (
    <span className="tokenlabel">
      <span className="tokenlabel__width" aria-hidden="true">
        {text}
      </span>
      <span className="tokenlabel__live">{display}</span>
    </span>
  )
}
