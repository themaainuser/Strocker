// Mask outline: alpha grid → marching-squares loops → sketchy inked edge + inner folds.
window.SUMI = window.SUMI || {};
(function (S) {
  const contour = S.contour = {};

  // mean alpha (0..1) per cell×cell CSS-px block
  contour.grid = (canvas, cell = 4, dpr = 1) => {
    const W = canvas.width, H = canvas.height, cs = cell * dpr;
    const cols = Math.ceil(W / dpr / cell), rows = Math.ceil(H / dpr / cell);
    const sum = new Float32Array(cols * rows), cnt = new Float32Array(cols * rows);
    const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    for (let y = 0; y < H; y++) {
      const row = Math.min(rows - 1, Math.floor(y / cs)) * cols;
      for (let x = 0; x < W; x++) {
        const k = row + Math.min(cols - 1, Math.floor(x / cs));
        sum[k] += d[(y * W + x) * 4 + 3]; cnt[k]++;
      }
    }
    const a = new Float32Array(cols * rows);
    for (let k = 0; k < a.length; k++) a[k] = cnt[k] ? sum[k] / (cnt[k] * 255) : 0;
    return { cols, rows, cell, a };
  };

  contour.bounds = (grid, threshold = 0.5) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let j = 0; j < grid.rows; j++) for (let i = 0; i < grid.cols; i++) {
      if (grid.a[j * grid.cols + i] < threshold) continue;
      if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j;
    }
    if (x1 < 0) return null;
    return { x: x0 * grid.cell, y: y0 * grid.cell, w: (x1 - x0 + 1) * grid.cell, h: (y1 - y0 + 1) * grid.cell };
  };

  // segments per case as pairs of edges: T(op) R(ight) B(ottom) L(eft); saddles 5/10 handled inline
  const CASES = {
    1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']], 6: [['T', 'B']], 7: [['L', 'T']],
    8: [['L', 'T']], 9: [['T', 'B']], 11: [['T', 'R']], 12: [['L', 'R']], 13: [['B', 'R']], 14: [['L', 'B']],
  };

  contour.trace = (grid, threshold = 0.5) => {
    const { cols, rows, cell, a } = grid;
    const v = (i, j) => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : a[j * cols + i]); // zero ring = always closed
    const cx = i => (i + 0.5) * cell;
    const points = new Map(); // edge key → {x, y}
    const links = new Map();  // edge key → [segment ids]
    const segs = [];

    // edge keys are lattice-exact, so neighbouring squares share points without float matching
    function edgePoint(key, x0, y0, v0, x1, y1, v1) {
      if (!points.has(key)) {
        const t = v1 === v0 ? 0.5 : (threshold - v0) / (v1 - v0);
        points.set(key, { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
      }
      return key;
    }
    function addSeg(k0, k1) {
      const id = segs.length; segs.push([k0, k1]);
      for (const k of [k0, k1]) { if (!links.has(k)) links.set(k, []); links.get(k).push(id); }
    }

    for (let j = -1; j < rows; j++) for (let i = -1; i < cols; i++) {
      const tl = v(i, j), tr = v(i + 1, j), br = v(i + 1, j + 1), bl = v(i, j + 1);
      const c = (tl >= threshold) << 3 | (tr >= threshold) << 2 | (br >= threshold) << 1 | (bl >= threshold);
      if (c === 0 || c === 15) continue;
      const E = {
        T: () => edgePoint(`h${i},${j}`, cx(i), cx(j), tl, cx(i + 1), cx(j), tr),
        B: () => edgePoint(`h${i},${j + 1}`, cx(i), cx(j + 1), bl, cx(i + 1), cx(j + 1), br),
        L: () => edgePoint(`v${i},${j}`, cx(i), cx(j), tl, cx(i), cx(j + 1), bl),
        R: () => edgePoint(`v${i + 1},${j}`, cx(i + 1), cx(j), tr, cx(i + 1), cx(j + 1), br),
      };
      let pairs = CASES[c];
      if (c === 5 || c === 10) {
        const centreIn = (tl + tr + br + bl) / 4 >= threshold;
        const isolateTlBr = (c === 5) === centreIn; // inside corners joined through the centre
        pairs = isolateTlBr ? [['L', 'T'], ['B', 'R']] : [['T', 'R'], ['L', 'B']];
      }
      for (const [e0, e1] of pairs) addSeg(E[e0](), E[e1]());
    }

    const used = new Uint8Array(segs.length), loops = [];
    for (let s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = 1;
      const start = segs[s][0], keys = [start];
      let cur = segs[s][1], closed = false;
      for (;;) {
        if (cur === start) { closed = true; break; }
        keys.push(cur);
        const next = (links.get(cur) || []).find(id => !used[id]);
        if (next === undefined) break;
        used[next] = 1;
        cur = segs[next][0] === cur ? segs[next][1] : segs[next][0];
      }
      if (keys.length >= 4) loops.push({ pts: keys.map(k => points.get(k)), closed });
    }
    return loops;
  };

  function chaikin(pts, closed, iterations = 2) {
    let cur = pts;
    for (let it = 0; it < iterations; it++) {
      const out = [], n = cur.length, last = closed ? n : n - 1;
      if (!closed) out.push(cur[0]);
      for (let i = 0; i < last; i++) {
        const p = cur[i], q = cur[(i + 1) % n];
        out.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 },
                 { x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
      }
      if (!closed) out.push(cur[n - 1]);
      cur = out;
    }
    return cur;
  }

  const signedArea = pts => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p.x * q.y - q.x * p.y; }
    return s / 2;
  };

  // one hand-drawn pass: wobble, pressure-varying width, broken runs, overshoots at some breaks
  function inkPath(ctx, rng, noise, pts, closed, opts, alphaK, taperEnds) {
    const n = pts.length, count = closed ? n : n - 1;
    const pW = rng.range(0, 500), pG = rng.range(0, 500), pB = rng.range(0, 500);
    ctx.lineCap = 'round';
    ctx.strokeStyle = S.ink.rgba(opts.color, opts.opacity * alphaK);
    let s = 0, wasOn = false, prev = null;
    for (let i = 0; i < count; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1e-6;
      const nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
      const off = (noise.n1(s * 0.02 + pW) - 0.5) * 3;
      const a = prev || { x: p.x + nx * off, y: p.y + ny * off };
      s += len;
      const off2 = (noise.n1(s * 0.02 + pW) - 0.5) * 3;
      const b = { x: q.x + nx * off2, y: q.y + ny * off2 };
      const on = noise.n1(s * 0.008 + pB) >= 0.3;
      if (on) {
        const t = i / count, taper = taperEnds ? Math.sin(Math.PI * t) : 1;
        ctx.lineWidth = (0.7 + 0.9 * noise.n1(s * 0.013 + pG)) * Math.max(0.25, taper);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else if (wasOn && rng.chance(0.3)) { // sketchy overshoot past the break
        const ext = rng.range(4, 10), ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
        ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + ux * ext, a.y + uy * ext); ctx.stroke();
      }
      wasOn = on; prev = b;
    }
  }

  contour.inkEdge = (ctx, rng, noise, loops, opts) => {
    if (!loops.length) return;
    const smooth = loops.map(l => ({ pts: chaikin(l.pts, l.closed), closed: l.closed }));
    for (const l of smooth) inkPath(ctx, rng, noise, l.pts, l.closed, opts, 0.85, false);

    // inner folds: partial copies of the largest outline pushed inward
    const main = smooth.reduce((m, l) => (l.pts.length > m.pts.length ? l : m));
    const pts = main.pts, n = pts.length;
    if (n < 12) return;
    const dirSign = signedArea(pts) > 0 ? 1 : -1;
    const folds = rng.int(2, 5);
    for (let f = 0; f < folds; f++) {
      const len = Math.floor(n * rng.range(0.15, 0.35)), start = rng.int(0, n - 1);
      const depth = rng.range(10, 40), fold = [];
      for (let k = 0; k < len; k++) {
        const i = (start + k) % n, p = pts[i], q = pts[(i + 1) % n];
        const tl = Math.hypot(q.x - p.x, q.y - p.y) || 1e-6;
        const nx = -(q.y - p.y) / tl * dirSign, ny = (q.x - p.x) / tl * dirSign;
        const d = depth * (1 - 0.4 * k / len);
        fold.push({ x: p.x + nx * d, y: p.y + ny * d });
      }
      inkPath(ctx, rng, noise, fold, false, opts, 0.6, true);
    }
  };
})(window.SUMI);
