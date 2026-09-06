import { useMemo } from 'react'
import TaggedText from './TaggedText'
import VerdictBadge from './VerdictBadge'
import { collectIssues, parseTaggedText } from '../lib/parseTags'
import type { SystemSpec } from '../data/systems'
import type { Verdict } from '../data/examples'
import type { LayerView } from '../lib/view'
import './SystemPanel.css'

interface Props {
  system: SystemSpec
  /** the tagged output of this system for the turn on screen */
  text: string
  mode: 'rendered' | 'raw'
  view: LayerView
  /** shown as a badge; omitted when there is no gold to compare against */
  verdict?: Verdict
  /** one-line reading of what this system did on this turn */
  note?: string
  /** slot for per-panel actions, e.g. an export menu */
  actions?: React.ReactNode
}

/** One of the three columns of the comparison. */
export default function SystemPanel({ system, text, mode, view, verdict, note, actions }: Props) {
  const issues = useMemo(() => collectIssues(parseTaggedText(text)), [text])
  const wellFormed = issues.orphanClosers === 0 && issues.unclosedTags === 0

  return (
    <article className={`panel panel--${system.kind}`} aria-label={system.name}>
      <header className="panel__head">
        <div className="panel__title-row">
          <h2 className="panel__title">{system.name}</h2>
          {verdict && <VerdictBadge verdict={verdict} />}
        </div>
        <p className="panel__tagline">{system.tagline}</p>
        <ol className="panel__flow">
          {system.flow.map((step, i) => (
            <li
              key={step + i}
              className={i === 0 || i === system.flow.length - 1 ? 'panel__step panel__step--io' : 'panel__step'}
            >
              {step}
            </li>
          ))}
        </ol>
      </header>

      <div className="panel__body" data-scroll>
        <TaggedText text={text} mode={mode} view={view} />
      </div>

      <footer className="panel__foot">
        {note && <p className="panel__note">{note}</p>}
        <p className={`panel__markup ${wellFormed ? 'is-ok' : 'is-bad'}`}>
          {wellFormed
            ? 'well-formed markup'
            : `${issues.orphanClosers} stray closer(s) · ${issues.unclosedTags} unclosed span(s)`}
        </p>
        {actions}
      </footer>
    </article>
  )
}
