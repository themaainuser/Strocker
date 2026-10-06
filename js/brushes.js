// Brush engine. Every brush draws through a per-stroke state `st` carrying a
// seeded rng + noise, so hand strokes and generated posters share one code path.
window.SUMI = window.SUMI || {};
(function (S) {
  S.DEFAULT_WIND = -35 * Math.PI / 180; // lower-left → upper-right, like the reference slashes

  S.defaultOpts = () => ({ size: 34, opacity: 0.85, dryness: 0.55, splatter: 40, bleed: 35, taper: 0.65, color: '#111318' });

  S.makeStroke = (ctx, seed, opts, wind = S.DEFAULT_WIND) =>
    ({ ctx, rng: S.makeRng(seed), noise: S.makeNoise(seed), opts, wind, speed: 0, erase: false });

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const TAU = Math.PI * 2;
  const ink = S.ink = {};

  const rgbCache = {};
  ink.rgba = (hex, a) => {
    let c = rgbCache[hex];
    if (!c) {
      const h = hex.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map(ch => ch + ch).join('') : h, 16);
      c = rgbCache[hex] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  };

  // ---------- spray: droplets thrown along `dir` ----------
  ink.spray = (ctx, rng, x, y, dir, radius, amount, opts) => {
    const bleed01 = opts.bleed / 100, op = opts.opacity, col = opts.color;
    const reach = radius * 2.5;
    const count = Math.floor(20 + 180 * amount);
    for (let i = 0; i < count; i++) {
      const a = dir + rng.gauss() * 0.5;
      const d = Math.pow(rng.next(), 1.4) * reach;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      const s = Math.pow(rng.next(), 3) * radius * 0.12 + 0.3;
      const stretch = 1 + 1.8 * d / reach; // far drops streak along their flight
      if (bleed01 > 0.05 && s > 1.6 && i % 2 === 0) {
        const hr = s * (2 + bleed01 * 3.5);
        const g = ctx.createRadialGradient(px, py, 0, px, py, hr);
        g.addColorStop(0, ink.rgba(col, op * 0.16 * bleed01));
        g.addColorStop(1, ink.rgba(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(px, py, hr, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = ink.rgba(col, op * rng.range(0.45, 0.95));
      ctx.beginPath(); ctx.ellipse(px, py, s * stretch, s, a, 0, TAU); ctx.fill();
      if (s > 0.8 && rng.chance(0.05)) { // thin tail pointing back at the source
        const tl = s * rng.range(3, 8);
        ctx.strokeStyle = ink.rgba(col, op * 0.6);
        ctx.lineWidth = s * 0.5;
        ctx.beginPath(); ctx.moveTo(px, py);
        ctx.lineTo(px - Math.cos(a) * tl, py - Math.sin(a) * tl); ctx.stroke();
      }
    }
    // blot cores for heavy throws
    if (amount > 0.4) {
      const blots = rng.int(1, 2);
      for (let i = 0; i < blots; i++) {
        const d = rng.range(0.2, 0.8) * radius, a = dir + rng.gauss() * 0.3;
        ctx.fillStyle = ink.rgba(col, op * rng.range(0.6, 0.9));
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d,
          rng.range(0.15, 0.3) * radius * 1.6, rng.range(0.15, 0.3) * radius * 0.7, a, 0, TAU);
        ctx.fill();
      }
    }
    // micro-mist
    const mist = Math.floor(30 + 120 * amount);
    for (let i = 0; i < mist; i++) {
      const a = dir + rng.gauss() * 0.9, d = Math.pow(rng.next(), 0.8) * reach * 1.2;
      ctx.fillStyle = ink.rgba(col, op * rng.range(0.3, 0.8));
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rng.range(0.3, 0.8), 0, TAU);
      ctx.fill();
    }
  };

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
  ink.drawSpeedLine = (ctx, rng, x0, y0, x1, y1, opts) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1) return;
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
  };

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
  ink.washBlob = (ctx, rng, x, y, r, layers, opts) => {
    const base = Array.from({ length: 10 }, (_, i) =>
      ({ x: x + Math.cos(i / 10 * TAU) * r, y: y + Math.sin(i / 10 * TAU) * r }));
    const shape = clampPts(ink.deformPolygon(base, 3, 0.45, rng), x, y, 1.8 * r);
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    for (let k = 0; k < layers; k++) {
      const p = clampPts(ink.deformPolygon(shape, 2, 0.3, rng), x, y, 1.8 * r);
      tracePoly(ctx, p);
      ctx.fillStyle = ink.rgba(opts.color, opts.opacity * rng.range(0.02, 0.05));
      ctx.fill();
      ctx.strokeStyle = ink.rgba(opts.color, opts.opacity * 0.04);
      ctx.stroke();
    }
  };

  // ---------- torn paper shard: jagged edge, folded face, partial ink outline ----------
  ink.shard = (ctx, rng, x, y, size, wind, opts) => {
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
      ink.spray(ctx, rng, x, y, wind, size * 0.45, opts.splatter / 100 * 0.9, opts);
    }
  };

  // ---------- mask: soft round dab, or erase ----------
  ink.maskDab = (ctx, x, y, r, erase) => {
    ctx.save();
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.7, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.restore();
  };

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

  // ---------- brushes ----------
  const brushes = S.brushes = {};

  brushes.wash = {
    layer: 'wash',
    start(st) { st.carry = 0; },
    segment(st, a, b, w) {
      stamp(st, a, b, Math.max(2, 0.4 * w), (x, y) => ink.washBlob(st.ctx, st.rng, x, y, w * 0.55, 6, st.opts));
    },
    dab(st, p) { ink.washBlob(st.ctx, st.rng, p.x, p.y, st.opts.size * 0.55, 6, st.opts); },
    end() {},
  };

  brushes.shard = {
    layer: 'fx',
    start(st) { st.carry = 0; },
    segment(st, a, b, w) {
      stamp(st, a, b, clamp(st.opts.size * 0.7, 18, 80), (x, y) => ink.shard(st.ctx, st.rng, x, y, w, st.wind, st.opts));
    },
    dab(st, p) { ink.shard(st.ctx, st.rng, p.x, p.y, st.opts.size, st.wind, st.opts); },
    end() {},
  };

  brushes.mask = {
    layer: 'mask',
    start(st) { st.carry = 0; },
    segment(st, a, b) {
      const r = st.opts.size / 2;
      stamp(st, a, b, Math.max(1, 0.25 * st.opts.size), (x, y) => ink.maskDab(st.ctx, x, y, r, st.erase));
    },
    dab(st, p) { ink.maskDab(st.ctx, p.x, p.y, st.opts.size / 2, st.erase); },
    end() {},
  };

  // persistent bristles: each keeps its own last point so streaks stay continuous,
  // and ink runs out along the stroke so the tail breaks into "flying white"
  brushes.dry = {
    layer: 'ink',
    start(st) {
      const o = st.opts, r = st.rng;
      const n = clamp(Math.round(o.size / 1.6), 8, 64);
      st.bristles = Array.from({ length: n }, () => ({
        t: clamp(r.gauss() * 0.33, -0.5, 0.5), wf: r.range(0.6, 1.4),
        load: r.range(0.75, 1), off: r.range(0, 1000), last: null,
      }));
      st.arc = 0;
      st.budget = 900 * (1 - 0.6 * o.dryness);
    },
    segment(st, a, b, w, dir) {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 0.01) return;
      const o = st.opts, ctx = st.ctx, bleed01 = o.bleed / 100;
      st.arc += len;
      const inkLeft = Math.max(0.12, 1 - st.arc / st.budget);
      const nx = -dy / len, ny = dx / len;
      ctx.lineCap = 'round';
      if (o.bleed > 2) { // ink soaking under the bristles
        ctx.strokeStyle = ink.rgba(o.color, o.opacity * 0.14 * bleed01);
        ctx.lineWidth = w * (0.45 + 0.9 * bleed01);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      const dry = Math.min(0.95, o.dryness + o.taper * 0.35 * st.speed);
      const bw = Math.max(0.6, w / st.bristles.length * 1.6);
      for (const br of st.bristles) {
        const px = b.x + nx * br.t * w, py = b.y + ny * br.t * w;
        if (!br.last) br.last = { x: a.x + nx * br.t * w, y: a.y + ny * br.t * w };
        const thresh = dry * 0.55 + Math.abs(br.t) * 2 * 0.25 + (1 - inkLeft) * 0.6;
        if (st.noise.n1(st.arc * 0.035 + br.off) > thresh) {
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
        ink.spray(ctx, st.rng, b.x, b.y, dir, w * 0.4, o.splatter / 100 * 0.5, o);
      }
    },
    dab(st, p) {
      const w = st.opts.size * 0.6;
      brushes.dry.segment(st, { x: p.x - 3, y: p.y }, { x: p.x + 3, y: p.y }, w, 0);
      if (st.opts.splatter > 0) ink.spray(st.ctx, st.rng, p.x, p.y, st.wind, w * 0.5, st.opts.splatter / 100 * 0.8, st.opts);
    },
    end() {},
  };

  brushes.spray = {
    layer: 'ink',
    start() {},
    segment(st, a, b, w, dir) {
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.01) return;
      ink.spray(st.ctx, st.rng, b.x, b.y, dir, w * 0.5, 0.08 + st.opts.splatter / 100 * 0.9, st.opts);
    },
    dab(st, p) {
      ink.spray(st.ctx, st.rng, p.x, p.y, st.wind, st.opts.size * 0.7, 0.1 + st.opts.splatter / 100 * 0.9, st.opts);
    },
    end() {},
  };

  // continuous pen for figure outlines: fast = thin
  brushes.fine = {
    layer: 'ink',
    start(st, p) { st.prev = p; st.mid = p; st.arc = 0; },
    segment(st, a, b) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) return;
      const o = st.opts, ctx = st.ctx, prev = st.prev;
      const mid = { x: (prev.x + b.x) / 2, y: (prev.y + b.y) / 2 };
      st.arc += len;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.2 - 1.7 * st.speed;
      ctx.strokeStyle = ink.rgba(o.color, o.opacity * (0.8 + 0.2 * st.noise.n1(st.arc * 0.05)));
      ctx.beginPath(); ctx.moveTo(st.mid.x, st.mid.y);
      ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y); ctx.stroke();
      st.mid = mid; st.prev = b;
    },
    dab(st, p) {
      st.ctx.fillStyle = ink.rgba(st.opts.color, st.opts.opacity);
      st.ctx.beginPath(); st.ctx.arc(p.x, p.y, 1.1, 0, TAU); st.ctx.fill();
    },
    end(st) {
      if (!st.prev || (st.prev.x === st.mid.x && st.prev.y === st.mid.y)) return;
      const ctx = st.ctx;
      ctx.beginPath(); ctx.moveTo(st.mid.x, st.mid.y); ctx.lineTo(st.prev.x, st.prev.y); ctx.stroke();
    },
  };

  // rubber-band: nothing until release, then one long tapered line snapped to the wind
  brushes.lines = {
    layer: 'ink',
    start(st, p) { st.p0 = p; st.p1 = p; },
    segment(st, a, b) { st.p1 = b; },
    dab() {},
    end(st) {
      const e = ink.snapEnd(st.p0, st.p1, st.wind);
      if (Math.hypot(e.x - st.p0.x, e.y - st.p0.y) > 4) {
        ink.drawSpeedLine(st.ctx, st.rng, st.p0.x, st.p0.y, e.x, e.y, st.opts);
      }
    },
  };
})(window.SUMI);
