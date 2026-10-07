// Export: JSON recording, standalone HTML player, optional WebM.
(() => {
  const { makeCalls } = FIX;
  const W = 320, H = 220, CANVAS = { w: W, h: H, dpr: 1 };
  const LAYERS = ['wash', 'ink', 'fx'];

  // strokes recorded live into per-layer canvases (like the app); the mask stroke must not show up in exports
  function recording() {
    const live = {}; for (const n of [...LAYERS, 'mask']) live[n] = T.canvas(W, H);
    const strokes = [];
    ['wash', 'dry', 'spray', 'shard', 'fine', 'mask'].forEach((tool, i) => {
      const c = makeCalls(tool), layer = SUMI.brushes[tool].layer;
      const pen = SUMI.recordStroke(live[layer].ctx, { tool, seed: c.seed + i, opts: c.opts, wind: c.wind, p0: c.p0, canvas: CANVAS });
      pen.dab();
      for (const [ax, ay, bx, by, w, dir, speed, alpha] of c.segs) pen.segment({ x: ax, y: ay }, { x: bx, y: by }, w, dir, { speed, alpha });
      strokes.push(pen.end());
    });
    return { live, strokes: JSON.parse(JSON.stringify(strokes)) };
  }
  function loadHTML(html) {
    return new Promise((res, rej) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:600px';
      f.onload = () => { try { res(f.contentWindow.SUMI_PLAYER ? f.contentWindow : null); } catch (e) { e.name === 'SecurityError' ? res(null) : rej(e); } };
      f.srcdoc = html;
      document.body.appendChild(f);
    });
  }

  T.test('export: core modules register their own source', () => {
    for (const k of ['rng', 'brushes', 'recorder', 'playback']) {
      T.eq(typeof (SUMI.modules && SUMI.modules[k]), 'function', k);
      T.assert(/^function\b/.test(SUMI.modules[k].toString()), k + ' source');
    }
  });

  T.test('export: JSON round-trips a recording', () => {
    const { strokes } = recording();
    const json = SUMI.recordingJSON(strokes, { canvas: CANVAS });
    const doc = SUMI.parseRecording(json);
    T.eq(doc.format, 'sumi-strokes'); T.eq(doc.v, 1); T.eq(doc.paper, '#f4f1ea');
    T.eq(JSON.stringify(doc.canvas), JSON.stringify(CANVAS));
    T.eq(JSON.stringify(doc.strokes), JSON.stringify(strokes));
    T.eq(JSON.stringify(SUMI.parseRecording(JSON.parse(json)).strokes), JSON.stringify(strokes), 'objects too');
  });

  T.test('export: parseRecording rejects anything else', () => {
    const { strokes } = recording(), ok = JSON.parse(SUMI.recordingJSON(strokes, { canvas: CANVAS }));
    const bad = [{}, { ...ok, format: 'other' }, { ...ok, v: 2 }, { ...ok, strokes: 'x' },
      { ...ok, strokes: [{ ...ok.strokes[0], v: 99 }] }, { ...ok, strokes: [{ ...ok.strokes[0], tool: 'nope' }] }, { ...ok, canvas: { w: 0, h: 10, dpr: 1 } }];
    for (const b of bad) { let e = null; try { SUMI.parseRecording(b); } catch (x) { e = x; } T.assert(e instanceof TypeError, JSON.stringify(b).slice(0, 60)); }
    let e = null; try { SUMI.parseRecording('{not json'); } catch (x) { e = x; } T.assert(e instanceof SyntaxError, 'bad JSON text');
  });

  T.test('export: standalone HTML is one self-contained file', () => {
    const { strokes } = recording(), html = SUMI.standaloneHTML(strokes, { canvas: CANVAS, title: '</title><script>alert(1)</script>' });
    T.assert(html.startsWith('<!DOCTYPE html>'), 'doctype');
    T.assert(!/<script[^>]*\bsrc=|<link\b|https?:\/\//i.test(html), 'no external references');
    T.assert(!html.includes('<script>alert(1)'), 'title is escaped');
    for (const k of ['rng', 'brushes', 'recorder', 'playback']) T.assert(html.includes(SUMI.modules[k].toString().slice(0, 40)), k + ' inlined');
  });

  T.test('export: standalone HTML replays the recording pixel-identically', async () => {
    const { live, strokes } = recording();
    const w = await loadHTML(SUMI.standaloneHTML(strokes, { canvas: CANVAS, speed: Infinity }));
    if (!w) T.skip('iframe blocked on file:// — use node tests/run.mjs');
    T.eq(await w.SUMI_PLAYER.run.done, true);
    for (const n of LAYERS) T.eq(T.hash(w.SUMI_PLAYER.layers[n]), T.hash(live[n].canvas), n);
    const view = w.document.querySelector('canvas'), px = T.pixels(view);
    let inked = 0; for (let i = 0; i < px.data.length; i += 4) if (px.data[i] < 200) inked++;
    T.assert(inked > 500, 'visible canvas shows the strokes on paper');
    T.eq(view.width, W); T.eq(view.height, H);
  });

  T.test('export: standalone HTML animates and replays on click', async () => {
    const { live, strokes } = recording();
    const w = await loadHTML(SUMI.standaloneHTML(strokes, { canvas: CANVAS, speed: 4, timing: 'sequence', gap: 50 }));
    if (!w) T.skip('iframe blocked on file:// — use node tests/run.mjs');
    w.SUMI_PLAYER.run.finish();
    T.eq(T.hash(w.SUMI_PLAYER.layers.ink), T.hash(live.ink.canvas), 'finish completes it');
    w.document.querySelector('canvas').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    T.assert(w.SUMI_PLAYER.run.timeline.position < w.SUMI_PLAYER.run.timeline.total, 'click restarts the playback');
  });

  T.test('export: options are checked before writing a file', () => {
    T.eq(typeof SUMI.standaloneHTML, 'function');
    const { strokes } = recording();
    for (const opts of [{ speed: 0 }, { speed: 'fast' }, { timing: 'shuffle' }]) {
      let e = null; try { SUMI.standaloneHTML(strokes, { canvas: CANVAS, ...opts }); } catch (x) { e = x; }
      T.assert(e instanceof TypeError, JSON.stringify(opts));
    }
  });

  T.test('export: WebM recording produces a video', async () => {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) T.skip('no MediaRecorder here');
    const { strokes } = recording();
    const run = SUMI.recordWebM(strokes.slice(0, 2), { canvas: CANVAS, speed: 16, hold: 100 });
    const blob = await run.done;
    T.assert(blob && /webm/.test(blob.type), 'type ' + (blob && blob.type));
    T.assert(blob.size > 0, 'size ' + blob.size);
  });
  T.test('export: WebM playback runs on its own timer, not on screen refreshes', async () => {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) T.skip('no MediaRecorder here');
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0; // a page that isn't being drawn (hidden, minimised, throttled)
    try {
      const { strokes } = recording();
      const run = SUMI.recordWebM(strokes.slice(0, 2), { canvas: CANVAS, hold: 50 });
      const blob = await Promise.race([run.done, new Promise(r => setTimeout(() => r('timed out'), 3000))]);
      T.assert(blob instanceof Blob && blob.size > 0, 'finished without animation frames: ' + blob);
    } finally { window.requestAnimationFrame = raf; }
  });
  T.test('export: the video opens on paper, not on a black frame', async () => {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) T.skip('no MediaRecorder here');
    const { strokes } = recording();
    // headless browsers record fine but often can't load or seek their own WebM: skip, don't hang
    const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(false), ms))]);
    const blob = await within(SUMI.recordWebM(strokes.slice(0, 2), { canvas: CANVAS, hold: 200 }).done, 5000);
    if (!blob) T.skip('this browser could not finish recording here');
    const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
    const loaded = await within(new Promise(r => { v.onloadeddata = () => r(true); v.onerror = () => r(false); }), 3000);
    if (!loaded) T.skip('this browser cannot decode its own WebM');
    v.currentTime = 0; // drawing right at loadeddata can read black
    if (!await within(new Promise(r => { v.onseeked = () => r(true); }), 3000)) T.skip('this browser cannot seek its own WebM');
    const c = T.canvas(v.videoWidth, v.videoHeight); c.ctx.drawImage(v, 0, 0);
    const [r, g, b] = T.rgb(T.pixels(c.canvas), 5, 5); // a corner no stroke touches
    T.assert(r > 200 && g > 200 && b > 190, 'first frame corner is ' + [r, g, b]);
  });
})();
