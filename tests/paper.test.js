// Paper colour: shard chips are cut from opts.paper, recorded with each stroke, so a replay never
// depends on whatever paper the page happens to have now.
(() => {
  const { base, makeCalls, play } = FIX;
  const W = 320, H = 220;
  const paint = (tool, opts) => {
    const rec = makeCalls(tool); rec.opts = opts;
    const c = T.canvas(W, H); play(c.ctx, rec); return T.hash(c.canvas);
  };

  T.test('paper: shard chips are cut from opts.paper; other brushes ignore it', () => {
    const old = base(); delete old.paper; // a stroke recorded before opts.paper existed
    T.eq(paint('shard', { ...base(), paper: '#f4f1ea' }), paint('shard', old), 'the default is the original paper');
    T.assert(paint('shard', { ...base(), paper: '#ff0000' }) !== paint('shard', old), 'a red paper makes red chips');
    for (const tool of FIX.TOOLS.filter(t => t !== 'shard')) T.eq(paint(tool, { ...base(), paper: '#ff0000' }), paint(tool, old), tool);
  });

  T.test('paper: the page-wide SUMI.PAPER no longer changes a stroke', () => {
    const had = 'PAPER' in SUMI, was = SUMI.PAPER, before = paint('shard', base());
    SUMI.PAPER = '#123456';
    try { T.eq(paint('shard', base()), before); } finally { if (had) SUMI.PAPER = was; else delete SUMI.PAPER; }
  });

  T.test('paper: opts.paper is validated and recorded; a shard replays with its own paper', () => {
    T.eq(SUMI.normalizeOpts({}).paper, '#f4f1ea');
    T.eq(SUMI.normalizeOpts({ paper: ' #abc ' }).paper, '#abc');
    let e = null; try { SUMI.normalizeOpts({ paper: 'notapaper' }); } catch (x) { e = x; }
    T.assert(e instanceof TypeError, 'a bad paper colour throws');
    const live = T.canvas(W, H);
    const pen = SUMI.recordStroke(live.ctx, { tool: 'shard', seed: 'p', opts: { ...base(), paper: '#d8e8f0' }, p0: { x: 40, y: 110 } });
    pen.dab();
    for (let i = 1; i < 40; i++) pen.move({ x: 40 + i * 6, y: 110 + Math.sin(i / 4) * 20 });
    const s = JSON.parse(JSON.stringify(pen.end()));
    T.eq(s.opts.paper, '#d8e8f0');
    const again = T.canvas(W, H); SUMI.replayStroke(again.ctx, s);
    T.eq(T.hash(again.canvas), T.hash(live.canvas));
  });
})();
