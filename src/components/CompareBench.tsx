import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FileDrop from './FileDrop'
import HoverTag from './HoverTag'
import LayerSwitch from './LayerSwitch'
import TurnLoader from './TurnLoader'
import TurnBand, { type TurnRow } from './TurnBand'
import { SYSTEMS, type SystemId } from '../data/systems'
import { TRANSCRIPT } from '../data/fixtures'
import { readTextFile } from '../lib/textFile'
import { parseTranscript, type FeedTurn } from '../lib/transcript'
import { annotateAcross, replayAcross, type SystemRun } from '../lib/api'
import { noticeOf } from '../lib/failure'
import { DEMO } from '../config/backend'
import { ms } from '../lib/duration'
import type { LayerView } from '../lib/view'
import './CompareBench.css'

/**
 * One turn, three systems, one clock each - and the reader holding the trigger.
 *
 * The "Double" page answers the same question by working a whole transcript
 * through on its own; this is the same measurement made by hand. Nothing is
 * computed until Compare is pressed, and when a file has been loaded nothing
 * further is computed until Next is. That is the point rather than a
 * limitation: a run that advances by itself puts the reader in front of a queue
 * they cannot stop on the row they wanted to read, and the row is the whole
 * finding - three annotations of one turn, and what each of them cost.
 *
 * The turns are always done one at a time and in order. Three systems racing
 * each other through a queue would be three systems contending for one machine,
 * and the three numbers on a row would then measure the contention rather than
 * the work.
 */

/** A pause that can be called off, so leaving the slide does not leave a timer. */
function wait(msToWait: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, msToWait)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * A turn on the bench right now.
 *
 * `generating` is the system whose column is still producing: one system id
 * while a demonstration build reveals them in turn, `'all'` while a service is
 * answering the three of them in one call, and null in the beat between two
 * systems.
 */
interface Live {
  turn: FeedTurn
  runs: Partial<Record<SystemId, SystemRun>>
  generating: SystemId | 'all' | null
}

/** Where the text under test came from, which is what the bench says it is. */
type SourceKind = 'typed' | 'file'

interface Loaded {
  kind: SourceKind
  /** what is named on the bar; a typed turn has no file name to give */
  name: string | null
  turns: FeedTurn[]
}

export default function CompareBench() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [pass, setPass] = useState(0)

  const start = useCallback((next: Loaded) => {
    /* a new subject is a new measurement: the run is remounted rather than
       reset, so no half-finished timing survives into the next one */
    setPass((value) => value + 1)
    setLoaded(next)
  }, [])

  if (!loaded) return <Intake onStart={start} />

  return <Run key={pass} loaded={loaded} onReset={() => setLoaded(null)} />
}

/* ------------------------------------------------------------------ *
 * The door: a turn typed, or a transcript dropped                      *
 * ------------------------------------------------------------------ */

