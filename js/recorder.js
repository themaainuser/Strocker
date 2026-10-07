// Stroke recorder. A pen draws through a brush and keeps the exact calls it made as
// plain JSON-safe data, so the stroke can be replayed pixel-identically later
// (same browser engine and canvas setup). Depends only on rng.js + brushes.js.
//
// Stroke format v2:
//   { v: 2, engine, tool, seed, opts, wind, erase, p0: {x, y}, canvas: {w, h, dpr}, t0, n0,
//     dab: {alpha, t, n} | null,
//     segs: [[ax, ay, bx, by, w, dir, speed, alpha, t, n], ...],
//     end: {alpha, t, n} | null }
// Every t (t0 included) is ms since the caller's `origin`, so calls from different strokes
// compare exactly. Every n is a page-wide call number, in call order: it breaks exact time
// ties, e.g. two pens drawing at once. `engine` is SUMI.BRUSH_ENGINE when it was recorded.
// v1 (still accepted) had no engine/n fields, and t was ms since the stroke's own start.
// Numbers are stored unrounded: rounding changes the pixels.
//
// Byte-identical replay also needs the same rasteriser for recording and replay: create
// both canvases with getContext('2d', { willReadFrequently: true }) (CPU). GPU canvases
// antialias differently, and the browser may move a GPU canvas to the CPU after readbacks.
window.SUMI = window.SUMI || {};
(function sumiRecorder(S) {
  S.STROKE_FORMAT = 2;
  // the painted area of a brush that doesn't report one: assume it may have painted anywhere
  S.EVERYWHERE = Object.freeze({ x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity });

  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const finitePt = p => !!p && finite(p.x) && finite(p.y);
  const unit = (v, d) => (finite(v) ? Math.max(0, Math.min(1, v)) : d);
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

  // the one place that says what a valid stroke is (recording, parsing and playback all use it)
  S.validateStroke = s => {
    const bad = msg => { throw new TypeError('invalid stroke: ' + msg); };
    if (!s || typeof s !== 'object') bad('not an object');
    if (s.v !== 1 && s.v !== 2) bad('unsupported format ' + JSON.stringify(s.v));
    if (!Object.prototype.hasOwnProperty.call(S.brushes, s.tool)) bad('unknown tool ' + JSON.stringify(s.tool));
    if (!finite(s.seed) && typeof s.seed !== 'string') bad('seed must be a finite number or a string');
    if (!s.opts || typeof s.opts !== 'object') bad('opts must be an object');
    S.normalizeOpts(s.opts); // throws TypeError on a bad colour
    if (!finite(s.wind)) bad('wind must be a finite number');
    if (typeof s.erase !== 'boolean') bad('erase must be true or false');
    if (!finitePt(s.p0)) bad('p0 must have finite x and y');
    checkCanvas(s.canvas, 'stroke canvas');
    if (!finite(s.t0)) bad('t0 must be a finite number');
    const v2 = s.v === 2;
    if (v2 && !finite(s.n0)) bad('n0 must be a finite number');
    const call = (c, what) => {
      if (c == null) return;
      if (!finite(c.alpha) || !finite(c.t) || (v2 && !finite(c.n))) bad(what + ' must be { alpha, t' + (v2 ? ', n' : '') + ' } numbers');
    };
    call(s.dab, 'dab'); call(s.end, 'end');
    if (!Array.isArray(s.segs)) bad('segs must be an array');
    const len = v2 ? 10 : 9;
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
    const now = () => clock() - origin;
    const stroke = {
      v: S.STROKE_FORMAT, engine: S.BRUSH_ENGINE, tool, seed, opts: { ...st.opts }, wind: st.wind, erase: st.erase,
      p0: { x: p0.x, y: p0.y }, canvas: size,
      t0: now(), n0: ++calls,
      dab: null, segs: [], end: null,
    };
    brush.start(st, stroke.p0);

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
      // the touch-down mark: once, and only before the first segment (replays put it there)
      dab({ alpha = 1 } = {}) {
        open();
        if (stroke.segs.length) throw new Error('dab must come before the first segment');
        if (stroke.dab) return; // one touch-down per stroke
        stroke.dab = { alpha: unit(alpha, 1), t: now(), n: ++calls };
        st.alpha = stroke.dab.alpha;
        brush.dab(st, stroke.p0);
        touched = true;
      },
      // stores what the brush actually receives: the same clamps brushes apply, made JSON-safe
      segment(a, b, w, dir, { speed = 0, alpha = 1 } = {}) {
        open();
        if (!finitePt(a) || !finitePt(b)) return; // brushes skip these too: nothing drawn, nothing stored
        w = finite(w) ? Math.max(0, w) : 0;
        dir = finite(dir) ? dir : Math.atan2(b.y - a.y, b.x - a.x);
        speed = unit(speed, 0);
        alpha = unit(alpha, 1);
        stroke.segs.push([a.x, a.y, b.x, b.y, w, dir, speed, alpha, now(), ++calls]);
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
