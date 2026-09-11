import Link from './Link'
import HoverTag from './HoverTag'
import type { Route } from '../lib/route'
import { PROJECT } from '../data/project'
import './NavBar.css'

/*
 * The order the tool is read in. It is about a debate while the debate is
 * happening, so the live feed comes first and everything else follows from it:
 * run one turn of your own, build the data by hand, and only then the argument
 * for why it is done in a single pass.
 */
const LINKS: { to: Route; label: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/live', label: 'Live' },
  { to: '/livesession', label: 'Session' },
  { to: '/playground', label: 'Playground' },
  { to: '/manual', label: 'Manual' },
  { to: '/why-joint', label: 'Why joint?' },
]

/**
 * `locked` is for a page somebody was given a link to, not one they opened.
 *
 * A spectator was handed one debate to watch. Putting the tool's own
 * navigation over it offers them the playground, the manual annotator and
 * somebody else's analytics - none of which they were invited to, and the
 * first click takes them out of the thing they were sent. So the bar keeps the
 * mark, which says what they are looking at, and nothing that leads anywhere:
 * no links, and a brand that is a name rather than a way home.
 */
export default function NavBar({
  route,
  bare,
  toned,
  locked,
}: {
  route: Route
  bare: boolean
  /** the slide under the bar carries a tone of its own; the bar takes it too */
  toned?: boolean
  locked?: boolean
}) {
  /*
   * Where the bar draws no rule under itself.
   *
   * The bar paints no surface, so it is already the colour of the page behind
   * it - measured, the two agree to within a value of 255. What was still
   * reading as a band along the top was the rule alone: a line drawn across an
   * otherwise continuous gradient marks off everything above it, and the eye
   * takes the strip it encloses for a differently coloured bar.
   *
   * The rule earns its place over a page with a top edge of its own to be
   * separated from. It does not over a deck, where a slide fills the window and
   * the line simply cuts across it - which is why the landing page has been
   * without one since it was asked for, and why "Why joint?" is now too.
   */
  const seamless = route === '/' || route === '/why-joint'
  const mark = (
    <span className="nav__name">
      {/* `<ARGUSTREAM/>` at rest, opening into `<argustream>ARGUSTREAM</argustream>`
          under the cursor: the mark closes itself until it is pointed at */}
      <HoverTag tag="argustream" zone=".nav__brand" selfClosing className="ht--float">
        {PROJECT.name.toUpperCase()}
      </HoverTag>
    </span>
  )

  if (locked) {
    return (
      <header className="nav nav--locked">
        <span className="nav__brand">{mark}</span>
        <span className="nav__watching">watching a live debate</span>
      </header>
    )
  }

  return (
    <header
      className={`nav${bare ? ' nav--bare' : ''}${seamless ? ' nav--seamless' : ''}${
        toned ? ' nav--toned' : ''
      }`}
    >
      <Link to="/" className="nav__brand">
        {mark}
      </Link>
      <nav className={`nav__links${bare ? ' is-hidden' : ''}`} aria-hidden={bare}>
        {LINKS.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className={`nav__link${route === link.to ? ' is-active' : ''}`}
            aria-current={route === link.to ? 'page' : undefined}
            tabIndex={bare ? -1 : undefined}
          >
            <HoverTag zone=".nav__link" className="ht--stacked">{link.label}</HoverTag>
          </Link>
        ))}
      </nav>
    </header>
  )
}
