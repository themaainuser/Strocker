# SUMI Console — ink posters in vanilla JS

Generate and paint "ECLIPSE"-style ink graphics: a figure silhouette filled with a
grey-blue double exposure (suspension bridge, power pylons, mist), cut by dry-brush
slashes, directional spray, torn-paper shards and speed lines.

No libraries, no build step. Canvas2D only. Open `index.html` by double-click, or serve
the folder (`npx serve .` / `python -m http.server`).

## Generate a poster

1. Type a seed (any word) or press **⟳ Reroll** for a random one.
2. Press **✦ Generate**. It paints step by step. Press it again to cancel.
3. The same seed, mask and window size always give the same picture.

| Control | What it does |
|---|---|
| Wind | Angle of the slashes, spray and speed lines (−80…80°, default −35° = lower-left → upper-right) |
| Ink mask edge | Traces the silhouette outline and its inner folds in fine, broken ink |
| Fill mask | Puts only the bridge/pylon scene into your painted mask, so you can add the ink by hand |
| Clear mask | Removes the painted silhouette |

### Your own figure (painted mask)

Press `7` (Mask) and paint the silhouette. It shows as a red tint only while the Mask
tool is active, and it is never exported. Hold `Alt` to erase. Then **Generate**, or
**Fill mask** and paint the rest yourself. With no mask painted, Generate makes a
temporary drape-shaped one from the seed.

## Drop-in file

To use the brushes, the recorder and replay in another canvas project, copy **one** file
from `dist/`:

| File | Use it as | You get |
|---|---|---|
| `dist/sumi-brushes.js` | `<script src="sumi-brushes.js"></script>` | a global `SUMI` (also in workers, via `globalThis`) |
| `dist/sumi-brushes.mjs` | `import SUMI, { recordStroke, replay } from './sumi-brushes.mjs'` | a module with no global |

Both contain `js/rng.js`, `js/brushes.js`, `js/recorder.js` and `js/playback.js`
unchanged, wrapped by a small build script. They paint exactly the same pixels as the
separate files: the test runner runs the same library tests, pixel fingerprints included,
on each build.

```js
const ctx = canvas.getContext('2d', { willReadFrequently: true }); // same canvas kind for record and replay
const pen = SUMI.recordStroke(ctx, { tool: 'dry', seed: Math.random(), opts: { size: 40 }, p0: { x, y } });
pen.dab();                                                    // pointerdown
pen.segment(from, to, width, direction, { speed, alpha });    // each move
const stroke = pen.end();                                     // pointerup → JSON-safe record
SUMI.replay(otherCtx, [stroke], { speed: 2 });                // animated, same pixels at the end
```

Tools: `dry`, `spray`, `fine`, `lines`, `wash`, `shard`, `mask` (`SUMI.BRUSH_NAMES`). The
banner at the top of each file states the brush-engine version, the stroke-format version
and a hash of the sources it was built from.

**Rebuilding.** Edit the files in `js/`, then run:

```bash
node tools/build-dist.mjs
```

The script has no dependencies. `node tests/run.mjs` fails if `dist/` is out of date.

**Export.** JSON, standalone HTML and WebM export stays in `js/export.js`. Load it after
`sumi-brushes.js` if you want it: it builds on the global `SUMI`.

## Recording and replay

Every hand stroke is recorded as plain JSON (`js/recorder.js`, stroke format v2): tool,
seed, options, wind, start point, the brush-engine version, and every brush call with its
exact width, direction, speed, transparency, time and call number. Times are ms on one
session clock, and call numbers break exact ties (e.g. two pens at once). v1 strokes still
replay. Undo, Clear, Clear mask and Generate keep the recording in step with what's on the
canvas. In the console, `SUMI.app.strokes()` returns the records.

Replay paints the strokes on top of the last generated poster or filled mask. Those aren't
recorded, so exports contain the strokes only; the panel says so when a poster is present.

