import { tagColour, tagsOfKind } from '../lib/tags'
import './TagLegend.css'

/** Colour key for the inline markup, shared by every view. */
export default function TagLegend() {
  return (
    <div className="legend">
      <LegendGroup title="Argument components" tags={tagsOfKind('argument')} />
      <LegendGroup title="Debate named entities" tags={tagsOfKind('entity')} />
      
    </div>
  )
}

function LegendGroup({ title, tags }: { title: string; tags: { name: string; label: string }[] }) {
  return (
    <div className="legend__group">
      <span className="legend__title">{title}</span>
      {tags.map((tag) => (
        <span
          key={tag.name}
          className="legend__item"
          style={{ ['--tag-color' as string]: tagColour(tag.name) }}
        >
          {tag.label}
        </span>
      ))}
    </div>
  )
}
