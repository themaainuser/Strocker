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
