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
const paperRGB = L => SUMI.ink.parseColor(L.paper).slice(0, 3);
T.test('layers: a new stack is pearl white; setPaper recolours the board with a full redraw', () => {
  const L = SUMI.createLayers(100, 80, 1), out = T.canvas(100, 80);
  T.eq(L.paper, '#f8f6f0', 'pearl white');
  L.composite(out.ctx);
  T.eq(T.rgb(T.pixels(out.canvas), 50, 40).slice(0, 3).join(), '248,246,240');
  const full = L.stats.fullFrames;
  L.setPaper('#e5d8c0');
  T.assert(L.dirty, 'a new paper needs a redraw');
  L.composite(out.ctx);
  T.eq(L.stats.fullFrames, full + 1, 'the whole board is redrawn');
  T.eq(T.rgb(T.pixels(out.canvas), 50, 40).slice(0, 3).join(), '229,216,192');
  L.get('ink').ctx.fillRect(10, 10, 5, 5); L.markArea({ x0: 10, y0: 10, x1: 15, y1: 15 }, 'ink');
  L.composite(out.ctx);
  T.eq(T.rgb(T.pixels(out.canvas), 18, 18).slice(0, 3).join(), '229,216,192', 'area redraws keep the new paper');
});
T.test('layers: mask tint only with showMask', () => {
  const L = SUMI.createLayers(100, 80, 1), out = T.canvas(100, 80), [pr, pg, pb] = paperRGB(L);
  L.get('mask').ctx.fillRect(0, 0, 100, 80);
  L.composite(out.ctx); let [r, g, b] = T.rgb(T.pixels(out.canvas), 50, 40);
  T.near(r, pr, 3); T.near(g, pg, 3); T.near(b, pb, 3);
  L.composite(out.ctx, { showMask: true }); [r, g] = T.rgb(T.pixels(out.canvas), 50, 40);
  T.assert(r > g + 20, 'tint expected');
});
T.test('layers: wash multiplies over paper', () => {
  const L = SUMI.createLayers(100, 80, 1), out = T.canvas(100, 80);
  L.get('wash').ctx.fillStyle = '#5a6d7e'; L.get('wash').ctx.fillRect(0, 0, 100, 80);
  L.composite(out.ctx); const [r, g, b] = T.rgb(T.pixels(out.canvas), 50, 40), [pr, pg, pb] = paperRGB(L);
  const mul = [pr * 0x5a / 255, pg * 0x6d / 255, pb * 0x7e / 255];
  T.assert(r >= mul[0] - 4 && r < pr && g >= mul[1] - 4 && g < pg && b >= mul[2] - 4 && b < pb, [r, g, b].join());
});
T.test('layers: export has stamp, never mask', () => {
  const L = SUMI.createLayers(300, 200, 1); L.get('mask').ctx.fillRect(0, 0, 300, 200);
  const px = T.pixels(L.exportCanvas(null, 'ECLIPSE'));
  const [r, g] = T.rgb(px, 150, 150), [pr, pg] = paperRGB(L); T.near(r, pr, 3); T.near(g, pg, 3);
  let dark = 0; for (let y = 8; y < 30; y++) for (let x = 20; x < 160; x++) if (T.rgb(px, x, y)[0] < 200) dark++;
  T.assert(dark > 10, 'stamp pixels ' + dark);
});
T.test('layers: resize keeps content; zero size ignored', () => {
  const L = SUMI.createLayers(100, 80, 1); L.get('ink').ctx.fillRect(10, 10, 20, 20);
  L.resize(0, 0, 1); T.eq(L.w, 100); T.eq(T.alpha(T.pixels(L.get('ink').canvas), 15, 15), 255);
  L.resize(200, 160, 1); T.eq(L.get('ink').canvas.width, 200);
  T.assert(T.alpha(T.pixels(L.get('ink').canvas), 40, 40) > 0, 'scaled content');
});
T.test('layers: paint layers use the CPU rasteriser so recorded strokes replay identically', () => {
  // GPU and CPU canvases antialias differently, and Chrome can silently move a GPU canvas
  // to the CPU after readbacks — so a live stroke and its replay must both start on the CPU
  const L = SUMI.createLayers(50, 40, 1);
  for (const n of [...SUMI.LAYER_NAMES, 'mask']) T.eq(L.get(n).ctx.getContextAttributes().willReadFrequently, true, n);
  L.resize(60, 50, 1);
  T.eq(L.get('ink').ctx.getContextAttributes().willReadFrequently, true, 'after resize');
});
T.test('layers: composite reuses the granulated wash and mask tint until those layers change', () => {
  const L = SUMI.createLayers(120, 80, 1), out = T.canvas(120, 80);
  L.get('wash').ctx.fillStyle = '#5a6d7e'; L.get('wash').ctx.fillRect(0, 0, 60, 80);
  L.get('mask').ctx.fillRect(60, 0, 60, 80);
  L.markDirty();
  L.composite(out.ctx, { showMask: true });
  const g0 = L.stats.granulations, t0 = L.stats.tints, first = T.hash(out.canvas);
  L.get('ink').ctx.fillRect(5, 5, 4, 4); L.markDirty('ink');
  L.composite(out.ctx, { showMask: true });
  T.eq(L.stats.granulations, g0, 'ink change re-granulated the wash'); T.eq(L.stats.tints, t0, 'ink change rebuilt the tint');
  T.assert(T.hash(out.canvas) !== first, 'ink change not shown');
  L.get('wash').ctx.fillRect(60, 0, 20, 80); L.markDirty('wash');
  L.composite(out.ctx, { showMask: true });
  T.eq(L.stats.granulations, g0 + 1, 'wash change not re-granulated');
  L.get('mask').ctx.clearRect(60, 0, 30, 80); L.markDirty('mask');
  L.composite(out.ctx, { showMask: true });
  T.eq(L.stats.tints, t0 + 1, 'mask change not re-tinted');
  for (const change of [() => L.clear(['wash']), () => L.restore(L.snapshot(['wash'])), () => L.resize(130, 90, 1), () => L.markDirty()]) {
    const before = L.stats.granulations; change(); L.composite(out.ctx);
    T.eq(L.stats.granulations, before + 1, 'not re-granulated after ' + change.toString());
  }
});
T.test('layers: cached composite matches a fresh one', () => {
  const draw = L => { L.get('wash').ctx.fillStyle = '#5a6d7e'; L.get('wash').ctx.fillRect(10, 10, 80, 50); L.get('ink').ctx.fillRect(20, 20, 30, 30); };
  const A = SUMI.createLayers(120, 80, 1), B = SUMI.createLayers(120, 80, 1), a = T.canvas(120, 80), b = T.canvas(120, 80);
  draw(A); A.markDirty(); A.composite(a.ctx); A.markDirty('ink'); A.composite(a.ctx); // second pass uses the cache
  draw(B); B.markDirty(); B.composite(b.ctx);
  T.eq(T.hash(a.canvas), T.hash(b.canvas));
});
T.test('layers: snapshots are CPU canvases', () => {
  const L = SUMI.createLayers(40, 30, 1), snap = L.snapshot(['ink', 'wash']);
  for (const n in snap) T.eq(snap[n].getContext('2d').getContextAttributes().willReadFrequently, true, n);
});
