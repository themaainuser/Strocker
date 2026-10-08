// Headless benchmark: serves the repo with cross-origin isolation (so performance.now() ticks
// in 5 µs steps, not 100 µs), opens bench/index.html in Edge/Chrome over the DevTools protocol
// in real time (no virtual time, unlike tests/run.mjs), and prints the report.
// Usage: node tools/bench.mjs [--json results.json]   (SUMI_BROWSER overrides the browser path)
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonOut = (i => (i >= 0 ? process.argv[i + 1] : null))(process.argv.indexOf('--json'));

const candidates = [
  process.env.SUMI_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'google-chrome',
  'chromium',
].filter(Boolean);
const available = c => {
  if (c.includes('/') || c.includes('\\')) return existsSync(c);
  try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
};
const browser = candidates.find(available);
if (!browser) { console.error('no Edge/Chrome found — set SUMI_BROWSER to a Chromium-based browser'); process.exit(1); }

// ---------- a static server that makes the page cross-origin isolated ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/bench/index.html`;

// ---------- the browser, driven over the DevTools protocol ----------
const profile = mkdtempSync(path.join(tmpdir(), 'sumi-bench-'));
const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let ws = null;
async function cleanup() {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: 1e9, method: 'Browser.close' })); } catch { /* closing anyway */ }
  await new Promise(r => { if (proc.exitCode !== null) r(); else { proc.once('exit', r); setTimeout(() => { proc.kill(); r(); }, 3000); } });
  server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold files */ }
}

try {
  const endpoint = await new Promise((res, rej) => {
    let buf = '';
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    proc.once('exit', code => rej(new Error('browser exited with ' + code)));
    setTimeout(() => rej(new Error('the browser gave no DevTools endpoint')), 30000);
  });
  ws = new WebSocket(endpoint);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to ' + endpoint)); });
  let nextId = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    const p = msg.id && pending.get(msg.id);
    if (p) { pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); }
    else listeners.forEach(fn => fn(msg));
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  listeners.push(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description).join(' ');
      if (text.startsWith('[bench]') || msg.params.type === 'error') process.stderr.write(text + '\n');
    }
    if (msg.method === 'Runtime.exceptionThrown') process.stderr.write('page error: ' + msg.params.exceptionDetails.text + '\n');
  });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.navigate', { url: pageUrl }, sessionId);
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; ; i++) { // until the page has started the benchmark
    if (await evaluate('location.href.includes("/bench/") && typeof window.SUMI_BENCH === "object"')) break;
    if (i > 100) throw new Error('the benchmark page did not start');
    await new Promise(r => setTimeout(r, 100));
  }
  const result = await evaluate('window.SUMI_BENCH');
  console.log(result.report);
  if (!result.env.crossOriginIsolated) console.error('warning: the page was not cross-origin isolated; timings are in 100 µs steps');
  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(result, null, 2)); console.error('wrote ' + jsonOut); }
} catch (err) {
  console.error('benchmark failed: ' + (err && err.message || err));
  process.exitCode = 1;
} finally {
  await cleanup();
}
