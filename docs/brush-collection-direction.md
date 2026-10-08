# Brush collection — direction

Date: 2026-10-06 · Applies to all work after the `feat/ink-poster-generator` branch.
Updated the same day after the review of `js/rng.js` + `js/brushes.js` and its fix pass.

## The real goal

A reusable collection of brushes and strokes for my other project, which uses plain canvas.
I don't want to recreate the ECLIPSE poster scene. The poster was only a style reference
for the strokes.

## Core to keep

`js/rng.js` + `js/brushes.js`: dry brush, spray, fine line, speed lines, wash, shard, mask.

- `brushes.js` depends only on `rng.js`. `tests/standalone.html` checks this by loading
  just those two files. One soft exception remains: `ink.shard` reads `SUMI.PAPER` for the
  chip colour, with a hard-coded `#f4f1ea` fallback.
- `scene.js`, `generator.js`, `contour.js` and `layers.js` are poster-specific and optional.

## The brush contract (in place since the fix pass)

What a host app or a recorder can rely on:

- **Inputs.** Output depends only on:
  - the seed, opts, wind and erase flag
  - the exact `start` / `dab` / `segment` / `end` arguments
  - `st.speed` and `st.alpha`, both 0..1, set by the caller before each call
  - the ctx's transform and clip

  Every other ctx property is reset on entry and restored on exit, so brushes neither
  leak state to the host nor pick it up.
- **Alpha.** Alpha is explicit: `st.alpha`, not `ctx.globalAlpha`. In the app, `strokeTo`
  sets `st.speed` / `st.alpha` before each move's sub-steps and resets alpha to 1 for
  `dab` and `end`.
- **Options.** `SUMI.makeStroke` normalises opts through `SUMI.normalizeOpts`: it fills
  defaults, clamps ranges and copies the object. Colours must be `#rgb(a)`,
  `#rrggbb(aa)`, `rgb()/rgba()` or a CSS name; anything else throws `TypeError`.
- **Dry-brush dab.** The dab is deferred: a click leaves the mark at `end`, and a drag
  cancels it.
- **Freeze tests.** `tests/brushes.contract.test.js` pins the RNG/noise golden values and
  one golden pixel hash per tool. If those change, saved strokes replay differently, so
  bump the stroke format version.

## To build next

Status on branch `feat/stroke-recorder`:
- **1 and 4 are built.** `js/recorder.js` has `SUMI.recordStroke` (a pen: `dab` /
  `segment` / `end`). The app records every hand stroke, and the recording follows Undo,
  Clear, Clear mask and Generate.
- **2 is built.** `js/playback.js` has `SUMI.playback` (time-ordered timeline with
  forward-only `seek`), `SUMI.replay` (animated: speed, `cancel`, `finish`) and
  `SUMI.replayStroke`. The app has a Replay control with speed and timing pickers.
- **3 is built.** `js/export.js` has `SUMI.recordingJSON` / `SUMI.parseRecording`
  (validated `sumi-strokes` v1 document holding v2 strokes), `SUMI.standaloneHTML` (one file: the four core
  modules inlined from their own source via `SUMI.modules`, plus a small layered player)
  and `SUMI.recordWebM` (`captureStream` + `MediaRecorder`). The app's live console is now
  the recording & export panel.

1. **Stroke recorder.**
   - **Per stroke:** `v` (format version), `tool`, the raw seed exactly as passed (number or
     string), `opts` after `normalizeOpts`, `wind`, `erase`, the start point `p0`, whether
     `dab` was called plus its alpha, `endAlpha`, and the canvas `{ w, h, dpr }`.
   - **Per segment:** `[ax, ay, bx, by, w, dir, speed, alpha, t]`. Format v2 adds a call
     number `n` to every row (see below).
   - **Keep the seed.** Today it is `Math.random()` in the pointerdown handler
     (`app.js:167`) and is thrown away.
   - **Record the calls exactly as passed to `brush.segment`.** These are the app's
     interpolated sub-steps from `strokeTo` (`app.js:128`–`160`), not raw mouse positions.
     Wrapping `SUMI.brushes[tool]` is safe: brushes no longer call their own public methods.
   - **Full precision.** Store full-precision doubles; JSON round-trips them exactly.
     Rounding to two decimals changed the output of every brush except speed lines.
   - **Clicks.** A click with no drag has zero segments, so `p0` and the dab flag are what
     make it replayable.
2. **Animated playback.** `SUMI.replay(ctx, stroke, { speed })`:
   - Order: `start(p0)`, then `dab` if one was recorded, then the recorded segments as-is,
     then `end`.
   - Never re-split or re-interpolate the path. Re-splitting changed dry, spray and fine
     by thousands of pixels. Playback speed only changes when each recorded call happens.
   - **Overlapping strokes** are fine visually. They are pixel-identical only when calls
     are applied in the recorded global order (by `t`).
   - **As built:** every call sits on one timeline. Each animation frame only decides how
     far along that fixed order to go. Verified in the live browser: a 7-stroke recording
     animated at 2× (1,265 calls) ended byte-identical to the instant replay.
   - **Format v2 (after the branch review).** v1 sorted on `t0 + t`. That float sum could
     put a stroke's start before the previous stroke's end when both happened at the same
     clock reading (about 2% of exact ties). Two pens drawing at once fell back to array
     order. v2 fixes both:
     - every time is stored on the session clock;
     - every call gets a page-wide number `n`;
     - playback sorts on (time, `n`).

     v1 strokes are converted on load. v2 also records `engine` (`SUMI.BRUSH_ENGINE`), and
     the golden-hash tests are keyed by it.
   - **`dab` comes first.** Calling `dab()` after the first `segment()` throws, because a
     replay would put the dab first and paint differently.
   - **Timing modes:**
     - `recorded`: keeps the pauses.
     - `sequence`: back to back, plus a `gap`.
     - `overlap`: starts staggered by `stagger`. Interleaves calls, so crossing strokes
       can differ.
   - **Known limit:** after a window resize the app stretches the existing bitmap, but
     records keep their original coordinates (`stroke.canvas` stores the size). A replay
     after a resize therefore draws at the recorded positions and won't line up with the
     stretched picture. A fix for later: repaint from the recording on resize instead of
     stretching.
