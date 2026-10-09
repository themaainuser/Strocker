/*! SUMI brushes — drop-in build (classic script: global SUMI)
 * Ink brushes (dry, spray, fine, lines, wash, shard, mask) + stroke recorder + replay.
 * Brush engine 3 · stroke format 3 · sources 48c03dcf6600
 * Built by tools/build-dist.mjs from js/rng.js, js/brushes.js, js/recorder.js, js/playback.js — edit those, not this file.
 * For pixel-identical replay, record and replay on canvases created with
 * getContext('2d', { willReadFrequently: true }). Docs: README.md "Drop-in file".
 */
(function (window) {
// ---- js/rng.js ----
// Seeded randomness. Every brush, scene and generator draw goes through
// these so the same seed always paints the same picture.
window.SUMI = window.SUMI || {};
(function sumiRng(S) {
  // FNV-1a over the seed's string form, then a murmur3 finalizer for avalanche
  S.hashSeed = function (seed) {
    const str = String(seed);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  };

  S.makeRng = function (seed) {
    let a = S.hashSeed(seed);
    const next = () => { // mulberry32
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      range: (lo, hi) => lo + next() * (hi - lo),
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      chance: p => next() < p,
      gauss: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
      pick: arr => arr[Math.floor(next() * arr.length)],
    };
  };

  // value noise on a 256-cell lattice, smoothstep-interpolated, outputs in [0, 1]
  S.makeNoise = function (seed) {
    const rng = S.makeRng('noise:' + seed);
    const perm = new Uint8Array(512), vals = new Float32Array(256);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) vals[i] = rng.next();

    const smooth = t => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const v1 = i => vals[perm[i & 255]];
    const v2 = (i, j) => vals[perm[(perm[i & 255] + j) & 255]];

    function n1(x) {
      const i = Math.floor(x), u = smooth(x - i);
      return lerp(v1(i), v1(i + 1), u);
    }
    function n2(x, y) {
      const i = Math.floor(x), j = Math.floor(y);
      const u = smooth(x - i), v = smooth(y - j);
      return lerp(lerp(v2(i, j), v2(i + 1, j), u), lerp(v2(i, j + 1), v2(i + 1, j + 1), u), v);
    }
    function fbm2(x, y, octaves = 4) {
      let sum = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < octaves; o++) {
        sum += amp * n2(x * f + o * 17.13, y * f + o * 31.71);
        norm += amp; amp *= 0.5; f *= 2;
      }
      return sum / norm;
    }
    return { n1, n2, fbm2 };
  };
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).rng = sumiRng;
})(window.SUMI);

