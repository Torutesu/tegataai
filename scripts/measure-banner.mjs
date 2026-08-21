#!/usr/bin/env node
/**
 * How long the person waits between pressing "Join the waitlist" and reading the
 * confirmation. The server's own work is under a millisecond; what dominates is how many
 * times the browser has to go to the API and back. This measures that, by putting a
 * fixed delay in front of every reply and counting what the page actually pays.
 *
 * Both arms run the same page and the same server. The only difference is the content
 * type the form posts under — which is what decides whether the browser sends a
 * preflight OPTIONS and waits for it before sending the request the person is waiting on.
 *
 *   node scripts/measure-banner.mjs [--rtt 60] [--runs 5] [--out docs/plan/perf/...]
 *
 * Loopback has no DNS, no TCP handshake worth the name and no TLS, so the preconnect in
 * the page cannot show up here. This measures the preflight only; the connection setup
 * it also removes is real but is not a number this harness can honestly produce.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const RTTS = String(arg('rtt', '20,60,150')).split(',').map(Number);
let RTT_MS = RTTS[0];
const RUNS = Number(arg('runs', '5'));
const OUT = arg('out', 'docs/plan/perf/waitlist-banner.json');
const SITE_PORT = 4599;
const API_PORT = 4600;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The page, with the form pointed at the local API instead of the real one, and the
 * posted content type swapped out here rather than in the browser. Playwright's request
 * interception would have been the obvious way to patch the script, but turning it on
 * changes how the browser does CORS — with a route registered, the preflight is never
 * sent — so the measurement would have shown no difference between the arms and it would
 * have been the harness, not the page.
 */
let postAs = null;
const site = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file = join('site', path.endsWith('/') ? `${path}index.html` : path);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  if (file.endsWith('.html') || file.endsWith('.js')) {
    let text = String(body).replaceAll('https://api.tegata.ai', API);
    if (postAs !== null && file.endsWith('waitlist.js')) {
      text = text.replace(/'text\/plain;charset=UTF-8'/, `'${postAs}'`);
    }
    body = Buffer.from(text);
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
});

/**
 * Stands in for the API across a network. Every reply — the preflight included — waits
 * one round trip, which is the whole point: a preflight is not free, it is another trip.
 */
let requests = [];
const api = createServer(async (req, res) => {
  requests.push(req.method);
  await sleep(RTT_MS);
  const cors = {
    'access-control-allow-origin': SITE,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  req.resume();
  res.writeHead(202, { ...cors, 'content-type': 'application/json' }).end('{"ok":true}');
});

await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

const browser = await chromium.launch(
  process.env.CHROME_PATH === undefined ? {} : { executablePath: process.env.CHROME_PATH },
);

/**
 * One submission, from a browser that has never spoken to the API before — which is the
 * state the person is in the first time, and the only submission most of them make.
 */
async function once(contentType) {
  postAs = contentType;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${SITE}/`, { waitUntil: 'load' });
  requests = [];
  await page.fill('input[type=email]', 'founder@example.com');
  const started = await page.evaluate(() => performance.now());
  await page.click('form.waitlist button[type=submit]');
  await page.waitForFunction(
    () => document.querySelector('.form-status')?.textContent?.startsWith('You are on the list'),
    undefined, { timeout: 15_000 },
  );
  const elapsed = await page.evaluate((t) => performance.now() - t, started);
  await context.close();
  return { ms: Math.round(elapsed), trips: [...requests] };
}

const arms = [
  { name: 'text/plain (shipped)', contentType: null },
  { name: 'application/json (preflighted)', contentType: 'application/json' },
];

/**
 * Reported across several round trips rather than at one, because the saving is one
 * round trip: on a fast connection it is small and on a phone on mobile data it is most
 * of the wait. A single number would let anyone pick the one that flatters them.
 */
const results = [];
for (const rtt of RTTS) {
  RTT_MS = rtt;
  const arm_results = [];
  for (const a of arms) {
    const samples = [];
    for (let i = 0; i < RUNS; i += 1) samples.push(await once(a.contentType));
    const ms = samples.map((s) => s.ms).sort((x, y) => x - y);
    arm_results.push({
      arm: a.name,
      api_requests_per_submission: samples[0].trips,
      time_to_confirmation_ms: {
        min: ms[0], median: ms[(ms.length - 1) >> 1], max: ms[ms.length - 1],
      },
      samples: ms,
    });
  }
  const [shipped, before] = arm_results.map((r) => r.time_to_confirmation_ms.median);
  results.push({ simulated_rtt_ms: rtt, saved_ms: before - shipped, arms: arm_results });
  console.log(`rtt ${String(rtt).padStart(4)}ms   ${String(before).padStart(5)}ms → ${String(shipped).padStart(5)}ms   saved ${before - shipped}ms`);
}

const report = {
  measured_at: new Date().toISOString(),
  node: process.version,
  scope: 'Chromium against a local API with a fixed delay per reply. Loopback, so no DNS, TCP or TLS setup is included — the preconnect the page also does cannot show here.',
  runs_per_arm: RUNS,
  note: 'Both arms are the same page and the same server; only the posted content type differs. A preflight is a second round trip in front of the one the person is waiting on.',
  measurements: results,
};
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);

await browser.close();
site.close();
api.close();
