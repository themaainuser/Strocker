T.test('rng: same seed → same sequence', () => {
  const a = SUMI.makeRng('eclipse'), b = SUMI.makeRng('eclipse');
  for (let i = 0; i < 100; i++) T.eq(a.next(), b.next(), 'step ' + i);
});
T.test('rng: different seeds differ', () => {
  const a = SUMI.makeRng('eclipse'), b = SUMI.makeRng('bridge');
  let same = 0; for (let i = 0; i < 50; i++) if (a.next() === b.next()) same++;
  T.assert(same < 5, 'sequences too similar');
});
T.test('rng: next in [0,1), int inclusive', () => {
  const r = SUMI.makeRng(42), seen = new Set();
  for (let i = 0; i < 10000; i++) { const v = r.next(); T.assert(v >= 0 && v < 1, 'next ' + v); }
  for (let i = 0; i < 3000; i++) seen.add(r.int(1, 3));
  T.eq([...seen].sort().join(), '1,2,3');
});
T.test('rng: gauss ~ N(0,1)', () => {
  const r = SUMI.makeRng(7); let s = 0, s2 = 0; const n = 20000;
  for (let i = 0; i < n; i++) { const g = r.gauss(); s += g; s2 += g * g; }
  const m = s / n; T.near(m, 0, 0.05, 'mean'); T.near(Math.sqrt(s2 / n - m * m), 1, 0.05, 'sd');
});
T.test('hashSeed: stable uint32, distinguishes inputs', () => {
  T.eq(SUMI.hashSeed('eclipse'), SUMI.hashSeed('eclipse'));
  T.assert(SUMI.hashSeed('a') !== SUMI.hashSeed('b'));
  const h = SUMI.hashSeed(42); T.assert(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});
// String(seed) used to make every object seed the same '[object Object]' sequence
T.test('rng: a seed must be a finite number or a string', () => {
  for (const bad of [{}, { a: 1 }, [], null, undefined, NaN, Infinity, true]) {
    for (const [name, fn] of [['makeRng', SUMI.makeRng], ['makeNoise', SUMI.makeNoise], ['hashSeed', SUMI.hashSeed]]) {
      let err = null; try { fn(bad); } catch (e) { err = e; }
      T.assert(err instanceof TypeError, `${name}(${JSON.stringify(bad) ?? String(bad)})`);
    }
  }
  T.eq(typeof SUMI.makeRng(0).next(), 'number'); T.eq(typeof SUMI.makeNoise('').n1(0.5), 'number');
});
T.test('noise: range, continuity, determinism', () => {
  const n = SUMI.makeNoise(3), m = SUMI.makeNoise(3), r = SUMI.makeRng(1);
  for (let i = 0; i < 500; i++) {
    const x = r.range(-50, 50), y = r.range(-50, 50), v = n.n2(x, y);
    T.assert(v >= 0 && v <= 1, 'n2 range ' + v);
    T.assert(Math.abs(v - n.n2(x + 0.01, y)) < 0.05, 'n2 jump');
    T.assert(Math.abs(n.n1(x) - n.n1(x + 0.01)) < 0.05, 'n1 jump');
    T.eq(v, m.n2(x, y));
    const f = n.fbm2(x, y); T.assert(f >= 0 && f <= 1, 'fbm range ' + f);
  }
});
