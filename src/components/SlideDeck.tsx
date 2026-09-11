import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import './SlideDeck.css'

export interface SlideItem {
  id: string
  /** short name for the slide, read out as its accessible label */
  label: string
  /** optional modifier class on the slide, e.g. for a full-bleed dark panel */
  className?: string
  /**
   * A named way on from this slide, drawn against its right edge.
   *
   * The deck moves by gesture and by arrow key, neither of which says where it
   * goes. Where the slide after this one is the answer to the slide being read
   * - the examples behind a question, the argument behind a tool - the deck can
   * say so in words instead of leaving the reader to find it.
   *
   * `to` is the slide it leads to, and defaults to the one after this. Naming it
   * is what lets a run of slides close rather than dead-end: the last of a set
   * of examples points back to where the run began, so a reader who has gone
   * through them all is offered the way round instead of an arrow that has
   * quietly stopped working.
   */
  next?: { label: string; to?: number }
  node: ReactNode
}

interface Props {
  slides: SlideItem[]
  /** called whenever the deck settles on another slide */
  onIndexChange?: (index: number) => void
}

/**
 * Horizontal deck: the page travels to the right instead of down.
 *
 * Native overflow scrolling does the work (so touch swipe, trackpad gestures and
 * the scrollbar keep behaving), and on top of it we map vertical wheel intent to
 * horizontal travel, add pointer dragging and arrow keys.
 * A slide taller than the viewport keeps its own vertical scroll: the wheel is
 * only redirected when the pointer is not over something that can absorb it.
 *
 * The deck carries no navigation of its own. On the landing page a bar of named
 * slides only repeated the site navigation one row lower, in the same words, and
 * the other decks are short enough to read straight through; what is left is the
 * gesture and the arrow keys.
 */
