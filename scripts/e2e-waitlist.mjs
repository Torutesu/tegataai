#!/usr/bin/env node
/**
 * The form, the policy and the server, together, in a browser.
 *
 * Everything else about the waitlist is tested with the server called directly, which
 * never crosses an origin, never applies site/_headers and never loads waitlist.js. The
 * mistakes that survive that gap are the ones that only show up in a browser:
 * TEGATA_SITE_ORIGINS not naming the site, the policy refusing the request, the script
 * served under a content type that stops it being a module (the form then navigates to
 * the API's JSON instead of showing anything).
 *
 * So this runs the real server built by main.ts, serves site/ under its real headers,
 * and presses the button.
 *
 *   node scripts/e2e-waitlist.mjs
 */
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('../site/', import.meta.url).pathname;
const API_PORT = 8791;
const ALLOWED_PORT = 8792;   // named in TEGATA_SITE_ORIGINS
const STRANGER_PORT = 8793;  // not named — the same pages served from the wrong place
const API = `http://127.0.0.1:${API_PORT}`;
const ALLOWED = `http://127.0.0.1:${ALLOWED_PORT}`;
const STRANGER = `http://127.0.0.1:${STRANGER_PORT}`;

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.js': 'text/javascript', '.xml': 'application/xml', '.txt': 'text/plain' };

// site/_headers, read the way the host reads it: a path pattern, then indented headers.
const rules = [];
let current = null;
for (const line of readFileSync(join(ROOT, '_headers'), 'utf8').split('\n')) {
  if (line.trim() === '' || line.trim().startsWith('#')) continue;
  if (!line.startsWith(' ')) { current = { pattern: line.trim(), headers: {} }; rules.push(current); continue; }
  const i = line.indexOf(':');
  current.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const matches = (pattern, url) => {
  if (pattern.endsWith('/*')) return url.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('/*.')) return url.endsWith(pattern.slice(2));
  return pattern === url;
};

/**
 * The published site, except that the API it posts to is this machine. The policy has to
 * be rewritten the same way — a page that may only reach api.tegata.ai cannot reach a
 * local port, and the refusal would look like the server being down.
 */
const serveSite = (port) => createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, p);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('nope'); return; }
  const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
  for (const rule of rules) if (matches(rule.pattern, p)) Object.assign(headers, rule.headers);
  for (const [k, v] of Object.entries(headers)) headers[k] = v.replaceAll('https://api.tegata.ai', API);
  let body = readFileSync(file);
  if (file.endsWith('.html') || file.endsWith('.js')) {
    body = Buffer.from(String(body).replaceAll('https://api.tegata.ai', API));
  }
  res.writeHead(200, headers).end(body);
}).listen(port, '127.0.0.1');

/** Something is listening there — ours or, worse, someone else's. */
const inUse = (port) => new Promise((resolve) => {
  const probe = createConnection({ port, host: '127.0.0.1' });
  probe.on('connect', () => { probe.destroy(); resolve(true); });
  probe.on('error', () => resolve(false));
});

