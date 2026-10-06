// SUMI test harness — dependency-free. Tests register at parse time and run on load.
// Loaded before js/*.js so load errors in the engine are reported as failures.
(function () {
  const tests = [];
  const loadErrors = [];
  addEventListener('error', e => loadErrors.push(e.message || String(e)));

  class Skip extends Error {}
  const fmt = v => (typeof v === 'string' ? JSON.stringify(v) : String(v));
  const fail = msg => { throw new Error(msg); };
  const label = msg => (msg ? msg + ': ' : '');

  const T = {
    test(name, fn) { tests.push({ name, fn }); },
    assert(cond, msg = 'assertion failed') { if (!cond) fail(msg); },
    eq(actual, expected, msg) {
      if (actual !== expected) fail(`${label(msg)}expected ${fmt(expected)}, got ${fmt(actual)}`);
    },
    near(actual, expected, tol, msg) {
      if (!(Math.abs(actual - expected) <= tol)) fail(`${label(msg)}expected ${expected} ± ${tol}, got ${actual}`);
    },
    skip(reason) { throw new Skip(reason); },

    canvas(w, h) {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      return { canvas, ctx: canvas.getContext('2d') };
    },
    pixels(canvas) {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return { w: canvas.width, h: canvas.height, data };
    },
    alpha(px, x, y) {
      x = Math.floor(x); y = Math.floor(y);
      if (x < 0 || y < 0 || x >= px.w || y >= px.h) return 0;
      return px.data[(y * px.w + x) * 4 + 3];
    },
    rgb(px, x, y) {
      const i = (Math.floor(y) * px.w + Math.floor(x)) * 4;
      return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
    },
    inkCount(px, x0, y0, x1, y1) {
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(px.w, Math.floor(x1)); y1 = Math.min(px.h, Math.floor(y1));
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (px.data[(y * px.w + x) * 4 + 3] > 0) n++;
      return n;
    },
    centroid(px) {
      let sx = 0, sy = 0, s = 0;
      for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) {
        const a = px.data[(y * px.w + x) * 4 + 3];
        sx += a * x; sy += a * y; s += a;
      }
      return s ? { x: sx / s, y: sy / s } : { x: NaN, y: NaN };
    },
    hash(canvas) { // FNV-1a over the RGBA bytes
      const d = T.pixels(canvas).data;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(16).padStart(8, '0');
    },
  };
  window.T = T;

  const TIMEOUT = 15000;
  async function runAll() {
    const results = loadErrors.map(m => ({ name: 'load error', status: 'fail', msg: m }));
    for (const { name, fn } of tests) {
      try {
        let timer;
        await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after ' + TIMEOUT + 'ms')), TIMEOUT); }),
        ]).finally(() => clearTimeout(timer));
        results.push({ name, status: 'pass', msg: '' });
      } catch (e) {
        results.push(e instanceof Skip
          ? { name, status: 'skip', msg: e.message }
          : { name, status: 'fail', msg: e && e.message ? e.message : String(e) });
      }
    }
    render(results);
  }

  function render(results) {
    const ul = document.getElementById('results');
    for (const r of results) {
      const li = document.createElement('li');
      li.className = r.status;
      li.textContent = r.msg ? `${r.name} — ${r.msg}` : r.name;
      ul.appendChild(li);
    }
    const count = s => results.filter(r => r.status === s).length;
    const p = count('pass'), f = count('fail'), s = count('skip');
    const sum = document.getElementById('summary');
    sum.setAttribute('data-passed', p);
    sum.setAttribute('data-failed', f);
    sum.setAttribute('data-skipped', s);
    sum.textContent = `${p} passed, ${f} failed, ${s} skipped`;
  }

  addEventListener('load', runAll);
})();
