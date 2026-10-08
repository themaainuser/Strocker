// Area-only redraw: brushes report where they painted, the pen and the playback timeline pass
// it on, and the layer stack recomposites just that area — byte-identical to a full redraw.
(() => {
  const inside = (r, x, y) => r && x >= r.x0 - 1 && x <= r.x1 + 1 && y >= r.y0 - 1 && y <= r.y1 + 1;
  // every inked pixel must lie in one of the rects reported for the calls that drew it
  function outsidePixels(canvas, rects) {
    const px = T.pixels(canvas); let n = 0, first = null;
    for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) {
      if (px.data[(y * px.w + x) * 4 + 3] === 0) continue;
      if (!rects.some(r => inside(r, x + 0.5, y + 0.5))) { n++; if (!first) first = [x, y]; }
    }
    return { n, first };
  }
  const take = st => { const r = st.dirty; st.dirty = null; return r; };

  T.test('dirty: every brush call reports an area containing everything it painted', () => {
    const rng = SUMI.makeRng('areas');
    for (const tool of FIX.TOOLS) {
      for (let k = 0; k < 6; k++) {
        const c = T.canvas(400, 400), size = rng.range(2, 140);
        const opts = { size, splatter: rng.range(0, 100), bleed: rng.range(0, 100), dryness: rng.range(0, 1), opacity: 1, color: '#000',
          sprayDensity: rng.range(0.1, 1), sprayGap: rng.chance(0.5) ? 0 : rng.range(0, 12),
          washLayers: rng.int(1, 6), washDetail: rng.int(2, 5), washEdge: rng.next() };
        const st = SUMI.makeStroke(c.ctx, 'a' + k, opts, rng.range(-3, 3)), b = SUMI.brushes[tool], rects = [];
        let p = { x: rng.range(120, 280), y: rng.range(120, 280) };
        b.start(st, p); rects.push(take(st));
        b.dab(st, p); rects.push(take(st));
        const n = rng.int(0, 40);
        for (let i = 0; i < n; i++) {
          // long and short moves, widths that shrink fast (stamped brushes carry spacing across calls)
          const len = rng.chance(0.2) ? rng.range(20, 90) : rng.range(0, 6), a = rng.range(0, Math.PI * 2);
          const q = { x: p.x + Math.cos(a) * len, y: p.y + Math.sin(a) * len };
          st.speed = rng.next(); st.alpha = rng.range(0.3, 1);
          b.segment(st, p, q, size * (1 - i / (n + 1)) + rng.range(0, 4), a); rects.push(take(st));
          p = q;
        }
        b.end(st); rects.push(take(st));
        const out = outsidePixels(c.canvas, rects.filter(Boolean));
        T.eq(out.n, 0, `${tool} #${k} (size ${size.toFixed(0)}) painted ${out.n} px outside its areas, e.g. at ${out.first}`);
      }
    }
  });

  T.test('dirty: pen.takeDirty returns the area painted since the last take', () => {
    const c = T.canvas(300, 200), pen = SUMI.recordStroke(c.ctx, { tool: 'dry', seed: 1, opts: { size: 30 }, p0: { x: 50, y: 100 } });
    pen.dab();
    pen.segment({ x: 50, y: 100 }, { x: 60, y: 98 }, 30, -0.2);
    const r = pen.takeDirty();
    T.assert(r && r.x0 < 50 && r.x1 > 60 && r.y0 < 98 && r.y1 > 100, 'area ' + JSON.stringify(r));
    T.eq(pen.takeDirty(), null, 'second take is empty');
    pen.end();
  });

  T.test('dirty: playback reports the area of the calls it applied', () => {
    const live = T.canvas(300, 200), pen = SUMI.recordStroke(live.ctx, { tool: 'wash', seed: 2, opts: { size: 30 }, p0: { x: 40, y: 100 } });
    for (let i = 0; i < 30; i++) pen.segment({ x: 40 + i * 7, y: 100 }, { x: 47 + i * 7, y: 100 }, 30, 0);
    const s = JSON.parse(JSON.stringify(pen.end()));
    const c = T.canvas(300, 200), tl = SUMI.playback(c.ctx, [s]);
    tl.seek((s.segs[10][8] - s.t0));
    const r1 = tl.takeDirty(), first = T.pixels(c.canvas);
    T.assert(r1 && r1.x0 <= 40 && r1.x1 < 200, 'first part ' + JSON.stringify(r1));
    T.eq(tl.takeDirty(), null);
    tl.seek(Infinity);
    const r2 = tl.takeDirty(), px = T.pixels(c.canvas);
    for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) {
      const i = (y * px.w + x) * 4;
      if (px.data[i + 3] !== first.data[i + 3]) T.assert(inside(r2, x + 0.5, y + 0.5), `changed pixel ${x},${y} outside ${JSON.stringify(r2)}`);
    }
  });

  // layer-stack tests need js/layers.js, which library-only pages (standalone, dist) don't load
  const layersTest = (name, fn) => T.test(name, () => { if (!SUMI.createLayers) T.skip('layers.js not loaded (library-only page)'); return fn(); });
  // layers: draw some content, composite fully once, then change parts and composite areas
  function scene(L) {
    const g = L.get('wash').ctx; g.fillStyle = '#5a6d7e'; g.fillRect(20, 20, 140, 90);
    L.get('scene').ctx.fillStyle = '#2b3a4a'; L.get('scene').ctx.fillRect(100, 40, 60, 60);
    L.get('ink').ctx.fillRect(40, 60, 50, 20);
    L.get('mask').ctx.fillStyle = '#fff'; L.get('mask').ctx.fillRect(0, 0, 60, 120);
    L.markDirty();
  }
  layersTest('dirty: area composites are byte-identical to a full composite', () => {
    for (const showMask of [false, true]) {
      const L = SUMI.createLayers(200, 120, 1), board = T.canvas(200, 120);
      scene(L); L.composite(board.ctx, { showMask });
      const frames0 = L.stats.areaFrames;
      const ink = L.get('ink').ctx, wash = L.get('wash').ctx, mask = L.get('mask').ctx;
      ink.fillRect(150, 90, 10, 10); L.markArea({ x0: 148, y0: 88, x1: 162, y1: 102 }, 'ink');
      L.composite(board.ctx, { showMask });
      wash.fillRect(10, 10, 20, 20); L.markArea({ x0: 9, y0: 9, x1: 31, y1: 31 }, 'wash');
      mask.clearRect(30, 0, 20, 20); L.markArea({ x0: 30, y0: 0, x1: 50, y1: 20 }, 'mask');
      L.composite(board.ctx, { showMask });
      T.eq(L.stats.areaFrames, frames0 + 2, 'took the area path');
      const fresh = T.canvas(200, 120); L.composite(fresh.ctx, { showMask, full: true });
      T.eq(T.hash(board.canvas), T.hash(fresh.canvas), 'showMask ' + showMask);
    }
  });

  // drawImage(layer) makes the browser snapshot that layer, and the next brush write then copies
  // the whole layer (~3–4 ms at 2x); area redraws must read layers with getImageData instead
  layersTest('dirty: area redraws and cache updates never use a layer as a drawImage source', () => {
    const L = SUMI.createLayers(200, 120, 1), board = T.canvas(200, 120);
    scene(L); L.composite(board.ctx, { showMask: true });
    const layerCanvases = [...SUMI.LAYER_NAMES, 'mask'].map(n => L.get(n).canvas), used = [];
    const proto = CanvasRenderingContext2D.prototype, orig = proto.drawImage;
    proto.drawImage = function (src, ...rest) { if (layerCanvases.includes(src)) used.push(src); return orig.call(this, src, ...rest); };
    try {
      L.get('wash').ctx.fillRect(10, 10, 9, 9); L.markArea({ x0: 9, y0: 9, x1: 20, y1: 20 }, 'wash');
      L.get('mask').ctx.clearRect(30, 0, 9, 9); L.markArea({ x0: 30, y0: 0, x1: 40, y1: 10 }, 'mask');
      L.get('ink').ctx.fillRect(60, 60, 9, 9); L.markArea({ x0: 59, y0: 59, x1: 70, y1: 70 }, 'ink');
      L.composite(board.ctx, { showMask: true });
    } finally { proto.drawImage = orig; }
    T.eq(used.length, 0, 'layers drawn from: ' + used.length);
    const fresh = T.canvas(200, 120); L.composite(fresh.ctx, { showMask: true, full: true });
    T.eq(T.hash(board.canvas), T.hash(fresh.canvas), 'still identical to a full redraw');
  });

  layersTest('dirty: an area composite leaves the rest of the board alone', () => {
    const L = SUMI.createLayers(200, 120, 1), board = T.canvas(200, 120);
    scene(L); L.composite(board.ctx);
    board.ctx.fillStyle = '#ff00ff'; board.ctx.fillRect(190, 0, 10, 10); // a sentinel outside the area
    L.get('ink').ctx.fillRect(20, 100, 6, 6); L.markArea({ x0: 18, y0: 98, x1: 28, y1: 108 }, 'ink');
    L.composite(board.ctx);
    T.eq(T.rgb(T.pixels(board.canvas), 195, 5).slice(0, 3).join(), '255,0,255');
  });

  layersTest('dirty: a full redraw is used when asked, when the board changes, and after markDirty', () => {
    const L = SUMI.createLayers(200, 120, 1), a = T.canvas(200, 120), b = T.canvas(200, 120);
    scene(L); L.composite(a.ctx);
    const full0 = L.stats.fullFrames;
    L.markArea({ x0: 0, y0: 0, x1: 5, y1: 5 }, 'ink'); L.composite(b.ctx); // a different board: must be full
    T.eq(L.stats.fullFrames, full0 + 1, 'new board');
    L.markArea({ x0: 0, y0: 0, x1: 5, y1: 5 }, 'ink'); L.composite(b.ctx, { showMask: true }); // tint switched on
    T.eq(L.stats.fullFrames, full0 + 2, 'mask tint toggled');
    L.markDirty('ink'); L.composite(b.ctx, { showMask: true });
    T.eq(L.stats.fullFrames, full0 + 3, 'markDirty');
  });

  layersTest('dirty: exporting a PNG does not use up a pending area update', () => {
    const L = SUMI.createLayers(200, 120, 1), board = T.canvas(200, 120);
    scene(L); L.composite(board.ctx);
    L.get('ink').ctx.fillRect(150, 20, 20, 20); L.markArea({ x0: 148, y0: 18, x1: 172, y1: 42 }, 'ink');
    L.exportCanvas(null, 'X');
    T.assert(L.dirty, 'export cleared the pending update');
    L.composite(board.ctx);
    const fresh = T.canvas(200, 120); L.composite(fresh.ctx, { full: true });
    T.eq(T.hash(board.canvas), T.hash(fresh.canvas));
  });
})();
