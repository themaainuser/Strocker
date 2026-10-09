// The brush library's contract: replayable, host-safe, forgiving inputs, frozen output.
(() => {
  const { TOOLS, base, makeCalls, play, dirty, state } = FIX;
  const W = 320, H = 220;
  const painted = c => T.inkCount(T.pixels(c), 0, 0, c.width, c.height);

  T.test('replay: recorded calls survive JSON and repaint identically on a used canvas', () => {
    for (const tool of TOOLS) {
      const rec = makeCalls(tool);
      const a = T.canvas(W, H); play(a.ctx, rec);
      const b = T.canvas(W, H);
      dirty(b.ctx); play(b.ctx, makeCalls('dry')); // an earlier stroke on the same ctx…
      b.ctx.clearRect(0, 0, W, H);                // …then undo/clear restores pixels, not ctx state
      dirty(b.ctx);
      play(b.ctx, JSON.parse(JSON.stringify(rec)));
      T.eq(T.hash(b.canvas), T.hash(a.canvas), tool);
    }
  });

  T.test('brushes: leave the host ctx state as they found it', () => {
    for (const tool of TOOLS) {
      const c = T.canvas(W, H); dirty(c.ctx);
      const before = state(c.ctx);
      play(c.ctx, makeCalls(tool));
      T.eq(state(c.ctx), before, tool);
    }
  });

  T.test('fine: interleaved strokes keep their own colour', () => {
    const run = (ctx, interleave) => {
      const f = SUMI.brushes.fine;
      const R = SUMI.makeStroke(ctx, 'R', { ...base(), color: '#ff0000' });
      const B = SUMI.makeStroke(ctx, 'B', { ...base(), color: '#0000ff' });
      f.start(R, { x: 20, y: 30 });
      for (let x = 20; x < 200; x += 10) f.segment(R, { x, y: 30 }, { x: x + 10, y: 30 }, 2, 0);
      if (interleave) {
        f.start(B, { x: 20, y: 90 });
        for (let x = 20; x < 200; x += 10) { B.speed = 1; f.segment(B, { x, y: 90 }, { x: x + 10, y: 90 }, 2, 0); }
      }
      f.end(R);
      if (interleave) f.end(B);
    };
    const solo = T.canvas(300, 120), mixed = T.canvas(300, 120);
    run(solo.ctx, false); run(mixed.ctx, true);
    const top = c => Array.from(c.getContext('2d').getImageData(0, 0, 300, 60).data).join();
    T.assert(top(mixed.canvas) === top(solo.canvas), 'red stroke changed by the blue one');
  });

  T.test('makeStroke: fills missing opts from defaults and copies them', () => {
    const o = { size: 30 }, st = SUMI.makeStroke(T.canvas(5, 5).ctx, 1, o), d = SUMI.defaultOpts();
    for (const k in d) if (k !== 'size') T.eq(st.opts[k], d[k], k);
    T.eq(st.opts.size, 30);
    o.size = 99; T.eq(st.opts.size, 30, 'opts must be copied, not referenced');
  });

  T.test('makeStroke: clamps numbers and falls back on junk', () => {
    const d = SUMI.defaultOpts();
    const st = SUMI.makeStroke(T.canvas(5, 5).ctx, 1, { opacity: 5, size: -10, dryness: NaN, splatter: 250, bleed: -3, taper: 'x' });
    T.eq(st.opts.opacity, 1); T.eq(st.opts.size, 1); T.eq(st.opts.dryness, d.dryness);
    T.eq(st.opts.splatter, 100); T.eq(st.opts.bleed, 0); T.eq(st.opts.taper, d.taper);
  });

  T.test('brushes: partial opts paint with every tool', () => {
    for (const tool of TOOLS) {
      const rec = makeCalls(tool); rec.opts = { size: 30 };
      const c = T.canvas(W, H); play(c.ctx, rec);
      T.assert(painted(c.canvas) > 0, tool + ' painted nothing');
    }
  });

  T.test('brushes: out-of-range speed and alpha behave like their clamps', () => {
    for (const tool of ['dry', 'fine', 'spray', 'wash']) {
      const set = (speed, alpha) => { const r = makeCalls(tool); r.segs.forEach(s => { s[6] = speed; s[7] = alpha; }); return r; };
      const draw = rec => { const c = T.canvas(W, H); play(c.ctx, rec); return T.hash(c.canvas); };
      T.eq(draw(set(2, 3)), draw(set(1, 1)), tool + ' above range');
      T.eq(draw(set(NaN, NaN)), draw(set(0, 1)), tool + ' NaN');
    }
  });

  T.test('brushes: negative or NaN widths and coordinates are skipped safely', () => {
    for (const tool of TOOLS) {
      const st = SUMI.makeStroke(T.canvas(100, 100).ctx, 's', base()), b = SUMI.brushes[tool];
      b.start(st, { x: 50, y: 50 });
      b.segment(st, { x: 50, y: 50 }, { x: 80, y: 60 }, -5, 0);
      b.segment(st, { x: NaN, y: 1 }, { x: 2, y: 3 }, 10, 0);
      b.segment(st, { x: 1, y: 1 }, { x: 20, y: 20 }, NaN, NaN);
      b.end(st);
    }
  });

  T.test('ink.rgba: hex forms, rgb() and named colours', () => {
    const r = SUMI.ink.rgba;
    T.eq(r('#fff', 1), 'rgba(255,255,255,1)');
    T.eq(r('#112233', 0.5), 'rgba(17,34,51,0.5)');
    T.eq(r('#11223380', 1), `rgba(17,34,51,${0x80 / 255})`);
    T.eq(r('#abcd', 1), `rgba(170,187,204,${0xdd / 255})`);
    T.eq(r(' #FFF ', 1), 'rgba(255,255,255,1)');
    T.eq(r('rgb(10, 20, 30)', 1), 'rgba(10,20,30,1)');
    T.eq(r('red', 1), 'rgba(255,0,0,1)');
  });

  T.test('ink.rgba / makeStroke: invalid colours throw TypeError', () => {
    for (const bad of ['notacolor', '#ggg', '__proto__', 'constructor', '']) {
      let err = null; try { SUMI.ink.rgba(bad, 1); } catch (e) { err = e; }
      T.assert(err instanceof TypeError, 'rgba(' + JSON.stringify(bad) + ')');
    }
    let err = null; try { SUMI.makeStroke(T.canvas(5, 5).ctx, 1, { color: 'nope' }); } catch (e) { err = e; }
    T.assert(err instanceof TypeError, 'makeStroke');
  });

  T.test('dry: a drag leaves no ink behind its touch-down point', () => {
    const c = T.canvas(200, 300), b = SUMI.brushes.dry, p = { x: 100, y: 60 };
    const st = SUMI.makeStroke(c.ctx, 'hook', { ...base(), size: 30, splatter: 0, bleed: 0 });
    b.start(st, p); b.dab(st, p);
    for (let y = 60; y < 260; y += 2) b.segment(st, { x: 100, y }, { x: 100, y: y + 2 }, 30, Math.PI / 2);
    b.end(st);
    T.eq(T.inkCount(T.pixels(c.canvas), 0, 0, 200, 54), 0, 'ink above the start');
  });

  T.test('wash: small blobs stay cheap', () => {
    const c = T.canvas(100, 100); let n = 0;
    const lineTo = c.ctx.lineTo.bind(c.ctx); c.ctx.lineTo = (x, y) => { n++; lineTo(x, y); };
    SUMI.ink.washBlob(c.ctx, SUMI.makeRng(1), 50, 50, 2, 6, base());
    T.assert(n <= 6 * 64, 'vertices ' + n);
  });

  T.test('spray: batches its droplets', () => {
    const c = T.canvas(300, 200); let n = 0;
    const fill = c.ctx.fill.bind(c.ctx); c.ctx.fill = (...a) => { n++; fill(...a); };
    SUMI.ink.spray(c.ctx, SUMI.makeRng('s'), 100, 100, 0, 30, 0.6, { ...base(), bleed: 0 });
    T.assert(n <= 24, 'fill calls ' + n);
  });

  // freeze tests: if these change, every saved stroke replays differently
  T.test('rng: golden vectors', () => {
    T.eq(SUMI.hashSeed('eclipse'), 612237515);
    const r = SUMI.makeRng('eclipse');
    T.eq(r.next(), 0.9853461415041238); T.eq(r.next(), 0.36088427319191396); T.eq(r.gauss(), -1.8649380786969285);
    const n = SUMI.makeNoise(3);
    T.eq(n.n1(1.5), 0.5142825469374657); T.eq(n.n2(1.25, 2.5), 0.5910588083788753); T.eq(n.fbm2(0.3, 0.7), 0.586394239986699);
  });

  // keyed by SUMI.BRUSH_ENGINE: a change that alters these hashes must bump the engine version
  // (and add its hashes here), so recordings say which brushes painted them
  const ENGINE_1 = { dry: 'cffaf707', spray: '96fc84e8', fine: '74f81a52', lines: '5c866284', wash: '637dd7f8', shard: '81f0cd31', mask: '3b72f452' };
  const GOLDEN = {
    1: ENGINE_1,
    2: ENGINE_1, // engine 2 only added the spray/wash quality options: default strokes paint as in 1
    3: ENGINE_1, // engine 3 only added opts.paper, whose default is the paper engines 1 and 2 used
    4: ENGINE_1, // engine 4 only added opts.washSmall, off by default
  };
  T.test('brushes: golden pixel hashes for this BRUSH_ENGINE (headless raster only)', () => {
    if (!/Headless/.test(navigator.userAgent)) T.skip('pinned to headless software raster; GPU canvases differ');
    const want = GOLDEN[SUMI.BRUSH_ENGINE];
    T.assert(want, 'no golden hashes for BRUSH_ENGINE ' + SUMI.BRUSH_ENGINE);
    const got = {};
    for (const tool of TOOLS) { const c = T.canvas(W, H); play(c.ctx, makeCalls(tool)); got[tool] = T.hash(c.canvas); }
    T.eq(JSON.stringify(got), JSON.stringify(want));
  });

  T.test('brushes: BRUSH_NAMES lists the built-in brushes', () => {
    T.eq(JSON.stringify(SUMI.BRUSH_NAMES.slice().sort()), JSON.stringify(TOOLS.slice().sort()));
  });

  T.test('ink.parseColor rejects malformed numbers', () => {
    for (const bad of ['rgb(1.2.3,0,0)', 'rgba(0,0,0,.)', 'rgb(.,.,.)']) {
      let err = null; try { SUMI.ink.parseColor(bad); } catch (e) { err = e; }
      T.assert(err instanceof TypeError, bad);
    }
  });

  // a click with the dry brush, recorded through the pen
  function dryClick(dabAlpha, endAlpha, wobble = [], dab = true) {
    const c = T.canvas(200, 200), p = { x: 100, y: 100 };
    const pen = SUMI.recordStroke(c.ctx, { tool: 'dry', seed: 'click', opts: { ...base(), size: 40, splatter: 0, bleed: 0 }, p0: p });
    if (dab) pen.dab({ alpha: dabAlpha });
    let prev = p;
    for (const q of wobble) { pen.segment(prev, q, 40, Math.atan2(q.y - prev.y, q.x - prev.x)); prev = q; }
    pen.end({ alpha: endAlpha });
    return c.canvas;
  }
  T.test('dry: a click is drawn with the dab alpha, not the end alpha', () => {
    const full = T.hash(dryClick(1, 1));
    T.assert(T.hash(dryClick(0.2, 1)) !== full, 'dab alpha ignored');
    T.eq(T.hash(dryClick(1, 0.2)), full, 'end alpha leaked into the dab');
  });

  T.test('dry: a jittery click still leaves its dab', () => {
    const wobble = [{ x: 100.4, y: 100.3 }, { x: 100.1, y: 100.7 }, { x: 100.6, y: 100.2 }];
    // if sub-pixel jitter cancelled the dab, this would equal the same wobble with no dab at all
    T.assert(T.hash(dryClick(1, 1, wobble)) !== T.hash(dryClick(1, 1, wobble, false)), 'jitter cancelled the dab');
  });

  T.test('wash: edge detail stays the same along a stroke whose width changes', () => {
    const c = T.canvas(400, 200), counts = [];
    const moveTo = c.ctx.moveTo.bind(c.ctx), lineTo = c.ctx.lineTo.bind(c.ctx);
    c.ctx.moveTo = (x, y) => { counts.push(0); moveTo(x, y); };
    c.ctx.lineTo = (x, y) => { counts[counts.length - 1]++; lineTo(x, y); };
    const st = SUMI.makeStroke(c.ctx, 'w', { ...base(), size: 40 }), b = SUMI.brushes.wash;
    b.start(st, { x: 20, y: 100 });
    for (let i = 0; i < 60; i++) b.segment(st, { x: 20 + i * 6, y: 100 }, { x: 26 + i * 6, y: 100 }, 80 - i * 1.2, 0); // 80 → 8 px wide
    b.end(st);
    T.assert(counts.length > 10, 'stamps drawn');
    T.eq(new Set(counts).size, 1, 'vertex counts per polygon: ' + [...new Set(counts)].join(','));
  });

  T.test('brushes: the ink.* helpers leave the host ctx as they found it', () => {
    const c = T.canvas(200, 200); FIX.dirty(c.ctx);
    const before = FIX.state(c.ctx), o = base(), r = SUMI.makeRng(1);
    SUMI.ink.spray(c.ctx, r, 100, 100, 0, 30, 0.6, o);
    SUMI.ink.washBlob(c.ctx, r, 100, 100, 30, 6, o);
    SUMI.ink.shard(c.ctx, r, 100, 100, 40, 0, o);
    SUMI.ink.maskDab(c.ctx, 100, 100, 20, true);
    SUMI.ink.drawSpeedLine(c.ctx, r, 10, 10, 190, 150, o);
    T.eq(FIX.state(c.ctx), before);
  });
})();
