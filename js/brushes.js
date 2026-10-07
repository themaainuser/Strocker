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
  // the pixels of an existing stroke (the golden-hash tests are keyed by it).
  S.BRUSH_ENGINE = 1;
  const DAB_CANCEL_PX = 2; // dry brush: travel that turns a click into a drag

  S.defaultOpts = () => ({ size: 34, opacity: 0.85, dryness: 0.55, splatter: 40, bleed: 35, taper: 0.65, color: '#111318' });

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
    const color = o.color == null ? d.color : o.color;
    ink.parseColor(color); // throws TypeError on anything that isn't a colour
    return {
      size: num(o.size, d.size, 1, 1000), opacity: num(o.opacity, d.opacity, 0, 1),
      dryness: num(o.dryness, d.dryness, 0, 1), splatter: num(o.splatter, d.splatter, 0, 100),
      bleed: num(o.bleed, d.bleed, 0, 100), taper: num(o.taper, d.taper, 0, 1),
      color: color.trim(),
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
  function sprayRaw(ctx, rng, x, y, dir, radius, amount, opts) {
    radius = Math.max(0, radius);
    const bleed01 = opts.bleed / 100, op = opts.opacity, col = opts.color;
    const reach = radius * 2.5;
    const drops = Array.from({ length: BUCKETS }, () => new Path2D());
    const band = (k, lo, hi) => Math.min(BUCKETS - 1, Math.floor((k - lo) / (hi - lo) * BUCKETS));
    const bandAlpha = (i, lo, hi) => lo + (i + 0.5) * (hi - lo) / BUCKETS;
    const tails = [];
    const count = Math.floor(20 + 180 * amount);
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
    const dots = Math.floor(60 + 260 * amount);
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
  function washRaw(ctx, rng, x, y, r, layers, opts, detail = r) {
    r = Math.max(0.5, r);
    // edge detail scales with size: small dabs don't need 320-vertex outlines
    const baseDepth = detail < 6 ? 1 : detail < 24 ? 2 : 3, layerDepth = detail < 24 ? 1 : 2;
    const base = Array.from({ length: 10 }, (_, i) =>
      ({ x: x + Math.cos(i / 10 * TAU) * r, y: y + Math.sin(i / 10 * TAU) * r }));
    const shape = clampPts(ink.deformPolygon(base, baseDepth, 0.45, rng), x, y, 1.8 * r);
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    for (let k = 0; k < layers; k++) {
      const p = clampPts(ink.deformPolygon(shape, layerDepth, 0.3, rng), x, y, 1.8 * r);
      tracePoly(ctx, p);
      ctx.fillStyle = ink.rgba(opts.color, opts.opacity * rng.range(0.02, 0.05));
      ctx.fill();
      ctx.strokeStyle = ink.rgba(opts.color, opts.opacity * 0.04);
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
    ctx.fillStyle = S.PAPER || '#f4f1ea';
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
    start() {},
    segment(st, a, b, w, dir) {
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.01) return;
      sprayRaw(st.ctx, st.rng, b.x, b.y, dir, w * 0.5, 0.08 + st.opts.splatter / 100 * 0.9, st.opts);
    },
    dab(st, p) {
      sprayRaw(st.ctx, st.rng, p.x, p.y, st.wind, st.opts.size * 0.7, 0.1 + st.opts.splatter / 100 * 0.9, st.opts);
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

  raw.wash = {
    layer: 'wash',
    start(st) { st.carry = 0; },
    segment(st, a, b, w) {
      stamp(st, a, b, Math.max(2, 0.4 * w), (x, y) => washRaw(st.ctx, st.rng, x, y, w * 0.55, 6, st.opts, st.opts.size * 0.55));
    },
    dab(st, p) { washRaw(st.ctx, st.rng, p.x, p.y, st.opts.size * 0.55, 6, st.opts); },
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
  function guard(brush) {
    const run = (st, fn) => {
      const c = st.ctx;
      c.save();
      try { baseline(c); c.globalAlpha = alphaOf(st); fn(); } finally { c.restore(); }
    };
    return {
      layer: brush.layer,
      start(st, p) {
        if (!finitePt(p)) throw new TypeError('start point must have finite x and y');
        run(st, () => brush.start(st, p));
      },
      segment(st, a, b, w, dir) {
        if (!finitePt(a) || !finitePt(b)) return;
        w = Number.isFinite(w) ? Math.max(0, w) : 0;
        dir = Number.isFinite(dir) ? dir : Math.atan2(b.y - a.y, b.x - a.x);
        run(st, () => brush.segment(st, a, b, w, dir));
      },
      dab(st, p) { if (finitePt(p)) run(st, () => brush.dab(st, p)); },
      end(st) { run(st, () => brush.end(st)); },
    };
  }
  S.brushes = {};
  for (const name of Object.keys(raw)) S.brushes[name] = guard(raw[name]);
  S.BRUSH_NAMES = Object.keys(raw); // the built-ins (a host may add its own brushes to S.brushes)
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).brushes = sumiBrushes;
})(window.SUMI);
