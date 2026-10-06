# Ink Poster Generator + Brush Engine Rebuild — Design

Date: 2026-10-06 · Status: design approved in chat, spec pending review

## 1. Goal

Make SUMI Console produce graphics in the style of the "ECLIPSE" reference poster:
off-white paper, a figure silhouette filled with a grey-blue double-exposure scene
(suspension bridge, lattice power pylons, mist), cut across by black dry-brush
slashes on one dominant diagonal, directional ink spray, torn-paper shards and long
thin speed lines.

Two ways to get there, sharing one brush engine:

- **Generate** — one click, seeded, reproducible poster.
- **Paint** — hand brushes that match the reference look.

The figure is supplied by the user as a **painted mask**; the engine fills it with
the scene and (optionally) inks its outline. No procedural figure drawing.

### Success criteria

1. Same seed + same mask + same viewport size → pixel-identical output (verified by
   a hash test on offscreen layers).
2. A generated poster contains every element listed in §6 in that layer order.
3. Dry-brush strokes read as continuous bristle streaks that break up toward the
   tail (visual check against the reference), not as short hatching.
4. No hitch on pointerdown: no `toDataURL` in pointer handlers; the visible canvas is
   recomposited only on frames where something changed.
5. Works opened by double-click (`file://`) and from a static server; zero console
   errors in either.
6. PNG export contains paper, all paint layers, grain and the stamp; never the mask
   tint.
7. `tests.html` reports all checks passing.

## 2. Constraints

- Vanilla JS, Canvas2D only, no libraries, no build step.
- Classic `<script>` tags, no ES modules (module scripts are blocked on `file://`).
  Files share one namespace: `window.SUMI`.
- Target current Chrome / Edge / Firefox. Safari is best-effort: where canvas
  `ctx.filter` blur is unsupported, the mask edge is hard instead of feathered.
- Every random choice in brushes, scene and generator goes through a seeded RNG
  object passed in — never `Math.random` directly. Hand painting seeds its RNG per
  stroke from `Math.random()` once, at pointerdown.

## 3. Architecture

Layered offscreen canvases composited into the visible `#board`.

```
index.html      loads scripts in order below, UI markup
style.css       existing look, new controls
js/rng.js       seeded RNG + noise
js/layers.js    layer stack, composite, snapshot/restore, export
js/brushes.js   all brush algorithms
js/contour.js   mask outline tracing + inked edge
js/scene.js     bridge / pylons / mist double-exposure + mask clip
js/generator.js poster recipe + step runner
app.js          UI wiring, pointer input, undo, console, render loop
tests.html      in-browser checks, no dependencies
```

### 3.1 `js/rng.js`

- `SUMI.hashSeed(str) → uint32` — stable hash so seeds can be words.
- `SUMI.makeRng(seed) → rng` (mulberry32) with `next()` in [0,1), `range(a,b)`,
  `int(a,b)` (inclusive), `chance(p)`, `gauss()` (mean 0, sd 1), `pick(arr)`.
- `SUMI.makeNoise(seed) → { n1(x), n2(x,y), fbm2(x,y,octaves) }` — value noise,
  outputs in [0,1], continuous.

### 3.2 `js/layers.js`

Layers (z-order): `wash`, `scene`, `ink`, `fx`; plus `mask` (never exported).
Paper is a flat fill drawn during composite; grain stays the existing DOM overlay
canvas.

- `SUMI.createLayers(w, h, dpr)` → object with:
  - `get(name) → { canvas, ctx }` (ctx already scaled by dpr; draw in CSS px)
  - `resize(w, h, dpr)` — keeps content by scaling old bitmap into new
  - `clear(names)`
  - `isMaskEmpty()` — downsampled alpha scan
  - `snapshot(names) → snap` (canvas copies via `drawImage`), `restore(snap)`
  - `composite(ctx, { showMask })` — paper fill → wash (multiply, with
    granulation) → scene (multiply) → ink → fx → mask tint (35% red) if `showMask`
  - `exportCanvas(grainCanvas, stampText)` → a new canvas for PNG download
- Granulation: one noise texture built at resize; at composite the wash layer is
  drawn to a scratch canvas, the texture is applied with `destination-out` at low
  alpha, then the scratch is multiplied onto the output.

### 3.3 `js/brushes.js`

Common interface, one object per tool:

```
brush.layer                       // target layer name
brush.start(st)                   // st = { ctx, rng, noise, opts, p, wind }
brush.segment(st, a, b, w, dir)   // a,b points; w live width; dir radians
brush.dab(st, p)                  // single click
brush.end(st)
```

