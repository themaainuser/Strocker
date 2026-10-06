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
  function checkStroke(s) {
    const ok = s && s.v === S.STROKE_FORMAT && Array.isArray(s.segs) &&
      typeof s.tool === 'string' && Object.prototype.hasOwnProperty.call(S.brushes, s.tool);
    if (!ok) throw new TypeError('not a v' + S.STROKE_FORMAT + ' stroke: ' + JSON.stringify(s && { v: s.v, tool: s.tool }));
  }
  function checkPlayback({ speed, timing }) {
    if (typeof speed !== 'number' || !(speed > 0)) throw new TypeError('speed must be a number > 0');
    if (!TIMINGS.includes(timing)) throw new TypeError('timing must be one of ' + TIMINGS.join(', '));
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
    const composite = () => {
      vctx.save();
      vctx.setTransform(1, 0, 0, 1, 0, 0);
      vctx.globalCompositeOperation = 'source-over';
      vctx.fillStyle = data.paper;
      vctx.fillRect(0, 0, view.width, view.height);
      vctx.globalCompositeOperation = 'multiply';
      vctx.drawImage(layers.wash, 0, 0);
      vctx.globalCompositeOperation = 'source-over';
      vctx.drawImage(layers.ink, 0, 0);
      vctx.drawImage(layers.fx, 0, 0);
      vctx.restore();
    };
    let run = null;
    const play = opts => {
      if (run) run.cancel();
      for (const c of Object.values(layers)) {
        const x = c.getContext('2d');
        x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.restore();
      }
      composite();
      run = S.replay(s => layers[S.brushes[s.tool].layer].getContext('2d'), strokes, { ...opts, onFrame: composite });
      return run;
    };
    return { layers, strokes, composite, play, get run() { return run; } };
  }

  // the exported page's entry point (inlined as source)
  function sumiStandalone(S, stage, data, opts) {
    const view = document.getElementById('sumi');
    view.style.width = data.canvas.w + 'px';
    const st = stage(S, data, view);
    const play = () => st.play(opts);
    view.addEventListener('click', play);
    play();
    window.SUMI_PLAYER = { layers: st.layers, play, get run() { return st.run; } };
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const scriptSafe = src => src.replace(/<\/(script)/gi, '<\\/$1'); // never close the <script> early

  S.standaloneHTML = (strokes, opts = {}) => {
    const { canvas, paper = PAPER, title = 'SUMI strokes', speed = 1, timing = 'recorded', gap = 150, stagger = 0 } = opts;
    checkPlayback({ speed, timing });
    const missing = CORE.filter(k => !(S.modules && typeof S.modules[k] === 'function'));
    if (missing.length) throw new Error('load js/' + missing.join('.js, js/') + '.js before exporting');
    const data = JSON.parse(S.recordingJSON(strokes, { canvas, paper }));
    const play = { speed: speed === Infinity ? null : speed, timing, gap, stagger }; // JSON has no Infinity
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
<p>${data.strokes.length} strokes · click to replay</p>
</main>
<script>
window.SUMI = window.SUMI || {};
${core}
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const PLAY = ${JSON.stringify(play)};
if (PLAY.speed === null) PLAY.speed = Infinity;
(${scriptSafe(sumiStandalone.toString())})(window.SUMI, ${scriptSafe(sumiStage.toString())}, DATA, PLAY);
</script>
</body>
</html>
`;
  };

  // real-time capture: plays the recording onto an offscreen stage and records it
  S.recordWebM = (strokes, opts = {}) => {
    const { canvas, paper = PAPER, speed = 1, timing = 'recorded', gap = 150, stagger = 0, fps = 30, hold = 600 } = opts;
    checkPlayback({ speed, timing });
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error('this browser cannot record canvas video');
    }
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error('this browser cannot encode WebM');
    const data = JSON.parse(S.recordingJSON(strokes, { canvas, paper }));
    const view = document.createElement('canvas');
    const stage = sumiStage(S, data, view);
    const rec = new MediaRecorder(view.captureStream(fps), { mimeType });
    const chunks = [];
    let cancelled = false;
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve, reject) => {
      rec.onstop = () => resolve(cancelled ? null : new Blob(chunks, { type: 'video/webm' }));
      rec.onerror = e => reject(e.error || new Error('video recording failed'));
    });
    stage.composite();
    rec.start(250);
    // frames come from a timer at the video's frame rate, not from screen refreshes, so the
    // video gets every frame even when the page isn't being drawn (hidden pane, throttled tab)
    const frame = cb => setTimeout(cb, 1000 / fps);
    const run = stage.play({ speed, timing, gap, stagger, frame });
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    run.done.then(() => setTimeout(stop, hold)); // hold the finished picture for a moment
    return { done, run, cancel() { cancelled = true; run.cancel(); stop(); } };
  };
})(window.SUMI);
