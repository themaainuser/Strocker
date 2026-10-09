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
  just those two files. (The one soft exception, `ink.shard` reading a page-wide paper colour,
  is gone: chips are cut from `opts.paper` since brush engine 3.)
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

Exports (done 2026-10-08, branch `perf/export-area`): the stage shared by the HTML player
and the WebM recorder (`sumiStage` in `export.js`) got the same area redraw, built into the
stage itself because exported files carry no `layers.js`. A test plays an exported file frame
by frame and checks each frame against a full redraw, byte for byte. Two deliberately broken
versions, one skipping the shard layer and one with the wrong wash blend, were caught.
1200×800 player, one frame's redraw including the upload: 1× 3.9 → 0.7 ms, 2× 25 → 1.8 ms.

## Spray and wash quality options (done 2026-10-08, branch `feat/quality-controls`)

The user wanted the cheaper spray and wash adjustable, with toggles or sliders and a warning
in the slow range, instead of fixed. So they are five brush options, recorded per stroke:
`sprayDensity`, `sprayGap`, `washLayers`, `washDetail` and `washEdge` (see the README). With
none set, a stroke paints at full quality, so engine-1 recordings replay exactly. The old
golden hashes pass unchanged. `BRUSH_ENGINE` went to 2 anyway, because an engine-1
replayer would ignore the new options.

Measured before building, with a pixel read after each move. Without it, Chrome defers the
raster and the timings mostly miss it:
- **Fewer droplets** and **bursts further apart** each about halve spray's cost.
- **Wash's edge line is its main cost.** Dropping it saves 65–75%. Fewer layers save
  35–50%, and fewer outline points save up to 60% at large sizes. Fading the line without
  dropping it saves nothing, so `washEdge` sets how many layers are outlined.
- **Pre-drawn images were dropped.** Droplet sprites were 3–4× slower than the batched
  path fills, and halo sprites saved nothing.

`SUMI.QUALITY` has `full`, `balanced` and `fast` presets. They were tuned by eye against Full.
The app starts on Balanced. Its brush cost meter times the current brush on a scratch canvas at
the board's pixel density, and warns at ≥ 8 ms per 12 px move.

## Stroke format v3 and gzip (done 2026-10-08, branch `feat/stroke-format-v3`)

The user found a single scribble recorded as about 1 MB. v2 stored about 3 rows per mouse
move, each with 10 full-precision numbers (~141 bytes): positions, width, direction, speed,
alpha, time and call number, all derived from the input. v3 stores the input instead:
- `pen.move(p)` records one `[x, y, t]` row per pointer move.
- The pen dynamics moved from `app.js` into `recorder.js` as `SUMI.penDynamics`: speed
  smoothing, taper thinning and lightening, ~2.5 px steps. Recording and playback both run
  them, and `SUMI.strokeCalls(stroke)` gives the derived calls.
- Input is rounded before use: positions to 1/100 px, times to 0.1 ms. The live stroke is
  drawn from exactly what's stored.
- Call numbers are implicit: a move's calls continue the stroke's numbering. A 4th number in a
  row is stored only when another pen cut in.
- `pen.segment()` remains for hosts with their own dynamics (v3 `segs` rows, as v2). A pen
  takes one or the other. v1 and v2 strokes still replay.
- Measured on one scribble of 1,800 moves: 785 KB as v2, 37.6 KB as v3, 15.2 KB gzipped.

Gzip: `SUMI.recordingGzip` / `SUMI.readRecording` handle `.json.gz` and plain JSON, and
`SUMI.standaloneHTMLGzip` embeds the recording as base64 gzip that the page unpacks on open,
with `SUMI_PLAYER_READY` resolving once it plays. The app's JSON and HTML buttons use both.
The inlined player code (~55 KB) is left uncompressed: compressing it would need eval.

## WebM rendered frame by frame (done 2026-10-08, branch `feat/webm-frames`)