`opts` = slider values (size, opacity, dryness, splatter, bleed, taper) + color.
The existing speed-reactive width/alpha logic in `strokeTo` is kept and feeds `w`.

| Tool (key) | Layer | Algorithm |
|---|---|---|
| Dry brush (1) | ink | At start, N = clamp(round(size/1.6), 8, 64) bristles, each with fixed normal offset (centre-weighted), width factor, ink load and noise offset. Each bristle keeps its own last point, so its streak is continuous. Visibility along arc length = `noise.n1(arc * f + off)` vs a threshold that rises with dryness, edge distance and ink depletion. Ink depletes with distance (budget ≈ 900px × (1 − 0.6·dryness)), so tails break up ("flying white"). Bleed = soft underlay as today. Splatter slider → occasional `spray` in stroke direction. |
| Spray (2) | ink | `spray(ctx, rng, x, y, dir, radius, amount)`: 20 + 180·amount droplets in a cone around `dir` (gauss spread ≈ 0.5 rad); distance `r^1.4 · radius · 2.5`; size `r^3 · radius · 0.12 + 0.3`; droplets stretch along travel direction proportional to distance; ~5% get a thin tail; plus a micro-mist of 0.3–0.8px dots. Hand tool uses pointer direction, or wind angle when still. |
| Fine line (3) | ink | Replaces Scratch. Smoothed continuous line (midpoint quadratic), width 0.5–2.2px from speed, slight alpha noise — for drawing figure outlines by hand. |
| Speed lines (4) | ink | Rubber-band: pointerdown sets start, preview drawn during composite, commit on pointerup. Angle snaps to wind if within 20°. Line = tapered quad (both ends), alpha varies along length; 30% chance of a parallel echo 2–5px away. |
| Wash (5) | wash | Deformed polygon: 10-gon radius r, recursive midpoint displacement (depth 3), then K layers (hand 6, generator 30–50) each re-deformed (depth 2) and filled at alpha 0.02–0.05; each layer's edge stroked at ~0.04 alpha so edges darken. Dabs spaced at 0.4·size along the path. |
| Shard (6) | fx | 4–7-gon stretched 1.5–2.5× along wind ± 30°; each edge subdivided with small jagged displacement (torn edge); paper fill; one side of a random fold line shaded grey; ~60% of edges outlined at 0.8px; soft drop shadow. Stamped along path as today. |
| Mask (7) | mask | Soft round dab (alpha 1 → 0 over the outer 30% of radius), spacing 0.25·size. Alt held = erase (`destination-out`). Mask tint shown only while this tool is active. |

### 3.4 `js/contour.js`

- `SUMI.contour.trace(maskCanvas, cell = 4, threshold = 0.5) → polylines` —
  marching squares on a downsampled alpha grid; segments joined into polylines
  (closed loops flagged). Empty mask → `[]`.
- `SUMI.contour.inkEdge(ctx, rng, noise, polylines, opts)` — Chaikin-smoothed
  polylines drawn as fine ink: ±1.5px noise wobble, width 0.7–1.6px from noise,
  runs where noise < 0.3 skipped (broken line), small overshoot at some breaks;
  plus 2–5 inner "fold" strokes: partial copies of the contour offset inward
  10–40px.

### 3.5 `js/scene.js`

- `SUMI.scene.bridgeGeometry(box, rng)` → `{ vp, deck, towers, cables, suspenders }`
  — vanishing point in the left 5–30% of the box at horizon 45–60% of box height;
  deck edges converge to it; 2–3 towers placed by inverse depth so they shrink
  toward `vp`; main cables are parabolas sagging between tower tops.
- `SUMI.scene.pylonGeometry(base, height, rng)` → `{ legs, braces, arms, wires }`
  — tapered frustum, zig-zag cross-bracing with intervals shrinking upward,
  2–3 crossarm levels, sagging wires leaving the arm tips.
- `SUMI.scene.render(ctx, rng, noise, box, opts)` — far-to-near: pale sky wash →
  bridge (wash-filled towers/deck + 0.6–1.2px linework) → 1–3 pylons → mist band
  under the deck. Indigo `#2b3a4a` / grey-blue `#5a6d7e`; alpha falls with
  distance; a fog wash pass after far elements fades their bases.
- `SUMI.scene.clipToMask(sceneCtx, maskCanvas, feather)` — mask blurred by
  `feather` px via `ctx.filter` when supported, then `destination-in`.

