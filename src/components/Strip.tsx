import { useEffect, useRef, type ReactNode } from 'react'
import './Strip.css'

interface Props {
  children: ReactNode
  className?: string
  'aria-label'?: string
}

/**
 * A single row that scrolls sideways instead of wrapping into a growing pile -
 * used wherever a list can get long, such as a tag set the visitor keeps adding
 * to.
 *
 * The wheel is mapped onto it explicitly: a notched mouse only reports deltaY,
 * which a horizontally scrolling box ignores by default. When the strip reaches
 * either end the event is left alone, so the slide deck picks it up again and
 * the page keeps travelling.
 */
export default function Strip({ children, className, ...rest }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const strip = ref.current
    if (!strip) return

    const onWheel = (event: WheelEvent) => {
      const room = strip.scrollWidth - strip.clientWidth
      if (room <= 1) return

      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const atStart = strip.scrollLeft <= 0
      const atEnd = strip.scrollLeft >= room - 1
      if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return

      event.preventDefault()
      strip.scrollLeft += delta
    }

    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div ref={ref} className={`strip${className ? ` ${className}` : ''}`} data-scroll data-no-drag {...rest}>
      {children}
    </div>
  )
}
