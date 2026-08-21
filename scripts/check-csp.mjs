#!/usr/bin/env node
/**
 * Loads every page with site/_headers actually applied and fails on any policy
 * violation. A Content-Security-Policy that nobody has loaded a page under is a
 * guess; this turns it into a test.
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../site/', import.meta.url).pathname;
const TYPES = { '.html':'text/html', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png',
  '.jpg':'image/jpeg', '.mp4':'video/mp4', '.js':'text/javascript', '.xml':'application/xml', '.txt':'text/plain' };

// Parse _headers the way the host does: a path pattern, then indented header lines.
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

const PORT = Number(process.env.CSP_PORT ?? 8081);

createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, p);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('nope'); return; }
  const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
  for (const rule of rules) if (matches(rule.pattern, p)) Object.assign(headers, rule.headers);
  res.writeHead(200, headers).end(readFileSync(file));
}).listen(PORT, '127.0.0.1', run);

const PAGES = ['/', '/ja/', '/agents.html', '/404.html', '/tool/?sample=200'];

async function run() {
  const base = `http://127.0.0.1:${PORT}`;
  // Use whatever chromium is already on the machine when one is provided, so this runs
  // in a sandbox that ships a browser as readily as it does in CI.
  const executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  let failures = 0;

  for (const path of PAGES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const violations = [];
    const errors = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(base + path, { waitUntil: 'networkidle' });
    if (path.startsWith('/tool')) await page.waitForSelector('#headline', { timeout: 15_000 });

    // Rendered, or blanked by the policy? Both look like "no error" without this.
    const rendered = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      text: document.body.innerText.trim().length,
      images: [...document.images].every((i) => i.complete && i.naturalWidth > 0),
      styled: getComputedStyle(document.querySelector('h1') ?? document.body).fontWeight,
    }));

    const broken = violations.length > 0 || errors.length > 0
      || rendered.text < 40 || !rendered.images
      || rendered.background === 'rgba(0, 0, 0, 0)';

    if (broken) failures++;
    process.stdout.write(`${path.padEnd(22)} ${broken ? 'BROKEN' : 'ok'}\n`);
    for (const v of violations.slice(0, 4)) process.stderr.write(`   CSP: ${v.slice(0, 180)}\n`);
    for (const e of errors.slice(0, 4)) process.stderr.write(`   ERR: ${e.slice(0, 180)}\n`);
    await page.close();
  }

  await browser.close();
  if (failures > 0) {
    process.stderr.write(`\ncsp check FAILED — ${failures} page(s) broken under site/_headers\n`);
    process.exit(1);
  }
  process.stdout.write(`\ncsp check ok — ${PAGES.length} pages load clean under the real headers\n`);
  process.exit(0);
}