Use it in another canvas app with just `js/rng.js` + `js/brushes.js` + `js/recorder.js` + `js/playback.js`:

```js
const ctx = canvas.getContext('2d', { willReadFrequently: true }); // CPU raster: see below
const pen = SUMI.recordStroke(ctx, { tool: 'dry', seed: Math.random(), opts: { size: 40 }, p0: { x, y } });
pen.dab();                                                  // on pointerdown — only before the first segment
pen.segment(a, b, width, direction, { speed, alpha });      // per move (speed, alpha in 0..1)
const stroke = pen.end();                                   // on pointerup → JSON-safe record

SUMI.replayStroke(otherCtx, JSON.parse(JSON.stringify(stroke))); // same pixels

// animated: several strokes, in recorded order, at any speed (ends with the same pixels)
const run = SUMI.replay(ctx, strokes, { speed: 2 });        // or a function stroke => ctx
await run.done;                                             // run.cancel() stops, run.finish() jumps to the end

SUMI.validateStroke(stroke);                                // throws TypeError on anything malformed
```

Notes for a host app:
- **Errors.** `done` rejects if a brush throws during a replay, instead of staying pending.
- **Brush engine version.** Each stroke records `SUMI.BRUSH_ENGINE` (now 2: engine 2 added
  the spray/wash quality options, and strokes without them paint as in engine 1). If you change a
  brush so that it paints differently, bump that number. Old recordings still replay, but
  with the new pixels.
- **Paths.** Brushes restore every ctx setting they touch, but they do call
  `beginPath()`, so finish any path you're building before you draw a stroke.
- **Don't transpile these files.** The HTML export inlines their exact source; Babel
  helpers wouldn't come along.
- **Redrawing only what changed.** `pen.takeDirty()` returns the box painted since the last
  call, as `{ x0, y0, x1, y1 }` in the ctx's own coordinates (the ones you pass to
  `segment`), or `null` if nothing was painted. During a replay, `onFrame(timeline)` runs
  after each frame and `timeline.takeDirty()` does the same for that frame. The box is
  conservative, so pixels never land outside it. A brush you add yourself that doesn't set
  `reportsArea` gives an infinite box, meaning redraw everything.

**▶ Replay** in the panel repaints your recorded strokes on a clean sheet, animated. Pick a
speed (0.5×–8×) and a timing:
- **as drawn**: keeps your pauses.
- **back to back**: drops the pauses between strokes.
- **all at once**: strokes start together. Where strokes cross, the final pixels can differ,
  because their calls interleave.

**Stop** jumps to the end, so the canvas always matches the recording. Replay is undoable.

Animation frames pause in background tabs, so a replay in a hidden tab waits.

## Export

The **recording & export** panel shows how many strokes are recorded and their size, plus
the last stroke exactly as stored. Three downloads:

| Button | What you get |
|---|---|
| **↓ JSON** | The recording as a `sumi-strokes` v1 document: `{ format, v, canvas, paper, strokes }` (each stroke in format v2). Load it back with `SUMI.parseRecording(json)`, which validates the document and every stroke in full via `SUMI.validateStroke`. |
| **↓ HTML** | One file with `rng.js`, `brushes.js`, `recorder.js` and `playback.js` inlined, plus a small player. It animates the strokes on open at the replay speed and timing picked in the panel; click the canvas to replay. No other files and no network. |
| **↓ WebM** | A video of the replay, recorded in real time at the replay speed (8× makes a short clip). While it records, the button reads **■ stop video**. Needs a browser that records WebM: Chrome, Edge or Firefox. In Safari the button is disabled. |

The HTML player draws the same layers as the app: wash multiplied onto the paper, then
ink, then shards. Its layer pixels match the app's in the same browser. Mask strokes are
left out, and the HTML has no paper grain or wash granulation, so it looks slightly flatter
than the app. Each frame redraws only the area its strokes painted (see Rendering).

