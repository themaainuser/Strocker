// Stroke recorder. A pen draws through a brush and keeps the exact calls it made as
// plain JSON-safe data, so the stroke can be replayed pixel-identically later
// (same browser engine and canvas setup). Depends only on rng.js + brushes.js.
//
// Stroke format v1:
//   { v, tool, seed, opts, wind, erase, p0: {x, y}, canvas: {w, h, dpr}, t0,
//     dab: {alpha, t} | null,
//     segs: [[ax, ay, bx, by, w, dir, speed, alpha, t], ...],
//     end: {alpha, t} | null }
// t0 is ms since the caller's `origin`; every other t is ms since the stroke started.
// Numbers are stored unrounded: rounding changes the pixels.
//
// Byte-identical replay also needs the same rasteriser for recording and replay: create
// both canvases with getContext('2d', { willReadFrequently: true }) (CPU). GPU canvases
// antialias differently, and the browser may move a GPU canvas to the CPU after readbacks.
window.SUMI = window.SUMI || {};
(function sumiRecorder(S) {
  S.STROKE_FORMAT = 1;

  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const finitePt = p => !!p && finite(p.x) && finite(p.y);
  const unit = (v, d) => (finite(v) ? Math.max(0, Math.min(1, v)) : d);
  const defaultClock = () => performance.now();

  function brushFor(tool) {
    const brush = Object.prototype.hasOwnProperty.call(S.brushes, tool) ? S.brushes[tool] : null;
    if (!brush) throw new TypeError('unknown tool: ' + JSON.stringify(tool));
    return brush;
  }

  function inferCanvas(ctx) {
    const dpr = (ctx.getTransform && ctx.getTransform().a) || 1;
    return { w: ctx.canvas.width / dpr, h: ctx.canvas.height / dpr, dpr };
  }

  S.recordStroke = (ctx, init) => {
    const { tool, seed, opts, wind = S.DEFAULT_WIND, erase = false, p0, canvas, clock = defaultClock, origin = 0 } = init;
    const brush = brushFor(tool);
    if (!finite(seed) && typeof seed !== 'string') throw new TypeError('seed must be a finite number or a string');
    if (!finitePt(p0)) throw new TypeError('p0 must have finite x and y');

    const st = S.makeStroke(ctx, seed, opts, wind);
    st.erase = !!erase;
    const start = clock();
    const stroke = {
      v: S.STROKE_FORMAT, tool, seed, opts: { ...st.opts }, wind: st.wind, erase: st.erase,
      p0: { x: p0.x, y: p0.y },
      canvas: canvas ? { w: canvas.w, h: canvas.h, dpr: canvas.dpr } : inferCanvas(ctx),
      t0: start - origin,
      dab: null, segs: [], end: null,
    };
    brush.start(st, stroke.p0);

    const open = () => { if (stroke.end) throw new Error('stroke already ended'); };
    return {
      stroke, // grows as the pen moves; final once end() returns it
      dab({ alpha = 1 } = {}) {
        open();
        if (stroke.dab) return; // one touch-down per stroke
        stroke.dab = { alpha: unit(alpha, 1), t: clock() - start };
        st.alpha = stroke.dab.alpha;
        brush.dab(st, stroke.p0);
      },
      // stores what the brush actually receives: the same clamps brushes apply, made JSON-safe
      segment(a, b, w, dir, { speed = 0, alpha = 1 } = {}) {
        open();
        if (!finitePt(a) || !finitePt(b)) return; // brushes skip these too: nothing drawn, nothing stored
        w = finite(w) ? Math.max(0, w) : 0;
        dir = finite(dir) ? dir : Math.atan2(b.y - a.y, b.x - a.x);
        speed = unit(speed, 0);
        alpha = unit(alpha, 1);
        stroke.segs.push([a.x, a.y, b.x, b.y, w, dir, speed, alpha, clock() - start]);
        st.speed = speed; st.alpha = alpha;
        brush.segment(st, { x: a.x, y: a.y }, { x: b.x, y: b.y }, w, dir);
      },
      end({ alpha = 1 } = {}) {
        if (stroke.end) return stroke;
        stroke.end = { alpha: unit(alpha, 1), t: clock() - start };
        st.alpha = stroke.end.alpha;
        brush.end(st);
        return stroke;
      },
    };
  };
  // replaying lives in playback.js: SUMI.replayStroke / SUMI.playback / SUMI.replay
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).recorder = sumiRecorder;
})(window.SUMI);