function Intake({ onStart }: { onStart: (loaded: Loaded) => void }) {
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * A dropped transcript, checked here before anything is sent.
   *
   * With no service behind the site the only turns that have three answers are
   * the four the paper reports, so those are what the bench runs - said
   * plainly, and with the dropped file still read and checked, because loading
   * a transcript is the gesture this screen is about and skipping it would be
   * demonstrating something else.
   */
  async function load(file: File | undefined | null) {
    if (!file) return
    setReading(true)
    setError(null)
    try {
      const result = await readTextFile(file)
      if (result.error) {
        setError(result.error)
        return
      }
      const parsed = parseTranscript(result.text)
      if (!parsed.length) {
        setError(`There is nothing to annotate in “${file.name}”. A transcript has one turn per line, as “SPEAKER: what they said”.`)
        return
      }
      setFileName(file.name)

      /*
       * On a demonstration build the bench always runs the turns the paper
       * reports, whatever was dropped on it.
       *
       * The file is still read and checked, because loading a transcript is the
       * gesture this screen is about and skipping it would be demonstrating
       * something else. What it is not is announced: a banner explaining that
       * the page is a simulation is the page talking about itself instead of
       * working. The claim is made where it can be checked - on each cell, next
       * to the figure it qualifies.
       */
      if (DEMO) {
        onStart({ kind: 'file', name: file.name, turns: bundledTurns() })
        return
      }

      onStart({ kind: 'file', name: file.name, turns: parsed })
    } finally {
      setReading(false)
    }
  }

  function compareTyped() {
    const trimmed = text.trim()
    if (!trimmed) return
    const parsed = parseTranscript(trimmed)
    onStart({
      kind: 'typed',
      name: null,
      /* one turn, whatever was pasted: a block with no speaker prefix is still
         a turn, and the parser is what decides where one ends */
      turns: parsed.length ? [parsed[0]] : [{ id: 'typed', index: 0, speaker: '', text: trimmed }],
    })
  }

  return (
    <div className="bench bench--intake shell">
      {/* the site's heading: what it is on the left, what it does on the right */}
      <header className="bench__head">
        <div>
          <span className="eyebrow">Three systems, three clocks</span>
          <h2 className="display bench__title">
            <HoverTag>Run one turn through all three</HoverTag>
          </h2>
        </div>
        <p className="bench__lead">
          Type a turn or drop a transcript, then press Compare. Each system annotates the same turn on its own, in
          order, and reports what it spent. A transcript advances one turn at a time, on your word.
        </p>
      </header>

      <div className="bench__doors">
        <section className="bench__door">
          <h3 className="eyebrow">Write a turn</h3>
          <textarea
            className="bench__input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            rows={5}
            placeholder="SPEAKER: type or paste one debate turn here…"
            aria-label="Turn to compare"
          />
          <div className="bench__door-foot">
            <span className="bench__chars">{text.trim().length} characters</span>
            <button type="button" className="btn btn--accent" onClick={compareTyped} disabled={!text.trim()}>
              Compare
            </button>
          </div>
        </section>

        <section className="bench__door">
          <h3 className="eyebrow">Or load a transcript</h3>
          <FileDrop
            fileName={fileName}
            title="Drop the debate transcript here"
            accept=".txt,text/plain"
            hint="a blank line between every turn"
            onFile={load}
          />
          {reading && <TurnLoader label="reading the transcript…" />}
          {/* the terms live down here rather than inside the box, so this door
              has the same foot as the one beside it and the two drop areas end
              on the same line */}
          <div className="bench__door-foot">
            <span className="bench__chars">plain .txt · up to 400 KB</span>
          </div>
        </section>
      </div>

      {error && <p className="bench__error">{error}</p>}
    </div>
  )
}

function bundledTurns(): FeedTurn[] {
  return parseTranscript(TRANSCRIPT.map((turn) => turn.text).join('\n\n'))
}

/* ------------------------------------------------------------------ *
 * The bench: one turn at a time, on the reader's word                  *
 * ------------------------------------------------------------------ */

