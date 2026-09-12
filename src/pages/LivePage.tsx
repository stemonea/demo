import { memo, useMemo, useState } from 'react'
import HoverTag from '../components/HoverTag'
import TaggedText from '../components/TaggedText'
import TagLegend from '../components/TagLegend'
import LayerSwitch from '../components/LayerSwitch'
import SourceBadge from '../components/SourceBadge'
import VerdictBadge from '../components/VerdictBadge'
import ExportMenu from '../components/ExportMenu'
import FileDrop from '../components/FileDrop'
import TurnLoader from '../components/TurnLoader'
import LiveStats from '../components/LiveStats'
import { readTextFile } from '../lib/textFile'
import {
  countAnnotated,
  FORMAT_RULES,
  FORMAT_SAMPLE,
  parseTranscript,
  type FeedTurn,
} from '../lib/transcript'
import { useFeed, useSteadyScroll } from '../lib/feed'
import { useAnnotationPipeline, type PipelineStatus } from '../lib/pipeline'
import { useLiveSession } from '../lib/liveSession'
import {
  ApiError,
  liveDebateSupported,
  startLiveDebate,
  type LiveTurnPayload,
  type Source,
} from '../lib/api'
import { checkNesting } from '../lib/wellformed'
import { DEMO, DEMO_PACE, DEMO_TRANSCRIPT } from '../config/backend'
import { demoAnnotator, loadDemoTranscript, withheldAnnotations } from '../lib/demo'
import type { LayerView } from '../lib/view'
import './LivePage.css'

/**
 * Turns computed before the first one is shown: one.
 *
 * Nothing is batched - a turn is an answer as soon as the tagger has finished
 * it, and that is when it goes on screen. Waiting for a handful of them before
 * showing anything is a blank screen for as many generations as the handful is
 * long, which is precisely the wait this view exists to make visible.
 */
const WARMUP = 1
/** How far past the visible turn the workers may run. */
const LOOK_AHEAD = 6

/**
 * A loaded debate, and how it is being annotated.
 *
 * `session` is what makes the feed live: the transcript was uploaded to the
 * service, which is annotating it and pushing each turn as it finishes. Without
 * one - no service configured, or a service that could not be reached - the
 * debate is replayed the way it always was, one request per turn, which is what
 * keeps a fully annotated transcript playable with nothing running at all.
 */
interface Loaded {
  turns: FeedTurn[]
  fileName: string | null
  session: string | null
  /** what the service said about the file it accepted */
  warnings: string[]
}

/**
 * Turn-level streaming.
 *
 * The view opens on the intake screen: a debate has to be loaded before it can
 * be replayed, and the format it must have is stated there. Once a transcript is
 * in, the first turns are annotated, the feed starts, and the rest arrive behind
 * what the reader is looking at - pushed by the service when there is one.
 */
export default function LivePage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /* bumping this remounts the replay, which is what "restart" means here:
     one mount, one session, nothing of the previous run left behind */
  const [run, setRun] = useState(0)

  if (!loaded) {
    return (
      <Intake
        fileName={fileName}
        error={loadError}
        onLoad={(next) => {
          setLoaded(next)
          setFileName(next.fileName)
          setLoadError(null)
        }}
        onError={(message) => setLoadError(message)}
      />
    )
  }

  return (
    <Feed
      key={run}
      loaded={loaded}
      onNewFile={() => {
        /* a new debate is a new run: the replay is remounted rather than reset,
           so nothing of the previous session is left behind */
        setRun((value) => value + 1)
        setLoaded(null)
        setFileName(null)
      }}
    />
  )
}

/* ------------------------------------------------------------------ *
 * Intake - the transcript, and the format it has to have               *
 * ------------------------------------------------------------------ */

interface IntakeProps {
  fileName: string | null
  error: string | null
  onLoad: (loaded: Loaded) => void
  onError: (message: string) => void
}

