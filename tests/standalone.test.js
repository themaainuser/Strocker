// Runs with ONLY js/rng.js + brushes.js + recorder.js + playback.js — the portable library.
T.test('standalone: no poster modules present', () => {
  T.eq(typeof SUMI.createLayers, 'undefined'); T.eq(typeof SUMI.scene, 'undefined'); T.eq(typeof SUMI.PAPER, 'undefined');
});
T.test('standalone: every tool paints', () => {
  for (const tool of FIX.TOOLS) {
    const c = T.canvas(320, 220);
    FIX.play(c.ctx, FIX.makeCalls(tool));
    T.assert(T.inkCount(T.pixels(c.canvas), 0, 0, 320, 220) > 0, tool + ' painted nothing');
  }
});
T.test('standalone: replay on a used canvas matches a fresh one', () => {
  for (const tool of FIX.TOOLS) {
    const a = T.canvas(320, 220), b = T.canvas(320, 220);
    FIX.play(a.ctx, FIX.makeCalls(tool));
    FIX.dirty(b.ctx);
    FIX.play(b.ctx, FIX.makeCalls(tool));
    T.eq(T.hash(b.canvas), T.hash(a.canvas), tool);
  }
});
T.test('standalone: a recorded stroke replays identically', () => {
  for (const tool of FIX.TOOLS) {
    const rec = FIX.makeCalls(tool), a = T.canvas(320, 220);
    const pen = SUMI.recordStroke(a.ctx, { tool, seed: rec.seed, opts: rec.opts, wind: rec.wind, p0: rec.p0 });
    pen.dab();
    for (const [ax, ay, bx, by, w, dir, speed, alpha] of rec.segs) pen.segment({ x: ax, y: ay }, { x: bx, y: by }, w, dir, { speed, alpha });
    const b = T.canvas(320, 220);
    SUMI.replayStroke(b.ctx, JSON.parse(JSON.stringify(pen.end())));
    T.eq(T.hash(b.canvas), T.hash(a.canvas), tool);
  }
});
T.test('standalone: animated replay of a recording ends identical to the live drawing', async () => {
  const live = T.canvas(320, 220), strokes = [];
  for (const tool of ['wash', 'dry', 'spray']) {
    const rec = FIX.makeCalls(tool), pen = SUMI.recordStroke(live.ctx, { tool, seed: rec.seed, opts: rec.opts, wind: rec.wind, p0: rec.p0 });
    for (const [ax, ay, bx, by, w, dir, speed, alpha] of rec.segs) pen.segment({ x: ax, y: ay }, { x: bx, y: by }, w, dir, { speed, alpha });
    strokes.push(pen.end());
  }
  let now = 0; const queue = [], c = T.canvas(320, 220);
  const run = SUMI.replay(c.ctx, JSON.parse(JSON.stringify(strokes)), { speed: 3, clock: () => now, frame: cb => queue.push(cb) });
  while (queue.length) { now += 16; queue.shift()(); }
  T.eq(await run.done, true);
  T.eq(T.hash(c.canvas), T.hash(live.canvas));
});