function Run({ loaded, onReset }: { loaded: Loaded; onReset: () => void }) {
  const [rows, setRows] = useState<TurnRow[]>([])
  /**
   * The turn being generated, filling in as its systems answer.
   *
   * It is state rather than a flag because the three columns do not finish
   * together: on a demonstration build each one is revealed as its own modelled
   * time elapses, so the row is on screen and half-built while the rest of it is
   * still coming. `generating` is the one still working, and its cell shows the
   * field of symbols instead of an answer.
   */
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<LayerView>('all')
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const abort = useRef<AbortController | null>(null)

  const total = loaded.turns.length
  const busy = live !== null
  const doneAll = rows.length >= total && !busy

  /**
   * One turn, and only that one.
   *
   * The controller belongs to the run rather than to the component, and every
   * write back into state is guarded on it still being the current one. That is
   * what makes an abandoned run silent instead of destructive: React runs an
   * effect, tears it down and runs it again on mount, so the first turn is
   * always started twice and cancelled once, and a run that checked only
   * "was I aborted" would leave the bench believing it was still generating for
   * ever - which is exactly what it did.
   */
  const run = useCallback(
    async (index: number, controller: AbortController) => {
      const turn = loaded.turns[index]
      if (!turn) return
      const current = () => abort.current === controller && !controller.signal.aborted

      setError(null)
      setLive({ turn, runs: {}, generating: null })

      try {
        if (DEMO) {
          /*
           * A build with nothing behind it replays the reported answers rather
           * than spending a timeout per turn learning that nobody is listening -
           * and then spends the time those answers are modelled to have taken.
           *
           * The wait is the demonstration. A row that appeared the instant it
           * was asked for would show three annotations and a table of durations
           * that nothing on screen ever took, which is a caption pretending to
           * be a measurement. Sitting through the figure, one system at a time
           * and each in its own column, is the flow the service actually has.
           */
          const result = replayAcross(turn.text)
          for (const system of SYSTEMS) {
            if (!current()) return
            setLive((was) => (was ? { ...was, generating: system.id } : was))
            await wait(result.runs[system.id]?.elapsedMs ?? 0, controller.signal)
            if (!current()) return
            setLive((was) =>
              was ? { ...was, runs: { ...was.runs, [system.id]: result.runs[system.id] }, generating: null } : was,
            )
          }
          if (!current()) return
          setRows((existing) => [...existing, { turn, runs: result.runs }])
          setLive(null)
          return
        }

        /* against a service the three are answered in one call, so all three are
           working until it returns */
        setLive((was) => (was ? { ...was, generating: 'all' } : was))
        const result = await annotateAcross(turn.text, 'all', controller.signal)
        if (!current()) return
        setRows((existing) => [...existing, { turn, runs: result.runs }])
        setLive(null)
      } catch (cause) {
        if (!current()) return
        setError(noticeOf(cause))
        setLive(null)
      }
    },
    [loaded.turns],
  )

  /** Starts the turn after the last one that landed, cancelling anything in flight. */
  const runNext = useCallback(() => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    void run(rows.length, controller)
  }, [run, rows.length])

  /*
   * The first turn is what Compare was pressed for, so it goes without being
   * asked for again. The controller is the effect's own, so the teardown React
   * performs on mount cancels this run and the re-run starts a clean one - the
   * bench is never left holding a cancelled turn.
   */
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    /* started just after the commit that mounted the bench, so the run's first
       write lands in a render of its own rather than inside this one */
    const kick = setTimeout(() => void run(0, controller), 0)
    return () => {
      clearTimeout(kick)
      controller.abort()
    }
  }, [run])

  /* what the pass has cost each system so far. Turns nobody timed are left out
     rather than counted as zero: "not measured" and "took no time" are not the
     same claim, and averaging the second into the first would invent a figure. */
  const totals = useMemo(
    () =>
      SYSTEMS.map((system) => {
        const times = rows
          .map((row) => row.runs[system.id]?.elapsedMs)
          .filter((value): value is number => typeof value === 'number')
        const sum = times.reduce((carried, value) => carried + value, 0)
        return { system, timed: times.length, total: sum, mean: times.length ? sum / times.length : null }
      }),
    [rows],
  )

  return (
    <div className="bench bench--run shell">
      <header className="bench__bar">
        <span className="bench__subject" title={loaded.name ?? undefined}>
          {loaded.kind === 'file' ? loaded.name : 'your turn'}
        </span>
        <span className="bench__progress">
          {rows.length} / {total} {total === 1 ? 'turn' : 'turns'}
          {doneAll && <span className="bench__state">done</span>}
        </span>
        <span className="bench__tools">
          <LayerSwitch value={view} onChange={setView} />
          <button
            type="button"
            className={`toggle${mode === 'raw' ? ' is-on' : ''}`}
            onClick={() => setMode((value) => (value === 'raw' ? 'rendered' : 'raw'))}
            aria-pressed={mode === 'raw'}
          >
            Raw
          </button>
          {total > 1 && (
            <button type="button" className="toggle" onClick={() => void runNext()} disabled={busy || doneAll}>
              Next turn →
            </button>
          )}
          <button type="button" className="toggle" onClick={onReset}>
            New subject
          </button>
        </span>
      </header>

      {error && <p className="bench__error">{error}</p>}

      {/* One panel: the three names, the turns under them, and what the pass has
          cost at its foot. Three separate blocks would read as three unrelated
          strips; the comparison is one object. */}
      <div className="bench__panel">
        <div className="bench__columns">
          {SYSTEMS.map((system) => (
            <div className={`bench__column bench__column--${system.kind}`} key={system.id}>
              <span className="bench__name">{system.name}</span>
              <span className="bench__flow">{system.flow.join(' → ')}</span>
            </div>
          ))}
        </div>

        <div className="bench__rows" data-scroll>
          {rows.map((row) => (
            <TurnBand key={row.turn.id} row={row} view={view} mode={mode} numbered={total > 1} />
          ))}

          {live && (
            <TurnBand
              row={live}
              view={view}
              mode={mode}
              numbered={total > 1}
              generating={live.generating}
            />
          )}

          {!busy && !doneAll && rows.length > 0 && (
            <button type="button" className="bench__next" onClick={() => void runNext()}>
              Run turn {rows.length + 1} of {total} →
            </button>
          )}
        </div>

        <footer className="bench__totals">
          {totals.map(({ system, timed, total: sum, mean }) => (
            <span className="bench__total" key={system.id}>
              <span className="bench__total-name">{system.name}</span>
              {mean === null ? (
                <span className="band__unmeasured">not measured</span>
              ) : (
                <>
                  <strong>{ms(mean)}</strong>
                  <span className="bench__total-of">
                    per turn · {ms(sum)} over {timed}
                  </span>
                </>
              )}
            </span>
          ))}
        </footer>
      </div>
    </div>
  )
}
