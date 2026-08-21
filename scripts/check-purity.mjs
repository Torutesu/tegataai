#!/usr/bin/env node
// D-29: core and store must be deterministic. No wall-clock, no randomness, no float money.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PURE = ['packages/core/src', 'packages/store/src'];
const RULES = [
  { re: /\bDate\.now\s*\(/,        msg: 'Date.now() — inject Clock instead (D-29)' },
  { re: /\bnew\s+Date\s*\(\s*\)/,  msg: 'new Date() with no argument — inject Clock instead (D-29)' },
  { re: /\bMath\.random\s*\(/,     msg: 'Math.random() — inject Rng instead (D-29)' },
  { re: /\.toFixed\s*\(/,          msg: '.toFixed() — money is integer only (CLAUDE.md rule 1)' },
  { re: /\bparseFloat\s*\(/,       msg: 'parseFloat() — money is integer only (CLAUDE.md rule 1)' },
  { re: /\bNumber\.parseFloat\s*\(/, msg: 'Number.parseFloat() — money is integer only' },
];

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

const violations = [];
for (const root of PURE) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bpurity-ok\b/.test(line)) return;              // explicit, reviewed exemption
      const code = line.replace(/\/\/.*$/, '');
      for (const r of RULES) if (r.re.test(code)) violations.push(`${file}:${i + 1}  ${r.msg}\n    ${line.trim()}`);
    });
  }
}

if (violations.length) {
  console.error(`purity check FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(v + '\n');
  process.exit(1);
}
console.log('purity check ok — core and store are deterministic');
