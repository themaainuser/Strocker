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

// spray/wash quality starts at Balanced: close to Full at about half the drawing time
const S = { ...SUMI.defaultOpts(), ...SUMI.QUALITY.balanced, tool: 'dry', wind: -35, seed: newSeed(), grain: 60, paper: true };
const QUALITY_KEYS = Object.keys(SUMI.QUALITY.full);

let layers = null;
let drawing = false, activeId = null, pen = null;
let preview = null, previewBox = null; // speed-line rubber band and the box it covers on the board
let undoStack = [], undoBudget = UNDO_BYTES;
let strokes = []; // every hand stroke still on the canvas, as replayable records (js/recorder.js)
// what the strokes sit on that isn't recorded: the last generated poster / filled mask
// (a snapshot of wash, scene, ink, fx). Replay paints the strokes on top of it.
let base = null;
const sessionStart = performance.now();
let run = null, busy = false; // run.kind is 'generate' or 'replay'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const windRad = () => S.wind * Math.PI / 180;
const strokeOpts = () => ({
  size: S.size, opacity: S.opacity, dryness: S.dryness, splatter: S.splatter, bleed: S.bleed, taper: S.taper, color: S.color,
  ...Object.fromEntries(QUALITY_KEYS.map(k => [k, S[k]])),
});

// ---------- feedback ----------
// { warn: true } shows the pop-up as an alert, like the cost warning: amber icon and title
function toastMsg(m, { warn = false } = {}) {
  toast.classList.toggle('alert', warn);
  toast.classList.toggle('warn', warn);
  if (warn) {
    const title = document.createElement('div');
    title.className = 'alert-title'; title.textContent = m;
    toast.replaceChildren(document.querySelector('#costWarn .alert-icon').cloneNode(true), title);
  } else toast.textContent = m;
  toast.classList.add('show');
  clearTimeout(toastMsg.t);
  toastMsg.t = setTimeout(() => toast.classList.remove('show'), warn ? 3200 : 1600); // warnings stay longer
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
  const shown = last.moves ? { ...last, moves: `[${last.moves.length} × [x, y, t]]` }
    : { ...last, segs: `[${last.segs.length} × [ax, ay, bx, by, w, dir, speed, alpha, t, n]]` };
  codeOut.textContent = '// last stroke, exactly as recorded (rows elided)\n' + JSON.stringify(shown) +
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
  scheduleCost(); // the cost depends on the pixel density
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
// the pen turns each pointer move into brush calls (speed thins and lightens the stroke, see
// SUMI.penDynamics in recorder.js) and records just the move, so the stroke stays small
function strokeTo(p) {
  const tool = pen.stroke.tool; // the stroke's own tool, even if a hotkey switched tools mid-stroke
  const moved = pen.move(p);
  if (!moved) return;
  layers.markArea(pen.takeDirty(), SUMI.brushes[tool].layer); // only the box the brush painted is redrawn
  if (tool === 'lines') {
    const p0 = pen.stroke.p0, e = SUMI.ink.snapEnd(p0, moved.p, windRad());
    preview = c => {
      c.strokeStyle = 'rgba(17,19,24,0.6)'; c.lineWidth = 1; c.setLineDash([6, 5]);
      c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(e.x, e.y); c.stroke(); c.setLineDash([]);
    };
    clearPreview(); // the old line's box, so it's erased
    previewBox = { x0: Math.min(p0.x, e.x) - 2, y0: Math.min(p0.y, e.y) - 2, x1: Math.max(p0.x, e.x) + 2, y1: Math.max(p0.y, e.y) + 2 };
    layers.markArea(previewBox);
  }
  cursorSize(moved.w);
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
  // the pen draws and records the input, including the seed, so the stroke can be replayed
  pen = SUMI.recordStroke(layers.get(layer).ctx, {
    tool: S.tool, seed: Math.random(), opts: strokeOpts(), wind: windRad(), erase: e.altKey, p0: p,
    origin: sessionStart, canvas: { w: layers.w, h: layers.h, dpr: layers.dpr },
  });
  drawing = true; // only once the pen exists, so a failed start can't break every later move
  activeId = e.pointerId;
  pen.dab({ alpha: 1 });
  layers.markArea(pen.takeDirty(), layer);
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
  layers.markArea(pen.takeDirty(), SUMI.brushes[stroke.tool].layer);
  strokes.push(stroke);
  pen = null;
  preview = null;
  clearPreview();
  refreshButtons(); // replay button follows the recording; fill-mask follows the mask
  log(stroke.tool, `${stroke.opts.size}px · ${stroke.opts.color}`);
}
// drop the active stroke without recording it (its undo entry restores the pixels)
function abortStroke() {
  drawing = false; activeId = null; pen = null; preview = null; previewBox = null; // undo redraws everything
}
// redraw the board under the rubber-band line so it disappears
function clearPreview() {
  if (previewBox) layers.markArea(previewBox);
  previewBox = null;
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
    { ...playbackShape(timing), speed, onFrame: tl => layers.markArea(tl.takeDirty(), ...ALL_LAYERS) });
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
  scheduleCost();
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
  for (const k of QUALITY_KEYS) $('v-' + k).textContent = QUALITY_UI[k].label(S[k]);
  const preset = Object.keys(SUMI.QUALITY).find(name => QUALITY_KEYS.every(k => SUMI.QUALITY[name][k] === S[k]));
  document.querySelectorAll('#qualityPresets button').forEach(b => b.classList.toggle('on', b.dataset.preset === preset));
  $('qualityName').textContent = preset || 'custom';
  scheduleCost();
}