// ---- js/brushes.js ----
// Brush engine. Every brush draws through a per-stroke state `st` carrying a
// seeded rng + noise, so hand strokes and generated posters share one code path.
//
// Contract (what makes strokes replayable and safe in a host app):
// - Output depends only on: seed, opts, wind, erase, the exact segment arguments,
//   st.speed and st.alpha (both 0..1, set by the caller before each call), and the
//   ctx's transform/clip. Every other ctx property is reset on entry and restored on exit.
// - The ink.* helpers keep the caller's globalAlpha too; brushes set it from st.alpha.
window.SUMI = window.SUMI || {};
(function sumiBrushes(S) {
  S.DEFAULT_WIND = -35 * Math.PI / 180; // lower-left → upper-right, like the reference slashes
  // Version of what these brushes paint. Recordings store it; bump it whenever a change alters
  // the pixels of an existing stroke, or adds options an older engine would ignore (the
  // golden-hash tests are keyed by it). 2 added the spray/wash quality options below; 3 added
  // opts.paper, the colour shard chips are cut from (before, a page-wide SUMI.PAPER).
  S.BRUSH_ENGINE = 3;
  const ORIGINAL_PAPER = '#f4f1ea'; // the paper every stroke recorded before opts.paper was cut from
  const DAB_CANCEL_PX = 2; // dry brush: travel that turns a click into a drag

  // Quality of the two costliest brushes, traded for drawing time. Recorded per stroke like any
  // other option; a stroke without them (any engine-1 recording) paints at full quality.
  //   sprayDensity  0.1..1   share of droplets and mist each spray burst throws
  //   sprayGap      0..50 px travel between spray bursts (0: a burst on every segment)
  //   washLayers    1..6     glaze layers per wash stamp; fewer are each darker, so depth holds
  //   washDetail    2..5     outline detail: at most 10·2^n points per layer (5 = 320)
  //   washEdge      0..1     share of wash layers that get the darker edge line (the main cost)
  S.QUALITY = Object.freeze({
    full: Object.freeze({ sprayDensity: 1, sprayGap: 0, washLayers: 6, washDetail: 5, washEdge: 1 }),
    balanced: Object.freeze({ sprayDensity: 0.8, sprayGap: 4, washLayers: 4, washDetail: 4, washEdge: 0.5 }),
    fast: Object.freeze({ sprayDensity: 0.5, sprayGap: 6, washLayers: 3, washDetail: 3, washEdge: 0 }),
  });

  S.defaultOpts = () => ({
    size: 34, opacity: 0.85, dryness: 0.55, splatter: 40, bleed: 35, taper: 0.65, color: '#111318', paper: ORIGINAL_PAPER,
    ...S.QUALITY.full,
  });

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const TAU = Math.PI * 2;
  const ink = S.ink = {};

  // ---------- colour ----------
  const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const FUNC = /^rgba?\(\s*([\d.]+)\s*,?\s*([\d.]+)\s*,?\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i;
  let probe = null;
  function viaCanvas(str) { // named colours: let the browser's CSS parser answer
    if (!probe) {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1)
        : typeof document !== 'undefined' ? document.createElement('canvas') : null;
      probe = c && c.getContext('2d');
      if (!probe) return null;
    }
    probe.fillStyle = '#010203';
    probe.fillStyle = str;
    return probe.fillStyle === '#010203' ? null : probe.fillStyle;
  }
  function parseColor(input) {
    if (typeof input !== 'string') throw new TypeError('colour must be a string, got ' + typeof input);
    const s = input.trim();
    let m = HEX.exec(s);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split('').map(c => c + c).join('');
      const n = parseInt(h.slice(0, 6), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
    }
    m = FUNC.exec(s);
    if (m && [m[1], m[2], m[3], m[4] === undefined ? '0' : m[4]].every(v => Number.isFinite(+v))) {
      const a = m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4];
      return [clamp(Math.round(+m[1]), 0, 255), clamp(Math.round(+m[2]), 0, 255), clamp(Math.round(+m[3]), 0, 255), clamp(a, 0, 1)];
    }
    const css = s && viaCanvas(s);
    if (css && css !== s) return parseColor(css);
    throw new TypeError('not a colour: ' + JSON.stringify(input));
  }
  const colours = new Map();
  ink.parseColor = input => {
    let c = colours.get(input);
    if (!c) {
      c = parseColor(input);
      if (colours.size > 512) colours.clear();
      colours.set(input, c);
    }
    return c;
  };
  ink.rgba = (color, a) => {
    const [r, g, b, ca] = ink.parseColor(color);
    return `rgba(${r},${g},${b},${a * ca})`;
  };

  // ---------- stroke state ----------
  const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
  // fill gaps from the defaults, clamp ranges, validate the colour; always a fresh object
  S.normalizeOpts = o => {
    o = o || {};
    const d = S.defaultOpts();
    const color = o.color == null ? d.color : o.color, paper = o.paper == null ? d.paper : o.paper;
    ink.parseColor(color); ink.parseColor(paper); // throw TypeError on anything that isn't a colour
    return {
      size: num(o.size, d.size, 1, 1000), opacity: num(o.opacity, d.opacity, 0, 1),
      dryness: num(o.dryness, d.dryness, 0, 1), splatter: num(o.splatter, d.splatter, 0, 100),
      bleed: num(o.bleed, d.bleed, 0, 100), taper: num(o.taper, d.taper, 0, 1),
      color: color.trim(), paper: paper.trim(),
      sprayDensity: num(o.sprayDensity, d.sprayDensity, 0.1, 1), sprayGap: num(o.sprayGap, d.sprayGap, 0, 50),
      washLayers: Math.round(num(o.washLayers, d.washLayers, 1, 6)), washDetail: Math.round(num(o.washDetail, d.washDetail, 2, 5)),
      washEdge: num(o.washEdge, d.washEdge, 0, 1),
    };
  };

  S.makeStroke = (ctx, seed, opts, wind = S.DEFAULT_WIND) => ({
    ctx, rng: S.makeRng(seed), noise: S.makeNoise(seed), opts: S.normalizeOpts(opts),
    wind: Number.isFinite(wind) ? wind : S.DEFAULT_WIND, speed: 0, alpha: 1, erase: false,
  });

  const unit = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : d);
  const speedOf = st => unit(st.speed, 0);
  const alphaOf = st => unit(st.alpha, 1);
  const finitePt = p => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

  // ---------- ctx hygiene ----------
  function baseline(c) {
    c.globalCompositeOperation = 'source-over';
    c.setLineDash([]); c.lineDashOffset = 0;
    c.shadowColor = 'rgba(0,0,0,0)'; c.shadowBlur = 0; c.shadowOffsetX = 0; c.shadowOffsetY = 0;
    if ('filter' in c) c.filter = 'none';
    c.lineCap = 'butt'; c.lineJoin = 'miter'; c.miterLimit = 10; c.lineWidth = 1;
    c.strokeStyle = '#000'; c.fillStyle = '#000';
  }
  // public helpers keep the caller's transform, clip and globalAlpha; everything else starts clean
  const helper = fn => function (ctx, ...args) {
    ctx.save();
    try { baseline(ctx); return fn(ctx, ...args); } finally { ctx.restore(); }
  };

  // ---------- spray: droplets thrown along `dir` ----------
  const BUCKETS = 4; // droplets are batched into a few alpha bands: one fill per band
  // `density` (0..1) thins droplets and mist: the spray brush's quality option, 1 elsewhere
  function sprayRaw(ctx, rng, x, y, dir, radius, amount, opts, density = 1) {
    radius = Math.max(0, radius);
    const bleed01 = opts.bleed / 100, op = opts.opacity, col = opts.color;
    const reach = radius * 2.5;
    const drops = Array.from({ length: BUCKETS }, () => new Path2D());
    const band = (k, lo, hi) => Math.min(BUCKETS - 1, Math.floor((k - lo) / (hi - lo) * BUCKETS));
    const bandAlpha = (i, lo, hi) => lo + (i + 0.5) * (hi - lo) / BUCKETS;
    const tails = [];
    const count = Math.floor((20 + 180 * amount) * density);
    for (let i = 0; i < count; i++) {
      const a = dir + rng.gauss() * 0.5;
      const d = Math.pow(rng.next(), 1.4) * reach;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      const s = Math.pow(rng.next(), 3.5) * radius * 0.09 + 0.3;
      const stretch = 1 + 1.2 * d / (reach || 1) * (s < 2 ? 1 : 0.35); // small far drops streak along their flight
      if (bleed01 > 0.05 && s > 1.6 && i % 2 === 0) {
        const hr = s * (2 + bleed01 * 3.5);
        const g = ctx.createRadialGradient(px, py, 0, px, py, hr);
        g.addColorStop(0, ink.rgba(col, op * 0.16 * bleed01));
        g.addColorStop(1, ink.rgba(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(px, py, hr, 0, TAU); ctx.fill();
      }
      const path = drops[band(rng.range(0.45, 0.95), 0.45, 0.95)];
      const rx = s * stretch;
      path.moveTo(px + Math.cos(a) * rx, py + Math.sin(a) * rx);
      path.ellipse(px, py, rx, s, a, 0, TAU);
      if (s > 0.8 && rng.chance(0.05)) tails.push([px, py, a, s, s * rng.range(3, 8)]); // thin tail toward the source
    }
    drops.forEach((p, i) => { ctx.fillStyle = ink.rgba(col, op * bandAlpha(i, 0.45, 0.95)); ctx.fill(p); });
    ctx.lineCap = 'round';
    ctx.strokeStyle = ink.rgba(col, op * 0.6);
    for (const [px, py, a, s, tl] of tails) {
      ctx.lineWidth = s * 0.5;
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px - Math.cos(a) * tl, py - Math.sin(a) * tl); ctx.stroke();
    }
    // blot core for heavy throws
    if (amount > 0.4 && rng.chance(amount)) {
      const d = rng.range(0.2, 0.8) * radius, a = dir + rng.gauss() * 0.3;
      ctx.fillStyle = ink.rgba(col, op * rng.range(0.6, 0.9));
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d,
        rng.range(0.08, 0.18) * radius, rng.range(0.08, 0.18) * radius * 0.8, a, 0, TAU);
      ctx.fill();
    }
    // micro-mist
    const mist = Array.from({ length: BUCKETS }, () => new Path2D());
    const dots = Math.floor((60 + 260 * amount) * density);
    for (let i = 0; i < dots; i++) {
      const a = dir + rng.gauss() * 0.9, d = Math.pow(rng.next(), 0.8) * reach * 1.2;
      const path = mist[band(rng.range(0.3, 0.8), 0.3, 0.8)];
      const cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d, r = rng.range(0.3, 0.8);
      path.moveTo(cx + r, cy); path.arc(cx, cy, r, 0, TAU);
    }
    mist.forEach((p, i) => { ctx.fillStyle = ink.rgba(col, op * bandAlpha(i, 0.3, 0.8)); ctx.fill(p); });
  }
  ink.spray = helper(sprayRaw);

  // ---------- speed lines ----------
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  ink.snapAngle = (angle, wind, tol) => {
    if (Math.abs(wrap(angle - wind)) <= tol) return wind;
    if (Math.abs(wrap(angle - wind - Math.PI)) <= tol) return wind + Math.PI;
    return angle;
  };
  ink.snapEnd = (p0, p1, wind, tol = 20 * Math.PI / 180) => {
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const a = ink.snapAngle(Math.atan2(p1.y - p0.y, p1.x - p0.x), wind, tol);
    return { x: p0.x + Math.cos(a) * len, y: p0.y + Math.sin(a) * len };
  };
  function speedLineRaw(ctx, rng, x0, y0, x1, y1, opts) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!(len >= 1)) return;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len, nx = -uy, ny = ux;
    const w0 = Math.max(0.4, opts.size * 0.03);
    const noise = S.makeNoise(rng.next()), phase = rng.range(0, 100);
    const SEGS = 24;
    const draw = (off, k) => {
      for (let i = 0; i < SEGS; i++) {
        const t0 = i / SEGS, t1 = (i + 1) / SEGS;
        const h0 = w0 * Math.pow(Math.sin(Math.PI * t0), 0.6) / 2, h1 = w0 * Math.pow(Math.sin(Math.PI * t1), 0.6) / 2;
        const ax = x0 + ux * len * t0 + nx * off, ay = y0 + uy * len * t0 + ny * off;
        const bx = x0 + ux * len * t1 + nx * off, by = y0 + uy * len * t1 + ny * off;
        ctx.fillStyle = ink.rgba(opts.color, opts.opacity * k * (0.35 + 0.65 * noise.n1(phase + t0 * 6)));
        ctx.beginPath();
        ctx.moveTo(ax + nx * h0, ay + ny * h0); ctx.lineTo(bx + nx * h1, by + ny * h1);
        ctx.lineTo(bx - nx * h1, by - ny * h1); ctx.lineTo(ax - nx * h0, ay - ny * h0);
        ctx.closePath(); ctx.fill();
      }
    };
    draw(0, 1);
    if (rng.chance(0.3)) draw(rng.range(2, 5) * (rng.chance(0.5) ? 1 : -1), 0.5);
  }
  ink.drawSpeedLine = helper(speedLineRaw);

  // ---------- watercolor: layered, re-deformed polygons (darker where edges pile up) ----------
  const centroid = pts => {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  };
  const clampPts = (pts, cx, cy, R) => {
    for (const p of pts) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d > R) { p.x = cx + (p.x - cx) * R / d; p.y = cy + (p.y - cy) * R / d; }
    }
    return pts;
  };
  ink.deformPolygon = (pts, depth, spread, rng) => {
    const c = centroid(pts);
    let maxR = 0;
    for (const p of pts) maxR = Math.max(maxR, Math.hypot(p.x - c.x, p.y - c.y));
    let cur = pts.map(p => ({ x: p.x, y: p.y }));
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (let i = 0; i < cur.length; i++) {
        const a = cur[i], b = cur[(i + 1) % cur.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        next.push(a, {
          x: (a.x + b.x) / 2 + rng.gauss() * spread * len,
          y: (a.y + b.y) / 2 + rng.gauss() * spread * len,
        });
      }
      cur = clampPts(next, c.x, c.y, maxR * 1.8);
    }
    return cur;
  };
  const tracePoly = (ctx, pts) => {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  };
  // `detail` is the radius that picks the edge detail (default: r). The wash brush passes one
  // value per stroke, so the outline doesn't jump as a speed-thinned stroke changes width.
  // `q` is the wash brush's quality: maxDepth caps the outline detail, alphaK darkens each layer
  // to make up for fewer layers, edges is how many layers get the edge line.
  const WASH_FULL = { maxDepth: 5, alphaK: 1, edges: Infinity };
  function washRaw(ctx, rng, x, y, r, layers, opts, detail = r, q = WASH_FULL) {
    r = Math.max(0.5, r);
    // edge detail scales with size: small dabs don't need 320-vertex outlines
    let baseDepth = detail < 6 ? 1 : detail < 24 ? 2 : 3, layerDepth = detail < 24 ? 1 : 2;
    while (baseDepth + layerDepth > q.maxDepth) { // smooth the silhouette first, keep the layers apart
      if (baseDepth > 1) baseDepth--; else if (layerDepth > 1) layerDepth--; else break;
    }
    const base = Array.from({ length: 10 }, (_, i) =>
      ({ x: x + Math.cos(i / 10 * TAU) * r, y: y + Math.sin(i / 10 * TAU) * r }));
    const shape = clampPts(ink.deformPolygon(base, baseDepth, 0.45, rng), x, y, 1.8 * r);
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    for (let k = 0; k < layers; k++) {
      const p = clampPts(ink.deformPolygon(shape, layerDepth, 0.3, rng), x, y, 1.8 * r);
      tracePoly(ctx, p);
      ctx.fillStyle = ink.rgba(opts.color, opts.opacity * rng.range(0.02, 0.05) * q.alphaK);
      ctx.fill();
      if (k >= q.edges) continue;
      ctx.strokeStyle = ink.rgba(opts.color, opts.opacity * 0.04 * q.alphaK);
      ctx.stroke();
    }
  }
  ink.washBlob = helper(washRaw);

  // ---------- torn paper shard: jagged edge, folded face, partial ink outline ----------
  function shardRaw(ctx, rng, x, y, size, wind, opts) {
    size = Math.max(0, size);
    const n = rng.int(4, 7), rx = size * rng.range(0.25, 0.5), stretch = rng.range(1.5, 2.5);
    const rot = wind + rng.range(-0.52, 0.52), cr = Math.cos(rot), sr = Math.sin(rot);
    const corners = Array.from({ length: n }, (_, i) => {
      const a = i / n * TAU + rng.range(-0.35, 0.35), rr = rng.range(0.6, 1.1);
      const lx = Math.cos(a) * rx * rr * stretch, ly = Math.sin(a) * rx * rr;
      return { x: x + lx * cr - ly * sr, y: y + lx * sr + ly * cr };
    });
    // tear every edge into small jagged steps
    const edges = corners.map((a, i) => {
      const b = corners[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / (len || 1), ny = (b.x - a.x) / (len || 1);
      const k = Math.max(2, Math.floor(len / 4)), amp = Math.min(2.2, len * 0.06);
      const pts = [a];
      for (let j = 1; j < k; j++) {
        const t = j / k, o = rng.range(-1, 1) * amp;
        pts.push({ x: a.x + (b.x - a.x) * t + nx * o, y: a.y + (b.y - a.y) * t + ny * o });
      }
      return pts;
    });
    const path = new Path2D();
    edges.flat().forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.12)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.fillStyle = opts.paper || ORIGINAL_PAPER; // chips are cut from the stroke's own paper
    ctx.fill(path);
    ctx.fillStyle = 'rgba(150,160,170,0.16)';
    ctx.fill(path);
    ctx.shadowColor = 'transparent';
    // fold: shade one side of a line through the shard
    const fa = rot + rng.range(0.6, 2.5), fx = x + rng.range(-0.3, 0.3) * rx, fy = y + rng.range(-0.3, 0.3) * rx;
    const L = size * 4, ux = Math.cos(fa), uy = Math.sin(fa);
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = 'rgba(90,100,110,0.25)';
    ctx.beginPath();
    ctx.moveTo(fx - ux * L, fy - uy * L); ctx.lineTo(fx + ux * L, fy + uy * L);
    ctx.lineTo(fx + ux * L - uy * L, fy + uy * L + ux * L); ctx.lineTo(fx - ux * L - uy * L, fy - uy * L + ux * L);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(90,100,110,0.35)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(fx - ux * L, fy - uy * L); ctx.lineTo(fx + ux * L, fy + uy * L); ctx.stroke();
    ctx.restore();
    // partial ink outline
    ctx.strokeStyle = ink.rgba(opts.color, opts.opacity * 0.8);
    ctx.lineWidth = 0.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    edges.forEach((pts, i) => {
      if (!rng.chance(0.6)) return;
      const end = corners[(i + 1) % n];
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.lineTo(end.x, end.y); ctx.stroke();
    });
    ctx.restore();
    if (opts.splatter > 0 && rng.chance(0.3 + opts.splatter / 100 * 0.55)) {
      sprayRaw(ctx, rng, x, y, wind, size * 0.45, opts.splatter / 100 * 0.9, opts);
    }
  }
  ink.shard = helper(shardRaw);

  // ---------- mask: soft round dab, or erase ----------
  function maskRaw(ctx, x, y, r, erase) {
    r = Math.max(0.5, r);
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.7, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ink.maskDab = helper(maskRaw);

  // place stamps every `spacing` px of travel, carrying the remainder across segments
  function stamp(st, a, b, spacing, fn) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.01) return;
    let d = spacing - (st.carry || 0);
    while (d <= len) {
      fn(a.x + (b.x - a.x) * d / len, a.y + (b.y - a.y) * d / len);
      d += spacing;
    }
    st.carry = len - (d - spacing);
  }

  // persistent bristles: each keeps its own last point so streaks stay continuous,
  // and ink runs out along the stroke so the tail breaks into "flying white"
  function drySegment(st, a, b, w, dir) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 0.01) return;
    const o = st.opts, ctx = st.ctx, bleed01 = o.bleed / 100;
    st.arc += len;
    const inkLeft = Math.max(0.12, 1 - st.arc / st.budget);
    const nx = -dy / len, ny = dx / len;
    ctx.lineCap = 'round';
    if (o.bleed > 2 && w > 0) { // ink soaking under the bristles
      ctx.strokeStyle = ink.rgba(o.color, o.opacity * 0.08 * bleed01);
      ctx.lineWidth = w * (0.45 + 0.9 * bleed01);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    const dry = Math.min(0.95, o.dryness + o.taper * 0.35 * speedOf(st));
    const bw = Math.max(0.6, w / st.bristles.length * 2.4);
    for (const br of st.bristles) {
      const px = b.x + nx * br.t * w, py = b.y + ny * br.t * w;
      if (!br.last) br.last = { x: a.x + nx * br.t * w, y: a.y + ny * br.t * w };
      const thresh = dry * 0.45 + Math.abs(br.t) * 2 * 0.35 + (1 - inkLeft) * 0.6;
      if (st.arc >= br.delay && st.noise.n1(st.arc * 0.035 + br.off) > thresh) {
        ctx.strokeStyle = ink.rgba(o.color, o.opacity * br.load * (0.55 + 0.45 * inkLeft));
        ctx.lineWidth = br.wf * bw;
        ctx.beginPath(); ctx.moveTo(br.last.x, br.last.y); ctx.lineTo(px, py); ctx.stroke();
      }
      br.last = { x: px, y: py };
    }
    if (st.rng.chance(0.04)) { // flyaway hair
      const br = st.rng.pick(st.bristles);
      ctx.strokeStyle = ink.rgba(o.color, o.opacity * 0.35);
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(br.last.x, br.last.y);
      ctx.lineTo(br.last.x + st.rng.range(-14, 14), br.last.y + st.rng.range(-14, 14)); ctx.stroke();
    }
    if (o.splatter > 0 && st.rng.chance(o.splatter / 400)) {
      sprayRaw(ctx, st.rng, b.x, b.y, dir, w * 0.4, o.splatter / 100 * 0.5, o);
    }
  }

  // ---------- brushes (raw; wrapped by `guard` below) ----------
  const raw = {};

  raw.dry = {
    layer: 'ink',
    start(st) {
      const o = st.opts, r = st.rng;
      const n = clamp(Math.round(o.size / 1.6), 8, 64);
      st.bristles = Array.from({ length: n }, () => ({
        t: clamp(r.gauss() * 0.33, -0.5, 0.5), wf: r.range(0.5, 2.2),
        load: r.range(0.75, 1), off: r.range(0, 1000), last: null,
        delay: Math.pow(r.next(), 2) * o.size * 0.6, // bristles touch down unevenly → ragged start
      }));
      st.arc = 0;
      st.budget = 900 * (1 - 0.6 * o.dryness);
      st.pendingDab = null;
      st.dabTravel = 0;
    },
    segment(st, a, b, w, dir) {
      // a real drag (2 px of travel) makes the stroke itself the touch-down; jitter doesn't
      st.dabTravel += Math.hypot(b.x - a.x, b.y - a.y);
      if (st.dabTravel >= DAB_CANCEL_PX) st.pendingDab = null;
      drySegment(st, a, b, w, dir);
    },
    // deferred: only a click (no real movement before end) leaves the dab mark,
    // so drags never get a sideways hook at their start
    dab(st, p) { st.pendingDab = { p, alpha: alphaOf(st) }; },
    end(st) {
      const pd = st.pendingDab;
      if (!pd) return;
      st.pendingDab = null;
      const { p } = pd, w = st.opts.size * 0.6;
      st.ctx.globalAlpha = pd.alpha; // drawn now, at the strength it was pressed with
      drySegment(st, { x: p.x - 3, y: p.y }, { x: p.x + 3, y: p.y }, w, 0);
      if (st.opts.splatter > 0) sprayRaw(st.ctx, st.rng, p.x, p.y, st.wind, w * 0.5, st.opts.splatter / 100 * 0.8, st.opts);
    },
  };

  raw.spray = {
    layer: 'ink',
    start(st) { st.travel = 0; },
    segment(st, a, b, w, dir) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) return;
      const gap = st.opts.sprayGap;
      if (gap > 0) { // a burst once the pen has travelled `gap` px since the last one
        st.travel = (st.travel || 0) + len;
        if (st.travel < gap) return;
        st.travel = Math.min(st.travel - gap, gap);
      }
      sprayRaw(st.ctx, st.rng, b.x, b.y, dir, w * 0.5, 0.08 + st.opts.splatter / 100 * 0.9, st.opts, st.opts.sprayDensity);
    },
    dab(st, p) {
      sprayRaw(st.ctx, st.rng, p.x, p.y, st.wind, st.opts.size * 0.7, 0.1 + st.opts.splatter / 100 * 0.9, st.opts, st.opts.sprayDensity);
    },
    end() {},
  };

  // continuous pen for figure outlines: fast = thin
  raw.fine = {
    layer: 'ink',
    start(st, p) { st.prev = p; st.mid = p; st.arc = 0; st.style = null; st.width = 1; },
    segment(st, a, b) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) return;
      const o = st.opts, ctx = st.ctx, prev = st.prev;
      const mid = { x: (prev.x + b.x) / 2, y: (prev.y + b.y) / 2 };
      st.arc += len;
      st.width = 2.2 - 1.7 * speedOf(st);
      st.style = ink.rgba(o.color, o.opacity * (0.8 + 0.2 * st.noise.n1(st.arc * 0.05)));
      ctx.lineCap = 'round';
      ctx.lineWidth = st.width;
      ctx.strokeStyle = st.style;
      ctx.beginPath(); ctx.moveTo(st.mid.x, st.mid.y);
      ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y); ctx.stroke();
      st.mid = mid; st.prev = b;
    },
    dab(st, p) {
      st.ctx.fillStyle = ink.rgba(st.opts.color, st.opts.opacity);
      st.ctx.beginPath(); st.ctx.arc(p.x, p.y, 1.1, 0, TAU); st.ctx.fill();
    },
    end(st) {
      if (!st.style || (st.prev.x === st.mid.x && st.prev.y === st.mid.y)) return;
      const ctx = st.ctx; // this stroke's own style, never whatever another stroke left behind
      ctx.lineCap = 'round';
      ctx.lineWidth = st.width;
      ctx.strokeStyle = st.style;
      ctx.beginPath(); ctx.moveTo(st.mid.x, st.mid.y); ctx.lineTo(st.prev.x, st.prev.y); ctx.stroke();
    },
  };

  // rubber-band: nothing until release, then one long tapered line snapped to the wind
  raw.lines = {
    layer: 'ink',
    start(st, p) { st.p0 = p; st.p1 = p; },
    segment(st, a, b) { st.p1 = b; },
    dab() {},
    end(st) {
      const e = ink.snapEnd(st.p0, st.p1, st.wind);
      if (Math.hypot(e.x - st.p0.x, e.y - st.p0.y) > 4) {
        speedLineRaw(st.ctx, st.rng, st.p0.x, st.p0.y, e.x, e.y, st.opts);
      }
    },
  };

  // the wash brush's quality options as washRaw takes them (6 layers is full quality, alphaK 1)
  const washQuality = o => ({ maxDepth: o.washDetail, alphaK: 6 / o.washLayers, edges: Math.round(o.washLayers * o.washEdge) });
  raw.wash = {
    layer: 'wash',
    start(st) { st.carry = 0; },
    segment(st, a, b, w) {
      const o = st.opts, q = washQuality(o);
      stamp(st, a, b, Math.max(2, 0.4 * w), (x, y) => washRaw(st.ctx, st.rng, x, y, w * 0.55, o.washLayers, o, o.size * 0.55, q));
    },
    dab(st, p) { const o = st.opts; washRaw(st.ctx, st.rng, p.x, p.y, o.size * 0.55, o.washLayers, o, o.size * 0.55, washQuality(o)); },
    end() {},
  };

  raw.shard = {
    layer: 'fx',
    start(st) { st.carry = 0; },
    segment(st, a, b, w) {
      stamp(st, a, b, clamp(st.opts.size * 0.7, 18, 80), (x, y) => shardRaw(st.ctx, st.rng, x, y, w, st.wind, st.opts));
    },
    dab(st, p) { shardRaw(st.ctx, st.rng, p.x, p.y, st.opts.size, st.wind, st.opts); },
    end() {},
  };

  raw.mask = {
    layer: 'mask',
    start(st) { st.carry = 0; },
    segment(st, a, b) {
      const r = st.opts.size / 2;
      stamp(st, a, b, Math.max(1, 0.25 * st.opts.size), (x, y) => maskRaw(st.ctx, x, y, r, st.erase));
    },
    dab(st, p) { maskRaw(st.ctx, p.x, p.y, st.opts.size / 2, st.erase); },
    end() {},
  };

  // public entry points: sanitise arguments, start from a clean ctx at st.alpha, restore after
  // ---------- painted areas ----------
  // A conservative box (CSS px, in the ctx's own coordinates) around everything one call can
  // paint, worked out from each brush's geometry above; computed from the state before the call.
  // tests/dirty.test.js paints random strokes and checks no pixel ever lands outside.
  const box = (pts, m) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  };
  const moved = (a, b) => Math.hypot(b.x - a.x, b.y - a.y) >= 0.01;
  const sprayReach = radius => 3.2 * radius + 4; // mist flies to 3·radius; drops, halos, tails add a little
  const EXTENT = {
    dry: {
      // bristles trail from where they were (previous width), plus bleed, flyaways and splatter
      segment(st, a, b, w) { const W = Math.max(w, st.extW || 0); st.extW = w; return box([a, b], 1.3 * W + 22); },
      end(st) { return st.pendingDab ? box([st.pendingDab.p], st.opts.size + 26) : null; },
    },
    spray: {
      segment(st, a, b, w) { return moved(a, b) ? box([b], sprayReach(w * 0.5)) : null; },
      dab(st, p) { return box([p], sprayReach(st.opts.size * 0.7)); },
    },
    fine: { // the curve runs from the previous midpoint through the previous point
      segment(st, a, b) { return moved(a, b) ? box([st.mid, st.prev, b], 3) : null; },
      dab(st, p) { return box([p], 3); },
      end(st) { return st.style ? box([st.mid, st.prev], 3) : null; },
    },
    lines: {
      end(st) { return box([st.p0, ink.snapEnd(st.p0, st.p1, st.wind)], Math.max(0.4, st.opts.size * 0.03) / 2 + 7); },
    },
    // stamped brushes: a stamp can land up to the carried distance behind the segment start
    wash: {
      segment(st, a, b, w) { return box([a, b], 0.99 * w + 3 + (st.carry || 0)); },
      dab(st, p) { return box([p], st.opts.size + 3); },
    },
    shard: {
      segment(st, a, b, w) { return box([a, b], 1.5 * w + 12 + (st.carry || 0)); },
      dab(st, p) { return box([p], 1.5 * st.opts.size + 12); },
    },
    mask: {
      segment(st, a, b) { return box([a, b], st.opts.size / 2 + 2 + (st.carry || 0)); },
      dab(st, p) { return box([p], st.opts.size / 2 + 2); },
    },
  };
  const grow = (st, r) => {
    if (!r) return;
    const d = st.dirty;
    st.dirty = d ? { x0: Math.min(d.x0, r.x0), y0: Math.min(d.y0, r.y0), x1: Math.max(d.x1, r.x1), y1: Math.max(d.y1, r.y1) } : r;
  };

  function guard(brush, name) {
    const run = (st, fn) => {
      const c = st.ctx;
      c.save();
      try { baseline(c); c.globalAlpha = alphaOf(st); fn(); } finally { c.restore(); }
    };
    const extent = (kind, ...args) => (EXTENT[name] && EXTENT[name][kind] ? EXTENT[name][kind](...args) : null);
    return {
      layer: brush.layer,
      reportsArea: true, // each call adds its painted box to st.dirty
      start(st, p) {
        if (!finitePt(p)) throw new TypeError('start point must have finite x and y');
        run(st, () => brush.start(st, p));
      },
      segment(st, a, b, w, dir) {
        if (!finitePt(a) || !finitePt(b)) return;
        w = Number.isFinite(w) ? Math.max(0, w) : 0;
        dir = Number.isFinite(dir) ? dir : Math.atan2(b.y - a.y, b.x - a.x);
        const r = extent('segment', st, a, b, w);
        run(st, () => brush.segment(st, a, b, w, dir));
        grow(st, r);
      },
      dab(st, p) {
        if (!finitePt(p)) return;
        const r = extent('dab', st, p);
        run(st, () => brush.dab(st, p));
        grow(st, r);
      },
      end(st) {
        const r = extent('end', st);
        run(st, () => brush.end(st));
        grow(st, r);
      },
    };
  }
  S.brushes = {};
  for (const name of Object.keys(raw)) S.brushes[name] = guard(raw[name], name);
  S.BRUSH_NAMES = Object.keys(raw); // the built-ins (a host may add its own brushes to S.brushes)
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).brushes = sumiBrushes;
})(window.SUMI);

