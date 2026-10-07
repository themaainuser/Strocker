// SUMI CONSOLE — UI shell around the layered ink engine in js/. No libraries, canvas2d only.
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { alpha: false });
const grainCanvas = document.getElementById('grain');
const gtx = grainCanvas.getContext('2d');
const cursor = document.getElementById('cursor');
const codeOut = document.getElementById('codeOut');
const logEl = document.getElementById('log');
const toast = document.getElementById('toast');
const $ = id => document.getElementById(id);

const TOOLS = ['dry', 'spray', 'fine', 'lines', 'wash', 'shard', 'mask'];
const ALL_LAYERS = [...SUMI.LAYER_NAMES, 'mask'];
const UNDO_LIMIT = 15;
const UNDO_BYTES = 256 * 1024 * 1024; // undo snapshots are full-size canvases: cap their memory too
const newSeed = () => Math.random().toString(36).slice(2, 8);

const S = { ...SUMI.defaultOpts(), tool: 'dry', wind: -35, seed: newSeed(), grain: 60, paper: true };

let layers = null;
let drawing = false, activeId = null, pen = null, last = null, lastW = 0, lastT = 0, smoothV = 0;
let preview = null; // speed-line rubber band
let undoStack = [], undoBudget = UNDO_BYTES;
let strokes = []; // every hand stroke still on the canvas, as replayable records (js/recorder.js)
// what the strokes sit on that isn't recorded: the last generated poster / filled mask
// (a snapshot of wash, scene, ink, fx). Replay paints the strokes on top of it.
let base = null;
const sessionStart = performance.now();
let run = null, busy = false; // run.kind is 'generate' or 'replay'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const windRad = () => S.wind * Math.PI / 180;
const strokeOpts = () => ({ size: S.size, opacity: S.opacity, dryness: S.dryness, splatter: S.splatter, bleed: S.bleed, taper: S.taper, color: S.color });

// ---------- feedback ----------
function toastMsg(m) {
  toast.textContent = m;
  toast.classList.add('show');
  clearTimeout(toastMsg.t);
  toastMsg.t = setTimeout(() => toast.classList.remove('show'), 1600);
}
function log(head, rest = '') {
  const d = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = head;
  d.append(b, rest ? ' · ' + rest : '');
  logEl.prepend(d);
  while (logEl.children.length > 40) logEl.lastChild.remove();
}
// the export panel shows the real recording: the last stroke exactly as stored
const strokeSize = new WeakMap(); // a stroke's JSON length, measured once (records don't change after end)
const sizeOf = s => { let n = strokeSize.get(s); if (n === undefined) { n = JSON.stringify(s).length + 1; strokeSize.set(s, n); } return n; };
function refreshExport() {
  const n = strokes.length, last = strokes[n - 1];
  const kb = n ? (strokes.reduce((t, s) => t + sizeOf(s), 1) / 1024).toFixed(1) + ' KB' : '';
  $('recCount').textContent = (n === 1 ? '1 stroke · ' + kb : n + ' strokes' + (n ? ' · ' + kb : '')) +
    (base ? ' · poster not exported' : ''); // Replay keeps the poster; exports hold the strokes only
  $('btnExportJSON').disabled = $('btnExportHTML').disabled = !n;
  // while a video records, the button is its Stop button
  $('btnExportWebM').disabled = videoJob ? false : !n || !CAN_RECORD_VIDEO;
  $('btnExportWebM').textContent = videoJob ? '■ stop video' : '↓ WebM';
  if (!n) {
    codeOut.textContent = '// paint something: every stroke is recorded\n// export it as JSON, a standalone HTML file or WebM';
    return;
  }
  const shown = { ...last, segs: `[${last.segs.length} × [ax, ay, bx, by, w, dir, speed, alpha, t, n]]` };
  codeOut.textContent = '// last stroke, exactly as recorded (segments elided)\n' + JSON.stringify(shown) +
    '\n\n// replay a recording anywhere (rng.js + brushes.js + recorder.js + playback.js):\n' +
    'SUMI.replay(ctx, SUMI.parseRecording(json).strokes, { speed: 1 })';
}