function Intake({ fileName, error, onLoad, onError }: IntakeProps) {
  const [uploading, setUploading] = useState(false)

  /**
   * The transcript, on its way to being annotated.
   *
   * The file is checked here first, so an obvious mistake is answered without a
   * round trip, and then handed to the service, which checks it again - a
   * service must not trust the page that calls it - and starts annotating it.
   * A service that refuses the file says why, and that is what is shown. A
   * service that is not there at all is not a dead end: the debate is replayed
   * turn by turn instead, which is enough for a transcript that arrived
   * annotated.
   */
  /**
   * The debate the site ships with, played whatever was dropped.
   *
   * In demo mode the file is still asked for and still checked, because that is
   * the gesture the page is about - but what plays is the shipped transcript,
   * and the feed says so rather than letting anyone believe their own file was
   * annotated by something that is not there.
   */
  async function loadDemo() {
    setUploading(true)
    try {
      onLoad({
        turns: await loadDemoTranscript(),
        fileName: DEMO_TRANSCRIPT.name,
        session: null,
        warnings: []
      })
    } catch (cause) {
      onError((cause as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function load(file: File | undefined | null) {
    if (!file) return

    if (DEMO) {
      /* checked all the same, so an obvious mistake is still answered */
      const check = await readTextFile(file)
      if (check.error) {
        onError(check.error)
        return
      }
      await loadDemo()
      return
    }

    const result = await readTextFile(file)
    if (result.error) {
      onError(result.error)
      return
    }
    const parsed = parseTranscript(result.text)
    if (!parsed.length) {
      onError(`“${file.name}” has no non-empty line to annotate.`)
      return
    }

    if (!liveDebateSupported()) {
      onLoad({ turns: parsed, fileName: file.name, session: null, warnings: [] })
      return
    }

    setUploading(true)
    try {
      const started = await startLiveDebate(file, 'all')
      onLoad({
        turns: started.turns.map(toFeedTurn),
        fileName: started.file || file.name,
        session: started.session,
        warnings: started.warnings ?? [],
      })
    } catch (cause) {
      /* the service rejected the file: its reason is the one worth showing */
      if (cause instanceof ApiError && (cause.kind === 'http' || cause.kind === 'payload')) {
        onError(cause.hint || cause.message)
        return
      }
      /* the service is not there: replay it turn by turn, as before */
      onLoad({ turns: parsed, fileName: file.name, session: null, warnings: [] })
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="page">
      <div className="page__inner">
        <div className="live shell">
          <header className="live__head">
            <div>
              <span className="eyebrow">Streaming</span>
              <h1 className="display live__title"><HoverTag>Live debate</HoverTag></h1>
            </div>
            <p className="live__lead">
              The tagger operates at turn level, so a debate can be annotated while it unfolds. Load the transcript
              you want replayed: it is sent to the model, which starts annotating it straight away and pushes every
              turn as it finishes it.
            </p>
          </header>

          <div className="intake">
            <section className="intake__format">
              <h2 className="eyebrow">Required format</h2>
              <ul className="intake__rules">
                {FORMAT_RULES.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
              <pre className="intake__sample">{FORMAT_SAMPLE}</pre>
            </section>

            <section className="intake__drop">
              <FileDrop
                fileName={fileName}
                title={uploading ? 'Sending the transcript…' : 'Drop the debate transcript here'}
                hint="Plain .txt, a blank line between turns, up to 400 KB"
                onFile={load}
              />
              {uploading && <TurnLoader label="checking the transcript and opening the stream…" />}
              {error && <p className="live__error">{error}</p>}
            </section>
          </div>

          <TagLegend />
        </div>
      </div>
    </div>
  )
}

/**
 * One turn of the queue the service answered with. The annotation is left off on
 * purpose, even for the turns already computed: in a live session every
 * annotation arrives through the stream, so there is one path into the feed
 * instead of two.
 */
function toFeedTurn(turn: LiveTurnPayload): FeedTurn {
  return {
    id: `turn-${turn.index + 1}`,
    index: turn.index,
    speaker: turn.speaker,
    text: turn.text,
  }
}

/* ------------------------------------------------------------------ *
 * Feed - the replay itself                                            *
 * ------------------------------------------------------------------ */

interface FeedProps {
  loaded: Loaded
  onNewFile: () => void
}

function Feed({ loaded, onNewFile }: FeedProps) {
  const { fileName, session, warnings } = loaded
  const [view, setView] = useState<LayerView>('all')

  /* the open stream, when the service is annotating this debate for us */
  const live = useLiveSession(session)
  const { waitFor } = live
  /*
   * In the demonstration the markup is held back and given up one turn at a
   * time, so the pipeline has something to wait for and the run is visible:
   * the loader, the queue moving, the buffer filling. Everywhere else this is
   * the live session's own wait, or nothing at all.
   */
  const demo = useMemo(() => (DEMO ? withheldAnnotations(loaded.turns) : null), [loaded.turns])
  const turns = demo ? demo.turns : loaded.turns

  const annotateTurn = useMemo(() => {
    if (demo) return demoAnnotator(demo.annotations)
    return session ? (turn: FeedTurn) => waitFor(turn.index) : undefined
  }, [demo, session, waitFor])

  const pipeline = useAnnotationPipeline(turns, {
    warmup: WARMUP,
    lookAhead: LOOK_AHEAD,
    annotateTurn,
    /*
     * The demonstration runs one turn at a time on purpose.
     *
     * With a buffer running six turns ahead the work is always already done,
     * so the feed only ever pops finished turns and there is nothing to watch.
     * Held to one, the wait for the next turn is on screen - the loader says
     * which turn is being annotated, the queue shows it running - and the
     * rhythm of the feed becomes the rhythm of the generation, which is the
     * whole point of showing it live.
     */
    ...(demo
      ? { lookAhead: 1, concurrency: 1, msPerWord: 0, minPace: DEMO_PACE.holdMs, maxPace: DEMO_PACE.holdMs }
      : {}),
  })
  const { shown, status, annotated, buffered, active, error } = pipeline

  /* the feed follows the newest turn, and lets go the moment somebody scrolls
     back to read something */
  const { box: feedBox, onScroll: onFeedScroll, behind, jump: toEnd } = useFeed<HTMLDivElement>(shown.length)
  /* and the page under the feed keeps the reader's place while the figures on
     it fill in - the same correction the watcher's page has always had, which
     this one was simply left out of */
  const { scroller, content } = useSteadyScroll<HTMLDivElement, HTMLDivElement>()
  const fromFile = useMemo(() => countAnnotated(turns), [turns])

  /* everything shown so far, as one annotated transcript - what Export writes */
  const annotatedSoFar = shown.map((entry) => entry.tagged).join('\n')

  /* the same turns as the analytics read them; recomputed only when one lands */
  const analysed = useMemo(
    () => shown.map((entry) => ({ index: entry.index, speaker: entry.speaker, tagged: entry.tagged })),
    [shown],
  )
  const lastSource = shown.at(-1)?.source
  const activeSet = useMemo(() => new Set(active), [active])

  return (
    <div className="page" ref={scroller}>
      <div className="page__inner">
        <div className="live shell" ref={content}>
          {/* The first screen, and only it: the head, the transport and the
              debate. The box takes whatever the two above it leave, so a head
              that wraps to another line costs the debate a line rather than
              pushing its foot off the bottom of the window. */}
          <section className="live__screen">
            <header className="live__head">
              <div>
                <span className="eyebrow">Streaming</span>
                <h1 className="display live__title"><HoverTag>Live debate</HoverTag></h1>
              </div>
              <p className="live__lead">
                {fileName ? <strong>{fileName}</strong> : 'Transcript'} · {turns.length} turns.{' '}
                {session ? (
                  <>
                    The service is annotating it and pushing every turn as it finishes it - {live.received} of{' '}
                    {turns.length} have arrived, and each one appears here the moment it does.
                  </>
                ) : fromFile === turns.length ? (
                  <>
                    Every turn arrived annotated in the file, so the feed replays it without calling the service - the
                    pacing, the buffer and the panels behave exactly as they do on a live run.
                  </>
                ) : (
                  <>
                    Each turn is computed and shown one at a time, and the ones behind it are computed while you read.
                  </>
                )}{' '}
                Each turn is held long enough to be read.
              </p>
              {warnings.length > 0 && (
                <ul className="live__warnings">
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </header>

            <div className="live__bar">
              <div className="live__transport">
                <button
                  type="button"
                  className="btn btn--accent live__play"
                  onClick={() => pipeline.setPlaying(!pipeline.playing)}
                  disabled={status === 'done' || status === 'error'}
                >
                  {pipeline.playing ? 'Pause' : shown.length ? 'Resume' : 'Play'}
                </button>
                <button type="button" className="toggle" onClick={onNewFile}>
                  New file
                </button>
              </div>
              <div className="live__right">
                <LayerSwitch value={view} onChange={setView} />
                {session && <LiveBadge status={live.status} complete={live.complete} />}
                <Progress status={status} shown={shown.length} annotated={annotated} total={turns.length} />
              </div>
            </div>

            <div className="live__grid">
              {/* Left: what to do with the debate, then what is still coming.
                  Right: the debate itself, which is what the screen is for and so
                  gets the room. What it adds up to is in the band underneath. */}
              <aside className="live__side">
                <section className="live__panel live__panel--export">
                  {session && (
                    <div className="keep">
                      <h2 className="eyebrow">Keep this debate</h2>
                      <p className="keep__text">
                        The service is holding the annotation of every turn it has computed - the whole debate, not
                        only what has gone by here.
                      </p>
                      <p className="keep__note">
                        {live.complete
                          ? 'All turns annotated.'
                          : `${live.received} of ${turns.length} annotated so far - exporting again later gets the rest.`}
                      </p>
                    </div>
                  )}
                  {/* Every way out of this page is one row of buttons.
                      There used to be a download of its own above this - the
                      service's own transcript - which made two places to save
                      the same debate from, one of them a large coloured button
                      that read as the way and left the four formats under it
                      looking like something else. One row, and `Plain text` in
                      it is the transcript that button was for.
                      ExportMenu writes its own label, so this panel does not */}
                  <ExportMenu tagged={annotatedSoFar} filename="live-session" />
                  {lastSource && <SourceBadge source={shownSource(lastSource)} />}
              </section>

              <section className="live__panel live__panel--queue">
                <h2 className="eyebrow">Queue · {shown.length} of {turns.length}</h2>
                <ol className="queue" data-scroll>
                  {turns.map((turn, i) => (
                    <QueueRow key={turn.id} turn={turn} state={queueState(i, shown.length, activeSet, buffered)} />
                  ))}
                </ol>
              </section>
            </aside>

            <div className="live__feed" data-scroll ref={feedBox} onScroll={onFeedScroll}>
              {shown.map((entry) => (
                <Turn
                  key={entry.id}
                  speaker={entry.speaker}
                  tagged={entry.tagged}
                  source={entry.source}
                  elapsedMs={entry.elapsedMs}
                  view={view}
                />
              ))}

              {(status === 'warming' || status === 'waiting') && (
                <TurnLoader label={`annotating turn ${shown.length + 1} of ${turns.length}…`} />
              )}
              {status === 'error' && (
                <div className="live__error">
                  <p>{error}</p>
                  <button type="button" className="toggle" onClick={pipeline.retry}>
                    Retry
                  </button>
                </div>
              )}

              {behind > 0 && (
                <button type="button" className="catchup" onClick={toEnd}>
                  {behind} new {behind === 1 ? 'turn' : 'turns'} ↓
                </button>
              )}
            </div>
          </div>
          </section>

          {/* Under the debate and clear of it: a section of its own, with its
              own heading, so the totals are plainly a second thing to read
              rather than more of the same box. */}
          <LiveStats turns={analysed} />

          <TagLegend />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Small pieces                                                        *
 * ------------------------------------------------------------------ */

/**
 * What the badge over a turn says.
 *
 * In the demonstration every answer is the transcript's own annotation, played
 * back - `from the file`. The live view is meant to read the same way whether
 * or not there is a service behind it, so here it is badged as the service's
 * answer, which is what the same page says with the demo off.
 */
function shownSource(source: Source): Source {
  return source === 'file' ? 'backend' : source
}

/**
 * One turn of the debate, memoised on what it is made of.
 *
 * A turn already on screen never changes: its words were annotated once and
 * that was that. But every new turn re-renders the feed, so two hundred turns
 * of tagged markup were being rebuilt to add one - which is the work that
 * makes a long replay stutter. The props are the fields rather than the turn
 * object, so a re-created object with the same content still compares equal.
 */
const Turn = memo(function Turn({
  speaker,
  tagged,
  source,
  elapsedMs,
  view,
}: {
  speaker: string
  tagged: string
  source: Source
  elapsedMs: number
  view: LayerView
}) {
  /* what came back, read as structure rather than as words: a turn whose tags
     cross or never close is annotated in name only, and the feed says so on the
     turn itself instead of letting it pass as an answer */
  const nesting = checkNesting(tagged)

  return (
    <article className="turn">
      <header className="turn__head">
        <span className="turn__speaker">{speaker}</span>
        <span className="turn__meta">
          {nesting.verdict && <VerdictBadge verdict={nesting.verdict} note={nesting.note} />}
          <SourceBadge source={shownSource(source)} elapsedMs={elapsedMs} />
        </span>
      </header>
      <TaggedText text={tagged} view={view} />
    </article>
  )
})

/** One line of the queue: only the one whose state changed need re-render. */
const QueueRow = memo(function QueueRow({ turn, state }: { turn: FeedTurn; state: string }) {
  return (
    <li className={`queue__item ${state}`}>
      <span className="queue__speaker">{turn.speaker}</span>
      <span className="queue__text">{turn.text}</span>
    </li>
  )
})

/** Whether the stream is open, so a dropped connection is visible, not silent. */
function LiveBadge({ status, complete }: { status: ReturnType<typeof useLiveSession>['status']; complete: boolean }) {
  const state = complete ? 'complete' : status
  const label =
    state === 'complete' ? 'fully annotated' : state === 'open' ? 'live' : state === 'error' ? 'reconnecting' : 'closed'
  return (
    <span className={`live-badge live-badge--${state}`} title="The service pushes each turn as it annotates it">
      <span className="live-badge__dot" aria-hidden="true" />
      {label}
    </span>
  )
}

const STATUS_LABEL: Record<PipelineStatus, string> = {
  idle: 'idle',
  warming: 'warming up',
  streaming: 'streaming',
  waiting: 'waiting for the service',
  paused: 'paused',
  error: 'stopped',
  done: 'complete',
}

function Progress({
  status,
  shown,
  annotated,
  total,
}: {
  status: PipelineStatus
  shown: number
  annotated: number
  total: number
}) {
  return (
    <span className="live__progress">
      <span className={`live__status live__status--${status}`}>
        {STATUS_LABEL[status]}
      </span>
      {shown} shown · {annotated} annotated · {total} turns
    </span>
  )
}

/** What the reader cannot see: turns already computed, and requests in flight. */
function queueState(index: number, shown: number, active: Set<number>, buffered: number): string {
  if (index < shown) return 'is-done'
  if (active.has(index)) return 'is-running'
  if (index < shown + buffered) return 'is-ready'
  return ''
}
