// The app redraws only the area a stroke touched, and the board always matches a full redraw.
(() => {
  const boardMatchesFull = a => {
    const fresh = document.createElement('canvas');
    fresh.width = a.board.width; fresh.height = a.board.height;
    a.app.layers.composite(fresh.getContext('2d'), { showMask: a.app.S.tool === 'mask', full: true });
    return T.hash(a.board) === T.hash(fresh);
  };

  T.test('render: painting with every tool redraws areas only and the board matches a full redraw', async () => {
    const a = await app(), L = a.app.layers;
    a.app.renderNow();
    const full0 = L.stats.fullFrames, area0 = L.stats.areaFrames;
    let y = 80;
    for (const tool of ['dry', 'spray', 'fine', 'lines', 'wash', 'shard']) {
      a.app.setTool(tool); a.app.renderNow(); // switching tools may redraw fully once
      const full = L.stats.fullFrames;
      ptr(a, 'pointerdown', { x: 80, y });
      for (let i = 1; i <= 12; i++) { ptr(a, 'pointermove', { x: 80 + i * 30, y: y - i * 4 }); a.app.renderNow(); }
      a.w.dispatchEvent(new a.w.PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', bubbles: true }));
      a.app.renderNow();
      T.eq(L.stats.fullFrames, full, tool + ' painted with full redraws');
      T.assert(boardMatchesFull(a), tool + ': board differs from a full redraw');
      y += 110;
    }
    T.assert(L.stats.areaFrames > area0 + 60, 'area frames ' + (L.stats.areaFrames - area0));
    T.assert(L.stats.fullFrames - full0 <= 6, 'full frames ' + (L.stats.fullFrames - full0));
  });

  T.test('render: the speed-line preview is erased when it moves and when the stroke ends', async () => {
    const a = await app(); a.app.setTool('lines'); a.app.renderNow();
    ptr(a, 'pointerdown', { x: 100, y: 500 });
    for (let i = 1; i <= 8; i++) { ptr(a, 'pointermove', { x: 100 + i * 50, y: 500 - i * 20 - (i % 2) * 60 }); a.app.renderNow(); }
    a.w.dispatchEvent(new a.w.PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', bubbles: true }));
    a.app.renderNow();
    T.assert(boardMatchesFull(a), 'preview left marks on the board');
  });

  T.test('render: an animated replay redraws areas and ends matching a full redraw', async () => {
    const a = await app(), L = a.app.layers;
    a.app.setTool('wash'); drag(a, line(100, 300, 500, 200));
    a.app.setTool('dry'); drag(a, line(100, 400, 500, 250));
    const frames = []; a.w.requestAnimationFrame = cb => frames.push(cb);
    let fake = a.w.performance.now(); a.w.performance.now = () => (fake += 16);
    const run = a.app.replay({ speed: 1 });
    const full0 = L.stats.fullFrames;
    for (let i = 0; i < 2000 && a.app.busy; i++) { const f = frames.shift(); if (!f) break; f(fake); a.app.renderNow(); }
    T.eq(await run.done, true);
    a.app.renderNow();
    T.assert(L.stats.fullFrames - full0 <= 2, 'replay used full redraws: ' + (L.stats.fullFrames - full0));
    T.assert(boardMatchesFull(a), 'board differs after replay');
  });
})();
