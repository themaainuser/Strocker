function mask(w, h, draw) { const c = T.canvas(w, h); c.ctx.fillStyle = '#fff'; draw(c.ctx); return c.canvas; }
const perim = pts => pts.reduce((s, p, i) => s + Math.hypot(p.x - pts[(i + 1) % pts.length].x, p.y - pts[(i + 1) % pts.length].y), 0);
T.test('contour: grid size', () => { const g = SUMI.contour.grid(mask(200, 120, () => {}), 4, 1); T.eq(g.cols, 50); T.eq(g.rows, 30); });
T.test('contour: circle → one closed loop, right perimeter', () => {
  const loops = SUMI.contour.trace(SUMI.contour.grid(mask(200, 200, x => { x.beginPath(); x.arc(100, 100, 50, 0, 7); x.fill(); })));
  T.eq(loops.length, 1); T.assert(loops[0].closed); T.near(perim(loops[0].pts), 2 * Math.PI * 50, 0.1 * 2 * Math.PI * 50);
});
T.test('contour: two blobs → two loops; empty → none', () => {
  const two = mask(300, 120, x => { x.fillRect(20, 20, 60, 60); x.fillRect(180, 30, 70, 50); });
  T.eq(SUMI.contour.trace(SUMI.contour.grid(two)).length, 2);
  T.eq(SUMI.contour.trace(SUMI.contour.grid(mask(100, 100, () => {}))).length, 0);
});
T.test('contour: shape touching the canvas edge still closes', () => {
  const loops = SUMI.contour.trace(SUMI.contour.grid(mask(200, 200, x => x.fillRect(0, 0, 100, 200))));
  T.eq(loops.length, 1); T.assert(loops[0].closed);
});
T.test('contour: bounds', () => {
  const b = SUMI.contour.bounds(SUMI.contour.grid(mask(200, 200, x => { x.beginPath(); x.arc(100, 100, 50, 0, 7); x.fill(); })));
  T.near(b.x, 50, 8); T.near(b.y, 50, 8); T.near(b.w, 100, 16); T.near(b.h, 100, 16);
  T.eq(SUMI.contour.bounds(SUMI.contour.grid(mask(50, 50, () => {}))), null);
});
T.test('contour: inkEdge draws, deterministic', () => {
  const loops = SUMI.contour.trace(SUMI.contour.grid(mask(200, 200, x => { x.beginPath(); x.arc(100, 100, 60, 0, 7); x.fill(); })));
  const a = T.canvas(200, 200), b = T.canvas(200, 200), o = SUMI.defaultOpts();
  SUMI.contour.inkEdge(a.ctx, SUMI.makeRng('e'), SUMI.makeNoise('e'), loops, o);
  SUMI.contour.inkEdge(b.ctx, SUMI.makeRng('e'), SUMI.makeNoise('e'), loops, o);
  T.eq(T.hash(a.canvas), T.hash(b.canvas)); T.assert(T.inkCount(T.pixels(a.canvas), 0, 0, 200, 200) > 100);
});