const dir = mkdtempSync(join(tmpdir(), 'tegata-e2e-'));
const db = join(dir, 'e2e.db');
const cleanup = [];
let failures = 0;
const check = (ok, message) => {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${message}\n`);
  if (!ok) failures += 1;
};

try {
  // Anything already answering here is not ours, and talking to it would produce a run
  // that looks almost right: the form works, the database never moves. Stop instead.
  for (const [name, port] of [['api', API_PORT], ['site', ALLOWED_PORT], ['site', STRANGER_PORT]]) {
    if (await inUse(port)) throw new Error(`port ${port} (${name}) is already in use — a server from an earlier run is still up`);
  }

  const boot = spawnSync(process.execPath, ['--import', 'tsx', 'packages/server/src/cli.ts', 'bootstrap', 'e2e'],
    { env: { ...process.env, TEGATA_DB: db }, encoding: 'utf8' });
  if (boot.status !== 0) throw new Error(`bootstrap failed: ${boot.stderr}`);
  // The key is printed twice — once in the table, once in an export line. Take the table's.
  const key = /^secret key\s+(\S+)$/m.exec(boot.stdout)?.[1];
  if (key === undefined) throw new Error('could not read the secret key from bootstrap');

  /**
   * One process, not a chain. Started through `npx` this is npx → sh → tsx → node, and
   * signalling what we spawned leaves the node at the end of it running: that is exactly
   * how the stale server the port check now catches came to exist. `node --import tsx`
   * is the same server with nothing in front of it, so killing the child kills it.
   */
  const server = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/main.ts'], {
    env: {
      ...process.env,
      TEGATA_DB: db,
      PORT: String(API_PORT),
      TEGATA_SITE_ORIGINS: ALLOWED,   // deliberately not STRANGER
      TEGATA_WAITLIST_RPM: '0',       // throttling is covered by its own tests
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.push(async () => {
    const ended = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    // It waits for open connections before exiting, and a browser that has just gone
    // away can leave one. Do not wait on that politeness.
    const grace = setTimeout(() => server.kill('SIGKILL'), 2000);
    await ended;
    clearTimeout(grace);
    if (await inUse(API_PORT)) throw new Error(`something is still listening on ${API_PORT}`);
  });
  server.stderr.on('data', (d) => process.stderr.write(`  server: ${d}`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('the server never became healthy');
    await new Promise((r) => setTimeout(r, 200));
  }

  const sites = [serveSite(ALLOWED_PORT), serveSite(STRANGER_PORT)];
  cleanup.push(() => { for (const s of sites) s.close(); });

  const browser = await chromium.launch(
    process.env.CHROME_PATH === undefined ? {} : { executablePath: process.env.CHROME_PATH },
  );
  cleanup.push(() => browser.close());

  const count = async () => {
    const res = await fetch(`${API}/v1/waitlist/count`, { headers: { authorization: `Bearer ${key}` } });
    // Reached by our key or not at all: this is what caught a stale server from an
    // earlier run still holding the port and answering with a database of its own.
    if (!res.ok) throw new Error(`the count endpoint answered ${res.status} — is this our server?`);
    return (await res.json()).count;
  };

  /** Fills the form, presses the button, and reports what the page ends up saying. */
  const submit = async (origin, email, { script = true } = {}) => {
    const page = await (await browser.newContext({ javaScriptEnabled: script })).newPage();
    const refusals = [];
    const answers = [];
    page.on('console', (m) => { if (/Refused to|Content Security Policy/.test(m.text())) refusals.push(m.text()); });
    const blocked = [];
    page.on('response', (r) => { if (r.url().startsWith(`${API}/v1/waitlist`)) answers.push(r.status()); });
    // A refusal the browser will not let the page read never arrives as a response.
    page.on('requestfailed', (r) => { if (r.url().startsWith(`${API}/v1/waitlist`)) blocked.push(r.failure()?.errorText ?? 'failed'); });
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await page.fill('input[type=email]', email);
    if (!script) {
      // No script means no banner: the browser navigates to whatever the API says.
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }).catch(() => {}),
        page.click('form.waitlist button[type=submit]'),
      ]);
      const landed = { said: (await page.textContent('body')) ?? '', url: page.url(), refusals, answers, blocked };
      await page.close();
      return landed;
    }
    await page.click('form.waitlist button[type=submit]');
    await page.waitForFunction(
      () => (document.querySelector('.form-status')?.textContent ?? '').length > 0
        && document.querySelector('.form-status').textContent !== 'Sending…',
      undefined, { timeout: 20_000 },
    ).catch(() => {});
    const said = await page.evaluate(() => document.querySelector('.form-status')?.textContent ?? '');
    const url = page.url();
    await page.close();
    return { said, url, refusals, answers, blocked };
  };

  process.stdout.write('\nthe form, end to end\n');

  /**
   * Each scenario is measured against the count just before it, so a scenario can be
   * added or reordered without every later number in the file being wrong.
   */
  let seen = await count();
  const stored = async (n, message) => {
    const now = await count();
    check(now === seen + n, `${message} — the count moved by ${now - seen}, expected ${n}`);
    seen = now;
  };
  const good = await submit(ALLOWED, 'founder@example.com');

  check(good.refusals.length === 0, `no policy refusals while submitting${good.refusals[0] ? ` — ${good.refusals[0].slice(0, 120)}` : ''}`);
  // If waitlist.js had not loaded and run, the form would have navigated to the API.
  check(good.url.startsWith(ALLOWED), 'the page stayed put, so the script loaded and ran');
  check(good.answers.join(',') === '202', `the API answered 202, once — got [${good.answers.join(', ')}]`);
  check(good.said.startsWith('You are on the list'), `the confirmation appeared — "${good.said}"`);
  await stored(1, 'the address reached the database');

  // The page carries its own locale in a hidden field now, so this is the check that
  // the field is actually there and reaches the store — on the Japanese page too.
  const ja = await browser.newContext();
  const jaPage = await ja.newPage();
  await jaPage.goto(`${ALLOWED}/ja/`, { waitUntil: 'load' });
  await jaPage.fill('input[type=email]', 'nihongo@example.com');
  await jaPage.click('form.waitlist button[type=submit]');
  await jaPage.waitForFunction(
    () => (document.querySelector('.form-status')?.textContent ?? '').length > 0
      && document.querySelector('.form-status').textContent !== '送信中…',
    undefined, { timeout: 20_000 },
  ).catch(() => {});
  await ja.close();

  const csv = await (await fetch(`${API}/v1/waitlist/export`,
    { headers: { authorization: `Bearer ${key}` } })).text();
  await stored(1, 'the Japanese page stored its address');
  const jaRow = csv.split('\n').find((l) => l.includes('nihongo@example.com')) ?? '';
  check(jaRow.includes('ja'), `the Japanese page recorded its own locale — "${jaRow.trim()}"`);
  check(jaRow.includes('site'), 'and its source');

  process.stdout.write('\nthe same pages, served from an origin the server does not know\n');

  const stranger = await submit(STRANGER, 'stranger@example.com');
  // The server answers 403 without any CORS header, so the browser never hands the
  // response to the page: from here the refusal is visible as a blocked request.
  check(stranger.answers.length === 0 && stranger.blocked.length === 1,
    `the browser was not allowed to read a reply — responses [${stranger.answers.join(', ')}], blocked [${stranger.blocked.join(', ')}]`);
  check(stranger.said.length > 0 && !stranger.said.startsWith('You are on the list'),
    `the form said something other than success — "${stranger.said}"`);
  await stored(0, 'nothing was stored for it');
  process.stdout.write('\nthe same page with no script behind it\n');

  const nojs = await submit(ALLOWED, 'nojs@example.com', { script: false });
  check(nojs.answers.join(',') === '202', `the API accepted the plain form post — got [${nojs.answers.join(', ')}]`);
  check(nojs.said.includes('You are on the list'), `the page it landed on says so — "${nojs.said.trim().slice(0, 60)}"`);
  await stored(1, 'that address reached the database too');

} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* going away anyway */ } }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  process.stderr.write(`\ne2e FAILED — ${failures} check(s)\n`);
  process.exit(1);
}
process.stdout.write('\ne2e ok — the real form reaches the real server, and only from an origin it names\n');
process.exit(0);
