// Playback of recorded strokes (format v1, see recorder.js). Every recorded call goes on one
// timeline sorted by time; seek(t) applies, in that fixed order, every call due by t. Frame
// timing and speed only change *when* calls happen, never their order or arguments, so an
// animated replay ends pixel-identical to the live drawing at any speed.
// Depends on rng.js + brushes.js + recorder.js.
window.SUMI = window.SUMI || {};
(function (S) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);

  function brushFor(tool) {
    const brush = Object.prototype.hasOwnProperty.call(S.brushes, tool) ? S.brushes[tool] : null;
    if (!brush) throw new TypeError('unknown tool: ' + JSON.stringify(tool));
    return brush;
  }
  function check(stroke) {
    if (!stroke || stroke.v !== S.STROKE_FORMAT) {
      throw new TypeError('unsupported stroke format: ' + JSON.stringify(stroke && stroke.v));
    }
    brushFor(stroke.tool);
  }

  // a stroke's calls as [time since its start, kind, segment index]; times never run backwards
  function localEvents(s) {
    const out = [[0, 'start', -1]];
    let prev = 0;
    const at = t => (prev = finite(t) ? Math.max(prev, t) : prev);
    if (s.dab) out.push([at(s.dab.t), 'dab', -1]);
    s.segs.forEach((g, i) => out.push([at(g[8]), 'seg', i]));
    if (s.end) out.push([at(s.end.t), 'end', -1]);
    return out;
  }

  // when each stroke starts on the playback clock
  function startTimes(strokes, locals, timing, gap, stagger) {
    if (timing === 'recorded') {
      const t0 = strokes.map(s => (finite(s.t0) ? s.t0 : 0)), base = Math.min(...t0);
      return t0.map(t => t - base);
    }
    if (timing === 'sequence') {
      let at = 0;
      return locals.map(ev => { const start = at; at += ev[ev.length - 1][0] + gap; return start; });
    }
    if (timing === 'overlap') return strokes.map((_, i) => i * stagger);
    throw new TypeError('timing must be "recorded", "sequence" or "overlap"');
  }

  // target: a ctx, or a function (stroke) => ctx to route strokes (e.g. to layers)
  S.playback = (target, strokes, { timing = 'recorded', gap = 0, stagger = 0 } = {}) => {
    strokes = Array.isArray(strokes) ? strokes : [strokes];
    strokes.forEach(check);
    const ctxFor = typeof target === 'function' ? target : () => target;
    const locals = strokes.map(localEvents);
    const starts = startTimes(strokes, locals, timing, finite(gap) ? Math.max(0, gap) : 0, finite(stagger) ? Math.max(0, stagger) : 0);

    // stroke-major order before a stable sort: equal times keep recorded order
    const events = [];
    locals.forEach((ev, s) => ev.forEach(([t, kind, i]) => events.push({ time: starts[s] + t, s, kind, i })));
    events.sort((a, b) => a.time - b.time);
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
    let state = 'running', resolve;
    const done = new Promise(r => { resolve = r; });
    const settle = completed => { if (state !== 'running') return; state = completed ? 'done' : 'cancelled'; resolve(completed); };
    const report = () => { if (onFrame) onFrame(tl); };

    if (speed === Infinity) { tl.seek(Infinity); report(); settle(true); }
    else {
      const t0 = clock();
      const tick = () => {
        if (state !== 'running') return;
        const finished = tl.seek((clock() - t0) * speed);
        report();
        if (finished) settle(true); else schedule(tick);
      };
      schedule(tick);
    }
    return {
      timeline: tl, done,
      cancel() { settle(false); },                                         // stop where it is
      finish() { if (state === 'running') { tl.seek(Infinity); report(); settle(true); } }, // jump to the end
    };
  };
})(window.SUMI);
