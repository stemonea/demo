import NavBar from './components/NavBar'
import HomePage from './pages/HomePage'
import WhyJointPage from './pages/WhyJointPage'
import LivePage from './pages/LivePage'
import LiveSessionPage from './pages/LiveSessionPage'
import AnalysisPage from './pages/AnalysisPage'
import ManualPage from './pages/ManualPage'
import PlaygroundPage from './pages/PlaygroundPage'
import { useCallback, useState } from 'react'
import { useHashParam, useRoute } from './lib/route'

export default function App() {
  const route = useRoute()
  /* the landing page runs bare while it sits on its first slide */
  const [homeSlide, setHomeSlide] = useState(0)
  /*
   * Whether the slide under the bar is one with a tone of its own.
   *
   * The bar paints no surface, which is what keeps it the colour of the page
   * everywhere else — and is exactly why it cannot follow a slide that is not
   * the page: the "Why joint?" slide is full-bleed green from just under the
   * bar down, and the bar stayed the light gradient above it, cutting a pale
   * strip across the top of the one slide meant to fill the window. So the
   * slide says when it is there and the bar takes the tone with it.
   */
  const [homeToned, setHomeToned] = useState(false)
  const bare = route === '/' && homeSlide === 0
  /* a shared session is one page somebody was sent, not an entry into the
     tool: it keeps the mark and loses the navigation */
  const watching = Boolean(useHashParam('session')) && route === '/livesession'

  /* stable, so the landing page's own effects do not re-run on every render */
  const onSlideChange = useCallback((index: number, toned: boolean) => {
    setHomeSlide(index)
    setHomeToned(toned)
  }, [])

  return (
    <div className="app">
      <NavBar route={route} bare={bare} toned={route === '/' && homeToned} locked={watching} />
      {route === '/why-joint' && <WhyJointPage />}
      {route === '/live' && <LivePage />}
      {route === '/livesession' && <LiveSessionPage />}
      {route === '/analysis' && <AnalysisPage />}
      {route === '/manual' && <ManualPage />}
      {route === '/playground' && <PlaygroundPage />}
      {route === '/' && <HomePage onSlideChange={onSlideChange} />}
    </div>
  )
}
