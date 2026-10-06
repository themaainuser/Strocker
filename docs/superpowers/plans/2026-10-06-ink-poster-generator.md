# Ink Poster Generator + Brush Engine Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn SUMI Console into a layered ink engine that can generate a seeded "ECLIPSE"-style poster in one click and lets the user paint the same look by hand, with a painted mask filled by a bridge/pylon double-exposure scene.

**Architecture:** Offscreen layer canvases (`wash`, `scene`, `ink`, `fx`, `mask`) composited into the visible `#board`. Brushes, scene and generator are pure functions of a seeded RNG, shared by hand painting and the generator. Classic scripts on a `window.SUMI` namespace so the page still opens from `file://`.

**Tech Stack:** Vanilla JS, Canvas2D, HTML/CSS. Tests: an in-browser harness (`tests.html`) run headlessly by `node tests/run.mjs` (Node built-ins + installed Edge/Chrome).

**Spec:** `docs/superpowers/specs/2026-10-06-ink-poster-generator-design.md`

## Global Constraints

- Vanilla JS + Canvas2D only. No libraries, no npm dependencies, no build step.
- Classic `<script>` tags, no ES modules. Everything lives on `window.SUMI`. `tests/run.mjs` is the only module file (Node).
- No `Math.random` anywhere in `js/`. `app.js` may use it only to create seeds.
- Must work opened by double-click (`file://`) and from a static server, with zero console errors.
- The engine uses radians and CSS pixels. Layer canvases are device pixels (CSS × dpr) with the ctx pre-scaled by dpr. dpr is capped at 2.
- Degrees appear only in the UI (Wind slider −80…80, default −35). `SUMI.DEFAULT_WIND = -35 * Math.PI / 180`.
- Colours: paper `#f4f1ea`, indigo `#2b3a4a`, grey-blue `#5a6d7e`, default ink `#111318`.
- Undo keeps at most 15 entries.
- Target browsers: current Chrome / Edge / Firefox. Where `ctx.filter` is missing, the mask feather falls back to a hard edge.

## Review Focus

1. Typing a seed into the seed field must not trigger tool hotkeys (`1`–`7`, `[`, `]`). Expected: shortcuts are ignored while a text input has focus. → test in Task 8.
2. A click without dragging, with any tool. Expected: a dab, no exception, no NaN geometry. → tests in Tasks 3 and 4.
3. A mask painted up to or over the canvas edge. Expected: the outline still closes and the scene still clips. → test in Task 5.
4. Pressing Generate or Reroll again while a run is animating. Expected: the old run cancels and one coherent result remains. → tests in Tasks 7 and 8.
5. Extreme wind (±80°) or a very small canvas (phone layout). Expected: no exception, and the poster still fills the canvas. → test in Task 7.

## File Map

```
index.html            modify: script tags, brush grid, Generate section, error hook
style.css             modify: Generate section controls
app.js                rewrite: UI, pointer → brush, undo, render loop, SUMI.app
js/rng.js             create: seeded RNG + value noise
js/layers.js          create: layer stack, composite, snapshot, export
js/brushes.js         create: stroke state + 7 brushes + ink helpers
js/contour.js         create: mask grid, marching squares, bounds, inked edge
js/scene.js           create: bridge / pylon geometry, scene render, mask clip
js/generator.js       create: poster recipe + step runner, auto-mask, fill mask
tests.html            create: loads js/ + harness + *.test.js
tests/harness.js      create: T.* test API + result rendering
tests/run.mjs         create: headless runner
tests/*.test.js       create: one per module + app.smoke.test.js
README.md             modify: new tools, generator, tests
.claude/launch.json   add: static server config for visual checks
```

Script order (both pages): `js/rng.js`, `js/layers.js`, `js/brushes.js`, `js/contour.js`, `js/scene.js`, `js/generator.js`. Then `app.js` (index) or `tests/harness.js` + `tests/*.test.js` (tests).

Rule for test files: touch `SUMI` only inside test bodies, never at top level. Otherwise a missing module throws at load time and the tests in that file are never registered.

---

### Task 1: Test harness, headless runner, seeded RNG + noise

**Files:**
- Create: `tests/harness.js`, `tests/run.mjs`, `tests.html`, `js/rng.js`, `tests/rng.test.js`
- Add: `.claude/launch.json` (already on disk; python `http.server` on 5178)

**Interfaces:**
- Produces (harness, global `T`):
  - `T.test(name, fn)` — `fn` may be async
  - `T.assert(cond, msg)`, `T.eq(actual, expected, msg)`, `T.near(actual, expected, tol, msg)`
  - `T.skip(reason)` — throws a skip marker
  - `T.canvas(w, h) → { canvas, ctx }` — plain dpr-1 canvas
  - `T.pixels(canvas) → { w, h, data }`, `T.alpha(px, x, y) → 0..255`, `T.rgb(px, x, y) → [r, g, b, a]`
  - `T.inkCount(px, x0, y0, x1, y1) → number` — pixels with alpha > 0, x1/y1 exclusive
  - `T.centroid(px) → { x, y }` — alpha-weighted
  - `T.hash(canvas) → string` — FNV-1a hex of the RGBA bytes
- Produces (`js/rng.js`):
  - `SUMI.hashSeed(seed: string|number) → uint32`
  - `SUMI.makeRng(seed: string|number) → { next(), range(a, b), int(a, b), chance(p), gauss(), pick(arr) }` — mulberry32 seeded from `hashSeed`; `int` inclusive
  - `SUMI.makeNoise(seed) → { n1(x), n2(x, y), fbm2(x, y, octaves = 4) }` — smooth value noise, outputs in [0, 1]

**Harness and runner behaviour:**
- **Harness:** registers tests at parse time. It runs them sequentially on `window` `load` and records `window` `error` events as failing "load error" results. It then renders:
  - one `<li class="pass|fail|skip">name — message</li>` per test inside `<ul id="results">`
  - a summary element: `<div id="summary" data-passed="P" data-failed="F" data-skipped="S">P passed, F failed, S skipped</div>`
- **Runner (`tests/run.mjs`):** picks a browser from `SUMI_BROWSER`, then `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`, then `C:/Program Files/Google/Chrome/Application/chrome.exe`, then `google-chrome` / `chromium` on PATH.
  - Runs it with `--headless=new --disable-gpu --allow-file-access-from-files --virtual-time-budget=20000 --dump-dom <file URL of tests.html>`.
  - Parses `#summary` and prints each failing `<li>` with its tags stripped.
  - Prints the summary line. Exits 1 if `failed > 0` or no summary was found (prints "summary not found — page crashed or timed out").

- [ ] **Step 1: Write the harness, the runner, `tests.html` (scripts: `js/rng.js`, `tests/harness.js`, `tests/rng.test.js`) and these failing tests in `tests/rng.test.js`**

