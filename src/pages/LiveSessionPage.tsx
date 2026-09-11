import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import HoverTag from '../components/HoverTag'
import TaggedText from '../components/TaggedText'
import TagLegend from '../components/TagLegend'
import LayerSwitch from '../components/LayerSwitch'
import SourceBadge from '../components/SourceBadge'
import ExportMenu from '../components/ExportMenu'
import LiveStats from '../components/LiveStats'
import PollBoard from '../components/PollBoard'
import PollVote from '../components/PollVote'
import { useRecorder } from '../lib/recorder'
import { annotate, closeRoom, openRoom, transcribe, ApiError, type Source } from '../lib/api'
import { simulatedFloor } from '../lib/audience'
import { DEMO } from '../config/backend'
import { loadDemoTranscript } from '../lib/demo'
import {
  arguedIn,
  clockFor,
  clockParam,
  fedPace,
  isReplaySession,
  newReplaySession,
  readClock,
} from '../lib/replaySession'
import { SPEAKER_PREFIX, type FeedTurn } from '../lib/transcript'
import { useFeed, useSteadyScroll } from '../lib/feed'
import {
  isLocalSession,
  newLocalSession,
  usePublishRun,
  useWatchRun,
  type Published,
  type WatchTurn,
} from '../lib/localSession'
import { linkTo, useHashParam } from '../lib/route'
import type { LayerView } from '../lib/view'
import './LiveSessionPage.css'

/*
 * The QR encoder is fetched only when there is a room worth pointing a phone
 * at, which in a published demonstration is never: that build has no service to
 * hold a room, so the code is never drawn and the encoder is never asked for.
 * Ten kilobytes is not much, but it is ten kilobytes of Reed-Solomon that the
 * common case has no use for, and the transcript is kept out of the bundle for
 * the same reason.
 */
const QrCode = lazy(() => import('../components/QrCode'))

/** The floor as it opens: two sides and a chair, all of them renameable. */
const OPENING_FLOOR = ['MODERATOR', 'SPEAKER A', 'SPEAKER B']

/** The beat a turn is held for, as a promise rather than as a timer. */
const held = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One turn as it was spoken, transcribed and annotated. */
interface SpokenTurn {
  id: string
  index: number
  speaker: string
  /** what was heard */
  text: string
  /** what came back from the annotator, `SPEAKER: <claim>…` */
  tagged: string
  seconds: number
  source: Source
  elapsedMs: number
}

/** Where a turn is between the microphone closing and the annotation landing. */
type Phase = 'idle' | 'recording' | 'transcribing' | 'annotating'

/**
 * The longest of a set of labels, by characters.
 *
 * Characters rather than pixels: every label these reserve space for is set in
 * the same face at the same size and tracking, so the count orders them the way
 * the type does, and counting needs no measuring pass and no layout to read.
 */
const widest = (labels: readonly string[]) =>
  labels.reduce((longest, label) => (label.length > longest.length ? label : longest), '')

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'ready',
  recording: 'listening',
  transcribing: 'transcribing',
  annotating: 'annotating',
}

/**
 * The phases this build can actually reach.
 *
 * Only a session with a microphone behind it records and transcribes; a played
 * debate is either waiting or being annotated. The badge below reserves room
 * for the longest word it can show, so reserving room for words this build will
 * never show is a badge that sits half empty for the whole debate.
 */
const PHASES_SHOWN: readonly Phase[] = DEMO
  ? ['idle', 'annotating']
  : ['idle', 'recording', 'transcribing', 'annotating']

/**
 * The longest of those, drawn and hidden behind whichever one is current.
 *
 * The badge used to be as wide as the word in it, and the word changes on every
 * turn: `ready` is five characters and `annotating` is ten, so the badge grew
 * by twenty-six pixels the moment a turn started being worked on. That was
 * enough to wrap the bar it sits in onto a second line, which made the bar
 * fifty-three pixels taller, which pushed the debate below it down - and then
 * back up again when the turn landed. Twice a turn, for the whole debate.
 *
 * Taken from the labels rather than written out, so a phase added later cannot
 * quietly reintroduce it.
 */
const LONGEST_PHASE = widest(PHASES_SHOWN.map((phase) => PHASE_LABEL[phase]))

/**
 * `#/livesession?session=…` is the same view with nothing to run.
 *
 * A room watching a debate belongs here rather than on the replay: the other
 * live view is given a transcript of something that already happened, and an
 * audience cannot take a side on a recording as it goes by. Here the debate is
 * happening - so there is a floor for people to watch, and something for them
 * to say back.
 */
export default function LiveSessionPage() {
  const watching = useHashParam('session')
  /*
   * A replayed room carries its clock beside its id rather than inside it.
   *
   * The two are addressed separately because they change at different moments:
   * the id is the thing votes are counted against and must survive the debate
   * being paused, and the clock is re-issued every time it is. Put the clock in
   * the id and stopping to explain a turn would empty the floor.
   */
  const clock = useHashParam('t')
  return watching ? <Watching session={watching} startedAt={readClock(clock)} /> : <Session />
}

/**
 * One turn of the debate, drawn once and then left alone.
 *
 * A turn that has landed never changes again, and yet every one of them used to
 * be rebuilt whenever the next arrived: the relay hands the watcher the whole
 * run on each message, so every object in the feed is a new object and React
 * has no way of knowing that two hundred of them say exactly what they said a
 * moment ago. On a long debate that is the stutter - the work grows with the
 * transcript, so the feed gets heavier the longer somebody watches.
 *
 * The props are the words themselves rather than the turn they came in, so the
 * comparison is on strings and numbers and holds however the turn was
 * delivered. `TaggedText` is memoised for the same reason one layer down; this
 * is what stops the header, the badge and the reconciliation around it.
 */
const Turn = memo(function Turn({
  speaker,
  tagged,
  source,
  elapsedMs,
  view,
  seconds,
}: {
  speaker: string
  tagged: string
  source: Source
  elapsedMs: number
  view: LayerView
  /** how long the turn was spoken for, where that is known */
  seconds?: number
}) {
  return (
    <article className="turn">
      <header className="turn__head">
        <span className="turn__speaker">{speaker}</span>
        <span className="turn__meta">
          {seconds !== undefined && <span className="turn__length">{seconds.toFixed(1)}s spoken</span>}
          <SourceBadge source={source} elapsedMs={elapsedMs} />
        </span>
      </header>
      <TaggedText text={tagged} view={view} />
    </article>
  )
})

