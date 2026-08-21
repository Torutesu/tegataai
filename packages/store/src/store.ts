import {
  type Balances, type Clock, type Credits, type Entitlement, type JsonObject, type MicroUsd,
  type RegisterEntry, type Rng, UlidFactory, deriveBalancesSelfContained, sealEntry, verifyChain,
  ZERO_HASH, overdraftRepayment, consume, sha256Hex, canonicalize,
} from '@tegata/core';
import { all, one, openDb, run, stmt, type Db } from './db.js';
import type {
  ActionSpec, AppendRequest, AuthorizationRow, OutboxEvent, SubjectRow, TenantRow,
} from './types.js';

export interface StoreOptions {
  path?: string;
  clock: Clock;
  rng: Rng;
}

/**
 * Everything that touches the ledger goes through here, and everything here runs
 * inside a transaction on one subject. The register is written append-only —
 * triggers in the schema make UPDATE and DELETE fail at the storage layer, so an
 * append-only ledger is a property of the database rather than a convention the
 * application is trusted to keep.
 */
export class Store {
  readonly db: Db;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly ulid: UlidFactory;

  constructor(opts: StoreOptions) {
    this.db = openDb(opts.path);
    this.clock = opts.clock;
    this.rng = opts.rng;
    this.ulid = new UlidFactory(() => this.rng.next());
  }

  close(): void { this.db.close(); }
  now(): string { return this.clock.iso(); }
  nowMs(): number { return this.clock.now(); }
  newId(): string { return this.ulid.generate(this.clock.now()); }
  random(): number { return this.rng.next(); }

  /**
   * Run `fn` inside an IMMEDIATE transaction. Named for the subject because that is
   * the unit the ledger serialises on; better-sqlite3 is synchronous, so nothing
   * interleaves and the name is a promise the engine keeps.
   */
  withSubject<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ---------------------------------------------------------------- tenants

