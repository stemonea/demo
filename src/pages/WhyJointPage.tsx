import { useEffect, useRef, useState } from 'react'
import HoverTag from '../components/HoverTag'
import SlideDeck, { type SlideItem } from '../components/SlideDeck'
import CompareBench from '../components/CompareBench'
import SystemPanel from '../components/SystemPanel'
import TaggedText from '../components/TaggedText'
import TagLegend from '../components/TagLegend'
import LayerSwitch from '../components/LayerSwitch'
import SourceBadge from '../components/SourceBadge'
import ExportMenu from '../components/ExportMenu'
import { EXAMPLES } from '../data/examples'
import { SYSTEMS } from '../data/systems'
import { FAILURE_MECHANISMS } from '../data/project'
import { compare, type CompareResult } from '../lib/api'
import { noticeOf } from '../lib/failure'
import type { LayerView } from '../lib/view'
import './WhyJointPage.css'

export default function WhyJointPage() {
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const [view, setView] = useState<LayerView>('all')
  const [showGold, setShowGold] = useState(true)

  /* the control bar rides along with every comparison slide */
  const renderControls = (withGold: boolean) => (
    <div className="controls">
      <div className="controls__toggles">
        <LayerSwitch value={view} onChange={setView} />
        {withGold && (
          <button
            type="button"
            className={`toggle${showGold ? ' is-on' : ''}`}
            onClick={() => setShowGold((value) => !value)}
            aria-pressed={showGold}
          >
            Gold
          </button>
        )}
        <button
          type="button"
          className={`toggle${mode === 'raw' ? ' is-on' : ''}`}
          onClick={() => setMode((value) => (value === 'raw' ? 'rendered' : 'raw'))}
          aria-pressed={mode === 'raw'}
        >
          Raw markup
        </button>
      </div>
    </div>
  )

  /*
   * The reader's own turn opens the deck.
   *
   * The page used to argue first and invite second: an overview, four reported
   * examples, and only then a box to type in. Anyone who arrived wanting to see
   * the thing work had to travel past the whole argument to reach it. Putting
   * their turn first reverses that - the tool is the first thing offered, and
   * the case for it is what the slide points at, in words, for whoever wants it
   * after they have seen it run.
   */
  /*
   * The write-only slide is off for now.
   *
   * The bench that opens the deck does everything this one does and more - it
   * takes a typed turn as well as a transcript, and it times what the three
   * systems spend - so having both offers the reader the same thing twice, once
   * in a poorer version. It is kept in the source rather than deleted because
   * the decision is about what to show, not about whether the screen was worth
   * building: flip this to bring it back.
   */
  const OWN_TURN_SLIDE = false

  const slides: SlideItem[] = [
    /*
     * The bench opens the deck: a turn, or a transcript, put through the three
     * systems with the clock running and advanced by hand. It is the argument
     * made rather than described - everything after it explains what the three
     * columns are and why the two pipelines lose what they lose.
     */
    {
      id: 'why-bench',
      label: 'Compare',
      next: { label: OWN_TURN_SLIDE ? 'Run your own turn' : 'Discover why joint' },
      node: <CompareBench />,
    },

    ...(OWN_TURN_SLIDE
      ? [
          {
            id: 'why-yours',
            label: 'Your own turn',
            next: { label: 'Discover why joint' },
            node: <OwnTurn mode={mode} view={view} controls={renderControls(false)} />,
          } satisfies SlideItem,
        ]
      : []),

    /*
     * From here on the deck is the argument, read in order, so every slide of it
     * carries the way to the next one: the overview into the first example, each
     * example into the one after it, and the last of them back to the reader's
     * own turn where the deck began. The run closes rather than stopping - an
     * arrow that simply disappeared on the final slide would leave whoever had
     * read the whole case with nothing to press.
     */
    {
      id: 'why-intro',
      label: 'Overview',
      next: { label: 'See the first example' },
      node: (
        <div className="why-intro shell">
          <span className="eyebrow">Comparison</span>
          <h1 className="display why-intro__title"><HoverTag>Why joint?</HoverTag></h1>
          <p className="why-intro__lead">
            The same debate turn, tagged three ways: one single-pass model against the two sequential pipelines that
            compose the same two stages in either order. The four reported turns follow.
          </p>
          <div className="why-intro__mechanisms">
            {FAILURE_MECHANISMS.map((mechanism, i) => (
              <div key={mechanism.title} className="mechanism">
                <span className="mechanism__num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <h2 className="mechanism__title">{mechanism.title}</h2>
                  <p className="mechanism__body">{mechanism.body}</p>
                </div>
              </div>
            ))}
          </div>
          <TagLegend />
        </div>
      ),
    },

    ...EXAMPLES.map<SlideItem>((example, i) => ({
      id: `why-${example.id}`,
      label: example.index,
      next:
        i === EXAMPLES.length - 1
          ? /* slide 0 is the bench, which is where the deck opens and therefore
               where a reader who has been through the whole case is sent back to */
            { label: 'Back to the bench', to: 0 }
          : { label: `Next: ${EXAMPLES[i + 1].index.toLowerCase()}` },
      node: (
        <div className="compare shell">
          <header className="compare__head">
            <h2 className="compare__title">
              <span className="eyebrow">{example.index}</span>
              {example.title}
            </h2>
            {renderControls(true)}
          </header>

          {showGold && (
            <div className="gold" aria-label="Gold annotation">
              <span className="gold__label">Gold</span>
              <TaggedText text={example.gold} mode={mode} view={view} />
            </div>
          )}

          {/* the screen split in three: one column per system */}
          <div className="split" data-scroll aria-label="System comparison">
            {SYSTEMS.map((system) => (
              <SystemPanel
                key={system.id}
                system={system}
                text={example.outputs[system.id].text}
                verdict={example.outputs[system.id].verdict}
                note={example.outputs[system.id].note}
                mode={mode}
                view={view}
                actions={
                  <ExportMenu
                    compact
                    tagged={example.outputs[system.id].text}
                    filename={`${example.id}-${system.id}`}
                  />
                }
              />
            ))}
          </div>

          <p className="commentary">{example.commentary}</p>
        </div>
      ),
    })),
  ]

  return <SlideDeck slides={slides} />
}

