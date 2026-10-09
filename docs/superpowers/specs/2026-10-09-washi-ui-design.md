# Washi UI: design

Date: 2026-10-09 · Branch: `feat/washi-ui`

## Goal

Give the app a new look and feel, called Washi, without changing what it does. The panel
becomes paper too: warm cream, a book-style serif, small-caps headings over thin ink rules,
square-cornered controls, and one red "seal" for the main action.

Chosen by the user during brainstorming, from three looks shown as mockups (Gallery, Sumi
studio, Washi). A full mockup was then shown: a throwaway Washi stylesheet on the real app
page, at desktop and phone widths, including the cost warning and the Advanced section. The
user approved it. That prototype lives at `.superpowers/brainstorm/washi-proto/` (local only,
not in git) and is the visual reference for this spec.

### Decisions already made

| Question | Answer |
|---|---|
| What should improve? | The look and feel only. Layout, organisation and phone behaviour stay as they are. |
| Which look? | C · Washi. |
| May `app.js` change? | Its label strings only, to fit the look. No behaviour changes. |
| Fonts? | Fonts already on the computer. The app must keep working offline from `file://`. |
| How to build it? | Approach 1: a new stylesheet on the same page skeleton (not a second theme, not new markup). |

## Scope

**Changes:** `style.css` (rewritten), `index.html` (icons and static labels), `app.js`
(label strings only), the tests that check those labels, one new test, and the README's
description of the UI.

**Does not change:**
- `js/` and `dist/`: the brush library, recorder, playback, layers, export.
- What the app does: every handler, state, shortcut, the cost meter's thresholds, undo,
  replay, export.
- The layout: a 320 px panel beside the stage; below 860 px the panel stacks above the stage
  at most 46 vh tall. The order of the panel's sections stays.
- Every element `app.js` or the tests find: ids, classes, `data-` attributes and element
  types (for example `#brushGrid button[data-brush]`, `#qualityPresets button`,
  `#costWarn .alert-icon`, `.alert-title`, `.alert-desc`, `#advanced`, `#toast`).
- The exported HTML player (it keeps its dark page), `examples/minimal.html`, `tests.html`,
  the test pages and `bench/index.html`.
- The board itself: the paper colour the user picks, the grain overlay, and the brush cursor.

## Visual system

All of it is defined as CSS custom properties on `:root` in `style.css`.

### Colour

| Token | Value | Use | Contrast on the panel |
|---|---|---|---|
| `--panel` | `#f2ece0` | panel background, washi cream | — |
| `--panel-2` | `#e9e1d0` | wells: the stroke-data `<pre>` | — |
| `--ink` | `#1b1a17` | text, rules at full strength, selected fills | 14.8 : 1 |
| `--ink-2` | `#4a4439` | section titles, secondary text | 8.2 : 1 |
| `--muted` | `#6b6253` | hints, units, italic notes | 5.1 : 1 (4.6 on `--panel-2`) |
| `--rule` | `rgba(27,26,23,.16)` | faint rules (the `<pre>` border) | — |
| `--rule-2` | `rgba(27,26,23,.34)` | control borders, section rules, slider tracks | — |
| `--seal` | `#b3261e` | the seal red: 墨 mark, Generate, ECLIPSE stamp mark, chosen paper ring, danger text, focus ring, mask cursor | 5.6 : 1 |
| `--seal-2` | `#951d16` | Generate on hover | — |
| `--seal-ink` | `#fbf3e6` | text on seal red | 5.9 : 1 on `--seal` |
| `--moss` | `#4f6b34` | cost meter: light | 5.1 : 1 |
| `--ochre` | `#8a6510` | cost meter: moderate | 4.5 : 1 |
| `--rust` | `#a3401a` | cost meter: heavy; the warning note and warning toast | 5.4 : 1 |
| `--paper` | `#f8f6f0` | the board's paper; `app.js` sets the chosen one | — |

The page and stage background behind the panel and board is `#e6dece`. Every text colour
clears 4.5 : 1 against its background. Red is used only for the seal roles listed above; the
cost meter and warnings use moss, ochre and rust instead, so a warning never looks like the
main action.

**Paper fibres:** the panel carries a faint noise texture: an inline SVG `feTurbulence` data
URI at about 7% ink, set as `--fibre`. It is drawn in CSS, so nothing is downloaded.

### Type

- `--serif`: `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`.
  Used for all text by default.
- `--mono`: `ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace`. Used for the seed
  field, slider values, hex codes, the fps counter, the cost meter, stroke data, the activity
  log and `kbd`.
