// The Washi look (docs/superpowers/specs/2026-10-09-washi-ui-design.md): its colours, readable
// text on the cream panel, and the serif. Helpers (app) come from app.smoke.test.js.
(() => {
  const PANEL = 'rgb(242, 236, 224)', INK = 'rgb(27, 26, 23)', SEAL = 'rgb(179, 38, 30)';
  // a computed colour as [r, g, b, a] (0..255, alpha 0..1)
  function rgba(css) {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(css);
    T.assert(m, 'not an rgb() colour: ' + css);
    return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  }
  const luminance = ([r, g, b]) => {
    const f = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // WCAG contrast of a text colour over a background, with the text's alpha composited
  function contrast(fgCss, bgCss) {
    const [fr, fg, fb, fa] = rgba(fgCss), bg = rgba(bgCss);
    const fgOver = [fr * fa + bg[0] * (1 - fa), fg * fa + bg[1] * (1 - fa), fb * fa + bg[2] * (1 - fa)];
    const [hi, lo] = [luminance(fgOver), luminance(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  T.test("washi: the look's colours are set", async () => {
    const a = await app(), d = a.w.document, css = (el, pseudo) => a.w.getComputedStyle(el, pseudo);
    T.eq(css(d.getElementById('panel')).backgroundColor, PANEL, 'cream panel');
    T.eq(css(d.getElementById('panel')).color, INK, 'ink text');
    T.eq(css(d.getElementById('btnGenerate')).backgroundColor, SEAL, 'Generate is the seal');
    T.eq(css(d.querySelector('#brushGrid button.active')).backgroundColor, INK, 'the chosen brush is inked');
    T.eq(css(d.querySelector('.stamp'), '::before').backgroundColor, SEAL, 'the ECLIPSE stamp carries a seal');
  });

  T.test('washi: text on the panel keeps 4.5:1 contrast', async () => {
    const a = await app(), d = a.w.document;
    const check = (el, label) => {
      const ratio = contrast(a.w.getComputedStyle(el).color, PANEL);
      T.assert(ratio >= 4.5, `${label}: ${ratio.toFixed(2)}:1`);
    };
    for (const sel of ['.brand p', '.hint', '.ctl-head i', '.quality-name', '#paperHex', '.rec-head span', '#btnClear']) {
      check(d.querySelector(sel), sel);
    }
    const meter = d.getElementById('costMeter');
    for (const [ms, level] of [[1, 'light'], [a.app.COST.light + 1, 'moderate'], [a.app.COST.heavy + 1, 'heavy']]) {
      a.app.showCost(ms);
      T.assert(meter.classList.contains(level), 'meter level ' + level);
      check(meter, 'cost meter, ' + level);
    }
    check(d.querySelector('#costWarn .alert-title'), 'warning title');
    check(d.querySelector('#costWarn .alert-desc'), 'warning details');
    a.app.showCost(1);
  });

  // A selected button is inked with cream text: a hover style that repaints its background
  // would leave cream on cream. Scripts can't put an element in :hover, so each hover rule is
  // checked with :hover removed: it must not match a selected (.on / .active) button.
  T.test('washi: hovering a selected button keeps it inked', async () => {
    const a = await app(), d = a.w.document;
    const selected = [...d.querySelectorAll('#panel button.on, #panel button.active')];
    T.assert(selected.length >= 3, 'selected buttons to check: ' + selected.length); // brush, preset, paper grain
    let hoverRules = 0;
    for (const sheet of d.styleSheets) for (const rule of sheet.cssRules) {
      if (!rule.selectorText || !rule.selectorText.includes(':hover') || !rule.style.background && !rule.style.backgroundColor) continue;
      hoverRules++;
      for (const sel of rule.selectorText.split(',')) {
        if (!sel.includes(':hover')) continue;
        const resting = sel.replace(/:hover/g, '');
        for (const el of selected) T.assert(!el.matches(resting), `"${sel.trim()}" repaints the selected ${el.id || el.textContent.trim()}`);
      }
    }
    T.assert(hoverRules > 0, 'found the hover rules');
  });

  T.test('washi: the panel uses the serif already on the computer', async () => {
    const a = await app();
    const family = a.w.getComputedStyle(a.w.document.body).fontFamily;
    T.assert(family.startsWith('"Iowan Old Style"'), family);
  });
})();