export default function SlideDeck({ slides, onIndexChange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)

  const indexRef = useRef(0)

  const goTo = useCallback(
    (target: number) => {
      const track = trackRef.current
      if (!track) return
      const clamped = Math.max(0, Math.min(slides.length - 1, target))
      indexRef.current = clamped
      setIndex(clamped)
      onIndexChange?.(clamped)
      track.scrollTo({
        left: clamped * track.clientWidth,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      })
    },
    [slides.length, onIndexChange],
  )

  /* keep the active index in sync with the actual scroll position */
  useEffect(() => {
    const track = trackRef.current
    if (!track) return

    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const current = Math.round(track.scrollLeft / Math.max(1, track.clientWidth))
        if (current === indexRef.current) return
        indexRef.current = current
        setIndex(current)
        onIndexChange?.(current)
      })
    }

    track.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      track.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [onIndexChange])

  /*
   * Wheel: one gesture = one slide.
   * A notched mouse wheel emits ~100px per click, which would need a dozen
   * clicks to cross a full-viewport slide, so instead of forwarding the delta we
   * accumulate it and step to the neighbouring slide, then ignore further events
   * until the smooth scroll has settled.
   *
   * The pause is deliberately a fixed one. Holding the deck shut for as long as
   * events keep arriving does stop a flick's inertia from carrying two slides,
   * but it also means that going on scrolling moves nothing at all until the
   * hand lifts, and the deck then reads as stuck rather than as disciplined. An
   * occasional double step is the better failure.
   */
  useEffect(() => {
    const track = trackRef.current
    if (!track) return

    let accumulated = 0
    let lockedUntil = 0

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      /* an inner scroller that already consumed this gesture, e.g. a Strip */
      if (event.defaultPrevented) return
      if (absorbs(event.target, event.deltaX, event.deltaY, track)) return

      event.preventDefault()

      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? track.clientWidth : 1
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const delta = raw * scale
      const now = performance.now()

      if (now < lockedUntil) return
      if (Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0
      accumulated += delta

      if (Math.abs(accumulated) < WHEEL_THRESHOLD) return

      goTo(indexRef.current + Math.sign(accumulated))
      accumulated = 0
      lockedUntil = now + WHEEL_COOLDOWN
    }

    track.addEventListener('wheel', onWheel, { passive: false })
    return () => track.removeEventListener('wheel', onWheel)
  }, [goTo])

  /* arrow keys, when the user is not typing */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return
      if (event.key === 'ArrowRight') goTo(index + 1)
      else if (event.key === 'ArrowLeft') goTo(index - 1)
      else if (event.key === 'Home') goTo(0)
      else if (event.key === 'End') goTo(slides.length - 1)
      else return
      event.preventDefault()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, index, slides.length])

  /* drag to pan, skipping interactive targets */
  useEffect(() => {
    const track = trackRef.current
    if (!track) return

    let pointerId: number | null = null
    let startX = 0
    let startLeft = 0
    let moved = false

    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      const target = event.target as HTMLElement | null
      if (target?.closest('a, button, input, textarea, select, [data-no-drag]')) return
      pointerId = event.pointerId
      startX = event.clientX
      startLeft = track.scrollLeft
      moved = false
      track.classList.add('is-dragging')
    }

    const onMove = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return
      const travel = event.clientX - startX
      if (!moved && Math.abs(travel) > 3) {
        moved = true
        track.setPointerCapture(pointerId)
      }
      if (moved) track.scrollLeft = startLeft - travel
    }

    const onUp = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return
      if (track.hasPointerCapture(pointerId)) track.releasePointerCapture(pointerId)
      pointerId = null
      track.classList.remove('is-dragging')
    }

    track.addEventListener('pointerdown', onDown)
    track.addEventListener('pointermove', onMove)
    track.addEventListener('pointerup', onUp)
    track.addEventListener('pointercancel', onUp)
    return () => {
      track.removeEventListener('pointerdown', onDown)
      track.removeEventListener('pointermove', onMove)
      track.removeEventListener('pointerup', onUp)
      track.removeEventListener('pointercancel', onUp)
    }
  }, [])

  return (
    <div className="deck">
      <div className="deck__track" ref={trackRef}>
        {slides.map((slide, i) => (
          <section
            className={`deck__slide${slide.className ? ` ${slide.className}` : ''}`}
            key={slide.id}
            id={slide.id}
            aria-label={slide.label}
          >
            <div className="deck__slide-inner">{slide.node}</div>
            {slide.next && index === i && (
              <button
                type="button"
                className="deck__onward"
                onClick={() => goTo(slide.next?.to ?? i + 1)}
                data-no-drag
              >
                <span className="deck__onward-label">{slide.next.label}</span>
                {/* the arrow turns back on itself where the way on is a way
                    round: the same control, saying which of the two it is */}
                <span className="deck__onward-arrow" aria-hidden="true">
                  {slide.next.to !== undefined && slide.next.to <= i ? '↩' : '→'}
                </span>
              </button>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}

/** px of wheel travel needed to step to the next slide */
const WHEEL_THRESHOLD = 40
/** ms of quiet after a step, so one gesture never skips two slides */
const WHEEL_COOLDOWN = 550

/**
 * True when the wheel belongs to a scrollable region inside the slide rather
 * than to the deck. Only explicit opt-ins count - an element marked
 * `data-scroll` or a form control - so the deck never silently swallows the
 * gesture just because a slide happens to be a few pixels too tall.
 */
function absorbs(target: EventTarget | null, deltaX: number, deltaY: number, boundary: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null

  while (node && node !== boundary) {
    const optIn = node.hasAttribute('data-scroll') || node instanceof HTMLTextAreaElement
    if (optIn) {
      const roomY = node.scrollHeight - node.clientHeight
      /*
       * A region that scrolls vertically keeps the whole vertical gesture, and
       * keeps it at its ends too. Handing the wheel back once the region is at
       * its top means that reading back up through a long text carries you out
       * of the slide the moment you reach the first line - you were reading,
       * not navigating, and the page went backwards under you. The deck is
       * still reached by the bar, the arrow keys and everywhere that is not an
       * inner scroller.
       */
      if (roomY > 1 && Math.abs(deltaY) >= Math.abs(deltaX)) return true
      const roomX = node.scrollWidth - node.clientWidth
      if (roomX > 1) {
        /* A strip that only scrolls sideways takes the wheel whichever axis it
           came from: a notched mouse reports deltaY alone, and the strip is
           what the pointer is over. */
        const delta = roomY > 1 || Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
        const atStart = node.scrollLeft <= 0
        const atEnd = node.scrollLeft >= roomX - 1
        if ((delta < 0 && !atStart) || (delta > 0 && !atEnd)) return true
      }
    }
    node = node.parentElement
  }

  return false
}
