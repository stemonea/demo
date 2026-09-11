import { useEffect, useState } from 'react'
import HoverTag from '../components/HoverTag'
import Link from '../components/Link'
import TokenStream from '../components/TokenStream'
import TokenLabel from '../components/TokenLabel'
import TaggedText from '../components/TaggedText'
import TagLegend from '../components/TagLegend'
import SlideDeck, { type SlideItem } from '../components/SlideDeck'
import { PROJECT } from '../data/project'
import { EXAMPLES } from '../data/examples'
import { TRANSCRIPT } from '../data/fixtures'
import { SYSTEMS } from '../data/systems'
import type { Route } from '../lib/route'
import './HomePage.css'

const SHOWCASE = EXAMPLES[2]

interface Props {
  /** lets the shell know which slide the landing deck is on */
  /**
   * Which slide the deck has settled on, and whether that slide carries a tone
   * of its own - the bar has no surface, so it is the only thing that has to be
   * told when the page beneath it stops being paper.
   */
  onSlideChange: (index: number, toned: boolean) => void
}

/** the one slide set on the accent's hue rather than on paper */
const TONED_SLIDE = 'home-why'

export default function HomePage({ onSlideChange }: Props) {
  const [slide, setSlide] = useState(0)

  /* leaving the page puts the shell back to its bare state */
  useEffect(() => () => onSlideChange(0, false), [onSlideChange])

  function handleSlide(index: number) {
    setSlide(index)
    onSlideChange(index, slides[index]?.id === TONED_SLIDE)
  }

  const slides: SlideItem[] = [
    {
      id: 'home-intro',
      label: 'Intro',
      className: 'slide--fill',
      node: (
        <div className="hero">
          <div className="hero__top shell shell--open">
          {/* The four questions an annotated turn answers, with a rule running
              between them. The marks that open and close the line stand behind
              the first word and the last, the way a Spanish question is set. */}
          <h1 className="display hero__title" aria-label="Who, what, where, when?">
            <span className="hero__word">
              <span className="hero__ask hero__ask--upside-down" aria-hidden="true">?</span>
              <ThinningWord>Who</ThinningWord>
            </span>
            <HeroRule />
            <span className="hero__word">
              <ThinningWord>What</ThinningWord>
            </span>
            <HeroRule />
            <span className="hero__word">
              <ThinningWord>When</ThinningWord>
            </span>
            <HeroRule />
            <span className="hero__word">
              <span className="hero__ask" aria-hidden="true">?</span>
              <ThinningWord>Where</ThinningWord>
            </span>
          </h1>

          <div className="hero__bottom">
            <p className="hero__lead">{PROJECT.tagline}</p>
            {/* the live feed leads the tool, so it leads the hero too */}
            <div className="hero__actions">
              <TokenLink to="/live" className="btn btn--accent btn--token" label="Open the live debate" />
              <TokenLink to="/playground" className="btn btn--ghost btn--token" label="Open the playground" />
            </div>
          </div>
          </div>

          {/* the lower half of the hero, covered by the field - and press it:
              the generation answers back, see `TokenStream` */}
          <div className="hero__field">
            <TokenStream fit interactive />
          </div>
        </div>
      ),
    },
    {
      /* a preview of the streaming view */
      id: 'home-live',
      label: 'Live debate',
      node: (
        <Link to="/live" className="preview shell">
          <div className="preview__text">
            <span className="eyebrow">Streaming</span>
            <h2 className="display preview__title"><HoverTag zone=".preview">Live debate</HoverTag></h2>
            <p className="preview__lead">
              Tagging happens turn by turn, so a debate can be annotated while it unfolds. Play a transcript and watch
              the tags land as each turn arrives.
            </p>
            <span className="preview__cta">Open the live feed →</span>
          </div>
          <figure className="preview__shot">
            <figcaption className="preview__shot-label">Turn by turn</figcaption>
            {TRANSCRIPT.slice(0, 2).map((turn) => (
              <div className="preview__turn" key={turn.id}>
                <span className="preview__speaker">{turn.speaker}</span>
                <TaggedText text={turn.tagged} />
              </div>
            ))}
          </figure>
        </Link>
      ),
    },
    {
      /* a preview of the microphone session */
      id: 'home-session',
      label: 'Live session',
      node: (
        <Link to="/livesession" className="preview preview--reverse shell">
          <div className="preview__text">
            <span className="eyebrow">Spoken</span>
            <h2 className="display preview__title"><HoverTag zone=".preview">Speak the debate</HoverTag></h2>
            <p className="preview__lead">
              Select who is about to speak, then either open the microphone or enter the text manually. 
              Each turn is transcribed and annotated before the next one begins, and new speakers can be added at any point during the debate.
            </p>
            <span className="preview__cta">Open the session →</span>
          </div>
          <figure className="preview__shot">
            <figcaption className="preview__shot-label">One turn, spoken</figcaption>
            <ul className="preview__chips">
              {['MODERATOR', 'TRUMP', 'BIDEN'].map((label, i) => (
                <li className={`preview__chip${i === 2 ? ' preview__chip--live' : ''}`} key={label}>
                  {i === 2 && <span className="preview__on-air" aria-hidden="true" />}
                  {label}
                </li>
              ))}
            </ul>
            <TaggedText text={TRANSCRIPT[1].tagged} />
          </figure>
        </Link>
      ),
    },
    {
      /* a preview of the playground - the whole slide opens it */
      id: 'home-try',
      label: 'Playground',
      node: (
        <Link to="/playground" className="preview shell">
          <div className="preview__text">
            <span className="eyebrow">Try!</span>
            <h2 className="display preview__title"><HoverTag zone=".preview">Playground</HoverTag></h2>
            <p className="preview__lead">
              Write your own turn, have it annotated in one pass, and read the result back filtering the annotated
              components you care about.
            </p>
            <span className="preview__cta">Open →</span>
          </div>
          <figure className="preview__shot">
            <figcaption className="preview__shot-label">Annotated turn</figcaption>
            <TaggedText text={SHOWCASE.gold} />
            <TagLegend />
          </figure>
        </Link>
      ),
    },
    {
      /* a preview of the hand-annotation workbench */
      id: 'home-manual',
      label: 'Manual',
      node: (
        <Link to="/manual" className="preview preview--reverse shell">
          <div className="preview__text">
            <span className="eyebrow">Manual</span>
            <h2 className="display preview__title"><HoverTag zone=".preview">Build it by hand</HoverTag></h2>
            <p className="preview__lead">
              Load a transcript, declare your own entity set, tag both layers by hand, and export it.
            </p>
            <span className="preview__cta">Open the annotator →</span>
          </div>
          <figure className="preview__shot">
            <figcaption className="preview__shot-label">Two layers, one file</figcaption>
            <ul className="preview__chips">
              {['CLAIM', 'PREMISE', 'PERSON', 'ORG', 'DATE', 'YOURS'].map((label) => (
                <li className="preview__chip" key={label}>
                  {label}
                </li>
              ))}
            </ul>
            <pre className="preview__code">{`# token\targument\tentity
TRUMP\tO\tB-PERSON
Iran\tB-CLAIM\tB-LOCATION
is\tI-CLAIM\tO`}</pre>
          </figure>
        </Link>
      ),
    },
    {
      /* a preview of the comparison - the whole slide opens it */
      id: 'home-why',
      label: 'Why joint?',
      className: 'slide--green',
      node: (
        <Link to="/why-joint" className="preview preview--green shell">
          <div className="preview__text">
            <span className="eyebrow">Info</span>
            <h2 className="display preview__title"><HoverTag zone=".preview">Why joint?</HoverTag></h2>
            <p className="preview__lead">
              Split the task in two and see the difference with the joint approach.
            </p>
            <span className="preview__cta">See the three systems →</span>
          </div>
          <figure className="preview__shot preview__shot--systems">
            <figcaption className="preview__shot-label">One turn, three systems</figcaption>
            <ul className="systems">
              {SYSTEMS.map((system) => (
                <li key={system.id} className={`systems__item systems__item--${system.kind}`}>
                  <span className="systems__name">{system.name}</span>
                  <span className="systems__flow">{system.flow.join('  →  ')}</span>
                </li>
              ))}
            </ul>
          </figure>
        </Link>
      ),
    },
  ]

  return (
    <>
      <SlideDeck slides={slides} onIndexChange={handleSlide} />
      {/* while the deck bar is away, this says which way the page goes */}
      <span className={`scroll-hint${slide > 0 ? ' is-gone' : ''}`} aria-hidden="true">
        Scroll
        <span className="scroll-hint__arrows">»</span>
      </span>
    </>
  )
}

