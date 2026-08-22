#!/usr/bin/env node
/**
 * The site links to a public repository, and this working tree is not one.
 *
 * `docs/` is the internal record: the GTM plan, the ICP target list with real companies
 * in it, the pricing assumptions, the decision log — and `docs/plan/security-review.md`,
 * which is a list of the risks we decided to accept. Publishing this tree as it stands
 * would hand all of that over, and the mistake is silent: the repository would look
 * fine, because everything in it is correct.
 *
 * So the public tree is built from an explicit list of what belongs in it, rather than
 * from a list of what to leave out. Anything new is private until someone adds it here.
 *
 *   node scripts/build-public.mjs [--out dist-public]
 *
 * It writes nothing outside the output directory and changes nothing in the repository.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const outFlag = process.argv.indexOf('--out');
const OUT = outFlag === -1 ? 'dist-public' : process.argv[outFlag + 1];

/** What a reader of the specification needs, and nothing else. */
const PUBLIC = [
  /^README\.md$/,
  /^LICENSE$/,
  /^spec\//,
  /^templates\//,
  /^packages\//,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig(\.base)?\.json$/,
  /^\.gitignore$/,
  // A reader is invited to run `pnpm verify`, so the checks it runs have to be there.
  // These two are also the point of a spec-first repository: they prove the examples
  // validate and the register's hash chain is real.
  /^scripts\/check-purity\.mjs$/,
  /^scripts\/verify-spec\.mjs$/,
  /^eslint\.config\.[cm]?js$/,
  /^\.eslintrc(\.[a-z]+)?$/,
  /^vitest\.config\.[cm]?ts$/,
];

/**
 * Not "everything else" — these are named so that a file which somehow matched above
 * still cannot get out. A rule that only allows is one typo away from allowing too much.
 */
const NEVER = [
  { re: /^docs\//, why: 'the internal record: strategy, target companies, accepted risks' },
  { re: /^demo\//, why: 'the launch film and its fixtures' },
  { re: /^site\//, why: 'the marketing site, deployed separately' },
  { re: /^brand\//, why: 'brand assets, not part of the specification' },
  { re: /^tools\//, why: 'the diagnostic tool goes to its own repository' },
  { re: /^scripts\/(check-site|check-csp|check-deployed|e2e-waitlist|measure-banner|build-public)\.mjs$/,
    why: 'checks for the site and this working tree, not for a reader' },
  { re: /^\.github\//, why: 'workflows that reference private paths' },
  { re: /^Dockerfile$/, why: 'deployment of our node, not of the reference implementation' },
  { re: /\.db(-wal|-shm)?$/, why: 'a database' },
  { re: /^\.env/, why: 'environment' },
];

const problems = [];
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

const included = [];
for (const file of tracked) {
  const denied = NEVER.find((d) => d.re.test(file));
  const allowed = PUBLIC.some((p) => p.test(file));
  if (denied !== undefined) {
    if (allowed) problems.push(`${file}: allowed and denied at once — ${denied.why}`);
    continue;
  }
  if (allowed) included.push(file);
}

if (included.length === 0) problems.push('nothing would be published, which cannot be right');

rmSync(OUT, { recursive: true, force: true });
for (const file of included) {
  const target = join(OUT, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
}

/**
 * `pnpm verify` is the first thing the README asks a reader to run, so the scripts that
 * survive must be the ones whose files did. A script that cannot run is worse than no
 * script: it reads as a project that does not run its own checks.
 */
const manifest = JSON.parse(readFileSync(join(OUT, 'package.json'), 'utf8'));
const present = new Set(included);
const dropped = [];
const here = (path) => present.has(path) || included.some((f) => f.startsWith(`${path}/`));
manifest.scripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name, cmd]) => {
  const text = String(cmd);
  // A path it names, or a directory that did not come along at all.
  const referenced = [...text.matchAll(/[\w.-]+\/[\w./-]+/g)].map((m) => m[0].replace(/\/$/, ''));
  const roots = NEVER.map((d) => d.re.source.replace(/^\^|\\\/$|\//g, '')).filter((r) => /^[a-z]+$/.test(r));
  const missing = [
    ...referenced.filter((r) => !here(r)),
    ...roots.filter((r) => new RegExp(`(^|\\s|/)${r}(/|\\s|$)`).test(text) && !here(r)),
  ];
  if (missing.length === 0) return true;
  dropped.push(`${name} (needs ${[...new Set(missing)].join(', ')})`);
  return false;
}));
manifest.scripts.verify = 'pnpm typecheck && pnpm lint && pnpm verify:purity && pnpm verify:spec && pnpm test';
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (dropped.length > 0) process.stdout.write(`  scripts left behind: ${dropped.join('; ')}\n`);

/**
 * A link into a file that stayed behind is a 404 for every reader, and it is the shape
 * the mistake takes: the private thing is not published, it is merely advertised.
 */
const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of included.filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(file, 'utf8');
  for (const [, href] of text.matchAll(MD_LINK)) {
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const path = join(dirname(file), href.split('#')[0]);
    if (path.length === 0) continue;
    if (!existsSync(join(OUT, path))) {
      problems.push(`${file}: links to ${href}, which is not in the public tree`);
    }
  }
}

/**
 * CLAUDE.md: `docs/` is Japanese, everything published is English. What this looks for
 * is a sentence written for ourselves, not a Japanese word inside an English one — the
 * README explains what 手形 means, and a canonicalisation test has to canonicalise
 * something that is not ASCII. So it measures the share of the line rather than its
 * presence: prose written in Japanese is mostly Japanese.
 */
const CJK = /[぀-ヿ一-鿿]/gu;
for (const file of included.filter((f) => /\.(md|ts|json|yaml|yml)$/.test(f))) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const dense = line.replace(/\s+/g, '');
    if (dense.length < 8) return;
    const share = (dense.match(CJK) ?? []).length / dense.length;
    if (share >= 0.3) {
      problems.push(`${file}:${i + 1}: a line written in Japanese, in a file meant for readers\n    ${line.trim().slice(0, 100)}`);
    }
  });
}

process.stdout.write(`public tree: ${included.length} files → ${OUT}\n`);
if (problems.length > 0) {
  process.stderr.write(`\npublic build FAILED — ${problems.length} problem(s):\n\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.exit(1);
}
process.stdout.write('public build ok — nothing internal, no dangling links, no Japanese\n');