```js
T.test('rng: same seed → same sequence', () => {
  const a = SUMI.makeRng('eclipse'), b = SUMI.makeRng('eclipse');
  for (let i = 0; i < 100; i++) T.eq(a.next(), b.next(), 'step ' + i);
});
T.test('rng: different seeds differ', () => {
  const a = SUMI.makeRng('eclipse'), b = SUMI.makeRng('bridge');
  let same = 0; for (let i = 0; i < 50; i++) if (a.next() === b.next()) same++;
  T.assert(same < 5, 'sequences too similar');
});
T.test('rng: next in [0,1), int inclusive', () => {
  const r = SUMI.makeRng(42), seen = new Set();
  for (let i = 0; i < 10000; i++) { const v = r.next(); T.assert(v >= 0 && v < 1, 'next ' + v); }
  for (let i = 0; i < 3000; i++) seen.add(r.int(1, 3));
  T.eq([...seen].sort().join(), '1,2,3');
});
T.test('rng: gauss ~ N(0,1)', () => {
  const r = SUMI.makeRng(7); let s = 0, s2 = 0; const n = 20000;
  for (let i = 0; i < n; i++) { const g = r.gauss(); s += g; s2 += g * g; }
  const m = s / n; T.near(m, 0, 0.05, 'mean'); T.near(Math.sqrt(s2 / n - m * m), 1, 0.05, 'sd');
});
T.test('hashSeed: stable uint32, distinguishes inputs', () => {
  T.eq(SUMI.hashSeed('eclipse'), SUMI.hashSeed('eclipse'));
  T.assert(SUMI.hashSeed('a') !== SUMI.hashSeed('b'));
  const h = SUMI.hashSeed(42); T.assert(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});
T.test('noise: range, continuity, determinism', () => {
  const n = SUMI.makeNoise(3), m = SUMI.makeNoise(3), r = SUMI.makeRng(1);
  for (let i = 0; i < 500; i++) {
    const x = r.range(-50, 50), y = r.range(-50, 50), v = n.n2(x, y);
    T.assert(v >= 0 && v <= 1, 'n2 range ' + v);
    T.assert(Math.abs(v - n.n2(x + 0.01, y)) < 0.05, 'n2 jump');
    T.assert(Math.abs(n.n1(x) - n.n1(x + 0.01)) < 0.05, 'n1 jump');
    T.eq(v, m.n2(x, y));
    const f = n.fbm2(x, y); T.assert(f >= 0 && f <= 1, 'fbm range ' + f);
  }
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm it fails**

Expected: exit 1, `0 passed, 6 failed`, failures mention `SUMI` / `makeRng` undefined.

- [ ] **Step 3: Implement `js/rng.js`**

`window.SUMI = window.SUMI || {}` at the top. Box–Muller for `gauss`. Value noise uses a 256-entry permutation from the seeded RNG, smoothstep interpolation, and normalised `fbm2`.

- [ ] **Step 4: Run `node tests/run.mjs` and confirm it passes**

Expected: `6 passed, 0 failed, 0 skipped`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests.html tests/ js/rng.js .claude/launch.json
git commit -m "feat: test harness, headless runner, seeded rng + noise"
```

---

### Task 2: Layer stack

**Files:**
- Create: `js/layers.js`, `tests/layers.test.js`
- Modify: `tests.html` (add `js/layers.js`, `tests/layers.test.js`)

**Interfaces:**
- Consumes: `SUMI.makeNoise` (granulation tile, fixed seed `7`)
- Produces:
  - `SUMI.PAPER = '#f4f1ea'`, `SUMI.LAYER_NAMES = ['wash', 'scene', 'ink', 'fx']`
  - `SUMI.createLayers(w, h, dpr) → Layers` with props `w`, `h`, `dpr`, `dirty`, and:
    - `get(name) → { canvas, ctx }` for every LAYER_NAME plus `'mask'`
    - `clear(names: string[])`
    - `resize(w, h, dpr)` — ignored when `w` or `h` < 1
    - `isMaskEmpty() → boolean`
    - `snapshot(names) → Snap`, `restore(snap)`
    - `markDirty()`
    - `composite(ctx, { showMask = false, preview = null })` — `ctx` is the board ctx; `preview` is an optional `fn(ctx)` drawn last in CSS px
    - `exportCanvas(grainCanvas|null, stampText) → HTMLCanvasElement`
- Composite order: identity transform → paper fill → wash (via scratch canvas: granulation tile `destination-out` at ~0.35 alpha, then `multiply`) → scene (`multiply`) → ink → fx → mask as `rgba(220,40,40,0.35)` tint only if `showMask` → preview. Clears `dirty`.
- `exportCanvas` = composite without mask/preview, then grain (if given), then the stamp: `◯ ` + `stampText`, 12px, letter-spacing 0.35em where supported, `#111` at 0.55 alpha, at (26, 22) CSS px.

- [ ] **Step 1: Write the failing tests in `tests/layers.test.js`**