Exporting works from `file://` too: each core file registers its module function in
`SUMI.modules`, and the export inlines that function's source text instead of fetching the
files.

From code: `SUMI.recordingJSON(strokes, { canvas })`, `SUMI.standaloneHTML(strokes, { canvas, speed, timing, gap, stagger })`
and `SUMI.recordWebM(strokes, { canvas, speed, fps })`. `recordWebM` returns
`{ done, cancel, stream }`, where `done` resolves to a Blob, or to `null` after `cancel()`.
Standalone HTML can only hold the built-in brushes (`SUMI.BRUSH_NAMES`): a stroke from a
brush you added yourself is rejected with a TypeError.

A replay is byte-identical to the original only on the same browser engine and the same
kind of canvas. Create canvases with `{ willReadFrequently: true }`: CPU and GPU canvases
antialias differently, and the browser may move a GPU canvas to the CPU after a pixel
readback. The app's paint layers are CPU canvases for this reason.

## Brushes

| Key | Brush | How it works |
|---|---|---|
| 1 | Dry brush | Fixed bristles per stroke, each with its own offset, ink load and touch-down point, so streaks stay continuous. Ink runs out with distance, so the tail breaks into dry streaks. Fast strokes get thinner, lighter and drier. |
| 2 | Spray | Droplets thrown in a cone along the stroke direction. Far drops streak, a few get tails, plus a fine stipple mist. |
| 3 | Fine line | Smoothed continuous pen for figure outlines (fast = thin). |
| 4 | Speed lines | Drag a rubber band; on release, one long tapered hairline, snapped to the wind if within 20°. |
| 5 | Wash | Watercolour: many faint, re-deformed polygons stacked on top of each other. Edges darken, and pigment granulates on the paper. |
| 6 | Shard | Torn-paper chips with jagged edges, a shaded fold and a partial ink outline. |
| 7 | Mask | Paints the silhouette (`Alt` erases). |

Shortcuts: `1–7` brush · `[` `]` size · `Ctrl+Z` undo (up to 15 steps or 256 MB of snapshots). Shortcuts are ignored
while typing in the seed field. **↓ PNG** exports paper, all paint layers, grain and the stamp.

### Quality: spray and wash

Spray and wash take the most time to draw, so five options trade some of their look for
speed. They are brush options like size, recorded with each stroke, so a replay always uses
the same settings. A stroke that doesn't set them paints at full quality. That includes every
recording made before these options existed, so those still replay exactly.

| Option | Range (default) | What it does | Look when lowered |
|---|---|---|---|
| `sprayDensity` | 0.1–1 (1) | share of droplets and mist per burst | sparser spray |
| `sprayGap` | 0–50 px (0) | travel between bursts; 0 is a burst per segment | clumpier along the stroke |
| `washLayers` | 1–6 (6) | glaze layers per stamp, each darker when there are fewer | less depth |
| `washDetail` | 2–5 (5) | outline points per layer, at most 10·2ⁿ (5 = 320) | smoother edges |
| `washEdge` | 0–1 (1) | share of layers that get the darker edge line, the main wash cost | lighter rim |

`SUMI.QUALITY` holds three presets: `full` (the defaults), `balanced` and `fast`. Use one in
another project with `opts: { size: 40, ...SUMI.QUALITY.balanced }`.

Measured per 12 px of painting at size 34 on a desktop PC, at 1× pixel density:

| ms per move | Full | Balanced | Fast |
|---|---|---|---|
| Spray | ~2.3 | ~1.8 | ~0.8 |
| Wash | ~1.2 | ~0.5 | ~0.2 |

**In the app**, the **Quality** panel has the presets and a slider for each option. It
starts on Balanced; once a slider moves off a preset, it reads "custom". The meter in the
panel's heading shows the current brush's drawing time, measured on your device whenever a
setting changes: green under 4 ms per move, yellow under 8 ms, amber from 8 ms. From 8 ms,
painting may stutter. An alert then appears in the panel naming the settings to lower, with a
short pop-up when you first cross the line. Both are styled after shadcn/ui's Alert: an amber
triangle icon (Lucide `triangle-alert`) and title, with the details in muted text.

