// The app's quality controls for spray and wash, its presets and the brush cost meter.
// Helpers (app, drag, line) come from app.smoke.test.js.
(() => {
  const KEYS = ['sprayDensity', 'sprayGap', 'washLayers', 'washDetail', 'washEdge'];
  const SLIDERS = { sprayDensity: 's-sprayDensity', sprayGap: 's-sprayGap', washLayers: 's-washLayers', washDetail: 's-washDetail', washEdge: 's-washEdge' };
  const activePreset = a => [...a.w.document.querySelectorAll('#qualityPresets button')].filter(b => b.classList.contains('on')).map(b => b.dataset.preset);

  T.test('app: quality starts at Balanced and every stroke records it', async () => {
    const a = await app(), Q = a.w.SUMI.QUALITY.balanced;
    T.eq(JSON.stringify(activePreset(a)), '["balanced"]');
    for (const k of KEYS) T.eq(a.app.S[k], Q[k], k);
    a.app.setTool('spray'); drag(a, line(100, 300, 400, 300));
    const s = a.app.strokes()[0];
    for (const k of KEYS) T.eq(s.opts[k], Q[k], 'recorded ' + k);
  });

  T.test('app: a quality slider changes the next stroke and the preset becomes custom', async () => {
    const a = await app(), d = a.w.document, el = d.getElementById('s-washLayers');
    el.value = '2'; el.dispatchEvent(new a.w.Event('input'));
    T.eq(a.app.S.washLayers, 2);
    T.eq(d.getElementById('v-washLayers').textContent, '2');
    T.eq(activePreset(a).length, 0, 'no preset matches');
    T.assert(/custom/i.test(d.getElementById('qualityName').textContent), 'shown as custom');
    a.app.setTool('wash'); drag(a, line(100, 300, 400, 300));
    T.eq(a.app.strokes()[0].opts.washLayers, 2);
  });

  T.test('app: preset buttons set every quality control', async () => {
    const a = await app(), d = a.w.document;
    for (const name of ['full', 'fast', 'balanced']) {
      d.querySelector(`#qualityPresets button[data-preset="${name}"]`).click();
      const Q = a.w.SUMI.QUALITY[name];
      for (const k of KEYS) T.eq(a.app.S[k], Q[k], `${name}: ${k}`);
      T.eq(JSON.stringify(activePreset(a)), JSON.stringify([name]));
      T.eq(+d.getElementById(SLIDERS.washDetail).value, Q.washDetail, `${name}: slider follows`);
    }
  });

  T.test('app: the cost meter measures the current brush and warns when it is heavy', async () => {
    const a = await app(), d = a.w.document, warn = d.getElementById('costWarn'), meter = d.getElementById('costMeter');
    a.app.setTool('spray');
    const cost = await a.app.measureCost();
    // the headless runner's clock stands still inside a task, so 0 ms is possible there
    T.assert(Number.isFinite(cost.ms) && cost.ms >= 0, 'measured ' + cost.ms);
    T.eq(cost.tool, 'spray');
    T.assert(['light', 'moderate', 'heavy'].includes(cost.level), cost.level);
    a.app.showCost(a.app.COST.heavy + 5);
    T.assert(!warn.hidden, 'warning shown');
    T.assert(meter.classList.contains('heavy'), 'meter marked heavy');
    T.assert(/spray/i.test(warn.textContent), 'the warning names what to lower: ' + warn.textContent);
    a.app.showCost(a.app.COST.light / 2);
    T.assert(warn.hidden, 'warning cleared');
    T.assert(meter.classList.contains('light'));
  });
})();
