// Builds the drop-in files from the four core sources (no dependencies):
//   dist/sumi-brushes.js   classic script: <script src> → global SUMI (window, worker: globalThis)
//   dist/sumi-brushes.mjs  ES module: import SUMI, { recordStroke, … } — no global
// The sources are wrapped unchanged in one function that receives the namespace holder as
// `window`, so their `window.SUMI` lines land on globalThis (classic) or a private object (ESM).
//
//   node tools/build-dist.mjs           write dist/
//   node tools/build-dist.mjs --check   exit 1 if dist/ doesn't match the current sources
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCES = ['js/rng.js', 'js/brushes.js', 'js/recorder.js', 'js/playback.js'];
export const OUTPUTS = { classic: 'dist/sumi-brushes.js', module: 'dist/sumi-brushes.mjs' };
const EXPORTS = ['hashSeed', 'makeRng', 'makeNoise', 'DEFAULT_WIND', 'BRUSH_ENGINE', 'BRUSH_NAMES', 'defaultOpts',
  'normalizeOpts', 'makeStroke', 'ink', 'brushes', 'STROKE_FORMAT', 'validateStroke', 'recordStroke',
  'playback', 'replayStroke', 'replay'];

export function build() {
  const files = SOURCES.map(f => ({ f, src: readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n') }));
  const all = files.map(x => x.src).join('\n');
  const engine = (all.match(/S\.BRUSH_ENGINE = (\d+)/) || [])[1];
  const format = (all.match(/S\.STROKE_FORMAT = (\d+)/) || [])[1];
  if (!engine || !format) throw new Error('could not read BRUSH_ENGINE / STROKE_FORMAT from the sources');
  const hash = createHash('sha256').update(all).digest('hex').slice(0, 12);
  const banner = kind => `/*! SUMI brushes — drop-in ${kind}
 * Ink brushes (dry, spray, fine, lines, wash, shard, mask) + stroke recorder + replay.
 * Brush engine ${engine} · stroke format ${format} · sources ${hash}
 * Built by tools/build-dist.mjs from ${SOURCES.join(', ')} — edit those, not this file.
 * For pixel-identical replay, record and replay on canvases created with
 * getContext('2d', { willReadFrequently: true }). Docs: README.md "Drop-in file".
 */`;
  // verbatim (no re-indenting): template strings and toString() stay byte-identical to the sources
  const body = files.map(({ f, src }) => `// ---- ${f} ----\n${src.trimEnd()}`).join('\n\n');

  const classic = `${banner('build (classic script: global SUMI)')}
(function (window) {
${body}
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
  const module = `${banner('build (ES module: no global)')}
const scope = { SUMI: {} };
(function (window) {
${body}
})(scope);

const SUMI = scope.SUMI;
export default SUMI;
export const {
  ${EXPORTS.join(', ')},
} = SUMI;
`;
  return { [OUTPUTS.classic]: classic, [OUTPUTS.module]: module };
}

// which output files differ from a fresh build (missing counts as stale)
export function stale() {
  return Object.entries(build()).filter(([f, text]) => {
    const p = path.join(root, f);
    return !existsSync(p) || readFileSync(p, 'utf8').replace(/\r\n/g, '\n') !== text;
  }).map(([f]) => f);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) {
    const out = stale();
    if (out.length) { console.error('out of date: ' + out.join(', ') + ' — run node tools/build-dist.mjs'); process.exit(1); }
    console.log('dist/ is up to date');
  } else {
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    for (const [f, text] of Object.entries(build())) {
      writeFileSync(path.join(root, f), text);
      console.log(`wrote ${f} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`);
    }
  }
}
