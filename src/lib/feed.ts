import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A feed that follows the newest turn, until somebody is reading.
 *
 * A live debate wants to stay at its own end: the turn that has just landed is
 * the one to look at, and having to chase it down the page would be worse than
 * useless. But the moment a reader scrolls back — to check what was claimed
 * four turns ago, to read a long answer properly — the next turn used to yank
 * the box out from under them, which makes reading the transcript of a running
 * debate impossible.
 *
 * So it follows only from the end. Scroll away and it lets go; scroll back and
 * it takes hold again. Nothing is lost while it is let go, and how much has
 * arrived meanwhile is counted, so the way back is a button that says how far
 * behind the reader has fallen rather than a guess at the bottom of a bar.
 */

/**
 * How near the foot counts as having arrived back at it.
 *
 * Deliberately a few pixels and not the half-screen this used to be. A wide
 * band is fine for deciding that somebody is still watching the end, and
 * wrong for deciding that they have come back to it: a reader who pushes the
 * feed up by twenty pixels is inside a wide band, so the scroll they just made
 * was read as "still at the end", the feed took hold again and put them back.
 * Coming back is now the one thing it means — the scroll has to actually reach
 * the bottom — and the slack is only what a fractional layout leaves behind.
 */
const REJOIN = 8

/**
 * How much of a wheel notch upwards counts as the reader taking over.
 *
 * Small enough that the first gentle push of a trackpad is heard, large
 * enough that the direction noise a flick downwards ends with - a stray
 * negative delta or two in the tail of the momentum - is not mistaken for
 * somebody scrolling back.
 */
const UP_INTENT = 2

/** Keys that mean "back up the feed", and so mean "stop following". */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

export interface Feed<T extends HTMLElement> {
  /* named `box` rather than `ref`: it is handed straight to the element, and
     nothing here ever reads it while rendering */
  box: React.RefObject<T | null>
  /** put this on the scrolling element */
  onScroll: () => void
  /** turns that have landed since the reader scrolled away */
  behind: number
  /** back to the end, and following again */
  jump: () => void
}

