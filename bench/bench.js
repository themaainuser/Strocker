// SUMI performance benchmark: how fast the core library (rng, brushes, recorder, playback)
// and export.js run in this browser. Open bench/index.html, or run `node tools/bench.mjs` for a
// headless run with a fine-grained clock. Results: window.SUMI_BENCH (a promise of a plain
// object whose `report` is the text shown on the page).
//
// Strokes are drawn the way the app draws them: recordStroke, a dab on touch-down, one
// pen.move per 60 Hz pointer event, end on release. Every timed step is followed by a
// 1-pixel getImageData, because Chrome defers canvas raster until something reads the canvas
// and the timings would otherwise mostly miss it. Canvases are CPU (willReadFrequently), as the
// library expects for exact replay. Nothing here touches the DOM board or layers.js.
(function () {
  const S = window.SUMI;
  const W = 1200, H = 800, TAU = Math.PI * 2;
  const MOVE_MS = 1000 / 60; // pointer moves arrive once per 60 Hz frame
  const SIZES = [12, 34, 80], DPRS = [1, 2];
  const PRESETS = { spray: ['full', 'balanced', 'fast'], wash: ['full', 'balanced', 'fast'] };
  const now = () => performance.now();
  const tick = () => new Promise(r => setTimeout(r, 0)); // lets the page paint between sections
  function log(msg) {
    console.log('[bench] ' + msg);
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
  }

  // ---------- helpers ----------
  function surface(dpr, w = W, h = H) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  const flush = ctx => ctx.getImageData(0, 0, 1, 1);
  function hash(ctx) {
    const { width, height } = ctx.canvas;
    const u = new Uint32Array(ctx.getImageData(0, 0, width, height).data.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
    return h >>> 0;
  }
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  function summary(xs) {
    const s = Float64Array.from(xs).sort(), n = s.length;
    const at = p => s[Math.min(n - 1, Math.floor(p * n))];
    return { n, mean: mean(xs), p50: at(0.5), p95: at(0.95), max: s[n - 1], total: mean(xs) * n };
  }
  const share = (xs, ms) => xs.filter(x => x > ms).length / xs.length;
  const gzipSize = async text =>
    (await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()).byteLength;
  // the painted box clipped to the board, in CSS px²
  const clippedArea = b => Math.max(0, Math.min(W, b.x1) - Math.max(0, b.x0)) * Math.max(0, Math.min(H, b.y1) - Math.max(0, b.y0));

  // a wandering pointer path that stays on the board; step is px per move (or a function of i)
  function pointerPath(seed, n, step) {
    const r = S.makeRng('path:' + seed);
    let x = r.range(0.3, 0.7) * W, y = r.range(0.3, 0.7) * H, a = r.range(0, TAU);
    const pts = [{ x, y }];
    for (let i = 0; i < n; i++) {
      a += r.gauss() * 0.2;
      if (x < 150 || x > W - 150 || y < 150 || y > H - 150) { // steer back toward the middle
        const home = Math.atan2(H / 2 - y, W / 2 - x);
        a += Math.atan2(Math.sin(home - a), Math.cos(home - a)) * 0.3;
      }
      const d = typeof step === 'function' ? step(i) : step;
      x = Math.min(W - 4, Math.max(4, x + Math.cos(a) * d));
      y = Math.min(H - 4, Math.max(4, y + Math.sin(a) * d));
      pts.push({ x, y });
    }
    return pts;
  }
  const varied = i => 4 + 22 * (0.5 + 0.5 * Math.sin(i / 37)); // 4..26 px per move, slow and fast

  // one stroke as the app draws it, on a fake 60 Hz clock; each step timed with a raster flush
  // (timed: false skips the flushes, for building recordings quickly)
  function drawStroke(ctx, tool, opts, pts, seed, { t0 = 0, canvas, timed = true } = {}) {
    let t = t0;
    const clock = () => t, moves = [], area = [];
    let a = now();
    const pen = S.recordStroke(ctx, { tool, seed, opts, p0: pts[0], clock, canvas });
    pen.dab({ alpha: 1 });
    pen.takeDirty();
    if (timed) flush(ctx);
    const start = now() - a;
    for (let i = 1; i < pts.length; i++) {
      t += MOVE_MS;
      a = now();
      pen.move(pts[i]);
      const box = pen.takeDirty();
      if (timed) flush(ctx);
      moves.push(now() - a);
      if (box) area.push(clippedArea(box));
    }
    t += MOVE_MS;
    a = now();
    const stroke = pen.end({ alpha: 1 });
    pen.takeDirty();
    if (timed) flush(ctx);
    return { stroke, start, moves, end: now() - a, area, t };
  }

  // ---------- environment ----------
  function environment() {
    let res = Infinity; // smallest step performance.now() takes
    for (let i = 0; i < 50; i++) {
      const a = now(); let b = now();
      while (b === a) b = now();
      res = Math.min(res, b - a);
    }
    return {
      userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency || null,
      crossOriginIsolated: !!self.crossOriginIsolated, timerResolutionMs: res,
      brushEngine: S.BRUSH_ENGINE, strokeFormat: S.STROKE_FORMAT,
      webCodecs: typeof S.canRenderWebM === 'function' && S.canRenderWebM(),
    };
  }

  // ---------- micro: the building blocks every brush call goes through ----------
  function micro() {
    const rows = [], ctx = surface(1, 8, 8), opts = S.defaultOpts();
    let sink = 0;
    const time = (name, n, fn) => {
      fn(Math.min(n, 2000)); // warm-up
      const a = now(); fn(n); const ms = now() - a;
      rows.push({ name, n, nsPer: ms * 1e6 / n, perSec: n / ms * 1000 });
    };
    const rng = S.makeRng(1), noise = S.makeNoise(1);
    time('rng.next', 5e6, n => { for (let i = 0; i < n; i++) sink += rng.next(); });
    time('rng.gauss', 2e6, n => { for (let i = 0; i < n; i++) sink += rng.gauss(); });
    time('noise.n1', 5e6, n => { for (let i = 0; i < n; i++) sink += noise.n1(i * 0.037); });
    time('noise.fbm2 (4 octaves)', 1e6, n => { for (let i = 0; i < n; i++) sink += noise.fbm2(i * 0.013, i * 0.029); });
    time('makeNoise (512+256 tables)', 2e4, n => { for (let i = 0; i < n; i++) sink += S.makeNoise(i).n1(0.5); });
    time('makeStroke (rng, noise, opts)', 2e4, n => { for (let i = 0; i < n; i++) sink += S.makeStroke(ctx, i, opts).wind; });
    time('normalizeOpts', 2e5, n => { for (let i = 0; i < n; i++) sink += S.normalizeOpts(opts).size; });
    time('ink.rgba (cached colour)', 2e6, n => { for (let i = 0; i < n; i++) sink += S.ink.rgba('#111318', 0.5).length; });
    time('penDynamics step (12 px move)', 2e5, n => {
      const step = S.penDynamics(S.normalizeOpts(opts), 'dry', { x: 0, y: 0 }, 0);
      for (let i = 1; i <= n; i++) sink += step({ x: i * 12, y: 0 }, i * MOVE_MS).length;
    });
    window.__benchSink = sink; // keeps the loops from being optimised away
    return rows;
  }

  // ---------- brushes: cost per pointer move, by size, pixel density and quality ----------
  // strokes of 40 moves of 12 px (~480 px); the first stroke of each cell warms up
  async function brushMatrix() {
    const rows = [];
    for (const tool of S.BRUSH_NAMES) {
      log('brushes: ' + tool);
      for (const preset of PRESETS[tool] || ['full']) for (const dpr of DPRS) for (const size of SIZES) {
        const ctx = surface(dpr), canvas = { w: W, h: H, dpr };
        const opts = { ...S.defaultOpts(), size, ...S.QUALITY[preset] };
        const moves = [], strokeCost = [], area = [];
        for (let s = -1; s < 6; s++) {
          const r = drawStroke(ctx, tool, opts, pointerPath(`${tool}/${size}/${s}`, 40, 12), s, { canvas });
          if (s < 0) continue;
          moves.push(...r.moves); strokeCost.push(r.start + r.end); area.push(...r.area);
        }
        rows.push({
          tool, preset: PRESETS[tool] ? preset : '', dpr, size, move: summary(moves),
          over8: share(moves, 8), over16: share(moves, MOVE_MS), startEnd: mean(strokeCost), boxSide: Math.sqrt(mean(area)),
        });
      }
      await tick();
    }
    return rows;
  }

  // ---------- the app's cost meter, to check the numbers the README quotes ----------
  // a copy of brushCost in app.js: four 3 px segments per "move" at speed 0.2, then a read
  function meterCost(tool, opts, dpr) {
    const w = 360, h = 160, x = surface(dpr, w, h);
    const st = S.makeStroke(x, 'cost', opts, S.DEFAULT_WIND), b = S.brushes[tool];
    let p = { x: 20, y: h / 2 };
    b.start(st, p);
    const move = () => {
      for (let i = 0; i < 4; i++) {
        const q = { x: p.x + 3, y: h / 2 + Math.sin(p.x / 30) * 10 };
        st.speed = 0.2; b.segment(st, p, q, opts.size, Math.atan2(q.y - p.y, q.x - p.x)); p = q;
      }
      x.getImageData(0, 0, 1, 1);
    };
    for (let i = 0; i < 3; i++) move();
    const rounds = [];
    for (let r = 0; r < 3; r++) {
      const t0 = now();
      for (let i = 0; i < 6; i++) move();
      rounds.push((now() - t0) / 6);
    }
    return rounds.sort((a, c) => a - c)[1];
  }
  function meterCheck() {
    const rows = [];
    for (const tool of ['spray', 'wash']) for (const preset of PRESETS[tool]) for (const dpr of DPRS) {
      const opts = S.normalizeOpts({ ...S.defaultOpts(), size: 34, ...S.QUALITY[preset] });
      const runs = Array.from({ length: 7 }, () => meterCost(tool, opts, dpr));
      rows.push({ tool, preset, dpr, ms: summary(runs).p50 });
    }
    return rows;
  }

  // ---------- one long stroke per brush: steady cost, recording size, exact replay ----------
  async function longStrokes() {
    const rows = [];
    for (const dpr of DPRS) for (const tool of S.BRUSH_NAMES) {
      log(`long stroke: ${tool} at ${dpr}x`);
      const ctx = surface(dpr), canvas = { w: W, h: H, dpr };
      const opts = { ...S.defaultOpts(), ...S.QUALITY.balanced };
      const r = drawStroke(ctx, tool, opts, pointerPath('long/' + tool, 1800, varied), 'long', { canvas });
      const live = hash(ctx), json = JSON.stringify(r.stroke);
      const again = surface(dpr);
      const a = now();
      S.replayStroke(again, r.stroke); flush(again);
      const replay = now() - a;
      const tenth = Math.floor(r.moves.length / 10);
      rows.push({
        tool, dpr, moves: r.moves.length, calls: S.strokeCalls(r.stroke).length, live: summary(r.moves), end: r.end,
        first: mean(r.moves.slice(0, tenth)), last: mean(r.moves.slice(-tenth)),
        json: json.length, gzip: await gzipSize(json), replay, identical: hash(again) === live,
      });
      await tick();
    }
    return rows;
  }

  // ---------- a session of mixed strokes, replayed frame by frame at several speeds ----------
  function session(dpr, count) {
    const ctx = surface(dpr), canvas = { w: W, h: H, dpr }, strokes = [];
    const opts = { ...S.defaultOpts(), ...S.QUALITY.balanced };
    let t = 0, liveMs = 0;
    for (let i = 0; i < count; i++) {
      const tool = S.BRUSH_NAMES[i % S.BRUSH_NAMES.length];
      const a = now();
      const r = drawStroke(ctx, tool, opts, pointerPath('session/' + i, 90, varied), 'session/' + i, { t0: t, canvas, timed: false });
      flush(ctx);
      liveMs += now() - a;
      strokes.push(r.stroke);
      t = r.t + 300; // a pause between strokes
    }
    return { strokes, liveMs, hash: hash(ctx) };
  }
  async function replays() {
    const rows = [];
    for (const dpr of DPRS) {
      log(`replay frames at ${dpr}x`);
      const rec = session(dpr, 21);
      for (const speed of [1, 4, 8, Infinity]) {
        const ctx = surface(dpr), tl = S.playback(ctx, rec.strokes), frames = [];
        let t = 0, done = false;
        while (!done) {
          t += MOVE_MS * speed;
          const a = now();
          done = tl.seek(t); tl.takeDirty(); flush(ctx);
          frames.push(now() - a);
        }
        rows.push({
          dpr, speed, strokes: rec.strokes.length, length: tl.duration, frames: summary(frames),
          over16: share(frames, MOVE_MS), identical: hash(ctx) === rec.hash,
        });
        await tick();
      }
    }
    return rows;
  }

  // ---------- a large recording through the export and import paths ----------
  async function recording() {
    log('large recording: drawing 120 strokes');
    const ctx = surface(1), canvas = { w: W, h: H, dpr: 1 }, strokes = [];
    const opts = { ...S.defaultOpts(), ...S.QUALITY.balanced };
    let t = 0, a = now();
    for (let i = 0; i < 120; i++) {
      const tool = S.BRUSH_NAMES[i % S.BRUSH_NAMES.length];
      const r = drawStroke(ctx, tool, opts, pointerPath('big/' + i, 60, varied), 'big/' + i, { t0: t, canvas, timed: false });
      strokes.push(r.stroke); t = r.t + 200;
    }
    flush(ctx);
    const steps = [{ step: 'draw live (120 strokes, 7,200 moves)', ms: now() - a }];
    const timed = async (step, fn) => {
      const t0 = now(), out = await fn();
      const bytes = typeof out === 'string' ? out.length : out instanceof Blob ? out.size : null;
      steps.push({ step, ms: now() - t0, bytes });
      return out;
    };
    log('large recording: export and import');
    const json = await timed('recordingJSON', () => S.recordingJSON(strokes, { canvas }));
    const gz = await timed('recordingGzip', () => S.recordingGzip(strokes, { canvas }));
    await timed('parseRecording (JSON text)', () => { S.parseRecording(json); return null; });
    await timed('readRecording (.json.gz)', async () => { await S.readRecording(gz); return null; });
    await timed('standaloneHTML', () => S.standaloneHTML(strokes, { canvas }));
    await timed('standaloneHTMLGzip', () => S.standaloneHTMLGzip(strokes, { canvas }));
    const target = surface(1);
    let tl;
    await timed('playback setup (validate, derive calls, sort)', () => { tl = S.playback(target, strokes); return null; });
    await timed(`replay all at once (${tl.total.toLocaleString('en')} calls)`, () => { tl.seek(Infinity); flush(target); return null; });
    return { strokes: strokes.length, moves: strokes.reduce((n, s) => n + s.moves.length, 0), steps };
  }

  // ---------- WebM rendered frame by frame (WebCodecs) ----------
  async function webm() {
    if (!S.canRenderWebM()) return { skipped: 'no WebCodecs in this browser' };
    const rows = [];
    for (const dpr of DPRS) {
      log(`WebM at ${dpr}x`);
      const rec = session(dpr, 8);
      const a = now();
      let blob;
      try {
        const job = S.renderWebM(rec.strokes, { canvas: { w: W, h: H, dpr }, speed: 1 });
        blob = await job.done;
        rows.push({ dpr, video: job.duration, ms: now() - a, bytes: blob.size });
      } catch (err) {
        rows.push({ dpr, error: err.code || err.message });
      }
      await tick();
    }
    return { rows };
  }

  // ---------- the report ----------
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const pct = v => (v > 0 ? (v * 100).toFixed(v < 0.01 ? 1 : 0) + '%' : '0');
  const kb = b => (b == null ? '' : b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB');
  const big = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : n.toFixed(0));
  function table(title, note, head, rows) {
    const cells = [head, ...rows.map(r => r.map(String))];
    const width = head.map((_, i) => Math.max(...cells.map(r => r[i].length)));
    const line = r => '| ' + r.map((c, i) => c.padEnd(width[i])).join(' | ') + ' |';
    return [`## ${title}`, note, '', line(head), '|' + width.map(w => '-'.repeat(w + 2)).join('|') + '|', ...rows.map(r => line(r.map(String))), ''].filter(x => x !== null).join('\n');
  }
  function report(R) {
    const e = R.env, out = [];
    out.push(`# SUMI benchmark\n${e.userAgent}\ncores ${e.cores} · timer ${f(e.timerResolutionMs * 1000, 0)} µs` +
      `${e.crossOriginIsolated ? '' : ' (not cross-origin isolated: run node tools/bench.mjs for a 5 µs clock)'}` +
      ` · engine ${e.brushEngine} · stroke format ${e.strokeFormat} · board ${W}×${H} CSS px · took ${f(R.tookMs / 1000, 1)} s\n`);
    out.push(table('Building blocks', null, ['operation', 'ns per call', 'per second'],
      R.micro.map(m => [m.name, f(m.nsPer, m.nsPer < 100 ? 1 : 0), big(m.perSec)])));
    out.push(table('Brush cost per pointer move (12 px, about 4 brush calls)',
      'ms per move including the raster. "> 8 ms" is the app\'s heavy line, "> 16.7" a missed 60 fps frame. ' +
      'start+end: touch-down and release per stroke. box: side of the average painted box a host redraws.',
      ['brush', 'quality', 'dpr', 'size', 'mean', 'p50', 'p95', 'max', '> 8 ms', '> 16.7', 'start+end', 'box px'],
      R.brushes.map(r => [r.tool, r.preset, r.dpr + 'x', r.size, f(r.move.mean), f(r.move.p50), f(r.move.p95), f(r.move.max),
        pct(r.over8), pct(r.over16), f(r.startEnd), f(r.boxSide, 0)])));
    out.push(table('README check: the app\'s cost meter at size 34',
      'README (1x): spray ~2.3 / ~1.8 / ~0.8 ms, wash ~1.2 / ~0.5 / ~0.2 ms for full / balanced / fast. Median of 7 meter runs.',
      ['brush', 'quality', 'dpr', 'ms per move'], R.meter.map(r => [r.tool, r.preset, r.dpr + 'x', f(r.ms)])));
    out.push(table('One long stroke per brush (1,800 moves, 4–26 px each, size 34, balanced)',
      'first/last: mean ms per move over the first and last tenth (a growing cost would show here). ' +
      'replay: replayStroke of the recording onto a fresh canvas; identical: same pixels as the live stroke.',
      ['brush', 'dpr', 'calls', 'live total ms', 'mean', 'p95', 'max', 'first', 'last', 'end', 'JSON', 'gzip', 'replay ms', 'identical'],
      R.long.map(r => [r.tool, r.dpr + 'x', r.calls, f(r.live.total, 0), f(r.live.mean), f(r.live.p95), f(r.live.max),
        f(r.first), f(r.last), f(r.end), kb(r.json), kb(r.gzip), f(r.replay, 0), r.identical ? 'yes' : 'NO'])));
    out.push(table('Animated replay: cost per 60 fps frame (21 mixed strokes, balanced)',
      'Each frame applies every call due by then, as SUMI.replay does. Infinity = draw it all in one go.',
      ['dpr', 'speed', 'length s', 'frames', 'mean', 'p95', 'max', '> 16.7', 'identical'],
      R.replays.map(r => [r.dpr + 'x', r.speed === Infinity ? '∞' : r.speed + '×', f(r.length / 1000, 1), r.frames.n,
        f(r.frames.mean), f(r.frames.p95), f(r.frames.max), pct(r.over16), r.identical ? 'yes' : 'NO'])));
    out.push(table(`Large recording: ${R.recording.strokes} strokes, ${R.recording.moves.toLocaleString('en')} moves (1x)`, null,
      ['step', 'ms', 'size'], R.recording.steps.map(s => [s.step, f(s.ms, 1), kb(s.bytes)])));
    if (R.webm.skipped) out.push(`## WebM\nskipped: ${R.webm.skipped}\n`);
    else {
      out.push(table('WebM rendered frame by frame (8 mixed strokes, 30 fps, speed 1)', null,
        ['dpr', 'video s', 'render s', 'faster than real time', 'size'],
        R.webm.rows.map(r => (r.error ? [r.dpr + 'x', 'error: ' + r.error, '', '', ''] :
          [r.dpr + 'x', f(r.video / 1000, 1), f(r.ms / 1000, 1), f(r.video / r.ms, 1) + '×', kb(r.bytes)]))));
    }
    return out.join('\n');
  }

  async function run() {
    const t0 = now();
    const R = { env: environment() };
    log('building blocks'); await tick();
    R.micro = micro();
    R.brushes = await brushMatrix();
    log('README check'); await tick();
    R.meter = meterCheck();
    R.long = await longStrokes();
    R.replays = await replays();
    R.recording = await recording();
    R.webm = await webm();
    R.tookMs = now() - t0;
    R.report = report(R);
    const el = document.getElementById('report');
    if (el) el.textContent = R.report;
    log('done in ' + f(R.tookMs / 1000, 1) + ' s');
    return R;
  }
  window.SUMI_BENCH = new Promise(r => addEventListener('load', r)).then(run);
  window.SUMI_BENCH.catch(err => log('FAILED: ' + (err && err.stack || err)));
})();
