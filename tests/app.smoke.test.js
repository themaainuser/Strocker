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
T.test('app: a painted stroke replays pixel-identically from its recording', async () => {
  const a = await app(); a.app.setTool('dry'); drag(a, line(100, 400, 500, 200));
  const recs = a.app.strokes(); T.eq(recs.length, 1, 'strokes recorded');
  const src = a.app.layers.get('ink').canvas, d = a.app.layers.dpr;
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0);
  SUMI.replayStroke(ctx, JSON.parse(JSON.stringify(recs[0])));
  T.eq(T.hash(c), T.hash(src));
});
T.test('app: recording follows undo, clear, clear mask and generate', async () => {
  const a = await app(), tools = () => a.app.strokes().map(s => s.tool).join();
  a.app.setTool('dry'); drag(a, line(100, 400, 300, 300)); drag(a, line(100, 300, 300, 200));
  a.app.setTool('mask'); drag(a, line(500, 100, 520, 300, 6));
  T.eq(tools(), 'dry,dry,mask');
  T.assert(a.app.strokes()[1].t0 >= a.app.strokes()[0].t0, 'session clock moves forward');
  a.app.undo(); T.eq(tools(), 'dry,dry', 'undo drops the last stroke');
  a.app.setTool('mask'); drag(a, line(500, 100, 520, 300, 6));
  await a.app.generate({ animate: false }).done;
  T.eq(tools(), 'mask', 'generate wipes the painted layers but keeps the mask');
  a.app.clearMask(); T.eq(tools(), '', 'clear mask drops mask strokes');
  a.app.undo(); T.eq(tools(), 'mask');
  a.w.document.getElementById('btnClear').click(); T.eq(tools(), '', 'clear empties the recording');
  a.app.undo(); T.eq(tools(), 'mask', 'undo brings it back');
});