### 3.6 `js/generator.js`

`SUMI.generate({ layers, seed, wind, inkEdge, animate, onLog }) → { cancel(), done }`

Builds the recipe as an ordered list of step closures. `animate: true` runs steps
across rAF frames with a ~12ms budget per frame; `animate: false` runs them
synchronously (used by tests). Each step logs a pseudo-call to the console panel,
e.g. `scene.bridge({ towers: 3, vp: [212, 388] })`.

Mask: if the mask layer is empty, a temporary auto-mask (3–5 soft ellipses along
a diagonal band) is built from the seed and used for this run only; it is not
written to the mask layer, so the seed alone decides the result.

## 4. UI changes

- Brush grid: Dry brush, Spray, Fine line, Speed lines, Wash, Shard, Mask (keys 1–7).
- Sliders unchanged (Size, Opacity, Dryness, Splatter, Bleed, Taper, Grain).
- New **Generate** section: seed text input (random 6-char default), **Generate**
  (current seed), **Reroll** (new seed, then generate), Wind slider (−80…80°,
  default −35°), "Ink mask edge" checkbox (default on), **Fill mask** (clears the
  scene layer and renders only the scene into the painted mask, using the current
  seed; disabled while the mask is empty), **Clear mask**.
- Demo button removed (Generate replaces it).
- While generating: pointer painting is ignored and Generate reads "Cancel".
- `[` `]` size and Ctrl+Z undo keep working.

## 5. Undo, render loop, resize

- Undo entry = `layers.snapshot(namesTouched)` taken before the action: one layer
  for a stroke; wash, scene, ink and fx for Generate; scene for Fill mask; mask for
  mask edits and Clear mask. Max 15 entries. Restore marks the composite dirty.
- `requestAnimationFrame` loop composites only when dirty.
- Resize keeps layer content (scaled) and rebuilds grain + granulation texture.

## 6. Generator recipe (order = layer paint order)

With canvas W×H, wind angle θ, diagonal D, rng from seed:

1. Clear wash, scene, ink, fx.
2. Mist: 3–6 large pale wash areas along the wind axis around the mask.
3. Scene rendered into the mask's bounding box, clipped with feather 10–24px.
4. If "Ink mask edge": contour + inner folds on ink.
5. Slashes: 4–9 dry-brush strokes, start points spread across a band through the
   lower-right of the mask, slightly curved paths at θ ± 10°, length 0.2–0.6·D,
   width 20–110px (1–2 hero strokes at the top of the range), synthetic speed
   profile slow-and-thick → fast-and-thin, dryness 0.3–0.8.
6. Spray: 3–8 bursts along each slash in direction θ; 2–4 standalone clusters;
   300–800 micro-dots in a wide band along the diagonal.
7. Shards: 8–20 along the band, larger near its centre, oriented to θ.
8. Speed lines: 12–30 across the full canvas at θ ± 3°, ~20% at a steeper
   secondary angle (θ − 25°), length 0.2–0.9·D.
9. Stamp: unchanged DOM element; drawn into PNG exports.

## 7. Testing

`tests.html` loads the `js/` files and prints a pass/fail list:

- rng: same seed → same sequence; outputs in range; `hashSeed` stable.
- noise: outputs in [0,1]; small input step → small output step.
- contour: filled circle radius 50 → one closed loop with perimeter within 10% of
  2π·50; two separate blobs → two loops; empty mask → `[]`.
- bridgeGeometry: towers inside box, ordered by depth, heights decreasing toward
  `vp`.
- pylonGeometry: top width < base width; braces non-empty.
- generator: 400×300 offscreen layers, `animate: false` — same seed twice →
  identical pixel hash; different seeds → different hash.

Visual acceptance: screenshots of seeds `eclipse`, `bridge`, `42` at 1400×900,
with and without a painted mask, compared against the reference by the checklist
in §1.

## 8. Out of scope

Procedural figure/hand drawing, image import, SVG/vector export, stroke
recording/replay, mobile-specific UI beyond the existing responsive CSS, any
change to `DESIGN.md`.

## 9. Risks

- Wash layering cost while hand painting → capped at 6 layers/dab, ≤ 64 vertices.
- Undo memory at dpr 2 on large screens (one full-size copy per touched layer) →
  15-entry cap; dpr stays capped at 2.
- `ctx.filter` unsupported (older Safari) → hard mask edge fallback.
