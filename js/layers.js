// Layer stack: offscreen canvases (device px, ctx pre-scaled by dpr) composited
// into the visible board. Paper is a flat fill; grain stays a DOM overlay.
window.SUMI = window.SUMI || {};
(function (S) {
  S.PAPER = '#f4f1ea';
  S.LAYER_NAMES = ['wash', 'scene', 'ink', 'fx'];
  const ALL = [...S.LAYER_NAMES, 'mask'];
  const MASK_TINT = 'rgba(220,40,40,0.35)';
  // paint layers rasterise on the CPU: GPU and CPU canvases antialias differently, and the
  // browser may move a GPU canvas to the CPU after readbacks, which would make a replayed
  // stroke differ from the live one. CPU raster is also what the mask/contour readbacks want.
  const CPU = { willReadFrequently: true };
  const GRANULATION = 0.22; // how much pigment the granulation tile lifts out of washes

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  // 256px seamless tile: clustered pigment granules + fine speckle (alpha = lift strength)
  let tile = null;
  function granulationTile() {
    if (tile) return tile;
    const N = 256, noise = S.makeNoise(7), rng = S.makeRng('granulation');
    tile = makeCanvas(N, N);
    const ctx = tile.getContext('2d'), img = ctx.createImageData(N, N);
    const f = (x, y) => noise.fbm2(x / 3, y / 3, 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      // blend four offset samples so the tile wraps without seams
      const v = (f(x, y) * (N - x) * (N - y) + f(x - N, y) * x * (N - y) +
                 f(x - N, y - N) * x * y + f(x, y - N) * (N - x) * y) / (N * N);
      const t = Math.min(1, Math.max(0, (v - 0.45) / 0.3));
      const speck = rng.next();
      const a = Math.min(1, 0.35 * t * t * (3 - 2 * t) + (speck > 0.8 ? 0.4 * speck : 0));
      img.data[(y * N + x) * 4 + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    return tile;
  }

  S.createLayers = function (w, h, dpr = 1) {
    const L = { w, h, dpr, dirty: true, stats: { granulations: 0, tints: 0 } };
    const layers = {};
    // per-layer change counters: the granulated wash and the mask tint are only rebuilt when
    // their layer changed, not on every frame (the granulation pass is the costly one)
    const version = {};
    let washCache, tintCache, pattern, washSeen = -1, tintSeen = -1;

    function setup(name) {
      const canvas = makeCanvas(L.w * L.dpr, L.h * L.dpr);
      const ctx = canvas.getContext('2d', CPU);
      ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      layers[name] = { canvas, ctx };
      version[name] = 0;
    }
    function setupCaches() {
      washCache = makeCanvas(L.w * L.dpr, L.h * L.dpr);
      tintCache = makeCanvas(L.w * L.dpr, L.h * L.dpr);
      pattern = washCache.getContext('2d', CPU).createPattern(granulationTile(), 'repeat');
      tintCache.getContext('2d', CPU);
      if (pattern.setTransform) pattern.setTransform(new DOMMatrix().scale(L.dpr));
      washSeen = tintSeen = -1;
    }
    for (const n of ALL) setup(n);
    setupCaches();
    const changed = names => { for (const n of names) version[n]++; L.dirty = true; };

    L.get = name => layers[name];
    L.version = name => version[name];
    // markDirty('ink') after drawing on one layer; markDirty() when unsure (all layers changed)
    L.markDirty = (...names) => changed(names.length ? names : ALL);

    L.clear = names => {
      for (const n of names) {
        const { canvas, ctx } = layers[n];
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      changed(names);
    };

    // resizes in place: the same canvas and ctx objects stay valid, so a stroke or a run that
    // holds a ctx keeps drawing onto the live layer
    L.resize = (w2, h2, dpr2 = L.dpr) => {
      if (!(w2 >= 1 && h2 >= 1)) return; // hidden/collapsed board: keep what we have
      if (w2 === L.w && h2 === L.h && dpr2 === L.dpr) return;
      L.w = w2; L.h = h2; L.dpr = dpr2;
      for (const n of ALL) {
        const { canvas, ctx } = layers[n];
        const old = makeCanvas(canvas.width, canvas.height);
        old.getContext('2d', CPU).drawImage(canvas, 0, 0);
        canvas.width = Math.max(1, Math.round(w2 * dpr2)); canvas.height = Math.max(1, Math.round(h2 * dpr2));
        ctx.drawImage(old, 0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
      }
      setupCaches();
      changed(ALL);
    };

    L.isMaskEmpty = () => {
      const src = layers.mask.canvas;
      const k = Math.min(1, 256 / Math.max(src.width, src.height));
      const c = makeCanvas(src.width * k, src.height * k), ctx = c.getContext('2d');
      ctx.drawImage(src, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
      return true;
    };

    L.snapshot = names => {
      const snap = {};
      for (const n of names) {
        const src = layers[n].canvas, copy = makeCanvas(src.width, src.height);
        copy.getContext('2d', CPU).drawImage(src, 0, 0); // CPU: a memory copy, not a GPU round trip
        snap[n] = copy;
      }
      return snap;
    };

    L.restore = snap => {
      for (const n in snap) {
        const { canvas, ctx } = layers[n];
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(snap[n], 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      changed(Object.keys(snap));
    };

    // wash with granules lifted out of the pigment; rebuilt only when the wash changed
    function granulatedWash() {
      if (washSeen !== version.wash) {
        const c = washCache.getContext('2d');
        c.globalCompositeOperation = 'source-over';
        c.clearRect(0, 0, washCache.width, washCache.height);
        c.drawImage(layers.wash.canvas, 0, 0);
        c.globalCompositeOperation = 'destination-out';
        c.globalAlpha = GRANULATION;
        c.fillStyle = pattern;
        c.fillRect(0, 0, washCache.width, washCache.height);
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
        washSeen = version.wash;
        L.stats.granulations++;
      }
      return washCache;
    }
    function maskTint() {
      if (tintSeen !== version.mask) {
        const c = tintCache.getContext('2d');
        c.globalCompositeOperation = 'source-over';
        c.clearRect(0, 0, tintCache.width, tintCache.height);
        c.drawImage(layers.mask.canvas, 0, 0);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = MASK_TINT;
        c.fillRect(0, 0, tintCache.width, tintCache.height);
        c.globalCompositeOperation = 'source-over';
        tintSeen = version.mask;
        L.stats.tints++;
      }
      return tintCache;
    }

    L.composite = (ctx, { showMask = false, preview = null } = {}) => {
      const W = ctx.canvas.width, H = ctx.canvas.height;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = S.PAPER;
      ctx.fillRect(0, 0, W, H);

      // wash glazed over the paper, then the scene, ink and shards
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(granulatedWash(), 0, 0, W, H);
      ctx.drawImage(layers.scene.canvas, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layers.ink.canvas, 0, 0, W, H);
      ctx.drawImage(layers.fx.canvas, 0, 0, W, H);
      if (showMask) ctx.drawImage(maskTint(), 0, 0, W, H);
      ctx.restore();

      if (preview) {
        ctx.save();
        ctx.setTransform(W / L.w, 0, 0, H / L.h, 0, 0);
        preview(ctx);
        ctx.restore();
      }
      L.dirty = false;
    };

    L.exportCanvas = (grainCanvas, stampText) => {
      const wasDirty = L.dirty;
      const out = makeCanvas(L.w * L.dpr, L.h * L.dpr), o = out.getContext('2d');
      L.composite(o);
      L.dirty = wasDirty;
      if (grainCanvas && grainCanvas.width) o.drawImage(grainCanvas, 0, 0, out.width, out.height);
      o.save();
      o.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      o.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      if ('letterSpacing' in o) o.letterSpacing = '0.35em';
      o.textBaseline = 'top';
      o.fillStyle = 'rgba(17,17,17,0.55)';
      o.fillText('◯ ' + stampText, 26, 22);
      o.restore();
      return out;
    };

    return L;
  };
})(window.SUMI);
