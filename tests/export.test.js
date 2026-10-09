// Export: JSON recording, standalone HTML player, optional WebM.
(() => {
  const { makeCalls } = FIX;
  const W = 320, H = 220, CANVAS = { w: W, h: H, dpr: 1 };
  const LAYERS = ['wash', 'ink', 'fx'];

  // strokes recorded live into per-layer canvases (like the app); the mask stroke must not show up in exports.
  // `clock` spaces the calls in time (the headless clock stands still, so otherwise they share one instant)
  function recording(clock) {
    const live = {}; for (const n of [...LAYERS, 'mask']) live[n] = T.canvas(W, H);
    const strokes = [];
    ['wash', 'dry', 'spray', 'shard', 'fine', 'mask'].forEach((tool, i) => {
      const c = makeCalls(tool), layer = SUMI.brushes[tool].layer;
      const pen = SUMI.recordStroke(live[layer].ctx, { tool, seed: c.seed + i, opts: c.opts, wind: c.wind, p0: c.p0, canvas: CANVAS, ...(clock && { clock }) });
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
      // a compressed page sets SUMI_PLAYER only once it has unpacked: wait on SUMI_PLAYER_READY
      f.onload = () => { try { const w = f.contentWindow; res(w.SUMI_PLAYER_READY ? w.SUMI_PLAYER_READY.then(() => w) : null); } catch (e) { e.name === 'SecurityError' ? res(null) : rej(e); } };
      f.srcdoc = html;
      document.body.appendChild(f);
    });
  }

  // replays a loaded player with animation frames by hand (offscreen test iframes can't count
  // on getting them): restarts it under a frame queue, as a click does, and runs every frame
  async function playByHand(w) {
    const frames = [];
    w.requestAnimationFrame = cb => frames.push(cb);
    const run = w.SUMI_PLAYER.play();
    const drawnAtOnce = run.timeline.position;
    for (let n = 0; frames.length && n < 1e5; n++) frames.shift()(w.performance.now());
    return { drawnAtOnce, done: await run.done };
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

  T.test('export: parseRecording checks every stroke in full', () => {
    const { strokes } = recording(), ok = () => JSON.parse(SUMI.recordingJSON(strokes, { canvas: CANVAS }));
    const breakers = [d => { delete d.strokes[1].p0; }, d => { d.strokes[1].opts.color = 'notacolour'; }, d => { d.strokes[1].segs[2] = null; }];
    for (const br of breakers) {
      const d = ok(); br(d);
      let e = null; try { SUMI.parseRecording(d); } catch (x) { e = x; } T.assert(e instanceof TypeError, br.toString());
    }
  });

  T.test('export: player options are validated and nothing can close the script early', () => {
    const { strokes } = recording();
    for (const opts of [{ timing: 'sequence', gap: '</script><script>alert(1)</script>' }, { gap: -1 }, { stagger: NaN }]) {
      let e = null; try { SUMI.standaloneHTML(strokes, { canvas: CANVAS, ...opts }); } catch (x) { e = x; }
      T.assert(e instanceof TypeError, JSON.stringify(opts));
    }
    const s = JSON.parse(JSON.stringify(strokes));
    s[1].seed = '</script><script>alert(1)</script><!--';
    const html = SUMI.standaloneHTML(s, { canvas: CANVAS });
    const scripts = html.split(/<script>/i).length - 1, closes = html.split(/<\/script>/i).length - 1;
    T.eq(scripts, 1, 'one script element'); T.eq(closes, 1, 'closed once');
    T.assert(!html.includes('<!--'), 'no HTML comment opener in the page');
  });

  T.test('export: player counts the strokes it plays; shard chips keep their recorded paper', () => {
    const { strokes } = recording(), html = SUMI.standaloneHTML(strokes, { canvas: CANVAS });
    T.assert(html.includes('5 strokes'), 'mask stroke not counted');
    T.assert(!html.includes('SUMI.PAPER ='), 'chip colours travel with each stroke (opts.paper), not a page-wide paper');
  });

  T.test('export: strokes from custom brushes cannot go into a standalone HTML file', () => {
    SUMI.brushes.custom = { ...SUMI.brushes.fine };
    try {
      const pen = SUMI.recordStroke(T.canvas(50, 50).ctx, { tool: 'custom', seed: 1, p0: { x: 1, y: 1 } });
      pen.segment({ x: 1, y: 1 }, { x: 9, y: 9 }, 2, 0.7);
      let e = null; try { SUMI.standaloneHTML([pen.end()], { canvas: CANVAS }); } catch (x) { e = x; }
      T.assert(e instanceof TypeError && /custom/.test(e.message), 'error: ' + (e && e.message));
    } finally { delete SUMI.brushes.custom; }
  });

  T.test('export: WebM options are validated; tracks stop when the video is done', async () => {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) T.skip('no MediaRecorder here');
    const { strokes } = recording();
    for (const fps of [0, -5, NaN, 500]) {
      let e = null; try { SUMI.recordWebM(strokes, { canvas: CANVAS, fps }); } catch (x) { e = x; }
      T.assert(e instanceof TypeError, 'fps ' + fps);
    }
    const job = SUMI.recordWebM(strokes.slice(0, 1), { canvas: CANVAS, speed: 16, hold: 50 });
    const blob = await Promise.race([job.done, new Promise(r => setTimeout(() => r('timeout'), 5000))]);
    if (blob === 'timeout') T.skip('this browser could not finish recording here');
    T.assert(job.stream.getTracks().every(t => t.readyState === 'ended'), 'tracks still live');
  });

  // a small EBML reader for checking the WebM files: { id: '1a45dfa3', at, size, data, kids }
  function ebml(bytes, start = 0, end = bytes.length, out = []) {
    const vint = (p, keepMarker) => {
      let len = 1; while (len <= 8 && !(bytes[p] & (0x80 >> (len - 1)))) len++;
      let v = keepMarker ? bytes[p] : bytes[p] & (0xff >> len);
      for (let i = 1; i < len; i++) v = v * 256 + bytes[p + i];
      return { v, len };
    };
    const MASTER = ['18538067', '114d9b74', '4dbb', '1549a966', '1654ae6b', 'ae', 'e0', '1f43b675', '1c53bb6b', 'bb', 'b7', '1a45dfa3'];
    for (let p = start; p < end;) {
      const id = vint(p, true), size = vint(p + id.len);
      const at = p, body = p + id.len + size.len;
      const hex = Array.from(bytes.subarray(p, p + id.len), b => b.toString(16).padStart(2, '0')).join('');
      const node = { id: hex, at, body, size: size.v, data: bytes.subarray(body, body + size.v) };
      if (MASTER.includes(hex)) node.kids = ebml(bytes, body, body + size.v);
      out.push(node);
      p = body + size.v;
    }
    return out;
  }
  const uintOf = d => d.reduce((v, b) => v * 256 + b, 0);
  const find = (nodes, id) => nodes.find(n => n.id === id);
  const all = (nodes, id) => nodes.filter(n => n.id === id);

  T.test('export: WebM renders frame by frame into a valid file: every frame on time, keyframes every 2 s', async () => {
    if (!SUMI.canRenderWebM()) T.skip('no WebCodecs here');
    let t = 0;
    const { strokes } = recording(() => (t += 16.7)); // ~6 s of drawing
    const progress = [];
    const job = SUMI.renderWebM(strokes, { canvas: CANVAS, speed: 2, fps: 30, hold: 300, onProgress: p => progress.push(p) });
    const blob = await T.busy(job.done);
    T.assert(blob instanceof Blob && blob.type === 'video/webm', 'a WebM blob');
    const bytes = new Uint8Array(await blob.arrayBuffer()), top = ebml(bytes);
    const head = find(top, '1a45dfa3'), seg = find(top, '18538067');
    T.eq(new TextDecoder().decode(find(head.kids, '4282').data), 'webm', 'DocType');
    T.eq(seg.body + seg.size, bytes.length, 'the segment size covers the file exactly');
    const info = find(seg.kids, '1549a966'), track = find(find(seg.kids, '1654ae6b').kids, 'ae');
    T.eq(uintOf(find(info.kids, '2ad7b1').data), 1e6, 'timestamps in ms');
    T.assert(/^V_VP[89]$/.test(new TextDecoder().decode(find(track.kids, '86').data)), 'VP9 or VP8');
    const video = find(track.kids, 'e0');
    T.eq(uintOf(find(video.kids, 'b0').data), W); T.eq(uintOf(find(video.kids, 'ba').data), H);
    // every frame, in order, 1/30 s apart, keyframes at 0 s, 2 s, 4 s...
    const blocks = [];
    for (const c of all(seg.kids, '1f43b675')) {
      const ct = uintOf(find(c.kids, 'e7').data);
      for (const b of all(c.kids, 'a3')) blocks.push({ t: ct + ((b.data[1] << 8) | b.data[2]), key: !!(b.data[3] & 0x80) });
    }
    const n = Math.round(job.duration / (1000 / 30));
    T.eq(blocks.length, n, 'frame count');
    blocks.forEach((b, i) => {
      T.eq(b.t, Math.round(i * 1000 / 30), 'frame ' + i + ' time');
      T.eq(b.key, i % 60 === 0, 'frame ' + i + ' keyframe');
    });
    const dur = new DataView(find(info.kids, '4489').data.slice().buffer).getFloat64(0);
    T.near(dur, n * 1000 / 30, 0.5, 'duration');
    // the seek index points at real elements
    const at = pos => Array.from(bytes.subarray(seg.body + pos, seg.body + pos + 4), x => x.toString(16).padStart(2, '0')).join('');
    for (const s of find(seg.kids, '114d9b74').kids) {
      const id = Array.from(find(s.kids, '53ab').data, x => x.toString(16).padStart(2, '0')).join('');
      T.eq(at(uintOf(find(s.kids, '53ac').data)).slice(0, id.length), id, 'SeekHead entry for ' + id);
    }
    const cues = all(find(seg.kids, '1c53bb6b').kids, 'bb');
    T.eq(cues.length, all(seg.kids, '1f43b675').length, 'one cue per cluster');
    for (const q of cues) T.eq(at(uintOf(find(find(q.kids, 'b7').kids, 'f1').data)), '1f43b675', 'cue points at a cluster');
    T.assert(progress.length > 5 && progress.every((p, i) => !i || p >= progress[i - 1]) && progress[progress.length - 1] === 1, 'progress rises to 1');
  });

  T.test('export: a rendered video ends on exactly the finished picture, without animation frames', async () => {
    if (!SUMI.canRenderWebM()) T.skip('no WebCodecs here');
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0; // a hidden or throttled page
    try {
      let t = 0;
      const { live, strokes } = recording(() => (t += 16.7));
      const job = SUMI.renderWebM(strokes, { canvas: CANVAS, speed: 8, hold: 0 });
      T.assert(await T.busy(job.done) instanceof Blob, 'finished');
      for (const n of LAYERS) T.eq(T.hash(job.stage.layers[n]), T.hash(live[n].canvas), n);
    } finally { window.requestAnimationFrame = raf; }
  });

  T.test('export: a render can be cancelled, and its options are checked', async () => {
    if (!SUMI.canRenderWebM()) T.skip('no WebCodecs here');
    const { strokes } = recording();
    for (const bad of [{ fps: 0 }, { fps: 500 }, { hold: -1 }, { speed: 0 }]) {
      let e = null; try { SUMI.renderWebM(strokes, { canvas: CANVAS, ...bad }); } catch (x) { e = x; }
      T.assert(e instanceof TypeError, JSON.stringify(bad));
    }
    const job = SUMI.renderWebM(strokes, { canvas: CANVAS, speed: 0.25 });
    job.cancel();
    T.eq(await T.busy(job.done), null, 'cancelled render resolves null');
  });

  T.test('export: a rendered video opens on paper', async () => {
    if (!SUMI.canRenderWebM()) T.skip('no WebCodecs here');
    const { strokes } = recording();
    const blob = await T.busy(SUMI.renderWebM(strokes.slice(0, 2), { canvas: CANVAS, speed: 4, hold: 200 }).done);
    const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
    const decoding = (p) => T.busy(p, 1e6).catch(() => false); // a browser that can't decode never answers
    if (!await decoding(new Promise(r => { v.onloadeddata = () => r(true); v.onerror = () => r(false); }))) T.skip('this browser cannot decode WebM here');
    T.assert(Number.isFinite(v.duration) && v.duration > 0.2, 'the player knows the length: ' + v.duration);
    v.currentTime = 0;
    if (!await decoding(new Promise(r => { v.onseeked = () => r(true); }))) T.skip('this browser cannot seek WebM here');
    const c = T.canvas(v.videoWidth, v.videoHeight); c.ctx.drawImage(v, 0, 0);
    const [r, g, b] = T.rgb(T.pixels(c.canvas), 5, 5);
    T.assert(r > 200 && g > 200 && b > 190, 'first frame corner is ' + [r, g, b]);
  });

  T.test('export: standalone HTML is one self-contained file', () => {
    const { strokes } = recording(), html = SUMI.standaloneHTML(strokes, { canvas: CANVAS, title: '</title><script>alert(1)</script>' });
    T.assert(html.startsWith('<!DOCTYPE html>'), 'doctype');
    T.assert(!/<script[^>]*\bsrc=|<link\b|https?:\/\//i.test(html), 'no external references');
    T.assert(!html.includes('<script>alert(1)'), 'title is escaped');
    for (const k of ['rng', 'brushes', 'recorder', 'playback']) T.assert(html.includes(SUMI.modules[k].toString().slice(0, 40)), k + ' inlined');
  });

  T.test('export: an instant player replays the recording pixel-identically, a slice per frame', async () => {
    const { live, strokes } = recording();
    const w = await loadHTML(SUMI.standaloneHTML(strokes, { canvas: CANVAS, speed: Infinity }));
    if (!w) T.skip('iframe blocked on file:// — use node tests/run.mjs');
    const { drawnAtOnce, done } = await playByHand(w);
    T.eq(drawnAtOnce, 0, 'nothing drawn in one blocking go');
    T.eq(done, true);
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

  T.test('export: the player redraws only what each frame painted, byte-identical to a full redraw', async () => {
    let t = 0;
    const { strokes } = recording(() => (t += 16.7)); // painted at 60 calls a second
    const w = await loadHTML(SUMI.standaloneHTML(strokes, { canvas: CANVAS, speed: 1, timing: 'sequence', gap: 0 }));
    if (!w) T.skip('iframe blocked on file:// — use node tests/run.mjs');
    const P = w.SUMI_PLAYER, view = w.document.querySelector('canvas');
    // frames by hand, and a clock that moves 40 ms per reading, so each frame applies a few calls
    const frames = [];
    w.requestAnimationFrame = cb => frames.push(cb);
    let fake = w.performance.now();
    w.performance.now = () => (fake += 40);
    const run = P.play(); // restarts under the queued frames
    const ref = w.document.createElement('canvas'); ref.width = view.width; ref.height = view.height;
    const full0 = P.stats.full, area0 = P.stats.area;
    let n = 0;
    while (frames.length && n < 1000) {
      frames.shift()(fake);
      P.composite(ref.getContext('2d')); // the full picture, beside the view
      T.eq(T.hash(view), T.hash(ref), 'frame ' + n);
      n++;
    }
    T.assert(run.timeline.done, 'played to the end in ' + n + ' frames');
    T.eq(P.stats.full - full0, 0, 'no full redraws while playing');
    T.assert(P.stats.area - area0 > 20, 'area frames: ' + (P.stats.area - area0) + ' of ' + n);
    // an area nobody can bound (a brush that doesn't report one) redraws everything; none redraws nothing
    P.update(null); T.eq(P.stats.full - full0, 0);
    P.update({ x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }); T.eq(P.stats.full - full0, 1);
  });

  T.test('export: the JSON download is gzip-compressed and reads back exactly', async () => {
    const { strokes } = recording(), json = SUMI.recordingJSON(strokes, { canvas: CANVAS });
    const blob = await SUMI.recordingGzip(strokes, { canvas: CANVAS });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    T.eq(bytes[0], 0x1f, 'gzip magic'); T.eq(bytes[1], 0x8b, 'gzip magic');
    T.assert(blob.size < json.length / 2, `${blob.size} bytes compressed from ${json.length}`);
    const want = JSON.stringify(SUMI.parseRecording(json));
    for (const input of [blob, bytes, bytes.buffer, json, JSON.parse(json)]) {
      T.eq(JSON.stringify(await SUMI.readRecording(input)), want, Object.prototype.toString.call(input));
    }
    let e = null; try { await SUMI.readRecording(new Uint8Array([0x1f, 0x8b, 1, 2, 3])); } catch (x) { e = x; }
    T.assert(e, 'a broken gzip file is an error');
  });

  T.test('export: the compressed HTML player unpacks itself and replays pixel-identically', async () => {
    const { live, strokes } = recording();
    const plain = SUMI.standaloneHTML(strokes, { canvas: CANVAS, speed: Infinity });
    const html = await SUMI.standaloneHTMLGzip(strokes, { canvas: CANVAS, speed: Infinity });
    T.assert(!html.includes('"tool"'), 'no raw stroke JSON inside');
    T.assert(html.length < plain.length, `${html.length} vs ${plain.length} characters`);
    T.assert(!/<script[^>]*\bsrc=|<link\b|https?:\/\//i.test(html), 'still one self-contained file');
    const w = await loadHTML(html);
    if (!w) T.skip('iframe blocked on file:// — use node tests/run.mjs');
    T.eq((await playByHand(w)).done, true);
    for (const n of LAYERS) T.eq(T.hash(w.SUMI_PLAYER.layers[n]), T.hash(live[n].canvas), n);
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
