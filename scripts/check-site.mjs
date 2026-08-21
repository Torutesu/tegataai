#!/usr/bin/env node
/**
 * The things a person forgets between testing locally and publishing. Each of these has
 * already happened once in this repository, which is why they are checked rather than
 * listed in a runbook.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const pages = [...walk('site')].filter((f) => f.endsWith('.html'));
check(pages.length >= 4, `expected at least 4 pages, found ${pages.length}`);

for (const page of pages) {
  const html = readFileSync(page, 'utf8');

  // A local endpoint left behind after testing points the form at nothing.
  check(!/127\.0\.0\.1|localhost:\d+/.test(html), `${page}: a local address is still in the page`);

  // A form must post somewhere real.
  for (const [, action] of html.matchAll(/<form[^>]*\saction="([^"]*)"/g)) {
    check(action !== '#' && action.length > 1, `${page}: form action is a placeholder (${action})`);
  }

  check(!/TODO\(launch\)/.test(html), `${page}: a launch TODO is still in the page`);

  // The tool runs under its own policy, which permits the inline code it is made of and
  // forbids it from reaching anything. The marketing pages run under the strict one.
  if (page.startsWith(join('site', 'tool'))) continue;

  check(!/\sstyle="/.test(html), `${page}: inline style attribute — the CSP will refuse it`);
  // A JSON-LD block is data the browser never executes, so the policy does not touch it.
  const executable = [...html.matchAll(/<script([^>]*)>/g)]
    .map((m) => m[1] ?? '')
    .filter((attrs) => !/type="application\/ld\+json"/.test(attrs));
  for (const attrs of executable) {
    check(/\ssrc=/.test(attrs), `${page}: inline script — the CSP will refuse it`);
  }
}

const headers = readFileSync('site/_headers', 'utf8');
check(!/127\.0\.0\.1|localhost/.test(headers), '_headers still allows a local origin');

// The tool is inline by design; what matters is that its policy still forbids the
// network and still permits the code it is actually made of.
const toolPolicy = (/^\/tool\/\*\n(?:\s+.*\n)*/m.exec(headers) ?? [''])[0];
check(/connect-src 'none'/.test(toolPolicy), "the /tool/ policy no longer forbids the network");
check(/script-src[^;]*'unsafe-inline'/.test(toolPolicy), 'the /tool/ policy would refuse the tool it serves');
check(/style-src[^;]*'unsafe-inline'/.test(toolPolicy), 'the /tool/ policy would refuse the tool it serves');

// The tool's promise is that it cannot reach the network. Two copies must not drift.
const shipped = readFileSync('site/tool/index.html', 'utf8');
const source = readFileSync('tools/margin-diagnostic/index.html', 'utf8');
check(shipped === source, 'site/tool/index.html has drifted from tools/margin-diagnostic/index.html');

/**
 * Whatever a form posts to must be allowed by the directives that govern posting to it.
 * Looking for the origin anywhere in the file would pass while connect-src pointed
 * somewhere else entirely, so each directive is read on its own.
 */
const directive = (policy, name) => {
  const found = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found === undefined ? null : found.slice(name.length + 1).trim().split(/\s+/);
};
const defaultPolicy = (/^\/\*\n(?:\s+.*\n)*/m.exec(headers) ?? [''])[0];
const cspLine = defaultPolicy.split('\n').find((l) => /Content-Security-Policy:/i.test(l)) ?? '';
const csp = cspLine.slice(cspLine.indexOf(':') + 1);

const actions = new Set(pages
  .filter((p) => !p.startsWith(join('site', 'tool')))
  .flatMap((p) => [...readFileSync(p, 'utf8')
    .matchAll(/<form[^>]*\saction="(https?:\/\/[^/"]+)/g)].map((m) => m[1])));

for (const origin of actions) {
  for (const name of ['connect-src', 'form-action']) {
    const values = directive(csp, name);
    check(values !== null && values.includes(origin),
      `the default policy's ${name} does not allow ${origin}, which a form posts to`);
  }
}

/**
 * The confirmation the person waits for cannot appear before the request completes, and
 * on a cross-origin form the browser will happily spend a whole extra round trip on a
 * preflight before it even sends that request. Only three content types avoid it. Going
 * back to application/json would silently put the preflight back and nothing would look
 * broken — it would just be slower — so it is checked here rather than remembered.
 */
const SAFELISTED = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'];
const script = readFileSync('site/waitlist.js', 'utf8');
for (const [, value] of script.matchAll(/'content-type':\s*'([^']+)'/g)) {
  check(SAFELISTED.some((t) => value.startsWith(t)),
    `waitlist.js posts as ${value}, which makes the browser preflight before it sends`);
}
check(/signal:/.test(script), 'waitlist.js has no deadline — a hung request leaves "Sending…" on screen');

// Connecting to the API costs DNS, TCP and TLS. Doing it while the page loads takes it
// off the path between the button and the confirmation.
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const form = /<form[^>]*\saction="(https?:\/\/[^/"]+)/.exec(html);
  if (form === null) continue;
  check(html.includes(`<link rel="preconnect" href="${form[1]}"`),
    `${page}: has a form posting to ${form[1]} but never preconnects to it`);
}

if (problems.length > 0) {
  console.error(`site check FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`site check ok — ${pages.length} pages, no local addresses, no inline style or script`);
