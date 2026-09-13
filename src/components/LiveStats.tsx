import { memo, useCallback, useMemo, useState, type CSSProperties } from 'react'
import {
  analyse,
  components,
  normalise,
  type AnalysedTurn,
  type Component,
  type EntityStat,
  type SpeakerStat,
} from '../lib/analytics'
import { getTagSpec, tagColour } from '../lib/tags'
import LiveCharts from './LiveCharts'
import './LiveStats.css'

interface Props {
  /** the turns that have gone by so far, newest last */
  turns: AnalysedTurn[]
}

/** One entity type, counted every way the joint markup allows. */
interface EntityRow {
  type: string
  label: string
  /** every mention of the type, wherever it fell */
  mentions: number
  /** claims with at least one mention of this type inside them */
  claims: number
  /** premises with at least one mention of this type inside them */
  premises: number
  /** mentions that sit in no argument component at all */
  outside: number
}

/** Which column the entity table is ordered by. */
type Sort = 'mentions' | 'claims' | 'premises'

const SORTS: { key: Sort; label: string; hint: string }[] = [
  { key: 'mentions', label: 'mentions', hint: 'how often the type is named at all' },
  { key: 'claims', label: 'in claims', hint: 'how many claims name this type' },
  { key: 'premises', label: 'in premises', hint: 'how many premises name this type' },
]

/**
 * The three ways of narrowing the list, one shown at a time.
 *
 * `types` is the NER class - every PERSON, every DATE. `entities` is the name
 * itself, after aliases have been folded together, so "Obama" and "Barack
 * Obama" are one row. They answer different questions - "are dates argued
 * with, or only cited?" against "what is actually said about this person?" -
 * and a reader nearly always wants one or the other, never both at once.
 */
type Lens = 'speakers' | 'types' | 'entities'

/**
 * How several selected entity types are combined.
 *
 * `any` is the union - every component that names at least one of them - and is
 * what a reader means by "show me people and organizations". `all` is the
 * intersection, and it is the question this schema exists to answer: which
 * arguments put a PERSON and a DATE inside the same claim. A sequential
 * pipeline cannot be asked that at all, because by the time it has the
 * entities it has lost the span that contained them.
 */
type Match = 'any' | 'all'

/** Adds or removes one value, keeping the order things were picked in. */
function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

/**
 * What the debate adds up to, under the debate itself.
 *
 * Everything here is arithmetic over the annotations that have already
 * arrived - no model, no second pass - so it can be recomputed from scratch on
 * every turn and always agrees with what is on screen above it.
 *
 * Two panels, not three, and they are not three equal things to read: the left
 * one is the question - narrow by who said it, or by what it named - and the
 * right one is the answer, the components themselves. Three lists side by side
 * each scrolling inside its own slot made the reader do the arranging; here the
 * control is on the left, the result is on the right, and the sentence between
 * them says what the one has done to the other.
 */
