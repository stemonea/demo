import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import './styles/appearance.css'

/**
 * A tab left open across a deploy.
 *
 * The build is split: the QR encoder is fetched only when there is a code to
 * draw, which is what keeps ten kilobytes of Reed-Solomon out of the common
 * case. The file names carry a hash of their contents, so a new deploy writes
 * new names and removes the old ones - and a page that was loaded *before* that
 * deploy is still holding the old names. The moment it reaches for a piece it
 * has not fetched yet, the piece is gone: `Failed to fetch dynamically imported
 * module`, and, because the import happens under `Suspense` with nothing
 * catching it, the view goes with it.
 *
 * It is not a rare corner on this site. GitHub Pages serves the entry document
 * with ten minutes of cache, a session is meant to be left running while people
 * scan into it, and the code is drawn from the one chunk that is loaded late.
 * A presenter with the page already open when a deploy lands is exactly the
 * person this breaks.
 *
 * Vite reports it rather than leaving it to be guessed at, and the answer is to
 * fetch the document again: the new one names the files that exist. Once, and
 * recorded in `sessionStorage`, because reloading is only the answer when the
 * chunk is missing - offline, it would be a loop, and a loop is worse than the
 * error it is trying to fix.
 */
const RELOADED = 'jaet.stale-build-reloaded'

window.addEventListener('vite:preloadError', (event) => {
  let reloaded = false
  try {
    reloaded = window.sessionStorage.getItem(RELOADED) === '1'
    window.sessionStorage.setItem(RELOADED, '1')
  } catch {
    /* storage refused: one reload is still better than a dead view, and
       without a record this can happen at most once per navigation anyway */
  }
  if (reloaded) return
  /* nothing is lost by reloading here: the module never arrived */
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
