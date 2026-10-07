// Playback of recorded strokes (format v2, v1 still accepted; see recorder.js). Every recorded
// call goes on one timeline sorted by time, exact ties broken by the recorded call number;
// seek(t) applies, in that fixed order, every call due by t. Frame timing and speed only change
// *when* calls happen, never their order or arguments, so an animated replay ends
// pixel-identical to the live drawing at any speed.
// Depends on rng.js + brushes.js + recorder.js.
window.SUMI = window.SUMI || {};
(function sumiPlayback(S) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const brushFor = tool => S.brushes[tool]; // validateStroke has checked it exists

  // a stroke's calls as { abs: time on the session clock, n: call number, kind, i };
  // times never run backwards within a stroke. v1 times were relative to the stroke's start.
  function strokeEvents(s) {
    const v2 = s.v === 2, abs = t => (v2 ? t : s.t0 + t);
    let prev = s.t0;
    const at = t => (prev = Math.max(prev, t));
    const out = [{ abs: s.t0, n: v2 ? s.n0 : NaN, kind: 'start', i: -1 }];
    if (s.dab) out.push({ abs: at(abs(s.dab.t)), n: v2 ? s.dab.n : NaN, kind: 'dab', i: -1 });
    s.segs.forEach((g, i) => out.push({ abs: at(abs(g[8])), n: v2 ? g[9] : NaN, kind: 'seg', i }));
    if (s.end) out.push({ abs: at(abs(s.end.t)), n: v2 ? s.end.n : NaN, kind: 'end', i: -1 });
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

  // target: a ctx, or a function (stroke) => ctx to route strokes (e.g. to layers)
  S.playback = (target, strokes, { timing = 'recorded', gap = 0, stagger = 0 } = {}) => {
    strokes = Array.isArray(strokes) ? strokes : [strokes];
    strokes.forEach(S.validateStroke);
    const ctxFor = typeof target === 'function' ? target : () => target;
    const evs = strokes.map(strokeEvents);
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
    function apply({ s, kind, i }) {
      const stroke = strokes[s], brush = brushFor(stroke.tool);
      if (kind === 'start') {
        const st = S.makeStroke(ctxFor(stroke), stroke.seed, stroke.opts, stroke.wind);
        st.erase = !!stroke.erase;
        brush.start(st, stroke.p0);
        live[s] = st;
        return;
      }
      const st = live[s];
      if (kind === 'dab') { st.alpha = stroke.dab.alpha; brush.dab(st, stroke.p0); }
      else if (kind === 'seg') {
        const [ax, ay, bx, by, w, dir, speed, alpha] = stroke.segs[i];
        st.speed = speed; st.alpha = alpha;
        brush.segment(st, { x: ax, y: ay }, { x: bx, y: by }, w, dir);
      } else { st.alpha = stroke.end.alpha; brush.end(st); live[s] = null; }
    }

    let pos = 0, now = -Infinity;
    return {
      starts, duration,
      get total() { return events.length; },
      get position() { return pos; },
      get done() { return pos >= events.length; },
      // forward-only: apply every call due by t; returns true once everything is drawn
      seek(t) {
        if (t > now) {
          now = t;
          while (pos < events.length && events[pos].time <= t) apply(events[pos++]);
        }
        return pos >= events.length;
      },
    };
  };

  // all at once, exactly the recorded calls (no re-splitting of the path)
  S.replayStroke = (ctx, stroke) => { S.playback(ctx, [stroke]).seek(Infinity); };

  // animated: speed 1 = real time, 2 = twice as fast, Infinity = draw immediately
  S.replay = (target, strokes, opts = {}) => {
    const { speed = 1, clock = () => performance.now(), frame, onFrame, ...timing } = opts;
    if (typeof speed !== 'number' || !(speed > 0)) throw new TypeError('speed must be a number > 0');
    const tl = S.playback(target, strokes, timing);
    const schedule = frame || (cb => requestAnimationFrame(cb));
    let state = 'running', resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const settle = completed => { if (state !== 'running') return; state = completed ? 'done' : 'cancelled'; resolve(completed); };
    const fail = err => { if (state !== 'running') return; state = 'failed'; reject(err); };
    const report = () => { if (onFrame) onFrame(tl); };
    // a brush that throws mid-replay rejects `done` (and stops) instead of leaving it pending
    const step = t => { try { const finished = tl.seek(t); report(); return finished; } catch (err) { fail(err); return null; } };

    if (speed === Infinity) { if (step(Infinity)) settle(true); }
    else {
      const t0 = clock();
      const tick = () => {
        if (state !== 'running') return;
        const finished = step((clock() - t0) * speed);
        if (finished) settle(true); else if (finished === false) schedule(tick);
      };
      schedule(tick);
    }
    return {
      timeline: tl, done,
      cancel() { settle(false); },                                               // stop where it is
      finish() { if (state === 'running' && step(Infinity)) settle(true); },    // jump to the end
    };
  };
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).playback = sumiPlayback;
})(window.SUMI);
