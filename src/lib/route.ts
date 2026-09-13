import { useEffect, useState } from 'react'

/**
 * Minimal hash routing - no dependencies, works on any static host
 * (GitHub Pages, S3, a plain folder) without server rewrites.
 * Add a route by extending `ROUTES`, then branch in `App.tsx`.
 */
export const ROUTES = [
  '/',
  '/live',
  '/livesession',
  '/playground',
  '/manual',
  '/analysis',
  '/why-joint',
] as const

export type Route = (typeof ROUTES)[number]

/**
 * The hash, split into the route and whatever it carries.
 *
 * A route is still one of `ROUTES` and nothing else; anything after a `?` is
 * a parameter of that route, not a route of its own. That is what lets one
 * view be addressed twice - `#/live` is the debate you are running, and
 * `#/live?session=…` is the same view watching someone else's - without a
 * second entry in the table or a second page to keep in step with the first.
 */
function splitHash(): { path: string; query: string } {
  const raw = window.location.hash.replace(/^#/, '') || '/'
  const cut = raw.indexOf('?')
  if (cut === -1) return { path: raw || '/', query: '' }
  return { path: raw.slice(0, cut) || '/', query: raw.slice(cut + 1) }
}

export function readHash(): Route {
  const { path } = splitHash()
  return (ROUTES as readonly string[]).includes(path) ? (path as Route) : '/'
}

/** What the current route was addressed with. */
export function hashParams(): URLSearchParams {
  return new URLSearchParams(splitHash().query)
}

/** One parameter of the current route, kept in step with the address bar. */
export function useHashParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(() => hashParams().get(name))

  useEffect(() => {
    const onChange = () => setValue(hashParams().get(name))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [name])

  return value
}

/**
 * The address to hand to somebody else.
 *
 * Absolute, and built from where this build actually lives - a project page in
 * a subfolder, a preview on another port - so the link works from the machine
 * it is pasted into rather than only from the one it was copied on.
 */
export function linkTo(route: Route, params?: Record<string, string>): string {
  const query = params ? new URLSearchParams(params).toString() : ''
  const { origin, pathname, search } = window.location
  return `${origin}${pathname}${search}#${route}${query ? `?${query}` : ''}`
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readHash)

  useEffect(() => {
    const onChange = () => setRoute(readHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route])

  return route
}