```js
T.test('layers: device-px canvases, dpr-scaled ctx', () => {
  const L = SUMI.createLayers(100, 80, 2), { canvas, ctx } = L.get('ink');
  T.eq(canvas.width, 200); T.eq(canvas.height, 160); T.eq(ctx.getTransform().a, 2);
  for (const n of [...SUMI.LAYER_NAMES, 'mask']) T.assert(L.get(n), n);
});
T.test('layers: snapshot/restore round-trip', () => {
  const L = SUMI.createLayers(100, 80, 1), ink = L.get('ink');
  ink.ctx.fillRect(10, 10, 30, 20); const before = T.hash(ink.canvas);
  const snap = L.snapshot(['ink']); L.clear(['ink']);
  T.assert(T.hash(ink.canvas) !== before); L.restore(snap); T.eq(T.hash(ink.canvas), before);
});
T.test('layers: isMaskEmpty', () => {
  const L = SUMI.createLayers(100, 80, 1);
  T.assert(L.isMaskEmpty()); L.get('mask').ctx.fillRect(40, 40, 6, 6);
  T.assert(!L.isMaskEmpty()); L.clear(['mask']); T.assert(L.isMaskEmpty());
});
T.test('layers: mask tint only with showMask', () => {
  const L = SUMI.createLayers(100, 80, 1), out = T.canvas(100, 80);
  L.get('mask').ctx.fillRect(0, 0, 100, 80);
  L.composite(out.ctx); let [r, g, b] = T.rgb(T.pixels(out.canvas), 50, 40);
  T.near(r, 244, 3); T.near(g, 241, 3); T.near(b, 234, 3);
  L.composite(out.ctx, { showMask: true }); [r, g] = T.rgb(T.pixels(out.canvas), 50, 40);
  T.assert(r > g + 20, 'tint expected');
});
T.test('layers: wash multiplies over paper', () => {
  const L = SUMI.createLayers(100, 80, 1), out = T.canvas(100, 80);
  L.get('wash').ctx.fillStyle = '#5a6d7e'; L.get('wash').ctx.fillRect(0, 0, 100, 80);
  L.composite(out.ctx); const [r, g, b] = T.rgb(T.pixels(out.canvas), 50, 40);
  const mul = [244 * 0x5a / 255, 241 * 0x6d / 255, 234 * 0x7e / 255];
  T.assert(r >= mul[0] - 4 && r < 244 && g >= mul[1] - 4 && g < 241 && b >= mul[2] - 4 && b < 234, [r, g, b].join());
});
T.test('layers: export has stamp, never mask', () => {
  const L = SUMI.createLayers(300, 200, 1); L.get('mask').ctx.fillRect(0, 0, 300, 200);
  const px = T.pixels(L.exportCanvas(null, 'ECLIPSE'));
  const [r, g] = T.rgb(px, 150, 150); T.near(r, 244, 3); T.near(g, 241, 3);
  let dark = 0; for (let y = 8; y < 30; y++) for (let x = 20; x < 160; x++) if (T.rgb(px, x, y)[0] < 200) dark++;
  T.assert(dark > 10, 'stamp pixels ' + dark);
});
T.test('layers: resize keeps content; zero size ignored', () => {
  const L = SUMI.createLayers(100, 80, 1); L.get('ink').ctx.fillRect(10, 10, 20, 20);
  L.resize(0, 0, 1); T.eq(L.w, 100); T.eq(T.alpha(T.pixels(L.get('ink').canvas), 15, 15), 255);
  L.resize(200, 160, 1); T.eq(L.get('ink').canvas.width, 200);
  T.assert(T.alpha(T.pixels(L.get('ink').canvas), 40, 40) > 0, 'scaled content');
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm the 7 layers tests fail**
- [ ] **Step 3: Implement `js/layers.js` to the interface above**

Snapshots are canvas copies made with `drawImage`, never `toDataURL`. `isMaskEmpty` scans alpha on a ≤128px downscaled copy. The granulation tile is 256×256 built from `fbm2`, used via `createPattern(…, 'repeat')`, and rebuilt on resize.
- [ ] **Step 4: Run `node tests/run.mjs` and confirm all pass** (`13 passed, 0 failed`)
- [ ] **Step 5: Commit** — `git add js/layers.js tests/layers.test.js tests.html && git commit -m "feat: layer stack with composite, snapshot, export"`

---

### Task 3: Stroke state + ink brushes (dry, spray, fine, speed lines)

**Files:**
- Create: `js/brushes.js`, `tests/brushes.test.js`
- Modify: `tests.html`

**Interfaces:**
- Consumes: `SUMI.makeRng`, `SUMI.makeNoise`
- Produces:
  - `SUMI.DEFAULT_WIND` (radians)
  - `SUMI.defaultOpts() → { size: 34, opacity: 0.85, dryness: 0.55, splatter: 40, bleed: 35, taper: 0.65, color: '#111318' }` — splatter and bleed are 0–100; the rest are 0–1 except size
  - `SUMI.makeStroke(ctx, seed, opts, wind = SUMI.DEFAULT_WIND) → st = { ctx, rng, noise, opts, wind, speed: 0, erase: false }`. `st.speed` is 0–1 (set by the caller per segment); brushes may keep per-stroke state on `st`.
  - Brush object: `{ layer, start(st, p), segment(st, a, b, w, dir), dab(st, p), end(st) }`
    - `a`, `b`, `p` are `{x, y}` in CSS px; `w` is the live width; `dir` is the travel direction in radians
  - `SUMI.brushes.dry | spray | fine | lines` — all with `layer: 'ink'`
  - `SUMI.ink.rgba(hex, a) → string`
  - `SUMI.ink.spray(ctx, rng, x, y, dir, radius, amount, opts)` — `amount` 0–1
  - `SUMI.ink.snapAngle(angle, wind, tol) → radians` — snaps to `wind` or `wind + π`, whichever is within `tol`
  - `SUMI.ink.snapEnd(p0, p1, wind, tol = 20° in rad) → {x, y}` — keeps length, snaps angle
  - `SUMI.ink.drawSpeedLine(ctx, rng, x0, y0, x1, y1, opts)`
- `lines` brush: `start` stores `st.p0`; `segment` stores `st.p1` and draws nothing; `end` draws `drawSpeedLine` from `p0` to `snapEnd(p0, p1, st.wind)` if the length is > 4px. `dab` does nothing.

**Dry brush algorithm.** The constants are starting values for the visual pass in Task 9; the tests below must keep passing.

```
start: N = clamp(round(size / 1.6), 8, 64)
  st.bristles = N × { t: clamp(gauss() * 0.33, -0.5, 0.5), wf: range(0.6, 1.4),
                      load: range(0.75, 1), off: range(0, 1000), last: null }
  st.arc = 0; st.budget = 900 * (1 - 0.6 * dryness)
segment(a, b, w, dir): len = |b - a|; if len < 0.01 return
  st.arc += len; ink = max(0.12, 1 - st.arc / st.budget); n = unit normal of a→b
  if bleed > 2: soft underlay line a→b (alpha opacity * 0.14 * bleed/100, width w * (0.45 + 0.9 * bleed/100))
  dry = min(0.95, dryness + taper * 0.35 * st.speed)
  each bristle: pt = b + n * t * w; if last is null: last = a + n * t * w
    thresh = dry * 0.55 + |t| * 2 * 0.25 + (1 - ink) * 0.6
    if noise.n1(st.arc * 0.035 + off) > thresh and last: round-cap line last→pt,
       width wf * max(0.6, w / N * 1.6), alpha opacity * load * (0.55 + 0.45 * ink)
    last = pt   // always, so gaps never bridge
  rng.chance(0.04): flyaway hair (0.7px, alpha 0.35 * opacity) off a random bristle
  rng.chance(splatter / 400): spray(b, dir, w * 0.4, splatter / 100 * 0.5)
dab(p): short 6px horizontal segment at w = size * 0.6, plus spray if splatter > 0
```

- `spray`: implements spec §3.3 (droplet cone, size and distance curves, stretching along travel, ~5% tails, micro-mist). The bleed halo from the current `burst()` is kept for droplets with r > 1.6.
- `fine`: midpoint-quadratic continuous line. Width 0.5–2.2px from `st.speed` (fast → thin). Alpha × (0.8 + 0.2 · noise).
- `drawSpeedLine`: 24 sub-quads, width `max(0.4, size * 0.03)` tapered to 0 at both ends, alpha varying with noise. `rng.chance(0.3)` adds a parallel echo 2–5px away at half alpha.

- [ ] **Step 1: Write the failing tests in `tests/brushes.test.js`**

```js
const black = () => ({ ...SUMI.defaultOpts(), opacity: 1, splatter: 0, bleed: 0, color: '#000000' });
function dragX(st, b, x0, x1, y, w) { b.start(st, { x: x0, y }); for (let x = x0; x < x1; x += 2) b.segment(st, { x, y }, { x: x + 2, y }, w, 0); b.end(st); }
function longestRuns(px, y0, y1) { const runs = []; for (let y = y0; y <= y1; y++) { let best = 0, cur = 0;
  for (let x = 0; x < px.w; x++) { if (T.alpha(px, x, y) > 0) { cur++; if (cur > best) best = cur; } else cur = 0; } if (best) runs.push(best); }
  return runs.sort((a, b) => a - b); }

