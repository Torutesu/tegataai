#!/usr/bin/env node
/**
 * Run this against the live site once it is up. Everything it checks is something that
 * is fine in the repository and can still be wrong on the host: a header the host did
 * not apply, a content type that stops the script being a module, a policy pointing at
 * an API that is not the one serving, an origin list the API does not have.
 *
 *   node scripts/check-deployed.mjs https://tegata.ai https://api.tegata.ai
 *
 * Add --key sk_live_… to also check the reads that need a tenant key. Without it, those
 * are skipped and said to be skipped rather than passed.
 *
 * It signs no one up: the submission it makes fills the honeypot, so the API answers
 * exactly as it does for a person and stores nothing.
 */
const [site, api] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keyFlag = process.argv.indexOf('--key');
const key = keyFlag === -1 ? null : process.argv[keyFlag + 1];

if (site === undefined || api === undefined) {
  process.stderr.write('usage: node scripts/check-deployed.mjs <site-origin> <api-origin> [--key sk_live_…]\n');
  process.exit(2);
}
const SITE = site.replace(/\/$/, '');
const API = api.replace(/\/$/, '');

let failures = 0;
let skipped = 0;
const check = (ok, message) => {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${message}\n`);
  if (!ok) failures += 1;
};
const skip = (message) => { process.stdout.write(`  --   ${message}\n`); skipped += 1; };

const get = async (path, init) => {
  try { return await fetch(SITE + path, { redirect: 'manual', ...init }); } catch (e) { return { error: String(e) }; }
};
const directive = (policy, name) => {
  const found = (policy ?? '').split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found === undefined ? null : found.slice(name.length + 1).trim().split(/\s+/);
};

process.stdout.write(`\nthe pages\n`);

const home = await get('/');
check(home.status === 200, `the home page answers — ${home.status ?? home.error}`);
check((home.headers?.get('content-type') ?? '').includes('text/html'), 'as HTML');

/**
 * A module served under the wrong type is not executed and nothing says so: the form
 * still renders, still submits, and the person lands on the API's reply instead of a
 * confirmation. It is the failure this deployment is most likely to have.
 */
const script = await get('/waitlist.js');
const scriptType = script.headers?.get('content-type') ?? '';
check(script.status === 200, `waitlist.js is served — ${script.status ?? script.error}`);
check(/javascript|ecmascript/i.test(scriptType),
  `and as a script, so type="module" loads it — got "${scriptType}"`);

const css = await get('/style.css');
check((css.headers?.get('content-type') ?? '').includes('text/css'), `style.css is text/css — got "${css.headers?.get('content-type')}"`);

process.stdout.write(`\nthe headers the host actually applied\n`);

const csp = home.headers?.get('content-security-policy');
check(typeof csp === 'string' && csp.length > 0, 'the pages carry a content policy');
for (const name of ['connect-src', 'form-action']) {
  const values = directive(csp, name);
  check(values !== null && values.includes(API),
    `${name} allows ${API}, which the form posts to — got ${values === null ? 'nothing' : values.join(' ')}`);
}
check(!/unsafe-inline/.test(csp ?? ''), "the policy does not permit inline code");
check((home.headers?.get('strict-transport-security') ?? '').includes('max-age='), 'HSTS is set');
check(home.headers?.get('x-content-type-options') === 'nosniff', 'nosniff is set');
check((home.headers?.get('x-frame-options') ?? '').toUpperCase() === 'DENY', 'the pages refuse to be framed');

/**
 * The diagnostic's whole claim is that it cannot send anything anywhere. On the site
 * that claim is a header, not a sentence on the page — so if this one is wrong, the
 * honest move is to take the tool down rather than to leave the sentence up.
 */
const tool = await get('/tool/');
const toolCsp = tool.headers?.get('content-security-policy');
check(tool.status === 200, `the diagnostic is served — ${tool.status ?? tool.error}`);
check((directive(toolCsp, 'connect-src') ?? []).join(' ') === "'none'",
  `and cannot reach the network — connect-src is ${directive(toolCsp, 'connect-src')?.join(' ') ?? 'not set'}`);

process.stdout.write(`\nhow it is found and shared\n`);

for (const [tag, what] of [['og:image', 'an OG image'], ['og:title', 'an OG title'], ['og:description', 'an OG description']]) {
  const html = home.status === 200 ? await home.clone().text() : '';
  check(html.includes(`property="${tag}"`), `the home page declares ${what}`);
}
const og = /<meta property="og:image" content="([^"]+)"/.exec(home.status === 200 ? await home.clone().text() : '');
if (og === null) { skip('no OG image to fetch'); } else {
  const img = await fetch(og[1], { redirect: 'follow' }).catch((e) => ({ error: String(e) }));
  check(img.status === 200 && (img.headers?.get('content-type') ?? '').startsWith('image/'),
    `the OG image loads — ${og[1]} → ${img.status ?? img.error} ${img.headers?.get('content-type') ?? ''}`);
}
for (const path of ['/ja/', '/agents.html']) {
  const r = await get(path);
  check(r.status === 200, `${path} answers — ${r.status ?? r.error}`);
}
const missing = await get('/definitely-not-a-page');
check(missing.status === 404, `a missing page is a 404, not a redirect — ${missing.status ?? missing.error}`);

process.stdout.write(`\nthe API, from the site's origin\n`);

const health = await fetch(`${API}/health`).catch((e) => ({ error: String(e) }));
check(health.status === 200, `the API answers — ${health.status ?? health.error}`);

/**
 * Sent the way the page sends it, from the page's origin, with the honeypot filled so
 * this leaves no row behind. A wrong TEGATA_SITE_ORIGINS shows up here as a 403.
 */
const posted = await fetch(`${API}/v1/waitlist`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain;charset=UTF-8', origin: SITE },
  body: JSON.stringify({ email: 'deploy-check@example.com', source: 'deploy-check', company_website: 'https://not-a-signup' }),
}).catch((e) => ({ error: String(e) }));
check(posted.status === 202, `it accepts a submission from ${SITE} — ${posted.status ?? posted.error}`);
check(posted.headers?.get('access-control-allow-origin') === SITE,
  `and lets that origin read the answer — got "${posted.headers?.get('access-control-allow-origin') ?? 'nothing'}"`);

const stranger = await fetch(`${API}/v1/waitlist`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://not-our-site.example' },
  body: JSON.stringify({ email: 'deploy-check@example.com', company_website: 'https://not-a-signup' }),
}).catch((e) => ({ error: String(e) }));
check(stranger.status === 403, `and refuses one from anywhere else — ${stranger.status ?? stranger.error}`);

if (key === null) {
  skip('the reads that need a tenant key (pass --key sk_live_…)');
} else {
  const count = await fetch(`${API}/v1/waitlist/count`, { headers: { authorization: `Bearer ${key}` } })
    .catch((e) => ({ error: String(e) }));
  check(count.status === 200, `the count reads with the key — ${count.status ?? count.error}`);
  const noKey = await fetch(`${API}/v1/waitlist/count`).catch((e) => ({ error: String(e) }));
  check(noKey.status === 401, `and not without one — ${noKey.status ?? noKey.error}`);
}

process.stdout.write('\n');
if (failures > 0) {
  process.stderr.write(`deploy check FAILED — ${failures} problem(s)${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(1);
}
process.stdout.write(`deploy check ok${skipped ? ` — ${skipped} skipped` : ''}\n`);