// ---------- canvas setup ----------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(r.width), h = Math.floor(r.height);
  if (w < 1 || h < 1) return;
  if (layers && w === layers.w && h === layers.h && dpr === layers.dpr) return; // nothing changed
  canvas.width = w * dpr; canvas.height = h * dpr;
  grainCanvas.width = w * dpr; grainCanvas.height = h * dpr;
  gtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (layers) layers.resize(w, h, dpr);
  else layers = SUMI.createLayers(w, h, dpr);
  layers.markDirty();
  renderGrain();
}

// paper tooth on its own overlay: mottling + speckles + fibres (seeded, so it never flickers)
function renderGrain() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!S.paper || S.grain <= 0 || w === 0) { grainCanvas.style.display = 'none'; return; }
  grainCanvas.style.display = 'block';
  gtx.clearRect(0, 0, w, h);
  const rng = SUMI.makeRng('paper'), k = S.grain / 100;
  for (let i = 0; i < 12 + k * 14; i++) {
    const x = rng.range(0, w), y = rng.range(0, h), r = rng.range(60, 220);
    const g = gtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(120,112,95,${0.03 + k * 0.06})`);
    g.addColorStop(1, 'rgba(120,112,95,0)');
    gtx.fillStyle = g;
    gtx.beginPath(); gtx.arc(x, y, r, 0, 7); gtx.fill();
  }
  const n = Math.floor(w * h / 240 * (0.3 + k));
  for (let i = 0; i < n; i++) {
    const s = rng.chance(0.06) ? rng.range(1.4, 2.8) : rng.range(0.5, 1.8);
    gtx.fillStyle = `rgba(60,55,45,${rng.range(0.04, 0.10 + k * 0.12)})`;
    gtx.fillRect(rng.range(0, w), rng.range(0, h), s, s * rng.range(0.6, 1));
  }
  gtx.lineWidth = 0.7;
  const fibres = Math.floor(40 + k * 130);
  for (let i = 0; i < fibres; i++) {
    const x = rng.range(0, w), y = rng.range(0, h), a = rng.range(0, Math.PI), l = rng.range(20, 150);
    gtx.strokeStyle = `rgba(70,65,55,${rng.range(0.05, 0.08 + k * 0.13)})`;
    gtx.beginPath(); gtx.moveTo(x, y);
    gtx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); gtx.stroke();
  }
}

function renderNow() {
  layers.composite(ctx, { showMask: S.tool === 'mask', preview });
}

// ---------- undo ----------
// an undo entry restores the pixels, the recording and the replay base together
const snapBytes = snap => Object.values(snap).reduce((n, c) => n + c.width * c.height * 4, 0);
const undoBytes = () => undoStack.reduce((n, e) => n + e.bytes, 0);
function trimUndo() {
  while (undoStack.length > UNDO_LIMIT || (undoStack.length > 1 && undoBytes() > undoBudget)) undoStack.shift();
}
function pushEntry(snap) {
  undoStack.push({ snap, strokes: strokes.slice(), base, bytes: snapBytes(snap) });
  trimUndo();
}
const pushUndo = names => pushEntry(layers.snapshot(names));
function undo() {
  if (drawing) abortStroke(); // the top entry is this stroke's own: popping it cancels the stroke
  else cancelRun();
  const entry = undoStack.pop();
  if (!entry) return toastMsg('nothing to undo');
  layers.restore(entry.snap);
  strokes = entry.strokes;
  base = entry.base;
  refreshButtons();
  toastMsg('undo');
}
// every action that changes the canvas first ends the active stroke and settles any run,
// so the recording and the canvas can't drift apart
function settle() { endStroke(); cancelRun(); }

// ---------- painting ----------
function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function cursorSize(w) {
  const big = S.tool === 'wash' || S.tool === 'spray' || S.tool === 'shard' || S.tool === 'mask';
  cursor.style.width = cursor.style.height = (big ? w : Math.max(10, w * 0.45)) + 'px';
}
function strokeTo(p) {
  const now = performance.now();
  const dt = now - lastT || 16;
  const dist = Math.hypot(p.x - last.x, p.y - last.y);
  // speed-reactive core: smoothed px/ms so width and ink glide instead of jitter
  smoothV += (dist / Math.max(dt, 1) - smoothV) * 0.35;
  const sn = Math.min(smoothV / 1.6, 1); // 0 = slow, 1 = fast flick
  const react = S.taper;
  const target = Math.max(1.5, S.size * (1 - react * 0.8 * sn));
  const w = lastW + (target - lastW) * 0.4;
  const steps = Math.max(1, Math.floor(dist / 2.5));
  const dir = Math.atan2(p.y - last.y, p.x - last.x);
  const tool = pen.stroke.tool; // the stroke's own tool, even if a hotkey switched tools mid-stroke
  const alpha = tool === 'mask' ? 1 : 1 - react * 0.45 * sn; // fast = lighter ink
  for (let i = 1; i <= steps; i++) {
    const t0 = (i - 1) / steps, t1 = i / steps;
    const a = { x: last.x + (p.x - last.x) * t0, y: last.y + (p.y - last.y) * t0 };
    const b = { x: last.x + (p.x - last.x) * t1, y: last.y + (p.y - last.y) * t1 };
    pen.segment(a, b, lastW + (w - lastW) * t1, dir, { speed: sn, alpha });
  }
  if (tool === 'lines') {
    const p0 = pen.stroke.p0, e = SUMI.ink.snapEnd(p0, p, windRad());
    preview = c => {
      c.strokeStyle = 'rgba(17,19,24,0.6)'; c.lineWidth = 1; c.setLineDash([6, 5]);
      c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(e.x, e.y); c.stroke(); c.setLineDash([]);
    };
  }
  cursorSize(w);
  last = p; lastW = w; lastT = now;
  layers.markDirty(SUMI.brushes[tool].layer);
}

// one stroke at a time, from one pointer: extra fingers, other buttons and stray events are
// ignored, and every way a stroke can stop (release, cancel, lost capture, blur, a mouse
// released outside the window) ends it the same way, so it is always recorded
canvas.addEventListener('pointerdown', e => {
  if (busy || !layers || drawing || e.button !== 0) return;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers can't be captured */ }
  const layer = SUMI.brushes[S.tool].layer;
  pushUndo([layer]);
  const p = pos(e);
  last = p; lastW = S.size; lastT = performance.now(); smoothV = 0;
  // the pen draws and records the exact calls, including the seed, so the stroke can be replayed
  pen = SUMI.recordStroke(layers.get(layer).ctx, {
    tool: S.tool, seed: Math.random(), opts: strokeOpts(), wind: windRad(), erase: e.altKey, p0: p,
    origin: sessionStart, canvas: { w: layers.w, h: layers.h, dpr: layers.dpr },
  });
  drawing = true; // only once the pen exists, so a failed start can't break every later move
  activeId = e.pointerId;
  pen.dab({ alpha: 1 });
  layers.markDirty(layer);
});
canvas.addEventListener('pointermove', e => {
  const p = pos(e);
  cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px';
  if (!drawing) { cursorSize(S.size); return; }
  if (e.pointerId !== activeId) return;
  if (e.pointerType === 'mouse' && e.buttons === 0) { endStroke(); return; } // released outside the window
  strokeTo(p);
});
const endIfActive = e => { if (drawing && e.pointerId === activeId) endStroke(); };
addEventListener('pointerup', endIfActive);
addEventListener('pointercancel', endIfActive);
canvas.addEventListener('lostpointercapture', endIfActive);
addEventListener('blur', () => endStroke());

function endStroke() {
  if (!drawing) return;
  drawing = false; activeId = null;
  const stroke = pen.end({ alpha: 1 });
  strokes.push(stroke);
  pen = null;
  preview = null;
  layers.markDirty(SUMI.brushes[stroke.tool].layer);
  refreshButtons(); // replay button follows the recording; fill-mask follows the mask
  log(stroke.tool, `${stroke.opts.size}px · ${stroke.opts.color}`);
}
// drop the active stroke without recording it (its undo entry restores the pixels)
function abortStroke() {
  drawing = false; activeId = null; pen = null; preview = null;
}

// ---------- generator ----------
function setBusy(b) {
  busy = b;
  const generating = b && run && run.kind === 'generate';
  $('btnGenerate').textContent = generating ? '■ Cancel' : '✦ Generate';
  $('btnGenerate').disabled = b && !generating; // during a replay, Replay's own button is the Stop
  $('btnReroll').disabled = b;
  refreshButtons();
}
// bookkeeping when a run stops, however it stops (finished, cancelled, failed); runs once
function afterRun(r) {
  if (r.settled) return;
  r.settled = true;
  if (r.kind === 'generate') base = layers.snapshot(SUMI.LAYER_NAMES); // the poster as far as it got
  layers.markDirty();
}
function cancelRun() {
  if (!run) return;
  const r = run;
  run = null;
  try {
    if (r.finish) r.finish(); else r.cancel(); // an interrupted replay completes, so the canvas matches the recording
  } finally {
    afterRun(r);
    setBusy(false);
  }
}
function startRun(r, kind, onDone) {
  r.kind = kind;
  run = r;
  setBusy(true);
  r.done.then(result => {
    if (run !== r) return; // a newer run (or a cancel) owns the state now
    run = null;
    afterRun(r);
    setBusy(false);
    onDone(result);
  }, err => {
    if (run === r) run = null;
    afterRun(r);
    setBusy(false);
    toastMsg(kind + ' failed: ' + (err && err.message));
  });
  return r;
}
function generate({ animate = true } = {}) {
  settle();
  pushUndo(SUMI.LAYER_NAMES);
  // the poster replaces everything but the mask, right away, so the canvas and the
  // recording agree even if the run is cancelled before its first frame
  strokes = strokes.filter(s => SUMI.brushes[s.tool].layer === 'mask');
  layers.clear(SUMI.LAYER_NAMES);
  base = null;
  S.seed = $('seedInput').value.trim() || newSeed();
  $('seedInput').value = S.seed;
  log('generate', `seed "${S.seed}" · wind ${S.wind}°`);
  const r = SUMI.generate({
    layers, seed: S.seed, wind: windRad(), inkEdge: $('chkInkEdge').checked, animate,
    onLog: m => log(m.split('(')[0], m.slice(m.indexOf('(') + 1, -1)),
  });
  return startRun(r, 'generate', () => toastMsg('poster ready — seed ' + S.seed));
}
const playbackShape = timing => (timing === 'sequence' ? { timing, gap: 150 } : timing === 'overlap' ? { timing, stagger: 0 } : { timing });

// repaint the recorded strokes, animated (js/playback.js), on top of the generated poster /
// filled mask if there is one; undoable
function replay({ speed = +$('replaySpeed').value, timing = $('replayTiming').value } = {}) {
  if (!strokes.length) { toastMsg('nothing recorded yet'); return null; }
  settle();
  pushUndo(ALL_LAYERS);
  layers.clear(ALL_LAYERS);
  if (base) layers.restore(base);
  const recs = strokes.slice();
  log('replay', `${recs.length} strokes · ${speed}× · ${timing}`);
  const r = SUMI.replay(s => layers.get(SUMI.brushes[s.tool].layer).ctx, recs,
    { ...playbackShape(timing), speed, onFrame: () => layers.markDirty() });
  return startRun(r, 'replay', completed => { if (completed) toastMsg('replay done'); });
}
function fillMask() {
  settle();
  if (layers.isMaskEmpty()) return toastMsg('paint a mask first (key 7)');
  const before = layers.snapshot(['scene']);
  const g = SUMI.fillMask({ layers, seed: $('seedInput').value.trim() || S.seed });
  if (!g) return toastMsg('the mask is too small or faint to fill — paint a bigger one');
  pushEntry(before);
  base = { ...(base || {}), ...layers.snapshot(['scene']) }; // Replay keeps the filled scene
  refreshButtons();
  log('scene.fill', `towers ${g.bridge.towers.length} · pylons ${g.pylons.length}`);
}
function clearMask() {
  settle();
  pushUndo(['mask']);
  layers.clear(['mask']);
  strokes = strokes.filter(s => SUMI.brushes[s.tool].layer !== 'mask');
  refreshButtons();
}
let maskSeen = -1, maskEmpty = true;
function maskIsEmpty() {
  const v = layers.version('mask');
  if (v !== maskSeen) { maskSeen = v; maskEmpty = layers.isMaskEmpty(); }
  return maskEmpty;
}
function refreshButtons() {
  if (!layers) return;
  refreshExport();
  $('btnFillMask').disabled = busy || maskIsEmpty();
  // while busy the replay button is the Stop button, so it stays enabled
  $('btnReplay').textContent = busy && run && run.finish ? '■ Stop' : '▶ Replay';
  $('btnReplay').disabled = busy ? !(run && run.finish) : !strokes.length;
}

// ---------- UI ----------
function setTool(name) {
  if (!TOOLS.includes(name)) return;
  S.tool = name;
  document.querySelectorAll('#brushGrid button').forEach(b => b.classList.toggle('active', b.dataset.brush === name));
  cursor.classList.toggle('mask', name === 'mask');
  if (layers) layers.dirty = true; // recomposite: the mask tint follows the tool
}
document.querySelectorAll('#brushGrid button').forEach(b => b.onclick = () => {
  setTool(b.dataset.brush);
  toastMsg(b.textContent.trim());
});
document.querySelectorAll('#swatches button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#swatches button').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); S.color = b.dataset.color;
  $('inkColor').value = S.color; $('inkHex').textContent = S.color;
});
$('inkColor').oninput = e => { S.color = e.target.value; $('inkHex').textContent = S.color; };

$('s-size').oninput = e => { S.size = +e.target.value; updateLabels(); };
$('s-opacity').oninput = e => { S.opacity = +e.target.value / 100; updateLabels(); };
$('s-dry').oninput = e => { S.dryness = +e.target.value / 100; updateLabels(); };
$('s-splat').oninput = e => { S.splatter = +e.target.value; updateLabels(); };
$('s-bleed').oninput = e => { S.bleed = +e.target.value; updateLabels(); };
$('s-taper').oninput = e => { S.taper = +e.target.value / 100; updateLabels(); };
$('s-grain').oninput = e => { S.grain = +e.target.value; updateLabels(); renderGrain(); };
$('s-wind').oninput = e => { S.wind = +e.target.value; updateLabels(); };
function updateLabels() {
  $('v-size').textContent = S.size;
  $('v-opacity').textContent = S.opacity.toFixed(2);
  $('v-dry').textContent = S.dryness.toFixed(2);
  $('v-splat').textContent = S.splatter;
  $('v-bleed').textContent = S.bleed;
  $('v-taper').textContent = S.taper.toFixed(2);
  $('v-grain').textContent = S.grain;
  $('v-wind').textContent = S.wind + '°';
}

$('btnGenerate').onclick = () => {
  if (busy && run && run.kind === 'generate') { cancelRun(); toastMsg('cancelled'); }
  else if (!busy) generate();
};
$('btnReroll').onclick = () => { $('seedInput').value = newSeed(); generate(); };
$('seedInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !busy) generate(); });
$('btnFillMask').onclick = fillMask;
$('btnReplay').onclick = () => { if (busy) cancelRun(); else replay(); };
$('btnClearMask').onclick = clearMask;
$('btnPaper').onclick = e => {
  S.paper = !S.paper;
  e.target.classList.toggle('on', S.paper);
  e.target.textContent = 'Paper grain: ' + (S.paper ? 'on' : 'off');
  renderGrain();
};
$('btnUndo').onclick = undo;
$('btnClear').onclick = () => {
  settle();
  pushUndo(ALL_LAYERS);
  layers.clear(ALL_LAYERS);
  strokes = [];
  base = null;
  refreshButtons();
  toastMsg('cleared');
};
// ---------- export (js/export.js) ----------
// WebM needs canvas capture + a WebM encoder (Safari records MP4 only, so it gets a disabled button)
const CAN_RECORD_VIDEO = typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream &&
  ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].some(t => MediaRecorder.isTypeSupported(t));
let videoJob = null;
const fileName = ext => `sumi-${S.seed}-${Date.now()}.${ext}`;
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// one coordinate space for all strokes: big enough for every stroke's canvas, first stroke's dpr
function exportCanvas() {
  return {
    w: Math.max(...strokes.map(s => s.canvas.w)), h: Math.max(...strokes.map(s => s.canvas.h)),
    dpr: strokes[0].canvas.dpr,
  };
}
const exportPlayback = () => ({ speed: +$('replaySpeed').value, ...playbackShape($('replayTiming').value) });
function exportJSON() { return SUMI.recordingJSON(strokes, { canvas: exportCanvas() }); }
function exportHTML() {
  return SUMI.standaloneHTML(strokes, { canvas: exportCanvas(), title: 'SUMI strokes · ' + S.seed, ...exportPlayback() });
}
function exportWebM(extra = {}) {
  if (!strokes.length || videoJob || !CAN_RECORD_VIDEO) return null;
  let job;
  try {
    job = SUMI.recordWebM(strokes.slice(), { canvas: exportCanvas(), ...exportPlayback(), ...extra });
  } catch (err) {
    toastMsg('video export failed: ' + err.message);
    return null;
  }
  videoJob = job;
  refreshExport();
  toastMsg('recording video in real time…');
  job.done
    .then(blob => { if (blob) { download(blob, fileName('webm')); log('export', 'WebM · ' + (blob.size / 1024).toFixed(0) + ' KB'); } },
      err => toastMsg('video failed: ' + err.message))
    .finally(() => {
      if (videoJob === job) videoJob = null;
      refreshExport();
    });
  return job;
}
$('btnExportJSON').onclick = () => {
  const json = exportJSON();
  download(new Blob([json], { type: 'application/json' }), fileName('json'));
  log('export', 'JSON · ' + strokes.length + ' strokes');
};
$('btnExportHTML').onclick = () => {
  download(new Blob([exportHTML()], { type: 'text/html' }), fileName('html'));
  log('export', 'HTML player · ' + strokes.length + ' strokes');
};
$('btnExportWebM').onclick = () => {
  if (videoJob) { videoJob.cancel(); toastMsg('video stopped'); } else exportWebM();
};
if (!CAN_RECORD_VIDEO) $('btnExportWebM').title = 'this browser cannot record canvas video';

$('btnSave').onclick = () => {
  const out = layers.exportCanvas(S.paper && S.grain > 0 ? grainCanvas : null, 'ECLIPSE');
  const a = document.createElement('a');
  a.download = `sumi-${S.seed}-${Date.now()}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
};

