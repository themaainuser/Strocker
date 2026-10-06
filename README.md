# SUMI Console — ink strokes in vanilla JS

Interactive playground for the ink / sumi-e effects in your reference
(dry-brush slashes, splatter spray, thin scratch lines, grey wash bleed, torn-paper shards).

No libraries. Canvas2D only. Open `index.html` in a browser.

## Run

```bat
cd ink-strokes-console
start index.html
:: or: npx serve .
```

## Brushes (`app.js`)

| Brush | How it works (JS only) |
|---|---|
| Dry Brush | 5–44 bristle sub-strokes per segment, perpendicular offsets, `dryness` = skip probability → white gaps. Velocity thins the stroke (`taper`). |
| Splatter | `pow(random,1.7)` radial distribution + 2–3 blot cores + elliptical dots |
| Scratch | 1px quadratic wobble + faint echo line |
| Wash | 16 radial-gradient blobs with `multiply` composite + uneven bleed ring |
| Shard | random 3–5-gon, paper-colour fill + ink outline (the white chips in the ref) |

Paper grain is procedural too: speckles + 70 fibre lines.

## Try the reference look

1. Click **✦ Demo** — paints washes → slashes → splatter → scratches → shards.
2. Then paint over it: big `Dry Brush` size ~64, `Splatter` 80 for the spray, `Wash` with bleed 70 for mist.
