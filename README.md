# ArguStream

An interactive tool for annotating political debates as they are spoken: a single-pass tagger that
inserts argument components (`<claim>`, `<premise>`) and debate named entities (`<person>`,
`<location>`, …) into a turn at once, preserving the original transcript.

React + plain CSS. No UI framework, no router dependency. **The app is anonymous**: no author,
affiliation or venue appears anywhere in the code or the interface.

The landing page runs bare **while it sits on its first slide**: no menu in the top bar, no numbered
slide bar under the deck, and a `Scroll »` marker pinned to the right edge saying which way the page
goes. One scroll to the right and the two menus fade in while the marker fades out; scroll back and
it reverses. `SlideDeck` reports its active slide through `onIndexChange`, `App` holds that index so
the top bar can follow it, and both menus stay in the layout while hidden so revealing them never
shifts the slides.

**The page never scrolls down — it travels to the right.** Every page is a horizontal deck of
full-viewport slides ([`components/SlideDeck.tsx`](src/components/SlideDeck.tsx)): native overflow
scrolling (so touch swipe and the scrollbar keep working) plus mouse dragging, arrow keys /
Home / End and numbered slide navigation.

**One wheel gesture = one slide.** A notched mouse wheel emits ~100 px per click, so forwarding the
raw delta would need a dozen clicks to cross a full-viewport slide. Instead the deck accumulates the
delta (40 px threshold, `deltaMode` normalised for line- and page-based devices) and steps to the
neighbouring slide, then ignores further events for 550 ms so a trackpad flick never skips two
slides.

Regions that scroll on their own opt in with `data-scroll` (plus form controls, which are handled
automatically) — currently the comparison columns and the annotation output. Over one of those the
wheel scrolls the region until it reaches its end, and the deck takes over from there. Nothing else
absorbs the gesture: a slide is never allowed to swallow the wheel just because it happens to be a
few pixels too tall. Typing in a text field never moves the deck.

## Pages

| Route | Page | Content |
| --- | --- | --- |
| `#/` | `pages/HomePage.tsx` | 5 slides — the title over the live token field, then four cover slides: the whole slide is a link to **Playground**, **Live debate**, **Manual** and **Why joint?** |
| `#/why-joint` | `pages/WhyJointPage.tsx` | 6 slides — the two failure mechanisms, four reported turns split into three columns (**JOINT**, **AM → DNER**, **DNER → AM**), and **Your own turn**: the same three systems run on text the visitor types. |
| `#/live` | `pages/LivePage.tsx` | Turn-level streaming. Opens on the intake screen, which states the transcript format and takes the `.txt`; then the transcript is replayed one turn per request, with a look-ahead buffer computing turns behind the one on screen, running tag totals, per-turn latency and a session export. |
| `#/analysis` | `pages/AnalysisPage.tsx` | Debate analytics over the bundled excerpt or over a `.txt` transcript you load (the same format the live view reads): stat tiles, the speaker x entity matrix, entity profiles, a mention timeline, and the same aggregation recomputed on each system. |
| `#/livesession` | `pages/LiveSessionPage.tsx` | A debate as it is **spoken**: say who is about to talk, open the microphone, close it. The turn is transcribed and annotated before the next begins. Shareable — see **Rooms** — so a floor can watch it and vote in it. |
| `#/manual` | `pages/ManualPage.tsx` | Load a `.txt` transcript, declare your own entity set, annotate both layers by hand with a label menu that opens at the selection, export two-layer CoNLL. |
| `#/playground` | `pages/PlaygroundPage.tsx` | Playground: a single view that opens on an empty editor — write or paste a turn, it is sent to the service to be computed, and the result can then be filtered component by component, copied and exported. |

## Rooms

The spoken session can be watched by other people, and how far its link reaches
depends on whether there is a service behind it.

