import './Notice.css'

/**
 * The box the app says "that did not work" in.
 *
 * There was one of these on four screens and they were four boxes: a red bar
 * on the live page, a red bar of another height on the analysis rail, a tinted
 * slab in the bench, a panel in the playground. Same job, same words now, four
 * appearances - so this is the box, once.
 *
 * It is built the way a system alert is built rather than the way a web error
 * is. The colour is carried by a mark, not by the words: red text is the first
 * thing an interface does to shout, and it is harder to read at exactly the
 * moment somebody has to read carefully. So the sentence stays in ordinary
 * ink on a tint of the tone, inside a hairline, and the only saturated thing
 * is a symbol the size of a capital letter.
 *
 * The two sentences are set as two lines, which is what `lib/failure.ts`
 * writes them as: what happened, then what to do. The split is made here
 * rather than asked of every caller, so the copy stays one string everywhere
 * it is written and still lands as a headline with a line under it.
 */

interface Props {
  /** an eyebrow over the sentence, where the failure has a name worth heading */
  title?: string
  /** what happened, and what to do about it */
  children: string
  /** the one move that can be made from here */
  action?: { label: string; onClick: () => void }
  /**
   * `bad` is something that did not happen and has to be dealt with; `warn` is
   * something worth knowing that has not stopped anybody. A live session uses
   * the second even for a refused microphone: the debate is still running, and
   * a red page in front of a room is a louder statement than the fact deserves.
   */
  tone?: 'bad' | 'warn'
}

/**
 * The end of the first sentence, when a capital or an opening quote follows it.
 *
 * A lookahead rather than a lookbehind, which older Safari does not have, and
 * a capital rather than any character so that `.txt`, `0.25 s` and a file
 * called `notes.final.txt` are not mistaken for the end of a thought.
 */
const SENTENCE_END = /\.\s+(?=[“"A-Z])/

function split(said: string): [string, string | null] {
  const at = said.search(SENTENCE_END)
  if (at === -1) return [said, null]
  return [said.slice(0, at + 1), said.slice(at + 1).trim()]
}

export default function Notice({ title, children, action, tone = 'bad' }: Props) {
  const [said, then] = split(children)

  return (
    <div
      className={`notice notice--${tone}`}
      /* a refusal interrupts; something merely worth knowing is announced and
         left for the reader to reach in their own time */
      role={tone === 'bad' ? 'alert' : 'status'}
    >
      {/* the only saturated thing in the box, and the size of a capital */}
      <svg className="notice__mark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle className="notice__disc" cx="10" cy="10" r="9" />
        <path className="notice__bang" d="M10 5.4v5.3" />
        <circle className="notice__dot" cx="10" cy="14.2" r="1" />
      </svg>

      <div className="notice__body">
        {title && <p className="notice__title">{title}</p>}
        <p className="notice__said">{said}</p>
        {then && <p className="notice__then">{then}</p>}
        {action && (
          <button type="button" className="btn btn--accent notice__action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}