/**
 * The tie between two of the four questions, and the question it becomes.
 *
 * At rest it is the rule the line has always had. Under the cursor it turns
 * into the mark the title is asking with - upright or turned over, decided
 * afresh each time the cursor arrives, so the line is never quite set the same
 * way twice. The two marks that open and close the title are fixed; these are
 * not, which is what makes them worth hovering.
 *
 * The mark is laid over the rule rather than put in its place. The rule is a
 * flex item between two words, and a character swapped into its box would
 * change the width of the line and move all four words while the cursor is on
 * one of them. So the box stays exactly the rule's and the mark is centred over
 * it - which is also what keeps the mark centred between the words, since the
 * rule is what the gap is measured from.
 *
 * Whether the mark is showing is left to CSS `:hover` rather than held here.
 * The deck travels sideways under the cursor, and a `pointerleave` that never
 * arrives would leave a rule stuck as a question mark; the browser's own hover
 * state cannot get stuck. All this holds is which way up the mark is, which is
 * the one thing CSS cannot decide.
 */
function HeroRule() {
  const [upsideDown, setUpsideDown] = useState(false)

  return (
    <span
      className="hero__rule"
      aria-hidden="true"
      onPointerEnter={() => setUpsideDown(Math.random() < 0.5)}
    >
      <span className={`hero__rule-mark${upsideDown ? ' hero__rule-mark--upside-down' : ''}`}>?</span>
    </span>
  )
}

/**
 * A hero button: it squares off under the cursor while its label is rebuilt out
 * of the glyph field's own alphabet. The hover lives here rather than in
 * `TokenLabel` so the anchor stays one element - the label is what animates, the
 * link is what is clicked.
 */
function TokenLink({ to, className, label }: { to: Route; className: string; label: string }) {
  const [run, setRun] = useState(0)
  const rebuild = () => setRun((value) => value + 1)

  return (
    <Link to={to} className={className} aria-label={label} onMouseEnter={rebuild} onFocus={rebuild}>
      <TokenLabel text={label} run={run} />
    </Link>
  )
}

/**
 * A word whose letters thin out under the cursor.
 *
 * Each letter is drawn twice: an invisible copy at the resting weight holds the
 * advance open, and the visible one loses weight when the pointer is on it. The
 * word therefore never reflows - a letter that narrowed as it lightened would
 * shift the ones after it out from under the cursor and flicker.
 *
 * The heading carries the real words as its label, so what is read aloud is a
 * sentence rather than a column of single letters.
 */
function ThinningWord({ children }: { children: string }) {
  return (
    <span className="thin" aria-hidden="true">
      {[...children].map((letter, index) => (
        <span className="thin__letter" key={`${letter}-${index}`}>
          <span className="thin__width">{letter}</span>
          <span className="thin__ink">{letter}</span>
        </span>
      ))}
    </span>
  )
}
