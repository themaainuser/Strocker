// Layer stack: offscreen canvases (device px, ctx pre-scaled by dpr) composited
// into the visible board. Paper is a flat fill; grain stays a DOM overlay.
window.SUMI = window.SUMI || {};
(function (S) {
  S.PAPER = '#f4f1ea';
  S.LAYER_NAMES = ['wash', 'scene', 'ink', 'fx'];
  const ALL = [...S.LAYER_NAMES, 'mask'];
  const MASK_TINT = 'rgba(220,40,40,0.35)';
  const GRANULATION = 0.35; // how much pigment the granulation tile lifts out of washes

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
    const f = (x, y) => noise.fbm2(x / 6, y / 6, 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      // blend four offset samples so the tile wraps without seams
      const v = (f(x, y) * (N - x) * (N - y) + f(x - N, y) * x * (N - y) +
                 f(x - N, y - N) * x * y + f(x, y - N) * (N - x) * y) / (N * N);
      const t = Math.min(1, Math.max(0, (v - 0.48) / 0.12));
      const speck = rng.next();
      const a = Math.min(1, 0.7 * t * t * (3 - 2 * t) + (speck > 0.85 ? 0.5 * speck : 0));
      img.data[(y * N + x) * 4 + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    return tile;
  }

  S.createLayers = function (w, h, dpr = 1) {
    const L = { w, h, dpr, dirty: true };
    const layers = {};
    let scratch, pattern;

    function setup(name, old) {
      const canvas = makeCanvas(L.w * L.dpr, L.h * L.dpr);
      const ctx = canvas.getContext('2d');
      if (old) ctx.drawImage(old, 0, 0, canvas.width, canvas.height);
      ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      layers[name] = { canvas, ctx };
    }
    function setupScratch() {
      scratch = makeCanvas(L.w * L.dpr, L.h * L.dpr);
      pattern = scratch.getContext('2d').createPattern(granulationTile(), 'repeat');
      if (pattern.setTransform) pattern.setTransform(new DOMMatrix().scale(L.dpr));
    }
    for (const n of ALL) setup(n, null);
    setupScratch();

    L.get = name => layers[name];
    L.markDirty = () => { L.dirty = true; };

    L.clear = names => {
      for (const n of names) {
        const { canvas, ctx } = layers[n];
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      L.dirty = true;
    };

    L.resize = (w2, h2, dpr2 = L.dpr) => {
      if (!(w2 >= 1 && h2 >= 1)) return; // hidden/collapsed board: keep what we have
      L.w = w2; L.h = h2; L.dpr = dpr2;
      for (const n of ALL) setup(n, layers[n].canvas);
      setupScratch();
      L.dirty = true;
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
        copy.getContext('2d').drawImage(src, 0, 0);
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
      L.dirty = true;
    };

    L.composite = (ctx, { showMask = false, preview = null } = {}) => {
      const W = ctx.canvas.width, H = ctx.canvas.height;
      const sc = scratch.getContext('2d');
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = S.PAPER;
      ctx.fillRect(0, 0, W, H);

      // wash: lift granules out of the pigment, then glaze it over the paper
      sc.globalCompositeOperation = 'source-over';
      sc.clearRect(0, 0, scratch.width, scratch.height);
      sc.drawImage(layers.wash.canvas, 0, 0);
      sc.globalCompositeOperation = 'destination-out';
      sc.globalAlpha = GRANULATION;
      sc.fillStyle = pattern;
      sc.fillRect(0, 0, scratch.width, scratch.height);
      sc.globalAlpha = 1;
      sc.globalCompositeOperation = 'source-over';

      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(scratch, 0, 0, W, H);
      ctx.drawImage(layers.scene.canvas, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layers.ink.canvas, 0, 0, W, H);
      ctx.drawImage(layers.fx.canvas, 0, 0, W, H);

      if (showMask) {
        sc.clearRect(0, 0, scratch.width, scratch.height);
        sc.drawImage(layers.mask.canvas, 0, 0);
        sc.globalCompositeOperation = 'source-in';
        sc.fillStyle = MASK_TINT;
        sc.fillRect(0, 0, scratch.width, scratch.height);
        sc.globalCompositeOperation = 'source-over';
        ctx.drawImage(scratch, 0, 0, W, H);
      }
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