The real-time recorder (MediaRecorder) dropped frames whenever drawing was slow, and always took
the video's full length. `SUMI.renderWebM` instead runs the replay on a clock that moves one
frame per step. Each frame is drawn, then encoded with WebCodecs `VideoEncoder` (VP9, else VP8,
30 fps, a keyframe every 2 s), so the video is always smooth.
- **Measured:** a 13.1 s video took 1.6 s at 1200×800 (8× real time) and 6.5 s at 2400×1600
  (2×). Its last frame matches the finished picture apart from compression noise.
- **The file writer is built in.** WebCodecs only produces encoded frames, so `export.js` has a
  ~100-line WebM writer: EBML header, Segment with SeekHead, Info (1 ms ticks, Duration), one
  track, a Cluster per keyframe, and Cues. Element IDs were checked against the IETF EBML and
  Matroska specs. Unlike the MediaRecorder file, it has a duration and a seek index; it decodes
  and seeks even in headless Chrome.
- **Fallback:** without WebCodecs, or without a VP9/VP8 encoder (`err.code === 'no-encoder'`),
  the app falls back to `recordWebM`.
- **Testing under virtual time.** The headless runner's virtual clock jumps to the next timer
  whenever the page is idle, which an encoder working on another thread looks like. So video
  tests await through `T.busy(promise)`, which keeps the page busy with message-channel tasks.
  The tests check the file structure byte by byte: frame times, keyframes, duration, and that
  SeekHead and Cues point at real elements. Two broken writers were caught: cue positions off
  by one, and every frame flagged as a keyframe.

## Replay in slices (done 2026-10-09, branch `perf/sliced-replay`)

The benchmark (`node tools/bench.mjs`, 2026-10-08) found two weak spots. Drawing a big
recording at once froze the page: 120 strokes (60,537 calls) took 3.7–4.9 s. And at 8×, 7–11%
of replay frames went over 16.7 ms. The user chose drawing in slices over saving a snapshot
image with each recording, so the file format is unchanged.
- **`budget`** on `SUMI.replay`: ms of drawing per frame. A frame stops once it has drawn that
  long and leaves the rest to the next frames, so speed becomes a maximum. With a budget,
  `speed: Infinity` draws over frames as well. `run.finish({ budget })` finishes in slices too,
  and plain `finish()` still jumps to the end. Without `budget` nothing changes, which the tests
  and any code that expects an instant replay rely on. `budget: 0` draws one call per frame, so
  the tests are deterministic.
- **`timeline.seek(t, deadline)`** stops after the call that passes the deadline. The next seek
  carries on, even to the same `t`. Before, a seek to a time no later than the last did nothing.
- **Measuring the drawing as well as the script.** The first version timed only the script,
  and frames still ran 26–46 ms. A CPU canvas (`willReadFrequently`) records draw calls and
  rasterises them only when read, which in the app happens later in the frame, in the render
  loop. So a sliced seek reads one pixel of each CPU canvas it drew on about once per
  millisecond, and the deferred drawing lands on its clock. GPU canvases rasterise off the main
  thread and are never read; a test fails if one is. A read changes no pixels, and a tainted
  canvas is left alone after its first failed read.
- **The app** replays with 12 ms. **Stop** finishes in slices and shows "■ finishing…". Other
  actions that interrupt a replay (a stroke, undo, Generate) still complete it at once, so the
  canvas always matches the recording. **The exported player** uses 12 ms; WebM rendering
  doesn't, because each video frame must show exactly its own time.
- **Measured** (headless Chrome 154): the 120 strokes now load in 4.4 s across 261 frames,
  12.9 ms of drawing per frame on average and at most 15.5 ms. The longest gap between frames
  was 33 ms. 8× replay frames peak at 13–15 ms, and none go over 16.7 ms. Pixels are identical
  at 1× and 2×. No brush changed, so `BRUSH_ENGINE` stays 3.
