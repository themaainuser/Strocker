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
T.test('layers: paint layers use the CPU rasteriser so recorded strokes replay identically', () => {
  // GPU and CPU canvases antialias differently, and Chrome can silently move a GPU canvas
  // to the CPU after readbacks — so a live stroke and its replay must both start on the CPU
  const L = SUMI.createLayers(50, 40, 1);
  for (const n of [...SUMI.LAYER_NAMES, 'mask']) T.eq(L.get(n).ctx.getContextAttributes().willReadFrequently, true, n);
  L.resize(60, 50, 1);
  T.eq(L.get('ink').ctx.getContextAttributes().willReadFrequently, true, 'after resize');
});