export function useFeed<T extends HTMLElement>(count: number): Feed<T> {
  const box = useRef<T>(null)
  /* state, because whether it is following is something the view renders and
     the effect below has to re-run when it changes — and a ref beside it,
     because the scroll handler has to compare against the current value
     without waiting for a render to hand it one */
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  /* how much had arrived when the reader last let go */
  const [anchor, setAnchor] = useState(count)
  /* the same number, readable from a listener that was registered once and so
     cannot have the latest render's value closed over it. Kept in step from an
     effect rather than in the body: a ref written while rendering is a value
     React is free to have produced twice, and the listeners only ever read it
     after a commit anyway. */
  const countRef = useRef(count)
  useEffect(() => {
    countRef.current = count
  }, [count])

  const behind = following ? 0 : Math.max(0, count - anchor)

  /**
   * Let go of the end, at the first sign the reader wants to be somewhere else.
   *
   * This used to be reachable only through the scroll handler, and only after
   * half a screen of travel — and inside that band the feed was still
   * following, so the next turn to land put the view straight back at the
   * foot. A reader pushing up a notch at a time with a trackpad never got out
   * of the band: every push was undone by the next arrival, a second or two
   * apart, and the box appeared to fight them. Intent is heard here instead of
   * distance, so the first push is enough.
   */
  const release = useCallback(() => {
    if (!followingRef.current) return
    /* there has to be somewhere to go: a debate that has not yet filled the box
       is at its end and its top at once, and a wheel over it moves nothing. Let
       go there and the feed would stop following a debate the reader never
       scrolled, and start counting turns as missed under their eyes. */
    if ((box.current?.scrollTop ?? 0) <= 0) return
    followingRef.current = false
    /* leaving the end is what fixes the mark the count is read against */
    setAnchor(countRef.current)
    setFollowing(false)
  }, [])

  const hold = useCallback(() => {
    if (followingRef.current) return
    followingRef.current = true
    setFollowing(true)
  }, [])

  /*
   * Following is done before the frame is painted, not after.
   *
   * An effect that runs after the paint lets the browser show one frame of the
   * new turn sitting below the fold with the scroll still where it was, and
   * then moves it: at the pace turns land that reads as a shudder on every
   * one of them. A layout effect puts the view at the foot in the same frame
   * the turn appears in, so the feed simply grows downwards.
   *
   * And it is only written when it is actually wrong. Assigning `scrollTop`
   * the value it already holds still cancels the momentum of a flick in
   * progress on macOS, which is the other half of what made this box feel
   * sticky.
   *
   * Every commit and not only a new turn, because a turn is not the only thing
   * that grows the box: the loader that says which turn is being annotated
   * comes and goes at the foot between every pair of them, and an error or a
   * catch-up button take a row of their own. Keyed to the count, those left the
   * view a little short of the bottom until the next turn landed and snatched
   * it down. The cost of covering them is one measurement per render of a page
   * that renders when a turn moves, and a write only when the foot has actually
   * got away.
   */
  useLayoutEffect(() => {
    const node = box.current
    if (!node || !following) return
    const foot = node.scrollHeight - node.clientHeight
    if (Math.abs(node.scrollTop - foot) > 1) node.scrollTop = foot
  })

  /*
   * The gestures that mean "I am reading, leave it alone".
   *
   * Registered on the element rather than handed to React, because a wheel
   * listener has to be able to say it is passive: a non-passive one makes the
   * browser wait to see whether the scroll will be cancelled before it moves
   * anything, which is a stutter of its own on every notch.
   */
  useEffect(() => {
    const node = box.current
    if (!node) return

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < -UP_INTENT) release()
    }
    const onKey = (event: KeyboardEvent) => {
      if (UP_KEYS.has(event.key)) release()
    }
    /* a finger travelling down the glass drags the debate up */
    let last = 0
    const onTouchStart = (event: TouchEvent) => {
      last = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? last
      if (y - last > UP_INTENT) release()
      last = y
    }

    node.addEventListener('wheel', onWheel, { passive: true })
    node.addEventListener('keydown', onKey)
    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('keydown', onKey)
      node.removeEventListener('touchstart', onTouchStart)
      node.removeEventListener('touchmove', onTouchMove)
    }
  }, [release])

  const onScroll = useCallback(() => {
    const node = box.current
    if (!node) return
    /* the foot still takes hold again on its own — scrolling back down to the
       end is how a reader says they are done reading */
    if (node.scrollHeight - node.clientHeight - node.scrollTop <= REJOIN) hold()
    else release()
  }, [hold, release])

  const jump = useCallback(() => {
    const node = box.current
    if (node) node.scrollTop = node.scrollHeight
    followingRef.current = true
    setFollowing(true)
  }, [])

  return { box, onScroll, behind, jump }
}

/**
 * Keeps a reader's place while the page above them changes size.
 *
 * The watcher's page is not only the feed: under it are the ballot, the running
 * totals and the figures, and every one of them is redrawn when a turn lands.
 * They do not merely redraw, they *resize* — the ballot opens from one line
 * into a board the moment a second name has argued, a bar chart takes another
 * row as another name is entered into it, the pairs fill in one at a time. A
 * reader who has scrolled down to any of that is reading below something that
 * just grew, so the page slides under them: what they were looking at is pushed
 * down the screen, which reads as the view hopping up on its own, and it does
 * it again on the next turn.
 *
 * Browsers have a name for the fix — scroll anchoring — and Safari does not
 * implement it at all, which is why this shows up on one machine and not the
 * next. So it is done here rather than hoped for, and the scrollers it is done
 * on turn the native mechanism off (`overflow-anchor: none`) so the two can
 * never both correct the same growth and double it.
 *
 * It works the way the browsers' own does, and not by adding up what grew.
 * Measuring growth was the first attempt and it cannot answer the case this
 * page actually has: two figures side by side in one grid row both stretch when
 * either of them gains a row, so the same thirty pixels are reported twice, and
 * a figure growing *inside* the block the reader is reading does not change
 * that block's height at all. Holding on to one block instead settles both.
 * The block the top of the view is resting on is noted, with how far down the
 * view it sits; if layout ever puts it somewhere else, the difference is given
 * back to the scroll. Whatever moved it, and however many things moved it, the
 * reader ends up looking at what they were looking at.
 */

