// Runs with ONLY js/rng.js + js/brushes.js loaded — the portable brush library.
T.test('standalone: no poster modules present', () => {
  T.eq(typeof SUMI.createLayers, 'undefined'); T.eq(typeof SUMI.scene, 'undefined'); T.eq(typeof SUMI.PAPER, 'undefined');
});
T.test('standalone: every tool paints', () => {
  for (const tool of FIX.TOOLS) {
    const c = T.canvas(320, 220);
    FIX.play(c.ctx, FIX.makeCalls(tool));
    T.assert(T.inkCount(T.pixels(c.canvas), 0, 0, 320, 220) > 0, tool + ' painted nothing');
  }
});
T.test('standalone: replay on a used canvas matches a fresh one', () => {
  for (const tool of FIX.TOOLS) {
    const a = T.canvas(320, 220), b = T.canvas(320, 220);
    FIX.play(a.ctx, FIX.makeCalls(tool));
    FIX.dirty(b.ctx);
    FIX.play(b.ctx, FIX.makeCalls(tool));
    T.eq(T.hash(b.canvas), T.hash(a.canvas), tool);
  }
});