export default function LiveStats({ turns }: Props) {
  /** the speakers the list is narrowed to; everyone, while it is empty */
  const [pickedSpeakers, setPickedSpeakers] = useState<string[]>([])
  const [kind, setKind] = useState<'all' | 'claim' | 'premise'>('all')
  /** the entity types the list is narrowed to; every type, while it is empty */
  const [pickedTypes, setPickedTypes] = useState<string[]>([])
  /** the named entities the list is narrowed to, by merged key */
  const [pickedEntities, setPickedEntities] = useState<string[]>([])
  /* how several of each are combined: union, or intersection. They are kept
     apart because the questions are different sizes - two types inside one
     claim is common, two particular names inside one claim is the finding */
  const [typeMatch, setTypeMatch] = useState<Match>('any')
  const [entityMatch, setEntityMatch] = useState<Match>('any')
  const [sort, setSort] = useState<Sort>('mentions')
  /** which of the three ways of narrowing is on screen */
  const [lens, setLens] = useState<Lens>('speakers')
  /* a real debate names a couple of hundred things; the list is ordered by how
     often, but finding one particular name in it is a search, not a scroll */
  const [find, setFind] = useState('')

  const stats = useMemo(() => analyse(turns), [turns])
  const said = useMemo(() => components(turns), [turns])

  /*
   * One table for the entities, not two.
   *
   * How often a type is named and how many components contain one are the same
   * list asked two questions, and splitting them over two panels meant reading
   * the same eight names twice to put them back together. They are columns of
   * one row here, which is also the only way to see the finding they add up
   * to: a type can be named constantly and still almost never be argued with.
   *
   * Components are counted, not mentions - a claim that names three people is
   * one claim that names a person, which is what "how many claims contain a
   * PERSON" asks. That is the question a sequential pipeline cannot answer at
   * all: by the time it finds the entities, the argument spans are gone.
   */
  const entities = useMemo(() => {
    const rows = new Map<string, EntityRow>()
    const row = (name: string) => {
      let found = rows.get(name)
      if (!found) {
        found = {
          type: name,
          label: getTagSpec(name)?.label ?? name,
          mentions: 0,
          claims: 0,
          premises: 0,
          outside: 0,
        }
        rows.set(name, found)
      }
      return found
    }

    for (const component of said) {
      /* de-duplicated per component: the unit being counted is the component */
      for (const name of new Set(component.mentions.map((mention) => mention.type))) {
        const entry = row(name)
        if (component.kind === 'claim') entry.claims += 1
        else entry.premises += 1
      }
    }

    /* a type named only outside every argument still belongs in the table -
       that it is never argued with is the finding, not a reason to hide it */
    for (const mention of stats.mentions) {
      const entry = row(mention.type)
      entry.mentions += 1
      if (mention.inside === null) entry.outside += 1
    }

    return [...rows.values()]
  }, [said, stats])

  const ordered = useMemo(
    () =>
      [...entities].sort(
        (a, b) => b[sort] - a[sort] || b.mentions - a.mentions || a.label.localeCompare(b.label),
      ),
    [entities, sort],
  )

  const speakers = useMemo(
    () => [...stats.speakers].sort((a, b) => b.claims + b.premises - (a.claims + a.premises) || b.turns - a.turns),
    [stats],
  )

  /* a speaker who has not spoken yet cannot stay selected, and neither can a
     type nobody has named - the debate arrives a turn at a time, so a
     selection can be made and then fall out from under itself */
  const onSpeakers = useMemo(() => {
    const known = new Set(speakers.map((speaker) => speaker.speaker))
    return pickedSpeakers.filter((name) => known.has(name))
  }, [pickedSpeakers, speakers])

  const onTypes = useMemo(() => {
    const known = new Set(entities.map((entry) => entry.type))
    return pickedTypes.filter((name) => known.has(name))
  }, [pickedTypes, entities])

  const onEntities = useMemo(() => {
    const known = new Set(stats.entities.map((entity) => entity.key))
    return pickedEntities.filter((key) => known.has(key))
  }, [pickedEntities, stats])

  const speakerSet = useMemo(() => new Set(onSpeakers), [onSpeakers])
  const typeSet = useMemo(() => new Set(onTypes), [onTypes])
  const entitySet = useMemo(() => new Set(onEntities), [onEntities])

  /*
   * The surface a mention was said with, back to the entity it belongs to.
   *
   * `analyse` folds aliases together after the fact - "Obama" becomes "barack
   * obama" once the longer form has been seen - and it is that merged key the
   * entity table and the charts are built on. A component only carries the
   * words as they were spoken, so this is the one bridge between the two: it
   * is built from the mentions `analyse` has already keyed, which is what
   * keeps the filter and the figures talking about the same entity.
   */
  const keyOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const mention of stats.mentions) map.set(normalise(mention.surface), mention.key)
    return map
  }, [stats])

  const entityKey = useCallback(
    (surface: string) => keyOf.get(normalise(surface)) ?? normalise(surface),
    [keyOf],
  )

  /* each component with both of its keyings worked out once, rather than on
     every keystroke of every filter */
  const rows = useMemo(
    () =>
      said.map((component, index) => ({
        /* its place in the debate, which does not move when a filter narrows
           the list - an index into the *filtered* list was changing the React
           key of every row below whichever one was dropped, so narrowing threw
           away and rebuilt the list it was narrowing */
        id: index,
        component,
        types: new Set(component.mentions.map((mention) => mention.type)),
        keys: new Set(component.mentions.map((mention) => keyOf.get(normalise(mention.surface)) ?? normalise(mention.surface))),
      })),
    [said, keyOf],
  )

  const shown = useMemo(
    () =>
      rows.filter(({ component, types, keys }) => {
        if (speakerSet.size && !speakerSet.has(component.speaker)) return false
        if (kind !== 'all' && component.kind !== kind) return false

        if (typeSet.size) {
          const hit =
            typeMatch === 'any' ? onTypes.some((type) => types.has(type)) : onTypes.every((type) => types.has(type))
          if (!hit) return false
        }

        if (entitySet.size) {
          const hit =
            entityMatch === 'any' ? onEntities.some((key) => keys.has(key)) : onEntities.every((key) => keys.has(key))
          if (!hit) return false
        }

        return true
      }),
    [rows, speakerSet, kind, typeSet, onTypes, typeMatch, entitySet, onEntities, entityMatch],
  )

  /* one scale for every speaker, and one for the column being ranked: a bar is
     only worth reading against the others, and it can only be read against
     them if they are all measured from the same zero to the same maximum */
  const mostComponents = Math.max(1, ...speakers.map((s) => s.claims + s.premises))
  const mostOfAType = Math.max(1, ...entities.map((entry) => entry[sort]))
  const mostOfAnEntity = Math.max(1, ...stats.entities.map((entity) => entity.total))

  /* the entity list as it is being read: everything, or what matches the
     search - with whatever is currently held always kept in view, so a filter
     never hides the thing it is filtering by */
  const foundEntities = useMemo(() => {
    const needle = find.trim().toLowerCase()
    if (!needle) return stats.entities
    return stats.entities.filter(
      (entity) => entitySet.has(entity.key) || entity.label.toLowerCase().includes(needle),
    )
  }, [stats, find, entitySet])

  const claimsMade = said.filter((component) => component.kind === 'claim').length
  const premisesMade = said.length - claimsMade
  const narrowed = Boolean(onSpeakers.length || onTypes.length || onEntities.length || kind !== 'all')

  const pickEntity = useCallback((key: string) => setPickedEntities((list) => toggle(list, key)), [])

  function clear() {
    setPickedSpeakers([])
    setPickedTypes([])
    setPickedEntities([])
    setKind('all')
  }

  /*
   * A pair pressed in the co-occurrence figure is a question with one answer:
   * the components that hold both names. So it takes both keys, switches the
   * combination to the intersection, and moves the panel to the list it just
   * changed - a filter the reader cannot see them set is a filter they will
   * read the result of as the whole debate.
   */
  const pickPair = useCallback((a: string, b: string) => {
    setPickedEntities((list) => [...new Set([...list, a, b])])
    setEntityMatch('all')
    setLens('entities')
  }, [])

  return (
    <section className="stats" aria-label="Running statistics">
      <header className="stats__head">
        <div>
          <span className="eyebrow">Running totals</span>
          <h2 className="display stats__title">What the debate adds up to</h2>
        </div>
        <p className="stats__lead">
          Counted from the annotations already on screen above - and counted again
          every time a turn lands.
        </p>
      </header>

      {/* the headline numbers, across the top of the band */}
      <ul className="tallies">
        <Tally value={stats.turns} label="turns" of="spoken so far" />
        <Tally
          value={stats.speakers.length}
          label={stats.speakers.length === 1 ? 'speaker' : 'speakers'}
          of="on the floor"
        />
        <Tally value={claimsMade} label="claims" of="things asserted" />
        <Tally value={premisesMade} label="premises" of="reasons given for them" />
        <Tally value={stats.totalMentions} label="mentions" of="people, places, dates…" />
      </ul>

      <div className="stats__row">
        {/*
          The left panel asks the question.

          Both ways of narrowing - by who was speaking, by what was named - are
          the same act, so they share one panel and one heading that says what
          pressing a row will do. Only one is on screen at a time, which is what
          gives the entity table the width its five columns need, and what
          leaves the reader with one list to scroll rather than two.

          Every row is a checkbox, not a radio: several speakers and several
          entity types can be held at once, because the questions worth asking
          of a debate are nearly always about more than one of either.
        */}
        <section className="cell cell--pick">
          <div className="cell__top">
            <h3 className="cell__head">Narrow the view</h3>
            <span className="cell__hint">press rows to filter · pick as many as you like</span>
          </div>

          <div className="lens" role="tablist" aria-label="Narrow the view by">
            <button
              type="button"
              role="tab"
              id="lens-speakers"
              aria-selected={lens === 'speakers'}
              aria-controls="lens-panel"
              className={`lens__tab${lens === 'speakers' ? ' is-on' : ''}`}
              onClick={() => setLens('speakers')}
            >
              Speakers
              <span className="lens__n">{speakers.length}</span>
              {onSpeakers.length > 0 && <span className="lens__on">{onSpeakers.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              id="lens-types"
              aria-selected={lens === 'types'}
              aria-controls="lens-panel"
              className={`lens__tab${lens === 'types' ? ' is-on' : ''}`}
              onClick={() => setLens('types')}
            >
              Entity types
              <span className="lens__n">{entities.length}</span>
              {onTypes.length > 0 && <span className="lens__on">{onTypes.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              id="lens-entities"
              aria-selected={lens === 'entities'}
              aria-controls="lens-panel"
              className={`lens__tab${lens === 'entities' ? ' is-on' : ''}`}
              onClick={() => setLens('entities')}
            >
              Named entities
              <span className="lens__n">{stats.entities.length}</span>
              {onEntities.length > 0 && <span className="lens__on">{onEntities.length}</span>}
            </button>
          </div>

          <div
            className="lens__panel"
            role="tabpanel"
            id="lens-panel"
            aria-labelledby={`lens-${lens}`}
          >
            {lens === 'speakers' ? (
              <>
                <p className="cell__note">
                  One scale for everyone, so the lengths compare. Pick two and the list on the right holds both -
                  which is how one speaker's argument is read against another's.
                </p>

                {/* two series, so the legend is always there and every count is
                    also written out - identity never rests on the colour alone */}
                <ul className="key" aria-hidden="true">
                  <li className="key__item key__item--claim">Claim</li>
                  <li className="key__item key__item--premise">Premise</li>
                </ul>

                {!speakers.length && <p className="cell__empty">No turn has gone by yet.</p>}

                <ul className="speakers" data-scroll>
                  {speakers.map((speaker) => (
                    <Speaker
                      key={speaker.speaker}
                      speaker={speaker}
                      scale={mostComponents}
                      on={speakerSet.has(speaker.speaker)}
                      anyOn={onSpeakers.length > 0}
                      onPick={() => setPickedSpeakers((list) => toggle(list, speaker.speaker))}
                    />
                  ))}
                </ul>
              </>
            ) : lens === 'types' ? (
              <>
                <p className="cell__note">
                  {stats.totalMentions} mention{stats.totalMentions === 1 ? '' : 's'} in all,{' '}
                  {stats.groundedMentions} of them inside a claim or a premise. Press a heading to reorder, a row
                  to filter - take several and choose whether a component must name <em>any</em> of them or{' '}
                  <em>all</em>.
                </p>

                {!ordered.length && <p className="cell__empty">Nothing named yet.</p>}

                {ordered.length > 0 && (
                  <div className="table" data-scroll>
                    <div className="table__head">
                      <span className="table__label">entity</span>
                      {SORTS.map((column) => (
                        <button
                          type="button"
                          key={column.key}
                          className={`table__sort${sort === column.key ? ' is-on' : ''}`}
                          onClick={() => setSort(column.key)}
                          aria-pressed={sort === column.key}
                          title={`Order by ${column.hint}`}
                        >
                          {column.label}
                          <span className="table__caret" aria-hidden="true">
                            ▾
                          </span>
                        </button>
                      ))}
                      <span
                        className="table__label table__label--last"
                        title="mentions that sit in no argument at all"
                      >
                        outside
                      </span>
                    </div>

                    {ordered.map((entry) => (
                      <button
                        type="button"
                        key={entry.type}
                        className={`table__row${typeSet.has(entry.type) ? ' is-on' : ''}`}
                        style={{ ['--tag-color' as string]: tagColour(entry.type) } as CSSProperties}
                        onClick={() => setPickedTypes((list) => toggle(list, entry.type))}
                        aria-pressed={typeSet.has(entry.type)}
                        title={`${entry.label}: named ${entry.mentions} time${entry.mentions === 1 ? '' : 's'}; inside ${entry.claims} of ${claimsMade} claims and ${entry.premises} of ${premisesMade} premises; ${entry.outside} outside any argument`}
                      >
                        <span className="table__name">
                          {/* the swatch is also the checkbox: it carries the
                              colour the tag is drawn in everywhere else, and
                              it is ticked when the type is one of the ones
                              being held */}
                          <span className="table__key" aria-hidden="true" />
                          <span className="table__text">{entry.label}</span>
                        </span>
                        {/* the ranked column carries the bar: length answers the
                            question the table is sorted by, and the other two stay
                            the figures they are. Three sets of stubs side by side
                            would say less than one set of lengths. */}
                        <Figure
                          value={entry.mentions}
                          bar={sort === 'mentions' ? entry.mentions / mostOfAType : null}
                        />
                        <Figure
                          value={entry.claims}
                          bar={sort === 'claims' ? entry.claims / mostOfAType : null}
                          tone="claim"
                        />
                        <Figure
                          value={entry.premises}
                          bar={sort === 'premises' ? entry.premises / mostOfAType : null}
                          tone="premise"
                        />
                        <span className="table__loose">{entry.outside}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="cell__note">
                  The names themselves, with aliases folded together - “Obama” and “Barack Obama” are one row.
                  Each bar is how that name was used: advanced inside a claim, offered inside a premise, or merely
                  said. Take two and switch to <em>all</em> for the components that name both.
                </p>

                {stats.entities.length > 0 && (
                  <div className="find">
                    <input
                      className="find__input"
                      type="search"
                      value={find}
                      onChange={(event) => setFind(event.target.value)}
                      placeholder="Find a name…"
                      aria-label="Search the named entities"
                    />
                    <span className="find__count">
                      {find.trim() ? `${foundEntities.length} of ${stats.entities.length}` : `${stats.entities.length} names`}
                    </span>
                  </div>
                )}

                <ul className="key" aria-hidden="true">
                  <li className="key__item key__item--claim">In a claim</li>
                  <li className="key__item key__item--premise">In a premise</li>
                  <li className="key__item key__item--outside">Outside</li>
                </ul>

                {!stats.entities.length && <p className="cell__empty">Nothing named yet.</p>}

                {stats.entities.length > 0 && !foundEntities.length && (
                  <p className="cell__empty">No name matches “{find.trim()}”.</p>
                )}

                <ul className="named" data-scroll>
                  {foundEntities.map((entity) => (
                    <Named
                      key={entity.key}
                      entity={entity}
                      scale={mostOfAnEntity}
                      on={entitySet.has(entity.key)}
                      onPick={() => setPickedEntities((list) => toggle(list, entity.key))}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>

        {/* what was actually said: the cell the panel on the left leads to */}
        <section className="cell cell--said">
          <div className="cell__top">
            <h3 className="cell__head">
              What was argued
              <span className="cell__count">
                {shown.length}
                <span className="cell__count-of">of {said.length}</span>
              </span>
            </h3>
            <span className="said__filters">
              {(['all', 'claim', 'premise'] as const).map((option) => (
                <button
                  type="button"
                  key={option}
                  className={`toggle${kind === option ? ' is-on' : ''}`}
                  onClick={() => setKind(option)}
                  aria-pressed={kind === option}
                >
                  {option === 'all' ? 'Both' : option === 'claim' ? 'Claims' : 'Premises'}
                </button>
              ))}
            </span>
          </div>

          {/*
            What the list is showing, in a sentence, directly over the list it
            is describing.

            Every narrowing is done by pressing a row in the panel to the left,
            and a pressed row is a quiet thing at this size. Writing the state
            out where the effect is - and giving every part of it a way back -
            is what stops a filtered list from being read as the whole debate.
          */}
          <div className={`showing${narrowed ? ' is-narrowed' : ''}`}>
            {!narrowed ? (
              <p className="showing__all">
                Everything argued so far. Press a speaker or an entity type to narrow it.
              </p>
            ) : (
              <ul className="picks">
                {onSpeakers.length > 0 && (
                  <ChipGroup
                    label={onSpeakers.length > 1 ? 'said by any of' : 'said by'}
                    items={onSpeakers.map((name) => ({ key: name, label: name }))}
                    onDrop={(name) => setPickedSpeakers((list) => toggle(list, name))}
                  />
                )}

                {onTypes.length > 0 && (
                  <ChipGroup
                    label="naming a"
                    verb="naming"
                    /* the switch only exists once there is something to combine */
                    match={onTypes.length > 1 ? typeMatch : undefined}
                    onMatch={() => setTypeMatch((value) => (value === 'any' ? 'all' : 'any'))}
                    items={onTypes.map((type) => ({
                      key: type,
                      label: getTagSpec(type)?.label ?? type,
                      colour: tagColour(type),
                    }))}
                    onDrop={(type) => setPickedTypes((list) => toggle(list, type))}
                  />
                )}

                {onEntities.length > 0 && (
                  <ChipGroup
                    label="mentioning"
                    verb="mentioning"
                    match={onEntities.length > 1 ? entityMatch : undefined}
                    onMatch={() => setEntityMatch((value) => (value === 'any' ? 'all' : 'any'))}
                    items={onEntities.map((key) => {
                      const entity = stats.entities.find((entry) => entry.key === key)
                      return {
                        key,
                        label: entity?.label ?? key,
                        colour: entity ? tagColour(entity.type) : undefined,
                      }
                    })}
                    onDrop={(key) => setPickedEntities((list) => toggle(list, key))}
                  />
                )}

                {kind !== 'all' && (
                  <ChipGroup
                    label="only"
                    items={[
                      {
                        key: kind,
                        label: kind === 'claim' ? 'claims' : 'premises',
                        colour: kind === 'claim' ? 'var(--tag-claim)' : 'var(--tag-premise)',
                      },
                    ]}
                    onDrop={() => setKind('all')}
                  />
                )}

                <li>
                  <button type="button" className="picks__clear" onClick={clear}>
                    Clear all
                  </button>
                </li>
              </ul>
            )}
          </div>

          <Argued
            rows={shown}
            typeSet={typeSet}
            entitySet={entitySet}
            entityKey={entityKey}
            empty={
              !narrowed
                ? 'Nothing yet - the debate is still arriving.'
                : (onTypes.length > 1 && typeMatch === 'all') || (onEntities.length > 1 && entityMatch === 'all')
                  ? 'No single component holds all of those at once. Switch the filter to “any”, or drop one of them.'
                  : 'Nothing matches that yet - clear a filter above, or wait for more of the debate.'
            }
          />
        </section>
      </div>

      {/*
        The same aggregation, cut four more ways.

        These figures were only ever on the Analytics page, over a transcript
        that had already finished - so the one view where the numbers are
        actually moving was the one view that could not show them. They are
        drawn from the `stats` above, which is recomputed on every turn, so
        they arrive with the turn and cannot disagree with the panels.
      */}
      <LiveCharts stats={stats} picked={entitySet} onPickEntity={pickEntity} onPickPair={pickPair} />
    </section>
  )
}

/** One component of the debate, as the list shows it. */
interface ArguedRow {
  id: number
  component: Component
}

/**
 * What was argued, memoised on the filtered list itself.
 *
 * The panel around it holds a search box, a tab and a set of toggles, and none
 * of those change which components are shown - but every keystroke was
 * rebuilding all of them, mentions and all. `shown` is a memo of its own, so
 * comparing it is one reference: type in the entity search and this list is
 * skipped entirely.
 */
const Argued = memo(function Argued({
  rows,
  typeSet,
  entitySet,
  entityKey,
  empty,
}: {
  rows: ArguedRow[]
  typeSet: ReadonlySet<string>
  entitySet: ReadonlySet<string>
  entityKey: (surface: string) => string
  empty: string
}) {
  return (
    <ol className="said" data-scroll>
      {!rows.length && <li className="cell__empty">{empty}</li>}

      {rows.map(({ id, component }) => (
        <li className={`said__item said__item--${component.kind}`} key={id}>
          <div className="said__meta">
            <span className={`said__kind said__kind--${component.kind}`}>{component.kind}</span>
            <span className="said__speaker">{component.speaker}</span>
            <span className="said__turn">Turn {component.turn + 1}</span>
          </div>

          <p className="said__text">{component.text}</p>

          {component.mentions.length > 0 && (
            <ul className="said__named">
              {component.mentions.map((mention, m) => (
                <li
                  className={`said__mention${
                    typeSet.has(mention.type) || entitySet.has(entityKey(mention.surface)) ? ' is-hit' : ''
                  }`}
                  key={`${mention.surface}-${m}`}
                  style={{ ['--tag-color' as string]: tagColour(mention.type) } as CSSProperties}
                  title={getTagSpec(mention.type)?.label ?? mention.type}
                >
                  {mention.surface}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
})

/** One value being held, with the way to let go of it. */
interface ChipItem {
  key: string
  label: string
  colour?: string
}

/**
 * One narrowing, named and undoable - however many values it holds.
 *
 * A filter that can carry several values is written as one phrase with several
 * names in it, not as one filter per name: "naming any of PERSON, DATE" is the
 * sentence the reader has in mind, and repeating the label in front of every
 * name says the same thing three times. When there is more than one name the
 * label becomes the switch between the union and the intersection, because
 * that is exactly where the question is asked.
 */
function ChipGroup({
  label,
  verb,
  items,
  match,
  onMatch,
  onDrop,
}: {
  label: string
  /** the word the any/all switch is built on, once there are several values */
  verb?: string
  items: ChipItem[]
  match?: Match
  onMatch?: () => void
  onDrop: (key: string) => void
}) {
  return (
    <li className="pick">
      {match && onMatch ? (
        <button
          type="button"
          className="pick__match"
          onClick={onMatch}
          title={
            match === 'any'
              ? 'Showing components that hold at least one of these - press for the ones that hold all of them'
              : 'Showing components that hold all of these at once - press for the ones that hold at least one'
          }
        >
          {verb ?? label} <strong>{match}</strong> of
        </button>
      ) : (
        <span className="pick__label">{label}</span>
      )}

      <span className="pick__values">
        {items.map((item) => (
          <span
            key={item.key}
            className="pick__value"
            style={item.colour ? ({ ['--tag-color' as string]: item.colour } as CSSProperties) : undefined}
          >
            {item.label}
            <button
              type="button"
              className="pick__x"
              onClick={() => onDrop(item.key)}
              aria-label={`Stop filtering by “${item.label}”`}
            >
              ×
            </button>
          </span>
        ))}
      </span>
    </li>
  )
}

/**
 * One figure in the entity table, with a bar behind it when its column is the
 * one the table is ordered by.
 */
function Figure({ value, bar, tone }: { value: number; bar: number | null; tone?: 'claim' | 'premise' }) {
  return (
    <span className={`figure${bar === null ? '' : ' figure--ranked'}`}>
      {bar !== null && (
        <span className="figure__track" aria-hidden="true">
          <span className={`figure__bar${tone ? ` figure__bar--${tone}` : ''}`} style={{ width: `${bar * 100}%` }} />
        </span>
      )}
      <span className="figure__n">{value}</span>
    </span>
  )
}

/**
 * One speaker: how much they have argued, what it was made of, and the way
 * into the words themselves.
 *
 * The whole block is the target rather than a link inside it - the number and
 * the bar are what raise the question, so they are what answers it - and it
 * carries a box that is ticked when the speaker is one of the ones being held,
 * because a row that does something and looks like a caption is a row nobody
 * presses.
 */
function Speaker({
  speaker,
  scale,
  on,
  anyOn,
  onPick,
}: {
  speaker: SpeakerStat
  scale: number
  on: boolean
  /** whether any speaker at all is selected, which is what makes this one a
      row to *add* rather than a row to start from */
  anyOn: boolean
  onPick: () => void
}) {
  const said = speaker.claims + speaker.premises
  const width = (said / scale) * 100
  const cue = on ? 'in view' : anyOn ? 'add' : 'read these'

  return (
    <li className="speaker">
      <button
        type="button"
        className={`speaker__row${on ? ' is-open' : ''}`}
        onClick={onPick}
        aria-pressed={on}
        title={on ? `Stop showing ${speaker.speaker}` : `Read what ${speaker.speaker} argued`}
      >
        <span className="speaker__head">
          <span className="speaker__mark" aria-hidden="true" />
          <span className="speaker__name">{speaker.speaker}</span>
          <span className="speaker__turns">
            {speaker.turns} {speaker.turns === 1 ? 'turn' : 'turns'}
          </span>
        </span>

        <span className="speaker__track">
          <span className="speaker__bar" style={{ width: `${width}%` }}>
            {speaker.claims > 0 && (
              <span className="speaker__seg speaker__seg--claim" style={{ flexGrow: speaker.claims }} />
            )}
            {speaker.premises > 0 && (
              <span className="speaker__seg speaker__seg--premise" style={{ flexGrow: speaker.premises }} />
            )}
          </span>
        </span>

        <span className="speaker__counts">
          <span className="count count--claim">
            <strong>{speaker.claims}</strong> claim{speaker.claims === 1 ? '' : 's'}
          </span>
          <span className="count count--premise">
            <strong>{speaker.premises}</strong> premise{speaker.premises === 1 ? '' : 's'}
          </span>
          <span className="count">
            <strong>{speaker.mentions}</strong> named
          </span>
          <span className="speaker__cue" aria-hidden="true">
            {cue}
          </span>
        </span>
      </button>
    </li>
  )
}

/**
 * One named entity: how often it was said, and what it was said inside.
 *
 * The type table above answers "are dates argued with at all"; this answers
 * "what happens to *this* name" - and the bar is the same three-part reading
 * the analytics deck gives it, so the row and the figure below the band say
 * the same thing about the same entity.
 */
function Named({
  entity,
  scale,
  on,
  onPick,
}: {
  entity: EntityStat
  scale: number
  on: boolean
  onPick: () => void
}) {
  const spec = getTagSpec(entity.type)

  return (
    <li>
      <button
        type="button"
        className={`named__row${on ? ' is-on' : ''}`}
        style={{ ['--tag-color' as string]: tagColour(entity.type) } as CSSProperties}
        onClick={onPick}
        aria-pressed={on}
        title={`${entity.label} · ${spec?.label ?? entity.type}: named ${entity.total} time${
          entity.total === 1 ? '' : 's'
        } - ${entity.claim} inside a claim, ${entity.premise} inside a premise, ${entity.outside} outside any argument`}
      >
        <span className="named__head">
          <span className="named__mark" aria-hidden="true" />
          <span className="named__name">{entity.label}</span>
          <span className="named__type">{spec?.short ?? entity.type}</span>
          <span className="named__total">{entity.total}</span>
        </span>

        <span className="named__track" style={{ ['--fill' as string]: `${(entity.total / scale) * 100}%` }}>
          <NamedSeg part={entity.claim} whole={entity.total} tone="claim" />
          <NamedSeg part={entity.premise} whole={entity.total} tone="premise" />
          <NamedSeg part={entity.outside} whole={entity.total} tone="outside" />
        </span>
      </button>
    </li>
  )
}

function NamedSeg({ part, whole, tone }: { part: number; whole: number; tone: string }) {
  if (part <= 0) return null
  return <span className={`named__seg named__seg--${tone}`} style={{ width: `${(part / whole) * 100}%` }} />
}

function Tally({ value, label, of }: { value: number; label: string; of: string }) {
  return (
    <li className="tally">
      <span className="tally__value">{value}</span>
      <span className="tally__label">{label}</span>
      <span className="tally__of">{of}</span>
    </li>
  )
}
