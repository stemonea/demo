import { useCallback, useEffect, useRef, useState } from 'react'

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

/** How near the foot still counts as being at it. */
const AT_END = 48

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

  const behind = following ? 0 : Math.max(0, count - anchor)

  useEffect(() => {
    const node = box.current
    if (node && following) node.scrollTop = node.scrollHeight
  }, [count, following])

  const onScroll = useCallback(() => {
    const node = box.current
    if (!node) return
    const atEnd = node.scrollHeight - node.clientHeight - node.scrollTop < AT_END
    if (atEnd === followingRef.current) return

    followingRef.current = atEnd
    /* leaving the end is what fixes the mark the count is read against. Set
       here rather than inside the updater above: an updater has to be a pure
       function of the value it is given, and React is free to run it twice. */
    if (!atEnd) setAnchor(count)
    setFollowing(atEnd)
  }, [count])

  const jump = useCallback(() => {
    const node = box.current
    if (node) node.scrollTop = node.scrollHeight
    followingRef.current = true
    setFollowing(true)
  }, [])

  return { box, onScroll, behind, jump }
}

/**
 * Keeps a reader's place while a block above them changes size.
 *
 * The watcher's page is not only the feed: under it are the ballot, the running
 * totals and the figures, and every one of them is redrawn when a turn lands.
 * They do not merely redraw, they *resize* — the ballot opens from one line
 * into a board the moment a second name has argued, the figures replace a
 * sentence with three charts as soon as an entity is named inside one, the
 * timeline takes another column. A reader who has scrolled down to any of that
 * is reading below the blocks that just grew, so the page slides under them and
 * what they were reading is pushed off the bottom: the view appears to jump
 * back up on its own, and it does it again on the next turn.
 *
 * Browsers have a name for the fix — scroll anchoring — and Safari does not
 * implement it at all, which is why this shows up on one machine and not the
 * next. So it is done here rather than hoped for, and the scroller it is done
 * on turns the native mechanism off (`overflow-anchor: none`) so the two can
 * never both correct the same growth and double it.
 *
 * Only what is wholly above the reader moves the reader: a block that grows
 * while it is on screen is growth they can see, and shifting the scroll to hide
 * it would be the jump rather than the cure.
 */
export function useSteadyScroll<S extends HTMLElement, C extends HTMLElement>(): {
  /** the element that scrolls */
  scroller: React.RefObject<S | null>
  /** the block whose own children are the ones watched for a change of height */
  content: React.RefObject<C | null>
} {
  const scroller = useRef<S>(null)
  const content = useRef<C>(null)

  useEffect(() => {
    const port = scroller.current
    const block = content.current
    if (!port || !block || typeof ResizeObserver === 'undefined') return

    /* what each block measured when it was last looked at */
    const heights = new WeakMap<Element, number>()

    const observer = new ResizeObserver((entries) => {
      const top = port.getBoundingClientRect().top
      let shift = 0

      for (const entry of entries) {
        const box = entry.target as HTMLElement
        const rect = box.getBoundingClientRect()
        const was = heights.get(box)
        heights.set(box, rect.height)
        /* the first callback is the measurement, not a change */
        if (was === undefined) continue

        const grew = rect.height - was
        if (!grew) continue

        /* where its foot stood before it changed, down the length of the
           scroller: the observer runs after layout, so the rect is already the
           new one and the growth has to be taken back out */
        const foot = rect.bottom - top + port.scrollTop - grew
        if (foot <= port.scrollTop) shift += grew
      }

      if (shift) port.scrollTop += shift
    })

    for (const child of block.children) observer.observe(child)
    return () => observer.disconnect()
  }, [])

  return { scroller, content }
}
