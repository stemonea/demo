import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { glyph } from '../lib/glyphs'
import { tagColour } from '../lib/tags'
import './TokenStream.css'

/**
 * The hero engraving: a field of symbols that never settles, with tags surfacing
 * out of it - generation, drawn in characters.
 *
 * A grid of glyphs is mutated a few per cent per tick; tags are written into it,
 * live for a while, then dissolve back into noise. The whole field warms to
 * light orange under the cursor.
 *
 * Where the field is `interactive`, pressing on it sends a wave out from the
 * point pressed: see `Wave` below.
 *
 * The same field, cut down to a few rows, is what waiting for the model looks
 * like elsewhere in the demo: a turn being annotated is exactly this - symbols
 * churning until tags surface out of them. Hence the size being a prop rather
 * than a constant.
 */

const COLS = 92
const ROWS = 11

/** what the tagger emits, and what surfaces out of the noise */
const TAGS = [
  '<claim>',
  '</claim>',
  '<premise>',
  '</premise>',
  '<person>',
  '</person>',
  '<location>',
  '</location>',
  '<organization>',
  '</organization>',
  '<event>',
  '</event>',
  '<date>',
  '</date>',
  '<role>',
  '</role>',
  '<party>',
  '</party>'
]

/** how many tags are alive at any moment, in the field this was drawn for */
const TAGS_ALIVE = 9
/** and therefore how thickly they surface, per character of any other field */
const TAG_DENSITY = TAGS_ALIVE / (COLS * ROWS)
/** however large the field, this many tags at once is already a page of markup */
const TAGS_ALIVE_MAX = 40
/** share of the field redrawn on every tick */
const CHURN = 0.07
const TICK_MS = 110

export interface TokenStreamProps {
  /**
   * Fill the element instead of being a fixed block: the grid is measured from
   * the box it is given and the character it is drawn with, so the field covers
   * its half of the page whatever the window is. `cols` and `rows` are then the
   * starting point, replaced as soon as the box has been measured.
   *
   * `'width'` measures the width alone. The field then spans its box exactly —
   * no short line ending in the middle of a panel, no run overflowing it — while
   * keeping the number of rows it was asked for and the type its own stylesheet
   * gives it. That is what a status band wants: it is a strip of a given height
   * whose only unknown is how wide the panel holding it happens to be.
   */
  fit?: boolean | 'width'
  /** width and height of the field, in characters */
  cols?: number
  rows?: number
  /** tags surfacing at once; by default, in proportion to the size of the field */
  tagsAlive?: number
  tickMs?: number
  /** the field answers the pointer: pressing on it sends a wave out from there */
  interactive?: boolean
  /** an extra class on the wrapper, for a field that is not the hero */
  className?: string
}

/**
 * A field fitted to its box: the grid, and the type that makes it land on it.
 *
 * `type` is null when only the width was measured — the field then keeps the
 * size its stylesheet set, and the count of columns is what was fitted to the
 * box instead of the other way round.
 */
interface Fitted {
  cols: number
  rows: number
  type: { fontSize: number; lineHeight: number } | null
}

interface Segment {
  text: string
  /** tag name when the run belongs to a tag, e.g. `claim` */
  tag?: string
  /** 0-1, how hard a wavefront is standing on the run right now */
  charge?: number
}

interface LiveTag {
  id: number
  name: string
  text: string
  row: number
  col: number
  ttl: number
}

/*
 * ---- the wave -------------------------------------------------------
 *
 * A press on the field puts a ring into it, expanding from the point pressed.
 * It is magnetic rather than liquid: the noise it crosses does not ripple, it
 * *aligns* - every character under the front is replaced by the rule that runs
 * along the front at that point, the way iron filings turn to lie along a
 * field. Since a circle's tangent turns through the four eighths of a turn the
 * box-drawing rules cover, the aligned noise draws the ring itself, and the
 * glyphs meet because the field is set at line-height 1 with no tracking.
 *
 * Nothing is written into the grid: the ring is computed at paint time from the
 * waves that are alive, so a cell it has passed is back to being whatever the
 * noise made it, with nothing to restore. Tags are lit but never overwritten -
 * what the model emitted stays readable, and the wave reads as passing through
 * it rather than erasing it.
 */

