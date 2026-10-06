// Headless runner: opens tests.html in Edge/Chrome, prints failures + summary.
// Usage: node tests/run.mjs   (set SUMI_BROWSER to override the browser path)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the full suite, plus the brush library loaded on its own (rng.js + brushes.js only)
const pages = ['tests.html', 'tests/standalone.html'];

const candidates = [
  process.env.SUMI_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'google-chrome',
  'chromium',
].filter(Boolean);

function available(c) {
  if (c.includes('/') || c.includes('\\')) return existsSync(c);
  try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// a browser can be installed but broken (e.g. Edge mid-update returns an empty DOM),
// so pages fall through to the next candidate until one produces a summary
const browsers = candidates.filter(available);
if (!browsers.length) {
  console.error('no Edge/Chrome found — set SUMI_BROWSER to a Chromium-based browser');
  process.exit(1);
}

const decode = s => s.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// a fresh profile per launch: a shared one can be left locked by a crashed or updating browser
function dumpDom(browser, url) {
  const profile = mkdtempSync(path.join(tmpdir(), 'sumi-headless-'));
  try {
    return execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
      '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
      '--virtual-time-budget=20000', '--dump-dom', url,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return (e.stdout || '').toString();
  } finally {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
  }
}

function runPage(rel) {
  const url = pathToFileURL(path.join(root, rel)).href;
  let dom = '';
  while (browsers.length) {
    dom = dumpDom(browsers[0], url);
    if (dom.includes('id="summary" data-')) break;
    console.error(`[${rel}] no summary from ${browsers[0]} — trying the next browser`);
    browsers.shift();
  }
  for (const m of dom.matchAll(/<li class="(fail|skip)">([\s\S]*?)<\/li>/g)) {
    console.log((m[1] === 'fail' ? 'FAIL ' : 'SKIP ') + `[${rel}] ` + decode(m[2]));
  }
  const tag = dom.match(/<div id="summary"([^>]*)>([^<]*)<\/div>/);
  const attr = name => Number(tag && (tag[1].match(new RegExp(`${name}="(\\d+)"`)) || [])[1]);
  if (!tag || Number.isNaN(attr('data-failed'))) {
    console.error(`[${rel}] summary not found — page crashed or timed out`);
    return null;
  }
  console.log(`[${rel}] ${decode(tag[2])}`);
  return { passed: attr('data-passed'), failed: attr('data-failed'), skipped: attr('data-skipped') };
}

const total = { passed: 0, failed: 0, skipped: 0 };
let broken = false;
for (const rel of pages) {
  const r = runPage(rel);
  if (!r) { broken = true; continue; }
  for (const k in total) total[k] += r[k];
}
console.log(`${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped`);
process.exit(broken || total.failed > 0 ? 1 : 0);
