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
