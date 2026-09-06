import TokenStream from './TokenStream'
import './TurnLoader.css'

/**
 * Waiting for a turn, drawn the way the home page draws generation: a band of
 * the same churning field, symbols settling into tags. It says what is actually
 * happening — the model is emitting this turn right now — instead of spinning.
 *
 * The field is short, so it reads as a status line rather than as a second
 * hero, and it is the same component: one animation, one idea.
 *
 * Its width is measured rather than declared. It used to be a flat 64 columns
 * wherever it appeared, which is a number that can only be right in one panel:
 * in the intake it stopped well short of the edge and read as a stray line of
 * text, and in the feed — a far wider box — it was a short band adrift in the
 * middle of it. Three rows is what makes it a status line; how many characters
 * fit across is the panel's business, so the panel is asked. `tagsAlive` goes
 * with it: the component works the hero's own density out from the size of the
 * grid, so a band that has grown wider surfaces proportionally more tags
 * instead of the same three thinning out across it.
 */
export default function TurnLoader({ label }: { label: string }) {
  return (
    <div className="loader" role="status">
      <TokenStream fit="width" cols={64} rows={3} tickMs={130} className="stream--loader" />
      <p className="loader__label">
        <span className="loader__dot" aria-hidden="true" />
        {label}
      </p>
    </div>
  )
}
