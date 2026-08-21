#!/usr/bin/env tsx
/**
 * AC-P1: authorize latency, measured rather than asserted. Single node on localhost
 * (docs/plan/credits-mvp.md §1.3) — the distributed figure is a separate exercise and
 * this file says so rather than implying otherwise.
 */
import autocannon from 'autocannon';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { SeededRng, sha256Hex, systemClock, UlidFactory } from '@tegata/core';
import { Store } from '@tegata/store';
import { buildApp } from '@tegata/server';

const DB = './perf.db';
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

const rng = new SeededRng(1234);
const store = new Store({ path: DB, clock: systemClock, rng });
const ulid = new UlidFactory(() => rng.next());
const tenantId = ulid.generate(systemClock.now());
const secret = `sk_perf_${randomBytes(12).toString('base64url')}`;

store.createTenant({
  tenant_id: tenantId, name: 'perf', secret_key_hash: sha256Hex(secret),
  credit_unit_micro_usd: 20_000, degraded_mode: 'allow', max_overdraft_credits: 200,
  cost_table_pin: null, webhook_url: null, webhook_secret: null, low_balance_pct: 20,
});
store.insertCostRates('v1', new Date(systemClock.now()).toISOString(), [
  { provider: 'anthropic', model: 'claude-opus-5', unit: 'token',
    input_micro_usd_per_unit: 15, output_micro_usd_per_unit: 75, cached_input_micro_usd_per_unit: 1 },
]);
store.upsertAction(tenantId, {
  action: 'chat.completion', pricing_mode: 'token_based', fixed_credits: null,
  default_face_value: 25, min_face_value: 1, fallback_action: null, fallback_model: null, markup_milli: 1000,
});

const SUBJECTS = 200;
for (let i = 0; i < SUBJECTS; i++) {
  const id = `perf_${i}`;
  store.ensureSubject(tenantId, id);
  // Enough that no run ends up measuring the refusal path instead of the hold path.
  store.grant(tenantId, id, { source: 'grant', credits: 500_000_000 });
}

const app = buildApp({ store, clock: systemClock, rng: new SeededRng(9) });
await app.listen({ port: 8899, host: '127.0.0.1' });

const durationSec = Number(process.env.PERF_SECONDS ?? 20);
const levels = (process.env.PERF_CONNECTIONS ?? '1,10,25,50,100').split(',').map(Number);
let n = 0;

const runAt = async (connections: number) => {
  const r = await autocannon({
    url: 'http://127.0.0.1:8899/v1/authorizations',
    connections,
    duration: durationSec,
    requests: [{
      method: 'POST',
      path: '/v1/authorizations',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      setupRequest: (req: autocannon.Request) => {
        n++;
        return {
          ...req,
          headers: { ...req.headers, 'idempotency-key': `perf-${n}` },
          body: JSON.stringify({
            subject_id: `perf_${n % SUBJECTS}`,
            action: 'chat.completion',
            estimate: { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 12_400, max_output_tokens: 2_000, cached_input_tokens: 8_000 },
          }),
        };
      },
    }],
  });
  return {
    connections,
    requests_total: r.requests.total,
    throughput_rps: Math.round(r.requests.mean),
    latency_ms: { p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, max: r.latency.max },
    errors: r.errors, timeouts: r.timeouts, non_2xx: r.non2xx,
    meets_p99_target: r.latency.p99 < 50 && r.errors === 0 && r.timeouts === 0 && r.non2xx === 0,
  };
};

const runs: Awaited<ReturnType<typeof runAt>>[] = [];
for (const c of levels) {
  process.stdout.write(`measuring at ${c} connection${c === 1 ? '' : 's'}...\n`);
  runs.push(await runAt(c));
}

await app.close();
store.close();
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

const clean = runs.filter((r) => r.errors === 0 && r.timeouts === 0 && r.non_2xx === 0);
const passing = clean.filter((r) => r.meets_p99_target);
const ceiling = Math.max(...clean.map((r) => r.throughput_rps));

const report = {
  measured_at: new Date(systemClock.now()).toISOString(),
  node: process.version,
  scope: 'Single node, localhost, in-process SQLite. Not a distributed measurement.',
  duration_seconds_per_level: durationSec,
  target: { p99_ms: 50, errors: 0 },
  runs,
  summary: {
    throughput_ceiling_rps: ceiling,
    highest_concurrency_meeting_p99_target: passing.length === 0 ? 0 : Math.max(...passing.map((r) => r.connections)),
    // Beyond the write throughput of one node, latency is queueing, not per-request
    // cost: the service time barely moves while the queue in front of it grows.
    interpretation: 'Latency past the throughput ceiling is queueing on the single writer, which is the known consequence of the single-node MVP (Q-03 deferred).',
  },
  errors_anywhere: runs.some((r) => r.errors > 0 || r.timeouts > 0 || r.non_2xx > 0),
};

mkdirSync('docs/plan/perf', { recursive: true });
writeFileSync('docs/plan/perf/authorize.json', `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write('\nconn   req/s     p50    p90    p99    max   errors\n');
for (const r of runs) {
  process.stdout.write(
    `${String(r.connections).padStart(4)} ${String(r.throughput_rps).padStart(7)} ` +
    `${String(r.latency_ms.p50).padStart(6)} ${String(r.latency_ms.p90).padStart(6)} ` +
    `${String(r.latency_ms.p99).padStart(6)} ${String(r.latency_ms.max).padStart(6)} ` +
    `${String(r.errors + r.timeouts + r.non_2xx).padStart(8)}${r.meets_p99_target ? '   <= p99 target met' : ''}\n`,
  );
}
process.stdout.write(
  `\nthroughput ceiling ${ceiling} req/s · p99 < 50ms holds up to ` +
  `${report.summary.highest_concurrency_meeting_p99_target} concurrent connections\n`,
);
process.exit(report.errors_anywhere ? 1 : 0);
