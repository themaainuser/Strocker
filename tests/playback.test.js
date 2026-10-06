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
    for (const s of strokes) {
      const at = s.t0 - base, times = [0, s.dab.t, ...s.segs.map(g => g[8]), s.end.t];
      due += times.filter(x => at + x <= t).length;
    }
    tl.seek(t);
    T.eq(tl.position, due);
    T.assert(tl.position > 0 && tl.position < tl.total, 'partway');
  });

  T.test('playback: timing modes place the stroke starts', () => {
    const { strokes } = recording(), ctx = T.canvas(W, H).ctx, d = strokes.map(s => s.end.t);
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

  T.test('playback: unfinished strokes and odd times are safe', () => {
    const { strokes } = recording(), s = JSON.parse(JSON.stringify(strokes[1]));
    s.end = null; s.segs[3][8] = -50; s.segs[4][8] = undefined; delete s.dab;
    const tl = SUMI.playback(T.canvas(W, H).ctx, [s]);
    T.eq(tl.seek(Infinity), true); T.eq(tl.position, tl.total);
  });
})();
