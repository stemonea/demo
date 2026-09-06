import type { TagNode } from './parseTags'

/** Which annotation layer is currently displayed. */
export type LayerView = 'all' | 'argument' | 'entity'

export const LAYER_VIEWS: { id: LayerView; label: string }[] = [
  { id: 'all', label: 'Both layers' },
  { id: 'argument', label: 'Arguments only' },
  { id: 'entity', label: 'Entities only' },
]

/**
 * Hides the tags of the layer(s) the user switched off, keeping their inner text.
 * Applied client-side so the toggle is instant and does not need a round-trip.
 */
export function filterLayer(nodes: TagNode[], view: LayerView): TagNode[] {
  if (view === 'all') return nodes

  return nodes.flatMap((node) => {
    if (node.type !== 'tag') return [node]
    const children = filterLayer(node.children, view)
    if (node.kind === view) return [{ ...node, children }]
    return children
  })
}

/**
 * Hides the annotated components the reader switched off, keeping their inner
 * text. Same idea as `filterLayer`, one notch finer: the playground lets the
 * reader keep or drop each tag of the computed result individually.
 */
export function filterTags(nodes: TagNode[], active: ReadonlySet<string>): TagNode[] {
  return nodes.flatMap((node) => {
    if (node.type !== 'tag') return [node]
    const children = filterTags(node.children, active)
    if (active.has(node.name)) return [{ ...node, children }]
    return children
  })
}