addEventListener('keydown', e => {
  const t = e.target;
  const typing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
    (t.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(t.type)));
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return; // browser / OS shortcuts (Ctrl+1 switches tabs)
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= TOOLS.length) setTool(TOOLS[n - 1]);
  if (e.key === '[') { S.size = clamp(S.size - 6, 2, 140); $('s-size').value = S.size; updateLabels(); }
  if (e.key === ']') { S.size = clamp(S.size + 6, 2, 140); $('s-size').value = S.size; updateLabels(); }
});

// ---------- render loop + fps ----------
let frames = 0, lastF = performance.now();
(function loop(t) {
  frames++;
  if (t - lastF > 1000) { $('fps').textContent = frames + ' fps'; frames = 0; lastF = t; }
  if (layers && layers.dirty) renderNow();
  requestAnimationFrame(loop);
})(performance.now());

addEventListener('resize', resize);
$('seedInput').value = S.seed;
updateLabels(); resize(); refreshButtons();

SUMI.app = {
  S,
  get layers() { return layers; },
  get busy() { return busy; },
  setTool, generate, replay, cancel: cancelRun, undo, fillMask, clearMask, renderNow,
  exportJSON, exportHTML, exportWebM,
  undoDepth: () => undoStack.length,
  undoBytes,
  setUndoBudget(bytes) { undoBudget = bytes; trimUndo(); },
  strokes: () => strokes.slice(),
};