// ---- js/recorder.js ----
// Stroke recorder. A pen draws through a brush and keeps what it was given as plain
// JSON-safe data, so the stroke can be replayed pixel-identically later (same browser
// engine and canvas setup). Depends only on rng.js + brushes.js.
//
// Stroke format v3:
//   { v: 3, engine, tool, seed, opts, wind, erase, p0: {x, y}, canvas: {w, h, dpr}, t0, n0,
//     dab: {alpha, t, n} | null,
//     moves: [[x, y, t], ...]                               (pointer input: pen.move)
//       or segs: [[ax, ay, bx, by, w, dir, speed, alpha, t, n], ...]   (explicit calls: pen.segment)
//     end: {alpha, t, n} | null }
// A pointer stroke stores only the input. SUMI.penDynamics turns each move into brush calls
// (speed thins and lightens it by opts.taper; ~2.5 px steps), live and on replay alike, so a
// replay re-derives the exact same calls. Input is rounded before it is used (p0 and moves to
// 1/100 px, every t to 0.1 ms), so the live stroke is drawn from the stored numbers.
// Every t (t0 included) is ms since the caller's `origin`, so calls from different strokes
// compare exactly. Every n is a page-wide call number, in call order: it breaks exact time
// ties, e.g. two pens drawing at once. A move's calls are numbered on from the stroke's last
// call; a 4th number in a move row is its first call's number, stored only when another pen's
// calls came in between. `engine` is SUMI.BRUSH_ENGINE when it was recorded.
// v2 (still accepted) is v3 with segs only and unrounded times; v1 had no engine/n fields,
// and t was ms since the stroke's own start. Explicit segment rows are stored unrounded.
//
// Byte-identical replay also needs the same rasteriser for recording and replay: create
// both canvases with getContext('2d', { willReadFrequently: true }) (CPU). GPU canvases
// antialias differently, and the browser may move a GPU canvas to the CPU after readbacks.
window.SUMI = window.SUMI || {};
(function sumiRecorder(S) {
  S.STROKE_FORMAT = 3;
  // the painted area of a brush that doesn't report one: assume it may have painted anywhere
  S.EVERYWHERE = Object.freeze({ x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity });

  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const finitePt = p => !!p && finite(p.x) && finite(p.y);
  const unit = (v, d) => (finite(v) ? Math.max(0, Math.min(1, v)) : d);
  const px = v => Math.round(v * 100) / 100; // pointer positions: 1/100 px
  const ms = v => Math.round(v * 10) / 10;   // times: 0.1 ms
  const defaultClock = () => performance.now();
  let calls = 0; // page-wide call numbers

  function brushFor(tool) {
    const brush = Object.prototype.hasOwnProperty.call(S.brushes, tool) ? S.brushes[tool] : null;
    if (!brush) throw new TypeError('unknown tool: ' + JSON.stringify(tool));
    return brush;
  }
  function checkCanvas(c, where = 'canvas') {
    if (!c || !(finite(c.w) && c.w > 0) || !(finite(c.h) && c.h > 0) || !(finite(c.dpr) && c.dpr > 0)) {
      throw new TypeError(where + ' must be { w, h, dpr } with positive numbers');
    }
    return { w: c.w, h: c.h, dpr: c.dpr };
  }
  function inferCanvas(ctx) {
    const a = ctx.getTransform ? Math.abs(ctx.getTransform().a) : 1;
    const dpr = finite(a) && a > 0 ? a : 1; // flipped or odd transforms: fall back to a usable size
    return { w: ctx.canvas.width / dpr, h: ctx.canvas.height / dpr, dpr };
  }

  // Pen dynamics: how pointer moves become brush calls. Speed is smoothed px/ms; faster is
  // thinner and lighter by opts.taper (the mask keeps full strength). Each move is split into
  // ~2.5 px steps with the width easing across them. Returns step(p, t) → calls, each
  // [ax, ay, bx, by, w, dir, speed, alpha]. The live pen and playback both run this.
  S.penDynamics = (opts, tool, p0, t0) => {
    let last = p0, lastW = opts.size, lastT = t0, v = 0;
    return (p, t) => {
      const dt = t - lastT || 16;
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      v += (dist / Math.max(dt, 1) - v) * 0.35;
      const speed = Math.min(v / 1.6, 1); // 0 = slow, 1 = fast flick
      const target = Math.max(1.5, opts.size * (1 - opts.taper * 0.8 * speed));
      const w = lastW + (target - lastW) * 0.4;
      const steps = Math.max(1, Math.floor(dist / 2.5));
      const dir = Math.atan2(p.y - last.y, p.x - last.x);
      const alpha = tool === 'mask' ? 1 : 1 - opts.taper * 0.45 * speed;
      const out = [];
      for (let i = 1; i <= steps; i++) {
        const a = (i - 1) / steps, b = i / steps;
        out.push([last.x + (p.x - last.x) * a, last.y + (p.y - last.y) * a,
          last.x + (p.x - last.x) * b, last.y + (p.y - last.y) * b, lastW + (w - lastW) * b, dir, speed, alpha]);
      }
      last = p; lastW = w; lastT = t;
      return out;
    };
  };

  // a stroke's brush calls as [ax, ay, bx, by, w, dir, speed, alpha, t, n] rows: its segs, or
  // for pointer strokes the calls the pen dynamics derive from its moves
  S.strokeCalls = s => {
    if (!s.moves) return s.segs;
    const step = S.penDynamics(S.normalizeOpts(s.opts), s.tool, s.p0, s.t0), out = [];
    let lastN = s.dab ? s.dab.n : s.n0;
    for (const m of s.moves) {
      const first = m.length === 4 ? m[3] : lastN + 1, t = m[2];
      const made = step({ x: m[0], y: m[1] }, t);
      made.forEach((g, j) => { g.push(t, first + j); out.push(g); });
      lastN = first + made.length - 1;
    }
    return out;
  };

  // the one place that says what a valid stroke is (recording, parsing and playback all use it)
  S.validateStroke = s => {
    const bad = msg => { throw new TypeError('invalid stroke: ' + msg); };
    if (!s || typeof s !== 'object') bad('not an object');
    if (s.v !== 1 && s.v !== 2 && s.v !== 3) bad('unsupported format ' + JSON.stringify(s.v));
    if (!Object.prototype.hasOwnProperty.call(S.brushes, s.tool)) bad('unknown tool ' + JSON.stringify(s.tool));
    if (!finite(s.seed) && typeof s.seed !== 'string') bad('seed must be a finite number or a string');
    if (!s.opts || typeof s.opts !== 'object') bad('opts must be an object');
    S.normalizeOpts(s.opts); // throws TypeError on a bad colour
    if (!finite(s.wind)) bad('wind must be a finite number');
    if (typeof s.erase !== 'boolean') bad('erase must be true or false');
    if (!finitePt(s.p0)) bad('p0 must have finite x and y');
    checkCanvas(s.canvas, 'stroke canvas');
    if (!finite(s.t0)) bad('t0 must be a finite number');
    const numbered = s.v >= 2;
    if (numbered && !finite(s.n0)) bad('n0 must be a finite number');
    const call = (c, what) => {
      if (c == null) return;
      if (!finite(c.alpha) || !finite(c.t) || (numbered && !finite(c.n))) bad(what + ' must be { alpha, t' + (numbered ? ', n' : '') + ' } numbers');
    };
    call(s.dab, 'dab'); call(s.end, 'end');
    const hasMoves = s.moves !== undefined, hasSegs = s.segs !== undefined;
    if (s.v === 3 && hasMoves === hasSegs) bad('a v3 stroke has either moves or segs');
    if (s.v !== 3 && hasMoves) bad('moves need format 3');
    if (hasMoves) {
      if (!Array.isArray(s.moves)) bad('moves must be an array');
      s.moves.forEach((m, i) => {
        if (!Array.isArray(m) || (m.length !== 3 && m.length !== 4) || !m.every(finite)) bad(`move ${i} must be 3 or 4 finite numbers`);
      });
      return;
    }
    if (!Array.isArray(s.segs)) bad('segs must be an array');
    const len = numbered ? 10 : 9;
    s.segs.forEach((g, i) => {
      if (!Array.isArray(g) || g.length !== len || !g.every(finite)) bad(`segment ${i} must be ${len} finite numbers`);
    });
  };

  S.recordStroke = (ctx, init) => {
    const { tool, seed, opts, wind = S.DEFAULT_WIND, erase = false, p0, canvas, clock = defaultClock, origin = 0 } = init;
    const brush = brushFor(tool);
    if (!finite(seed) && typeof seed !== 'string') throw new TypeError('seed must be a finite number or a string');
    if (!finitePt(p0)) throw new TypeError('p0 must have finite x and y');
    const size = canvas ? checkCanvas(canvas) : inferCanvas(ctx);

    const st = S.makeStroke(ctx, seed, opts, wind);
    st.erase = !!erase;
    const now = () => ms(clock() - origin);
    const stroke = {
      v: S.STROKE_FORMAT, engine: S.BRUSH_ENGINE, tool, seed, opts: { ...st.opts }, wind: st.wind, erase: st.erase,
      p0: { x: px(p0.x), y: px(p0.y) }, canvas: size,
      t0: now(), n0: ++calls,
      dab: null, moves: [], end: null, // moves becomes segs if the pen is given segments
    };
    brush.start(st, stroke.p0);

    let mode = null, step = null, lastN = stroke.n0; // mode: 'moves' or 'segs', fixed by the first call
    const open = () => { if (stroke.end) throw new Error('stroke already ended'); };
    let touched = false; // for brushes that don't report areas
    return {
      stroke, // grows as the pen moves; final once end() returns it — treat it as read-only
      // the box painted since the last call (null if nothing), so a host can redraw just that;
      // brushes that don't report areas give an infinite box (redraw everything)
      takeDirty() {
        if (!brush.reportsArea) { const r = touched ? S.EVERYWHERE : null; touched = false; return r; }
        const r = st.dirty || null; st.dirty = null; return r;
      },
      // the touch-down mark: once, and only before the first move or segment (replays put it there)
      dab({ alpha = 1 } = {}) {
        open();
        if (mode) throw new Error('dab must come before the first move or segment');
        if (stroke.dab) return; // one touch-down per stroke
        stroke.dab = { alpha: unit(alpha, 1), t: now(), n: ++calls };
        lastN = stroke.dab.n;
        st.alpha = stroke.dab.alpha;
        brush.dab(st, stroke.p0);
        touched = true;
      },
      // the pointer moved to p: records [x, y, t] and draws what the pen dynamics make of it.
      // Returns the rounded point and the stroke's width there (e.g. for a cursor), or null.
      move(p) {
        open();
        if (mode === 'segs') throw new Error('this pen records segments: use segment(), not move()');
        if (!finitePt(p)) return null; // nothing drawn, nothing stored
        if (!mode) { mode = 'moves'; step = S.penDynamics(st.opts, tool, stroke.p0, stroke.t0); }
        const q = { x: px(p.x), y: px(p.y) }, t = now(), made = step(q, t);
        const row = [q.x, q.y, t];
        if (calls !== lastN) row.push(calls + 1); // another pen drew in between: store where this move starts
        stroke.moves.push(row);
        for (const [ax, ay, bx, by, w, dir, speed, alpha] of made) {
          ++calls;
          st.speed = speed; st.alpha = alpha;
          brush.segment(st, { x: ax, y: ay }, { x: bx, y: by }, w, dir);
        }
        lastN = calls;
        touched = true;
        return { p: q, w: made[made.length - 1][4] };
      },
      // explicit calls, for hosts with their own pen dynamics: stores what the brush actually
      // receives (the same clamps brushes apply), made JSON-safe
      segment(a, b, w, dir, { speed = 0, alpha = 1 } = {}) {
        open();
        if (mode === 'moves') throw new Error('this pen records moves: use move(), not segment()');
        if (!finitePt(a) || !finitePt(b)) return; // brushes skip these too: nothing drawn, nothing stored
        if (!mode) { mode = 'segs'; delete stroke.moves; stroke.segs = []; }
        w = finite(w) ? Math.max(0, w) : 0;
        dir = finite(dir) ? dir : Math.atan2(b.y - a.y, b.x - a.x);
        speed = unit(speed, 0);
        alpha = unit(alpha, 1);
        stroke.segs.push([a.x, a.y, b.x, b.y, w, dir, speed, alpha, now(), lastN = ++calls]);
        st.speed = speed; st.alpha = alpha;
        brush.segment(st, { x: a.x, y: a.y }, { x: b.x, y: b.y }, w, dir);
        touched = true;
      },
      end({ alpha = 1 } = {}) {
        if (stroke.end) return stroke;
        stroke.end = { alpha: unit(alpha, 1), t: now(), n: ++calls };
        st.alpha = stroke.end.alpha;
        brush.end(st);
        touched = true;
        return stroke;
      },
    };
  };
  // replaying lives in playback.js: SUMI.replayStroke / SUMI.playback / SUMI.replay
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).recorder = sumiRecorder;
})(window.SUMI);

