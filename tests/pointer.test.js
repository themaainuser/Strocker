// Stroke format v3: the pen records the pointer input ([x, y, t] per move, rounded before use)
// and the library's pen dynamics turn it into brush calls, live and on replay alike.
(() => {
  const W = 400, H = 300;
  const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // pointer positions along loops, with float32 coordinates like real pointer events
  function scribble(n, seed = 1) {
    const rng = SUMI.makeRng('scribble' + seed), pts = [];
    let x = 140, y = 150, a = 0;
    for (let i = 0; i < n; i++) {
      a += 0.09 + 0.05 * Math.sin(i / 37);
      const step = rng.range(1, 14);
      x = clampTo(x + Math.cos(a) * step, 20, W - 20); y = clampTo(y + Math.sin(a) * step * 0.7, 20, H - 20);
      pts.push({ x: Math.fround(x), y: Math.fround(y) });
    }
    return pts;
  }
  const ticking = (from = 1000.123456, dt = 16.6667) => { let t = from; return () => (t += dt); };
  function drawLive(ctx, tool, pts, { clock = ticking(), opts = {}, seed = 's' } = {}) {
    const pen = SUMI.recordStroke(ctx, { tool, seed, opts: { ...FIX.base(), ...opts }, p0: pts[0], clock });
    pen.dab();
    for (const p of pts.slice(1)) pen.move(p);
    return pen.end();
  }
  const replayed = (strokes, w = W, h = H) => { const c = T.canvas(w, h); SUMI.playback(c.ctx, strokes).seek(Infinity); return T.hash(c.canvas); };

  T.test('v3: pointer strokes record [x, y, t] per move and replay pixel-identically', () => {
    for (const tool of FIX.TOOLS) {
      const live = T.canvas(W, H), s = drawLive(live.ctx, tool, scribble(60));
      T.eq(s.v, 3); T.eq(SUMI.STROKE_FORMAT, 3);
      T.assert(Array.isArray(s.moves) && !('segs' in s), tool + ': moves, not segs');
      T.eq(s.moves.length, 59);
      for (const m of s.moves) T.assert((m.length === 3 || m.length === 4) && m.every(Number.isFinite), 'row ' + JSON.stringify(m));
      T.eq(replayed([JSON.parse(JSON.stringify(s))]), T.hash(live.canvas), tool);
    }
  });

  T.test('v3: input is rounded before it is drawn (1/100 px, 0.1 ms)', () => {
    const s = drawLive(T.canvas(W, H).ctx, 'dry', [{ x: 10.123456, y: 20.987654 }, { x: 30.555555, y: 40.444444 }]);
    T.eq(JSON.stringify(s.p0), '{"x":10.12,"y":20.99}');
    T.eq(JSON.stringify(s.moves[0].slice(0, 2)), '[30.56,40.44]');
    for (const t of [s.t0, s.dab.t, s.moves[0][2], s.end.t]) T.eq(Math.round(t * 10) / 10, t, 'time to 0.1 ms: ' + t);
  });

  T.test('v3: a long scribble is a small fraction of the per-segment rows it stands for', () => {
    const s = drawLive(T.canvas(W, H).ctx, 'dry', scribble(1800));
    const json = JSON.stringify(s), calls = SUMI.strokeCalls(s);
    T.assert(calls.length > 1.5 * s.moves.length, `${calls.length} brush calls from ${s.moves.length} moves`);
    T.assert(json.length < 70 * 1024, 'stroke JSON ' + (json.length / 1024).toFixed(1) + ' KB');
    T.assert(JSON.stringify(calls).length > 8 * json.length, 'segment rows would be over 8× larger');
  });

  T.test('v3: speed thins and lightens a stroke by opts.taper', () => {
    const widths = (taper, step, dt) => {
      const pts = Array.from({ length: 30 }, (_, i) => ({ x: 20 + i * step, y: 150 }));
      const s = drawLive(T.canvas(2000, H).ctx, 'dry', pts, { clock: ticking(0, dt), opts: { size: 40, taper } });
      const c = SUMI.strokeCalls(s).slice(-10); // after the speed has built up
      return { w: c.reduce((t, g) => t + g[4], 0) / c.length, alpha: c[c.length - 1][7] };
    };
    const slow = widths(0.65, 2, 16), fast = widths(0.65, 40, 16);
    T.assert(fast.w < slow.w * 0.7 && fast.alpha < slow.alpha, `fast ${fast.w.toFixed(1)}/${fast.alpha} vs slow ${slow.w.toFixed(1)}/${slow.alpha}`);
    const flat = widths(0, 40, 16);
    T.near(flat.w, 40, 0.01, 'no taper: full width at any speed');
  });

  T.test('v3: two pens drawing at once replay in their recorded order', () => {
    const c = T.canvas(W, H), clock = ticking(0, 0.01); // most moves land on the same 0.1 ms
    const A = scribble(80, 2), B = scribble(80, 3);
    const a = SUMI.recordStroke(c.ctx, { tool: 'dry', seed: 'a', opts: FIX.base(), p0: A[0], clock });
    const b = SUMI.recordStroke(c.ctx, { tool: 'shard', seed: 'b', opts: FIX.base(), p0: B[0], clock });
    a.dab(); b.dab();
    for (let i = 1; i < 80; i++) { a.move(A[i]); b.move(B[i]); }
    const sa = a.end(), sb = b.end();
    T.assert(sa.moves.some(m => m.length === 4), 'call numbers stored where the other pen cut in');
    T.eq(replayed(JSON.parse(JSON.stringify([sa, sb]))), T.hash(c.canvas));
  });

  T.test('v3: a pen records moves or segments, not both', () => {
    const pen = SUMI.recordStroke(T.canvas(W, H).ctx, { tool: 'dry', seed: 1, opts: FIX.base(), p0: { x: 10, y: 10 } });
    pen.move({ x: 20, y: 12 });
    let e = null; try { pen.segment({ x: 20, y: 12 }, { x: 30, y: 14 }, 20, 0); } catch (x) { e = x; }
    T.assert(e, 'segment after move throws');
    const seg = SUMI.recordStroke(T.canvas(W, H).ctx, { tool: 'dry', seed: 1, opts: FIX.base(), p0: { x: 10, y: 10 } });
    seg.segment({ x: 10, y: 10 }, { x: 20, y: 12 }, 20, 0);
    e = null; try { seg.move({ x: 30, y: 14 }); } catch (x) { e = x; }
    T.assert(e, 'move after segment throws');
    const s = seg.end();
    T.assert(Array.isArray(s.segs) && !('moves' in s), 'a segment stroke keeps explicit rows');
  });

  T.test('v3: validation rejects bad pointer strokes; v2 strokes still replay', () => {
    const live = T.canvas(W, H), s = drawLive(live.ctx, 'spray', scribble(30));
    const bad = {
      'moves and segs': x => { x.segs = []; }, 'neither': x => { delete x.moves; },
      'short row': x => { x.moves[3] = x.moves[3].slice(0, 2); }, 'string in row': x => { x.moves[3][0] = '5'; },
      'row too long': x => { x.moves[3] = [1, 2, 3, 4, 5]; },
    };
    for (const [name, breakIt] of Object.entries(bad)) {
      const x = JSON.parse(JSON.stringify(s)); breakIt(x);
      let e = null; try { SUMI.validateStroke(x); } catch (err) { e = err; }
      T.assert(e instanceof TypeError, name);
    }
    // a v2 stroke is a v3 segment stroke with v: 2
    const seg = T.canvas(W, H), pen = SUMI.recordStroke(seg.ctx, { tool: 'dry', seed: 9, opts: FIX.base(), p0: { x: 40, y: 40 } });
    pen.dab(); for (let i = 0; i < 40; i++) pen.segment({ x: 40 + i * 5, y: 40 }, { x: 45 + i * 5, y: 42 }, 24, 0.1);
    const v2 = JSON.parse(JSON.stringify(pen.end())); v2.v = 2;
    T.eq(replayed([v2]), T.hash(seg.canvas), 'v2');
  });
})();
