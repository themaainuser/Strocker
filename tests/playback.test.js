// Animated playback: a recording replays over time, at any speed, with identical pixels.
(() => {
  const { makeCalls } = FIX;
  const W = 320, H = 220;

  // three overlapping strokes recorded live with a fake clock; a pause before the second
  function recording() {
    let now = 0;
    const clock = () => (now += 16), live = T.canvas(W, H), strokes = [];
    for (const [tool, pause] of [['wash', 0], ['dry', 500], ['spray', 40]]) {
      now += pause;
      const c = makeCalls(tool);
      const pen = SUMI.recordStroke(live.ctx, { tool, seed: c.seed + strokes.length, opts: c.opts, wind: c.wind, p0: c.p0, clock, origin: 0 });
      pen.dab();
      for (const [ax, ay, bx, by, w, dir, speed, alpha] of c.segs) pen.segment({ x: ax, y: ay }, { x: bx, y: by }, w, dir, { speed, alpha });
      strokes.push(pen.end());
    }
    return { live: live.canvas, strokes: JSON.parse(JSON.stringify(strokes)) };
  }
  // drive SUMI.replay with a fake clock and frame queue
  function drive(target, strokes, opts, frameMs) {
    let now = 1000; const queue = [];
    const run = SUMI.replay(target, strokes, { ...opts, clock: () => now, frame: cb => queue.push(cb) });
    let frames = 0;
    while (queue.length && frames < 100000) { now += frameMs; queue.shift()(); frames++; }
    return { run, frames, queue };
  }

  T.test('playback: seek(Infinity) reproduces the live recording', () => {
    const { live, strokes } = recording(), c = T.canvas(W, H);
    T.eq(SUMI.playback(c.ctx, strokes).seek(Infinity), true, 'reports finished');
    T.eq(T.hash(c.canvas), T.hash(live));
  });

  T.test('replay: any speed and frame split give the same pixels', async () => {
    const { live, strokes } = recording();
    for (const [speed, frameMs] of [[0.37, 7], [5, 33], [1, 16.7]]) {
      const c = T.canvas(W, H), { run, frames } = drive(c.ctx, strokes, { speed }, frameMs);
      T.eq(await run.done, true, 'completed');
      T.assert(frames > 2, `animated over frames (${frames})`);
      T.eq(T.hash(c.canvas), T.hash(live), `speed ${speed}`);
    }
  });

  T.test('playback: seek applies exactly the calls due by t', () => {
    const { strokes } = recording(), tl = SUMI.playback(T.canvas(W, H).ctx, strokes);
    const base = Math.min(...strokes.map(s => s.t0)), t = tl.duration / 2;
    let due = 0;
    for (const s of strokes) { // v2: every time is on the same session clock as t0
      const times = [s.t0, s.dab.t, ...s.segs.map(g => g[8]), s.end.t];
      due += times.filter(x => x - base <= t).length;
    }
    tl.seek(t);
    T.eq(tl.position, due);
    T.assert(tl.position > 0 && tl.position < tl.total, 'partway');
  });

  T.test('playback: timing modes place the stroke starts', () => {
    const { strokes } = recording(), ctx = T.canvas(W, H).ctx, d = strokes.map(s => s.end.t - s.t0);
    const rec = SUMI.playback(ctx, strokes);
    T.eq(JSON.stringify(rec.starts), JSON.stringify(strokes.map(s => s.t0 - strokes[0].t0)), 'as drawn');
    T.eq(rec.duration, rec.starts[2] + d[2]);
    const seq = SUMI.playback(ctx, strokes, { timing: 'sequence', gap: 100 });
    T.eq(JSON.stringify(seq.starts), JSON.stringify([0, d[0] + 100, d[0] + 100 + d[1] + 100]), 'back to back');
    const ovl = SUMI.playback(ctx, strokes, { timing: 'overlap', stagger: 50 });
    T.eq(JSON.stringify(ovl.starts), JSON.stringify([0, 50, 100]), 'overlapping');
    let err = null; try { SUMI.playback(ctx, strokes, { timing: 'shuffle' }); } catch (e) { err = e; }
    T.assert(err instanceof TypeError, 'unknown timing');
  });

  T.test('playback: back-to-back keeps the pixels; overlapping reorders crossing strokes', () => {
    const { live, strokes } = recording();
    const seq = T.canvas(W, H); SUMI.playback(seq.ctx, strokes, { timing: 'sequence', gap: 0 }).seek(Infinity);
    T.eq(T.hash(seq.canvas), T.hash(live), 'sequence');
    const ovl = T.canvas(W, H); SUMI.playback(ovl.ctx, strokes, { timing: 'overlap' }).seek(Infinity);
    T.assert(T.hash(ovl.canvas) !== T.hash(live), 'interleaved calls composite in a different order');
  });

  T.test('playback: seek is forward-only', () => {
    const { strokes } = recording(), tl = SUMI.playback(T.canvas(W, H).ctx, strokes);
    tl.seek(tl.duration / 2); const pos = tl.position;
    tl.seek(10); T.eq(tl.position, pos);
  });

  T.test('playback: a target function routes each stroke to its own canvas', () => {
    const { strokes } = recording(), a = T.canvas(W, H), b = T.canvas(W, H);
    SUMI.playback(s => (s.tool === 'dry' ? a.ctx : b.ctx), strokes).seek(Infinity);
    const solo = T.canvas(W, H); SUMI.replayStroke(solo.ctx, strokes[1]);
    T.eq(T.hash(a.canvas), T.hash(solo.canvas));
  });

  T.test('replay: rejects non-positive speeds; Infinity draws at once', async () => {
    const { live, strokes } = recording(), ctx = T.canvas(W, H).ctx;
    for (const bad of [0, -1, NaN, '2']) {
      let err = null; try { SUMI.replay(ctx, strokes, { speed: bad }); } catch (e) { err = e; }
      T.assert(err instanceof TypeError, 'speed ' + bad);
    }
    const c = T.canvas(W, H), run = SUMI.replay(c.ctx, strokes, { speed: Infinity });
    T.eq(T.hash(c.canvas), T.hash(live), 'drawn synchronously');
    T.eq(await run.done, true);
  });

  T.test('replay: cancel stops where it is, finish completes the drawing', async () => {
    const { live, strokes } = recording();
    let now = 0; const queue = [];
    const c1 = T.canvas(W, H), r1 = SUMI.replay(c1.ctx, strokes, { clock: () => now, frame: cb => queue.push(cb) });
    for (let i = 0; i < 5; i++) { now += 16; queue.shift()(); }
    r1.cancel(); const pos = r1.timeline.position;
    while (queue.length) { now += 16; queue.shift()(); }
    T.eq(r1.timeline.position, pos, 'no calls after cancel');
    T.eq(await r1.done, false, 'cancel resolves false');
    const c2 = T.canvas(W, H), r2 = SUMI.replay(c2.ctx, strokes, { clock: () => now, frame: cb => queue.push(cb) });
    now += 16; queue.shift()();
    r2.finish();
    T.eq(T.hash(c2.canvas), T.hash(live), 'finish draws everything left');
    T.eq(await r2.done, true, 'finish resolves true');
  });

  // drawing in slices: a big recording must never be drawn in one blocking go when a budget is set
  T.test('playback: seek(t, deadline) stops once the deadline has passed, and the next call carries on', () => {
    const { live, strokes } = recording(), c = T.canvas(W, H), tl = SUMI.playback(c.ctx, strokes);
    T.eq(tl.seek(Infinity, 0), false, 'a deadline already passed stops after one call');
    T.eq(tl.position, 1);
    T.eq(tl.seek(Infinity, 0), false);
    T.eq(tl.position, 2, 'seeking to the same time carries on');
    T.eq(tl.seek(Infinity), true, 'no deadline draws the rest');
    T.eq(T.hash(c.canvas), T.hash(live));
  });

  // A CPU canvas rasterises what was drawn only when something reads it, so a slice timed by
  // its script alone overruns. Simulated: each clock reading moves 0.25 ms, and a read costs
  // the 20 ms of drawing the canvas had deferred.
  function withCosts(ctx, fn) {
    let clock = 0, reads = 0;
    const read = ctx.getImageData.bind(ctx);
    performance.now = () => (clock += 0.25);
    ctx.getImageData = (...a) => { reads++; clock += 20; return read(...a); };
    try { return fn(() => reads); } finally { delete performance.now; delete ctx.getImageData; }
  }
  T.test('playback: a slice counts the drawing a CPU canvas defers until it is read', () => {
    const { strokes } = recording(), c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    withCosts(ctx, reads => {
      const tl = SUMI.playback(ctx, strokes);
      tl.seek(Infinity, performance.now() + 12);
      T.assert(reads() > 0, 'the canvas was read during the slice');
      T.assert(tl.position < 12, 'stops once the deferred drawing has used the budget, after ' + tl.position + ' calls');
    });
  });
  T.test('playback: a slice never reads a GPU canvas', () => {
    const { live, strokes } = recording(), c = T.canvas(W, H); // no willReadFrequently: may be on the GPU
    withCosts(c.ctx, reads => {
      const tl = SUMI.playback(c.ctx, strokes);
      while (!tl.seek(Infinity, performance.now() + 1e9)); // long slices that would read a CPU canvas often
      T.eq(reads(), 0);
    });
    T.eq(T.hash(c.canvas), T.hash(live));
  });

  T.test('replay: with a budget, speed Infinity draws over frames, never at once', async () => {
    const { live, strokes } = recording(), c = T.canvas(W, H), blank = T.hash(c.canvas);
    const queue = []; let reports = 0;
    const run = SUMI.replay(c.ctx, strokes, { speed: Infinity, budget: 0, frame: cb => queue.push(cb), onFrame: () => reports++ });
    T.eq(T.hash(c.canvas), blank, 'nothing drawn before the first frame');
    let frames = 0;
    while (queue.length && frames < 1e5) { queue.shift()(); frames++; }
    T.eq(frames, run.timeline.total, 'budget 0 draws one call per frame');
    T.eq(reports, frames, 'onFrame after every frame, so a host can redraw what changed');
    T.eq(T.hash(c.canvas), T.hash(live));
    T.eq(await run.done, true);
  });

  T.test('replay: with a budget, a frame that falls behind catches up over the next frames', async () => {
    const { live, strokes } = recording(), c = T.canvas(W, H);
    let now = 0; const queue = [];
    const run = SUMI.replay(c.ctx, strokes, { speed: 8, budget: 0, clock: () => now, frame: cb => queue.push(cb) });
    now = 1e7; // long past the end: without a budget the next frame would draw everything
    queue.shift()();
    T.eq(run.timeline.position, 1, 'one call in that frame');
    let frames = 1;
    while (queue.length && frames < 1e5) { queue.shift()(); frames++; }
    T.eq(frames, run.timeline.total, 'the rest follows one call per frame');
    T.eq(T.hash(c.canvas), T.hash(live));
    T.eq(await run.done, true);
  });

  T.test('replay: finish({ budget }) draws the rest over frames', async () => {
    const { live, strokes } = recording(), c = T.canvas(W, H);
    let now = 0; const queue = [];
    const run = SUMI.replay(c.ctx, strokes, { clock: () => now, frame: cb => queue.push(cb) });
    now += 16; queue.shift()();
    const pos = run.timeline.position;
    run.finish({ budget: 0 });
    T.eq(run.timeline.position, pos, 'the call itself draws nothing');
    let frames = 0;
    while (queue.length && frames < 1e5) { queue.shift()(); frames++; } // the clock stands still: only finish moves it on
    T.eq(frames, run.timeline.total - pos, 'one call per frame to the end');
    T.eq(T.hash(c.canvas), T.hash(live));
    T.eq(await run.done, true);
  });

  T.test('replay: rejects a budget that is not a number ≥ 0', () => {
    const { strokes } = recording(), ctx = T.canvas(W, H).ctx;
    for (const bad of [-1, NaN, '5', null]) {
      let err = null; try { SUMI.replay(ctx, strokes, { budget: bad, frame: () => {} }); } catch (e) { err = e; }
      T.assert(err instanceof TypeError, 'budget ' + bad);
    }
    const run = SUMI.replay(ctx, strokes, { frame: () => {} });
    let err = null; try { run.finish({ budget: -1 }); } catch (e) { err = e; }
    T.assert(err instanceof TypeError, 'finish budget -1');
    T.eq(run.timeline.position, 0, 'a rejected finish draws nothing');
  });

  T.test('playback: unfinished strokes and out-of-order times are safe; missing numbers are rejected', () => {
    const { strokes } = recording(), s = JSON.parse(JSON.stringify(strokes[1]));
    s.end = null; s.segs[3][8] = -50; s.dab = null;
    const tl = SUMI.playback(T.canvas(W, H).ctx, [s]);
    T.eq(tl.seek(Infinity), true); T.eq(tl.position, tl.total);
    s.segs[4][8] = null; // what undefined becomes after JSON
    let err = null; try { SUMI.playback(T.canvas(W, H).ctx, [s]); } catch (e) { err = e; }
    T.assert(err instanceof TypeError, 'malformed segment accepted');
  });

  // record live with a scripted clock: [tool, colour, clock reading per call]
  T.test('playback: exact ties between strokes keep the recorded call order', () => {
    let now = 0; const clock = () => now, origin = 1207, live = T.canvas(W, H);
    const opts = c => ({ ...FIX.base(), color: c, size: 40, splatter: 60 });
    now = 20264.9;
    const z = SUMI.recordStroke(live.ctx, { tool: 'fine', seed: 1, opts: opts('#000'), p0: { x: 20, y: 20 }, clock, origin });
    z.segment({ x: 20, y: 20 }, { x: 60, y: 30 }, 2, 0.2); const sz = z.end();
    now = 110485.9;
    const a = SUMI.recordStroke(live.ctx, { tool: 'lines', seed: 2, opts: opts('#ff0000'), p0: { x: 40, y: 180 }, clock, origin });
    a.segment({ x: 40, y: 180 }, { x: 280, y: 40 }, 30, -0.53);
    now = 111747.3; const sa = a.end();
    const b = SUMI.recordStroke(live.ctx, { tool: 'spray', seed: 3, opts: opts('#0000ff'), p0: { x: 160, y: 110 }, clock, origin });
    b.dab(); const sb = b.end();
    const c = T.canvas(W, H);
    SUMI.playback(c.ctx, JSON.parse(JSON.stringify([sz, sa, sb]))).seek(Infinity);
    T.eq(T.hash(c.canvas), T.hash(live.canvas));
  });

  T.test('playback: two pens recording at once replay in call order', () => {
    const clock = () => 5000, live = T.canvas(W, H); // a coarse clock: every call ties
    const pen = (seed, color, y) => SUMI.recordStroke(live.ctx, { tool: 'dry', seed, opts: { ...FIX.base(), color, size: 40 }, p0: { x: 20, y }, clock });
    const red = pen(1, '#cc0000', 80), blue = pen(2, '#0000cc', 140);
    for (let i = 0; i < 40; i++) {
      const x = 20 + i * 7;
      blue.segment({ x, y: 140 - i * 1.5 }, { x: x + 7, y: 140 - (i + 1) * 1.5 }, 40, -0.2);
      red.segment({ x, y: 80 + i * 1.5 }, { x: x + 7, y: 80 + (i + 1) * 1.5 }, 40, 0.2);
    }
    const strokes = JSON.parse(JSON.stringify([red.end(), blue.end()]));
    const c = T.canvas(W, H); SUMI.playback(c.ctx, strokes).seek(Infinity);
    T.eq(T.hash(c.canvas), T.hash(live.canvas));
  });

  T.test('playback: v1 strokes (relative times) still replay', () => {
    const live = T.canvas(W, H), rec = makeCalls('dry');
    const pen = SUMI.recordStroke(live.ctx, { tool: 'dry', seed: rec.seed, opts: rec.opts, wind: rec.wind, p0: rec.p0 });
    for (const [ax, ay, bx, by, w, dir, speed, alpha] of rec.segs) pen.segment({ x: ax, y: ay }, { x: bx, y: by }, w, dir, { speed, alpha });
    const s = JSON.parse(JSON.stringify(pen.end()));
    const v1 = { ...s, v: 1, segs: s.segs.map(g => { const r = g.slice(0, 9); r[8] -= s.t0; return r; }), end: { alpha: 1, t: s.end.t - s.t0 } };
    delete v1.engine; delete v1.n0;
    const c = T.canvas(W, H); SUMI.replayStroke(c.ctx, v1);
    T.eq(T.hash(c.canvas), T.hash(live.canvas));
  });

  T.test('replay: an error mid-replay rejects done instead of hanging', async () => {
    SUMI.brushes.boom = { layer: 'ink', start() {}, dab() {}, end() {}, segment() { throw new Error('boom'); } };
    try {
      const s = SUMI.recordStroke(T.canvas(50, 50).ctx, { tool: 'fine', seed: 1, p0: { x: 1, y: 1 } });
      s.segment({ x: 1, y: 1 }, { x: 9, y: 9 }, 2, 0.7);
      const bad = { ...JSON.parse(JSON.stringify(s.end())), tool: 'boom' };
      let now = 0; const queue = [];
      const r = SUMI.replay(T.canvas(50, 50).ctx, [bad], { clock: () => now, frame: cb => queue.push(cb) });
      while (queue.length) { now += 1e6; queue.shift()(); }
      const result = await Promise.race([r.done.then(() => 'resolved', e => 'rejected: ' + e.message), new Promise(res => setTimeout(() => res('pending'), 200))]);
      T.eq(result, 'rejected: boom');
      const r2 = SUMI.replay(T.canvas(50, 50).ctx, [bad], { frame: () => {} });
      r2.finish();
      T.eq(await r2.done.then(() => 'resolved', e => 'rejected: ' + e.message), 'rejected: boom', 'finish');
    } finally { delete SUMI.brushes.boom; }
  });
})();