**With one** (`VITE_DEMO=0`), the room is minted on the service — `POST /room` —
and the session panel shows it as a **QR code** with the link underneath. Whoever
is in the room points a phone at it and lands on the debate as it is being
spoken; they can say which side they are on and change their mind as the debate
gives them reason to, and the panel counts how many people are watching, which is
the one figure that says the code is working. Read-only otherwise: nothing over
there reaches the session.

**Without one** (`VITE_DEMO=1`, the published build), the room is minted locally
and relayed between tabs of one browser over `BroadcastChannel`, exactly as
before. **No QR code is shown, deliberately.** A local room lives in this
browser's `localStorage`, so a phone that scanned it would open a page with no
debate in it — a code that scans perfectly and then fails is worse than no code.
The panel says where the link reaches instead, and it says a different sentence
for each case: a local room, a room on the service, a service that would not give
one, and a page served from `localhost` — where the link is real but means *this
machine* to anything that reads it. `npm run dev -- --host` is what puts it on
the network, and the panel says so rather than offering a code that cannot work.

Which transport is used is decided in one place per hook, on the shape of the
session id: `local-…` is relayed between tabs, `r-…` is a room the service is
holding. The four hooks — `usePublishRun` and `useWatchRun` in
[`lib/localSession.ts`](src/lib/localSession.ts), `useBallot` and `useVotes` in
[`lib/poll.ts`](src/lib/poll.ts) — keep their signatures and their call sites
either way, and [`lib/room.ts`](src/lib/room.ts) is the network half and nothing
else. The view watching a debate cannot tell the two apart, which is what keeps
the published build and the served build the same page.

A room takes only the turns it does not have, not the run: the local relay posts
the whole run on every turn because a channel is free, and over the network the
same habit would be a 150 KB POST per turn by the end of a long debate.

The QR encoder (`qrcode-generator`, no dependencies of its own) is the only
rendering dependency in the project and is **loaded on demand** — a published
demonstration has no service, so it never draws a code and never fetches it. The
drawing is the tool's own: inline SVG in `--ink` on `--paper`, like the charts.

## Demo mode

The app is built to talk to `jaet-be`. Published on a static host there is no
service to talk to, so `VITE_DEMO` turns the live debate into something that
works without one:

```bash
VITE_DEMO=1 npm run build
```

With it on, the live view plays `public/demo/tagged.txt` — a whole debate that
arrived annotated — **whatever file is dropped on it**, and says so in as many
words: the visitor is told their file was not annotated and that what is playing
is the one that ships with the site. Nothing is sent anywhere.

The markup is **held back** rather than handed over with the turns. A turn that
arrives already annotated is taken straight into the feed, which is why the
first version of this looked frozen: every turn was ready at once, so nothing
was ever seen being worked on. Instead the pipeline is given bare turns and an
annotator that answers each one after a wait — a floor, a few milliseconds a
word, a ceiling — and only one turn is worked on at a time. The loader then
names the turn being annotated, the queue shows it running, and the rhythm of
the feed is the rhythm of the generation, which is the point of showing it live
at all. The status says *annotating* rather than *waiting for the service*,
because there is no service to wait for.

How slowly it pretends to think is `DEMO_PACE` in `src/config/backend.ts` — a
floor, a few milliseconds a word, a ceiling, and the beat after a turn lands
before the next is asked for. Each has a `VITE_DEMO_*` override, so the pace can
be changed without touching the file.

The transcript is fetched, not bundled, so 125 KB of debate stays out of the
JavaScript, and its address is built from Vite's `BASE_URL` — which is what
makes it survive being published in a subfolder, as a GitHub Pages project page
is. It carries a `[12] SPEAKER` index line above each turn; those lines are
dropped when it is read, so the file itself stays exactly as it was given.

Off by default: a developer running against `jaet-be` gets the real thing, and
only the published build pretends.

## Backend contract