## Rendering

Brushes never draw on the visible canvas. Each tool paints into its own offscreen layer
(`js/layers.js`): `wash`, `scene`, `ink`, `fx` (shards) and `mask`. Each layer is a CPU
canvas (`willReadFrequently`) at device resolution, pre-scaled by the pixel ratio. The app's
`requestAnimationFrame` loop composites the layers onto the board only when something changed:

1. paper colour
2. wash, with pigment granules lifted out of it, multiplied onto the paper
3. scene, multiplied
4. ink, then shards, drawn normally on top
5. the red mask tint, only while the Mask tool is active

Paper grain is a separate canvas overlaid with CSS, so it is never re-blended.

**Area redraws.** While you paint or replay, only the box the brushes reported is redrawn.
That box of each layer is copied into a small scratch canvas with `getImageData` /
`putImageData`, then blended onto the board with the same operations a full redraw uses.
Only the box is uploaded to the screen, and the result is byte-identical to a full redraw
(tested). The granulated wash and the mask tint are cached, and are rebuilt only inside
changed boxes. Generate, undo, Clear, resizing and switching the mask tint on or off
still redraw the whole board.

At 2× pixel density this cut a wash frame from about 68 ms to 3 ms and an ink frame from
about 13 ms to 2 ms. Brush pixels did not change, so saved strokes replay identically.

**Exports too.** The standalone HTML player and the WebM recorder redraw only each replay
frame's box in the same way. In a 1200×800 player, a frame's redraw went from about
3.9 ms to 0.7 ms at 1× and from 25 ms to 1.8 ms at 2×, counting the upload to the screen.

## Files

```
index.html        UI markup, loads the scripts below in order
app.js            UI, pointer input, undo, render loop (SUMI.app)
js/rng.js         seeded RNG + value noise — every random draw goes through here
js/layers.js      offscreen layers (wash, scene, ink, fx, mask), compositing, export
js/brushes.js     the seven brushes + ink helpers (spray, wash, shard, speed line)
js/recorder.js    stroke recorder (pen)
js/playback.js    timeline + animated replay of recorded strokes
js/export.js      JSON, standalone HTML player, WebM
dist/             drop-in builds of rng + brushes + recorder + playback (generated)
tools/build-dist.mjs   builds dist/ (node tools/build-dist.mjs, --check to verify)
js/contour.js     mask → marching-squares outline → inked edge and folds
js/scene.js       bridge / pylon geometry, scene painting, mask clip
js/generator.js   the poster recipe, auto-mask, fill mask
tests.html        in-browser test page (open it directly to see results)
tests/run.mjs     headless runner
tests/standalone.html   brush library without the poster modules
tests/stroke-fixtures.js   a stroke recorded as plain data + replay helper
tests/dist*.html   the library tests again, against each drop-in build
```

All files are classic scripts on a `window.SUMI` namespace (no ES modules), so the page
works from `file://`.

## Tests

```bash
node tests/run.mjs
```

The runner opens four pages in headless Edge or Chrome:
- `tests.html`: everything.
- `tests/standalone.html`: the portable library loaded alone (`rng.js` + `brushes.js` +
  `recorder.js` + `playback.js`).
- `tests/dist.html` and `tests/dist-esm.html`: the same library tests against each
  drop-in build.

It also checks that `dist/` matches the sources. If a browser returns
nothing, for example Edge mid-update, it falls back to the next one. Set `SUMI_BROWSER`
to choose a Chromium-based browser yourself. It prints failures plus a summary; exit code
1 means a failure. The tests cover the RNG and noise, layers, every brush, contour tracing,
scene geometry, generator determinism and cancel, and app smoke tests that drive
`index.html` in an iframe.
