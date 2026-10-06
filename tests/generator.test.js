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