- Base size 13 px. Section titles 13 px in small caps (`font-variant: small-caps`,
  `letter-spacing: .07em`), so a title like "Generate — seeded poster" keeps its capital G and
  sets the rest in small capitals. The brand title is 15 px, weight 600, `letter-spacing:
  .16em`; its tagline is 12 px italic in `--muted`.
- Explanatory `<i>` notes beside labels ("slash angle", "droplets per burst") are italic in
  `--muted`. Values (`<b>` in `.ctl-head`) are mono, regular weight, tabular figures.
- No web fonts, no `@import`, no `url()` that leaves the page.

### Shape and state

- Corners: 2 px on buttons, tiles, inputs, swatches, alerts and the toast; 3 px on the seal
  mark. No pills or circles anywhere except the board cursor.
- Borders: 1 px `--rule-2`. Section titles sit over a 1 px `--rule-2` rule.
- **Hover:** border goes to `--ink`, with a 4% ink wash behind.
- **Selected or on** (the active brush, the active quality preset, "Paper grain: on" — the
  `.active` and `.on` classes `app.js` already sets): filled with `--ink`, text in `--panel`.
- **Disabled:** 40% opacity (unchanged).
- **Focus:** `outline: 2px solid var(--seal); outline-offset: 2px` on buttons, inputs,
  selects and summaries. The seed field shows focus as a 2 px seal underline.

## Components, top to bottom

1. **Brand:** the 墨 mark becomes a 42 px red seal (`--seal`, 3 px corners, a thin inner
   cream ring) with the character in `--seal-ink`. "SUMI CONSOLE" and the italic tagline
   beside it.
2. **Generate:** the seed field is an underline (1 px `--ink`), typed in mono with a little
   letter-spacing. Reroll is a ghost button. Generate is the seal button: `--seal`
   background, `--seal-ink` text, small caps, `letter-spacing: .14em`, full width.
   The wind slider, the "Ink mask edge" checkbox (accent `--ink`), and the Fill mask / Clear
   mask buttons follow the shared styles.
3. **Brush:** a two-column grid of square tiles (the seventh, Mask, spans both). Each tile
   has a kanji icon (see Markup) and the brush name; the selected tile is inked. Mask's
   "alt = erase" note is italic `--muted`, and turns pale cream on the inked tile.
4. **Ink:** four square 28 px swatches with a `--rule-2` border; the chosen one gets a 2 px
   `--ink` ring, offset 2 px. The colour input is a small bordered square, with the hex code
   beside it in mono `--muted`.
5. **Sliders** (size, opacity, dryness, splatter, bleed, taper, grain, and every Quality
   slider): a 1 px `--rule-2` track and a 12 px square `--ink` weight with a cream border,
   styled for both WebKit and Firefox.
6. **Quality** (`<details>`): the summary is a section title, with the cost meter floated
   right in mono and coloured by its level (`.light` moss, `.moderate` ochre, `.heavy` rust,
   otherwise `--muted`). The Full / Balanced / Fast presets are ghost buttons; the active one
   is inked. "preset: balanced" is italic `--muted` with the name in `--ink`.
   **The warning** (`#costWarn`) keeps its icon / title / description grid, drawn as a note
   pinned in the margin: 1 px `--rule-2` border, a 3 px `--rust` left edge, 2 px corners, and
   a faintly lighter background (`rgba(255,252,245,.6)`). The icon and title are rust, the
   description `--ink-2`.
7. **Replay:** the speed and timing selects are bordered boxes with 2 px corners, in the
   serif. Replay is a full-width ghost button.
8. **Paper & canvas:** the paper swatches are square like the ink ones, but the chosen one's
   ring is `--seal`. The hex and name are in mono `--muted`. "Paper grain" inks when on;
   Clear's text is `--seal`.
9. **Recording & export:** the stroke count in the serif, "stroke format v3" italic
   `--muted`, and the fps counter in mono `--muted` on the right of the title. Export buttons
   are ghost buttons. Advanced's summary is italic `--muted`. The stroke data `<pre>` is mono
   on `--panel-2` with a `--rule` border; it still wraps anywhere, so the panel never scrolls
   sideways. "activity log" is in small caps; the log itself is mono, with each brush name in
   `--ink`.
10. **Hint:** italic `--muted`. `kbd` is mono, `--ink`, with a 1 px `--rule-2` border and a
   2 px bottom border, on `rgba(255,252,245,.6)`.
11. **Stage:** background `#e6dece`. The ECLIPSE stamp is set in the serif, `letter-spacing:
   .38em`, at 60% ink, and its mark (the `::before`) becomes a 10 px square in `--seal`
   instead of "◯". The brush cursor is unchanged, except that the mask cursor's dashes become
   `--seal`.
