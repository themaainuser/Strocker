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

Shortcuts: `1–7` brush · `[` `]` size · `Ctrl+Z` undo (15 steps). Shortcuts are ignored
while typing in the seed field. **↓ PNG** exports paper, all paint layers, grain and the stamp.

## Files

```
index.html        UI markup, loads the scripts below in order
app.js            UI, pointer input, undo, render loop (SUMI.app)
js/rng.js         seeded RNG + value noise — every random draw goes through here
js/layers.js      offscreen layers (wash, scene, ink, fx, mask), compositing, export
js/brushes.js     the seven brushes + ink helpers (spray, wash, shard, speed line)
js/contour.js     mask → marching-squares outline → inked edge and folds
js/scene.js       bridge / pylon geometry, scene painting, mask clip
js/generator.js   the poster recipe, auto-mask, fill mask
tests.html        in-browser test page (open it directly to see results)
tests/run.mjs     headless runner
```

All files are classic scripts on a `window.SUMI` namespace (no ES modules), so the page
works from `file://`.

## Tests

```bash
node tests/run.mjs
```

The runner opens `tests.html` in headless Edge or Chrome (set `SUMI_BROWSER` to pick
another Chromium-based browser) and prints failures plus a summary. Exit code 1 means
a failure. The tests cover the RNG and noise, layers, every brush, contour tracing,
scene geometry, generator determinism and cancel, and app smoke tests that drive
`index.html` in an iframe.
