// Export a recording three ways:
//   SUMI.recordingJSON / SUMI.parseRecording   the strokes as a validated JSON document
//   SUMI.recordingGzip / SUMI.readRecording    the same, gzip-compressed (reads either kind back)
//   SUMI.standaloneHTML / standaloneHTMLGzip   one .html file that animates them, no other files;
//                                              the Gzip page carries the recording compressed
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

  // gzip via the browser's CompressionStream (Chrome 80+, Firefox 113+, Safari 16.4+)
  const gzip = text => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const gunzip = bytes => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  S.recordingJSON = (strokes, { canvas, paper = PAPER } = {}) => {
    strokes.forEach(checkStroke);
    S.ink.parseColor(paper);
    return JSON.stringify({ format: FORMAT, v: VERSION, canvas: canvasOf(strokes, canvas), paper, strokes });
  };

  // the recording as a gzip-compressed JSON document (a Blob for a .json.gz download)
  S.recordingGzip = async (strokes, opts = {}) =>
    new Blob([await gzip(S.recordingJSON(strokes, opts))], { type: 'application/gzip' });

  // reads a recording from JSON text, a parsed object, or the bytes of a .json or .json.gz file
  // (a Blob, ArrayBuffer or typed array; gzip is recognised by its first two bytes)
  S.readRecording = async input => {
    if (typeof input === 'string' || (input && !(input instanceof Blob) && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input))) {
      return S.parseRecording(input);
    }
    const buf = input instanceof Blob ? await input.arrayBuffer() : input;
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : new TextDecoder().decode(bytes);
    return S.parseRecording(text);
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

  // a compressed page's recording: base64 of the gzipped JSON, unpacked on open (inlined as source)
  async function sumiUnpack(packed) {
    const bin = atob(packed), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
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

  // what both kinds of page are built from (checks the options and strokes first)
  function playerParts(strokes, opts) {
    const { canvas, paper = PAPER, title = 'SUMI strokes', speed = 1, timing = 'recorded', gap = 150, stagger = 0 } = opts;
    checkPlayback({ speed, timing, gap, stagger });
    const missing = CORE.filter(k => !(S.modules && typeof S.modules[k] === 'function'));
    if (missing.length) throw new Error('load js/' + missing.join('.js, js/') + '.js before exporting');
    // the page inlines brushes.js only: brushes a host added at runtime aren't in it
    const custom = [...new Set(strokes.map(s => s && s.tool))].filter(t => !(S.BRUSH_NAMES || []).includes(t));
    if (custom.length) throw new TypeError('custom brushes can\'t go into a standalone HTML file: ' + custom.join(', '));
    const data = JSON.parse(S.recordingJSON(strokes, { canvas, paper }));
    // JSON has no Infinity; the player draws at most 12 ms per frame, so big recordings don't freeze it
    const play = { speed: speed === Infinity ? null : speed, timing, gap, stagger, budget: 12 };
    const shown = data.strokes.filter(s => S.brushes[s.tool].layer !== 'mask').length; // the player skips mask strokes
    const core = CORE.map(k => '(' + scriptSafe(S.modules[k].toString()) + ')(window.SUMI);').join('\n');
    return { data, play, shown, core, title };
  }
  // `boot` is the script that hands the recording to sumiStart and sets SUMI_PLAYER_READY
  function playerPage({ play, shown, core, title }, boot) {
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
${core}
const PLAY = ${jsonSafe(play)};
if (PLAY.speed === null) PLAY.speed = Infinity;
const sumiStart = DATA => {
  (${scriptSafe(sumiStandalone.toString())})(window.SUMI, ${scriptSafe(sumiStage.toString())}, DATA, PLAY);
  return window.SUMI_PLAYER;
};
${boot}
</script>
</body>
</html>
`;
  }

  S.standaloneHTML = (strokes, opts = {}) => {
    const parts = playerParts(strokes, opts);
    return playerPage(parts, `window.SUMI_PLAYER_READY = Promise.resolve(sumiStart(${jsonSafe(parts.data)}));`);
  };

  // the same page with the recording gzipped and base64-encoded inside; it unpacks on open
  S.standaloneHTMLGzip = async (strokes, opts = {}) => {
    const parts = playerParts(strokes, opts);
    const packed = toBase64(new Uint8Array(await (await gzip(JSON.stringify(parts.data))).arrayBuffer()));
    return playerPage(parts, `window.SUMI_PLAYER_READY = (${scriptSafe(sumiUnpack.toString())})(${JSON.stringify(packed)}).then(sumiStart, err => {
  document.querySelector('p').textContent = 'This browser cannot open this file: ' + err.message;
  throw err;
});`);
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

  // ---------- WebM rendered frame by frame (WebCodecs) ----------
  // A minimal WebM writer: the EBML header, then a Segment holding a SeekHead, Info (1 ms ticks
  // and the duration), one video track, Clusters of SimpleBlocks (a new one at each keyframe) and
  // Cues. It is built in memory, so every size is exact. IDs are from the EBML and Matroska specs.
  const ID = {
    EBML: [0x1A, 0x45, 0xDF, 0xA3], EBMLVersion: [0x42, 0x86], EBMLReadVersion: [0x42, 0xF7],
    EBMLMaxIDLength: [0x42, 0xF2], EBMLMaxSizeLength: [0x42, 0xF3], DocType: [0x42, 0x82],
    DocTypeVersion: [0x42, 0x87], DocTypeReadVersion: [0x42, 0x85],
    Segment: [0x18, 0x53, 0x80, 0x67], SeekHead: [0x11, 0x4D, 0x9B, 0x74], Seek: [0x4D, 0xBB],
    SeekID: [0x53, 0xAB], SeekPosition: [0x53, 0xAC],
    Info: [0x15, 0x49, 0xA9, 0x66], TimestampScale: [0x2A, 0xD7, 0xB1], Duration: [0x44, 0x89],
    MuxingApp: [0x4D, 0x80], WritingApp: [0x57, 0x41],
    Tracks: [0x16, 0x54, 0xAE, 0x6B], TrackEntry: [0xAE], TrackNumber: [0xD7], TrackUID: [0x73, 0xC5],
    TrackType: [0x83], FlagLacing: [0x9C], CodecID: [0x86], Video: [0xE0], PixelWidth: [0xB0], PixelHeight: [0xBA],
    Cluster: [0x1F, 0x43, 0xB6, 0x75], Timestamp: [0xE7], SimpleBlock: [0xA3],
    Cues: [0x1C, 0x53, 0xBB, 0x6B], CuePoint: [0xBB], CueTime: [0xB3], CueTrackPositions: [0xB7],
    CueTrack: [0xF7], CueClusterPosition: [0xF1],
  };
  const cat = parts => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const bigEndian = (n, len) => {
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); }
    return out;
  };
  // an element size as an EBML variable-length number, in its shortest form (all ones is reserved)
  const vsize = n => {
    let len = 1; while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
    const out = bigEndian(n, len); out[0] |= 1 << (8 - len);
    return out;
  };
  const el = (id, ...body) => { const data = cat(body); return cat([new Uint8Array(id), vsize(data.length), data]); };
  const uint = (id, n, len) => { if (len == null) { len = 1; while (len < 8 && n >= 2 ** (8 * len)) len++; } return el(id, bigEndian(n, len)); };
  const text = (id, s) => el(id, new TextEncoder().encode(s));
  const float64 = (id, x) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return el(id, b); };

  // frames: [{ t: ms, key, data: Uint8Array }] in order, starting with a keyframe
  function webmFile({ codecId, width, height, frames, duration }) {
    const header = el(ID.EBML, uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8), text(ID.DocType, 'webm'), uint(ID.DocTypeVersion, 4), uint(ID.DocTypeReadVersion, 2));
    const info = el(ID.Info, uint(ID.TimestampScale, 1e6), float64(ID.Duration, duration),
      text(ID.MuxingApp, 'SUMI'), text(ID.WritingApp, 'SUMI brushes'));
    const tracks = el(ID.Tracks, el(ID.TrackEntry, uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.TrackType, 1),
      uint(ID.FlagLacing, 0), text(ID.CodecID, codecId), el(ID.Video, uint(ID.PixelWidth, width), uint(ID.PixelHeight, height))));
    // a cluster per keyframe, or sooner if a block's 16-bit time offset would run out
    const clusters = [];
    let cur = null;
    for (const f of frames) {
      if (!cur || f.key || f.t - cur.t > 30000) { cur = { t: f.t, key: f.key, blocks: [] }; clusters.push(cur); }
      const rel = f.t - cur.t; // track 1, time offset, keyframe flag, then the frame
      cur.blocks.push(el(ID.SimpleBlock, new Uint8Array([0x81, (rel >> 8) & 0xff, rel & 0xff, f.key ? 0x80 : 0]), f.data));
    }
    const clusterBytes = clusters.map(c => el(ID.Cluster, uint(ID.Timestamp, c.t), ...c.blocks));
    // positions are counted from the start of the Segment's data; the SeekHead stores them as
    // 8-byte numbers, so its own size is known before they are
    const seekHead = positions => el(ID.SeekHead, ...[ID.Info, ID.Tracks, ID.Cues].map((id, i) =>
      el(ID.Seek, el(ID.SeekID, new Uint8Array(id)), uint(ID.SeekPosition, positions[i], 8))));
    const infoAt = seekHead([0, 0, 0]).length, tracksAt = infoAt + info.length;
    let at = tracksAt + tracks.length;
    const cuePoints = [];
    clusters.forEach((c, i) => {
      if (c.key) cuePoints.push(el(ID.CuePoint, uint(ID.CueTime, c.t), el(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, at))));
      at += clusterBytes[i].length;
    });
    const segment = el(ID.Segment, seekHead([infoAt, tracksAt, at]), info, tracks, ...clusterBytes, el(ID.Cues, ...cuePoints));
    return new Blob([header, segment], { type: 'video/webm' });
  }

  // VP9, else VP8, at this size (the VP9 level covers sizes up to 4K)
  async function encoderConfig(width, height, fps) {
    const bitrate = Math.round(Math.min(8e6, Math.max(1e6, width * height * fps * 0.08)));
    for (const [codec, codecId] of [['vp09.00.50.08', 'V_VP9'], ['vp8', 'V_VP8']]) {
      const config = { codec, width, height, bitrate, framerate: fps };
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, codecId }; } catch { /* next codec */ }
    }
    return null;
  }
  const nextTask = () => new Promise(r => setTimeout(r, 0));

  S.canRenderWebM = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';

  // A video of the replay, drawn and encoded frame by frame with WebCodecs: each frame shows the
  // picture at exactly its time, so the video is smooth however fast this device draws, and it is
  // usually done faster than real time. Returns { done, cancel, stage, duration }: done resolves
  // to the Blob (duration is then its length in ms), or to null after cancel(). It rejects with
  // err.code 'no-encoder' when the browser can't encode VP9 or VP8; recordWebM is the fallback.
  S.renderWebM = (strokes, opts = {}) => {
    const { canvas, paper = PAPER, speed = 1, timing = 'recorded', gap = 150, stagger = 0, fps = 30, hold = 600, onProgress } = opts;
    checkPlayback({ speed, timing, gap, stagger });
    if (!finite(fps) || fps <= 0 || fps > 120) throw new TypeError('fps must be a number in (0, 120]');
    if (!finite(hold) || hold < 0) throw new TypeError('hold must be a number ≥ 0');
    if (!S.canRenderWebM()) throw Object.assign(new Error('this browser cannot encode video frame by frame'), { code: 'no-encoder' });
    const data = JSON.parse(S.recordingJSON(strokes, { canvas, paper }));
    const view = document.createElement('canvas');
    const stage = sumiStage(S, data, view);
    let cancelled = false;
    const job = { stage, duration: 0, cancel() { cancelled = true; } };
    job.done = (async () => {
      const chosen = await encoderConfig(view.width, view.height, fps);
      if (!chosen) throw Object.assign(new Error('this browser has no WebM video encoder (VP9 or VP8)'), { code: 'no-encoder' });
      const frames = [];
      let failure = null, wake = null;
      const woken = () => new Promise(r => { wake = r; }); // the encoder took a frame, or failed
      const enc = new VideoEncoder({
        output: chunk => {
          const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
          frames.push({ t: Math.round(chunk.timestamp / 1000), key: chunk.type === 'key', data: bytes });
        },
        error: e => { failure = e; if (wake) wake(); },
      });
      enc.addEventListener('dequeue', () => { if (wake) wake(); });
      enc.configure(chosen.config);
      const step = 1000 / fps, keyEvery = Math.max(1, Math.round(fps * 2));
      let n = 0;
      const encodeFrame = async () => {
        const frame = new VideoFrame(view, { timestamp: Math.round(n * step * 1000) });
        enc.encode(frame, { keyFrame: n % keyEvery === 0 });
        frame.close();
        n++;
        while (enc.encodeQueueSize > 3 && !failure) await woken(); // let the encoder catch up
        if (n % 8 === 0) await nextTask();
      };
      // the replay runs on a clock that moves exactly one frame per step
      let now = 0;
      const ticks = [];
      const run = stage.play({ speed, timing, gap, stagger, clock: () => now, frame: cb => ticks.push(cb) });
      const length = run.timeline.duration / speed;
      try {
        await encodeFrame(); // the opening frame
        while (ticks.length && !cancelled && !failure) {
          now += step;
          ticks.shift()(); // applies every call due by now and redraws what they painted
          await encodeFrame();
          if (onProgress) onProgress(Math.min(1, now / Math.max(length, step)));
        }
        for (let i = Math.round(hold / step); i > 0 && !cancelled && !failure; i--) await encodeFrame(); // hold the finished picture
        if (cancelled || failure) run.cancel(); // its frames stop coming, so don't wait for it
        if (cancelled) return null;
        if (failure) throw failure;
        await run.done; // rejects if a brush threw
        await enc.flush();
        if (failure) throw failure;
      } finally {
        if (enc.state !== 'closed') enc.close();
      }
      if (onProgress) onProgress(1);
      job.duration = n * step;
      return webmFile({ codecId: chosen.codecId, width: view.width, height: view.height, frames, duration: job.duration });
    })();
    return job;
  };
})(window.SUMI);
