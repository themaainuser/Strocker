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
