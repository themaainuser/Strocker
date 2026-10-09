// Seeded randomness. Every brush, scene and generator draw goes through
// these so the same seed always paints the same picture.
window.SUMI = window.SUMI || {};
(function sumiRng(S) {
  // a seed is a finite number or a string; anything else has an ambiguous string form (every
  // object would be '[object Object]', so all object seeds would paint alike)
  const checkSeed = seed => {
    if (typeof seed === 'string' || (typeof seed === 'number' && Number.isFinite(seed))) return seed;
    throw new TypeError('seed must be a finite number or a string, got ' + (typeof seed === 'number' ? seed : seed === null ? 'null' : typeof seed));
  };

  // FNV-1a over the seed's string form, then a murmur3 finalizer for avalanche
  S.hashSeed = function (seed) {
    const str = String(checkSeed(seed));
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  };

  S.makeRng = function (seed) {
    let a = S.hashSeed(seed);
    const next = () => { // mulberry32
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      range: (lo, hi) => lo + next() * (hi - lo),
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      chance: p => next() < p,
      gauss: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
      pick: arr => arr[Math.floor(next() * arr.length)],
    };
  };

  // value noise on a 256-cell lattice, smoothstep-interpolated, outputs in [0, 1]
  S.makeNoise = function (seed) {
    const rng = S.makeRng('noise:' + checkSeed(seed));
    const perm = new Uint8Array(256), vals = new Float32Array(256); // every lookup wraps at 256
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    perm.set(p);
    for (let i = 0; i < 256; i++) vals[i] = rng.next();

    const smooth = t => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const v1 = i => vals[perm[i & 255]];
    const v2 = (i, j) => vals[perm[(perm[i & 255] + j) & 255]];

    function n1(x) {
      const i = Math.floor(x), u = smooth(x - i);
      return lerp(v1(i), v1(i + 1), u);
    }
    function n2(x, y) {
      const i = Math.floor(x), j = Math.floor(y);
      const u = smooth(x - i), v = smooth(y - j);
      return lerp(lerp(v2(i, j), v2(i + 1, j), u), lerp(v2(i, j + 1), v2(i + 1, j + 1), u), v);
    }
    function fbm2(x, y, octaves = 4) {
      let sum = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < octaves; o++) {
        sum += amp * n2(x * f + o * 17.13, y * f + o * 31.71);
        norm += amp; amp *= 0.5; f *= 2;
      }
      return sum / norm;
    }
    return { n1, n2, fbm2 };
  };
  // export.js inlines this function's own source into standalone HTML files
  (S.modules || (S.modules = {})).rng = sumiRng;
})(window.SUMI);
