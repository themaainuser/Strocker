function loadApp() { return new Promise((res, rej) => {
  const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;left:-3000px;top:0;width:1200px;height:800px'; f.src = 'index.html';
  f.onload = () => { try { const w = f.contentWindow; res({ w, app: w.SUMI.app, board: w.document.getElementById('board') }); }
    catch (e) { e.name === 'SecurityError' ? res(null) : rej(e); } };
  document.body.appendChild(f); }); }
async function app() { const a = await loadApp(); if (!a) T.skip('iframe blocked on file:// — use node tests/run.mjs'); return a; }
// pointer events with the fields real input carries (type, id, button, buttons)
function ptr(a, type, p, init = {}) {
  const r = a.board.getBoundingClientRect(), down = type === 'pointerdown' || type === 'pointermove';
  a.board.dispatchEvent(new a.w.PointerEvent(type, {
    clientX: r.left + (p ? p.x : 0), clientY: r.top + (p ? p.y : 0), bubbles: true,
    pointerId: 1, pointerType: 'mouse', button: type === 'pointermove' ? -1 : 0, buttons: down ? 1 : 0, ...init,
  }));
}
function drag(a, pts, extra = {}) {
  ptr(a, 'pointerdown', pts[0], extra);
  for (const p of pts.slice(1)) ptr(a, 'pointermove', p, extra);
  a.w.dispatchEvent(new a.w.PointerEvent('pointerup', { pointerId: extra.pointerId || 1, pointerType: extra.pointerType || 'mouse', bubbles: true }));
}
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
  const a = await app(), L = a.app.layers, names = ['wash', 'scene', 'ink', 'fx'];
  const hashes = () => names.map(n => T.hash(L.get(n).canvas)).join();
  // off-screen file:// iframes get throttled frames and timers, so frames are queued and
  // flushed by hand: a first run that wasn't really cancelled would visibly keep painting
  const frames = [];
  a.w.requestAnimationFrame = cb => frames.push(cb);
  const flush = n => { for (let i = 0; i < n && frames.length; i++) frames.shift()(a.w.performance.now()); };
  // the runner's virtual time barely moves inside a task, so a frame's 12 ms budget would never
  // run out; a clock that jumps 20 ms per reading makes every frame do one step
  let fake = a.w.performance.now();
  a.w.performance.now = () => (fake += 20);
  a.app.generate();
  flush(1); // the first run paints one frame…
  T.assert(frames.length > 0, 'first run finished in one frame: nothing left to check');
  await a.app.generate({ animate: false }).done;
  T.assert(!a.app.busy, 'still busy'); T.assert(inked(a, 'ink') > 0);
  const after = hashes();
  flush(400);
  T.eq(hashes(), after, 'canvas changed after the second generate finished');
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
T.test('app: replay repaints the recording exactly and is undoable', async () => {
  const a = await app(), L = a.app.layers, names = ['wash', 'ink', 'fx', 'mask'];
  const hashes = () => names.map(n => T.hash(L.get(n).canvas)).join();
  a.app.setTool('dry'); drag(a, line(100, 400, 500, 200));
  a.app.setTool('wash'); drag(a, line(150, 200, 400, 420));
  const before = hashes(), depth = a.app.undoDepth();
  T.eq(await a.app.replay({ speed: Infinity }).done, true);
  T.eq(hashes(), before); T.eq(a.app.undoDepth(), depth + 1, 'one undo step'); T.assert(!a.app.busy);
});
T.test('app: stopping an animated replay jumps to the end', async () => {
  const a = await app(); a.app.setTool('dry'); drag(a, line(100, 400, 500, 200));
  const before = T.hash(a.app.layers.get('ink').canvas);
  const run = a.app.replay({ speed: 1 }); T.assert(a.app.busy, 'busy while replaying');
  a.w.document.getElementById('btnReplay').click(); // reads "Stop" while busy
  T.eq(await run.done, true); T.assert(!a.app.busy, 'idle again');
  T.eq(T.hash(a.app.layers.get('ink').canvas), before, 'canvas matches the recording');
});
T.test('app: replay needs a recording; its pickers do not steal hotkeys', async () => {
  const a = await app(), btn = a.w.document.getElementById('btnReplay');
  T.assert(btn.disabled, 'disabled with nothing recorded');
  a.app.setTool('dry'); drag(a, line(100, 400, 300, 300)); T.assert(!btn.disabled, 'enabled after a stroke');
  a.app.undo(); T.assert(btn.disabled, 'disabled again after undo');
  const sel = a.w.document.getElementById('replaySpeed'); sel.focus();
  sel.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: '3', bubbles: true })); T.eq(a.app.S.tool, 'dry');
});
T.test('app: export panel shows the real last stroke and follows the recording', async () => {
  const a = await app(), d = a.w.document, ids = ['btnExportJSON', 'btnExportHTML'];
  for (const id of ids) T.assert(d.getElementById(id).disabled, id + ' disabled with nothing recorded');
  a.app.setTool('dry'); drag(a, line(100, 400, 500, 200));
  for (const id of ids) T.assert(!d.getElementById(id).disabled, id + ' enabled');
  const code = d.getElementById('codeOut').textContent;
  T.assert(code.includes('"tool":"dry"') && code.includes('"v":1'), 'shows the recorded stroke: ' + code.slice(0, 80));
  T.assert(d.getElementById('recCount').textContent.startsWith('1 stroke'), 'count: ' + d.getElementById('recCount').textContent);
  a.app.undo(); T.assert(d.getElementById('btnExportJSON').disabled, 'disabled again after undo');
});
T.test('app: JSON and HTML buttons download the recording', async () => {
  const a = await app(), d = a.w.document, got = [];
  a.w.HTMLAnchorElement.prototype.click = function () { got.push(this.download); };
  a.app.setTool('dry'); drag(a, line(100, 400, 500, 200));
  d.getElementById('btnExportJSON').click(); d.getElementById('btnExportHTML').click();
  T.eq(got.length, 2); T.assert(/\.json$/.test(got[0]) && /\.html$/.test(got[1]), got.join());
  const doc = SUMI.parseRecording(a.app.exportJSON()), L = a.app.layers;
  T.eq(doc.strokes.length, 1);
  T.eq(JSON.stringify(doc.canvas), JSON.stringify({ w: L.w, h: L.h, dpr: L.dpr }));
  T.assert(a.app.exportHTML().includes('SUMI_PLAYER'), 'html player');
});
T.test('app: WebM button records and downloads a video', async () => {
  if (typeof MediaRecorder === 'undefined') T.skip('no MediaRecorder here');
  const a = await app(), btn = a.w.document.getElementById('btnExportWebM'), got = [];
  a.w.HTMLAnchorElement.prototype.click = function () { got.push(this.download); };
  a.app.setTool('dry'); drag(a, line(100, 400, 500, 200));
  const job = a.app.exportWebM({ speed: Infinity, hold: 50 });
  T.assert(btn.disabled, 'busy while recording');
  T.assert(await job.done, 'got a video');
  await new Promise(r => setTimeout(r, 0));
  T.assert(got.some(n => /\.webm$/.test(n)), 'downloaded: ' + got.join());
  T.assert(!btn.disabled, 'ready again');
});
T.test('app: a browser that cannot encode WebM gets a message, not an error', async () => {
  const a = await app();
  a.app.setTool('dry'); drag(a, line(100, 400, 500, 200));
  a.w.SUMI.recordWebM = () => { throw new Error('this browser cannot encode WebM'); };
  const btn = a.w.document.getElementById('btnExportWebM');
  if (btn.disabled) T.skip('video export unavailable in this browser');
  btn.click();
  await new Promise(r => setTimeout(r, 0));
  T.eq(a.w.__errors.length, 0, a.w.__errors.join('; '));
  T.assert(/cannot encode WebM/.test(a.w.document.getElementById('toast').textContent), 'toast explains');
  T.assert(!btn.disabled && btn.textContent.includes('WebM'), 'button ready again');
});
