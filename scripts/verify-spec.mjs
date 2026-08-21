#!/usr/bin/env node
// spec/ is normative. Its examples must validate, and register.jsonl must chain.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ajv lives in the server package's dependency tree
const require = createRequire(pathToFileURL('packages/server/package.json'));
const Ajv = require('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats');

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const schemas = {};
for (const f of readdirSync('spec/schema')) schemas[f] = load(`spec/schema/${f}`);

const auth = ajv.compile(schemas['authorization.schema.json']);
const pol  = ajv.compile(schemas['policy.schema.json']);
const reg  = ajv.compile(schemas['register-entry.schema.json']);

let failures = 0;
const check = (label, ok, errs) => {
  if (ok) { console.log(`  valid: ${label}`); return; }
  failures++;
  console.error(`  FAIL:  ${label}`);
  for (const e of errs ?? []) console.error(`         ${e.instancePath || '/'} ${e.message}`);
};

console.log('spec examples:');
for (const f of readdirSync('spec/examples')) {
  if (!f.endsWith('.json')) continue;
  const v = f.includes('policy') ? pol : auth;
  check(`spec/examples/${f}`, v(load(`spec/examples/${f}`)), v.errors);
}

// JCS over the value set the register uses: objects, arrays, strings, integers, booleans, null.
const jcs = (o) => JSON.stringify(o, (_k, v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  }
  return v;
});

console.log('register chain:');
let prev = '0'.repeat(64), n = 0, balance = 0;
const reserved = new Map();
for (const line of readFileSync('spec/examples/register.jsonl', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  n++;
  const entry = JSON.parse(line);
  if (!reg(entry)) { check(`register line ${n}`, false, reg.errors); continue; }
  if (entry.seq !== n) { failures++; console.error(`  FAIL:  seq gap at line ${n} (got ${entry.seq})`); }
  const { hash, ...rest } = entry;
  if (rest.prev_hash !== prev) { failures++; console.error(`  FAIL:  prev_hash mismatch at seq ${entry.seq}`); }
  const computed = createHash('sha256').update(jcs(rest), 'utf8').digest('hex');
  if (computed !== hash) { failures++; console.error(`  FAIL:  hash mismatch at seq ${entry.seq}`); }
  prev = hash;
  balance += entry.delta_amount;
  if (entry.kind === 'issue') reserved.set(entry.authorization_id, entry.meta.face_value);
  if (entry.kind === 'capture' || entry.kind === 'release') reserved.delete(entry.authorization_id);
}
const held = [...reserved.values()].reduce((a, b) => a + b, 0);
console.log(`  ${n} entries · balance ${balance} · reserved ${held} · available ${balance - held}`);

if (failures) { console.error(`\nspec verification FAILED (${failures})`); process.exit(1); }
console.log('\nspec verification ok');