```
POST  {VITE_API_URL}/annotate
      { "text": "SPEAKER: …", "view": "all" | "argument" | "entity" }
  →   { "tagged": "SPEAKER: <claim>…</claim>" }

POST  {VITE_API_URL}/compare
      { "text": "…", "view": "…", "systems": ["joint", "am-dner", "dner-am"] }
  →   { "outputs": { "joint": "…", "am-dner": "…", "dner-am": "…" } }
```

`annotation`, `annotated`, `output` and `text` are accepted as aliases of `tagged`. The live view
issues one `/annotate` call per turn, which is what makes it a faithful picture of streaming use.
Configure the base URL by copying `.env.example` to `.env`:

```bash
VITE_API_URL=http://localhost:8000
```

### What answers a turn

`baseUrl` points at [`../jaet-be`](../jaet-be) on port 8000 unless `.env` says otherwise, so a turn
typed into the playground is annotated by the model — including, and especially, text that is not one
of the bundled examples.

When there is no service to ask, the four turns of the comparison fall back to
[`src/data/fixtures.ts`](src/data/fixtures.ts). Those fixtures are **not invented**: they are the
reported outputs for those turns, so what the interface shows is what the three systems actually
produced. Anything else is reported as what it is — a turn nobody computed — rather than answered by
the local heuristic, which is off by default (`offline.heuristic` in the config) precisely because a
rough tagger reads like a prediction.

Every answer carries a badge saying where it came from — `annotation service`, `pre-computed`,
`from the file` or `offline heuristic` — so a stand-in is never mistaken for a live model
prediction.

### The transcript format

[`src/lib/transcript.ts`](src/lib/transcript.ts) holds both the rules shown on the intake screen and
the parser that enforces them, so the copy on screen cannot drift from the behaviour:

* a `.txt` file, UTF-8, up to 400 KB;
* one turn per block, blocks separated by a blank line — a turn may run over several lines;
* every turn opens with the speaker in capitals, then a colon: `SPEAKER: text`.

A new `SPEAKER:` prefix also ends a turn, so a file written one turn per line, with no blank lines at
all, still parses correctly.

**A turn may arrive already annotated.** If a block carries inline tags of the schema, it is taken as
the answer for that turn: nothing is sent anywhere, and the turn is badged `from the file` instead of
`annotation service`. A transcript annotated end to end therefore replays with no backend at all —
the pacing, the buffer and every panel behave exactly as they do on a live run — which is what makes
a demo possible before the service exists. The analytics view reads the same file the same way.

### The client

Every request the app makes lives in [`src/lib/api.ts`](src/lib/api.ts) — `annotate` for one turn
(the playground, the live feed, the analytics loader), `compare` for the three-system column view,
`checkService` for the health probe. No page touches `fetch`, a URL or a retry policy.

[`src/config/backend.ts`](src/config/backend.ts) is **the only place an address lives**: base URL,
routes, API key, timeout, retries, the request bodies, and the keys the answer is read from. Each
value can be overridden from `.env` (`VITE_API_URL`, `VITE_API_KEY`, `VITE_API_TIMEOUT_MS`) for a
build deployed against several services. `routes.annotate` points at `/playground`, the function of
the same name in [`../jaet-be/main.py`](../jaet-be/main.py).

Every failure arrives as an `ApiError` carrying which kind it was, because the fix differs in each
case:

| kind | what happened | what the panel says to do |
| --- | --- | --- |
| `config` | no service configured | set `VITE_API_URL`, or `baseUrl` in the config |
| `network` | the address did not answer at all | check the address, that it runs, and CORS |
| `timeout` | no answer within `timeoutMs` | raise the timeout, or look at the model |
| `http` | an error status came back | per status: credentials, route, rate limit, service logs |
| `payload` | the body could not be read | expected a string under `tagged`, `annotation`, … |