// ---------- spray & wash quality ----------
// slider value <-> option value, and how each option reads in its label
const QUALITY_UI = {
  sprayDensity: { opt: v => v / 100, slider: o => Math.round(o * 100), label: o => Math.round(o * 100) + '%' },
  sprayGap: { opt: v => v, slider: o => o, label: o => (o ? o + ' px' : 'every step') },
  washLayers: { opt: v => v, slider: o => o, label: o => String(o) },
  washDetail: { opt: v => v, slider: o => o, label: o => 'max ' + 10 * 2 ** o },
  washEdge: { opt: v => v / 100, slider: o => Math.round(o * 100), label: o => Math.round(S.washLayers * o) + ' of ' + S.washLayers },
};
for (const k of QUALITY_KEYS) {
  $('s-' + k).oninput = e => { S[k] = QUALITY_UI[k].opt(+e.target.value); updateLabels(); };
}
function setQuality(name) {
  const Q = SUMI.QUALITY[name];
  if (!Q) return;
  for (const k of QUALITY_KEYS) { S[k] = Q[k]; $('s-' + k).value = QUALITY_UI[k].slider(Q[k]); }
  updateLabels();
}
document.querySelectorAll('#qualityPresets button').forEach(b => b.onclick = () => setQuality(b.dataset.preset));

// Brush cost meter: times the current brush and settings on a scratch canvas at the board's pixel
// density, per 12 px of painting (about one pointer move), so the warning reflects this device.
const COST = { light: 4, heavy: 8 }; // ms; a 60 fps frame is 16.7 ms and the board needs some of it
let costTimer = 0, lastCostLevel = 'light';
function scheduleCost() {
  clearTimeout(costTimer);
  costTimer = setTimeout(() => (drawing || busy ? scheduleCost() : measureCost()), 300);
}
function brushCost(tool, opts, dpr) {
  const w = 360, h = 160, c = document.createElement('canvas');
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const st = SUMI.makeStroke(x, 'cost', opts, windRad()), b = SUMI.brushes[tool];
  let p = { x: 20, y: h / 2 };
  b.start(st, p);
  const move = () => { // four 3 px steps, like strokeTo, then a read like the area redraw's
    for (let i = 0; i < 4; i++) {
      const q = { x: p.x + 3, y: h / 2 + Math.sin(p.x / 30) * 10 };
      st.speed = 0.2; b.segment(st, p, q, opts.size, Math.atan2(q.y - p.y, q.x - p.x)); p = q;
    }
    x.getImageData(0, 0, 1, 1);
  };
  for (let i = 0; i < 3; i++) move(); // warm-up
  const rounds = [];
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 6; i++) move();
    rounds.push((performance.now() - t0) / 6);
  }
  return rounds.sort((a, b) => a - b)[1]; // median
}
const costLevel = ms => (ms >= COST.heavy ? 'heavy' : ms >= COST.light ? 'moderate' : 'light');
const COST_ADVICE = {
  spray: 'Try lower density, wider spacing, a smaller size, or Balanced or Fast.',
  wash: 'Try fewer layers or edge lines, less edge detail, a smaller size, or Balanced or Fast.',
};
function showCost(ms, tool = S.tool) {
  const level = costLevel(ms), meter = $('costMeter'), warn = $('costWarn');
  meter.className = 'meter ' + level;
  meter.textContent = `${tool} · ${ms.toFixed(1)} ms`;
  warn.hidden = level !== 'heavy';
  $('costWarnText').textContent = level === 'heavy'
    ? `${tool[0].toUpperCase() + tool.slice(1)} takes about ${ms.toFixed(1)} ms per move on this device. ` +
      (COST_ADVICE[tool] || 'Try a smaller size or less splatter.')
    : '';
  if (level === 'heavy' && lastCostLevel !== 'heavy') toastMsg('Heavy brush settings: painting may stutter', { warn: true });
  lastCostLevel = level;
  return { ms, level, tool };
}
// measures now (the meter calls this after settings settle); resolves to { ms, level, tool }
function measureCost() {
  clearTimeout(costTimer);
  const tool = S.tool;
  return Promise.resolve(showCost(brushCost(tool, strokeOpts(), layers ? layers.dpr : 1), tool));
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
// a Promise: the page carries the recording gzip-compressed and unpacks it on open
function exportHTML() {
  return SUMI.standaloneHTMLGzip(strokes, { canvas: exportCanvas(), title: 'SUMI strokes · ' + S.seed, ...exportPlayback() });
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
const sizeLabel = bytes => (bytes / 1024).toFixed(1) + ' KB';
$('btnExportJSON').onclick = async () => {
  try {
    const blob = await SUMI.recordingGzip(strokes, { canvas: exportCanvas() }); // read back with SUMI.readRecording
    download(blob, fileName('json.gz'));
    log('export', `JSON · ${strokes.length} strokes · ${sizeLabel(blob.size)} gzipped`);
  } catch (err) { toastMsg('export failed: ' + err.message); }
};
$('btnExportHTML').onclick = async () => {
  try {
    const html = await exportHTML();
    download(new Blob([html], { type: 'text/html' }), fileName('html'));
    log('export', `HTML player · ${strokes.length} strokes · ${sizeLabel(html.length)}`);
  } catch (err) { toastMsg('export failed: ' + err.message); }
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
  setTool, setQuality, generate, replay, cancel: cancelRun, undo, fillMask, clearMask, renderNow,
  measureCost, showCost, COST,
  exportJSON, exportHTML, exportWebM,
  undoDepth: () => undoStack.length,
  undoBytes,
  setUndoBudget(bytes) { undoBudget = bytes; trimUndo(); },
  strokes: () => strokes.slice(),
};