  createTenant(t: Omit<TenantRow, 'created_at'>): TenantRow {
    const row: TenantRow = { ...t, created_at: this.now() };
    run(this.db,
      `INSERT INTO tenant (tenant_id,name,secret_key_hash,credit_unit_micro_usd,degraded_mode,
        max_overdraft_credits,cost_table_pin,webhook_url,webhook_secret,low_balance_pct,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      row.tenant_id, row.name, row.secret_key_hash, row.credit_unit_micro_usd, row.degraded_mode,
      row.max_overdraft_credits, row.cost_table_pin, row.webhook_url, row.webhook_secret,
      row.low_balance_pct, row.created_at);
    return row;
  }

  getTenant(tenantId: string): TenantRow | undefined {
    return one<TenantRow>(this.db, 'SELECT * FROM tenant WHERE tenant_id = ?', tenantId);
  }

  tenantByKey(secret: string): TenantRow | undefined {
    return one<TenantRow>(this.db, 'SELECT * FROM tenant WHERE secret_key_hash = ?', sha256Hex(secret));
  }

  /**
   * The only place a column name reaches SQL as text rather than as a bound parameter,
   * so the set of names it will accept is fixed here. Nothing outside this list can be
   * written, whatever the caller passes.
   */
  private static readonly TENANT_WRITABLE = new Set<keyof TenantRow>([
    'name', 'secret_key_hash', 'credit_unit_micro_usd', 'degraded_mode',
    'max_overdraft_credits', 'cost_table_pin', 'webhook_url', 'webhook_secret',
    'low_balance_pct',
  ]);

  updateTenant(tenantId: string, patch: Partial<TenantRow>): void {
    const cols = Object.keys(patch).filter((k) => Store.TENANT_WRITABLE.has(k as keyof TenantRow));
    const rejected = Object.keys(patch).filter((k) => k !== 'tenant_id' && !Store.TENANT_WRITABLE.has(k as keyof TenantRow));
    if (rejected.length > 0) {
      throw new Error(`updateTenant: refusing to write unknown column(s): ${rejected.join(', ')}`);
    }
    if (cols.length === 0) return;
    run(this.db, `UPDATE tenant SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE tenant_id = ?`,
      ...cols.map((c) => (patch as Record<string, unknown>)[c]), tenantId);
  }

  // --------------------------------------------------------------- subjects

  /** Subjects are created on first sight: the id is the tenant's, not ours (PRD §5.1). */
  ensureSubject(tenantId: string, subjectId: string): SubjectRow {
    const existing = this.getSubject(tenantId, subjectId);
    if (existing !== undefined) return existing;
    const row: SubjectRow = {
      tenant_id: tenantId, subject_id: subjectId, status: 'active',
      external_ref: null, created_at: this.now(),
    };
    run(this.db,
      'INSERT INTO subject (tenant_id,subject_id,status,external_ref,created_at) VALUES (?,?,?,?,?)',
      row.tenant_id, row.subject_id, row.status, row.external_ref, row.created_at);
    run(this.db,
      'INSERT INTO balance_projection (tenant_id,subject_id,balance,reserved,last_seq) VALUES (?,?,0,0,0)',
      tenantId, subjectId);
    return row;
  }

  getSubject(tenantId: string, subjectId: string): SubjectRow | undefined {
    return one<SubjectRow>(this.db,
      'SELECT * FROM subject WHERE tenant_id = ? AND subject_id = ?', tenantId, subjectId);
  }

  setSubjectStatus(tenantId: string, subjectId: string, status: SubjectRow['status']): void {
    run(this.db, 'UPDATE subject SET status = ? WHERE tenant_id = ? AND subject_id = ?',
      status, tenantId, subjectId);
  }

  setSubjectExternalRef(tenantId: string, subjectId: string, ref: JsonObject): void {
    run(this.db, 'UPDATE subject SET external_ref = ? WHERE tenant_id = ? AND subject_id = ?',
      JSON.stringify(ref), tenantId, subjectId);
  }

  subjectByStripeCustomer(tenantId: string, customerId: string): SubjectRow | undefined {
    return one<SubjectRow>(this.db,
      `SELECT * FROM subject WHERE tenant_id = ?
        AND json_extract(external_ref, '$.stripe_customer_id') = ?`,
      tenantId, customerId);
  }

  listSubjects(tenantId: string): SubjectRow[] {
    return all<SubjectRow>(this.db, 'SELECT * FROM subject WHERE tenant_id = ? ORDER BY subject_id', tenantId);
  }

  // --------------------------------------------------------------- register

  /**
   * Append one entry. The projection is updated in the same transaction, but it is
   * a cache: `rebuildProjection` recomputes it from the entries, and the entries win.
   */
  append(tenantId: string, subjectId: string, req: AppendRequest): RegisterEntry {
    const head = one<{ seq: number; hash: string }>(this.db,
      'SELECT seq, hash FROM register WHERE tenant_id = ? AND subject_id = ? ORDER BY seq DESC LIMIT 1',
      tenantId, subjectId);
    const entry = sealEntry({
      subject_id: subjectId,
      at: this.now(),
      kind: req.kind,
      delta_amount: req.delta_amount,
      delta_cost_micro_usd: req.delta_cost_micro_usd ?? 0,
      authorization_id: req.authorization_id,
      entitlement_id: req.entitlement_id,
      policy_ref: req.policy_ref,
      meta: req.meta ?? {},
    }, head?.seq ?? 0, head?.hash ?? ZERO_HASH);

    run(this.db,
      `INSERT INTO register (tenant_id,subject_id,seq,at,kind,delta_amount,delta_cost_micro_usd,
        authorization_id,entitlement_id,policy_ref,meta,prev_hash,hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tenantId, subjectId, entry.seq, entry.at, entry.kind, entry.delta_amount,
      entry.delta_cost_micro_usd, entry.authorization_id ?? null, entry.entitlement_id ?? null,
      entry.policy_ref === undefined ? null : JSON.stringify(entry.policy_ref),
      canonicalize(entry.meta), entry.prev_hash, entry.hash);

    const reservedDelta =
      req.kind === 'issue' ? (req.meta?.face_value as number) : 0;
    run(this.db,
      `UPDATE balance_projection SET balance = balance + ?, reserved = reserved + ?, last_seq = ?
        WHERE tenant_id = ? AND subject_id = ?`,
      entry.delta_amount, reservedDelta, entry.seq, tenantId, subjectId);

    if (entry.delta_amount < 0) {
      run(this.db,
        'INSERT OR REPLACE INTO settlement_window (tenant_id,subject_id,at,credits) VALUES (?,?,?,?)',
        tenantId, subjectId, `${entry.at}#${entry.seq}`, -entry.delta_amount);
    }
    return entry;
  }

  /** Close a reservation: the hold stops counting toward `reserved`. */
  releaseReservation(tenantId: string, subjectId: string, faceValue: Credits): void {
    run(this.db,
      'UPDATE balance_projection SET reserved = reserved - ? WHERE tenant_id = ? AND subject_id = ?',
      faceValue, tenantId, subjectId);
  }

  balances(tenantId: string, subjectId: string): Balances {
    const row = one<{ balance: number; reserved: number }>(this.db,
      'SELECT balance, reserved FROM balance_projection WHERE tenant_id = ? AND subject_id = ?',
      tenantId, subjectId);
    if (row === undefined) return { balance: 0, reserved: 0, available: 0 };
    return { balance: row.balance, reserved: row.reserved, available: row.balance - row.reserved };
  }

  registerEntries(tenantId: string, subjectId: string, afterSeq = 0, limit = 1_000_000): RegisterEntry[] {
    const rows = all<{
      seq: number; at: string; kind: RegisterEntry['kind']; delta_amount: number;
      delta_cost_micro_usd: number; authorization_id: string | null; entitlement_id: string | null;
      policy_ref: string | null; meta: string; prev_hash: string; hash: string;
    }>(this.db,
      `SELECT seq,at,kind,delta_amount,delta_cost_micro_usd,authorization_id,entitlement_id,
              policy_ref,meta,prev_hash,hash
         FROM register WHERE tenant_id = ? AND subject_id = ? AND seq > ?
        ORDER BY seq LIMIT ?`,
      tenantId, subjectId, afterSeq, limit);
    return rows.map((r) => {
      const e: RegisterEntry = {
        seq: r.seq, subject_id: subjectId, at: r.at, kind: r.kind,
        delta_amount: r.delta_amount, delta_cost_micro_usd: r.delta_cost_micro_usd,
        meta: JSON.parse(r.meta) as JsonObject, prev_hash: r.prev_hash, hash: r.hash,
      };
      if (r.authorization_id !== null) e.authorization_id = r.authorization_id;
      if (r.entitlement_id !== null) e.entitlement_id = r.entitlement_id;
      if (r.policy_ref !== null) e.policy_ref = JSON.parse(r.policy_ref) as RegisterEntry['policy_ref'];
      return e;
    });
  }

  /** The register is the truth; this recomputes the cache from it (INV-10). */
  rebuildProjection(tenantId: string, subjectId: string): Balances {
    const entries = this.registerEntries(tenantId, subjectId);
    const derived = deriveBalancesSelfContained(entries);
    run(this.db,
      `UPDATE balance_projection SET balance = ?, reserved = ?, last_seq = ?
        WHERE tenant_id = ? AND subject_id = ?`,
      derived.balance, derived.reserved, entries.length, tenantId, subjectId);
    return derived;
  }

  verifySubjectChain(tenantId: string, subjectId: string): ReturnType<typeof verifyChain> {
    return verifyChain(this.registerEntries(tenantId, subjectId));
  }

  /** Settled credits inside a rolling window, for the period ceiling. */
  settledSince(tenantId: string, subjectId: string, sinceIso: string): Credits {
    const row = one<{ total: number | null }>(this.db,
      `SELECT SUM(credits) AS total FROM settlement_window
        WHERE tenant_id = ? AND subject_id = ? AND at >= ?`,
      tenantId, subjectId, sinceIso);
    return row?.total ?? 0;
  }

  settledLifetime(tenantId: string, subjectId: string): Credits {
    const row = one<{ total: number | null }>(this.db,
      'SELECT SUM(credits) AS total FROM settlement_window WHERE tenant_id = ? AND subject_id = ?',
      tenantId, subjectId);
    return row?.total ?? 0;
  }

  // ----------------------------------------------------------- entitlements

  grant(tenantId: string, subjectId: string, g: {
    source: Entitlement['source']; credits: Credits; expires_at?: string | null;
    refresh_policy?: Entitlement['refresh_policy']; rollover_cap_credits?: number | null;
    priority?: number; amount_micro_usd?: MicroUsd; source_ref?: string | null;
  }): { entitlement: Entitlement; entry: RegisterEntry } {
    const { balance } = this.balances(tenantId, subjectId);
    // A grant repays an overdraft before crediting the rest, so the stack keeps
    // describing the money that is there (core: overdraftRepayment).
    const repaid = overdraftRepayment(balance, g.credits);
    const id = this.newId();
    const now = this.now();
    const ent: Entitlement = {
      entitlement_id: id, subject_id: subjectId, source: g.source,
      credits_granted: g.credits, credits_remaining: g.credits - repaid,
      effective_from: now, expires_at: g.expires_at ?? null,
      refresh_policy: g.refresh_policy ?? 'reset',
      rollover_cap_credits: g.rollover_cap_credits ?? null,
      priority: g.priority ?? 100, status: 'active',
      amount_micro_usd: g.amount_micro_usd ?? 0, source_ref: g.source_ref ?? null,
      created_at: now,
    };
    run(this.db,
      `INSERT INTO entitlement (entitlement_id,tenant_id,subject_id,source,credits_granted,
        credits_remaining,effective_from,expires_at,refresh_policy,rollover_cap_credits,priority,
        status,amount_micro_usd,source_ref,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, tenantId, subjectId, ent.source, ent.credits_granted, ent.credits_remaining,
      ent.effective_from, ent.expires_at, ent.refresh_policy, ent.rollover_cap_credits,
      ent.priority, ent.status, ent.amount_micro_usd, ent.source_ref, ent.created_at);

    const meta: JsonObject = { source: ent.source };
    if (repaid > 0) meta.overdraft_repaid = repaid;
    const entry = this.append(tenantId, subjectId, {
      kind: 'grant', delta_amount: g.credits, entitlement_id: id, meta,
    });
    return { entitlement: ent, entry };
  }

  activeEntitlements(tenantId: string, subjectId: string): Entitlement[] {
    return all<Entitlement>(this.db,
      `SELECT entitlement_id,subject_id,source,credits_granted,credits_remaining,effective_from,
              expires_at,refresh_policy,rollover_cap_credits,priority,status,amount_micro_usd,
              source_ref,created_at
         FROM entitlement WHERE tenant_id = ? AND subject_id = ? AND status = 'active'`,
      tenantId, subjectId);
  }

  /** Draw from the stack, recording which grants paid and what could not be covered. */
  drawFromStack(tenantId: string, subjectId: string, authorizationId: string | null, amount: Credits): Credits {
    const stack = this.activeEntitlements(tenantId, subjectId);
    const { consumptions, shortfall } = consume(stack, amount);
    for (const c of consumptions) {
      run(this.db,
        'UPDATE entitlement SET credits_remaining = credits_remaining - ? WHERE entitlement_id = ?',
        c.credits, c.entitlement_id);
      if (authorizationId !== null) {
        run(this.db,
          `INSERT INTO consumption (tenant_id,authorization_id,entitlement_id,credits,at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(tenant_id,authorization_id,entitlement_id)
             DO UPDATE SET credits = credits + excluded.credits`,
          tenantId, authorizationId, c.entitlement_id, c.credits, this.now());
      }
    }
    return shortfall;
  }

  expireEntitlement(tenantId: string, subjectId: string, ent: Entitlement, reason: string): RegisterEntry | null {
    run(this.db, "UPDATE entitlement SET status = 'expired', credits_remaining = 0 WHERE entitlement_id = ?",
      ent.entitlement_id);
    if (ent.credits_remaining <= 0) return null;
    return this.append(tenantId, subjectId, {
      kind: 'expire', delta_amount: -ent.credits_remaining,
      entitlement_id: ent.entitlement_id, meta: { reason },
    });
  }

  /**
   * Lapse part of a grant. A capped rollover keeps what fits under the cap and lapses
   * only the excess, so expiring the whole grant would destroy credits the tenant
   * promised to carry.
   */
  expirePartialEntitlement(
    tenantId: string, subjectId: string, ent: Entitlement, amount: Credits, reason: string,
  ): RegisterEntry | null {
    const lapse = Math.min(amount, ent.credits_remaining);
    if (lapse <= 0) return null;
    const remaining = ent.credits_remaining - lapse;
    run(this.db,
      'UPDATE entitlement SET credits_remaining = ?, status = ? WHERE entitlement_id = ?',
      remaining, remaining === 0 ? 'expired' : 'active', ent.entitlement_id);
    return this.append(tenantId, subjectId, {
      kind: 'expire', delta_amount: -lapse, entitlement_id: ent.entitlement_id,
      meta: { reason, lapsed: lapse, carried: remaining },
    });
  }

  reduceEntitlement(entitlementId: string, by: Credits): void {
    run(this.db, 'UPDATE entitlement SET credits_remaining = credits_remaining - ? WHERE entitlement_id = ?',
      by, entitlementId);
  }

  entitlementsBySourceRef(tenantId: string, sourceRef: string): Entitlement[] {
    return all<Entitlement>(this.db,
      `SELECT entitlement_id,subject_id,source,credits_granted,credits_remaining,effective_from,
              expires_at,refresh_policy,rollover_cap_credits,priority,status,amount_micro_usd,
              source_ref,created_at
         FROM entitlement WHERE tenant_id = ? AND source_ref = ? AND status = 'active'`,
      tenantId, sourceRef);
  }

  // -------------------------------------------------------- authorizations

  insertAuthorization(row: AuthorizationRow): void {
    run(this.db,
      `INSERT INTO authorization_ (authorization_id,tenant_id,subject_id,action,state,face_value,
        maturity,estimate,context,captured_amount,cost_micro_usd,dishonor_reason,provisional,
        created_at,closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.authorization_id, row.tenant_id, row.subject_id, row.action, row.state, row.face_value,
      row.maturity, row.estimate, row.context, row.captured_amount, row.cost_micro_usd,
      row.dishonor_reason, row.provisional, row.created_at, row.closed_at);
  }

  getAuthorization(tenantId: string, id: string): AuthorizationRow | undefined {
    return one<AuthorizationRow>(this.db,
      'SELECT * FROM authorization_ WHERE tenant_id = ? AND authorization_id = ?', tenantId, id);
  }

  closeAuthorization(id: string, patch: {
    state: AuthorizationRow['state']; captured_amount?: Credits | null; cost_micro_usd?: MicroUsd | null;
  }): void {
    run(this.db,
      `UPDATE authorization_ SET state = ?, captured_amount = ?, cost_micro_usd = ?, closed_at = ?
        WHERE authorization_id = ?`,
      patch.state, patch.captured_amount ?? null, patch.cost_micro_usd ?? null, this.now(), id);
  }

  maturedAuthorizations(nowIso: string, limit = 500): AuthorizationRow[] {
    return all<AuthorizationRow>(this.db,
      "SELECT * FROM authorization_ WHERE state = 'issued' AND maturity <= ? ORDER BY maturity LIMIT ?",
      nowIso, limit);
  }

  openAuthorizationCount(tenantId: string, subjectId: string): number {
    const r = one<{ n: number }>(this.db,
      "SELECT COUNT(*) AS n FROM authorization_ WHERE tenant_id = ? AND subject_id = ? AND state = 'issued'",
      tenantId, subjectId);
    return r?.n ?? 0;
  }

  recentDishonorCount(tenantId: string, subjectId: string, sinceIso: string): number {
    const r = one<{ n: number }>(this.db,
      `SELECT COUNT(*) AS n FROM register
        WHERE tenant_id = ? AND subject_id = ? AND kind = 'dishonor' AND at >= ?`,
      tenantId, subjectId, sinceIso);
    return r?.n ?? 0;
  }

  // ------------------------------------------------------------ idempotency

  /** Returns the stored response for a replayed key, or throws on a conflicting body. */
  lookupIdempotent(tenantId: string, key: string, requestHash: string):
    { status: number; body: unknown } | 'conflict' | undefined {
    const row = one<{ request_hash: string; status_code: number; response: string }>(this.db,
      'SELECT request_hash, status_code, response FROM idempotency WHERE tenant_id = ? AND idem_key = ?',
      tenantId, key);
    if (row === undefined) return undefined;
    if (row.request_hash !== requestHash) return 'conflict';
    return { status: row.status_code, body: JSON.parse(row.response) };
  }

  /**
   * Claim a key before doing the work. The primary key makes this the point where
   * concurrent replays collide, so exactly one caller proceeds (AC-04).
   */
  claimIdempotent(tenantId: string, key: string, requestHash: string): boolean {
    const res = stmt(this.db, 
      `INSERT OR IGNORE INTO idempotency (tenant_id,idem_key,request_hash,status_code,response,created_at)
       VALUES (?,?,?,0,'',?)`,
    ).run(tenantId, key, requestHash, this.now());
    return res.changes === 1;
  }

  completeIdempotent(tenantId: string, key: string, status: number, body: unknown): void {
    run(this.db, 'UPDATE idempotency SET status_code = ?, response = ? WHERE tenant_id = ? AND idem_key = ?',
      status, JSON.stringify(body), tenantId, key);
  }

  releaseIdempotent(tenantId: string, key: string): void {
    run(this.db, 'DELETE FROM idempotency WHERE tenant_id = ? AND idem_key = ? AND status_code = 0',
      tenantId, key);
  }

  purgeIdempotency(beforeIso: string): number {
    const r = stmt(this.db, 'DELETE FROM idempotency WHERE created_at < ?').run(beforeIso);
    return r.changes;
  }

  // ---------------------------------------------------------- action & cost

  upsertAction(tenantId: string, a: ActionSpec): void {
    run(this.db,
      `INSERT INTO action_catalog (tenant_id,action,pricing_mode,fixed_credits,default_face_value,
        min_face_value,fallback_action,fallback_model,markup_milli)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id,action) DO UPDATE SET
         pricing_mode=excluded.pricing_mode, fixed_credits=excluded.fixed_credits,
         default_face_value=excluded.default_face_value, min_face_value=excluded.min_face_value,
         fallback_action=excluded.fallback_action, fallback_model=excluded.fallback_model,
         markup_milli=excluded.markup_milli`,
      tenantId, a.action, a.pricing_mode, a.fixed_credits, a.default_face_value,
      a.min_face_value, a.fallback_action, a.fallback_model, a.markup_milli);
  }

  getAction(tenantId: string, action: string): ActionSpec | undefined {
    return one<ActionSpec>(this.db,
      `SELECT action,pricing_mode,fixed_credits,default_face_value,min_face_value,
              fallback_action,fallback_model,markup_milli
         FROM action_catalog WHERE tenant_id = ? AND action = ?`, tenantId, action);
  }

  costTableVersionExists(version: string): boolean {
    return one(this.db, 'SELECT 1 AS x FROM cost_table WHERE version = ? LIMIT 1', version) !== undefined;
  }

  insertCostRates(version: string, effectiveFrom: string, rates: readonly {
    provider: string; model: string; unit: string;
    input_micro_usd_per_unit: number; output_micro_usd_per_unit: number;
    cached_input_micro_usd_per_unit: number;
  }[]): void {
    for (const r of rates) {
      run(this.db,
        `INSERT INTO cost_table (version,provider,model,unit,input_micro_usd_per_unit,
          output_micro_usd_per_unit,cached_input_micro_usd_per_unit,effective_from)
         VALUES (?,?,?,?,?,?,?,?)`,
        version, r.provider, r.model, r.unit, r.input_micro_usd_per_unit,
        r.output_micro_usd_per_unit, r.cached_input_micro_usd_per_unit, effectiveFrom);
    }
  }

  latestCostVersion(): string | undefined {
    return one<{ version: string }>(this.db,
      'SELECT version FROM cost_table ORDER BY effective_from DESC, version DESC LIMIT 1')?.version;
  }

  // ----------------------------------------------------------------- outbox

  enqueueEvent(tenantId: string, type: string, subjectId: string | null, payload: JsonObject): string {
    const id = this.newId();
    run(this.db,
      `INSERT INTO event_outbox (event_id,tenant_id,type,subject_id,payload,created_at,next_attempt_at)
       VALUES (?,?,?,?,?,?,?)`,
      id, tenantId, type, subjectId, JSON.stringify(payload), this.now(), this.now());
    return id;
  }

  dueEvents(nowIso: string, limit = 50): OutboxEvent[] {
    const rows = all<{
      event_id: string; tenant_id: string; type: string; subject_id: string | null;
      payload: string; created_at: string; attempts: number;
    }>(this.db,
      `SELECT event_id,tenant_id,type,subject_id,payload,created_at,attempts FROM event_outbox
        WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`,
      nowIso, limit);
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as JsonObject }));
  }

