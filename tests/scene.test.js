const box = { x: 100, y: 50, w: 400, h: 500 };
T.test('bridge: placement and tower order', () => {
  for (let s = 0; s < 20; s++) {
    const g = SUMI.scene.bridgeGeometry(box, SUMI.makeRng(s));
    T.assert(g.vp.x >= box.x + 0.05 * box.w - 1e-6 && g.vp.x <= box.x + 0.30 * box.w + 1e-6, 'vp.x ' + g.vp.x);
    T.assert(g.vp.y >= box.y + 0.45 * box.h - 1e-6 && g.vp.y <= box.y + 0.60 * box.h + 1e-6, 'vp.y ' + g.vp.y);
    T.assert(g.towers.length >= 2 && g.towers.length <= 3, 'towers ' + g.towers.length);
    g.towers.forEach((t, i) => {
      T.assert(t.x >= box.x && t.x <= box.x + box.w && t.yTop >= box.y, 'tower in box');
      if (i) T.assert(t.yDeck - t.yTop > g.towers[i - 1].yDeck - g.towers[i - 1].yTop, 'far→near');
    });
    T.assert(g.cables.length > 0 && g.suspenders.length > 0);
  }
});
T.test('pylon: tapers, braced, armed, wired', () => {
  const g = SUMI.scene.pylonGeometry({ x: 300, y: 500 }, 300, SUMI.makeRng(3));
  const base = Math.abs(g.legs[1][0].x - g.legs[0][0].x), top = Math.abs(g.legs[1][1].x - g.legs[0][1].x);
  T.assert(top < base, `top ${top} base ${base}`); T.assert(g.braces.length > 0);
  T.assert(g.arms.length >= 2 && g.arms.length <= 3); T.assert(g.wires.length >= g.arms.length);
});
T.test('scene: render deterministic, returns geometry', () => {
  const a = T.canvas(600, 600), b = T.canvas(600, 600);
  const ga = SUMI.scene.render(a.ctx, SUMI.makeRng('sc'), SUMI.makeNoise('sc'), box);
  SUMI.scene.render(b.ctx, SUMI.makeRng('sc'), SUMI.makeNoise('sc'), box);
  T.eq(T.hash(a.canvas), T.hash(b.canvas)); T.assert(ga.pylons.length >= 1 && ga.pylons.length <= 3);
  T.assert(T.inkCount(T.pixels(a.canvas), 0, 0, 600, 600) > 5000, 'scene too empty');
});
T.test('clipToMask: nothing survives outside the mask', () => {
  for (const feather of [0, 12]) {
    const s = T.canvas(100, 100), m = T.canvas(100, 100);
    s.ctx.fillRect(0, 0, 100, 100); m.ctx.fillStyle = '#fff'; m.ctx.fillRect(0, 0, 50, 100);
    SUMI.scene.clipToMask(s.ctx, m.canvas, feather);
    const px = T.pixels(s.canvas); T.assert(T.alpha(px, 20, 50) > 0, 'inside ' + feather); T.eq(T.inkCount(px, 51, 0, 100, 100), 0, 'outside ' + feather);
  }
});
