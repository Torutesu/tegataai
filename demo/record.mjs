#!/usr/bin/env node
/** Records the player. The content is the captured session; nothing here is composed. */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const parts = process.argv[2] ?? 'open,3,4a,4b,6,close,sign';
const name = process.argv[3] ?? 'beats';
const OUT = `out/_${name}`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const url = new URL(pathToFileURL('player.html'));
url.searchParams.set('parts', parts);
await page.goto(url.href);

// The player sets the title when the last card is done.
await page.waitForFunction(() => document.title === 'done', null, { timeout: 180_000 });
await page.waitForTimeout(600);

await context.close();
await browser.close();

const webm = readdirSync(OUT).find((f) => f.endsWith('.webm'));
renameSync(`${OUT}/${webm}`, `out/scene-${name}.webm`);
rmSync(OUT, { recursive: true, force: true });
console.log(`recorded out/scene-${name}.webm`);
