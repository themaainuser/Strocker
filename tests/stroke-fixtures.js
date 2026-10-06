// Shared fixtures: a stroke recorded as plain data (exactly the calls a live session
// makes), a player that replays those calls, and a "used canvas" helper.
window.FIX = (() => {
  const TOOLS = ['dry', 'spray', 'fine', 'lines', 'wash', 'shard', 'mask'];
  const base = () => ({ ...SUMI.defaultOpts(), color: '#000000', opacity: 1 });

  // full-precision floats on purpose: rounding must never be needed for identity
  function makeCalls(tool) {
    const p0 = { x: 40.123456789, y: 160.987654321 }, segs = [];
    let prev = p0, t = 0;
    for (let i = 1; i <= 60; i++) {
      const p = { x: p0.x + i * 3.7031, y: p0.y - i * 1.9177 + Math.sin(i / 7) * 4.1 };
      const w = 30 * (1 - 0.5 * i / 60) + 0.123;
      segs.push([prev.x, prev.y, p.x, p.y, w, Math.atan2(p.y - prev.y, p.x - prev.x), i / 60, 1 - 0.4 * i / 60, (t += 16.7)]);
      prev = p;
    }
    return { tool, seed: 0.7316247301, opts: base(), wind: -0.61, erase: false, p0, dab: true, dabAlpha: 1, segs, endAlpha: 1 };
  }

  function play(ctx, rec) {
    const b = SUMI.brushes[rec.tool], st = SUMI.makeStroke(ctx, rec.seed, rec.opts, rec.wind);
    st.erase = rec.erase;
    b.start(st, rec.p0);
    if (rec.dab) { st.alpha = rec.dabAlpha; b.dab(st, rec.p0); }
    for (const [ax, ay, bx, by, w, dir, speed, alpha] of rec.segs) {
      st.speed = speed; st.alpha = alpha;
      b.segment(st, { x: ax, y: ay }, { x: bx, y: by }, w, dir);
    }
    st.alpha = rec.endAlpha;
    b.end(st);
  }

  // every ctx property a brush could inherit from a host app or an earlier stroke
  function dirty(ctx) {
    ctx.lineCap = 'square'; ctx.lineJoin = 'bevel'; ctx.lineWidth = 7; ctx.miterLimit = 2;
    ctx.strokeStyle = '#123456'; ctx.fillStyle = '#654321'; ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = 'multiply';
    ctx.shadowColor = 'rgba(255,0,0,0.5)'; ctx.shadowBlur = 3; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 1;
    ctx.setLineDash([3, 2]); ctx.lineDashOffset = 1;
    ctx.filter = 'blur(1px)';
  }
  const STATE = ['lineCap', 'lineJoin', 'lineWidth', 'miterLimit', 'strokeStyle', 'fillStyle', 'globalAlpha',
    'globalCompositeOperation', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'lineDashOffset', 'filter'];
  const state = ctx => STATE.map(k => k + '=' + ctx[k]).join(';') + ';dash=' + ctx.getLineDash().join(',');

  return { TOOLS, base, makeCalls, play, dirty, state };
})();