/**
 * How fast a front travels across the field, in CSS pixels per second.
 *
 * Set against the width of a character rather than picked for its own sake: at
 * this speed the front crosses about one column per frame, which is the finest
 * step a character grid has. Faster and it skips columns and reads as jumping;
 * much slower and it crawls.
 */
const WAVE_SPEED = 850
/** how thick the front is, as a share of one cell's width plus its height */
const WAVE_BAND = 0.6
/** presses that land while earlier waves are still running */
const WAVES_MAX = 3
/**
 * Steps the charge is quantised to. A run of the field is one element per step,
 * so this is a trade of elements for smoothness; the front is only about three
 * columns thick, which is what keeps the count down at this many.
 */
const CHARGE_LEVELS = 8

interface Wave {
  /** `performance.now()` when the field was pressed */
  started: number
  /** where it was pressed, in cells */
  col: number
  row: number
  /** the cell it was measured against, so distances can be taken in pixels */
  cellW: number
  cellH: number
  /** distance to the furthest corner: how far the front has to go to be gone */
  reach: number
  /** and therefore how long it lives, at a fixed speed */
  life: number
  /** thickness of the front, in pixels */
  band: number
}

/** the four rules a wavefront can be drawn with, by eighth of a turn */
const ALIGNED = ['─', '╲', '│', '╱']

/**
 * The rule that lies along the front at a point offset (`dx`, `dy`) from where
 * the field was pressed. The front runs at a right angle to that ray, which is
 * what makes the aligned noise close into a ring.
 */
function aligned(dx: number, dy: number): string {
  let angle = (Math.atan2(dy, dx) + Math.PI / 2) % Math.PI
  if (angle < 0) angle += Math.PI
  return ALIGNED[Math.round((angle / Math.PI) * 4) % 4]
}

/**
 * The shape of the front across its own thickness.
 *
 * A raised cosine rather than a ramp. A triangular crest arrives and leaves on
 * a corner, and on a character grid that corner is exactly what is seen
 * stepping from one cell to the next; easing both edges to nothing lets the
 * front slide across a cell instead of landing on it.
 */
const crest = (off: number, band: number) => 0.5 * (1 + Math.cos((Math.PI * off) / band))

/** the step of charge a strength falls in; 0 is a cell no front is standing on */
const levelOf = (strength: number) =>
  strength <= 0 ? 0 : Math.min(CHARGE_LEVELS, Math.ceil(strength * CHARGE_LEVELS))

/**
 * One line of the field.
 *
 * Held behind `memo` because a wave redraws the field on every frame of the
 * display but only ever stands on a few of its lines at a time: `paint` hands
 * back the very same array for a line the front has not touched, so this bails
 * out for most of the field and only the lines under the front are reconciled.
 * That is what buys the frame rate the movement needs.
 */
const Row = memo(function Row({ segments }: { segments: Segment[] }) {
  return (
    <span>
      {segments.map((segment, i) => {
        if (!segment.tag && !segment.charge) return <span key={i}>{segment.text}</span>
        const style: Record<string, string> = {}
        if (segment.tag) style['--tag-color'] = tagColour(segment.tag)
        if (segment.charge) style['--charge'] = String(segment.charge)
        return (
          <span
            key={i}
            className={`${segment.tag ? 'stream__tag' : ''}${segment.charge ? ' stream__charged' : ''}`.trim()}
            style={style as CSSProperties}
          >
            {segment.text}
          </span>
        )
      })}
      {'\n'}
    </span>
  )
})

/** characters in the probe used to measure one character of the field */
const PROBE = 'M'.repeat(20)

/**
 * How big a glyph wants to be when the field is filling a box, as a share of the
 * box's height, and the sizes it may never fall outside of. Big enough to be
 * read as characters rather than as texture.
 */
const FIT_GLYPH_SHARE = 0.065
const FIT_MIN_PX = 15
const FIT_MAX_PX = 30

