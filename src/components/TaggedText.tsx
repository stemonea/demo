import { memo, useMemo } from 'react'
import { parseTaggedText, type TagNode } from '../lib/parseTags'
import { filterLayer, type LayerView } from '../lib/view'
import { getTagSpec, tagColour } from '../lib/tags'
import './TaggedText.css'

interface Props {
  text: string
  /** `rendered` paints the spans, `raw` shows the literal markup */
  mode?: 'rendered' | 'raw'
  /** which annotation layer to display */
  view?: LayerView
}

/**
 * Memoised, because a live debate re-renders every turn already on screen
 * whenever a new one lands.
 *
 * The parse is already cached, but the elements were not: a turn of markup is
 * a tree of tagged spans, and rebuilding two hundred of those on every turn is
 * the work that makes the feed stutter while the debate runs. The props are a
 * string and two enums, so the comparison is exact and costs nothing.
 */
function TaggedText({ text, mode = 'rendered', view = 'all' }: Props) {
  const nodes = useMemo(() => filterLayer(parseTaggedText(text), view), [text, view])

  if (mode === 'raw') {
    return <pre className="tagged tagged--raw">{text}</pre>
  }

  return <p className="tagged">{nodes.map(renderNode)}</p>
}

function renderNode(node: TagNode, key: number) {
  if (node.type === 'text') return <span key={key}>{node.value}</span>

  if (node.type === 'orphan') {
    return (
      <span
        key={key}
        className="tagged__orphan"
        title={`Closing </${node.name}> without a matching opening tag`}
      >
        {node.raw}
      </span>
    )
  }

  const spec = getTagSpec(node.name)
  const classes = [
    'tagged__span',
    `tagged__span--${node.kind}`,
    node.unclosed ? 'tagged__span--unclosed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  /*
   * Where the type is written depends on how much of the text the span covers.
   * An argument component runs over a whole sentence, so it is opened by a label
   * that reads as its heading; an entity is a word or two, and a full label in
   * front of every one of them turns the turn into a list of labels — so it
   * carries a short code after it, the way a footnote marker would.
   */
  const label = spec?.label ?? node.name
  const code = spec?.short ?? node.name.toUpperCase()

  return (
    <span
      key={key}
      className={classes}
      data-tag={node.name}
      style={{ ['--tag-color' as string]: tagColour(node.name) }}
      title={node.unclosed ? `<${node.name}> is never closed` : label}
    >
      {node.kind !== 'entity' && <span className="tagged__label">{label}</span>}
      {node.children.map(renderNode)}
      {node.kind === 'entity' && <span className="tagged__code">{code}</span>}
      {node.unclosed && <span className="tagged__warn" aria-hidden="true">⚠</span>}
    </span>
  )
}

export default memo(TaggedText)
