// Export a recording three ways:
//   SUMI.recordingJSON / SUMI.parseRecording   the strokes as a validated JSON document
//   SUMI.standaloneHTML                        one .html file that animates them, no other files
//   SUMI.recordWebM                            a video, via canvas.captureStream + MediaRecorder
// The HTML inlines rng.js + brushes.js + recorder.js + playback.js from the functions those
// files register in SUMI.modules (the browser keeps their exact source text), so exporting
// works from file:// without fetching anything.
window.SUMI = window.SUMI || {};
(function (S) {
  const FORMAT = 'sumi-strokes', VERSION = 1, PAPER = '#f4f1ea';
  const CORE = ['rng', 'brushes', 'recorder', 'playback'];
  const TIMINGS = ['recorded', 'sequence', 'overlap'];
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const positive = v => finite(v) && v > 0;

  function checkCanvas(c) {
    if (!c || !positive(c.w) || !positive(c.h) || !positive(c.dpr)) {
      throw new TypeError('canvas must be { w, h, dpr } with positive numbers');
    }
    return { w: c.w, h: c.h, dpr: c.dpr };
  }
  const checkStroke = s => S.validateStroke(s); // one definition of a valid stroke (recorder.js)
  function checkPlayback({ speed, timing, gap, stagger }) {
    if (typeof speed !== 'number' || !(speed > 0)) throw new TypeError('speed must be a number > 0');
    if (!TIMINGS.includes(timing)) throw new TypeError('timing must be one of ' + TIMINGS.join(', '));
    for (const [k, v] of [['gap', gap], ['stagger', stagger]]) {
      if (!finite(v) || v < 0) throw new TypeError(k + ' must be a number ≥ 0');
    }
  }
  const canvasOf = (strokes, canvas) =>
    checkCanvas(canvas || (strokes[0] && strokes[0].canvas) || { w: 800, h: 600, dpr: 1 });

  S.recordingJSON = (strokes, { canvas, paper = PAPER } = {}) => {
    strokes.forEach(checkStroke);
    S.ink.parseColor(paper);
    return JSON.stringify({ format: FORMAT, v: VERSION, canvas: canvasOf(strokes, canvas), paper, strokes });
  };

  S.parseRecording = input => {
    const doc = typeof input === 'string' ? JSON.parse(input) : input; // bad JSON text → SyntaxError
    if (!doc || doc.format !== FORMAT) throw new TypeError('not a SUMI recording (format must be "' + FORMAT + '")');
    if (doc.v !== VERSION) throw new TypeError('unsupported recording version: ' + JSON.stringify(doc.v));
    if (!Array.isArray(doc.strokes)) throw new TypeError('strokes must be an array');
    doc.strokes.forEach(checkStroke);
    S.ink.parseColor(doc.paper);
    return { format: FORMAT, v: VERSION, canvas: checkCanvas(doc.canvas), paper: doc.paper, strokes: doc.strokes };
  };

  // Compositing stage shared by the HTML player and the video recorder: per-layer CPU canvases
  // like the app (wash multiplied onto paper, then ink, then fx). Mask strokes are an authoring
  // aid and are left out. Self-contained so its source can be inlined into exported files.
  // Replay frames redraw only the box their calls painted, as the app does (js/layers.js).
  function sumiStage(S, data, view) {
    const { w, h, dpr } = data.canvas;
    view.width = Math.round(w * dpr); view.height = Math.round(h * dpr);
    const vctx = view.getContext('2d');
    const layer = () => {
      const c = document.createElement('canvas');
      c.width = view.width; c.height = view.height;
      c.getContext('2d', { willReadFrequently: true }).setTransform(dpr, 0, 0, dpr, 0, 0);
      return c;
    };
    const layers = { wash: layer(), ink: layer(), fx: layer() };
    const strokes = data.strokes.filter(s => S.brushes[s.tool].layer in layers);
    const stats = { full: 0, area: 0 };
    // the whole picture, onto the view or (for a copy) another canvas of the same size
    const composite = (ctx = vctx) => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = data.paper;
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(layers.wash, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layers.ink, 0, 0);
      ctx.drawImage(layers.fx, 0, 0);
      ctx.restore();
      if (ctx === vctx) stats.full++;
    };
    // Redraws box r (CSS px, as playback reports it) with the same blends. Each layer's box is
    // copied into a small scratch canvas with get/putImageData (drawImage would make the browser
    // snapshot the whole layer), so only the box is uploaded. An unbounded box redraws it all.
    let scratch = null;
    const update = r => {
      if (!r) return;
      if (![r.x0, r.y0, r.x1, r.y1].every(Number.isFinite)) { composite(); return; }
      const x0 = Math.max(0, Math.floor(r.x0 * dpr) - 1), y0 = Math.max(0, Math.floor(r.y0 * dpr) - 1);
      const x1 = Math.min(view.width, Math.ceil(r.x1 * dpr) + 1), y1 = Math.min(view.height, Math.ceil(r.y1 * dpr) + 1);
      if (x1 <= x0 || y1 <= y0) return;
      const bw = x1 - x0, bh = y1 - y0;
      if (!scratch || scratch.width !== bw || scratch.height !== bh) {
        scratch = document.createElement('canvas'); scratch.width = bw; scratch.height = bh;
      }
      const sc = scratch.getContext('2d', { willReadFrequently: true });
      const put = (src, op) => {
        sc.putImageData(src.getContext('2d').getImageData(x0, y0, bw, bh), 0, 0);
        vctx.globalCompositeOperation = op;
        vctx.drawImage(scratch, x0, y0);
      };
      vctx.save();
      vctx.setTransform(1, 0, 0, 1, 0, 0);
      vctx.globalCompositeOperation = 'source-over';
      vctx.fillStyle = data.paper;
      vctx.fillRect(x0, y0, bw, bh);
      put(layers.wash, 'multiply');
      put(layers.ink, 'source-over');
      put(layers.fx, 'source-over');
      vctx.restore();
      stats.area++;
    };
    let run = null;
    const play = opts => {
      if (run) run.cancel();
      for (const c of Object.values(layers)) {
        const x = c.getContext('2d');
        x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.restore();
      }
      composite();
      run = S.replay(s => layers[S.brushes[s.tool].layer].getContext('2d'), strokes,
        { ...opts, onFrame: tl => update(tl.takeDirty()) });
      return run;
    };
    return { layers, strokes, stats, composite, update, play, get run() { return run; } };
  }

  // the exported page's entry point (inlined as source)
  function sumiStandalone(S, stage, data, opts) {
    const view = document.getElementById('sumi');
    view.style.width = data.canvas.w + 'px';
    const st = stage(S, data, view);
    const play = () => st.play(opts);
    view.addEventListener('click', play);
    play();
    window.SUMI_PLAYER = { layers: st.layers, stats: st.stats, composite: st.composite, update: st.update, play, get run() { return st.run; } };
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // inlined source must never close the <script> early or open an HTML comment
  const scriptSafe = src => src.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  const jsonSafe = value => JSON.stringify(value).replace(/</g, '\\u003c');

  S.standaloneHTML = (strokes, opts = {}) => {
    const { canvas, paper = PAPER, title = 'SUMI strokes', speed = 1, timing = 'recorded', gap = 150, stagger = 0 } = opts;
    checkPlayback({ speed, timing, gap, stagger });
    const missing = CORE.filter(k => !(S.modules && typeof S.modules[k] === 'function'));
    if (missing.length) throw new Error('load js/' + missing.join('.js, js/') + '.js before exporting');
    // the page inlines brushes.js only: brushes a host added at runtime aren't in it
    const custom = [...new Set(strokes.map(s => s && s.tool))].filter(t => !(S.BRUSH_NAMES || []).includes(t));
    if (custom.length) throw new TypeError('custom brushes can\'t go into a standalone HTML file: ' + custom.join(', '));
    const data = JSON.parse(S.recordingJSON(strokes, { canvas, paper }));
    const play = { speed: speed === Infinity ? null : speed, timing, gap, stagger }; // JSON has no Infinity
    const shown = data.strokes.filter(s => S.brushes[s.tool].layer !== 'mask').length; // the player skips mask strokes
    const core = CORE.map(k => '(' + scriptSafe(S.modules[k].toString()) + ')(window.SUMI);').join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  html,body{margin:0;min-height:100%;background:#0e0e10}
  body{display:grid;place-items:center;min-height:100vh;font:12px ui-monospace,Menlo,Consolas,monospace;color:#8b8b90}
  #sumi{display:block;max-width:100vw;max-height:calc(100vh - 32px);height:auto;cursor:pointer;box-shadow:0 2px 24px rgba(0,0,0,.45)}
  p{margin:8px 0 0;text-align:center}
</style>
</head>
<body>
<main>
<canvas id="sumi" role="img" aria-label="${esc(title)}: animated ink strokes"></canvas>
<p>${shown} strokes · click to replay</p>
</main>
<script>
window.SUMI = window.SUMI || {};
window.SUMI.PAPER = ${jsonSafe(S.PAPER || '#f4f1ea')}; // shard chips are cut from this paper, as when recorded
${core}
const DATA = ${jsonSafe(data)};
const PLAY = ${jsonSafe(play)};
if (PLAY.speed === null) PLAY.speed = Infinity;
(${scriptSafe(sumiStandalone.toString())})(window.SUMI, ${scriptSafe(sumiStage.toString())}, DATA, PLAY);
</script>
</body>
</html>
`;
  };

  // real-time capture: plays the recording onto an offscreen stage and records it
  // done resolves to the video Blob, or to null if cancel() was called
  S.recordWebM = (strokes, opts = {}) => {
    const { canvas, paper = PAPER, speed = 1, timing = 'recorded', gap = 150, stagger = 0, fps = 30, hold = 600 } = opts;
    checkPlayback({ speed, timing, gap, stagger });
    if (!finite(fps) || fps <= 0 || fps > 120) throw new TypeError('fps must be a number in (0, 120]');
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error('this browser cannot record canvas video');
    }
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error('this browser cannot encode WebM');
    const data = JSON.parse(S.recordingJSON(strokes, { canvas, paper }));
    const view = document.createElement('canvas');
    const stage = sumiStage(S, data, view);
    const stream = view.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    let cancelled = false, failure = null, run = null;
    const stopTracks = () => stream.getTracks().forEach(t => t.stop());
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve, reject) => {
      rec.onstop = () => {
        stopTracks();
        if (failure) reject(failure);
        else resolve(cancelled ? null : new Blob(chunks, { type: 'video/webm' }));
      };
      rec.onerror = e => { stopTracks(); if (run) run.cancel(); reject(e.error || new Error('video recording failed')); };
    });
    stage.composite();
    rec.start(250);
    // frames come from a timer at the video's frame rate, not from screen refreshes, so the
    // video gets every frame even when the page isn't being drawn (hidden pane, throttled tab)
    const frame = cb => setTimeout(cb, 1000 / fps);
    run = stage.play({ speed, timing, gap, stagger, frame });
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    run.done.then(() => setTimeout(stop, hold), err => { failure = err; stop(); }); // hold the finished picture a moment
    return { done, run, stream, cancel() { cancelled = true; run.cancel(); stop(); } };
  };
})(window.SUMI);
