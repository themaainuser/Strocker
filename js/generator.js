// Poster generator: one seed → mist, double-exposure scene, inked silhouette,
// dry-brush slashes, spray, shards and speed lines. Steps are generator functions
// so an animated run can pause mid-stroke and still use the rng in the same order.
window.SUMI = window.SUMI || {};
(function (S) {
  const GREY = '#5a6d7e', INK = '#111318';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r0 = v => Math.round(v);

  // temporary figure-ish silhouette (never stored in the mask layer)
  S.autoMask = (rng, layers, wind) => {
    const c = document.createElement('canvas');
    c.width = Math.round(layers.w * layers.dpr); c.height = Math.round(layers.h * layers.dpr);
    const ctx = c.getContext('2d'), W = layers.w, H = layers.h, m = Math.min(W, H);
    ctx.setTransform(layers.dpr, 0, 0, layers.dpr, 0, 0);
    // a broad drape leaning across the wind, built from a few large soft ellipses
    const top = { x: W * rng.range(0.38, 0.5), y: H * 0.1 }, bot = { x: W * rng.range(0.4, 0.55), y: H * 0.85 };
    const n = rng.int(3, 4);
    const blob = (x, y, rx, ry, rot) => {
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.75, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, rx = m * rng.range(0.16, 0.24);
      blob(top.x + (bot.x - top.x) * t + rng.gauss() * m * 0.03, top.y + (bot.y - top.y) * t,
        rx, rx * rng.range(1.1, 1.6), wind + Math.PI / 2 + rng.range(-0.35, 0.35));
    }
    return c;
  };

  function sceneInto(layers, rng, noise, maskCanvas, box, feather) {
    layers.clear(['scene']);
    const ctx = layers.get('scene').ctx;
    const geom = S.scene.render(ctx, rng, noise, box);
    S.scene.clipToMask(ctx, maskCanvas, feather);
    layers.markDirty();
    return geom;
  }

  const gridCell = layers => Math.max(3, Math.round(Math.min(layers.w, layers.h) / 150));

  S.fillMask = ({ layers, seed }) => {
    if (layers.isMaskEmpty()) return null;
    const rng = S.makeRng('fill:' + seed), noise = S.makeNoise('fill:' + seed);
    const mask = layers.get('mask').canvas;
    const box = S.contour.bounds(S.contour.grid(mask, gridCell(layers), layers.dpr), 0.05);
    if (!box) return null;
    return sceneInto(layers, rng, noise, mask, box, 16);
  };

  // paper: the colour the shard chips are cut from (the brushes' default if not given)
  S.generate = ({ layers, seed, wind = S.DEFAULT_WIND, inkEdge = true, animate = true, onLog = () => {}, paper }) => {
    const rng = S.makeRng('gen:' + seed), noise = S.makeNoise('gen:' + seed);
    const W = layers.w, H = layers.h, D = Math.hypot(W, H);
    const k = clamp(D / 1600, 0.3, 1.6); // size scale vs a ~1400×900 board
    const u = { x: Math.cos(wind), y: Math.sin(wind) }, n = { x: -u.y, y: u.x };
    const ctxOf = name => layers.get(name).ctx;
    const ctx = {}; // shared between steps: mask, grid, box, band centre, slash paths

    function* clearStep() { layers.clear(['wash', 'scene', 'ink', 'fx']); }

    function* maskStep() {
      const painted = !layers.isMaskEmpty();
      ctx.mask = painted ? layers.get('mask').canvas : S.autoMask(rng, layers, wind);
      ctx.grid = S.contour.grid(ctx.mask, gridCell(layers), layers.dpr);
      ctx.box = S.contour.bounds(ctx.grid, 0.05) || { x: W * 0.3, y: H * 0.15, w: W * 0.35, h: H * 0.7 };
      const b = ctx.box;
      ctx.centre = { x: b.x + b.w * rng.range(0.55, 0.9), y: b.y + b.h * rng.range(0.6, 0.9) };
      onLog(`mask.${painted ? 'painted' : 'auto'}({ box: [${r0(b.x)}, ${r0(b.y)}, ${r0(b.w)}, ${r0(b.h)}] })`);
    }

    function* mistStep() {
      const blobs = rng.int(3, 6), b = ctx.box, c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      for (let i = 0; i < blobs; i++) {
        const a = rng.range(-0.3, 0.3) * D, p = rng.gauss() * D * 0.06;
        S.ink.washBlob(ctxOf('wash'), rng, c.x + u.x * a + n.x * p, c.y + u.y * a + n.y * p,
          D * rng.range(0.06, 0.12), 24, { color: GREY, opacity: 0.22 });
        yield;
      }
      onLog(`wash.mist({ blobs: ${blobs} })`);
    }

    function* sceneStep() {
      const g = sceneInto(layers, rng, noise, ctx.mask, ctx.box, rng.range(18, 40));
      onLog(`scene.bridge({ towers: ${g.bridge.towers.length}, vp: [${r0(g.bridge.vp.x)}, ${r0(g.bridge.vp.y)}] })`);
      onLog(`scene.pylons({ count: ${g.pylons.length} })`);
    }

    function* edgeStep() {
      const loops = S.contour.trace(ctx.grid);
      S.contour.inkEdge(ctxOf('ink'), rng, noise, loops, { ...S.defaultOpts(), color: INK, opacity: 0.85 });
      onLog(`edge.ink({ loops: ${loops.length} })`);
    }

    function* slashStep() {
      const count = rng.int(4, 9), heroes = rng.int(1, 2);
      ctx.slashes = [];
      for (let i = 0; i < count; i++) {
        const hero = i < heroes;
        const wMax = (hero ? rng.range(110, 160) : rng.range(30, 90)) * k;
        const len = D * rng.range(0.3, 0.7), ang = wind + rng.range(-10, 10) * Math.PI / 180;
        const off = rng.gauss() * D * 0.08, along = rng.range(-0.25, 0.05) * D;
        const p0 = { x: ctx.centre.x + n.x * off + u.x * along, y: ctx.centre.y + n.y * off + u.y * along };
        const p2 = { x: p0.x + Math.cos(ang) * len, y: p0.y + Math.sin(ang) * len };
        const bend = len * rng.range(-0.08, 0.08);
        const p1 = { x: (p0.x + p2.x) / 2 - Math.sin(ang) * bend, y: (p0.y + p2.y) / 2 + Math.cos(ang) * bend };
        const dry = rng.range(0.3, 0.8);
        const st = S.makeStroke(ctxOf('ink'), rng.next(),
          { ...S.defaultOpts(), size: wMax, dryness: dry, opacity: 0.9, bleed: 10, splatter: 30, color: INK }, wind);
        const at = t => ({
          x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
          y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
        });
        // short attack so the brush lands tapered, then thins out as it speeds up
        const width = t => wMax * Math.min(1, 0.6 + t / 0.05) * (1 - 0.45 * Math.pow(t, 1.5));
        const steps = Math.max(2, Math.ceil(len / 3));
        S.brushes.dry.start(st, p0);
        let prev = p0;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps, p = at(t);
          st.speed = t;
          S.brushes.dry.segment(st, prev, p, width(t), Math.atan2(p.y - prev.y, p.x - prev.x));
          prev = p;
          if (s % 40 === 0) yield;
        }
        ctx.slashes.push({ at, width });
        onLog(`brush.slash({ w: ${r0(wMax)}, len: ${r0(len)}, dry: ${dry.toFixed(2)}${hero ? ', hero: true' : ''} })`);
        yield;
      }
    }

    function* sprayStep() {
      const ink = ctxOf('ink'), o = { ...S.defaultOpts(), opacity: 0.9, bleed: 15, color: INK };
      let bursts = 0;
      for (const sl of ctx.slashes) {
        const m = rng.int(3, 8);
        for (let i = 0; i < m; i++, bursts++) {
          const t = rng.range(0.1, 1), p = sl.at(t);
          S.ink.spray(ink, rng, p.x, p.y, wind, sl.width(t) * rng.range(0.4, 0.9), rng.range(0.3, 0.9), o);
        }
        yield;
      }
      const clusters = rng.int(2, 4);
      for (let i = 0; i < clusters; i++) {
        const a = rng.range(-0.3, 0.3) * D, p = rng.gauss() * D * 0.05;
        S.ink.spray(ink, rng, ctx.centre.x + u.x * a + n.x * p, ctx.centre.y + u.y * a + n.y * p,
          wind, rng.range(20, 50) * k, rng.range(0.5, 1), o);
      }
      onLog(`spray.burst({ n: ${bursts + clusters} })`);
      const dots = rng.int(300, 800);
      for (let i = 0; i < dots; i++) {
        const a = rng.range(-0.5, 0.5) * D, p = rng.gauss() * D * 0.12;
        ink.fillStyle = S.ink.rgba(INK, rng.range(0.3, 0.85));
        ink.beginPath();
        ink.arc(ctx.centre.x + u.x * a + n.x * p, ctx.centre.y + u.y * a + n.y * p, rng.range(0.3, 1.2), 0, Math.PI * 2);
        ink.fill();
      }
      onLog(`spray.mist({ dots: ${dots} })`);
    }

    function* shardStep() {
      const count = rng.int(8, 20), o = { ...S.defaultOpts(), splatter: 25, color: INK, ...(paper && { paper }) };
      for (let i = 0; i < count; i++) {
        const a = rng.range(-0.4, 0.4) * D, p = rng.gauss() * D * 0.1;
        const near = 1 - 0.5 * Math.min(1, Math.abs(p) / (D * 0.15));
        S.ink.shard(ctxOf('fx'), rng, ctx.centre.x + u.x * a + n.x * p, ctx.centre.y + u.y * a + n.y * p,
          rng.range(24, 80) * k * near, wind + rng.gauss() * 0.2, o);
        if (i % 4 === 3) yield;
      }
      onLog(`shard.scatter({ n: ${count} })`);
    }

    function* linesStep() {
      const count = rng.int(12, 30);
      for (let i = 0; i < count; i++) {
        const ang = rng.chance(0.2) ? wind - 25 * Math.PI / 180 : wind + clamp(rng.gauss() * 0.025, -0.052, 0.052);
        const len = rng.range(0.2, 0.9) * D, c = { x: rng.range(0, W), y: rng.range(0, H) };
        const dx = Math.cos(ang) * len / 2, dy = Math.sin(ang) * len / 2;
        S.ink.drawSpeedLine(ctxOf('ink'), rng, c.x - dx, c.y - dy, c.x + dx, c.y + dy,
          { ...S.defaultOpts(), size: rng.range(15, 45), opacity: rng.range(0.35, 0.75), color: INK });
      }
      onLog(`lines.speed({ n: ${count} })`);
    }

    const steps = [clearStep, maskStep, mistStep, sceneStep];
    if (inkEdge) steps.push(edgeStep);
    steps.push(slashStep, sprayStep, shardStep, linesStep);

    function* program() {
      for (const step of steps) { yield* step(); layers.markDirty(); yield; }
    }
    const it = program();

    if (!animate) {
      while (!it.next().done) { /* run to completion */ }
      layers.markDirty();
      return { cancel() {}, done: Promise.resolve() };
    }

    let cancelled = false, resolve;
    const done = new Promise(r => { resolve = r; });
    function frame() {
      if (cancelled) return;
      const t0 = performance.now();
      let r;
      do { r = it.next(); } while (!r.done && performance.now() - t0 < 12);
      layers.markDirty();
      if (r.done) resolve(); else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { cancel() { cancelled = true; resolve(); }, done };
  };
})(window.SUMI);
