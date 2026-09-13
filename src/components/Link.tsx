import { useCallback, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import type { Route } from '../lib/route'

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: Route
}

/**
 * Anchor bound to the hash router.
 *
 * Re-clicking the route you are already on takes you back to its beginning: the
 * pages travel sideways, so that means the first slide of the deck, not the top
 * of a vertical page - a plain `scrollTo(top)` moves nothing here and reads as a
 * dead link, which is exactly what `Home` and the brand looked like while on the
 * landing page.
 */
export default function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handle = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      const current = window.location.hash.replace(/^#/, '') || '/'
      if (current === to) {
        event.preventDefault()
        document.querySelector('.deck__track')?.scrollTo({ left: 0, behavior: 'smooth' })
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    },
    [to, onClick],
  )

  return (
    <a href={`#${to}`} onClick={handle} {...rest}>
      {children}
    </a>
  )
}