T.test('dry: deterministic per seed', () => {
  const a = T.canvas(400, 120), b = T.canvas(400, 120);
  dragX(SUMI.makeStroke(a.ctx, 's', { ...black(), size: 30 }), SUMI.brushes.dry, 50, 350, 60, 30);
  dragX(SUMI.makeStroke(b.ctx, 's', { ...black(), size: 30 }), SUMI.brushes.dry, 50, 350, 60, 30);
  T.eq(T.hash(a.canvas), T.hash(b.canvas));
});
T.test('dry: continuous bristle streaks', () => {
  const c = T.canvas(400, 120);
  dragX(SUMI.makeStroke(c.ctx, 'streak', { ...black(), size: 30, dryness: 0.5 }), SUMI.brushes.dry, 50, 350, 60, 30);
  const runs = longestRuns(T.pixels(c.canvas), 40, 80);
  T.assert(runs.length >= 8, 'inked rows ' + runs.length);
  T.assert(runs[runs.length >> 1] >= 120, 'median longest run ' + runs[runs.length >> 1]);
});
T.test('dry: tail breaks up more than head', () => {
  const c = T.canvas(1300, 80);
  dragX(SUMI.makeStroke(c.ctx, 'tail', { ...black(), size: 30, dryness: 0.5 }), SUMI.brushes.dry, 50, 1250, 40, 30);
  const px = T.pixels(c.canvas), head = T.inkCount(px, 50, 20, 250, 60), tail = T.inkCount(px, 1050, 20, 1250, 60);
  T.assert(tail < head * 0.7, `tail ${tail} head ${head}`);
});
T.test('spray: biased along dir', () => {
  const c = T.canvas(300, 200);
  SUMI.ink.spray(c.ctx, SUMI.makeRng('spray'), 100, 100, 0, 30, 0.6, black());
  const m = T.centroid(T.pixels(c.canvas)); T.assert(m.x > 110, 'x ' + m.x); T.assert(Math.abs(m.y - 100) < 10, 'y ' + m.y);
});
T.test('snapAngle: both directions, tolerance', () => {
  const w = SUMI.DEFAULT_WIND, tol = 20 * Math.PI / 180;
  T.near(SUMI.ink.snapAngle(w + 0.2, w, tol), w, 1e-9);
  T.near(SUMI.ink.snapAngle(w + 0.5, w, tol), w + 0.5, 1e-9);
  T.near(SUMI.ink.snapAngle(w + Math.PI + 0.1, w, tol), w + Math.PI, 1e-9);
});
T.test('lines: draws only on end, snapped', () => {
  const c = T.canvas(400, 400), st = SUMI.makeStroke(c.ctx, 'l', black()), b = SUMI.brushes.lines;
  b.start(st, { x: 50, y: 350 }); b.segment(st, { x: 50, y: 350 }, { x: 330, y: 170 }, 34, -0.57);
  T.eq(T.inkCount(T.pixels(c.canvas), 0, 0, 400, 400), 0); b.end(st);
  T.assert(T.inkCount(T.pixels(c.canvas), 0, 0, 400, 400) > 50, 'line drawn');
  const e = SUMI.ink.snapEnd({ x: 50, y: 350 }, { x: 330, y: 170 }, SUMI.DEFAULT_WIND);
  T.near(Math.atan2(e.y - 350, e.x - 50), SUMI.DEFAULT_WIND, 1e-6);
});
T.test('fine: continuous line', () => {
  const c = T.canvas(300, 60);
  dragX(SUMI.makeStroke(c.ctx, 'f', black()), SUMI.brushes.fine, 50, 250, 30, 2);
  const runs = longestRuns(T.pixels(c.canvas), 25, 35); T.assert(runs[runs.length - 1] >= 180, 'run ' + runs[runs.length - 1]);
});
T.test('ink brushes: click without drag is safe and paints', () => {
  for (const name of ['dry', 'spray', 'fine']) {
    const c = T.canvas(200, 200), st = SUMI.makeStroke(c.ctx, 'click-' + name, black()), b = SUMI.brushes[name], p = { x: 100, y: 100 };
    b.start(st, p); b.dab(st, p); b.segment(st, p, p, 34, 0); b.end(st);
    T.assert(T.inkCount(T.pixels(c.canvas), 0, 0, 200, 200) > 0, name + ' painted nothing');
  }
  const c = T.canvas(50, 50), st = SUMI.makeStroke(c.ctx, 'lc', black()), p = { x: 25, y: 25 };
  SUMI.brushes.lines.start(st, p); SUMI.brushes.lines.dab(st, p); SUMI.brushes.lines.end(st);
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm the 8 brush tests fail**
- [ ] **Step 3: Implement `js/brushes.js` (`SUMI.ink` helpers, `makeStroke`, `defaultOpts`, the four brushes) per the interfaces and algorithm above**
- [ ] **Step 4: Run `node tests/run.mjs` and confirm all pass** (`21 passed`)
- [ ] **Step 5: Commit** — `git commit -m "feat: dry brush with persistent bristles, directional spray, fine line, speed lines"`

---

### Task 4: Wash, shard and mask brushes

**Files:**
- Modify: `js/brushes.js`, `tests/brushes.test.js`

**Interfaces:**
- Consumes: Task 3 (`makeStroke`, `ink.spray`, `ink.rgba`)
- Produces:
  - `SUMI.ink.deformPolygon(pts, depth, spread, rng) → pts` — length `pts.length · 2^depth`. Midpoint displacement: the offset is gaussian × `spread` × edge length; the result is clamped to ≤ 1.8× the original max radius from the centroid.
  - `SUMI.ink.washBlob(ctx, rng, x, y, r, layers, opts)` — 10-gon, base deform depth 3 (spread 0.45). Each of `layers` re-deforms depth 2 (spread 0.3), is filled at alpha `opacity · range(0.02, 0.05)`, and has its edge stroked at `opacity · 0.04`, width 1.2. After each deform, every vertex is clamped to ≤ 1.8·r from (x, y).
  - `SUMI.ink.shard(ctx, rng, x, y, size, wind, opts)` — per spec §3.3. Paper fill `#f4f1ea`. The fold side is shaded `rgba(90,100,110,0.25)`. ~60% of edges get a 0.8px ink outline. Shadow `rgba(0,0,0,0.12)`, blur 3. Spray if `splatter > 0`.
  - `SUMI.ink.maskDab(ctx, x, y, r, erase)` — opaque white core to 70% radius, fading to 0 at r; `destination-out` when `erase`.
  - `SUMI.brushes.wash` (layer `'wash'`, dabs every 0.4·w along the path, 6 layers each, r = w·0.55)
  - `SUMI.brushes.shard` (layer `'fx'`, stamped every `clamp(size·0.7, 18, 80)` px of travel, as in the current `strokeTo`)
  - `SUMI.brushes.mask` (layer `'mask'`, dab every 0.25·size, r = size/2, erases when `st.erase`)

- [ ] **Step 1: Append the failing tests to `tests/brushes.test.js`**

```js
T.test('brushes: target layers', () => {
  const want = { dry: 'ink', spray: 'ink', fine: 'ink', lines: 'ink', wash: 'wash', shard: 'fx', mask: 'mask' };
  for (const k in want) T.eq(SUMI.brushes[k] && SUMI.brushes[k].layer, want[k], k);
});
T.test('deformPolygon: vertex count and bound', () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ x: 50 * Math.cos(i / 10 * 2 * Math.PI), y: 50 * Math.sin(i / 10 * 2 * Math.PI) }));
  const out = SUMI.ink.deformPolygon(pts, 3, 0.45, SUMI.makeRng(1));
  T.eq(out.length, 80); for (const p of out) T.assert(Math.hypot(p.x, p.y) <= 90 + 1e-6, 'radius ' + Math.hypot(p.x, p.y));
});
T.test('wash: translucent, bounded, deterministic', () => {
  const a = T.canvas(300, 300), b = T.canvas(300, 300), o = { ...SUMI.defaultOpts(), opacity: 1, color: '#000000' };
  SUMI.ink.washBlob(a.ctx, SUMI.makeRng('w'), 150, 150, 60, 30, o); SUMI.ink.washBlob(b.ctx, SUMI.makeRng('w'), 150, 150, 60, 30, o);
  T.eq(T.hash(a.canvas), T.hash(b.canvas));
  const px = T.pixels(a.canvas), al = T.alpha(px, 150, 150); T.assert(al > 0 && al < 200, 'centre alpha ' + al);
  T.eq(T.inkCount(px, 0, 0, 300, 40) + T.inkCount(px, 0, 261, 300, 300), 0, 'ink beyond 1.8r');
});
T.test('shard: opaque paper face, deterministic', () => {
  const a = T.canvas(200, 200), b = T.canvas(200, 200), o = { ...SUMI.defaultOpts(), splatter: 0 };
  SUMI.ink.shard(a.ctx, SUMI.makeRng('s'), 100, 100, 60, SUMI.DEFAULT_WIND, o);
  SUMI.ink.shard(b.ctx, SUMI.makeRng('s'), 100, 100, 60, SUMI.DEFAULT_WIND, o);
  T.eq(T.hash(a.canvas), T.hash(b.canvas));
  const [r, , , al] = T.rgb(T.pixels(a.canvas), 100, 100); T.assert(al === 255 && r > 150, 'centre ' + r + ',' + al);
});
T.test('mask: dab paints, erase clears', () => {
  const c = T.canvas(100, 100);
  SUMI.ink.maskDab(c.ctx, 50, 50, 20, false); T.eq(T.alpha(T.pixels(c.canvas), 50, 50), 255);
  SUMI.ink.maskDab(c.ctx, 50, 50, 20, true); T.eq(T.alpha(T.pixels(c.canvas), 50, 50), 0);
});
T.test('paint brushes: click without drag is safe and paints', () => {
  for (const name of ['wash', 'shard', 'mask']) {
    const c = T.canvas(200, 200), st = SUMI.makeStroke(c.ctx, 'click-' + name, { ...SUMI.defaultOpts(), opacity: 1 }), b = SUMI.brushes[name], p = { x: 100, y: 100 };
    b.start(st, p); b.dab(st, p); b.segment(st, p, p, 34, 0); b.end(st);
    T.assert(T.inkCount(T.pixels(c.canvas), 0, 0, 200, 200) > 0, name + ' painted nothing');
  }
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm the 6 new tests fail**
- [ ] **Step 3: Implement the helpers and the three brushes in `js/brushes.js`**
- [ ] **Step 4: Run `node tests/run.mjs` and confirm all pass** (`27 passed`)
- [ ] **Step 5: Commit** — `git commit -m "feat: watercolor wash, torn shards, mask brush"`

---

### Task 5: Mask contour tracing and inked edge

**Files:**
- Create: `js/contour.js`, `tests/contour.test.js`
- Modify: `tests.html`

**Interfaces:**
- Consumes: `SUMI.ink.rgba`
- Produces:
  - `SUMI.contour.grid(canvas, cell = 4, dpr = 1) → { cols, rows, cell, a: Float32Array }` — mean alpha (0–1) per `cell`×`cell` CSS-px block; `cols = ceil(canvas.width / dpr / cell)`
  - `SUMI.contour.trace(grid, threshold = 0.5) → Array<{ pts: {x, y}[], closed: boolean }>` — CSS px
  - `SUMI.contour.bounds(grid, threshold = 0.5) → { x, y, w, h } | null`
  - `SUMI.contour.inkEdge(ctx, rng, noise, loops, opts)` — per spec §3.4, including 2–5 inner fold strokes
- Marching squares notes:
  - Treat the grid as padded with a ring of zeros, so shapes touching the border still close.
  - Sample at cell centres and interpolate linearly along the cell edges.
  - Resolve saddle cases 5/10 with the mean of the four corners.
  - Join segments into polylines through an endpoint map keyed on coordinates rounded to 1e-3. A polyline is `closed` when it returns to its start.
  - Drop loops with fewer than 4 points.

- [ ] **Step 1: Write the failing tests in `tests/contour.test.js`**

```js
function mask(w, h, draw) { const c = T.canvas(w, h); c.ctx.fillStyle = '#fff'; draw(c.ctx); return c.canvas; }
const perim = pts => pts.reduce((s, p, i) => s + Math.hypot(p.x - pts[(i + 1) % pts.length].x, p.y - pts[(i + 1) % pts.length].y), 0);
T.test('contour: grid size', () => { const g = SUMI.contour.grid(mask(200, 120, () => {}), 4, 1); T.eq(g.cols, 50); T.eq(g.rows, 30); });
T.test('contour: circle → one closed loop, right perimeter', () => {
  const loops = SUMI.contour.trace(SUMI.contour.grid(mask(200, 200, x => { x.beginPath(); x.arc(100, 100, 50, 0, 7); x.fill(); })));
  T.eq(loops.length, 1); T.assert(loops[0].closed); T.near(perim(loops[0].pts), 2 * Math.PI * 50, 0.1 * 2 * Math.PI * 50);
});
T.test('contour: two blobs → two loops; empty → none', () => {
  const two = mask(300, 120, x => { x.fillRect(20, 20, 60, 60); x.fillRect(180, 30, 70, 50); });
  T.eq(SUMI.contour.trace(SUMI.contour.grid(two)).length, 2);
  T.eq(SUMI.contour.trace(SUMI.contour.grid(mask(100, 100, () => {}))).length, 0);
});
T.test('contour: shape touching the canvas edge still closes', () => {
  const loops = SUMI.contour.trace(SUMI.contour.grid(mask(200, 200, x => x.fillRect(0, 0, 100, 200))));
  T.eq(loops.length, 1); T.assert(loops[0].closed);
});
T.test('contour: bounds', () => {
  const b = SUMI.contour.bounds(SUMI.contour.grid(mask(200, 200, x => { x.beginPath(); x.arc(100, 100, 50, 0, 7); x.fill(); })));
  T.near(b.x, 50, 8); T.near(b.y, 50, 8); T.near(b.w, 100, 16); T.near(b.h, 100, 16);
  T.eq(SUMI.contour.bounds(SUMI.contour.grid(mask(50, 50, () => {}))), null);
});
T.test('contour: inkEdge draws, deterministic', () => {
  const loops = SUMI.contour.trace(SUMI.contour.grid(mask(200, 200, x => { x.beginPath(); x.arc(100, 100, 60, 0, 7); x.fill(); })));
  const a = T.canvas(200, 200), b = T.canvas(200, 200), o = SUMI.defaultOpts();
  SUMI.contour.inkEdge(a.ctx, SUMI.makeRng('e'), SUMI.makeNoise('e'), loops, o);
  SUMI.contour.inkEdge(b.ctx, SUMI.makeRng('e'), SUMI.makeNoise('e'), loops, o);
  T.eq(T.hash(a.canvas), T.hash(b.canvas)); T.assert(T.inkCount(T.pixels(a.canvas), 0, 0, 200, 200) > 100);
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm the 6 contour tests fail**
- [ ] **Step 3: Implement `js/contour.js`**
- [ ] **Step 4: Run `node tests/run.mjs` and confirm all pass** (`33 passed`)
- [ ] **Step 5: Commit** — `git commit -m "feat: mask contour tracing and inked edge"`

---

### Task 6: Double-exposure scene

**Files:**
- Create: `js/scene.js`, `tests/scene.test.js`
- Modify: `tests.html`

**Interfaces:**
- Consumes: `SUMI.ink.washBlob`, `SUMI.ink.rgba`, rng, noise
- Produces:
  - `SUMI.scene.bridgeGeometry(box, rng) → { vp: {x, y}, deck: { near: [{x, y}, {x, y}], far: {x, y} }, towers: [{ x, yTop, yDeck, w }], cables: {x, y}[][], suspenders: [{x, y}, {x, y}][] }`
    - `box = { x, y, w, h }` in CSS px
    - `vp.x ∈ [box.x + 0.05·box.w, box.x + 0.30·box.w]`, `vp.y ∈ [box.y + 0.45·box.h, box.y + 0.60·box.h]`
    - 2–3 towers ordered far → near (height `yDeck − yTop` strictly increasing), all with `x` inside the box and `yTop ≥ box.y`
  - `SUMI.scene.pylonGeometry(base, height, rng) → { legs: [[base, top], [base, top]], braces: [{x, y}, {x, y}][], arms: [{ y, x0, x1 }], wires: {x, y}[][] }`
    - top width < base width; 2–3 arms; every arm tip starts at least one wire
  - `SUMI.scene.render(ctx, rng, noise, box) → { bridge, pylons }` — 1–3 pylons, drawn far → near, palette and fog pass per spec §3.5
  - `SUMI.scene.clipToMask(sceneCtx, maskCanvas, feather)`. Steps:
    1. Blur a copy of the mask by `feather / 2` with `ctx.filter`, skipped when unsupported.
    2. `destination-in` with the blurred copy.
    3. `destination-in` with the original mask, so nothing survives outside it.
    - Work in device pixels: identity transform, `drawImage` at the full canvas size.

- [ ] **Step 1: Write the failing tests in `tests/scene.test.js`**

```js
const box = { x: 100, y: 50, w: 400, h: 500 };
T.test('bridge: placement and tower order', () => {
  for (let s = 0; s < 20; s++) {
    const g = SUMI.scene.bridgeGeometry(box, SUMI.makeRng(s));
    T.assert(g.vp.x >= box.x + 0.05 * box.w - 1e-6 && g.vp.x <= box.x + 0.30 * box.w + 1e-6, 'vp.x ' + g.vp.x);
    T.assert(g.vp.y >= box.y + 0.45 * box.h - 1e-6 && g.vp.y <= box.y + 0.60 * box.h + 1e-6, 'vp.y ' + g.vp.y);
    T.assert(g.towers.length >= 2 && g.towers.length <= 3, 'towers ' + g.towers.length);
    g.towers.forEach((t, i) => {
      T.assert(t.x >= box.x && t.x <= box.x + box.w && t.yTop >= box.y, 'tower in box');
      if (i) T.assert(t.yDeck - t.yTop > g.towers[i - 1].yDeck - g.towers[i - 1].yTop, 'far→near');
    });
    T.assert(g.cables.length > 0 && g.suspenders.length > 0);
  }
});
T.test('pylon: tapers, braced, armed, wired', () => {
  const g = SUMI.scene.pylonGeometry({ x: 300, y: 500 }, 300, SUMI.makeRng(3));
  const base = Math.abs(g.legs[1][0].x - g.legs[0][0].x), top = Math.abs(g.legs[1][1].x - g.legs[0][1].x);
  T.assert(top < base, `top ${top} base ${base}`); T.assert(g.braces.length > 0);
  T.assert(g.arms.length >= 2 && g.arms.length <= 3); T.assert(g.wires.length >= g.arms.length);
});
T.test('scene: render deterministic, returns geometry', () => {
  const a = T.canvas(600, 600), b = T.canvas(600, 600);
  const ga = SUMI.scene.render(a.ctx, SUMI.makeRng('sc'), SUMI.makeNoise('sc'), box);
  SUMI.scene.render(b.ctx, SUMI.makeRng('sc'), SUMI.makeNoise('sc'), box);
  T.eq(T.hash(a.canvas), T.hash(b.canvas)); T.assert(ga.pylons.length >= 1 && ga.pylons.length <= 3);
  T.assert(T.inkCount(T.pixels(a.canvas), 0, 0, 600, 600) > 5000, 'scene too empty');
});
T.test('clipToMask: nothing survives outside the mask', () => {
  for (const feather of [0, 12]) {
    const s = T.canvas(100, 100), m = T.canvas(100, 100);
    s.ctx.fillRect(0, 0, 100, 100); m.ctx.fillStyle = '#fff'; m.ctx.fillRect(0, 0, 50, 100);
    SUMI.scene.clipToMask(s.ctx, m.canvas, feather);
    const px = T.pixels(s.canvas); T.assert(T.alpha(px, 20, 50) > 0, 'inside ' + feather); T.eq(T.inkCount(px, 51, 0, 100, 100), 0, 'outside ' + feather);
  }
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm the 4 scene tests fail**
- [ ] **Step 3: Implement `js/scene.js`**
- [ ] **Step 4: Run `node tests/run.mjs` and confirm all pass** (`37 passed`)
- [ ] **Step 5: Commit** — `git commit -m "feat: procedural bridge/pylon double-exposure scene"`

---

### Task 7: Generator

**Files:**
- Create: `js/generator.js`, `tests/generator.test.js`
- Modify: `tests.html`

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces:
  - `SUMI.generate({ layers, seed, wind = SUMI.DEFAULT_WIND, inkEdge = true, animate = true, onLog = () => {} }) → { cancel(), done: Promise<void> }`
    - Builds the spec §6 recipe as an ordered list of step closures. Every log line names its step: `mist`, `scene`, `edge` (only when `inkEdge`), `slash`, `spray`, `shard`, `lines`.
    - `animate: false` runs every step synchronously before returning (`done` already resolved).
    - `animate: true` runs nothing synchronously, then runs steps on `requestAnimationFrame` within ~12ms per frame. `cancel()` stops it and resolves `done` immediately.
    - Calls `layers.markDirty()` after each step.
  - `SUMI.autoMask(rng, layers, wind) → HTMLCanvasElement` — the same device size as the layers; 3–5 soft ellipses along the diagonal band; never written to the mask layer
  - `SUMI.fillMask({ layers, seed }) → { bridge, pylons } | null` — `null` and no change when the mask is empty; otherwise clears `scene`, renders into the mask bounds and clips with feather 16
- Slash speed profile: `w(t) = wMax · (1 − 0.7 · t^1.5)` and `st.speed = t` along the stroke, path sampled every 3px.

- [ ] **Step 1: Write the failing tests in `tests/generator.test.js`**

```js
const fresh = (w = 400, h = 300) => SUMI.createLayers(w, h, 1);
const hashes = L => SUMI.LAYER_NAMES.map(n => T.hash(L.get(n).canvas)).join('|');
const gen = (L, seed, extra = {}) => SUMI.generate({ layers: L, seed, animate: false, ...extra }).done;
T.test('generate: same seed → identical layers', async () => {
  const a = fresh(), b = fresh(); await gen(a, 'eclipse'); await gen(b, 'eclipse'); T.eq(hashes(a), hashes(b));
});
T.test('generate: different seeds differ', async () => {
  const a = fresh(), b = fresh(); await gen(a, 'eclipse'); await gen(b, 'bridge');
  T.assert(T.hash(a.get('ink').canvas) !== T.hash(b.get('ink').canvas));
});
T.test('generate: every layer painted; auto-mask not stored', async () => {
  const L = fresh(); await gen(L, '42');
  for (const n of SUMI.LAYER_NAMES) T.assert(T.inkCount(T.pixels(L.get(n).canvas), 0, 0, 400, 300) > 0, n + ' empty');
  T.assert(L.isMaskEmpty(), 'auto-mask leaked into mask layer');
});
T.test('generate: painted mask confines the scene', async () => {
  const L = fresh(); const m = L.get('mask').ctx; m.fillStyle = '#fff'; m.fillRect(50, 50, 100, 200);
  await gen(L, 'masked'); const px = T.pixels(L.get('scene').canvas);
  T.eq(T.inkCount(px, 0, 0, 400, 49) + T.inkCount(px, 0, 251, 400, 300) + T.inkCount(px, 0, 0, 49, 300) + T.inkCount(px, 151, 0, 400, 300), 0);
  T.assert(T.inkCount(px, 50, 50, 150, 250) > 0, 'scene missing inside mask');
});
T.test('generate: logs every recipe step', async () => {
  const logs = []; await gen(fresh(), 'log', { onLog: m => logs.push(m) }); const all = logs.join('\n');
  for (const k of ['mist', 'scene', 'edge', 'slash', 'spray', 'shard', 'lines']) T.assert(all.includes(k), 'missing ' + k);
});
T.test('generate: cancel stops an animated run', async () => {
  const logs = [], run = SUMI.generate({ layers: fresh(), seed: 'c', animate: true, onLog: m => logs.push(m) });
  run.cancel(); await run.done; await new Promise(r => setTimeout(r, 100)); T.eq(logs.length, 0);
});
T.test('generate: extreme wind and tiny canvas', async () => {
  for (const deg of [-80, 80]) { const L = fresh(120, 90); await gen(L, 'w' + deg, { wind: deg * Math.PI / 180 });
    T.assert(T.inkCount(T.pixels(L.get('ink').canvas), 0, 0, 120, 90) > 0, 'ink at ' + deg); }
});
T.test('fillMask: null on empty mask, scene only inside mask', () => {
  const L = fresh(); T.eq(SUMI.fillMask({ layers: L, seed: 'f' }), null);
  const m = L.get('mask').ctx; m.fillStyle = '#fff'; m.fillRect(100, 40, 150, 220);
  T.assert(SUMI.fillMask({ layers: L, seed: 'f' })); const px = T.pixels(L.get('scene').canvas);
  T.assert(T.inkCount(px, 100, 40, 250, 260) > 0); T.eq(T.inkCount(px, 0, 0, 99, 300), 0);
  T.eq(T.inkCount(T.pixels(L.get('ink').canvas), 0, 0, 400, 300), 0, 'fillMask touched ink');
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm the 8 generator tests fail**
- [ ] **Step 3: Implement `js/generator.js`**
- [ ] **Step 4: Run `node tests/run.mjs` and confirm all pass** (`45 passed`)
- [ ] **Step 5: Commit** — `git commit -m "feat: seeded poster generator, auto-mask, fill mask"`

---

### Task 8: App rewire (UI, input, undo, render loop)

**Files:**
- Modify: `index.html`, `style.css`
- Rewrite: `app.js`
- Create: `tests/app.smoke.test.js`
- Modify: `tests.html`

**Interfaces:**
- Consumes: everything above
- Produces: `SUMI.app = { S, layers, setTool(name), generate({ animate = true } = {}) → run, cancel(), undo(), undoDepth(), fillMask(), clearMask(), renderNow(), get busy() }`

**`index.html`:**
- First script in `<head>`: `window.__errors = []; addEventListener('error', e => __errors.push(e.message));`
- Brush grid `data-brush` values: `dry spray fine lines wash shard mask`, with labels Dry brush, Spray, Fine line, Speed lines, Wash, Shard, Mask (keys 1–7).
- New "Generate" section:
  - `#seedInput` (text)
  - `#btnGenerate`, `#btnReroll`
  - `#s-wind` (range −80…80, value −35) with `#v-wind`
  - `#chkInkEdge` (checked)
  - `#btnFillMask`, `#btnClearMask`
- Remove `#btnDemo`.
- Scripts in the order from the File Map.

**`app.js` behaviour:**
- **State.** `S` = `defaultOpts()` fields + `tool: 'dry'`, `wind: -35` (deg), `seed` (random 6-char base36), `paper`, `grain`.
- **Layers.** `layers = SUMI.createLayers(...)` sized to `#board`, dpr capped at 2. Window resize → `layers.resize` + `renderGrain`; the existing grain code is kept.
- **Pointer down:**
  - ignored while `busy`
  - `pushUndo([brush.layer])`
  - `st = SUMI.makeStroke(layers.get(brush.layer).ctx, Math.random(), opts, wind rad)`, with `st.erase = e.altKey`
  - `brush.start` then `brush.dab`
  - `setPointerCapture` wrapped in try/catch (synthetic pointers throw)
- **Pointer move.** Keep the current `strokeTo` velocity maths (`smoothV`, width glide, `ctx.globalAlpha = velA`), then set `st.speed = sn` and call `brush.segment` per sub-step with `dir = atan2`.
- **Pointer up.** `brush.end`; log the stroke; for the mask tool, refresh the Fill-mask disabled state.
- **Render loop.** rAF calls `layers.composite(boardCtx, { showMask: tool === 'mask', preview })` when `layers.dirty`. While dragging Speed lines, `preview` draws a 1px dashed line to the snapped end. `renderNow()` composites synchronously.
- **Undo.** A stack of `layers.snapshot(names)`, max 15. Pushes per action:
  - stroke: its layer
  - Generate: `['wash', 'scene', 'ink', 'fx']`
  - Fill mask: `['scene']`
  - Clear mask: `['mask']`
  - Clear: all four plus mask
- **Generate.** Cancels any running generation, pushes undo, and sets `busy`. `#btnGenerate` reads "Cancel" (clicking it cancels) until `done`. A run's `done` handler clears `busy` only if that run is still the current one, so a cancelled run can't clear a newer run's state. Reroll sets a new seed into `#seedInput`, then generates. Generator logs go to `#log`.
- **Hotkeys.** `1`–`7`, `[`, `]`, Ctrl+Z. Ignored when `e.target` is an `input` (other than range or checkbox), a `textarea` or `contenteditable`.
- **Export.** PNG via `layers.exportCanvas(S.paper && S.grain > 0 ? grainCanvas : null, 'ECLIPSE')`.

- [ ] **Step 1: Write the failing smoke tests in `tests/app.smoke.test.js`**

```js
function loadApp() { return new Promise((res, rej) => {
  const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;left:-3000px;top:0;width:1200px;height:800px'; f.src = 'index.html';
  f.onload = () => { try { const w = f.contentWindow; res({ w, app: w.SUMI.app, board: w.document.getElementById('board') }); }
    catch (e) { e.name === 'SecurityError' ? res(null) : rej(e); } };
  document.body.appendChild(f); }); }
async function app() { const a = await loadApp(); if (!a) T.skip('iframe blocked on file:// — use node tests/run.mjs'); return a; }
function drag(a, pts, extra = {}) { const r = a.board.getBoundingClientRect(), ev = (type, p) => a.board.dispatchEvent(new a.w.PointerEvent(type, { clientX: r.left + p.x, clientY: r.top + p.y, pointerId: 1, bubbles: true, ...extra }));
  ev('pointerdown', pts[0]); for (const p of pts.slice(1)) ev('pointermove', p); a.w.dispatchEvent(new a.w.PointerEvent('pointerup', { pointerId: 1 })); }
const line = (x0, y0, x1, y1, n = 30) => Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n }));
const inked = (a, name) => T.inkCount(T.pixels(a.app.layers.get(name).canvas), 0, 0, 1e5, 1e5);

T.test('app: loads with no errors', async () => { const a = await app(); T.eq(a.w.__errors.length, 0, a.w.__errors.join('; ')); T.assert(a.app); });
T.test('app: dry stroke paints ink, undo removes it', async () => {
  const a = await app(); a.app.setTool('dry'); drag(a, line(100, 400, 500, 200)); T.assert(inked(a, 'ink') > 0);
  a.app.undo(); T.eq(inked(a, 'ink'), 0);
});
T.test('app: typing in the seed field does not switch tools', async () => {
  const a = await app(); a.app.setTool('dry'); const inp = a.w.document.getElementById('seedInput'); inp.focus();
  inp.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: '3', bubbles: true })); T.eq(a.app.S.tool, 'dry');
});
T.test('app: mask tint only while mask tool active; never exported', async () => {
  const a = await app(); a.app.setTool('mask'); drag(a, line(300, 300, 320, 300, 4)); a.app.renderNow();
  const ctx = a.board.getContext('2d'), d = a.w.devicePixelRatio > 2 ? 2 : (a.w.devicePixelRatio || 1);
  const [r, g] = ctx.getImageData(310 * d, 300 * d, 1, 1).data; T.assert(r > g + 20, 'tint on board');
  const out = a.app.layers.exportCanvas(null, 'ECLIPSE'), [er, eg] = out.getContext('2d').getImageData(310 * d, 300 * d, 1, 1).data;
  T.assert(Math.abs(er - eg) < 12, 'tint leaked into export');
});
T.test('app: fill mask disabled until a mask exists', async () => {
  const a = await app(), btn = a.w.document.getElementById('btnFillMask'); T.assert(btn.disabled, 'should start disabled');
  a.app.setTool('mask'); drag(a, line(200, 200, 260, 260, 6)); T.assert(!btn.disabled, 'should enable');
});
T.test('app: second generate cancels the first', async () => {
  const a = await app(); a.app.generate(); await a.app.generate({ animate: false }).done;
  T.assert(!a.app.busy, 'still busy'); T.assert(inked(a, 'ink') > 0);
});
T.test('app: undo history capped at 15', async () => {
  const a = await app(); a.app.setTool('fine'); for (let i = 0; i < 20; i++) drag(a, line(50, 50 + i * 10, 300, 50 + i * 10, 4));
  T.eq(a.app.undoDepth(), 15);
});
```

- [ ] **Step 2: Run `node tests/run.mjs` and confirm the 7 smoke tests fail** (`SUMI.app` undefined)
- [ ] **Step 3: Update `index.html` and `style.css`; rewrite `app.js` per the behaviour above**
- [ ] **Step 4: Run `node tests/run.mjs` and confirm all pass** (`52 passed, 0 failed, 0 skipped`)
- [ ] **Step 5: Double-click check.** Open `index.html` from Explorer (or `start index.html`), click Generate, and confirm the poster paints with no console errors.
- [ ] **Step 6: Commit** — `git commit -m "feat: wire layered engine, generator and new tools into the console"`

---

### Task 9: Visual tuning against the reference, README

**Files:**
- Modify: `js/brushes.js`, `js/scene.js`, `js/generator.js` (constants only), `README.md`

- [ ] **Step 1: Capture screenshots.** Start the `sumi` preview (`.claude/launch.json`) at 1400×900. Capture seeds `eclipse`, `bridge` and `42`, each with no mask and with a painted diagonal figure mask.
- [ ] **Step 2: Compare each screenshot with the reference.** Tune constants until all of these hold:
  - one dominant lower-left → upper-right diagonal
  - slashes read as continuous bristle streaks that dry out at the tail
  - the spray streaks along the slash direction, mostly fine dots
  - wash edges are visibly darker than wash interiors
  - bridge towers and pylons are readable inside the mask and fade toward its edge
  - shards are visible as light chips with a shaded fold
  - speed lines are long and nearly parallel
  - the paper stays mostly clean in the top-left quadrant
- [ ] **Step 3: Re-run `node tests/run.mjs` after tuning.** Expected: `52 passed, 0 failed, 0 skipped`.
- [ ] **Step 4: Check for unseeded randomness.** Run `grep -n "Math.random" js/`. Expected: no output. Then run `grep -n "toDataURL" app.js js/`. Expected: only the PNG-save line in `app.js`.
- [ ] **Step 5: Update `README.md`.** Cover the seven tools and keys, Generate / Reroll / seed / wind / ink-edge / Fill mask, the painted-mask workflow, `node tests/run.mjs`, and the file map.
- [ ] **Step 6: Commit** — `git commit -m "feat: tune ink look against reference; docs"`
