import { cryptoRng, systemClock } from '@tegata/core';
import { Store } from '@tegata/store';
import { buildApp } from './app.js';
import { deliverDue } from './events.js';
import { expireMatured } from './service.js';
import { sweepEntitlements } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const store = new Store({
  path: process.env.TEGATA_DB ?? './tegata.db',
  clock: systemClock,
  // Every id in the ledger comes from here. A seeded PRNG belongs in the tests that
  // need to replay; a running node gets randomness that cannot be reconstructed from
  // the ids it has already handed out.
  rng: cryptoRng,
});

// PRD §12.6. Env overrides so an operator can raise or disable them without a rebuild.
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`);
  return v;
};

const app = buildApp({
  store, clock: systemClock, logger: true,
  tenantRps: num('TEGATA_TENANT_RPS', 1000),
  subjectRps: num('TEGATA_SUBJECT_RPS', 20),
  // The site is served from somewhere else, so the form's origins are named explicitly.
  waitlistOrigins: (process.env.TEGATA_SITE_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter((o) => o.length > 0),
  waitlistRpm: num('TEGATA_WAITLIST_RPM', 5),
});

/** Housekeeping runs in-process: one node, one loop, nothing else to coordinate. */
const sweeper = setInterval(() => {
  try {
    expireMatured(store);
    store.purgeIdempotency(new Date(systemClock.now() - 86_400_000).toISOString());
    for (const t of store.db.prepare('SELECT tenant_id FROM tenant').all() as { tenant_id: string }[]) {
      sweepEntitlements(store, t.tenant_id);
    }
  } catch (e) {
    app.log.error(e);
  }
}, 10_000);

const deliverer = setInterval(() => {
  void deliverDue(store, (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status })))
    .catch((e: unknown) => { app.log.error(e); });
}, 1_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweeper);
    clearInterval(deliverer);
    void app.close().then(() => { store.close(); process.exit(0); });
  });
}

await app.listen({ port, host });
