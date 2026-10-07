// Checks specific to the drop-in builds (dist/). Runs on dist.html (classic) and dist-esm.html.
(() => {
  const esm = window.DIST_ESM;

  T.test('dist: exposes the whole library API', () => {
    for (const k of ['hashSeed', 'makeRng', 'makeNoise', 'defaultOpts', 'normalizeOpts', 'makeStroke', 'recordStroke',
      'validateStroke', 'playback', 'replay', 'replayStroke']) T.eq(typeof SUMI[k], 'function', k);
    T.eq(typeof SUMI.brushes, 'object'); T.eq(typeof SUMI.ink, 'object');
    T.eq(SUMI.BRUSH_NAMES.length, 7);
    T.assert(SUMI.BRUSH_ENGINE >= 1 && SUMI.STROKE_FORMAT >= 2, 'versions');
  });

  T.test('dist: registers module sources, so js/export.js works on top of it', () => {
    for (const k of ['rng', 'brushes', 'recorder', 'playback']) T.eq(typeof SUMI.modules[k], 'function', k);
  });

  T.test('dist: ES module has no global and named exports match', () => {
    if (!esm) T.skip('classic build');
    T.eq(esm.leakedGlobal, false, 'importing created a global SUMI');
    T.eq(esm.named.default, esm.SUMI);
    for (const k of ['recordStroke', 'replay', 'replayStroke', 'playback', 'validateStroke', 'makeStroke', 'normalizeOpts',
      'defaultOpts', 'makeRng', 'makeNoise', 'hashSeed', 'brushes', 'ink', 'BRUSH_ENGINE', 'BRUSH_NAMES', 'STROKE_FORMAT', 'DEFAULT_WIND']) {
      T.eq(esm.named[k], esm.SUMI[k], k);
    }
  });

  T.test('dist: classic script defines the global on globalThis', () => {
    if (esm) T.skip('module build');
    T.eq(globalThis.SUMI, window.SUMI);
  });
})();