/* ------------------------------------------------------------------ *
 * The three systems, run on the visitor's own text                    *
 * ------------------------------------------------------------------ */

function OwnTurn({
  mode,
  view,
  controls,
}: {
  mode: 'rendered' | 'raw'
  view: LayerView
  controls: React.ReactNode
}) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<CompareResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  async function run() {
    const trimmed = text.trim()
    if (!trimmed || status === 'loading') return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setStatus('loading')
    setError(null)
    try {
      setResult(await compare(trimmed, view, controller.signal))
      setStatus('done')
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') return
      setError(noticeOf(cause))
      setStatus('error')
    }
  }

  return (
    <div className="compare shell">
      <header className="compare__head">
        <h2 className="compare__title">
          <span className="eyebrow">Your own turn</span>
          Run the three systems on your text
        </h2>
        {controls}
      </header>

      <div className="own">
        <textarea
          className="own__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={2}
          placeholder="SPEAKER: paste a debate turn here…"
          aria-label="Text to compare"
        />
        <div className="own__actions">
          <span className="own__hint">One turn, as it would arrive from the transcript.</span>
          <button
            type="button"
            className="btn btn--accent"
            onClick={run}
            disabled={status === 'loading' || !text.trim()}
          >
            {status === 'loading' ? 'Running…' : 'Compare'}
          </button>
        </div>
      </div>

      {status === 'error' && <p className="own__error">{error}</p>}

      {status === 'done' && result && (
        <>
          <div className="split" data-scroll aria-label="System comparison">
            {SYSTEMS.map((system) => (
              <SystemPanel
                key={system.id}
                system={system}
                text={result.outputs[system.id]}
                mode={mode}
                view={view}
                actions={<ExportMenu compact tagged={result.outputs[system.id]} filename={`your-turn-${system.id}`} />}
              />
            ))}
          </div>
          <p className="commentary commentary--row">
            <SourceBadge source={result.source} elapsedMs={result.elapsedMs} />
            <span>
              The two pipelines are the same two stages composed in either order; every structural defect below is
              produced by that composition, not by the backbone.
            </span>
          </p>
        </>
      )}

      {status !== 'done' && status !== 'error' && (
        <p className="own__hint">
          {status === 'loading'
            ? 'Running the three systems…'
            : 'Pick a turn or paste your own, then compare the single-pass model against both pipelines.'}
        </p>
      )}
    </div>
  )
}
