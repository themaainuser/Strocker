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
const newSeed = () => Math.random().toString(36).slice(2, 8);

const S = { ...SUMI.defaultOpts(), tool: 'dry', wind: -35, seed: newSeed(), grain: 60, paper: true };

let layers = null;
let drawing = false, brush = null, st = null, last = null, lastW = 0, lastT = 0, smoothV = 0;
let preview = null; // speed-line rubber band
let undoStack = [];
let run = null, busy = false;

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
function refreshCode(x = 0, y = 0) {
  codeOut.textContent =
`brush.${S.tool}({
  x: ${Math.round(x)}, y: ${Math.round(y)}, v: ${smoothV.toFixed(2)}px/ms,
  size: ${S.size}, opacity: ${S.opacity},
  dryness: ${S.dryness}, splatter: ${S.splatter},
  bleed: ${S.bleed}, taper: ${S.taper},
  ink: '${S.color}', wind: ${S.wind}°
});`;
}

// ---------- canvas setup ----------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(r.width), h = Math.floor(r.height);
  if (w < 1 || h < 1) return;
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
function pushUndo(names) {
  undoStack.push(layers.snapshot(names));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}
function undo() {
  const snap = undoStack.pop();
  if (!snap) return toastMsg('nothing to undo');
  cancelRun();
  layers.restore(snap);
  refreshMaskButtons();
  toastMsg('undo');
}

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
  st.speed = sn;
  st.alpha = S.tool === 'mask' ? 1 : 1 - react * 0.45 * sn; // fast = lighter ink
  for (let i = 1; i <= steps; i++) {
    const t0 = (i - 1) / steps, t1 = i / steps;
    const a = { x: last.x + (p.x - last.x) * t0, y: last.y + (p.y - last.y) * t0 };
    const b = { x: last.x + (p.x - last.x) * t1, y: last.y + (p.y - last.y) * t1 };
    brush.segment(st, a, b, lastW + (w - lastW) * t1, dir);
  }
  st.alpha = 1; // dab and end draw at full strength
  if (S.tool === 'lines') {
    const p0 = st.p0, e = SUMI.ink.snapEnd(p0, p, windRad());
    preview = c => {
      c.strokeStyle = 'rgba(17,19,24,0.6)'; c.lineWidth = 1; c.setLineDash([6, 5]);
      c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(e.x, e.y); c.stroke(); c.setLineDash([]);
    };
  }
  cursorSize(w);
  last = p; lastW = w; lastT = now;
  layers.markDirty();
  refreshCode(p.x, p.y);
}

canvas.addEventListener('pointerdown', e => {
  if (busy || !layers) return;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers can't be captured */ }
  brush = SUMI.brushes[S.tool];
  pushUndo([brush.layer]);
  st = SUMI.makeStroke(layers.get(brush.layer).ctx, Math.random(), strokeOpts(), windRad());
  st.erase = e.altKey;
  drawing = true;
  const p = pos(e);
  last = p; lastW = S.size; lastT = performance.now(); smoothV = 0;
  brush.start(st, p);
  brush.dab(st, p);
  layers.markDirty();
  refreshCode(p.x, p.y);
});
canvas.addEventListener('pointermove', e => {
  const p = pos(e);
  cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px';
  if (!drawing) { cursorSize(S.size); refreshCode(p.x, p.y); return; }
  strokeTo(p);
});
addEventListener('pointerup', () => {
  if (!drawing) return;
  drawing = false;
  brush.end(st);
  preview = null;
  layers.markDirty();
  if (S.tool === 'mask') refreshMaskButtons();
  log(S.tool, `${S.size}px · ${S.color}`);
});

// ---------- generator ----------
function setBusy(b) {
  busy = b;
  $('btnGenerate').textContent = b ? '■ Cancel' : '✦ Generate';
  $('btnReroll').disabled = b;
  refreshMaskButtons();
}
function cancelRun() {
  if (!run) return;
  const r = run;
  run = null;
  r.cancel();
  setBusy(false);
}
function generate({ animate = true } = {}) {
  cancelRun();
  pushUndo(SUMI.LAYER_NAMES);
  S.seed = $('seedInput').value.trim() || newSeed();
  $('seedInput').value = S.seed;
  setBusy(true);
  log('generate', `seed "${S.seed}" · wind ${S.wind}°`);
  const r = SUMI.generate({
    layers, seed: S.seed, wind: windRad(), inkEdge: $('chkInkEdge').checked, animate,
    onLog: m => log(m.split('(')[0], m.slice(m.indexOf('(') + 1, -1)),
  });
  run = r;
  r.done.then(() => {
    if (run !== r) return; // a newer run (or a cancel) owns the state now
    run = null;
    setBusy(false);
    layers.markDirty();
    toastMsg('poster ready — seed ' + S.seed);
  });
  return r;
}
function fillMask() {
  if (busy) return;
  if (layers.isMaskEmpty()) return toastMsg('paint a mask first (key 7)');
  pushUndo(['scene']);
  const g = SUMI.fillMask({ layers, seed: $('seedInput').value.trim() || S.seed });
  log('scene.fill', `towers ${g.bridge.towers.length} · pylons ${g.pylons.length}`);
}
function clearMask() {
  pushUndo(['mask']);
  layers.clear(['mask']);
  refreshMaskButtons();
}
function refreshMaskButtons() {
  if (!layers) return;
  $('btnFillMask').disabled = busy || layers.isMaskEmpty();
}

// ---------- UI ----------
function setTool(name) {
  if (!TOOLS.includes(name)) return;
  S.tool = name;
  document.querySelectorAll('#brushGrid button').forEach(b => b.classList.toggle('active', b.dataset.brush === name));
  cursor.classList.toggle('mask', name === 'mask');
  if (layers) layers.markDirty(); // mask tint follows the tool
  refreshCode();
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
  if (busy) { cancelRun(); toastMsg('cancelled'); } else generate();
};
$('btnReroll').onclick = () => { $('seedInput').value = newSeed(); generate(); };
$('seedInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !busy) generate(); });
$('btnFillMask').onclick = fillMask;
$('btnClearMask').onclick = clearMask;
$('btnPaper').onclick = e => {
  S.paper = !S.paper;
  e.target.classList.toggle('on', S.paper);
  e.target.textContent = 'Paper grain: ' + (S.paper ? 'on' : 'off');
  renderGrain();
};
$('btnUndo').onclick = undo;
$('btnClear').onclick = () => {
  cancelRun();
  pushUndo(ALL_LAYERS);
  layers.clear(ALL_LAYERS);
  refreshMaskButtons();
  toastMsg('cleared');
};
$('btnSave').onclick = () => {
  const out = layers.exportCanvas(S.paper && S.grain > 0 ? grainCanvas : null, 'ECLIPSE');
  const a = document.createElement('a');
  a.download = `sumi-${S.seed}-${Date.now()}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
};

addEventListener('keydown', e => {
  const t = e.target;
  const typing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' ||
    (t.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(t.type)));
  if (typing) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= TOOLS.length) setTool(TOOLS[n - 1]);
  if (e.key === '[') { S.size = clamp(S.size - 6, 2, 140); $('s-size').value = S.size; updateLabels(); }
  if (e.key === ']') { S.size = clamp(S.size + 6, 2, 140); $('s-size').value = S.size; updateLabels(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
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
updateLabels(); refreshCode(); resize(); refreshMaskButtons();

SUMI.app = {
  S,
  get layers() { return layers; },
  get busy() { return busy; },
  setTool, generate, cancel: cancelRun, undo, fillMask, clearMask, renderNow,
  undoDepth: () => undoStack.length,
};
