// Headless runner: opens tests.html in Edge/Chrome, prints failures + summary.
// Usage: node tests/run.mjs   (set SUMI_BROWSER to override the browser path)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = pathToFileURL(path.join(root, 'tests.html')).href;

const candidates = [
  process.env.SUMI_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'google-chrome',
  'chromium',
].filter(Boolean);

function findBrowser() {
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) { if (existsSync(c)) return c; continue; }
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* not on PATH */ }
  }
  return null;
}

const browser = findBrowser();
if (!browser) {
  console.error('no Edge/Chrome found — set SUMI_BROWSER to a Chromium-based browser');
  process.exit(1);
}

const profile = path.join(tmpdir(), 'sumi-headless-profile');
mkdirSync(profile, { recursive: true });

let dom = '';
try {
  dom = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--virtual-time-budget=20000', '--dump-dom', page,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  dom = (e.stdout || '').toString();
}

const decode = s => s.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

for (const m of dom.matchAll(/<li class="(fail|skip)">([\s\S]*?)<\/li>/g)) {
  console.log((m[1] === 'fail' ? 'FAIL ' : 'SKIP ') + decode(m[2]));
}

const tag = dom.match(/<div id="summary"([^>]*)>([^<]*)<\/div>/);
const attr = name => tag && (tag[1].match(new RegExp(`${name}="(\\d+)"`)) || [])[1];
const failed = attr('data-failed');
if (!tag || failed === undefined) {
  console.error('summary not found — page crashed or timed out');
  process.exit(1);
}
console.log(decode(tag[2]));
process.exit(Number(failed) > 0 ? 1 : 0);
