// The drop-in example (examples/minimal.html): draws, saves and reopens a drawing with only
// dist/sumi-brushes.mjs, driven in an iframe the way a person would use it.
(() => {
  function loadExample() {
    return new Promise((res, rej) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-3000px;top:0;width:1000px;height:760px';
      f.src = 'examples/minimal.html';
      f.onload = () => {
        try { const w = f.contentWindow; res({ w, ex: w.sumiExample, doc: w.document }); }
        catch (e) { e.name === 'SecurityError' ? res(null) : rej(e); }
      };
      document.body.appendChild(f);
    });
  }
  // a plain browser on file:// blocks the iframe; the headless runner never does, so there a
  // blocked or silent page means the example is broken
  async function example() {
    const a = await loadExample(), headless = /Headless/.test(navigator.userAgent);
    if (!a && !headless) T.skip('iframe blocked on file:// — use node tests/run.mjs');
    T.assert(a && a.ex, 'examples/minimal.html did not start (no window.sumiExample)');
    return a;
  }
  const ink = a => T.hash(a.ex.canvas);
  // pointer events with the fields real input carries
  function draw(a, pts) {
    const c = a.ex.canvas, r = c.getBoundingClientRect();
    const ev = (type, p) => c.dispatchEvent(new a.w.PointerEvent(type, {
      clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true, pointerId: 1, pointerType: 'mouse',
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    ev('pointerdown', pts[0]);
    for (const p of pts.slice(1)) ev('pointermove', p);
    ev('pointerup', pts[pts.length - 1]);
  }
  const line = (x0, y0, x1, y1, n = 30) => Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n }));
  function pick(a, tool) {
    const sel = a.doc.getElementById('tool');
    sel.value = tool; sel.dispatchEvent(new a.w.Event('change'));
  }
  // runs `start` (which returns a promise) with animation frames by hand, since test iframes
  // can't count on getting them, and a clock that moves 4 ms per reading so animated replays
  // move on (and their 12 ms slices stay small)
  async function withFrames(a, start) {
    const queue = [];
    a.w.requestAnimationFrame = cb => queue.push(cb);
    let fake = a.w.performance.now();
    a.w.performance.now = () => (fake += 4);
    let settled = false;
    const p = Promise.resolve().then(start).finally(() => { settled = true; });
    for (let i = 0; i < 1e5 && !settled; i++) {
      if (queue.length) queue.shift()(a.w.performance.now());
      else await new Promise(r => setTimeout(r, 0));
    }
    return p;
  }
  function paint(a) {
    pick(a, 'wash'); draw(a, line(120, 300, 520, 180));
    pick(a, 'dry'); draw(a, line(100, 420, 600, 260));
    pick(a, 'spray'); draw(a, line(300, 120, 640, 380, 20));
  }

  T.test('example: draws, saves, clears and reopens a drawing pixel-identically', async () => {
    const a = await example(), blank = ink(a);
    paint(a);
    const drawn = ink(a);
    T.assert(drawn !== blank, 'strokes painted');
    T.eq(a.ex.strokes().length, 3, 'three strokes recorded');
    const json = a.ex.save();
    const doc = JSON.parse(json);
    T.eq(doc.format, 'sumi-strokes'); T.eq(doc.strokes.length, 3);
    a.doc.getElementById('clear').click();
    T.eq(ink(a), blank, 'cleared'); T.eq(a.ex.strokes().length, 0);
    await withFrames(a, () => a.ex.open(new a.w.Blob([json])));
    T.eq(ink(a), drawn, 'reopened pixel-identically');
    T.eq(a.ex.strokes().length, 3, 'the reopened strokes are the drawing again');
  });

  T.test("example: opens the app's .json.gz export", async () => {
    const a = await example();
    paint(a);
    const drawn = ink(a), gz = await SUMI.recordingGzip(a.ex.strokes()); // what the app's ↓ JSON saves
    a.doc.getElementById('clear').click();
    await withFrames(a, () => a.ex.open(gz));
    T.eq(ink(a), drawn);
  });

  T.test('example: Replay redraws the same picture', async () => {
    const a = await example();
    paint(a);
    const drawn = ink(a);
    await withFrames(a, () => { a.doc.getElementById('replay').click(); return a.ex.lastRun().done; });
    T.eq(ink(a), drawn);
  });

  T.test('example: a file that is not a drawing shows an error and keeps the drawing', async () => {
    const a = await example();
    paint(a);
    const drawn = ink(a), status = a.doc.getElementById('status');
    for (const bad of ['not json', '{"format":"sumi-strokes","v":1,"strokes":[{"v":3}]}']) {
      await withFrames(a, () => a.ex.open(new a.w.Blob([bad])));
      T.assert(/can't open/i.test(status.textContent), 'error shown: ' + status.textContent);
      T.eq(ink(a), drawn, 'drawing kept');
      T.eq(a.ex.strokes().length, 3);
    }
  });
})();
