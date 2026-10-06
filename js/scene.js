// Double-exposure scene: suspension bridge receding into mist + lattice power
// pylons, painted far→near in indigo / grey-blue wash, then clipped to the mask.
window.SUMI = window.SUMI || {};
(function (S) {
  const scene = S.scene = {};
  const INDIGO = '#2b3a4a', GREY = '#5a6d7e', WHITE = '#ffffff';
  const lerp = (a, b, t) => a + (b - a) * t;

  // parabola from p to q sagging `sag` px below the chord at its middle
  const sagCurve = (p, q, sag, n = 24) => Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return { x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) + sag * 4 * t * (1 - t) };
  });

  scene.bridgeGeometry = (box, rng) => {
    const vp = { x: box.x + box.w * rng.range(0.05, 0.3), y: box.y + box.h * rng.range(0.45, 0.6) };
    const nearX = box.x + box.w * rng.range(0.92, 1.08);
    const nearY = vp.y - box.h * rng.range(0.12, 0.25);
    const thick = box.h * 0.025;
    const deckY = s => lerp(nearY, vp.y, s);
    const at = s => lerp(nearX, vp.x, s); // s: 0 = near end, 1 = vanishing point

    // world-evenly spaced towers → perspective fractions bunching toward vp
    const count = rng.int(2, 3), s0 = rng.range(0.18, 0.3), gap = rng.range(0.8, 1.4);
    const fr = Array.from({ length: count }, (_, i) => 1 - (1 - s0) / (1 + gap * i));
    const H0 = Math.min(box.h * rng.range(0.35, 0.5), (deckY(s0) - box.y) * 0.95 / (1 - s0));
    const towers = fr.map(s => {
      const h = H0 * (1 - s);
      return { x: at(s), yTop: deckY(s) - h, yDeck: deckY(s), w: h * 0.12, s };
    }).reverse(); // far → near

    const cables = [], suspenders = [];
    for (const side of [-0.35, 0.35]) {
      const tops = towers.map(t => ({ x: t.x + side * t.w, y: t.yTop }));
      const far = towers[0], near = towers[towers.length - 1];
      const spans = [];
      // back span toward the vanishing point, main spans between towers, side span to the near anchorage
      spans.push(sagCurve({ x: lerp(far.x, vp.x, 0.6), y: deckY(lerp(far.s, 1, 0.6)) - 2 }, tops[0], (far.yDeck - far.yTop) * 0.1));
      for (let i = 0; i < tops.length - 1; i++) {
        const a = towers[i], b = towers[i + 1];
        spans.push(sagCurve(tops[i], tops[i + 1], ((a.yDeck - a.yTop) + (b.yDeck - b.yTop)) / 2 * 0.75));
      }
      spans.push(sagCurve(tops[tops.length - 1], { x: nearX, y: nearY - 2 }, (near.yDeck - near.yTop) * 0.12));
      for (const sp of spans) {
        cables.push(sp);
        for (let i = 1; i < sp.length - 1; i++) {
          const p = sp[i], s = (nearX - p.x) / (nearX - vp.x);
          if (s < 0 || s > 1) continue;
          if (deckY(s) - p.y > 2) suspenders.push([p, { x: p.x, y: deckY(s) }]);
        }
      }
    }
    return { vp, deck: { near: [{ x: nearX, y: nearY }, { x: nearX, y: nearY + thick }], far: vp }, towers, cables, suspenders };
  };

  scene.pylonGeometry = (base, height, rng) => {
    const baseW = height * rng.range(0.16, 0.22), topW = baseW * rng.range(0.18, 0.28);
    const topY = base.y - height;
    const legs = [
      [{ x: base.x - baseW / 2, y: base.y }, { x: base.x - topW / 2, y: topY }],
      [{ x: base.x + baseW / 2, y: base.y }, { x: base.x + topW / 2, y: topY }],
    ];
    const legX = (leg, y) => lerp(leg[0].x, leg[1].x, (base.y - y) / height);
    // bracing levels get closer together toward the top
    const n = rng.int(7, 11), r = 0.85;
    const levels = Array.from({ length: n + 1 }, (_, k) => base.y - height * (1 - Math.pow(r, k)) / (1 - Math.pow(r, n)));
    const braces = [];
    for (let k = 0; k < n; k++) {
      const y0 = levels[k], y1 = levels[k + 1];
      const l0 = { x: legX(legs[0], y0), y: y0 }, r0 = { x: legX(legs[1], y0), y: y0 };
      const l1 = { x: legX(legs[0], y1), y: y1 }, r1 = { x: legX(legs[1], y1), y: y1 };
      braces.push([l0, r1], [r0, l1], [l1, r1]);
    }
    const armCount = rng.int(2, 3), arms = [], wires = [];
    const side = rng.chance(0.5) ? 1 : -1;
    for (let a = 0; a < armCount; a++) {
      const y = base.y - height * (0.72 + 0.1 * a);
      const half = topW * rng.range(1.8, 3) * (1 - 0.15 * a);
      const arm = { y, x0: base.x - half, x1: base.x + half };
      arms.push(arm);
      for (const tx of [arm.x0, arm.x1]) {
        const tip = { x: tx, y: y + height * 0.03 }; // insulator hang
        const span = height * rng.range(0.9, 1.6);
        const end = { x: tip.x + side * span, y: tip.y + height * rng.range(-0.05, 0.12) };
        wires.push(sagCurve(tip, end, span * rng.range(0.06, 0.12), 20));
      }
    }
    const peak = { x: base.x, y: topY - height * 0.08 };
    return { legs, braces, arms, wires, peak, base, height };
  };

  function quad(ctx, a, b, c, d) {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();
  }
  function polyline(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  const wash = (ctx, rng, x, y, r, layers, color, opacity) =>
    S.ink.washBlob(ctx, rng, x, y, r, layers, { color, opacity });

  function drawBridge(ctx, rng, g, box) {
    const rgba = S.ink.rgba;
    const [nt, nb] = g.deck.near;
    // deck: thin wedge into the vanishing point, darker underside
    ctx.fillStyle = rgba(GREY, 0.55);
    quad(ctx, nt, nb, { x: g.vp.x, y: g.vp.y + 1 }, { x: g.vp.x, y: g.vp.y });
    ctx.fillStyle = rgba(INDIGO, 0.4);
    quad(ctx, { x: nb.x, y: nb.y - (nb.y - nt.y) * 0.35 }, nb, { x: g.vp.x, y: g.vp.y + 1 }, { x: g.vp.x, y: g.vp.y + 0.6 });

    ctx.lineCap = 'round';
    for (const t of g.towers) {
      const depth = 1 - t.s * 0.6, h = t.yDeck - t.yTop;
      wash(ctx, rng, t.x, t.yTop + h * 0.5, h * 0.35, 6, GREY, 0.35 * depth);
      const lw = Math.max(1.2, t.w * 0.18), pier = h * 0.25;
      ctx.fillStyle = rgba(INDIGO, 0.75 * depth);
      for (const side of [-0.5, 0.5]) {
        const x = t.x + side * t.w;
        quad(ctx, { x: x - lw / 2, y: t.yTop }, { x: x + lw / 2, y: t.yTop },
          { x: x + lw * 0.65, y: t.yDeck + pier }, { x: x - lw * 0.65, y: t.yDeck + pier });
      }
      const beams = rng.int(2, 3);
      for (let b = 0; b < beams; b++) {
        const y = t.yTop + h * (0.02 + b * 0.32);
        ctx.fillRect(t.x - t.w * 0.5, y, t.w, Math.max(1, lw * 0.6));
      }
    }
    for (const c of g.cables) {
      const s = Math.min(1, Math.max(0, (g.deck.near[0].x - c[c.length >> 1].x) / (g.deck.near[0].x - g.vp.x)));
      ctx.strokeStyle = rgba(INDIGO, 0.7 * (1 - s * 0.5));
      ctx.lineWidth = 0.5 + 1.1 * (1 - s);
      polyline(ctx, c);
    }
    ctx.strokeStyle = rgba(INDIGO, 0.3);
    ctx.lineWidth = 0.5;
    for (const [a, b] of g.suspenders) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  }

  function drawPylon(ctx, rng, g, k) {
    const rgba = S.ink.rgba;
    const [L, R] = g.legs;
    ctx.fillStyle = rgba(GREY, 0.12 * k);
    quad(ctx, L[0], R[0], R[1], L[1]);
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(INDIGO, 0.8 * k);
    ctx.lineWidth = 1.2;
    polyline(ctx, L); polyline(ctx, R);
    polyline(ctx, [L[1], g.peak, R[1]]);
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = rgba(INDIGO, 0.55 * k);
    for (const [a, b] of g.braces) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(INDIGO, 0.75 * k);
    for (const a of g.arms) {
      const drop = g.height * 0.03;
      polyline(ctx, [{ x: a.x0, y: a.y }, { x: a.x1, y: a.y }]);
      polyline(ctx, [{ x: a.x0, y: a.y }, { x: g.base.x, y: a.y + drop * 2 }, { x: a.x1, y: a.y }]);
      for (const x of [a.x0, a.x1]) polyline(ctx, [{ x, y: a.y }, { x, y: a.y + drop }]);
    }
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = rgba(INDIGO, 0.45 * k);
    for (const w of g.wires) polyline(ctx, w);
  }

  scene.render = (ctx, rng, noise, box) => {
    // pale sky wash in the upper part
    const skies = rng.int(4, 7);
    for (let i = 0; i < skies; i++) {
      wash(ctx, rng, box.x + box.w * rng.range(0.1, 0.9), box.y + box.h * rng.range(0.05, 0.55),
        Math.max(8, box.w * rng.range(0.15, 0.28)), 16, GREY, 0.25);
    }
    const bridge = scene.bridgeGeometry(box, rng);

    // far pylon sits behind the bridge, near/main ones in front of it
    const pylonCount = rng.int(1, 3), pylons = [];
    const main = scene.pylonGeometry(
      { x: box.x + box.w * rng.range(0.6, 0.85), y: box.y + box.h * rng.range(0.55, 0.7) }, box.h * rng.range(0.45, 0.65), rng);
    if (pylonCount >= 3) {
      const far = scene.pylonGeometry({ x: box.x + box.w * rng.range(0.1, 0.35), y: bridge.vp.y + box.h * 0.05 },
        box.h * rng.range(0.15, 0.25), rng);
      pylons.push(far); drawPylon(ctx, rng, far, 0.45);
    }
    // fog between far things and the bridge
    for (let i = 0; i < 3; i++) {
      wash(ctx, rng, lerp(bridge.vp.x, box.x + box.w, rng.next()), bridge.vp.y + box.h * rng.range(0, 0.08),
        Math.max(8, box.w * rng.range(0.12, 0.22)), 10, WHITE, 0.6);
    }
    drawBridge(ctx, rng, bridge, box);
    if (pylonCount >= 2) {
      const second = scene.pylonGeometry({ x: main.base.x + main.height * rng.range(0.35, 0.6), y: main.base.y + box.h * 0.04 },
        main.height * rng.range(0.6, 0.85), rng);
      pylons.push(second); drawPylon(ctx, rng, second, 0.7);
    }
    pylons.push(main); drawPylon(ctx, rng, main, 1);

    // mist band under the deck: grey cloud shadow, then white cotton hiding the piers
    const deckLow = Math.max(bridge.deck.near[1].y, bridge.vp.y);
    const clouds = rng.int(10, 20);
    for (let i = 0; i < clouds; i++) {
      const x = box.x + box.w * rng.range(-0.05, 1.05), y = deckLow + box.h * rng.range(0.02, 0.22);
      const r = Math.max(8, box.w * rng.range(0.06, 0.16));
      wash(ctx, rng, x, y + r * 0.35, r, 8, GREY, 0.35);
      wash(ctx, rng, x, y, r * 0.9, 12, WHITE, 0.9);
    }
    return { bridge, pylons };
  };

  scene.clipToMask = (sceneCtx, maskCanvas, feather) => {
    const c = sceneCtx.canvas, W = c.width, H = c.height;
    const dpr = sceneCtx.getTransform().a || 1;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    if (feather > 0 && 'filter' in t) t.filter = `blur(${(feather / 2) * dpr}px)`;
    t.drawImage(maskCanvas, 0, 0, W, H);
    sceneCtx.save();
    sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
    sceneCtx.globalCompositeOperation = 'destination-in';
    sceneCtx.drawImage(tmp, 0, 0);         // soft fade toward the silhouette edge
    sceneCtx.drawImage(maskCanvas, 0, 0, W, H); // hard clip: nothing leaks outside
    sceneCtx.restore();
  };
})(window.SUMI);
