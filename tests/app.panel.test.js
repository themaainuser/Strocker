// The side panel: no sideways scrolling, and the technical extras behind Advanced.
// Helpers (app, drag, line) come from app.smoke.test.js.
(() => {
  T.test('app: the side panel never scrolls sideways, even with the stroke data open', async () => {
    const a = await app(), d = a.w.document, panel = d.getElementById('panel');
    d.getElementById('advanced').open = true;
    a.app.setTool('wash'); drag(a, line(100, 300, 600, 300)); // a long recorded stroke in the code box
    // neither the panel nor anything in it (the code box scrolls on its own) may scroll sideways
    for (const el of [panel, ...panel.querySelectorAll('*')]) {
      T.assert(el.scrollWidth <= el.clientWidth + 1 || a.w.getComputedStyle(el).overflowX === 'visible',
        `${el.tagName}${el.id ? '#' + el.id : ''}: ${el.scrollWidth} px of content in ${el.clientWidth} px`);
    }
  });

  T.test('app: stroke data and the activity log sit behind Advanced, closed by default', async () => {
    const a = await app(), d = a.w.document, adv = d.getElementById('advanced');
    const code = d.getElementById('codeOut'), logEl = d.getElementById('log');
    T.eq(adv.tagName, 'DETAILS');
    T.assert(!adv.open, 'closed by default');
    T.assert(adv.contains(code) && adv.contains(logEl), 'both inside Advanced');
    T.assert(!adv.contains(d.getElementById('btnExportJSON')), 'export buttons stay outside');
    a.app.setTool('dry'); drag(a, line(100, 300, 400, 300));
    T.assert(!code.checkVisibility(), 'stroke data hidden while closed');
    adv.querySelector('summary').click();
    T.assert(adv.open && code.checkVisibility() && logEl.checkVisibility(), 'shown when opened');
    T.assert(/dry/.test(logEl.textContent), 'the log lists the stroke: ' + logEl.textContent);
  });
})();
