// The app's paper colour: pearl white by default, swatches and a colour picker to change it.
// Helpers (app, drag, line) come from app.smoke.test.js.
(() => {
  const PEARL = '#f8f6f0';
  const hex = d => '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  const corner = a => { a.app.renderNow(); const b = a.board; return hex(b.getContext('2d').getImageData(3, b.height - 3, 1, 1).data); };

  T.test('app: the paper starts pearl white; swatches and the colour picker recolour it', async () => {
    const a = await app(), d = a.w.document;
    T.eq(a.app.S.paperColor, PEARL); T.eq(corner(a), PEARL);
    const kraft = d.querySelector('#paperSwatches button[data-paper="#e5d8c0"]');
    kraft.click();
    T.eq(a.app.S.paperColor, '#e5d8c0'); T.eq(corner(a), '#e5d8c0');
    T.assert(kraft.classList.contains('active') && kraft.getAttribute('aria-pressed') === 'true', 'swatch marked');
    const pick = d.getElementById('paperColor');
    pick.value = '#ddeeff'; pick.dispatchEvent(new a.w.Event('input'));
    T.eq(corner(a), '#ddeeff');
    T.assert(/#ddeeff/i.test(d.getElementById('paperHex').textContent), d.getElementById('paperHex').textContent);
    T.eq(d.querySelectorAll('#paperSwatches button.active').length, 0, 'a custom colour matches no swatch');
  });

  T.test('app: strokes, recordings and the PNG carry the paper colour', async () => {
    const a = await app();
    a.app.setPaper('#e5d8c0');
    a.app.setTool('shard'); drag(a, line(100, 300, 400, 300));
    T.eq(a.app.strokes()[0].opts.paper, '#e5d8c0', 'the stroke records its paper');
    T.eq(SUMI.parseRecording(a.app.exportJSON()).paper, '#e5d8c0', 'the recording says which paper');
    const png = a.app.layers.exportCanvas(null, 'X');
    T.eq(hex(png.getContext('2d').getImageData(3, png.height - 3, 1, 1).data), '#e5d8c0', 'PNG paper');
  });
})();