/**
 * Who is standing, as against who is chairing.
 *
 * Not a guess about names: a moderator asks and does not assert, so the
 * annotation separates them by itself - the ballot opens as the speakers who
 * have actually made a claim or a premise, and whoever is running the session
 * corrects it in a click either way.
 */
/**
 * A debate as it is being spoken.
 *
 * The other live view replays a transcript that already exists; this one has no
 * transcript until someone talks. The microphone is opened for one speaker,
 * closed, and what was said is transcribed and annotated before the next person
 * starts - which is also how the speaker is known without any diarisation at
 * all. Whoever is running the session says who is about to talk, and a name can
 * be added at any point, because a debate acquires participants as it goes.
 */
function Session() {
  const [speakers, setSpeakers] = useState<string[]>(OPENING_FLOOR)
  const [current, setCurrent] = useState(OPENING_FLOOR[0])
  const [draft, setDraft] = useState('')
  /* a turn written rather than spoken */
  const [typed, setTyped] = useState('')
  /*
   * Whether the typing box is open.
   *
   * Speaking and typing are two ways of giving the same turn, and which one is
   * wanted changes from turn to turn: a debate followed from a broadcast is
   * typed, the person in the room is spoken, and one session has both. So the
   * box opens and closes at any point, beside a microphone that stays where it
   * is - the choice is made per turn, not per session.
   *
   * Closed to begin with all the same: standing open it took a fifth of the
   * first screen from the debate, which is what the screen is for.
   */
  const [typing, setTyping] = useState(false)
  const [turns, setTurns] = useState<SpokenTurn[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [view, setView] = useState<LayerView>('all')
  const [notice, setNotice] = useState<string | null>(null)
  /* the feed follows the newest turn, and lets go the moment somebody scrolls
     back to read something */
  const { box: feedBox, onScroll: onFeedScroll, behind, jump: toEnd } = useFeed<HTMLDivElement>(turns.length)
  /* and the page keeps its place while the blocks under the feed resize */
  const { scroller, content } = useSteadyScroll<HTMLDivElement, HTMLDivElement>()

  const recorder = useRecorder()
  const busy = phase === 'transcribing' || phase === 'annotating'

  /* ---- the floor --------------------------------------------------- */

  /**
   * A name is added and taken in one move: someone who was not expected has
   * started talking, and the point of typing their name is to record them, so
   * the microphone should be one press away and not two.
   */
  const addSpeaker = useCallback(
    (raw: string) => {
      const name = raw.trim().toUpperCase().replace(/\s+/g, ' ')
      if (!name) return
      if (/:/.test(name)) {
        setNotice('A speaker name cannot contain a colon - that is what separates the name from the turn.')
        return
      }
      setSpeakers((current) => (current.includes(name) ? current : [...current, name]))
      setCurrent(name)
      setDraft('')
      setNotice(null)
    },
    [],
  )

  function removeSpeaker(name: string) {
    /* a name that has already said something stays: the turns above carry it */
    if (turns.some((turn) => turn.speaker === name)) {
      setNotice(`${name} has already spoken, so the name stays with those turns.`)
      return
    }
    setSpeakers((list) => {
      const next = list.filter((item) => item !== name)
      if (name === current) setCurrent(next[0] ?? '')
      return next
    })
  }

  /* ---- the microphone ---------------------------------------------- */

  async function open() {
    setNotice(null)
    /* the microphone can be refused, and a page that says "listening" while it
       was refused is worse than one that says nothing */
    if (await recorder.open()) setPhase('recording')
    else setPhase('idle')
  }

  /**
   * Closing the microphone is what produces a turn: the recording is converted
   * to what the service accepts, transcribed, and the line that comes back is
   * annotated. The two steps are shown separately because they fail
   * differently - nothing heard is not the same as nothing annotated.
   */
  async function close() {
    let recording: Awaited<ReturnType<typeof recorder.close>>
    try {
      recording = await recorder.close()
    } catch (cause) {
      setPhase('idle')
      setNotice(`The recording could not be read: ${(cause as Error).message}`)
      return
    }

    if (!recording || recording.seconds < 0.25) {
      setPhase('idle')
      setNotice('That was too short to transcribe - hold the microphone open while the turn is spoken.')
      return
    }

    setPhase('transcribing')
    let heard: Awaited<ReturnType<typeof transcribe>>
    try {
      heard = await transcribe(recording.wav)
    } catch (cause) {
      setPhase('idle')
      setNotice(cause instanceof ApiError ? `${cause.message} ${cause.hint}` : (cause as Error).message)
      return
    }

    if (!heard.text) {
      setPhase('idle')
      setNotice('Nothing was heard in that recording. Check the input level and try the turn again.')
      return
    }

    /* the transcript format the whole tool reads: the speaker, then the turn */
    const line = `${current}: ${heard.text}`

    setPhase('annotating')
    try {
      const annotated = await annotate(line, 'all')
      setTurns((list) => [
        ...list,
        {
          id: `turn-${list.length}-${Date.now()}`,
          index: list.length,
          speaker: current,
          text: heard.text,
          tagged: annotated.tagged,
          seconds: recording.seconds,
          source: annotated.source,
          elapsedMs: heard.elapsedMs + annotated.elapsedMs,
        },
      ])
      setNotice(null)
    } catch (cause) {
      setNotice(
        cause instanceof ApiError
          ? `Heard “${heard.text}”, but it could not be annotated. ${cause.message} ${cause.hint}`
          : (cause as Error).message,
      )
    } finally {
      setPhase('idle')
    }
  }

  /**
   * The same turn, typed.
   *
   * Everything above needs a microphone and a transcription service, and there
   * are two ordinary reasons not to have both: a quiet room, and a machine
   * with nothing listening on it. A typed turn skips only the hearing - it is
   * annotated by the same call, attributed to the same speaker, and lands in
   * the same feed - so a session can be run, watched and voted on with a
   * keyboard alone.
   */
  async function say(text: string) {
    const said = text.trim()
    if (!said || busy) return

    /*
     * Where there is no service, a typed turn hands over the next turn of the
     * debate that shipped with the site, whatever was typed - the same gesture
     * the live page makes with a dropped file. The typing is not decoration:
     * it is what advances the debate, one turn per turn, which is exactly what
     * running a transcribed session by hand feels like.
     */
    if (DEMO) {
      setNotice(null)
      setTyped('')
      await stepScripted()
      return
    }

    if (!current) return

    setNotice(null)
    setPhase('annotating')
    try {
      const annotated = await annotate(`${current}: ${said}`, 'all')
      setTurns((list) => [
        ...list,
        {
          id: `turn-${list.length}-${Date.now()}`,
          index: list.length,
          speaker: current,
          text: said,
          tagged: annotated.tagged,
          seconds: 0,
          source: annotated.source,
          elapsedMs: annotated.elapsedMs,
        },
      ])
      setTyped('')
    } catch (cause) {
      setNotice(cause instanceof ApiError ? `${cause.message} ${cause.hint}` : (cause as Error).message)
    } finally {
      setPhase('idle')
    }
  }

  /* ---- a debate to run when there is nothing to speak to ----------- */

  /*
   * The demonstration, spoken by the file.
   *
   * The published build has no service behind it: nothing can be transcribed
   * and nothing can be annotated on demand, so this page would be a
   * microphone that leads nowhere. What it does have is a debate that shipped
   * with the site, every turn already carrying its markup - and fed in one at
   * a time, attributed to the speaker it was actually said by, that is enough
   * to run everything downstream of a turn: the floor fills, the totals move,
   * the link is live, and the room can vote on it.
   *
   * Nothing about it is disguised. The turns are marked as coming from the
   * file wherever a source is shown, and the panel says what it is doing
   * before it does any of it.
   */
  const [script, setScript] = useState<FeedTurn[] | null>(null)
  const [fed, setFed] = useState(0)
  /*
   * When this run started, or null while it has not.
   *
   * The one number a phone needs. Everything else it shows - which turns have
   * landed, which one is being worked on, who is on the ballot - it works out
   * for itself from the transcript this build ships and the pace in
   * `replaySession.ts`, because both sides of the code are running the same
   * function over the same file. So the room is not sent the debate: it is
   * sent the moment the debate began, and derives the rest.
   *
   * It is an origin in the past rather than a position, which is what makes it
   * survive being read late: somebody scanning at turn forty gets the whole
   * debate so far and then carries on live, with nothing to catch up on.
   */
  const [clock, setClock] = useState<number | null>(null)
  const [feeding, setFeeding] = useState(false)
  const [loading, setLoading] = useState(false)

  /**
   * The floor is handed over before the turn lands, not with it.
   *
   * That is the order a session actually goes in: whoever is running it says
   * who is about to talk, and only then is there anything to show. Doing both
   * at once would make the name and the words appear together, which is the
   * one moment of a live session that never looks like that.
   *
   * The three placeholders the floor opens with go when the first real name
   * arrives: a floor with SPEAKER A on it beside two people who are actually
   * talking is a floor nobody is reading.
   */
  const hand = useCallback((from: FeedTurn[], at: number) => {
    const next = from[at]
    if (!next) return
    setSpeakers((list) => {
      const kept = at === 0 ? list.filter((name) => !OPENING_FLOOR.includes(name)) : list
      return kept.includes(next.speaker) ? kept : [...kept, next.speaker]
    })
    setCurrent(next.speaker)
  }, [])

  const push = useCallback((from: FeedTurn[], at: number) => {
    const next = from[at]
    if (!next) return false

    const said = next.text.replace(SPEAKER_PREFIX, '').trim()
    const words = said.split(/\s+/).length
    setTurns((list) => [
      ...list,
      {
        id: `fed-${next.index}`,
        index: list.length,
        speaker: next.speaker,
        text: said,
        tagged: next.tagged ?? next.text,
        /* about the pace of speech, so the length of a turn reads as a length
           of time rather than as a zero nobody spoke for */
        seconds: words / 2.6,
        source: 'file',
        elapsedMs: 0,
      },
    ])
    setFed(at + 1)
    return true
  }, [])

  const load = useCallback(async (): Promise<FeedTurn[] | null> => {
    if (script) return script
    setLoading(true)
    try {
      const loaded = await loadDemoTranscript()
      setScript(loaded)
      return loaded
    } catch (cause) {
      setNotice((cause as Error).message)
      return null
    } finally {
      setLoading(false)
    }
  }, [script])

  /* whether there is any debate left to play, and whether it is playing:
     derived rather than set, so the end of the transcript is not a state
     change that has to be made from inside the timer */
  const moreToPlay = script === null || fed < script.length
  const playing = feeding && moreToPlay

  /**
   * Whether this turn can be given as text at all.
   *
   * The microphone and the box are two ways to the same turn, so they are never
   * both live at once: a turn being recorded is already being given. Where the
   * debate is the one that shipped with the site, the box runs out when the
   * transcript does, the same way the play button does.
   */
  const canSay =
    !busy &&
    recorder.phase !== 'recording' &&
    (DEMO ? moreToPlay : Boolean(current))

  /*
   * What the one button says, and everything it could say.
   *
   * The second list is what the button reserves room for. Written out beside
   * the label rather than derived from it, because they are the same decision:
   * a label added to the first without being added to the second brings the
   * jitter back, and here that is one line apart.
   */
  const micLabel = DEMO
    ? playing
      ? 'Pause'
      : loading
        ? 'Loading…'
        : !moreToPlay
          ? 'Finished'
          : fed
            ? 'Resume'
            : 'Play'
    : recorder.phase === 'recording'
      ? `Stop - ${current}`
      : busy
        ? PHASE_LABEL[phase]
        : `Record ${current || '…'}`

  /*
   * What the button reserves room for, where it needs to reserve any.
   *
   * Only the spoken session needs it: there the label is `Record MODERATOR`
   * between turns and the phase word while one is being worked on, so it
   * changes by itself on every turn and the bar re-wraps under it. A played
   * debate changes this label only when somebody presses it, or when the
   * transcript runs out - never while a turn lands - so there is nothing to
   * reserve against, and reserving anyway left `Play` floating in a button
   * built for `Loading…`.
   */
  const micSizer = DEMO
    ? widest(['Play', 'Pause', 'Resume', 'Loading…', 'Finished'])
    : widest([`Stop - ${current}`, `Record ${current || '…'}`, ...Object.values(PHASE_LABEL)])

  /*
   * One turn, then the wait its own length earns, then the next.
   *
   * The wait is spent the way a real one is: the turn is being worked on
   * while it is not there yet, so the panel at the foot of the feed says so
   * and the state above it moves, exactly as when somebody has just stopped
   * speaking. A turn that simply appeared would be a list being filled in;
   * this is a debate arriving.
   */
  useEffect(() => {
    if (!playing || !script) return
    const next = script[fed]
    if (!next) return

    const hold = fedPace(next.text)
    /* `setTimeout(…, 0)` rather than a call here: an effect synchronises with
       something outside React, it does not set state on its way past */
    const opens = setTimeout(() => {
      hand(script, fed)
      setPhase('annotating')
    }, 0)
    const lands = setTimeout(() => {
      push(script, fed)
      setPhase('idle')
    }, hold)

    return () => {
      clearTimeout(opens)
      clearTimeout(lands)
    }
  }, [playing, script, fed, hand, push])

  async function playDebate() {
    if (playing) {
      setFeeding(false)
      /* the turn that was in flight is not in flight any more: left as it was,
         the foot of the feed would go on saying it was being worked on for as
         long as the session stayed paused */
      setPhase('idle')
      return
    }
    setNotice(null)
    const loaded = await load()
    if (!loaded) return
    /* anchored so that the turn about to be played lands at the same instant
       here and on every phone: resuming after a pause re-issues it from
       wherever the run had got to, which is why the code is redrawn */
    setClock(clockFor(loaded, fed, Date.now()))
    setFeeding(true)
  }

  /**
   * One turn of that debate, taken by hand rather than by the timer.
   *
   * The turn is held for as long as the timer would have held it, so a session
   * driven from the keyboard has the same beat as one left to play: the floor
   * passes, the foot of the feed says the turn is being worked on, and then it
   * lands. What it does not do is touch the clock. The clock is the one thing
   * the room derives its own schedule from, and a run being stepped by hand has
   * no schedule to hand anybody - the phones follow a debate that is played,
   * which is what the play button is for.
   */
  async function stepScripted() {
    const from = script ?? (await load())
    if (!from) return
    const at = fed
    const next = from[at]
    if (!next) return

    /* a turn taken by hand takes the run over: the playback stops where it is
       rather than racing this step to the same index */
    setFeeding(false)
    hand(from, at)
    setPhase('annotating')

    await held(fedPace(next.text))
    push(from, at)
    setPhase('idle')
  }

  /* ---- what the session adds up to --------------------------------- */

  const analysed = useMemo(
    () => turns.map((turn) => ({ index: turn.index, speaker: turn.speaker, tagged: turn.tagged })),
    [turns],
  )
  const transcript = turns.map((turn) => turn.tagged).join('\n\n')

  /* ---- the room watching it ---------------------------------------- */

  /*
   * A session is shareable the moment it starts, and how far the link reaches
   * depends on whether there is a service to hold the room.
   *
   * With one, the room is minted on it: the link works from any device, which
   * is what makes it worth putting on a QR code for a room full of people.
   * Without one - the published demonstration - there is no session id to
   * borrow, so the room is local and relayed between tabs of this browser, and
   * the panel says so instead of offering a link that cannot travel.
   *
   * A service that will not mint one falls back to a local room rather than
   * leaving the session unshareable: the debate is not the room's, and losing
   * the audience must not cost the run.
   */
  const [room, setRoom] = useState(DEMO ? newReplaySession : newLocalSession)
  const [minting, setMinting] = useState(!DEMO)
  /* set when a service was configured and would not give us a room */
  const [roomFailed, setRoomFailed] = useState(false)
  /* this page is still on screen, and a room asked for is still wanted */
  const alive = useRef(true)
  const asked = useRef(false)

  const takeRoom = useCallback(() => {
    openRoom()
      .then((minted) => {
        if (!alive.current) return
        setRoom(minted)
        setRoomFailed(false)
      })
      .catch(() => {
        /* no room to be had. The debate is not the room's, so this falls back
           to relaying between tabs rather than leaving the session unshareable,
           and the panel says which of the two it ended up with */
        if (!alive.current) return
        setRoom(newLocalSession())
        setRoomFailed(true)
      })
      .finally(() => {
        if (alive.current) setMinting(false)
      })
  }, [])

  useEffect(() => {
    alive.current = true
    /* the local room the state was opened with is already the right one for a
       demonstration; anywhere else, one is asked of the service instead - once
       per run of this page, which `asked` is what holds under a double mount.
       `New room` is how another is deliberately taken. */
    if (!DEMO && !asked.current) {
      asked.current = true
      takeRoom()
    }
    return () => {
      alive.current = false
    }
  }, [takeRoom])

  /** A new room: a new link, an empty floor, and nobody watching yet. */
  const newRoom = useCallback(() => {
    setRoomFailed(false)
    /* the one being left is closed rather than left to time out. An empty floor
       is what "clears the votes" means, and a service still holding the old room
       would go on relaying this debate to anybody who kept the old link. */
    if (!isLocalSession(room) && !isReplaySession(room)) void closeRoom(room)
    if (DEMO) {
      /* a new room is a new floor, not a new debate: the clock belongs to the
         run and the run has not changed, so it carries over untouched */
      setRoom(newReplaySession())
      return
    }
    setMinting(true)
    takeRoom()
  }, [takeRoom, room])

  const relayed = useMemo(
    () =>
      turns.map<WatchTurn>((turn) => ({
        index: turn.index,
        speaker: turn.speaker,
        tagged: turn.tagged,
        source: turn.source,
        elapsedMs: turn.elapsedMs,
      })),
    [turns],
  )

  const arguing = useMemo(() => arguedIn(analysed), [analysed])
  /* null until whoever is running it says otherwise, and then it is theirs */
  const [chosen, setChosen] = useState<string[] | null>(null)
  const ballot = useMemo(
    () => (chosen ? chosen.filter((name) => speakers.includes(name)) : speakers.filter((name) => arguing.has(name))),
    [chosen, speakers, arguing],
  )

  /* a spoken debate has no length known in advance, and it is live for as long
     as somebody is running it */
  const reach = usePublishRun(room, relayed, 0, ballot, true, false)

  /*
   * The room the moderator is watching, when there is no service to hold one.
   *
   * Real votes cannot be pooled across devices on a build with nothing behind
   * it, so a board fed only by this browser would sit at one voter however many
   * phones had scanned in. The simulated floor is what puts a room on the chart
   * - derived, not received, and identical on every device because every device
   * computes it from the same id and the same turn count. It is labelled as
   * simulated on the board itself; see `lib/audience.ts`.
   */
  const crowd = useMemo(
    () => (isReplaySession(room) && clock !== null ? simulatedFloor(room, ballot, turns.length) : null),
    [room, clock, ballot, turns.length],
  )

  return (
    <div className="page" ref={scroller}>
      <div className="page__inner">
        <div className="session shell" ref={content}>
          {/* The first screen, and only it: the head, the floor, the
              microphone and the feed. The box takes whatever the blocks above
              it leave rather than a height worked out by subtracting a guess
              at them, so a name added to the floor or a notice appearing costs
              the feed a line instead of pushing its foot off the window. */}
          <section className="session__screen">
          <header className="session__head">
            <div>
              <span className="eyebrow">Live session</span>
              <h1 className="display session__title"><HoverTag>Speak the debate</HoverTag></h1>
            </div>
            {/* what the page in front of the reader actually does. An
                instruction to open a microphone, on a screen where the button
                says Play, is itself the tell - the mode does not have to be
                named for the mismatch to give it away. */}
            <p className="session__lead">
              {DEMO ? (
                <>
                  Select who is about to speak, then either open the microphone or enter the text manually.
                  Each turn is transcribed and annotated before the next one begins, and new speakers can be added at any point.
                </>
              ) : (
                <>
                  Select who is about to speak, then either open the microphone or enter the text manually.
                  Each turn is transcribed and annotated before the next one begins, and new speakers can be added at any point.
                </>
              )}
            </p>
          </header>

          {/* ---- the floor: who is talking, and who else is here ---- */}
          <section className="floor" aria-label="Speakers">
            <span className="floor__label">Speaking</span>

            <ul className="floor__list">
              {speakers.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className={`floor__who${name === current ? ' is-on' : ''}`}
                    onClick={() => setCurrent(name)}
                    disabled={recorder.phase === 'recording' || playing}
                    aria-pressed={name === current}
                    title={
                      recorder.phase === 'recording'
                        ? 'Close the microphone before changing speaker'
                        : playing
                          ? 'Pause the session before changing speaker'
                          : `Hand the floor to ${name}`
                    }
                  >
                    {name}
                    <span
                      className="floor__drop"
                      role="button"
                      tabIndex={-1}
                      title={`Remove ${name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        removeSpeaker(name)
                      }}
                    >
                      ×
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <form
              className="floor__add"
              onSubmit={(event) => {
                event.preventDefault()
                addSpeaker(draft)
              }}
            >
              <input
                className="floor__input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Add a speaker"
                aria-label="Add a speaker"
                maxLength={32}
                disabled={recorder.phase === 'recording' || playing}
              />
              <button
                type="submit"
                className="toggle"
                disabled={!draft.trim() || recorder.phase === 'recording' || playing}
              >
                Add
              </button>
            </form>
          </section>

          {/* ---- the microphone ------------------------------------- */}
          <section className="mic" aria-label="Microphone">
            {/*
              One button, and it is the one the page already had.
              
              Where the debate is being played rather than spoken there is
              nothing for a microphone to do, and a second control beside it
              announcing as much would be the machinery talking over the thing
              it is meant to be showing. So this button starts the session,
              whichever way the session gets its turns - and it looks and
              behaves the same either way, down to the light that says it is
              running.
            */}
            <button
              type="button"
              /* two different things, and only one of them is red: `is-live`
                 is a microphone that is actually open and listening to a room,
                 which is worth an alarm colour. A debate being played is simply
                 running - it keeps the tool's own colour and says so with the
                 light, the way every other running thing here does. */
              className={`mic__btn${
                recorder.phase === 'recording' ? ' is-live' : playing ? ' is-running' : ''
              }`}
              onClick={() => (DEMO ? void playDebate() : recorder.phase === 'recording' ? close() : open())}
              disabled={
                DEMO ? loading || !moreToPlay : busy || !current
              }
            >
              <span className="mic__dot" aria-hidden="true" />
              {/* The button holds the longest label it can ever show, and draws
                  the current one over it - the same reservation the phase badge
                  makes, and for the same reason: `Record MODERATOR` becoming
                  `annotating` and back on every turn was re-wrapping this bar
                  and shoving the debate up and down under it. */}
              <span className="mic__label">
                {micSizer && (
                  <span className="mic__label-sizer" aria-hidden="true">
                    {micSizer}
                  </span>
                )}
                <span className="mic__label-word">{micLabel}</span>
              </span>
            </button>

            {/* the level, so a speaker can see they are being heard before
                they trust a recording they cannot play back - there is no
                microphone open behind a played debate, and a meter sitting
                dead at zero says more about the machinery than about the
                debate, so it is simply not there */}
            {!DEMO && (
              <div className="mic__meter" role="presentation">
                <span className="mic__fill" style={{ width: `${Math.round(recorder.level * 100)}%` }} />
              </div>
            )}

            <span className="mic__state">
              <span className={`mic__phase mic__phase--${phase}`}>
                <span className="mic__phase-sizer" aria-hidden="true">
                  {LONGEST_PHASE}
                </span>
                <span className="mic__phase-word">{PHASE_LABEL[phase]}</span>
              </span>
              {recorder.phase === 'recording' && <span className="mic__clock">{recorder.seconds.toFixed(1)}s</span>}
              {recorder.phase === 'recording' && (
                <button type="button" className="toggle" onClick={() => { recorder.cancel(); setPhase('idle') }}>
                  Discard
                </button>
              )}
              {/* the way to the typing box, beside the microphone rather than
                  under it: the two are the same choice - how this turn gets
                  into the session - and only one of them needs the room */}
              <button
                type="button"
                className={`toggle${typing ? ' is-on' : ''}`}
                onClick={() => setTyping(!typing)}
                aria-expanded={typing}
                aria-controls="say-turn"
                title={typing ? 'Put the box away' : 'Type this turn instead of speaking it'}
              >
                {/* the label does not change when the box opens: this is the
                    control that says which of the two ways in is chosen, and a
                    button that renames itself to "Close" is a second dismissal
                    competing with the card's own - the selected state is what
                    says it is open */}
                Type the turn
              </button>
            </span>

            <span className="mic__right">
              <LayerSwitch value={view} onChange={setView} />
              {/* compact here and nowhere else: this bar carries the transport,
                  the state, the way in and the view as well, and at full size
                  the four formats were the last thing that fitted - pressing
                  play was enough to push the row onto a second line and take
                  fifty pixels off the debate */}
              <ExportMenu tagged={transcript} filename="live-session" compact />
            </span>
          </section>

          {/* The same turn without the microphone.
              
              A debate can be live and still arrive as text: a broadcast being
              followed, a feed somebody is transcribing, a quiet room, a machine
              with nothing listening on it. So this sits beside the microphone
              rather than instead of it, and which of the two gives the next
              turn is decided turn by turn, in the middle of the session.

              Behind the button in the bar above rather than always open. It is
              not the way every session runs, and standing open it spent a block
              of the first screen on a box nobody was typing in - which came out
              of the debate, since the feed takes whatever the blocks above it
              leave. Opened, it can be as large as it wants: the room is being
              asked for. */}
          {typing && (
          <form
            className="say"
            onSubmit={(event) => {
              event.preventDefault()
              void say(typed)
            }}
          >
            {/* The head names the card and offers the way out of it.
                
                "or type the turn" read as an alternative to the microphone
                because it used to sit under one, always open. Opened on
                purpose it needs naming rather than offering - and the way to
                put it away belongs here as well as in the bar above, because
                this is where the hands are. */}
            <header className="say__head">
              <label className="say__label" htmlFor="say-turn">
                The turn
              </label>
              <button
                type="button"
                className="say__done"
                onClick={() => setTyping(false)}
                title="Put the box away and go back to the microphone"
              >
                Done
              </button>
            </header>
            {/*
              A turn is a paragraph, not a search box.

              This was one line high, which meant a moderator typing what was
              actually said watched the beginning of it scroll out of view and
              had no way to re-read the sentence they were in the middle of.
              So: several lines by default, and it grows with what is typed up
              to a ceiling, after which it scrolls - a box that grew without
              limit would push the debate off the screen, which is the thing
              the moderator is following.

              Enter still sends the turn, because that is what the single line
              did and the moderator's hands are busy; Shift+Enter is the
              newline, for a turn that has one.
            */}
            <textarea
              id="say-turn"
              className="say__input"
              rows={5}
              /* it was opened to be typed in; the caret starts there rather
                 than after a second click */
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                /* the way out is the same key it is everywhere else, so the
                   box can be put away without reaching for the mouse */
                if (event.key === 'Escape') {
                  setTyping(false)
                  return
                }
                if (event.key !== 'Enter' || event.shiftKey) return
                event.preventDefault()
                if (canSay && typed.trim()) void say(typed)
              }}
              placeholder={current ? `What ${current} said…` : 'Pick who is speaking first'}
              disabled={!canSay}
            />
            {/* What the keyboard does, and the one action of the card, on one
                line: the hint is read once and the button is reached for every
                turn, so the button is the thing that is filled and the hint is
                the thing that is quiet. */}
            <footer className="say__foot">
              <p className="say__keys">Enter sends it · Shift+Enter for a new line · Esc closes</p>
              <button
                type="submit"
                className="btn btn--accent say__send"
                disabled={!canSay || !typed.trim()}
              >
                Add turn
              </button>
            </footer>
          </form>
          )}

          {(notice || recorder.error) && <p className="session__notice">{recorder.error ?? notice}</p>}

          <div className="session__grid">
            <aside className="session__side" data-scroll>
              <Share
                session={room}
                clock={clock}
                minting={minting}
                failed={roomFailed}
                reach={reach}
                onReset={newRoom}
              />
            </aside>

            <div className="session__feed" data-scroll ref={feedBox} onScroll={onFeedScroll}>
              {!turns.length && (
                <p className="session__empty">
                  Nothing said yet. Pick who is speaking, press record, and close the microphone when the turn ends.
                </p>
              )}

              {turns.map((turn) => (
                <Turn
                  key={turn.id}
                  speaker={turn.speaker}
                  tagged={turn.tagged}
                  source={turn.source}
                  elapsedMs={turn.elapsedMs}
                  seconds={turn.seconds}
                  view={view}
                />
              ))}

              {busy && (
                <p className="session__working">
                  <span className="session__dot" aria-hidden="true" />
                  {phase === 'transcribing' ? 'Transcribing what was said…' : 'Annotating the turn…'}
                </p>
              )}

              {behind > 0 && (
                <button type="button" className="catchup" onClick={toEnd}>
                  {behind} new {behind === 1 ? 'turn' : 'turns'} ↓
                </button>
              )}
            </div>
          </div>
          </section>

          {/* What the room is doing, before what the debate is doing: during a
              live event the audience moving is the thing whoever is running it
              has to see first. */}
          <PollBoard
            session={room}
            crowd={crowd}
            speakers={speakers}
            ballot={ballot}
            onBallot={setChosen}
            turns={turns.length}
          />

          {/* under the session, the same band the live view carries */}
          <LiveStats turns={analysed} />

          <TagLegend />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Watching - the same session, from the outside                        *
 * ------------------------------------------------------------------ */

/**
 * A session somebody else is running, watched.
 *
 * Nothing here can reach back into it: no microphone, no turn to add, no name
 * to change. What a watcher gets is the debate as it is spoken, the totals
 * under it, and one thing to say back - which side they are on, and when they
 * changed their mind about it.
 */
function Watching({ session, startedAt }: { session: string; startedAt: number | null }) {
  const [view, setView] = useState<LayerView>('all')
  const { run: relay, lost } = useWatchRun(session, startedAt)
  const turns = useMemo(() => relay?.turns ?? [], [relay])

  /* a replayed room whose link arrived without a clock: the debate had not
     started when the code was scanned, and nothing here can be told when it
     does - there is no connection to be told over */
  const replay = isReplaySession(session)
  const unstarted = replay && startedAt === null

  /* the same rule as the session it is watching: follow the end, and let go
     the moment somebody scrolls back */
  const { box: feedBox, onScroll: onFeedScroll, behind, jump: toEnd } = useFeed<HTMLDivElement>(turns.length)
  /*
   * And the same again for the page under the feed.
   *
   * This is the view it matters most on. A watcher has one thing to do - say
   * where they stand - and the ballot is below the debate, so this is the page
   * people are actually scrolled down on when a turn lands and the blocks above
   * them resize.
   */
  const { scroller, content } = useSteadyScroll<HTMLDivElement, HTMLDivElement>()

  const analysed = useMemo(
    () => turns.map((turn) => ({ index: turn.index, speaker: turn.speaker, tagged: turn.tagged })),
    [turns],
  )
  const transcript = turns.map((turn) => turn.tagged).join('\n\n')

  const ballot = useMemo(() => relay?.ballot ?? [], [relay])
  /* the same room the moderator's board shows, and for the same reason:
     computed from the session and the turn count, so every phone open on this
     code has the same one without anything having been sent */
  const ballotKey = ballot.join('|')
  const crowd = useMemo(
    () => (replay && !unstarted ? simulatedFloor(session, ballotKey ? ballotKey.split('|') : [], turns.length) : null),
    [replay, unstarted, session, ballotKey, turns.length],
  )

  return (
    <div className="page" ref={scroller}>
      <div className="page__inner">
        <div className="session shell" ref={content}>
          <section className="session__screen">
            <header className="session__head">
              <div>
                <span className="eyebrow">Watching</span>
                <h1 className="display session__title">
                  <HoverTag>A debate, live</HoverTag>
                </h1>
              </div>
              <p className="session__lead">
                {replay ? (
                  <>
                    A read-only view of a debate being played on the screen you scanned. This build has no service
                    behind it, so nothing is being sent here: the debate ships with the site, and this page works out
                    which turn has landed from the moment the run started - which is what the code carried. The one
                    thing this page lets you do is say where you stand, and change it whenever the debate does.
                  </>
                ) : (
                  <>
                    A read-only view of a debate being spoken in another tab. Each turn appears here as it is
                    transcribed and annotated over there, and everything below is recomputed as they land. The one
                    thing this page lets you do is say where you stand - and change it whenever the debate does.
                  </>
                )}
              </p>
            </header>

            <section className="mic mic--watch" aria-label="Session">
              <span className="watch__id" title="The session this view is attached to">
                session <strong>{session}</strong>
              </span>
              <span className="mic__state">
                {/* a replayed debate ends, and saying "live" under a feed that
                    has stopped for good is the one thing this row must not do */}
                <span className={`mic__phase mic__phase--${turns.length ? 'idle' : 'transcribing'}`}>
                  {relay?.complete
                    ? 'the debate has ended'
                    : unstarted
                      ? 'not started'
                      : turns.length
                        ? 'live'
                        : 'waiting for the first turn'}
                </span>
                <span className="mic__clock">
                  {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
                </span>
              </span>
              <span className="mic__right">
                <LayerSwitch value={view} onChange={setView} />
                <ExportMenu tagged={transcript} filename="live-session" />
              </span>
            </section>

            <div className="session__grid session__grid--watch">
              <div className="session__feed" data-scroll ref={feedBox} onScroll={onFeedScroll}>
                {!turns.length && (
                  <p className="session__empty">
                    {unstarted
                      ? 'This code was made before the debate began, so it carries no clock to follow - and with no service behind this build there is no way for it to be sent one. Scan the code again now that the debate is running and it will open at the turn everybody else is on.'
                      : isLocalSession(session)
                        ? 'Nothing said yet - this follows a session running in another tab of this browser, and the turns appear here as they are spoken.'
                        : 'Nothing said yet - this follows a debate somebody is running now, and the turns appear here as they are spoken.'}
                  </p>
                )}

                {/* the feed keeps what it has: a debate that has gone quiet and
                    one this page can no longer hear look identical, so the
                    difference is said rather than left to be guessed at */}
                {lost && (
                  <p className="session__lost" role="status">
                    {replay
                      ? 'The debate that ships with this site could not be read, so there is nothing to play here. Reloading the page is what tries again.'
                      : 'Not connected - new turns are not arriving. What is above stays as it was, and the feed picks up again by itself.'}
                  </p>
                )}

                {turns.map((turn) => (
                  <Turn
                    key={`turn-${turn.index}`}
                    speaker={turn.speaker}
                    tagged={turn.tagged}
                    source={turn.source}
                    elapsedMs={turn.elapsedMs}
                    view={view}
                  />
                ))}

                {behind > 0 && (
                  <button type="button" className="catchup" onClick={toEnd}>
                    {behind} new {behind === 1 ? 'turn' : 'turns'} ↓
                  </button>
                )}
              </div>
            </div>
          </section>

          <PollVote session={session} crowd={crowd} ballot={ballot} turns={analysed} />

          <LiveStats turns={analysed} />

          <TagLegend />
        </div>
      </div>
    </div>
  )
}

/**
 * An address a phone cannot reach.
 *
 * `linkTo` builds the link from where this build is actually served, which on a
 * developer's machine is `localhost` - an address that means *this* machine to
 * whatever reads it. Put that on a QR code and it scans perfectly and then
 * fails, which is worse than not offering one, so the panel says so instead.
 * `npm run dev -- --host` is what puts the site on the network.
 */
const REACHES_ONLY_HERE = /^(localhost|127\.0\.0\.1|\[::1\])$/i

/**
 * The address that turns one session into something other people can watch,
 * and - where there is a service holding the room - something they can be
 * pointed at rather than sent.
 *
 * Absolute, and built from where this build is actually served. The same link
 * every time it is copied, for as long as this session is the one being run;
 * `New room` is how it is deliberately ended, because the votes are counted
 * against the session and a fresh room is an empty floor.
 *
 * The QR code is shown only for a room the service is holding, and that is the
 * whole of the distinction: a local room lives in this browser's storage, so a
 * phone that scanned it would open a page with no debate in it. The link stays
 * on the panel underneath either way - it is what somebody without a phone in
 * their hand uses, and what gets pasted into a chat.
 */
function Share({
  session,
  clock,
  minting,
  failed,
  reach,
  onReset,
}: {
  session: string
  /** when the replayed run started, or null while it has not - see `replaySession.ts` */
  clock: number | null
  /** a room has been asked of the service and has not arrived yet */
  minting: boolean
  /** a service was configured and would not give us one */
  failed: boolean
  reach: Published
  onReset: () => void
}) {
  /*
   * The link, and - for a replayed room - the clock beside it.
   *
   * This is the whole of what travels. A phone that opens it has the transcript
   * already, because it is the same build, so the session names the floor it
   * votes on and `t` says when the debate began; everything else is worked out
   * on the device. It is re-issued whenever the run is resumed, which is why the
   * code is worth looking at again after a pause.
   */
  const url = useMemo(
    () => linkTo('/livesession', clock === null ? { session } : { session, t: clockParam(clock) }),
    [session, clock],
  )
  const field = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)

  const local = isLocalSession(session)
  const replay = isReplaySession(session)
  /* a replayed room is only worth scanning once it has a clock in it: before
     the debate is started there is nothing for the other side to follow */
  const waiting = replay && clock === null
  const onlyHere = useMemo(() => REACHES_ONLY_HERE.test(window.location.hostname), [])
  /* whether the link the code carries can be reached from the device that
     scans it. The code is drawn either way - it is the link, and a panel that
     shows the link but hides its code is a panel with a hole in it - but what
     is said under it changes, because "point a camera at this" is a promise
     that a `localhost` address cannot keep */
  const scannable = !local && !onlyHere && !waiting

  async function copy() {
    field.current?.select()
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* selected instead: the reader copies it themselves */
    }
  }

  return (
    <div className="share">
      <h2 className="eyebrow">Share this session</h2>
      <p className="share__text">
        Whoever opens this link watches the debate as it is spoken/written, and can say which side they are on, and change
        it as the debate changes it for them.
      </p>

      <div className="share__code">
        {/* nothing while it loads: it is a fraction of a second on the same
            connection the room is on, and a placeholder that flashes where a
            code is about to be would be worse than the gap */}
        <Suspense fallback={null}>
          <QrCode value={url} label="Scan to watch this debate and vote in it" />
        </Suspense>
        <p className="share__scan">
          {scannable
            ? 'Point a camera at this to join.'
            : waiting
              ? 'Press play, and then point a camera at it.'
              : 'This is the link below.'}
          {/* the one figure that says the code is working */}
          {reach.watching > 0 && (
            <>
              {' '}
              <strong className="share__here">
                {reach.watching} {reach.watching === 1 ? 'person is' : 'people are'} watching
              </strong>
              .
            </>
          )}
        </p>
      </div>

      <div className="share__row">
        <input
          ref={field}
          className="share__url"
          type="text"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Link to this session"
        />
        <button type="button" className="toggle share__copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Where the link reaches - the one thing somebody has to know before
          handing it to anyone, and not the same sentence twice: a room being
          opened, a service that would not open one, a local room, a real room
          on a page only this machine can reach, and a service that has stopped
          answering. What is running behind it is not their problem; how far
          the thing in their hand travels is. */}
      <p className="share__note">
        {waiting ? (
          'Nothing is served behind this build, so the room is not held anywhere: the debate ships with the site, and this link hands a phone the one thing it cannot work out on its own - when the run began. Start the debate and the code goes live.'
        ) : replay ? (
          <>
            Anyone who scans this now opens the debate at the turn everybody else is on, on any device, with nothing
            served behind it: both sides play the same transcript to the same schedule from the moment in this link.
            Pausing re-issues it, so a phone that scanned before the pause runs ahead until it scans again - there is
            no connection here to tell it otherwise. The floor it votes on is this session, and it is cleared by a new
            room.
          </>
        ) : minting ? (
          'Opening a room on the service - the link will work from any device once it answers.'
        ) : failed ? (
          <>
            The service did not open a room, so this one is local: it works in this browser, on this machine - a second
            window is a second voter. Start the service and take a new room for a link that travels.
          </>
        ) : local ? (
          /* where this build is served from does not come into it: the browser
             is the limit, not the host, and `--host` would not lift it */
          'The same link every time you copy it. It works in this browser, on this machine - a second window is a second voter - and it ends when a new room is started.'
        ) : onlyHere ? (
          <>
            The room is on the service and will hold anyone who reaches it - but this page is served from{' '}
            <code>localhost</code>, so the link in it only means anything on this machine. Serve it with{' '}
            <code>npm run dev -- --host</code> and the code becomes scannable.
          </>
        ) : reach.lost ? (
          'The service stopped answering, so nobody watching is being sent new turns. The debate itself is unaffected - it is being annotated here - and the room picks up again when the service does.'
        ) : (
          'The same link every time you copy it. Anyone who opens it is in the room, on any device, and it ends when a new room is started.'
        )}
      </p>

      <button type="button" className="share__reset" onClick={onReset} title="A new room: a new link, and no votes in it">
        New room - clears the votes
      </button>
    </div>
  )
}
