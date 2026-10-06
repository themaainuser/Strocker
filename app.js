// SUMI CONSOLE — 100% vanilla JS, canvas2d only. No libraries.
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { alpha: false });
const grainCanvas = document.getElementById('grain');
const gtx = grainCanvas.getContext('2d');
const cursor = document.getElementById('cursor');
const codeOut = document.getElementById('codeOut');
const logEl = document.getElementById('log');
const toast = document.getElementById('toast');

const S = {
  brush: 'sumi',
  color: '#111318',
  size: 34,
  opacity: 0.85,
  dryness: 0.55,
  splatter: 40,
  bleed: 35,
  taper: 0.65,
  grain: 60,
  paper: true,
};

let drawing = false, last = null, lastW = 0, lastT = 0, shardDist = 0;
let smoothV = 0, velA = 1, velDry = 0; // speed-reactive state: smoothed px/ms, ink multiplier, dryness boost
let undoStack = [];
const PAPER = '#f4f1ea';

// ---------- utils ----------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hexRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function toastMsg(m) {
  toast.textContent = m;
  toast.classList.add('show');
  clearTimeout(toastMsg.t);
  toastMsg.t = setTimeout(() => toast.classList.remove('show'), 1600);
}
function log(brush, extra = '') {
  const d = document.createElement('div');
  d.innerHTML = `<b>${brush}</b> · ${S.size}px · ${S.color} ${extra}`;
  logEl.prepend(d);
  while (logEl.children.length > 30) logEl.lastChild.remove();
}
function refreshCode(x = 0, y = 0) {
  codeOut.textContent =
`brush.${S.brush}({
  x: ${Math.round(x)}, y: ${Math.round(y)}, v: ${smoothV.toFixed(2)}px/ms,
  size: ${S.size}, opacity: ${S.opacity},
  dryness: ${S.dryness}, splatter: ${S.splatter},
  bleed: ${S.bleed}, taper: ${S.taper},
  grain: ${S.grain}, ink: '${S.color}'
});`;
}

