import { useMemo } from 'react'
import qrcode from 'qrcode-generator'
import './QrCode.css'

/**
 * A link, as something a phone can be pointed at.
 *
 * The encoder is a dependency because Reed-Solomon and mask selection are not
 * things worth getting subtly wrong on a stage; the *drawing* is ours, the way
 * the charts are, so the code is set in the tool's own colours and sizes itself
 * against the panel instead of arriving as a fixed-size image.
 *
 * One `<path>`, not a rect per module. A code of this size is about a thousand
 * dark modules, and a thousand elements is a thousand elements to lay out and
 * paint every time the panel re-renders — which, on the page running a live
 * debate, is every turn. As one path it is a single node and a single paint.
 *
 * `shape-rendering: crispEdges` matters more than it looks: a scanner reads the
 * *contrast* between neighbouring modules, and antialiasing a module edge onto
 * a fractional pixel is what makes a small code on a dense screen fail to
 * resolve at an angle or in bad light.
 */

/**
 * Error correction. `M` recovers about 15% of the code and is the usual choice;
 * the higher levels exist for codes that get printed and handled, and buy
 * nothing on a screen except a denser grid that scans from further away.
 */
const CORRECTION = 'M' as const

/**
 * The quiet zone, in modules, and it is not decoration: the specification asks
 * for four clear modules on every side, and a scanner that cannot find them
 * will not attempt the code at all. Anything the panel puts around this — a
 * border, a background of a different colour — must stay outside it.
 */
const QUIET = 4

interface Props {
  /** what the code carries; a URL, here */
  value: string
  /** described to anyone who cannot see it, since the code itself says nothing */
  label: string
  className?: string
}

export default function QrCode({ value, label, className = '' }: Props) {
  /* re-encoding is only worth doing when the link changes, which is once a room */
  const drawn = useMemo(() => {
    if (!value) return null
    try {
      /* 0 asks the encoder to pick the smallest version the text fits in */
      const code = qrcode(0, CORRECTION)
      code.addData(value)
      code.make()

      const count = code.getModuleCount()
      const path: string[] = []
      for (let row = 0; row < count; row += 1) {
        /* dark modules in a row are run together into one rectangle: a code is
           full of horizontal runs, and this roughly halves the path */
        let from = -1
        for (let col = 0; col <= count; col += 1) {
          const dark = col < count && code.isDark(row, col)
          if (dark && from === -1) from = col
          if (!dark && from !== -1) {
            path.push(`M${from + QUIET} ${row + QUIET}h${col - from}v1h-${col - from}z`)
            from = -1
          }
        }
      }

      return { path: path.join(''), size: count + QUIET * 2 }
    } catch {
      /* too long to encode at this correction level: the link is still on the
         panel underneath, which is the thing that actually has to work */
      return null
    }
  }, [value])

  if (!drawn) return null

  return (
    <svg
      className={`qr ${className}`.trim()}
      viewBox={`0 0 ${drawn.size} ${drawn.size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      {/* the quiet zone is part of the code, so it is painted, not left open:
          the panel behind this may be any colour, and the code needs its own */}
      <rect className="qr__ground" x="0" y="0" width={drawn.size} height={drawn.size} />
      <path className="qr__ink" d={drawn.path} />
    </svg>
  )
}