// ---- js/playback.js ----
// Playback of recorded strokes (format v3; v2 and v1 still accepted; see recorder.js). A pointer
// stroke's moves become the brush calls the pen dynamics derived from them when it was drawn
// (SUMI.strokeCalls). Every call goes on one timeline sorted by time, exact ties broken by the
// recorded call number;
// seek(t) applies, in that fixed order, every call due by t. Frame timing and speed only change
// *when* calls happen, never their order or arguments, so an animated replay ends
// pixel-identical to the live drawing at any speed.
// Depends on rng.js + brushes.js + recorder.js.
window.SUMI = window.SUMI || {};
(function sumiPlayback(S) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const brushFor = tool => S.brushes[tool]; // validateStroke has checked it exists

  // a stroke's calls as { abs: time on the session clock, n: call number, kind, i } (i indexes
  // its rows); times never run backwards within a stroke. v1 times were relative to its start.
  function strokeEvents(s, rows) {
    const numbered = s.v >= 2, abs = t => (numbered ? t : s.t0 + t);
    let prev = s.t0;
    const at = t => (prev = Math.max(prev, t));
    const out = [{ abs: s.t0, n: numbered ? s.n0 : NaN, kind: 'start', i: -1 }];
    if (s.dab) out.push({ abs: at(abs(s.dab.t)), n: numbered ? s.dab.n : NaN, kind: 'dab', i: -1 });
    rows.forEach((g, i) => out.push({ abs: at(abs(g[8])), n: numbered ? g[9] : NaN, kind: 'seg', i }));
    if (s.end) out.push({ abs: at(abs(s.end.t)), n: numbered ? s.end.n : NaN, kind: 'end', i: -1 });
    return out;
  }

  // when each stroke starts on the playback clock (null = keep recorded times)
  function startTimes(strokes, evs, timing, gap, stagger) {
    if (timing === 'recorded') return null;
    if (timing === 'sequence') {
      let at = 0;
      return evs.map((ev, s) => { const start = at; at += ev[ev.length - 1].abs - strokes[s].t0 + gap; return start; });
    }
    if (timing === 'overlap') return strokes.map((_, i) => i * stagger);
    throw new TypeError('timing must be "recorded", "sequence" or "overlap"');
  }

  // A CPU canvas (willReadFrequently) leaves most of its drawing until something reads it, so a
  // slice timed by its script alone would overrun. Sliced seeks read one pixel of each CPU canvas
  // they drew on about once per READ_EVERY_MS, so that drawing counts against the deadline. GPU
  // canvases draw off the main thread and are never read: a read would stall them. Reading
  // changes no pixels; a canvas that can't be read (tainted) is left alone from then on.
  const READ_EVERY_MS = 1;
  const cpu = new WeakMap();
  function cpuCanvas(ctx) {
    let v = cpu.get(ctx);
    if (v === undefined) {
      const a = ctx && typeof ctx.getContextAttributes === 'function' ? ctx.getContextAttributes() : null;
      v = !!(a && a.willReadFrequently);
      if (ctx && typeof ctx === 'object') cpu.set(ctx, v);
    }
    return v;
  }
  function readPixel(ctx) {
    try { ctx.getImageData(0, 0, 1, 1); } catch { cpu.set(ctx, false); }
  }

  // target: a ctx, or a function (stroke) => ctx to route strokes (e.g. to layers)
  S.playback =(target, strokes, { timing = 'recorded', gap = 0, stagger = 0 } = {}) => {
    strokes = Array.isArray(strokes) ? strokes : [strokes];
    strokes.forEach(S.validateStroke);
    const ctxFor = typeof target === 'function' ? target : () => target;
    const rows = strokes.map(S.strokeCalls); // each stroke's brush calls
    const evs = strokes.map((s, i) => strokeEvents(s, rows[i]));
    const custom = startTimes(strokes, evs, timing, finite(gap) ? Math.max(0, gap) : 0, finite(stagger) ? Math.max(0, stagger) : 0);
    const base = strokes.length ? Math.min(...strokes.map(s => s.t0)) : 0;
    const starts = custom || strokes.map(s => s.t0 - base);

    // recorded timing subtracts one base from every session time, which keeps their order
    // exact; ties go by call number, then stroke-major order (stable sort)
    const events = [];
    evs.forEach((ev, s) => ev.forEach(e => events.push({
      time: custom ? custom[s] + (e.abs - strokes[s].t0) : e.abs - base, n: e.n, s, kind: e.kind, i: e.i,
    })));
    events.sort((a, b) => (a.time - b.time) || (finite(a.n) && finite(b.n) ? a.n - b.n : 0));
    const duration = events.length ? events[events.length - 1].time : 0;

    const live = new Array(strokes.length).fill(null);
    let dirty = null; // union of what the applied calls painted, until takeDirty()
    const grow = r => {
      if (!r) return;
      dirty = dirty ? { x0: Math.min(dirty.x0, r.x0), y0: Math.min(dirty.y0, r.y0), x1: Math.max(dirty.x1, r.x1), y1: Math.max(dirty.y1, r.y1) } : r;
    };
    const collect = (st, brush) => {
      if (!brush.reportsArea) { grow(S.EVERYWHERE); return; }
      grow(st.dirty); st.dirty = null;
    };
    // applies one call; returns the ctx it drew on
    function apply({ s, kind, i }) {
      const stroke = strokes[s], brush = brushFor(stroke.tool);
      if (kind === 'start') {
        const st = S.makeStroke(ctxFor(stroke), stroke.seed, stroke.opts, stroke.wind);
        st.erase = !!stroke.erase;
        brush.start(st, stroke.p0);
        live[s] = st;
        return st.ctx;
      }
      const st = live[s];
      if (kind === 'dab') { st.alpha = stroke.dab.alpha; brush.dab(st, stroke.p0); }
      else if (kind === 'seg') {
        const [ax, ay, bx, by, w, dir, speed, alpha] = rows[s][i];
        st.speed = speed; st.alpha = alpha;
        brush.segment(st, { x: ax, y: ay }, { x: bx, y: by }, w, dir);
      } else { st.alpha = stroke.end.alpha; brush.end(st); live[s] = null; }
      collect(st, brush);
      return st.ctx;
    }

    let pos = 0, now = -Infinity;
    const unread = new Set(); // CPU canvases drawn on since the slice last read them
    return {
      starts, duration,
      get total() { return events.length; },
      get position() { return pos; },
      get done() { return pos >= events.length; },
      // the box painted by the calls applied since the last takeDirty() (null if none)
      takeDirty() { const r = dirty; dirty = null; return r; },
      // forward-only: apply every call due by t; returns true once everything is drawn.
      // A deadline (a performance.now() time) stops it after the call that passes it, so a big
      // recording can be drawn a slice per frame; the next seek carries on from there.
      seek(t, deadline = Infinity) {
        if (t > now) now = t;
        if (deadline === Infinity) {
          while (pos < events.length && events[pos].time <= now) apply(events[pos++]);
          return pos >= events.length;
        }
        let read = performance.now();
        while (pos < events.length && events[pos].time <= now) {
          const ctx = apply(events[pos++]);
          if (cpuCanvas(ctx)) unread.add(ctx);
          let at = performance.now();
          if (unread.size && at - read >= READ_EVERY_MS) { // the canvas draws what it deferred, on the clock
            for (const c of unread) readPixel(c);
            unread.clear();
            read = at = performance.now();
          }
          if (at >= deadline) break;
        }
        return pos >= events.length;
      },
    };
  };

  // all at once: exactly the recorded (or, for pointer strokes, re-derived) calls
  S.replayStroke = (ctx, stroke) => { S.playback(ctx, [stroke]).seek(Infinity); };

  const checkBudget = b => {
    if (b !== undefined && !(typeof b === 'number' && b >= 0)) throw new TypeError('budget must be a number ≥ 0 (ms per frame)');
  };

  // animated: speed 1 = real time, 2 = twice as fast, Infinity = draw immediately.
  // budget (ms of drawing per frame, ≥ 0; 0 = one call per frame): a frame stops once it has
  // drawn for that long and leaves the rest to the next frames, so the page stays responsive
  // and speed becomes a maximum. With a budget, speed Infinity draws over frames as well.
  S.replay = (target, strokes, opts = {}) => {
    const { speed = 1, budget, clock = () => performance.now(), frame, onFrame, ...timing } = opts;
    if (typeof speed !== 'number' || !(speed > 0)) throw new TypeError('speed must be a number > 0');
    checkBudget(budget);
    const tl = S.playback(target, strokes, timing);
    const schedule = frame || (cb => requestAnimationFrame(cb));
    let state = 'running', resolve, reject;
    let slice = budget === undefined ? Infinity : budget, rushing = speed === Infinity; // rushing: everything is due
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const settle = completed => { if (state !== 'running') return; state = completed ? 'done' : 'cancelled'; resolve(completed); };
    const fail = err => { if (state !== 'running') return; state = 'failed'; reject(err); };
    const report = () => { if (onFrame) onFrame(tl); };
    // a brush that throws mid-replay rejects `done` (and stops) instead of leaving it pending
    const step = (t, ms) => {
      try {
        const finished = tl.seek(t, ms === Infinity ? Infinity : performance.now() + ms);
        report();
        return finished;
      } catch (err) { fail(err); return null; }
    };

    const t0 = clock();
    const tick = () => {
      if (state !== 'running') return;
      const finished = step(rushing ? Infinity : (clock() - t0) * speed, slice);
      if (finished) settle(true); else if (finished === false) schedule(tick);
    };
    if (rushing && slice === Infinity) { if (step(Infinity, Infinity)) settle(true); }
    else schedule(tick);
    return {
      timeline: tl, done,
      cancel() { settle(false); }, // stop where it is
      // jump to the end now; with { budget }, draw the rest over the next frames instead
      finish({ budget: b } = {}) {
        checkBudget(b);
        if (state !== 'running') return;
        if (b === undefined) { if (step(Infinity, Infinity)) settle(true); return; }
        rushing = true; slice = b; // the tick already scheduled carries on, now to the end
      },
    };
  };
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).playback = sumiPlayback;
})(window.SUMI);
})(typeof globalThis !== 'undefined' ? globalThis : this);