/**
 * The blocks a page offers to be held on to.
 *
 * Marking them is what gives the correction its aim. Left to the top-level
 * sections alone it is too coarse — a section that contains the whole view
 * cannot report that something inside it, above the reader, has grown — so a
 * page marks the pieces a reader actually reads to: a figure, a panel, a band.
 */
const STEADY = '[data-steady]'

export function useSteadyScroll<S extends HTMLElement, C extends HTMLElement>(): {
  /** the element that scrolls */
  scroller: React.RefObject<S | null>
  /** the block whose own children, and whose marked blocks, are held on to */
  content: React.RefObject<C | null>
} {
  const scroller = useRef<S>(null)
  const content = useRef<C>(null)

  useEffect(() => {
    const port = scroller.current
    const block = content.current
    if (!port || !block || typeof ResizeObserver === 'undefined') return

    /** what the view is resting on, and how far down the view it was resting */
    let held: { box: Element; offset: number } | null = null

    const blocks = (): Element[] => [...block.children, ...block.querySelectorAll(STEADY)]

    /*
     * The block under the top edge of the view.
     *
     * The deepest one, which is what makes a figure inside a band a better hold
     * than the band: of everything the edge has already passed, the one it
     * passed last. Nothing is held when the view is above them all, and then
     * the first block below the edge stands in.
     */
    const pick = () => {
      const top = port.getBoundingClientRect().top
      let under: { box: Element; offset: number } | null = null
      let next: { box: Element; offset: number } | null = null

      for (const box of blocks()) {
        const rect = box.getBoundingClientRect()
        /* already scrolled past: it cannot say where the reader is */
        if (rect.bottom <= top) continue
        const offset = rect.top - top
        if (offset <= 0) {
          if (!under || offset > under.offset) under = { box, offset }
        } else if (!next || offset < next.offset) {
          next = { box, offset }
        }
      }

      held = under ?? next
    }

    /* the correction itself: whatever layout has just done, the held block goes
       back to the height of the view it was at */
    const steady = () => {
      if (!held) return pick()
      if (!held.box.isConnected) return pick()

      const top = port.getBoundingClientRect().top
      const moved = held.box.getBoundingClientRect().top - top - held.offset
      /* under a pixel is layout rounding, and worth less than the interruption
         a write to `scrollTop` costs a scroll already in flight */
      if (Math.abs(moved) < 1) return
      port.scrollTop += moved
    }

    /* a scroll is the reader saying where they want to be, so it replaces the
       hold rather than being corrected against it */
    const onScroll = () => pick()

    const sizes = new ResizeObserver(steady)
    const watched = new Set<Element>()
    const watch = () => {
      for (const box of watched) if (!box.isConnected) { sizes.unobserve(box); watched.delete(box) }
      for (const box of blocks()) {
        if (watched.has(box)) continue
        watched.add(box)
        sizes.observe(box)
      }
    }

    /* the blocks are not all there at the start — the figures appear with the
       first entity, the board with the second speaker — so the list of what to
       watch is rebuilt when the page gains or loses one, once per frame however
       many turns land in it */
    let queued = 0
    const mounts = new MutationObserver(() => {
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        watch()
      })
    })

    pick()
    watch()
    sizes.observe(block)
    mounts.observe(block, { childList: true, subtree: true })
    port.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      if (queued) cancelAnimationFrame(queued)
      mounts.disconnect()
      sizes.disconnect()
      port.removeEventListener('scroll', onScroll)
    }
  }, [])

  return { scroller, content }
}
