#!/usr/bin/env node
/**
 * Scenes 2 and 5 are screen recordings of the real things: the diagnostic tool being
 * driven with real CSVs, and a demo app talking to a running server. Nothing is mocked;
 * the numbers on screen are whatever they come out as.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const which = process.argv[2];
const OUT = `out/${which}`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);

if (which === 'tool') {
  // Scene 2. Two exports are dropped onto the real tool, which computes in the browser.
  await page.goto('http://127.0.0.1:8080/tool/');
  await wait(800);

  const csv = JSON.parse(readFileSync('fixtures.json', 'utf8'));
  for (const [dropId, fileName, text] of [
    ['dz-stripe', 'stripe-payments.csv', csv.stripe],
    ['dz-usage', 'anthropic-usage.csv', csv.usage],
  ]) {
    await page.dispatchEvent(`#${dropId}`, 'dragover');
    await wait(320);
    // A genuine drop: the tool reads the file exactly as it would from a desktop.
    await page.evaluate(async ({ dropId, fileName, text }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], fileName, { type: 'text/csv' }));
      document.getElementById(dropId).dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true }),
      );
    }, { dropId, fileName, text });
    await wait(750);
  }

  await wait(450);
  await page.click('#run');
  await page.waitForSelector('#headline', { state: 'visible' });
  // Hold on the two numbers, which is all the scene is for.
  await page.evaluate(() => document.getElementById('results').scrollIntoView({ block: 'start' }));
  await wait(3600);
  await page.evaluate(() => document.getElementById('chartwrap').scrollIntoView({ block: 'center' }));
  await wait(1700);

  const headline = (await page.textContent('#headline')).replace(/\s+/g, ' ').trim();
  console.log('scene 2 headline:', headline);
} else {
  // Scene 5. The demo app, against the running server.
  const key = readFileSync('/tmp/demo.key', 'utf8').trim();
  const base = process.env.DEMO_BASE ?? 'http://127.0.0.1:8792';

  // The page is on file://, so the browser will not call the API directly and the
  // server has no CORS headers — correctly, since the MVP is server-to-server only.
  // Rather than loosen the product for a video, forward each call to the real server
  // from here. It is a transport hop, not a mock: every response below is the server's.
  await page.route(`${base}/**`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'access-control-allow-origin': '*' },
    });
  });

  const url = new URL(pathToFileURL('app.html'));
  url.searchParams.set('base', base);
  url.searchParams.set('key', key);
  await page.goto(url.href);
  await page.waitForFunction(() => document.title === 'done', null, { timeout: 60_000 });
  await wait(400);
}

await context.close();
await browser.close();
const webm = readdirSync(OUT).find((f) => f.endsWith('.webm'));
renameSync(`${OUT}/${webm}`, `out/scene-${which}.webm`);
rmSync(OUT, { recursive: true, force: true });
console.log(`recorded out/scene-${which}.webm`);