12. **Toast:** `--ink` background, `--panel` text, 2 px corners, in the serif. As a warning
   (`.alert.warn`) it uses the panel background with rust text, like the warning note.
13. **Scrollbar:** the panel's scrollbar is thin, `--rule-2` on transparent.
14. **Narrow screens** (below 860 px): the same layout as today. The panel loses its right
   border and gets a bottom border instead.

## Markup (`index.html`)

Only text inside elements changes; no id, class, attribute or element is added or removed.

| Where | Today | Washi |
|---|---|---|
| Brush icons (`#brushGrid button span`) | 🖌 ✸ ✎ ╱ ◍ ◇ ◐ | 筆 (brush) 霧 (mist) 線 (line) 疾 (swift) 滲 (bleed) 片 (fragment) 覆 (cover) |
| `#btnReroll` | ⟳ Reroll | Reroll |
| `#btnGenerate` (initial) | ✦ Generate | Generate |
| `#btnReplay` (initial) | ▶ Replay | Replay |
| `#btnUndo` | ↩ Undo | Undo |
| `#btnSave` | ↓ PNG | Save PNG |
| `#btnExportJSON`, `#btnExportHTML`, `#btnExportWebM` | ↓ JSON, ↓ HTML, ↓ WebM | JSON, HTML, WebM |

The emoji and symbols go because Windows' serif fonts lack ↓ and ■ and drew them in a stray
colour in the mockup, and because the emoji brush (🖌) is the only colour in the panel that
isn't ink or seal.

## Label strings (`app.js`)

Only these string literals change. The code around them stays as it is.

| Where | Today | Washi |
|---|---|---|
| `setBusy` (`#btnGenerate`) | `'■ Cancel'` / `'✦ Generate'` | `'Cancel'` / `'Generate'` |
| `refreshButtons` (`#btnReplay`) | `'■ finishing…'` / `'■ Stop'` / `'▶ Replay'` | `'Finishing…'` / `'Stop'` / `'Replay'` |
| `refreshExport` (`#btnExportWebM`) | `'↓ WebM'` / `'■ stop'` / `` `■ ${pct}%` `` | `'WebM'` / `'Stop'` / `` `Stop · ${pct}%` `` |

Its spoken labels ("Stop recording the video", "Stop the video (45% rendered)") are already
words, so they stay. A code comment that names the old amber warning colour is updated to
rust; no other comment changes.

## Tests

- **All existing tests pass** (436 at the time of writing).
- **Label checks updated to the new wording:**
  - `tests/app.smoke.test.js` checks the video button starts with "■" while rendering. It
    will check that it says "Stop" instead (the spoken-label check stays).
  - The same file checks `/finishing/` on the replay button. That becomes case-insensitive,
    to match "Finishing…".
  - Any other label check that fails only because of the wording is updated the same way,
    and listed in the commit.
- **New: the app stays offline.** A test loads the app in the iframe the app tests already
  use and checks what it would fetch:
  - every `<link href>` and `<script src>` is a relative path (no `http:`, `https:` or `//`);
  - the stylesheet has no `@import` and no `@font-face` rule;
  - every `url(…)` in the stylesheet is either relative or a `data:` URI. The paper-fibre
    texture is a `data:` URI whose SVG mentions `http://www.w3.org/2000/svg`; that is a
    namespace name, not a download, so the test looks at where each `url()` points, not at
    the text inside it.

  This locks in the decision to use fonts already on the computer.
- **Unchanged guards that matter here:** "nothing in the panel scrolls sideways"
  (`tests/app.panel.test.js`), the app smoke tests that click every control by id, and the
  alert-layout test (icon, title, muted description, `hidden` really hides).

## Verification before it is called done

1. Run the full suite: `node tests/run.mjs`.
2. Paint a few strokes with different brushes, then capture the app headless at 1440 × 900
   and at 375 px: the top of the panel, the Quality section with the cost warning showing,
   and the bottom with Advanced open. Scan the whole panel for sideways scrolling at both
   widths, as `tests/app.panel.test.js` does.
3. Compare the captures with the approved mockup.
4. Check that text colours meet the contrast table above (measured from the CSS values).
5. Show the user the captures.

## README

Update the parts that describe the UI so they match:
- the labels: Reroll, Generate, Replay, Stop, Finishing…, Save PNG, JSON, HTML, WebM, Stop · 45%
- the cost meter's colours (moss / ochre / rust instead of green / yellow / amber)
- the warning's look (a note with a rust edge, instead of "styled after shadcn/ui's Alert:
  an amber triangle icon")

The description of the alert's layout (icon column, title, muted description) still holds.