  markDelivered(eventId: string): void {
    run(this.db, 'UPDATE event_outbox SET delivered_at = ? WHERE event_id = ?', this.now(), eventId);
  }

  markAttempted(eventId: string, nextAttemptIso: string | null): void {
    run(this.db, 'UPDATE event_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ?',
      nextAttemptIso, eventId);
  }

  eventsOfType(tenantId: string, type: string): OutboxEvent[] {
    const rows = all<{
      event_id: string; tenant_id: string; type: string; subject_id: string | null;
      payload: string; created_at: string; attempts: number;
    }>(this.db,
      'SELECT event_id,tenant_id,type,subject_id,payload,created_at,attempts FROM event_outbox WHERE tenant_id = ? AND type = ? ORDER BY created_at',
      tenantId, type);
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as JsonObject }));
  }

  // ------------------------------------------------------------ stripe, misc

  stripeEventSeen(eventId: string): boolean {
    return one(this.db, 'SELECT 1 AS x FROM stripe_event WHERE event_id = ?', eventId) !== undefined;
  }

  recordStripeEvent(eventId: string, tenantId: string): boolean {
    const r = stmt(this.db, 
      'INSERT OR IGNORE INTO stripe_event (event_id,tenant_id,processed_at) VALUES (?,?,?)',
    ).run(eventId, tenantId, this.now());
    return r.changes === 1;
  }

  recordRevenue(tenantId: string, subjectId: string, kind: 'subscription' | 'topup',
    amountMicroUsd: MicroUsd, periodStart: string, periodEnd: string, sourceRef: string | null): void {
    run(this.db,
      `INSERT INTO revenue_event (id,tenant_id,subject_id,kind,amount_micro_usd,period_start,period_end,source_ref)
       VALUES (?,?,?,?,?,?,?,?)`,
      this.newId(), tenantId, subjectId, kind, amountMicroUsd, periodStart, periodEnd, sourceRef);
  }

  revenueEvents(tenantId: string): {
    subject_id: string; kind: string; amount_micro_usd: number; period_start: string; period_end: string;
  }[] {
    return all(this.db,
      'SELECT subject_id,kind,amount_micro_usd,period_start,period_end FROM revenue_event WHERE tenant_id = ?',
      tenantId);
  }

  costBySubject(tenantId: string, fromIso: string, toIso: string): Map<string, MicroUsd> {
    const rows = all<{ subject_id: string; total: number }>(this.db,
      `SELECT subject_id, SUM(delta_cost_micro_usd) AS total FROM register
        WHERE tenant_id = ? AND at >= ? AND at <= ? GROUP BY subject_id`,
      tenantId, fromIso, toIso);
    return new Map(rows.map((r) => [r.subject_id, r.total]));
  }
}

export type { SubjectRow, TenantRow, AuthorizationRow, AppendRequest, OutboxEvent };
