// Stroke recorder: live strokes become plain JSON data that replays pixel-identically.
(() => {
  const { TOOLS, base, makeCalls, dirty } = FIX;
  const W = 320, H = 220;
  const clockFrom = (start, step) => { let t = start - step; return () => (t += step); };

  // draw a fixture stroke live through the recorder; returns the finished record
  function record(ctx, tool, extra = {}) {
    const calls = makeCalls(tool);
    const pen = SUMI.recordStroke(ctx, {
      tool, seed: calls.seed, opts: calls.opts, wind: calls.wind, erase: calls.erase, p0: calls.p0,
      clock: clockFrom(1000, 16), origin: 900, ...extra,
    });
    pen.dab({ alpha: calls.dabAlpha });
    for (const [ax, ay, bx, by, w, dir, speed, alpha] of calls.segs) {
      pen.segment({ x: ax, y: ay }, { x: bx, y: by }, w, dir, { speed, alpha });
    }
    return pen.end({ alpha: calls.endAlpha });
  }

  T.test('recorder: every tool replays pixel-identically after JSON, on a used canvas', () => {
    for (const tool of TOOLS) {
      const a = T.canvas(W, H), stroke = record(a.ctx, tool);
      const b = T.canvas(W, H); dirty(b.ctx);
      SUMI.replayStroke(b.ctx, JSON.parse(JSON.stringify(stroke)));
      T.eq(T.hash(b.canvas), T.hash(a.canvas), tool);
    }
  });

  T.test('recorder: record follows the documented schema (v2)', () => {
    const c = T.canvas(W, H), s = record(c.ctx, 'dry', { opts: { size: 30, color: ' #abc ' } });
    T.eq(s.v, SUMI.STROKE_FORMAT); T.eq(SUMI.STROKE_FORMAT, 2);
    T.eq(s.engine, SUMI.BRUSH_ENGINE); T.assert(Number.isInteger(SUMI.BRUSH_ENGINE) && SUMI.BRUSH_ENGINE >= 1, 'engine version');
    T.eq(s.tool, 'dry'); T.eq(s.seed, 0.7316247301); T.eq(s.wind, -0.61); T.eq(s.erase, false);
    T.eq(JSON.stringify(s.opts), JSON.stringify(SUMI.normalizeOpts({ size: 30, color: ' #abc ' })));
    T.eq(JSON.stringify(s.p0), JSON.stringify({ x: 40.123456789, y: 160.987654321 }));
    T.eq(JSON.stringify(s.canvas), JSON.stringify({ w: W, h: H, dpr: 1 }));
    // every time is ms since the caller's origin (clock starts at 1000, origin 900, steps of 16)
    T.eq(s.t0, 100, 't0 = first clock reading − origin');
    T.eq(s.dab.alpha, 1); T.eq(s.dab.t, 116);
    T.eq(s.segs.length, 60);
    for (const seg of s.segs) T.assert(seg.length === 10 && seg.every(Number.isFinite), 'segment shape');
    T.eq(s.segs[0][8], 132); T.eq(s.segs[59][8], 132 + 59 * 16, 'segment t from the clock');
    T.eq(s.end.alpha, 1); T.eq(s.end.t, 1092);
    // every call has a session-wide sequence number, in call order
    const ns = [s.n0, s.dab.n, ...s.segs.map(g => g[9]), s.end.n];
    for (let i = 1; i < ns.length; i++) T.eq(ns[i], ns[i - 1] + 1, 'call numbers consecutive at ' + i);
  });

  T.test('recorder: dab after a segment throws and changes nothing', () => {
    const a = T.canvas(W, H), pen = SUMI.recordStroke(a.ctx, { tool: 'spray', seed: 7, opts: base(), p0: { x: 60, y: 100 } });
    pen.segment({ x: 60, y: 100 }, { x: 64, y: 101 }, 30, 0.2);
    const before = T.hash(a.canvas);
    let err = null; try { pen.dab(); } catch (e) { err = e; }
    T.assert(err instanceof Error && /before the first segment/.test(err.message), 'error: ' + (err && err.message));
    T.eq(T.hash(a.canvas), before, 'nothing drawn'); T.eq(pen.stroke.dab, null);
    const s = pen.end(), b = T.canvas(W, H);
    SUMI.replayStroke(b.ctx, JSON.parse(JSON.stringify(s)));
    T.eq(T.hash(b.canvas), T.hash(a.canvas));
  });

  T.test('recorder: canvas option is validated; odd transforms still give a usable size', () => {
    const ctx = T.canvas(200, 100).ctx;
    for (const canvas of [{ w: 10, h: 10 }, { w: -1, h: 10, dpr: 1 }, { w: 10, h: NaN, dpr: 1 }]) {
      let err = null; try { SUMI.recordStroke(ctx, { tool: 'fine', seed: 1, p0: { x: 1, y: 1 }, canvas }); } catch (e) { err = e; }
      T.assert(err instanceof TypeError, JSON.stringify(canvas));
    }
    ctx.setTransform(-1, 0, 0, -1, 200, 100); // flipped
    const c = SUMI.recordStroke(ctx, { tool: 'fine', seed: 1, p0: { x: 1, y: 1 } }).end().canvas;
    T.assert(c.w > 0 && c.h > 0 && c.dpr > 0, JSON.stringify(c));
  });

  T.test('recorder: validateStroke accepts v1 and v2, rejects malformed strokes', () => {
    const good = record(T.canvas(W, H).ctx, 'dry'), copy = () => JSON.parse(JSON.stringify(good));
    SUMI.validateStroke(copy());
    const v1 = copy(); v1.v = 1; delete v1.engine; delete v1.n0;
    v1.segs = v1.segs.map(g => { const r = g.slice(0, 9); r[8] -= v1.t0; return r; });
    v1.dab = { alpha: 1, t: v1.dab.t - v1.t0 }; v1.end = { alpha: 1, t: v1.end.t - v1.t0 };
    SUMI.validateStroke(v1);
    const breakers = {
      'no p0': s => { delete s.p0; }, 'bad colour': s => { s.opts.color = 'notacolour'; }, 'object seed': s => { s.seed = {}; },
      'null opts': s => { s.opts = null; }, 'NaN wind': s => { s.wind = 'x'; }, 'null segment': s => { s.segs[3] = null; },
      'short segment': s => { s.segs[3] = s.segs[3].slice(0, 8); }, 'string in segment': s => { s.segs[3][4] = '30'; },
      'bad dab': s => { s.dab = { alpha: 'x', t: 1, n: 1 }; }, 'bad end': s => { s.end = { t: 1 }; }, 'bad canvas': s => { s.canvas = { w: 0, h: 1, dpr: 1 }; },
      'unknown tool': s => { s.tool = 'nope'; }, 'version 3': s => { s.v = 3; },
    };
    for (const k in breakers) {
      const s = copy(); breakers[k](s);
      let err = null; try { SUMI.validateStroke(s); } catch (e) { err = e; }
      T.assert(err instanceof TypeError, k);
    }
  });

  T.test('recorder: keeps full precision', () => {
    const pen = SUMI.recordStroke(T.canvas(50, 50).ctx, { tool: 'fine', seed: 1, p0: { x: 1 / 3, y: 2 / 3 } });
    pen.segment({ x: 1 / 3, y: 2 / 3 }, { x: Math.PI, y: Math.E }, 1 / 7, 1 / 9, { speed: 1 / 11, alpha: 1 / 13 });
    const s = JSON.parse(JSON.stringify(pen.end()));
    T.eq(s.p0.x, 1 / 3);
    T.eq(JSON.stringify(s.segs[0].slice(0, 8)), JSON.stringify([1 / 3, 2 / 3, Math.PI, Math.E, 1 / 7, 1 / 9, 1 / 11, 1 / 13]));
  });

  T.test('recorder: a click with no drag is recorded and replays', () => {
    for (const tool of ['dry', 'spray', 'fine', 'wash', 'shard', 'mask']) {
      const a = T.canvas(100, 100), pen = SUMI.recordStroke(a.ctx, { tool, seed: 'click', opts: base(), p0: { x: 50, y: 50 } });
      pen.dab(); const s = pen.end();
      T.eq(s.segs.length, 0); T.assert(s.dab, tool + ' dab recorded');
      T.assert(T.inkCount(T.pixels(a.canvas), 0, 0, 100, 100) > 0, tool + ' click painted nothing');
      const b = T.canvas(100, 100); SUMI.replayStroke(b.ctx, JSON.parse(JSON.stringify(s)));
      T.eq(T.hash(b.canvas), T.hash(a.canvas), tool);
    }
  });

  T.test('recorder: junk inputs are stored JSON-safe and replay the same', () => {
    const a = T.canvas(W, H), pen = SUMI.recordStroke(a.ctx, { tool: 'dry', seed: 5, opts: base(), p0: { x: 50, y: 100 } });
    pen.segment({ x: 50, y: 100 }, { x: 90, y: 90 }, NaN, NaN, { speed: NaN, alpha: 7 });
    pen.segment({ x: Infinity, y: 0 }, { x: 1, y: 1 }, 10, 0); // skipped: nothing drawn, nothing stored
    pen.segment({ x: 90, y: 90 }, { x: 160, y: 60 }, -4, 0.2, { speed: -1, alpha: -1 });
    pen.segment({ x: 160, y: 60 }, { x: 220, y: 40 }, 30, -0.3);
    const s = pen.end(), json = JSON.stringify(s);
    T.assert(!JSON.stringify(s.segs).includes('null'), 'segments must be JSON-safe numbers');
    T.eq(s.segs.length, 3);
    const b = T.canvas(W, H); SUMI.replayStroke(b.ctx, JSON.parse(json));
    T.eq(T.hash(b.canvas), T.hash(a.canvas));
  });

  T.test('recorder: canvas size inferred from the ctx transform', () => {
    const c = T.canvas(200, 100); c.ctx.setTransform(2, 0, 0, 2, 0, 0);
    const s = SUMI.recordStroke(c.ctx, { tool: 'fine', seed: 1, p0: { x: 5, y: 5 } }).end();
    T.eq(JSON.stringify(s.canvas), JSON.stringify({ w: 100, h: 50, dpr: 2 }));
  });

  T.test('recorder: bad input throws, ended pens refuse more calls', () => {
    const ctx = T.canvas(20, 20).ctx, throws = (fn, Type) => { let e = null; try { fn(); } catch (x) { e = x; } return e instanceof Type; };
    T.assert(throws(() => SUMI.recordStroke(ctx, { tool: 'nope', seed: 1, p0: { x: 0, y: 0 } }), TypeError), 'unknown tool');
    T.assert(throws(() => SUMI.recordStroke(ctx, { tool: 'dry', seed: {}, p0: { x: 0, y: 0 } }), TypeError), 'object seed');
    T.assert(throws(() => SUMI.recordStroke(ctx, { tool: 'dry', seed: 1, p0: { x: NaN, y: 0 } }), TypeError), 'bad p0');
    const pen = SUMI.recordStroke(ctx, { tool: 'dry', seed: 1, p0: { x: 1, y: 1 } }), s = pen.end();
    T.eq(pen.end(), s, 'end is idempotent');
    T.assert(throws(() => pen.segment({ x: 1, y: 1 }, { x: 5, y: 5 }, 5, 0), Error), 'segment after end');
    T.assert(throws(() => SUMI.replayStroke(ctx, { ...s, v: 99 }), TypeError), 'unknown format version');
    T.assert(throws(() => SUMI.replayStroke(ctx, { ...s, tool: 'nope' }), TypeError), 'unknown tool on replay');
  });
})();