Retries apply only to failures another attempt could fix — a dropped connection, a timeout, 429,
502, 503, 504 — and never to a 400, a 404 or a broken contract, which would fail identically. Where
the service explains itself (FastAPI's `detail`), that explanation is shown instead of the status
code. A `GET /health` probe on load reports `service ready` / `service unreachable` next to the
address in the playground, so the state is known before a turn is typed rather than after. With no
address configured the app says `offline mode` and replays the bundled answers, each labelled as
what it is.

### The service

[`../jaet-be`](../jaet-be) is the other half: FastAPI over the MLX model, with `playground()` as the
function this front end calls — it prints every body it receives, annotates it, and answers
`{ tagged, view, model, elapsed_ms }`. `JAET_STUB=1` runs it without loading the model, which is
enough to exercise the whole front end. Its `CORSMiddleware` is what lets the browser reach it at
all.

### Keeping the live view continuously fed

A debate arrives faster than a tagger answers, so the live feed is not driven request by request.
[`src/lib/pipeline.ts`](src/lib/pipeline.ts) runs two things at once, with a buffer between them:

| | |
| --- | --- |
| **producer** | annotates turns in order, 2 requests in flight, never more than `lookAhead` (6) turns past the one on screen — so a 300-turn transcript does not hit the service in one burst |
| **buffer** | turns already computed but not shown yet; the meter in the *Pipeline* panel is this buffer |
| **consumer** | reveals one buffered turn at a time, after a warm-up of the first 4, holding each on screen long enough to read it — 260 ms per word, floor 4 s, ceiling 14 s — with **Next turn** to jump ahead |

The reader therefore sees turn 4 while turns 5–10 are already computed and 11–12 are in flight. When
the service is slower than the reading pace the buffer runs dry, and the view says `waiting for the
service` rather than hiding it.

This needs nothing of the backend beyond the per-turn `POST /annotate` it already answers. Two
upgrades fit without touching the buffer or the UI, if the backend can push:

* **SSE** — `POST /annotate/stream` with the whole transcript, the server replying `text/event-stream`
  with one event per finished turn. One connection instead of *n* requests, results arrive as soon as
  they are ready, and `Last-Event-ID` resumes after a drop. This is the natural fit for a replay.
* **WebSocket** — needed only when turns are also going *up* as they are spoken, i.e. a feed that is
  live rather than replayed.

Either one replaces the producer alone: the consumer keeps reading the buffer, so the pacing, the
warm-up and every panel stay exactly as they are.

Layer filtering is applied **client-side as well** ([`src/lib/view.ts`](src/lib/view.ts)), so the
entities / arguments / both switch is instant and correct even if the service ignores `view`.

## Analytics

[`src/lib/analytics.ts`](src/lib/analytics.ts) is a pure function over annotated turns - no model is
involved. One traversal produces the only relation the views need:

```
mention = { turn, speaker, type, surface, key, inside: 'claim' | 'premise' | null }
```

`inside` comes from the **nesting** of the markup, which is why the page can recompute the same
aggregation on a sequential pipeline and show what it costs: on the bundled excerpt the joint output
grounds 6 of 8 entity mentions in an argument component, AM -> DNER grounds 2 of 8, and DNER -> AM
grounds 0 of 5. Everything else - the speaker x entity matrix, the claim/premise/outside profile per
entity, the timeline, co-occurrence inside a component - is counting over that list.

Surface forms are folded by `normalise` plus a crude alias merge ("Obama" into "Barack Obama"). That
is the one genuinely lossy step and the first thing a deployment should replace with real entity
linking.

## Manual annotation

The text comes from a file the visitor loads - **`.txt` only**, up to 400 KB, by picker or drag and
drop. Anything else is refused by name before it is read.

[`src/lib/manual.ts`](src/lib/manual.ts) keeps spans as character offsets over the untouched text and
derives everything from them. The entity set is user-declared, so this path deliberately does not go
through the tag registry. Two spans of the same layer may nest or sit apart but never half-overlap -
that has no reading in BIO, so it is refused when the span is created rather than repaired later.
Layers cross freely: an entity inside a claim is the normal case.

A long tag set never turns into a stack: the entity set and the class bar are rendered as
[`components/Strip.tsx`](src/components/Strip.tsx), a single row that scrolls sideways. The wheel is
mapped onto it explicitly, because a notched mouse only reports `deltaY`, which a horizontally
scrolling box ignores; when the strip reaches either end the event is left alone and the slide deck
picks the page back up.

The span list stops growing after a few rows and scrolls on its own, so a long annotation never
turns the side panel into an endless pile.

Removing a span: click it in the text and a menu opens with a bin. Clicking an entity that sits
inside an argument component is a click on both, so the menu lists the whole chain, innermost first,
and you say which one goes.

Assigning a label: the text panel behaves like text - an I-beam cursor and the browser's own
selection - and the classes live in the bar **above** it, which stays disabled until something is
selected and then shows the selected words. Number keys assign as well; <kbd>Esc</kbd> clears and
<kbd>Backspace</kbd> undoes.

Two details make that work. The panel is marked `data-no-drag`, so a drag across it selects text
instead of panning the slide deck. And the selection is read off a clone of the DOM range rather
than by walking up from the anchor node, so a drag that starts or ends in the whitespace between two
words still resolves to whole tokens. The annotation itself is rendered by nesting one element per
span with the very classes `TaggedText` uses elsewhere, so a turn built by hand looks exactly like a
turn that came back from the tagger; tokens are the leaves and carry the `data-token` the selection
resolves against.

## Export

[`src/lib/export.ts`](src/lib/export.ts) walks the parsed annotation once and emits, from the same
traversal, three formats — so the token stream and the character spans can never disagree:

| Format | File | Content |
| --- | --- | --- |
| Inline XML | `.xml` | the markup as the model emits it |
| BIO / CoNLL | `.tsv` | one token per line with **two** BIO columns, argument and entity |
| JSON spans | `.json` | the untouched transcript plus character-offset spans and tokens |

Export is available per column in the comparison, on the playground result, and for the whole
session in the live view.

## Structure

```
src/
  data/            content only — no JSX
    project.ts     copy and the two failure mechanisms
    systems.ts     the three systems shown as columns
    examples.ts    the comparison turns: gold + per-system output, verdict, note
    fixtures.ts    pre-computed answers and the transcript replayed by the live view
    samples.ts     starter texts, derived from the fixtures
  lib/
    analytics.ts   annotated turns -> mentions -> matrices, profiles, timeline
    manual.ts      hand-built spans -> inline markup, two-layer CoNLL, JSON
    textFile.ts    reads a dropped .txt, or says why it was refused
    transcript.ts  the transcript format: the rules shown on screen, and the parser
    pipeline.ts    the live view's producer / buffer / consumer, one turn at a time
    tags.ts        registry of inline tags (claim, premise, person, …)
    parseTags.ts   forgiving parser: keeps crossing / unclosed markup as nodes
    view.ts        layer filtering (all / argument / entity, or per component)
    export.ts      tagged text -> tokens + spans -> XML / CoNLL / JSON
    api.ts         backend client, fixture replay, offline heuristic
    route.ts       ~30-line hash router hook
    glyphs.ts      the alphabet the generated noise is drawn from
  components/      one component + one CSS file each
    HoverTag.tsx   text that annotates itself under the cursor
    charts/        inline-SVG heatmap, stacked bars and timeline (no chart library)
    SlideDeck.tsx  the horizontal deck every page is built from
    TokenStream.tsx  the hero: a field of symbols that never settles, with tags
                     surfacing out of it; warms to light orange under the cursor
    FileDrop.tsx     .txt drop zone, shared by the annotator and the analytics
    Strip.tsx        a row that scrolls sideways instead of stacking
  pages/           one page + one CSS file each
  styles/
    colours.css    every colour in the tool, grouped by job — restyle from here
    tokens.css     everything else: radii, elevation, type scale, layout
    appearance.css shared visual finish, loaded after component styles
    base.css       reset, layout shell, shared `.btn` / `.display` / `.eyebrow`
```

### Editing

* **New comparison turn** — append to `EXAMPLES` in `src/data/examples.ts`; tabs, columns and
  commentary follow automatically.
* **New tag type** — add it to `TAG_SPECS` in `src/lib/tags.ts` and a matching `--tag-<name>` colour
  in `src/styles/colours.css`. Parsing, colouring, legend and counters follow.
* **New column / system** — add a `SystemSpec` to `src/data/systems.ts` and an output under each
  example. The grid in `WhyJointPage.css` is `repeat(3, …)`; switch it to
  `repeat(auto-fit, minmax(320px, 1fr))` for an arbitrary number of columns.
* **New slide** — append a `{ id, label, node }` entry to the page's `slides` array; the navigation
  and the keyboard shortcuts follow. Add `className: 'slide--ink'` for a full-bleed dark slide. A
  cover slide is just a `<Link>` with class `preview` wrapping its text and a framed `preview__shot`.
* **New page** — add the path to `ROUTES` in `src/lib/route.ts`, a branch in `App.tsx`, and an entry
  in `LINKS` in `components/NavBar.tsx`.
* **Restyle** — [`src/styles/colours.css`](src/styles/colours.css) holds every colour in the
  interface, grouped by the job it does: surfaces, text, brand, status, the shadow tint, one token
  per annotation tag, and the chart ramp. Nothing in a component hard-codes a value, so changing the
  four or five tokens in *Brand* and *Surfaces* restyles the whole tool. Radii, elevation, the type
  scale and the layout widths live next door in `tokens.css`. Typography uses local system fonts.
  `appearance.css`, imported after `App` in `main.tsx`, applies the shared rounded surfaces,
  translucent navigation, controls and accessibility preferences across every route. Page CSS
  continues to own the existing columns, spacing, ordering and scroll containers.
  Change `--accent` for buttons and selections (hover and soft shades derive automatically),
  `--bg` / `--paper` for surfaces, `--tag-*` for annotations and their related chart series,
  and `--contrast-*` for the device's increased-contrast mode.
  The pastel logo uses `--logo-start` / `--logo-end` for its gradient, `--logo-ink` /
  `--logo-dash` for the symbol and `--logo-text` for the navigation wordmark.
  `npm run dev` and `npm run build` regenerate `public/icons.svg`, `favicon-32.png` and
  `apple-touch-icon.png` from this palette and `scripts/logo.svg`; colour edits during development
  regenerate the icons and reload the page. Do not edit the generated icons directly.
  Logo asset colours and `--bg` accept hex values or `var(--token)` aliases to hex values;
  other interface tokens also accept CSS expressions such as `color-mix()`.
  The browser's `theme-color` metadata follows `--bg` automatically.

### Markup rendering

`TaggedText` renders the inline markup as nested coloured spans, and where the type is written
depends on how much text the span covers: an **argument component** runs over a whole sentence, so it
is a tinted band opened by its label, while an **entity** is a word or two — a full label in front of
each one would turn a turn into a list of labels, so it is underlined in its colour and carries a
short code after it (`PER`, `LOC`, `ORG`, …, from `short` in `lib/tags.ts`) the size of a footnote
marker. Pointing at any span outlines it and names its type in full. The hand annotator renders the
same way, from the same classes.

Sequential pipelines emit ill-formed output on purpose (stray closers, unclosed spans): the parser
keeps those defects, the UI marks them in red, and each panel reports a well-formedness summary.
**Raw markup** shows the literal strings.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
npm run preview
```

`vite.config.ts` sets `base: './'`, so `dist/` can be served from any static host or subfolder
(GitHub Pages included) without further configuration.
