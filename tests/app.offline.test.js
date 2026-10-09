// The app must keep working offline from file:// (its panel uses fonts already on the
// computer), so nothing it loads may come from the network. Helpers (app) come from
// app.smoke.test.js.
(() => {
  const REMOTE = /^(https?:)?\/\//i;
  const rulesOf = (list, out = []) => {
    for (const r of list) { out.push(r); if (r.cssRules) rulesOf(r.cssRules, out); } // @media, @supports…
    return out;
  };

  T.test('app: loads nothing from the network: relative scripts and styles, no web fonts', async () => {
    const a = await app(), d = a.w.document;
    for (const el of d.querySelectorAll('link[href], script[src]')) {
      const ref = el.getAttribute(el.tagName === 'LINK' ? 'href' : 'src');
      T.assert(!REMOTE.test(ref), `${el.tagName.toLowerCase()} loads ${ref}`);
    }
    T.assert(d.styleSheets.length > 0, 'the stylesheet loaded');
    for (const sheet of d.styleSheets) {
      for (const rule of rulesOf(sheet.cssRules)) {
        T.assert(!(rule instanceof a.w.CSSImportRule), '@import: ' + rule.cssText);
        T.assert(!(rule instanceof a.w.CSSFontFaceRule), '@font-face: ' + rule.cssText);
        // where each url() points; a data: URI may mention http:// inside (an SVG namespace)
        for (const m of rule.cssText.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g)) {
          const target = (m[1] ?? m[2] ?? m[3]).trim();
          T.assert(target.startsWith('data:') || !REMOTE.test(target), 'url() loads ' + target);
        }
      }
    }
  });
})();
