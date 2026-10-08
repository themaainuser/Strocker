// Quality options for spray and wash: cheaper to draw, recorded per stroke like any other opt.
// Missing options mean full quality, so every earlier recording still paints as before.
(() => {
  const { base, makeCalls, play } = FIX;
  const W = 320, H = 220;
  const KEYS = ['sprayDensity', 'sprayGap', 'washLayers', 'washDetail', 'washEdge'];
  const paint = (tool, opts) => {
    const rec = makeCalls(tool); rec.opts = opts;
    const c = T.canvas(W, H); play(c.ctx, rec); return T.hash(c.canvas);
  };
  // a ctx that counts the calls made on it, plus Path2D shapes (spray batches droplets in paths)
  function counting(ctx) {
    const n = {};
    const bump = k => { n[k] = (n[k] || 0) + 1; };
    const proxy = new Proxy(ctx, {
      get(t, k) { const v = t[k]; return typeof v === 'function' ? (...a) => { bump(k); return v.apply(t, a); } : v; },
      set(t, k, v) { t[k] = v; return true; },
    });
    return { ctx: proxy, n, bump };
  }
  function work(tool, opts) {
    const c = T.canvas(W, H), k = counting(c.ctx);
    const P = Path2D.prototype, saved = { ellipse: P.ellipse, arc: P.arc };
    P.ellipse = function (...a) { k.bump('shape'); return saved.ellipse.apply(this, a); };
    P.arc = function (...a) { k.bump('shape'); return saved.arc.apply(this, a); };
    try {
      const b = SUMI.brushes[tool], st = SUMI.makeStroke(k.ctx, 'work', { ...base(), ...opts }, 0);
      b.start(st, { x: 20, y: 110 });
      for (let i = 0; i < 40; i++) b.segment(st, { x: 20 + i * 3, y: 110 }, { x: 23 + i * 3, y: 110 }, 34, 0);
      b.end(st);
    } finally { Object.assign(P, saved); }
    return k.n;
  }

  T.test('quality: defaults are full quality, so earlier strokes paint exactly as before', () => {
    const d = SUMI.normalizeOpts({});
    for (const key of KEYS) T.eq(d[key], SUMI.QUALITY.full[key], key);
    for (const tool of FIX.TOOLS) {
      const old = base(); for (const key of KEYS) delete old[key]; // a recording made before these options
      T.eq(paint(tool, { ...base(), ...SUMI.QUALITY.full }), paint(tool, old), tool);
    }
  });

  T.test('quality: options are clamped, rounded and kept stable', () => {
    const o = SUMI.normalizeOpts({ sprayDensity: 5, sprayGap: -3, washLayers: 3.6, washDetail: 9, washEdge: 'x' });
    T.eq(JSON.stringify(KEYS.map(k => o[k])), JSON.stringify([1, 0, 4, 5, 1]));
    const low = SUMI.normalizeOpts({ sprayDensity: 0, sprayGap: 1e9, washLayers: 0, washDetail: 0, washEdge: -1 });
    T.eq(JSON.stringify(KEYS.map(k => low[k])), JSON.stringify([0.1, 50, 1, 2, 0]));
    T.eq(JSON.stringify(SUMI.normalizeOpts(o)), JSON.stringify(o), 'normalising twice changes nothing');
  });

  T.test('quality: each option changes its own brush and nothing else', () => {
    const cheaper = { sprayDensity: 0.5, sprayGap: 6, washLayers: 3, washDetail: 2, washEdge: 0.5 };
    for (const [key, value] of Object.entries(cheaper)) {
      const owner = key.startsWith('spray') ? 'spray' : 'wash';
      for (const tool of FIX.TOOLS) {
        const same = paint(tool, { ...base(), [key]: value }) === paint(tool, base());
        T.eq(same, tool !== owner, `${key}=${value} on ${tool}`);
      }
    }
  });

  T.test('quality: cheaper settings do less drawing work', () => {
    const full = work('spray', {}), less = work('spray', { sprayDensity: 0.5 }), gap = work('spray', { sprayGap: 6 });
    T.assert(less.shape <= full.shape * 0.55, `density 0.5: ${less.shape} of ${full.shape} droplets`);
    T.assert(gap.fill <= full.fill * 0.55, `gap 6 px over 3 px steps: ${gap.fill} of ${full.fill} fills`);
    const w = work('wash', {}), layers = work('wash', { washLayers: 3 }), detail = work('wash', { washDetail: 2 });
    T.eq(layers.fill * 2, w.fill, 'half the layers, half the fills');
    T.assert(detail.lineTo <= w.lineTo * 0.55, `detail 2: ${detail.lineTo} of ${w.lineTo} outline points`);
    T.eq(work('wash', { washEdge: 0 }).stroke || 0, 0, 'no edge lines');
    T.eq(work('wash', { washEdge: 0.5 }).stroke * 2, w.stroke, 'half the edge lines');
  });

  T.test('quality: presets run from full to fast, and fast strokes replay identically', () => {
    const { full, balanced, fast } = SUMI.QUALITY;
    for (const [lo, hi] of [[balanced, full], [fast, balanced]]) {
      T.assert(lo.sprayDensity <= hi.sprayDensity && lo.sprayGap >= hi.sprayGap && lo.washLayers <= hi.washLayers &&
        lo.washDetail <= hi.washDetail && lo.washEdge <= hi.washEdge, 'each preset is no heavier than the one above');
    }
    T.assert(Object.isFrozen(full) && Object.isFrozen(SUMI.QUALITY), 'presets are read-only');
    for (const tool of ['spray', 'wash']) {
      const live = T.canvas(W, H), pen = SUMI.recordStroke(live.ctx, { tool, seed: 'q', opts: { ...base(), ...fast }, p0: { x: 30, y: 110 } });
      pen.dab();
      for (let i = 0; i < 50; i++) pen.segment({ x: 30 + i * 5, y: 110 }, { x: 35 + i * 5, y: 110 + Math.sin(i) * 3 }, 30, 0, { speed: i / 50, alpha: 0.9 });
      const s = JSON.parse(JSON.stringify(pen.end()));
      T.eq(s.opts.sprayDensity, fast.sprayDensity, 'recorded');
      const again = T.canvas(W, H); SUMI.replayStroke(again.ctx, s);
      T.eq(T.hash(again.canvas), T.hash(live.canvas), tool);
    }
  });

  // pins what the fast preset paints, like the golden hashes for the defaults
  const GOLDEN_FAST = {
    2: { spray: '94a0179d', wash: '06d73067' },
  };
  T.test('quality: golden pixel hashes for the fast preset (headless raster only)', () => {
    if (!/Headless/.test(navigator.userAgent)) T.skip('pinned to headless software raster; GPU canvases differ');
    const want = GOLDEN_FAST[SUMI.BRUSH_ENGINE];
    T.assert(want, 'no fast-preset hashes for BRUSH_ENGINE ' + SUMI.BRUSH_ENGINE);
    const got = {};
    for (const tool of ['spray', 'wash']) got[tool] = paint(tool, { ...base(), ...SUMI.QUALITY.fast });
    T.eq(JSON.stringify(got), JSON.stringify(want));
  });
})();