3. **Export as code.**
   - JSON stroke data.
   - A standalone HTML file (`rng.js` + `brushes.js` + strokes + a playback loop) that
     animates with no dependencies.
   - Optional: a WebM video via `canvas.captureStream()` + `MediaRecorder`.
   - **As built:**
     - **Getting the source.** The export never fetches files, so it works from
       `file://`. Each core file registers its own module function, and the export
       inlines `fn.toString()`, which is the exact source.
     - **HTML.** The exported HTML's layer pixels match the live layers (tested).
     - **Video timing.** The video advances on its own timer at its frame rate, not on
       screen refreshes. Driven by animation frames, a video recorded while the page
       wasn't being drawn had no middle frames.
     - **Safari.** It records MP4 only, so the WebM button is disabled there and errors
       become a message.
4. **Test first.** A replayed stroke must come out pixel-identical to the original.
   - Already true at brush level: `replay: recorded calls survive JSON and repaint
     identically on a used canvas` in `tests/brushes.contract.test.js`.
   - The recorder's own test should reuse `tests/stroke-fixtures.js`.
   - **Scope of "pixel-identical":** the same browser engine and canvas setup. JS maths
     functions and GPU vs software rasterisers differ across browsers. The exported HTML
     will look the same elsewhere, but won't match byte for byte.
   - **Same rasteriser, verified in the live app.** Within one browser, a GPU-drawn stroke
     and its CPU-drawn replay differ. Chrome moved a GPU layer to the CPU after a pixel
     readback, so the live stroke and its replay no longer matched. The app's paint layers
     are therefore CPU canvases (`willReadFrequently: true`), and the export's playback
     canvas must be one too. With that, 9 overlapping strokes across all 4 layers replayed
     byte-identically after JSON.
   - **Size:** about 140 bytes per segment row (full-precision numbers, one row per 2.5 px
     sub-step). A 190-segment stroke is about 26 KB, and the 9-stroke test above was 137 KB. Fine for JSON. If exports get large, delta-encode the rows instead of
     rounding them.

## Drop-in packaging (done 2026-10-07)

`dist/sumi-brushes.js` (classic script, global `SUMI`) and `dist/sumi-brushes.mjs` (ES
module, no global) are built from the four core files by `tools/build-dist.mjs`, which has
no dependencies. The build wraps the sources verbatim in one function that receives the
namespace holder as `window`. Both builds pass the library tests, pixel fingerprints
included, and `tests/run.mjs` fails when `dist/` is stale.

## Area-only redraw (done 2026-10-07, branch `perf/area-redraw`)

Measured first: uploading whole CPU layers to the board every frame cost ~10 ms at 1× and
35–50 ms at 2×, more than drawing the brushes. Now only the changed box is redrawn:

1. **Brushes report their painted area.** Each built-in brush declares `reportsArea: true`.
   The guard adds a conservative box per call to `st.dirty` (the `EXTENT` table in
   `brushes.js`). `tests/dirty.test.js` paints random strokes with every tool and fails if a
   pixel lands outside the box.
2. **The pen and the timeline pass the box on.** `pen.takeDirty()` and
   `timeline.takeDirty()` return the box. Brushes without `reportsArea` give
   `SUMI.EVERYWHERE`, meaning redraw everything.
3. **The app redraws only that box.** `layers.markArea(box, ...layers)` copies each layer's box
   into a small CPU scratch with get/putImageData and blends it with the same operations as
   a full frame. Reading layers with `drawImage` was avoided because it makes Chrome
   snapshot the layer and copy all of it on the next stroke (~3 ms at 2×). Replay frames use
   the same path.
4. **Area equals full.** A test checks the area redraw is byte-identical to a full redraw.
   Three deliberately broken versions were all caught. A bug where a partial mask-tint update
   wiped the tint outside its box was found and fixed this way.

Brush pixels are unchanged: no `BRUSH_ENGINE` bump. 2× wash frame ~68 → ~3 ms, 2× ink frame
~13 → ~2 ms, 1× painting ~8–14 → ~0.4–3 ms.

Open:
- **Spray and wash cost.** Making them cheaper to draw (fewer droplets, simpler wash
  outlines) would change their pixels and need a `BRUSH_ENGINE` bump. On hold until the
  user decides.
- **Exports.** The standalone HTML player and the WebM recorder still composite full frames;
  the same approach would apply there.

## Note

The "live console" (`refreshCode`) was only a display and couldn't reproduce a stroke.
**Done:** it is replaced by the recording & export panel, which shows the last stroke as
actually stored.

## Deferred (minor review items, not yet done)

- Use `globalThis` instead of `window`, for Workers / OffscreenCanvas. (Done for the drop-in
  files: the build passes `globalThis` in as `window`. The separate `js/` files still use `window`.)
- Pass the paper colour as `opts.paper` instead of reading `SUMI.PAPER`.
- `stamp()` can place a stamp behind the segment start when the spacing shrinks.
- The shard's tint fill still runs under its drop shadow.
- Calling `segment` before `start` throws for some brushes.
- Document `layer` as a compositing hint.
- Half of the noise permutation table is never used.
- Object seeds all hash to `'[object Object]'`.