// ---------- canvas setup ----------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(r.width), h = Math.floor(r.height);
  const old = undoStack.length ? snapshot() : null;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  grainCanvas.width = w * dpr; grainCanvas.height = h * dpr;
  gtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (old) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, w, h); img.src = old; }
  else paintPaper();
  renderGrain();
}
function paintPaper() {
  // flat base only — texture lives on the #grain overlay so the
  // Grain bar is always visible and never gets painted over
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}
// visible paper tooth on its own layer: speckles + fibres + soft mottling
function renderGrain() {
  // measure the board, not the overlay: after "off" the overlay has
  // display:none so its clientWidth is 0 and grain could never come back
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!S.paper || S.grain <= 0 || w === 0) { grainCanvas.style.display = 'none'; return; }
  grainCanvas.style.display = 'block';
  // re-sync backing store in case the window resized while hidden
  if (grainCanvas.width !== canvas.width || grainCanvas.height !== canvas.height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    grainCanvas.width = Math.floor(w * dpr); grainCanvas.height = Math.floor(h * dpr);
    gtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  gtx.clearRect(0, 0, w, h);
  const k = S.grain / 100; // 0..1 intensity from the Grain bar
  // soft uneven tone so 60–100 is clearly visible
  for (let i = 0; i < 12 + k * 14; i++) {
    const x = rand(0, w), y = rand(0, h), r = rand(60, 220);
    const g = gtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(120,112,95,${0.03 + k * 0.06})`);
    g.addColorStop(1, 'rgba(120,112,95,0)');
    gtx.fillStyle = g;
    gtx.beginPath(); gtx.arc(x, y, r, 0, 7); gtx.fill();
  }
  // speckle
  const n = Math.floor(w * h / 240 * (0.3 + k));
  for (let i = 0; i < n; i++) {
    const big = Math.random() < 0.06;
    const s = big ? rand(1.4, 2.8) : rand(0.5, 1.8);
    gtx.fillStyle = `rgba(60,55,45,${rand(0.04, 0.10 + k * 0.12)})`;
    gtx.fillRect(rand(0, w), rand(0, h), s, s * rand(0.6, 1));
  }
  // fibres — the faint scratchy lines in your reference, now visible
  gtx.lineWidth = 0.7;
  const fibres = Math.floor(40 + k * 130);
  for (let i = 0; i < fibres; i++) {
    const x = rand(0, w), y = rand(0, h), a = rand(0, Math.PI), l = rand(20, 150);
    gtx.strokeStyle = `rgba(70,65,55,${rand(0.05, 0.08 + k * 0.13)})`;
    gtx.beginPath(); gtx.moveTo(x, y);
    gtx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); gtx.stroke();
  }
}
function snapshot() { return canvas.toDataURL(); }
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 20) undoStack.shift();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return toastMsg('nothing to undo');
  const img = new Image();
  img.onload = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.save(); ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h); ctx.restore();
  };
  img.src = s;
  toastMsg('undo');
}

// ---------- BRUSHES (the whole point) ----------

// 1. DRY BRUSH — many bristle sub-strokes with gaps (bottom black slashes in ref)
function sumiSeg(x0, y0, x1, y1, w) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 0.1;
  const nx = -dy / len, ny = dx / len;
  const bleed01 = S.bleed / 100;
  // bleed = soft ink soaking under the bristles (global slider)
  if (bleed01 > 0.02) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(S.color, S.opacity * 0.14 * bleed01);
    ctx.lineWidth = w * (0.45 + bleed01 * 0.9);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  const bristles = clamp(Math.floor(w / 2.1), 5, 44);
  ctx.lineCap = 'round';
  for (let i = 0; i < bristles; i++) {
    const t = (Math.random() + Math.random() - 1) * w * 0.5; // denser centre
    const edge = Math.abs(t) / (w * 0.5);
    const dry = Math.min(0.95, S.dryness + velDry); // fast strokes break up more
    if (Math.random() < dry * (0.25 + edge * 0.75)) continue; // the "dry" gap
    const j0 = rand(-1.5, 1.5), j1 = rand(-1.5, 1.5);
    ctx.strokeStyle = rgba(S.color, S.opacity * rand(0.25, 0.9));
    ctx.lineWidth = rand(0.6, 1.9) * (0.6 + w / 38);
    ctx.beginPath();
    ctx.moveTo(x0 + nx * t + j0, y0 + ny * t + j0);
    ctx.lineTo(x1 + nx * t + j1, y1 + ny * t + j1);
    ctx.stroke();
  }
  // occasional flyaway hair
  if (Math.random() < 0.25) {
    const t = rand(-w / 2, w / 2);
    ctx.strokeStyle = rgba(S.color, S.opacity * 0.35);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x0 + nx * t, y0 + ny * t);
    ctx.lineTo(x1 + nx * t + rand(-14, 14), y1 + ny * t + rand(-14, 14));
    ctx.stroke();
  }
  // splatter trail
  if (S.splatter > 0 && Math.random() < S.splatter / 160) {
    burst(x1, y1, w * 0.35, S.splatter / 100);
  }
}

// 2. SPLATTER — ink dots + satellites (the spray around the figure)
// amt comes from the Splatter slider; bleed controls droplet softness (halo)
function burst(x, y, radius, amt = 0.4, color = S.color) {
  const bleed01 = S.bleed / 100;
  const count = Math.floor(4 + amt * 46);
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2);
    const d = Math.pow(Math.random(), 1.7) * radius * 2.2;
    const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
    const r = Math.pow(Math.random(), 2.4) * (radius * 0.28) + 0.4;
    // bleed halo — high bleed = soft soaked dot, low bleed = hard dot
    if (bleed01 > 0.05 && r > 1.6 && (i % 2 === 0)) {
      const hr = r * (2 + bleed01 * 3.5);
      const g = ctx.createRadialGradient(px, py, 0, px, py, hr);
      g.addColorStop(0, rgba(color, S.opacity * 0.16 * bleed01));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, hr, 0, 7); ctx.fill();
    }
    ctx.fillStyle = rgba(color, S.opacity * rand(0.35, 0.95));
    ctx.beginPath();
    ctx.ellipse(px, py, r * rand(0.7, 1.6), r * rand(0.6, 1.2), rand(0, 3), 0, 7);
    ctx.fill();
  }
  // 2–3 big blot cores
  if (amt > 0.25) {
    for (let i = 0; i < 3; i++) {
      if (Math.random() > amt) continue;
      const px = x + rand(-radius * 0.4, radius * 0.4), py = y + rand(-radius * 0.4, radius * 0.4);
      ctx.fillStyle = rgba(color, S.opacity * rand(0.5, 0.85));
      ctx.beginPath();
      ctx.ellipse(px, py, rand(2, radius * 0.22 + 2), rand(1, radius * 0.16 + 1), rand(0, 3), 0, 7);
      ctx.fill();
    }
  }
}

// 3. SCRATCH — long thin wobbly line (the fine construction lines in ref)
// bleed widens/softens it, splatter sprays specks off it
function scratchSeg(x0, y0, x1, y1) {
  const bleed01 = S.bleed / 100;
  // soft bleed ghost under the line
  if (bleed01 > 0.05) {
    ctx.strokeStyle = rgba(S.color, S.opacity * 0.10 * bleed01);
    ctx.lineWidth = 2 + bleed01 * 6;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.strokeStyle = rgba(S.color, S.opacity * 0.55);
  ctx.lineWidth = rand(0.5, 1.1) + bleed01 * 1.4;
  const mx = (x0 + x1) / 2 + rand(-3, 3), my = (y0 + y1) / 2 + rand(-3, 3);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, my, x1, y1); ctx.stroke();
  if (Math.random() < 0.3) { // faint echo
    ctx.strokeStyle = rgba(S.color, S.opacity * 0.18);
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(x0 + rand(-6, 6), y0 + rand(-6, 6));
    ctx.lineTo(x1 + rand(-6, 6), y1 + rand(-6, 6)); ctx.stroke();
  }
  // splatter slider throws specks off the scratch
  if (S.splatter > 0 && Math.random() < S.splatter / 500) {
    burst(x1, y1, 5 + S.splatter * 0.25, (S.splatter / 100) * 0.6);
  }
}

// 4. WASH — soft bleeding grey-blue cloud (kimono / river mist in ref)
function washDot(x, y, size) {
  const bleed = 0.4 + S.bleed / 100 * 1.4;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const blobs = 16;
  for (let i = 0; i < blobs; i++) {
    const r = size * rand(0.25, 0.62) * bleed;
    const ox = rand(-size * 0.25, size * 0.25) * bleed;
    const oy = rand(-size * 0.25, size * 0.25) * bleed;
    const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
    const a = S.opacity * rand(0.04, 0.10);
    g.addColorStop(0, rgba(S.color, a));
    g.addColorStop(0.75, rgba(S.color, a * 0.55));
    g.addColorStop(1, rgba(S.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, 7); ctx.fill();
  }
  // darker uneven edge = bleed ring
  ctx.strokeStyle = rgba(S.color, S.opacity * (0.08 + S.bleed / 100 * 0.14));
  ctx.lineWidth = rand(1, 2.4);
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.ellipse(x + rand(-4, 4), y + rand(-4, 4),
      size * rand(0.4, 0.6) * bleed, size * rand(0.3, 0.5) * bleed,
      rand(0, 3), rand(0, 3), rand(3.5, 6.5));
    ctx.stroke();
  }
  ctx.restore();
  if (S.splatter > 0 && Math.random() < 0.05 + (S.splatter / 100) * 0.2) {
    burst(x, y, size * 0.5, 0.1 + (S.splatter / 100) * 0.6);
  }
}

// 5. SHARD — torn-paper fragment (white chips flying in ref)
// bleed = ink soaking around the torn edge, splatter = spray around it,
// taper/size comes through the w passed in (velocity-thinned, see strokeTo)
function shard(x, y, size) {
  const bleed01 = S.bleed / 100;
  const n = 3 + Math.floor(Math.random() * 3);
  const r = size * rand(0.25, 0.6);
  const rot = rand(0, Math.PI * 2);
  const path = new Path2D();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2 + rand(-0.4, 0.4);
    const rr = r * rand(0.5, 1.15);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i ? path.lineTo(px, py) : path.moveTo(px, py);
  }
  path.closePath();
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.shadowColor = rgba(S.color, 0.18 + bleed01 * 0.3);
  ctx.shadowBlur = 4 + bleed01 * 16;
  ctx.shadowOffsetY = 1;
  ctx.fill(path);
  ctx.shadowColor = 'transparent';
  // bleed halo: wide soft ink ring first…
  if (bleed01 > 0.02) {
    ctx.strokeStyle = rgba(S.color, S.opacity * 0.22 * bleed01);
    ctx.lineWidth = 1 + bleed01 * 10;
    ctx.stroke(path);
  }
  // …then the crisp torn edge
  ctx.strokeStyle = rgba(S.color, S.opacity * 0.8);
  ctx.lineWidth = 1;
  ctx.stroke(path);
  ctx.restore();
  // splatter slider sprays ink around the shard
  if (S.splatter > 0 && Math.random() < 0.3 + (S.splatter / 100) * 0.55) {
    burst(x, y, size * 0.45, (S.splatter / 100) * 0.9);
  }
}

// ---------- stroke routing ----------
function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function strokeTo(p) {
  const now = performance.now();
  const dt = now - lastT || 16;
  const dist = Math.hypot(p.x - last.x, p.y - last.y);
  // ---- speed-reactive core: smooth raw px/ms so width/ink glide, not jitter
  const raw = dist / Math.max(dt, 1);
  smoothV += (raw - smoothV) * 0.35;
  const sn = Math.min(smoothV / 1.6, 1); // 0 = slow/hand still, 1 = fast flick
  const react = S.taper; // Taper slider = speed-reaction strength, every brush (0 = off)
  const target = Math.max(1.5, S.size * (1 - react * 0.8 * sn)); // fast = thin
  const w = lastW + (target - lastW) * 0.4;
  velA = 1 - react * 0.45 * sn;   // fast = lighter ink
  velDry = react * 0.35 * sn;     // fast dry-brush = more breakup
  const steps = Math.max(1, Math.floor(dist / 2.5));
  const wStart = lastW;

  ctx.globalAlpha = velA;
  for (let i = 1; i <= steps; i++) {
    const t0 = (i - 1) / steps, t1 = i / steps;
    const ax = last.x + (p.x - last.x) * t0, ay = last.y + (p.y - last.y) * t0;
    const bx = last.x + (p.x - last.x) * t1, by = last.y + (p.y - last.y) * t1;
    const wi = wStart + (w - wStart) * t1; // glide width along the segment
    if (S.brush === 'sumi') sumiSeg(ax, ay, bx, by, wi);
    else if (S.brush === 'scratch') scratchSeg(ax, ay, bx, by);
    else if (S.brush === 'wash') washDot(bx, by, wi * 0.55);
    else if (S.brush === 'splatter') burst(bx, by, wi * 0.5, 0.08 + (S.splatter / 100) * 0.9);
  }
  ctx.globalAlpha = 1;
  // live cursor mirrors live width, so you see the reaction under your hand
  const cd = (S.brush === 'wash' || S.brush === 'splatter' || S.brush === 'shard') ? w : Math.max(10, w * 0.45);
  cursor.style.width = cursor.style.height = cd + 'px';
  // shard = stamped along the path, spaced by size — so it follows the pointer
  if (S.brush === 'shard') {
    shardDist += dist;
    const spacing = clamp(S.size * 0.7, 18, 80);
    ctx.globalAlpha = velA;
    while (shardDist >= spacing) {
      const t = 1 - (shardDist - spacing) / Math.max(dist, 0.1);
      const sx = last.x + (p.x - last.x) * clamp(t, 0, 1);
      const sy = last.y + (p.y - last.y) * clamp(t, 0, 1);
      shard(sx, sy, w);
      shardDist -= spacing;
    }
    // slow/small moves: still drop one so it never feels dead
    if (dist < spacing && dist > 2 && shardDist > 8) {
      shard(p.x + rand(-4, 4), p.y + rand(-4, 4), w);
      shardDist = 0;
    }
    ctx.globalAlpha = 1;
  }
  last = p; lastW = w; lastT = now;
  refreshCode(p.x, p.y);
}
function dab(p) { // single click
  if (S.brush === 'splatter') burst(p.x, p.y, S.size * 0.7, 0.1 + (S.splatter / 100) * 0.9);
  else if (S.brush === 'wash') washDot(p.x, p.y, S.size * 0.7);
  else if (S.brush === 'shard') shard(p.x, p.y, S.size);
  else if (S.brush === 'sumi') { sumiSeg(p.x - 3, p.y, p.x + 3, p.y, S.size * 0.6); if (S.splatter > 0) burst(p.x, p.y, S.size * 0.3, (S.splatter / 100) * 0.8); }
  else scratchSeg(p.x - S.size, p.y - S.size * 0.5, p.x + S.size, p.y + S.size * 0.5);
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pushUndo();
  drawing = true;
  const p = pos(e);
  last = p; lastW = S.size; lastT = performance.now(); shardDist = 0;
  smoothV = 0; velA = 1; velDry = 0; ctx.globalAlpha = 1;
  dab(p); refreshCode(p.x, p.y);
});
canvas.addEventListener('pointermove', e => {
  const p = pos(e);
  cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px';
  const d = (S.brush === 'wash' || S.brush === 'splatter' || S.brush === 'shard') ? S.size : Math.max(14, S.size * 0.4);
  cursor.style.width = cursor.style.height = d + 'px';
  if (!drawing) { refreshCode(p.x, p.y); return; }
  strokeTo(p);
});
addEventListener('pointerup', () => {
  ctx.globalAlpha = 1;
  if (drawing) { drawing = false; log(S.brush); }
});

// ---------- UI ----------
const $ = id => document.getElementById(id);
document.querySelectorAll('#brushGrid button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#brushGrid button').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); S.brush = b.dataset.brush;
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
function updateLabels() {
  $('v-size').textContent = S.size;
  $('v-opacity').textContent = S.opacity.toFixed(2);
  $('v-dry').textContent = S.dryness.toFixed(2);
  $('v-splat').textContent = S.splatter;
  $('v-bleed').textContent = S.bleed;
  $('v-taper').textContent = S.taper.toFixed(2);
  $('v-grain').textContent = S.grain;
}
$('btnPaper').onclick = e => {
  S.paper = !S.paper;
  e.target.classList.toggle('on', S.paper);
  e.target.textContent = 'Paper grain: ' + (S.paper ? 'on' : 'off');
  renderGrain();
};
$('btnUndo').onclick = undo;
$('btnClear').onclick = () => { pushUndo(); paintPaper(); toastMsg('cleared'); };
$('btnSave').onclick = () => {
  // composite paint + grain so the PNG keeps the paper texture
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const octx = out.getContext('2d');
  octx.drawImage(canvas, 0, 0);
  if (S.paper && S.grain > 0) octx.drawImage(grainCanvas, 0, 0);
  const a = document.createElement('a');
  a.download = 'sumi-' + Date.now() + '.png';
  a.href = out.toDataURL('image/png'); a.click();
};
addEventListener('keydown', e => {
  const map = { 1: 'sumi', 2: 'splatter', 3: 'scratch', 4: 'wash', 5: 'shard' };
  if (map[e.key]) document.querySelector(`[data-brush="${map[e.key]}"]`).click();
  if (e.key === '[') { S.size = clamp(S.size - 6, 2, 140); $('s-size').value = S.size; updateLabels(); }
  if (e.key === ']') { S.size = clamp(S.size + 6, 2, 140); $('s-size').value = S.size; updateLabels(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
});

// ---------- demo: paints an eclipse-like burst ----------
$('btnDemo').onclick = async () => {
  pushUndo();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const cx = w * 0.55, cy = h * 0.55;
  toastMsg('painting demo…');
  const keep = { ...S };
  // washes first
  S.brush = 'wash'; S.color = '#5a6d7e'; S.opacity = 0.9; S.bleed = 70;
  for (let i = 0; i < 26; i++) {
    washDot(cx + rand(-90, 90), cy + rand(-130, 130), rand(40, 90));
    await new Promise(r => setTimeout(r, 24));
  }
  // big dry slashes
  S.brush = 'sumi'; S.color = '#111318'; S.opacity = 0.9; S.dryness = 0.6; S.size = 64;
  const slashes = [
    [cx - 200, cy + 220, cx + 160, cy - 40],
    [cx - 160, cy + 260, cx + 200, cy + 10],
    [cx - 60, cy + 240, cx + 120, cy + 120],
  ];
  for (const [x0, y0, x1, y1] of slashes) {
    for (let t = 0; t <= 1; t += 0.04) {
      const ax = x0 + (x1 - x0) * t, ay = y0 + (y1 - y0) * t;
      const bx = x0 + (x1 - x0) * (t + 0.04), by = y0 + (y1 - y0) * (t + 0.04);
      sumiSeg(ax, ay, bx, by, 64 * Math.sin(Math.PI * t) + 8);
      await new Promise(r => setTimeout(r, 12));
    }
  }
  // splatter field
  S.brush = 'splatter'; S.splatter = 80;
  for (let i = 0; i < 22; i++) {
    burst(cx + rand(-220, 220), cy + rand(-220, 220), rand(15, 55), rand(0.3, 0.9));
    await new Promise(r => setTimeout(r, 24));
  }
  // scratches
  S.brush = 'scratch'; S.opacity = 0.6;
  for (let i = 0; i < 18; i++) {
    const x = cx + rand(-260, 260), y = cy + rand(-260, 260);
    scratchSeg(x, y, x + rand(-160, 160), y + rand(-160, 160));
    await new Promise(r => setTimeout(r, 20));
  }
  // shards
  S.brush = 'shard'; S.size = 40;
  for (let i = 0; i < 10; i++) {
    shard(cx + rand(-240, 240), cy + rand(-240, 240), rand(20, 50));
    await new Promise(r => setTimeout(r, 30));
  }
  Object.assign(S, keep); updateLabels();
  $('inkColor').value = S.color;
  log('demo', '· eclipse burst');
  toastMsg('demo done — paint over it');
};

// ---------- fps ----------
let frames = 0, lastF = performance.now();
(function loop(t) {
  frames++;
  if (t - lastF > 1000) {
    document.getElementById('fps').textContent = frames + ' fps';
    frames = 0; lastF = t;
  }
  requestAnimationFrame(loop);
})(performance.now());

addEventListener('resize', resize);
updateLabels(); refreshCode(); resize();
