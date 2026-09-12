import { useEffect, useMemo, useRef, useState } from 'react'
import HoverTag from '../components/HoverTag'
import SlideDeck, { type SlideItem } from '../components/SlideDeck'
import SourceBadge from '../components/SourceBadge'
import FileDrop from '../components/FileDrop'
import { readTextFile } from '../lib/textFile'
import { parseTranscript } from '../lib/transcript'
import { Cooccurrence, EntityProfiles, MentionTimeline, WhoArguesWhat } from '../components/charts/Charts'
import { TRANSCRIPT } from '../data/fixtures'
import { SYSTEMS, type SystemId } from '../data/systems'
import { EXAMPLES } from '../data/examples'
import { analyse, type AnalysedTurn } from '../lib/analytics'
import { annotate, type Source } from '../lib/api'
import { noticeOf } from '../lib/failure'
import './AnalysisPage.css'

/**
 * Debate analytics over annotated turns.
 *
 * The transcript can come from the bundled excerpt — which carries the output of
 * all three systems, so the same aggregation can be recomputed on a pipeline and
 * compared — or from a .txt transcript the visitor loads, one turn per line,
 * annotated turn by turn.
 */
export default function AnalysisPage() {
  const [system, setSystem] = useState<SystemId>('joint')
  const [ownTurns, setOwnTurns] = useState<AnalysedTurn[] | null>(null)
  const [ownSource, setOwnSource] = useState<Source | null>(null)

  const turns: AnalysedTurn[] = useMemo(() => {
    if (ownTurns) return ownTurns
    return TRANSCRIPT.map((turn, index) => ({
      index,
      speaker: turn.speaker,
      tagged: outputOf(index, system),
    }))
  }, [ownTurns, system])

  const stats = useMemo(() => analyse(turns), [turns])

  /* the same aggregation, recomputed on each system, for the integrity panel */
  const perSystem = useMemo(
    () =>
      SYSTEMS.map((spec) => ({
        spec,
        stats: analyse(
          TRANSCRIPT.map((turn, index) => ({ index, speaker: turn.speaker, tagged: outputOf(index, spec.id) })),
        ),
      })),
    [],
  )

  const slides: SlideItem[] = [
    {
      id: 'analysis-overview',
      label: 'Overview',
      node: (
        <div className="analysis shell">
          <header className="analysis__head">
            <div>
              <span className="eyebrow">Analytics</span>
              <h1 className="display analysis__title"><HoverTag>Who argues what</HoverTag></h1>
            </div>
            <p className="analysis__lead">
              No model runs here: every view below is arithmetic over the tags. The relation that generates all of
              them is where a mention sits — inside a claim, inside a premise, or outside any argument.
            </p>
          </header>

          <div className="analysis__controls">
            <Sourcebar
              system={system}
              onSystem={setSystem}
              own={Boolean(ownTurns)}
              onOwn={setOwnTurns}
              onSource={setOwnSource}
            />
            {ownSource && <SourceBadge source={ownSource} />}
          </div>

          <div className="tiles">
            <Tile value={stats.turns} label="turns" detail="in the transcript under analysis" />
            <Tile value={stats.components} label="argument components" detail="claims and premises found" />
            <Tile value={stats.entities.length} label="distinct entities" detail="after alias merging" />
            <Tile
              value={`${percent(stats.groundedMentions, stats.totalMentions)}%`}
              label="grounded mentions"
              detail={`${stats.groundedMentions} of ${stats.totalMentions} entity mentions sit inside an argument`}
              accent
            />
          </div>

          <section className="integrity">
            <h2 className="eyebrow">Why the joint output is the one you can analyse</h2>
            <p className="integrity__text">
              Grounding a mention means knowing which argument component encloses it. That is a property of the
              nesting, so it survives or dies with the markup — recomputed here on each system over the same excerpt.
            </p>
            <ul className="integrity__rows">
              {perSystem.map(({ spec, stats: other }) => (
                <li className={`integrity__row integrity__row--${spec.kind}`} key={spec.id}>
                  <span className="integrity__name">{spec.name}</span>
                  <span className="integrity__bar">
                    <span
                      className="integrity__fill"
                      style={{ width: `${percent(other.groundedMentions, Math.max(1, other.totalMentions))}%` }}
                    />
                  </span>
                  <span className="integrity__value">
                    {other.groundedMentions}/{other.totalMentions} mentions · {other.components} components
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ),
    },
    {
      id: 'analysis-matrix',
      label: 'Who argues what',
      node: (
        <div className="analysis shell">
          <h2 className="display analysis__section"><HoverTag>Speakers × entities</HoverTag></h2>
          <WhoArguesWhat stats={stats} />
          <h3 className="eyebrow">Invoked together</h3>
          <Cooccurrence stats={stats} limit={5} />
        </div>
      ),
    },
    {
      id: 'analysis-entities',
      label: 'Entity profiles',
      node: (
        <div className="analysis shell">
          <h2 className="display analysis__section"><HoverTag>How each entity is used</HoverTag></h2>
          <EntityProfiles stats={stats} />
        </div>
      ),
    },
    {
      id: 'analysis-timeline',
      label: 'Timeline',
      node: (
        <div className="analysis shell">
          <h2 className="display analysis__section"><HoverTag>Turn by turn</HoverTag></h2>
          <MentionTimeline stats={stats} />
        </div>
      ),
    },
  ]

  return <SlideDeck slides={slides} />
}

/* ------------------------------------------------------------------ */

function outputOf(index: number, system: SystemId): string {
  return EXAMPLES[index].outputs[system].text
}

function percent(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0
}

function Tile({
  value,
  label,
  detail,
  accent,
}: {
  value: number | string
  label: string
  detail: string
  accent?: boolean
}) {
  return (
    <div className={`tile${accent ? ' tile--accent' : ''}`}>
      <span className="tile__value">{value}</span>
      <span className="tile__label">{label}</span>
      <span className="tile__detail">{detail}</span>
    </div>
  )
}

/* ---- transcript source ------------------------------------------- */

function Sourcebar({
  system,
  onSystem,
  own,
  onOwn,
  onSource,
}: {
  system: SystemId
  onSystem: (id: SystemId) => void
  own: boolean
  onOwn: (turns: AnalysedTurn[] | null) => void
  onSource: (source: Source | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  /* the same transcript format the live view reads: one turn per block, and a
     turn that already carries its tags is taken as it is */
  const loaded = useMemo(() => parseTranscript(text), [text])

  async function load(file: File | undefined | null) {
    if (!file) return
    const result = await readTextFile(file)
    if (result.error) {
      setError(result.error)
      return
    }
    setText(result.text)
    setFileName(file.name)
    setError(null)
  }

  async function run() {
    if (!loaded.length || busy) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setBusy(true)
    setError(null)
    setProgress({ done: 0, total: loaded.length })
    try {
      const collected: AnalysedTurn[] = []
      let source: Source = 'precomputed'
      for (const turn of loaded) {
        if (turn.tagged !== undefined) {
          collected.push({ index: turn.index, speaker: turn.speaker, tagged: turn.tagged })
          source = 'file'
        } else {
          const result = await annotate(turn.text, 'all', controller.signal)
          source = result.source
          collected.push({ index: turn.index, speaker: turn.speaker, tagged: result.tagged })
        }
        setProgress({ done: turn.index + 1, total: loaded.length })
      }
      onOwn(collected)
      onSource(source)
      setOpen(false)
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') {
        setError(noticeOf(cause))
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="sourcebar">
      <div className="sourcebar__row">
        <span className="sourcebar__label">Transcript</span>
        <button
          type="button"
          className={`toggle${!own ? ' is-on' : ''}`}
          onClick={() => {
            onOwn(null)
            onSource(null)
          }}
        >
          Bundled excerpt
        </button>
        <button type="button" className={`toggle${own ? ' is-on' : ''}`} onClick={() => setOpen((value) => !value)}>
          {own ? 'Your transcript' : 'Load a .txt'}
        </button>
      </div>

      <div className="sourcebar__row">
        <span className="sourcebar__label">Analyse output of</span>
        {SYSTEMS.map((spec) => (
          <button
            key={spec.id}
            type="button"
            className={`toggle${system === spec.id ? ' is-on' : ''}`}
            onClick={() => onSystem(spec.id)}
            disabled={own}
            title={own ? 'Your own transcript is annotated by the configured backend only' : spec.tagline}
          >
            {spec.name}
          </button>
        ))}
      </div>

      {open && (
        <div className="sourcebar__load">
          <FileDrop
            fileName={fileName}
            title="Drop a .txt transcript here"
            hint={
              fileName
                ? `${loaded.length} turn${loaded.length === 1 ? '' : 's'} · one per block`
                : 'Plain text, one turn per block separated by a blank line, up to 400 KB'
            }
            onFile={load}
          />
          <div className="sourcebar__actions">
            <span className="sourcebar__hint">
              {progress
                ? `Annotating turn ${progress.done} of ${progress.total}…`
                : 'Each turn is annotated on its own, then the views are recomputed.'}
            </span>
            <button type="button" className="btn btn--accent" onClick={run} disabled={busy || !loaded.length}>
              {busy ? 'Annotating…' : 'Annotate & analyse'}
            </button>
          </div>
          {error && <p className="sourcebar__error">{error}</p>}
        </div>
      )}
    </div>
  )
}