export default function TokenStream({
  fit = false,
  cols = COLS,
  rows: rowCount = ROWS,
  tagsAlive,
  tickMs = TICK_MS,
  interactive = false,
  className = '',
}: TokenStreamProps = {}) {
  const reduced = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  /* in `fit` mode the grid is whatever the box holds, measured rather than
     guessed: a character grid has a fixed aspect, so the only way to cover a
     box of any shape is to change how many characters are in it */
  const boxRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLPreElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const [measured, setMeasured] = useState<Fitted | null>(null)

  /*
   * Measured before the first paint, not after it.
   *
   * `ResizeObserver` delivers its first callback *after* the browser has laid
   * the box out and painted it, so a field that is measured only there is drawn
   * once at whatever `cols` it was seeded with and then snaps to its real width
   * a frame later. On the hero, mounted once, that is a flicker nobody sees; on
   * the loader it is not, because the loader is mounted afresh for every turn of
   * the debate — the band would flash short and jump wide, over and over, for
   * as long as the replay ran. So the same measurement is taken synchronously
   * here as well, in a layout effect, and the observer is left to do what it is
   * actually for: noticing that the box has since changed size.
   */
  useLayoutEffect(() => {
    const box = boxRef.current
    const field = fieldRef.current
    const probe = probeRef.current
    if (!fit || !box || !field || !probe) return

    const measure = () => {
      /* how wide a character is per point of type: a ratio, so it holds at any
         size and the field can be resized without measuring again */
      const drawn = parseFloat(getComputedStyle(field).fontSize)
      const advance = probe.getBoundingClientRect().width / PROBE.length
      if (!drawn || !advance) return
      const ratio = advance / drawn

      const area = box.getBoundingClientRect()
      if (!area.width) return

      if (fit === 'width') {
        /*
         * Width alone: the type stays as the stylesheet set it and the count of
         * columns is what gives. `clientWidth` less the padding is the room the
         * run actually has — the band is inset by a rule and a gutter — and the
         * count is rounded *down*, because a field set in `pre` cannot wrap: one
         * column too many is a line running out past the edge of the panel
         * rather than a line one character short of it.
         */
        const style = getComputedStyle(box)
        const inner =
          box.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
        const columns = Math.max(12, Math.floor(inner / advance))
        setMeasured((was) =>
          was && was.cols === columns && was.rows === rowCount ? was : { cols: columns, rows: rowCount, type: null },
        )
        return
      }

      if (!area.height) return

      /*
       * The grid is fitted to the box rather than cropped by it. A whole number
       * of characters has to span the width and a whole number of lines the
       * height, so the type is sized to the count instead of the count being
       * rounded off the type: the field then reaches every edge exactly, with
       * no clipped row along the bottom and no strip of page down the side.
       */
      const wanted = Math.min(FIT_MAX_PX, Math.max(FIT_MIN_PX, area.height * FIT_GLYPH_SHARE))
      const columns = Math.max(12, Math.round(area.width / (wanted * ratio)))
      const fontSize = area.width / (columns * ratio)
      const lines = Math.max(2, Math.round(area.height / fontSize))

      setMeasured({
        cols: columns,
        rows: lines,
        type: { fontSize, lineHeight: area.height / lines },
      })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [fit, rowCount])

  const gridCols = measured?.cols ?? cols
  const gridRows = measured?.rows ?? rowCount

  /* a bigger field has to carry more tags, or the same nine are lost in it: the
     density of the hero is what the effect was tuned at, so that is what is kept */
  const alive =
    tagsAlive ?? Math.min(TAGS_ALIVE_MAX, Math.max(2, Math.round(gridCols * gridRows * TAG_DENSITY)))

  const cells = useRef<string[][]>([])
  const owners = useRef<(number | null)[][]>([])
  const tags = useRef<LiveTag[]>([])
  const nextId = useRef(1)

  /* the waves running through the field, and the way to wake the loop that
     draws them — the loop lives with the field's own timer, so it is handed
     back out here for the pointer to reach */
  const waves = useRef<Wave[]>([])
  const kick = useRef<(() => void) | null>(null)

  const [rows, setRows] = useState<Segment[][]>([])

  useEffect(() => {
    cells.current = Array.from({ length: gridRows }, () => Array.from({ length: gridCols }, glyph))
    owners.current = Array.from({ length: gridRows }, () => Array.from({ length: gridCols }, () => null))
    tags.current = []
    waves.current = []

    /* a narrow field has no room for the longest tags, and one that never fits
       would spin the spawn loop forever */
    const fits = TAGS.filter((tag) => tag.length + 2 <= gridCols)
    if (!fits.length) return

    const free = (row: number, col: number, length: number) => {
      if (col + length > gridCols) return false
      for (let i = Math.max(0, col - 1); i < Math.min(gridCols, col + length + 1); i += 1) {
        if (owners.current[row][i] !== null) return false
      }
      return true
    }

    const spawn = () => {
      const text = fits[Math.floor(Math.random() * fits.length)]
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const row = Math.floor(Math.random() * gridRows)
        const col = Math.floor(Math.random() * (gridCols - text.length))
        if (!free(row, col, text.length)) continue

        const tag: LiveTag = {
          id: nextId.current++,
          name: text.replace(/[<>/]/g, ''),
          text,
          row,
          col,
          ttl: 12 + Math.floor(Math.random() * 26),
        }
        for (let i = 0; i < text.length; i += 1) {
          cells.current[row][col + i] = text[i]
          owners.current[row][col + i] = tag.id
        }
        tags.current.push(tag)
        return
      }
    }

    /* what makes two neighbouring characters one run: whose tag they belong to,
       and how hard a front is standing on them */
    const keyAt = (y: number, x: number, charge: number[] | null) =>
      (owners.current[y][x] ?? 0) * (CHARGE_LEVELS + 1) + (charge ? levelOf(charge[x]) : 0)

    /* the last frame drawn, and which of its lines the front was standing on */
    let drawn: Segment[][] = []
    const wasCharged = new Array<boolean>(gridRows).fill(false)

    /**
     * Does a front stand anywhere on this line of the field right now? Two ways
     * it does not: it has not reached the line yet, or it has gone straight
     * past it — the furthest the line reaches from the press is its far end, so
     * once the ring is wider than that the line is behind it and settled.
     */
    const crosses = (wave: Wave, dy: number, radius: number) => {
      if (Math.abs(dy) > radius + wave.band) return false
      const far = Math.hypot(Math.max(wave.col, gridCols - wave.col) * wave.cellW, dy)
      return far > radius - wave.band
    }

    /*
     * One frame of the field. Each row is grouped into runs drawn the same way,
     * so a tag — or a stretch of a wavefront — is a single element rather than
     * a span per character.
     *
     * `churned` says the noise itself has moved, which is every line at once.
     * A wave frame has not touched the noise, so only the lines a front stands
     * on now — and the ones it has just left — are built again; the rest are
     * handed back as the very same arrays, which is what lets `Row` drop out of
     * the render. A front is on three or four lines of a field fifteen or twenty
     * deep, so most of the work goes away and the frame is spent where the
     * movement is. That is what pays for drawing on every frame of the display
     * rather than on every third one.
     */
    const paint = (churned = false) => {
      const byId = new Map(tags.current.map((tag) => [tag.id, tag.name]))
      const active = waves.current
      const now = active.length ? performance.now() : 0

      const all = churned || !drawn.length
      const stale = new Array<boolean>(gridRows).fill(all)
      if (!all) {
        for (let y = 0; y < gridRows; y += 1) if (wasCharged[y]) stale[y] = true
        for (const wave of active) {
          const age = (now - wave.started) / wave.life
          if (age < 0 || age > 1) continue
          const radius = age * wave.reach
          for (let y = 0; y < gridRows; y += 1) {
            if (crosses(wave, (y + 0.5 - wave.row) * wave.cellH, radius)) stale[y] = true
          }
        }
      }

      drawn = cells.current.map((row, y) => {
        if (!stale[y]) return drawn[y]

        /* untouched noise is drawn straight from the grid; only a line a front
           stands on is copied, and only that copy is aligned to it */
        const chars = active.length ? row.slice() : row
        const charge = active.length ? new Array<number>(gridCols).fill(0) : null

        for (const wave of active) {
          const age = (now - wave.started) / wave.life
          if (age < 0 || age > 1) continue
          const radius = age * wave.reach
          const dy = (y + 0.5 - wave.row) * wave.cellH
          if (!crosses(wave, dy, radius)) continue
          /* the ring spends its energy as it spreads over more of the field */
          const amp = Math.pow(1 - age, 0.7)

          for (let x = 0; x < gridCols; x += 1) {
            const dx = (x + 0.5 - wave.col) * wave.cellW
            const off = Math.abs(Math.hypot(dx, dy) - radius)
            if (off >= wave.band) continue
            const strength = amp * crest(off, wave.band)
            if (strength <= charge![x]) continue
            charge![x] = strength
            /* a tag is lit rather than aligned: what the model emitted stays
               readable, and the wave passes through it */
            if (owners.current[y][x] === null) chars[x] = aligned(dx, dy)
          }
        }

        wasCharged[y] = false
        const segments: Segment[] = []
        let start = 0
        let key = keyAt(y, 0, charge)
        for (let x = 1; x <= gridCols; x += 1) {
          /* NaN closes the last run: it matches nothing, itself included */
          const here = x < gridCols ? keyAt(y, x, charge) : NaN
          if (here === key) continue
          const owner = owners.current[y][start]
          const level = charge ? levelOf(charge[start]) : 0
          if (level) wasCharged[y] = true
          segments.push({
            text: chars.slice(start, x).join(''),
            tag: owner === null ? undefined : byId.get(owner),
            charge: level ? level / CHARGE_LEVELS : undefined,
          })
          start = x
          key = here
        }
        return segments
      })

      setRows(drawn)
    }

    const tick = () => {
      /* noise: redraw a slice of the field, leaving whatever a tag holds */
      const churn = Math.max(1, Math.round(gridCols * gridRows * CHURN))
      for (let i = 0; i < churn; i += 1) {
        const row = Math.floor(Math.random() * gridRows)
        const col = Math.floor(Math.random() * gridCols)
        if (owners.current[row][col] === null) cells.current[row][col] = glyph()
      }

      /* tags age out and dissolve back into the noise */
      tags.current = tags.current.filter((tag) => {
        tag.ttl -= 1
        if (tag.ttl > 0) return true
        for (let i = 0; i < tag.text.length; i += 1) {
          cells.current[tag.row][tag.col + i] = glyph()
          owners.current[tag.row][tag.col + i] = null
        }
        return false
      })

      while (tags.current.length < alive) spawn()

      paint(true)
    }

    /* the waves run on their own clock, and on every frame of it: the noise
       churns slowly enough to read as generation, which is far too slow for a
       front to travel smoothly */
    let waveFrame: number | null = null

    const run = (now: number) => {
      waves.current = waves.current.filter((wave) => now - wave.started < wave.life)
      paint()
      if (!waves.current.length) {
        /* that last frame put the field back to the noise underneath */
        waveFrame = null
        return
      }
      waveFrame = requestAnimationFrame(run)
    }

    kick.current = () => {
      if (waveFrame === null) waveFrame = requestAnimationFrame(run)
    }

    tick()
    const timer = reduced ? null : setInterval(tick, tickMs)

    return () => {
      if (timer !== null) clearInterval(timer)
      if (waveFrame !== null) cancelAnimationFrame(waveFrame)
      kick.current = null
      waves.current = []
    }
  }, [reduced, gridCols, gridRows, alive, tickMs])

  /**
   * A press on the field. The front is put in at a fixed speed and lives until
   * it has reached the furthest corner, so where you press changes how long the
   * wave runs rather than how fast it sweeps — a press in a corner crosses the
   * whole field, one in the middle is over in half the time.
   */
  function strike(event: ReactPointerEvent<HTMLDivElement>) {
    const field = fieldRef.current
    if (reduced || !field || !kick.current) return

    const rect = field.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const cellW = rect.width / gridCols
    const cellH = rect.height / gridRows
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const reach = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y))

    waves.current.push({
      started: performance.now(),
      col: x / cellW,
      row: y / cellH,
      cellW,
      cellH,
      reach,
      life: (reach / WAVE_SPEED) * 1000,
      band: (cellW + cellH) * WAVE_BAND,
    })
    if (waves.current.length > WAVES_MAX) {
      waves.current.splice(0, waves.current.length - WAVES_MAX)
    }
    kick.current()
  }

  return (
    <div
      className={`stream${fit === true ? ' stream--fit' : ''}${
        fit === 'width' ? ' stream--fit-width' : ''
      }${interactive ? ' stream--interactive' : ''} ${className}`.trim()}
      ref={boxRef}
      onPointerDown={interactive ? strike : undefined}
    >
      <pre
        className="stream__field"
        aria-hidden="true"
        ref={fieldRef}
        style={
          measured?.type
            ? { fontSize: `${measured.type.fontSize}px`, lineHeight: `${measured.type.lineHeight}px` }
            : undefined
        }
      >
        {fit && (
          <span className="stream__probe" ref={probeRef} aria-hidden="true">
            {PROBE}
          </span>
        )}
        {rows.map((segments, y) => (
          <Row segments={segments} key={y} />
        ))}
      </pre>
      <span className="visually-hidden">
        A stream of generated symbols with argument and entity tags surfacing out of it.
      </span>
    </div>
  )
}