- **Found while checking it in the app, at 1.25×.** At fractional pixel ratios, Chrome's spray
  pixels depend on when the canvas is read during drawing. A replay with no read before the end
  and one read part-way through differed in 27 of ~179,000 inked pixels (0.015%; at 1.5×, 26
  pixels by at most 2 levels). Dry and wash didn't differ. This predates slicing: the live drawing (undo
  snapshots, area redraws) and animated replays already read part-way through. So
  pixel-identical replay also needs an integer pixel ratio, or reads at the same points. The
  README says so.
- **Testing.** Test iframes can't count on animation frames, so app and player tests run them
  by hand (`handFrames`, `playByHand`). The deferred-drawing test fakes the costs: a clock that
  moves 0.25 ms per reading, and a read that costs 20 ms.

## Small washes (done 2026-10-09, branch `perf/small-wash`)

The benchmark's third weak spot: small spray and wash weren't cheaper than medium ones. Wash
stamps sit 0.4 × the width apart, so a thin wash places far more stamps per pixel. On Full, a
size-12 wash cost about twice a size-34 one. Spray throws the same number of drops at every
size.
- **Prototyped first** (throwaway, never in the repo): candidates drawn side by side with their
  costs. For spray, drop counts scaled with size or area were 3–6× cheaper when small, but
  visibly lighter and sparser. For wash, wider stamp gaps made small strokes look beaded,
  and fewer layers alone made them darker and blotchier. Less outline detail plus fewer layers
  (never below 2) looked closest to the original. The user chose to **leave spray as it is**,
  and to take that wash fix **as a configurable option**.
- **`washSmall`**, the sixth quality option: the size below which wash stamps get simpler.
  Layers become `washLayers × √(size ÷ washSmall)`, at least 2 (or `washLayers` if lower), with
  alphaK `6 / layers` as for `washLayers`. Below about size 22 (`detail < 12`), outlines drop
  from 80 points to 40. Full has 0 (off), so a stroke without it, including every older
  recording, paints as before. Balanced and Fast have 34. `BRUSH_ENGINE` went to 4 (an older
  engine would ignore the option). The engine-4 golden hashes equal engine 3 for defaults and
  for Fast at size 34, and new hashes pin small Balanced washes (sizes 8 and 12).
- **App:** a sixth Quality slider, "Small wash — simpler below size", 0–80, "off" at 0.
- **Measured** with an A/B in alternating order (old-new-new-old, twice, headless Chrome). On
  Balanced, a size-12 wash went from 0.89 to 0.25 ms per move at 1× and from 1.13 to 0.29 ms at
  2×, now cheaper than size 34 (0.43–0.59 ms). Unchanged sizes stayed within this laptop's
  noise: adjacent runs agree within ~15%, while the machine drifted ~2× over the session. The
  first A/B ran old before new every time, and that ordering alone made new look 1.3–1.5×
  slower at untouched sizes.

## Note

The "live console" (`refreshCode`) was only a display and couldn't reproduce a stroke.
**Done:** it is replaced by the recording & export panel, which shows the last stroke as
actually stored.

## Deferred (minor review items, not yet done)

- Use `globalThis` instead of `window`, for Workers / OffscreenCanvas. (Done for the drop-in
  files: the build passes `globalThis` in as `window`. The separate `js/` files still use `window`.)
- ~~Pass the paper colour as `opts.paper` instead of reading the page-wide paper.~~ Done
  2026-10-08 (brush engine 3), with the app's paper colour options; the default paper is pearl
  white (`#f8f6f0`).
- `stamp()` can place a stamp behind the segment start when the spacing shrinks.
- The shard's tint fill still runs under its drop shadow.
- Calling `segment` before `start` throws for some brushes.
- Document `layer` as a compositing hint.
- Half of the noise permutation table is never used.
- Object seeds all hash to `'[object Object]'`.
