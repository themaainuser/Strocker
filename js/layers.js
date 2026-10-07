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
  const FULL = 'full';
  const unite = (a, r) => (a === FULL ? FULL : !a ? { ...r } : {
    x0: Math.min(a.x0, r.x0), y0: Math.min(a.y0, r.y0), x1: Math.max(a.x1, r.x1), y1: Math.max(a.y1, r.y1),
  });
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
    const L = { w, h, dpr, dirty: true, stats: { granulations: 0, tints: 0, fullFrames: 0, areaFrames: 0 } };
    const layers = {};
    const version = {}; // per-layer change counters (L.version), e.g. to cache "is the mask empty"
    // What changed since the last composite. A full redraw re-blends every layer and uploads
    // whole CPU layers to the board (~10 ms per layer at 1x, ~4x that at 2x); an area redraw
    // copies just the changed box of each layer into a small scratch canvas and blends that,
    // so only the box is uploaded. The granulated wash and the mask tint are rebuilt the same
    // way: whole, only in the changed box, or not at all.
    let frameFull = true, frameArea = null, washStale = FULL, tintStale = FULL;
    let washCache, tintCache, pattern, scratch = null;
    let lastCtx = null, lastShowMask = null;

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
      washStale = tintStale = FULL;
    }
    for (const n of ALL) setup(n);
    setupCaches();
    const changed = names => {
      for (const n of names) version[n]++;
      if (names.includes('wash')) washStale = FULL;
      if (names.includes('mask')) tintStale = FULL;
      frameFull = true;
      L.dirty = true;
    };

    L.get = name => layers[name];
    L.version = name => version[name];
    // markDirty('ink') after drawing on one layer; markDirty() when unsure (all layers changed)
    L.markDirty = (...names) => changed(names.length ? names : ALL);
    // markArea(box, 'ink') after drawing inside box (CSS px) on a layer: only that box is redrawn.
    // With no layer names it just redraws the box (e.g. to move an overlay drawn by preview).
    L.markArea = (rect, ...names) => {
      if (!rect) return;
      if (![rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite)) { changed(names.length ? names : ALL); return; }
      for (const n of names) version[n]++;
      if (names.includes('wash')) washStale = unite(washStale, rect);
      if (names.includes('mask')) tintStale = unite(tintStale, rect);
      frameArea = unite(frameArea, rect);
      L.dirty = true;
    };

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

    // CSS box -> device pixel box on the layers, padded a pixel for antialiasing, clipped
    function deviceBox(r) {
      const W = layers.ink.canvas.width, H = layers.ink.canvas.height;
      const x0 = Math.max(0, Math.floor(r.x0 * L.dpr) - 1), y0 = Math.max(0, Math.floor(r.y0 * L.dpr) - 1);
      const x1 = Math.min(W, Math.ceil(r.x1 * L.dpr) + 1), y1 = Math.min(H, Math.ceil(r.y1 * L.dpr) + 1);
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }
    // Copy box r of a CPU canvas into ctx at (dx, dy) without using it as a drawImage source:
    // drawImage makes the browser snapshot the source, and the next brush stroke on that layer
    // then copies the whole layer first (~3 ms at 2x). get/putImageData round-trips exactly.
    const copyBox = (src, ctx, r, dx, dy) => ctx.putImageData(src.getContext('2d').getImageData(r.x, r.y, r.w, r.h), dx, dy);

    // the region of a cache to rebuild: all of it, a box, or nothing
    const regionOf = stale => (stale === FULL ? { x: 0, y: 0, w: washCache.width, h: washCache.height } : stale ? deviceBox(stale) : null);

    // wash with granules lifted out of the pigment
    function granulatedWash() {
      const r = regionOf(washStale);
      washStale = null;
      if (!r) return washCache;
      const c = washCache.getContext('2d');
      copyBox(layers.wash.canvas, c, r, r.x, r.y);
      c.globalCompositeOperation = 'destination-out';
      c.globalAlpha = GRANULATION;
      c.fillStyle = pattern; // anchored to the canvas origin, so a box matches the full pass
      c.fillRect(r.x, r.y, r.w, r.h);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      L.stats.granulations++;
      return washCache;
    }
    function maskTint() {
      const r = regionOf(tintStale);
      tintStale = null;
      if (!r) return tintCache;
      const c = tintCache.getContext('2d');
      c.save();
      // source-in clears everything outside what it draws, so keep it inside the box
      c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
      copyBox(layers.mask.canvas, c, r, r.x, r.y);
      c.globalCompositeOperation = 'source-in';
      c.fillStyle = MASK_TINT;
      c.fillRect(r.x, r.y, r.w, r.h);
      c.restore();
      L.stats.tints++;
      return tintCache;
    }

    // the whole picture: paper, wash glazed over it, then the scene, ink and shards
    function drawFull(ctx, showMask, preview) {
      const W = ctx.canvas.width, H = ctx.canvas.height;
      const wash = granulatedWash(), tint = showMask ? maskTint() : null;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = S.PAPER;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(wash, 0, 0, W, H);
      ctx.drawImage(layers.scene.canvas, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layers.ink.canvas, 0, 0, W, H);
      ctx.drawImage(layers.fx.canvas, 0, 0, W, H);
      if (tint) ctx.drawImage(tint, 0, 0, W, H);
      ctx.restore();
      drawPreview(ctx, preview, null);
    }

    // the same blends as drawFull, restricted to box r: each layer's box is copied into a small
    // CPU scratch canvas first, so the board only uploads box-sized images
    function drawArea(ctx, r, showMask, preview) {
      const wash = granulatedWash(), tint = showMask ? maskTint() : null;
      if (!scratch || scratch.width !== r.w || scratch.height !== r.h) scratch = makeCanvas(r.w, r.h);
      const sc = scratch.getContext('2d', CPU);
      const put = (src, op) => {
        copyBox(src, sc, r, 0, 0);
        ctx.globalCompositeOperation = op;
        ctx.drawImage(scratch, r.x, r.y);
      };
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = S.PAPER;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      put(wash, 'multiply');
      put(layers.scene.canvas, 'multiply');
      put(layers.ink.canvas, 'source-over');
      put(layers.fx.canvas, 'source-over');
      if (tint) put(tint, 'source-over');
      ctx.restore();
      drawPreview(ctx, preview, r);
    }

    function drawPreview(ctx, preview, clip) {
      if (!preview) return;
      const W = ctx.canvas.width, H = ctx.canvas.height;
      ctx.save();
      if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
      ctx.setTransform(W / L.w, 0, 0, H / L.h, 0, 0);
      preview(ctx);
      ctx.restore();
    }

    // Draws what changed since the last call: the marked boxes only, unless a full redraw is
    // needed (markDirty, a different or resized board, the mask tint switched, or full: true).
    // An overlay drawn by preview must lie inside the marked boxes on area frames.
    L.composite = (ctx, { showMask = false, preview = null, full = false } = {}) => {
      // a full picture onto some other canvas is a copy: it leaves the board's pending updates alone
      if (full && lastCtx && ctx !== lastCtx) { drawFull(ctx, showMask, preview); return; }
      const W = ctx.canvas.width, H = ctx.canvas.height;
      const sameBoard = ctx === lastCtx && W === layers.ink.canvas.width && H === layers.ink.canvas.height;
      if (full || frameFull || !sameBoard || showMask !== lastShowMask) {
        drawFull(ctx, showMask, preview);
        L.stats.fullFrames++;
      } else if (frameArea) {
        const r = deviceBox(frameArea);
        if (r) { drawArea(ctx, r, showMask, preview); L.stats.areaFrames++; }
      }
      lastCtx = ctx; lastShowMask = showMask;
      frameFull = false; frameArea = null;
      L.dirty = false;
    };

    // a full picture on a new canvas; pending board updates are left for the next composite
    L.exportCanvas = (grainCanvas, stampText) => {
      const out = makeCanvas(L.w * L.dpr, L.h * L.dpr), o = out.getContext('2d');
      drawFull(o, false, null);
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
