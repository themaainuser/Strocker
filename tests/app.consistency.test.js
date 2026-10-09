// The recording must always match what's on the canvas (review batch 1). Uses the helpers
// from app.smoke.test.js (app, ptr, drag, line, inked).
(() => {
  const ALL5 = ['wash', 'scene', 'ink', 'fx', 'mask'];
  const layerHashes = a => ALL5.map(n => T.hash(a.app.layers.get(n).canvas)).join();
  // the app's own Replay (instant, all in one go) must reproduce exactly what is on screen
  async function inStep(a) {
    const before = layerHashes(a), r = a.app.replay({ speed: Infinity, timing: 'recorded', budget: Infinity });
    if (r) await r.done;
    return layerHashes(a) === before;
  }
  const path = (x, y, n, dx = 20, dy = -8) => Array.from({ length: n }, (_, i) => ({ x: x + (i + 1) * dx, y: y + (i + 1) * dy }));

  T.test('consistency: a second finger is ignored and the first stroke stays recorded', async () => {
    const a = await app(); a.app.setTool('dry');
    const t = id => ({ pointerId: id, pointerType: 'touch' });
    ptr(a, 'pointerdown', { x: 100, y: 400 }, t(1));
    for (const p of path(100, 400, 10)) ptr(a, 'pointermove', p, t(1));
    ptr(a, 'pointerdown', { x: 600, y: 500 }, t(2));
    for (let i = 1; i <= 10; i++) {
      ptr(a, 'pointermove', { x: 600 - i * 15, y: 500 - i * 10 }, t(2));
      ptr(a, 'pointermove', { x: 300 + i * 10, y: 320 - i * 5 }, t(1));
    }
    ptr(a, 'pointerup', { x: 450, y: 350 }, t(2));
    ptr(a, 'pointerup', { x: 400, y: 270 }, t(1));
    T.eq(a.app.strokes().length, 1);
    T.assert(await inStep(a), 'recording does not match the canvas');
  });

  T.test('consistency: a cancelled pointer ends the stroke and hovering does not paint', async () => {
    const a = await app(); a.app.setTool('dry');
    ptr(a, 'pointerdown', { x: 100, y: 400 });
    for (const p of path(100, 400, 10)) ptr(a, 'pointermove', p);
    ptr(a, 'pointercancel', { x: 300, y: 320 }, { buttons: 0 });
    T.eq(a.app.strokes().length, 1, 'cancelled stroke is kept and recorded');
    const ink = T.hash(a.app.layers.get('ink').canvas);
    for (const p of path(300, 320, 10, 20, 0)) ptr(a, 'pointermove', p, { buttons: 0, pointerType: 'touch' });
    T.eq(T.hash(a.app.layers.get('ink').canvas), ink, 'hover painted');
    T.assert(await inStep(a), 'recording does not match the canvas');
  });

  T.test('consistency: a mouse released outside the window ends the stroke', async () => {
    const a = await app(); a.app.setTool('dry');
    ptr(a, 'pointerdown', { x: 100, y: 400 });
    for (const p of path(100, 400, 10)) ptr(a, 'pointermove', p);
    ptr(a, 'pointermove', { x: 320, y: 300 }, { buttons: 0 }); // back over the board with no button down
    T.eq(a.app.strokes().length, 1);
    const ink = T.hash(a.app.layers.get('ink').canvas);
    ptr(a, 'pointermove', { x: 500, y: 200 }, { buttons: 0 });
    T.eq(T.hash(a.app.layers.get('ink').canvas), ink, 'kept painting with no button down');
    T.assert(await inStep(a));
  });

  T.test('consistency: window blur ends the stroke', async () => {
    const a = await app(); a.app.setTool('dry');
    ptr(a, 'pointerdown', { x: 100, y: 400 });
    for (const p of path(100, 400, 10)) ptr(a, 'pointermove', p);
    a.w.dispatchEvent(new a.w.Event('blur'));
    T.eq(a.app.strokes().length, 1);
    T.assert(await inStep(a));
  });

  T.test('consistency: right-click does not paint', async () => {
    const a = await app(); a.app.setTool('dry');
    ptr(a, 'pointerdown', { x: 100, y: 400 }, { button: 2, buttons: 2 });
    for (const p of path(100, 400, 5, 20, 0)) ptr(a, 'pointermove', p, { buttons: 2 });
    ptr(a, 'pointerup', { x: 200, y: 400 }, { button: 2 });
    T.eq(a.app.strokes().length, 0); T.eq(inked(a, 'ink'), 0); T.eq(a.app.undoDepth(), 0);
  });

  T.test('consistency: Ctrl+Z in the middle of a stroke cancels that stroke', async () => {
    const a = await app(); a.app.setTool('dry');
    drag(a, line(100, 400, 400, 250));
    const one = layerHashes(a);
    ptr(a, 'pointerdown', { x: 100, y: 500 });
    for (const p of path(100, 500, 8)) ptr(a, 'pointermove', p);
    a.w.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    for (const p of path(260, 436, 8)) ptr(a, 'pointermove', p);
    ptr(a, 'pointerup', { x: 420, y: 372 });
    T.eq(a.app.strokes().length, 1, 'only the first stroke remains');
    T.eq(layerHashes(a), one, 'canvas back to the first stroke only');
    T.assert(await inStep(a));
  });

  T.test('consistency: Clear mask during a replay keeps the recording in step', async () => {
    const a = await app();
    a.app.setTool('mask'); drag(a, line(500, 100, 520, 300, 6)); drag(a, line(560, 100, 580, 300, 6));
    a.app.setTool('dry'); drag(a, line(100, 400, 400, 250));
    a.app.replay({ speed: 1, timing: 'sequence' });
    a.w.document.getElementById('btnClearMask').click();
    T.assert(!a.app.busy, 'replay settled');
    T.eq(a.app.strokes().map(s => s.tool).join(), 'dry');
    T.eq(inked(a, 'mask'), 0, 'mask cleared');
    await new Promise(r => setTimeout(r, 100));
    T.eq(inked(a, 'mask'), 0, 'replay kept painting the mask');
    T.assert(await inStep(a));
  });

  T.test('consistency: Fill mask on a tiny mask explains instead of throwing', async () => {
    const a = await app(), m = a.app.layers.get('mask').ctx;
    m.fillStyle = 'rgba(255,255,255,0.03)'; m.fillRect(10, 10, 2, 2); // faint dot: not empty, nothing to fill
    const depth = a.app.undoDepth();
    a.app.fillMask();
    T.eq(a.w.__errors.length, 0, a.w.__errors.join('; '));
    T.eq(a.app.undoDepth(), depth, 'no empty undo step');
    T.assert(/mask/i.test(a.w.document.getElementById('toast').textContent), 'toast explains');
  });

  T.test('consistency: a same-size resize mid-stroke keeps the stroke on the canvas', async () => {
    const a = await app(); a.app.setTool('dry');
    const ctx0 = a.app.layers.get('ink').ctx;
    ptr(a, 'pointerdown', { x: 100, y: 400 });
    for (const p of path(100, 400, 8)) ptr(a, 'pointermove', p);
    a.w.dispatchEvent(new a.w.Event('resize'));
    for (const p of path(260, 336, 8)) ptr(a, 'pointermove', p);
    ptr(a, 'pointerup', { x: 420, y: 272 });
    T.assert(a.app.layers.get('ink').ctx === ctx0, 'layer ctx replaced');
    T.assert(await inStep(a));
  });

  T.test('consistency: replay keeps the generated poster and filled mask underneath', async () => {
    const a = await app();
    await a.app.generate({ animate: false }).done;
    a.app.setTool('dry'); drag(a, line(100, 400, 400, 250));
    T.assert(inked(a, 'scene') > 0, 'poster has a scene');
    T.assert(await inStep(a), 'replay changed the poster');
    T.assert(/poster/i.test(a.w.document.getElementById('recCount').textContent), 'panel says the poster is not exported');
    a.w.document.getElementById('btnClear').click();
    a.app.setTool('mask'); drag(a, line(150, 100, 170, 400, 6));
    a.app.fillMask();
    T.assert(inked(a, 'scene') > 0, 'mask filled');
    a.app.setTool('wash'); drag(a, line(100, 300, 300, 300));
    T.assert(await inStep(a), 'replay lost the filled mask');
    a.app.undo(); a.app.undo(); a.app.undo(); // replay, wash, fill
    T.eq(inked(a, 'scene'), 0, 'undo removes the fill');
    T.assert(await inStep(a), 'replay brought the undone fill back');
  });

  T.test('consistency: cancelling a generate before its first frame keeps the recording in step', async () => {
    const a = await app();
    a.app.setTool('mask'); drag(a, line(500, 100, 520, 300, 6));
    a.app.setTool('dry'); drag(a, line(100, 400, 400, 250));
    a.app.generate(); a.app.cancel();
    T.eq(a.app.strokes().map(s => s.tool).join(), 'mask');
    T.eq(inked(a, 'ink'), 0, 'generate wipes the painted layers right away');
    T.assert(await inStep(a));
  });

  T.test('consistency: Ctrl/Meta/Alt + digit does not switch tools', async () => {
    const a = await app(); a.app.setTool('dry');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      a.w.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: '3', [mod]: true, bubbles: true }));
    }
    T.eq(a.app.S.tool, 'dry');
  });

  T.test('consistency: Generate is disabled while a replay runs', async () => {
    const a = await app(); a.app.setTool('dry'); drag(a, line(100, 400, 400, 250));
    a.app.replay({ speed: 1 });
    const g = a.w.document.getElementById('btnGenerate');
    T.assert(g.disabled, 'generate enabled during replay'); T.assert(g.textContent.includes('Generate'), g.textContent);
    a.app.cancel(); T.assert(!g.disabled, 'generate still disabled after the replay');
  });
})();
