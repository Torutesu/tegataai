import {
  type ActionSpec, type ActualUsage, type Credits, type DishonorReason, type Estimate,
  type JsonObject, type MicroUsd, type Policy, type PolicyViolation, type RegisterEntry,
  clampMaturitySeconds, err, evaluate, hasMatured, parseWindowMs, priceActual, priceEstimate,
  toIso,
} from '@tegata/core';
import type { AuthorizationRow, Store } from '@tegata/store';
import { assertRegisterEntry } from './schemas.js';
import { fireEvent } from './events.js';

export interface IssueRequest {
  subject_id: string;
  action: string;
  estimate?: Estimate;
  maturity_seconds?: number;
  context?: JsonObject;
  provisional?: boolean;
}

export interface IssueAuthorized {
  decision: 'authorized';
  authorization_id: string;
  face_value: Credits;
  available_after_hold: Credits;
  maturity: string;
}

export interface IssueDishonored {
  decision: 'dishonored';
  reason: DishonorReason;
  available: Credits;
  required: Credits;
  rule?: PolicyViolation;
  remedy?: { fallback_action: string; fallback_face_value: Credits };
}

export type IssueResult = IssueAuthorized | IssueDishonored;

/** Applies to a whole tenant in the MVP; the schema already carries the richer form. */
export function tenantPolicies(store: Store, tenantId: string): Policy[] {
  void store; void tenantId;
  return [];
}

function actionOrThrow(store: Store, tenantId: string, action: string): ActionSpec {
  const spec = store.getAction(tenantId, action);
  if (spec === undefined) throw err.notFound('Action', action);
  return spec;
}

function rateLookup(store: Store, tenantId: string, pin: string | null) {
  const version = pin ?? store.latestCostVersion() ?? '';
  return (provider: string, model: string) => {
    const override = store.db.prepare(
      `SELECT provider, model, 'token' AS unit, input_micro_usd_per_unit, output_micro_usd_per_unit,
              cached_input_micro_usd_per_unit
         FROM rate_override WHERE tenant_id = ? AND provider = ? AND model = ?`,
    ).get(tenantId, provider, model);
    if (override !== undefined) return override as never;
    const row = store.db.prepare(
      `SELECT provider, model, unit, input_micro_usd_per_unit, output_micro_usd_per_unit,
              cached_input_micro_usd_per_unit
         FROM cost_table WHERE version = ? AND provider = ? AND model = ?`,
    ).get(version, provider, model);
    return row as never;
  };
}

/** T1 / T2 — issue or dishonor. Never throws for a business refusal (spec §4.1). */
export function issue(store: Store, tenantId: string, req: IssueRequest): IssueResult {
  const tenant = store.getTenant(tenantId);
  if (tenant === undefined) throw err.notFound('Tenant', tenantId);
  const action = actionOrThrow(store, tenantId, req.action);

  return store.withSubject(() => {
    store.ensureSubject(tenantId, req.subject_id);
    const subject = store.getSubject(tenantId, req.subject_id);

    const pricing = priceEstimate(
      { action, creditUnitMicroUsd: tenant.credit_unit_micro_usd, lookupRate: rateLookup(store, tenantId, tenant.cost_table_pin) },
      req.estimate,
    );
    const faceValue = pricing.credits;
    const { available } = store.balances(tenantId, req.subject_id);

    const dishonor = (reason: DishonorReason, rule?: PolicyViolation): IssueDishonored => {
      const meta: JsonObject = { action: req.action, reason, required: faceValue, available };
      if (rule !== undefined) meta.rule = rule as unknown as JsonObject;
      const entry = store.append(tenantId, req.subject_id, {
        kind: 'dishonor', delta_amount: 0, meta,
        ...(rule === undefined ? {} : { policy_ref: { policy_id: rule.policy_id, version: rule.version } }),
      });
      assertRegisterEntry(toEntryJson(entry));
      const out: IssueDishonored = { decision: 'dishonored', reason, available, required: faceValue };
      if (rule !== undefined) out.rule = rule;
      // The remedy proposes; the caller decides. We never route the request ourselves.
      if (action.fallback_action !== null && reason === 'insufficient_balance') {
        const fb = store.getAction(tenantId, action.fallback_action);
        if (fb !== undefined) {
          out.remedy = {
            fallback_action: fb.action,
            fallback_face_value: priceEstimate(
              { action: fb, creditUnitMicroUsd: tenant.credit_unit_micro_usd, lookupRate: rateLookup(store, tenantId, tenant.cost_table_pin) },
              req.estimate,
            ).credits,
          };
        }
      }
      fireEvent(store, tenantId, 'authorization.dishonored', req.subject_id, {
        action: req.action, reason, required: faceValue, available,
      });
      const since = toIso(store.nowMs() - 86_400_000);
      if (store.recentDishonorCount(tenantId, req.subject_id, since) >= 3) {
        fireEvent(store, tenantId, 'dishonor.repeated', req.subject_id, { action: req.action, reason });
      }
      return out;
    };

    if (subject === undefined || subject.status !== 'active') return dishonor('subject_suspended');

    const policies = tenantPolicies(store, tenantId);
    if (policies.length > 0) {
      const windowMs = policies[0]?.limits?.per_period?.window;
      const periodSettled = windowMs === undefined
        ? 0
        : store.settledSince(tenantId, req.subject_id, toIso(store.nowMs() - parseWindowMs(windowMs)));
      const verdict = evaluate(policies, {
        action: req.action, faceValue, available,
        periodSettled, aggregateSettled: store.settledLifetime(tenantId, req.subject_id),
      });
      if (!verdict.allowed) return dishonor(verdict.reason, verdict.rule);
    }

    if (available < faceValue) return dishonor('insufficient_balance');

    const id = store.newId();
    const maturityMs = store.nowMs() + clampMaturitySeconds(req.maturity_seconds) * 1000;
    const row: AuthorizationRow = {
      authorization_id: id, tenant_id: tenantId, subject_id: req.subject_id, action: req.action,
      state: 'issued', face_value: faceValue, maturity: toIso(maturityMs),
      estimate: req.estimate === undefined ? null : JSON.stringify(req.estimate),
      context: req.context === undefined ? null : JSON.stringify(req.context),
      captured_amount: null, cost_micro_usd: null, dishonor_reason: null,
      provisional: req.provisional === true ? 1 : 0, created_at: store.now(), closed_at: null,
    };
    store.insertAuthorization(row);
    const meta: JsonObject = { face_value: faceValue, action: req.action };
    if (req.estimate !== undefined) meta.model = req.estimate.model;
    if (pricing.usedDefault) meta.priced_by_default = true;
    if (row.provisional === 1) meta.provisional = true;
    const entry = store.append(tenantId, req.subject_id, {
      kind: 'issue', delta_amount: 0, authorization_id: id, meta,
    });
    assertRegisterEntry(toEntryJson(entry));

    if (pricing.usedDefault && req.estimate !== undefined) {
      fireEvent(store, tenantId, 'cost_table.unknown_model', req.subject_id, {
        provider: req.estimate.provider, model: req.estimate.model, action: req.action,
      });
    }
    return {
      decision: 'authorized', authorization_id: id, face_value: faceValue,
      available_after_hold: store.balances(tenantId, req.subject_id).available,
      maturity: row.maturity,
    };
  });
}

export interface CaptureRequest {
  actual?: ActualUsage;
  amount?: Credits;
  cost_micro_usd?: MicroUsd;
  provider?: string;
  model?: string;
}

export interface CaptureResult {
  authorization_id: string;
  state: 'captured';
  captured_amount: Credits;
  released_remainder: Credits;
  balance: Credits;
  available: Credits;
  overdrawn: boolean;
}

/** T3 — settle. Must succeed: the action already ran (spec §4.2). */
export function capture(store: Store, tenantId: string, id: string, req: CaptureRequest): CaptureResult {
  const tenant = store.getTenant(tenantId);
  if (tenant === undefined) throw err.notFound('Tenant', tenantId);

  return store.withSubject(() => {
    const auth = store.getAuthorization(tenantId, id);
    if (auth === undefined) throw err.notFound('Authorization', id);
    if (auth.state !== 'issued') throw err.authorizationClosed(id, auth.state);
    if (hasMatured(auth.maturity, store.now())) throw err.authorizationMatured(id, auth.maturity);

    const action = actionOrThrow(store, tenantId, auth.action);
    const settled = settleAmount(store, tenantId, tenant.credit_unit_micro_usd, action, auth, req);

    store.drawFromStack(tenantId, auth.subject_id, id, settled.credits);
    store.closeAuthorization(id, {
      state: 'captured', captured_amount: settled.credits, cost_micro_usd: settled.costMicroUsd,
    });
    store.releaseReservation(tenantId, auth.subject_id, auth.face_value);

    const before = store.balances(tenantId, auth.subject_id);
    const entry = store.append(tenantId, auth.subject_id, {
      kind: 'capture', delta_amount: -settled.credits, delta_cost_micro_usd: settled.costMicroUsd,
      authorization_id: id,
      meta: {
        face_value: auth.face_value, action: auth.action,
        ...(settled.usedDefault ? { priced_by_default: true } : {}),
      },
    });
    assertRegisterEntry(toEntryJson(entry));

    const after = store.balances(tenantId, auth.subject_id);
    const overdrawn = after.balance < 0;
    if (overdrawn && before.balance >= 0) {
      fireEvent(store, tenantId, 'balance.overdrawn', auth.subject_id, {
        balance: after.balance, limit: tenant.max_overdraft_credits, authorization_id: id,
      });
    }
    emitBalanceSignals(store, tenantId, auth.subject_id, before.balance, after.balance, tenant.low_balance_pct);

    return {
      authorization_id: id, state: 'captured', captured_amount: settled.credits,
      released_remainder: Math.max(0, auth.face_value - settled.credits),
      balance: after.balance, available: after.available, overdrawn,
    };
  });
}

function settleAmount(
  store: Store, tenantId: string, creditUnit: number, action: ActionSpec,
  auth: AuthorizationRow, req: CaptureRequest,
): { credits: Credits; costMicroUsd: MicroUsd; usedDefault: boolean } {
  if (req.amount !== undefined) {
    return { credits: req.amount, costMicroUsd: req.cost_micro_usd ?? 0, usedDefault: false };
  }
  if (req.actual === undefined) {
    // Nothing measured and nothing stated: settle at the face value rather than at zero,
    // because the action ran and a free settlement would understate cost.
    return { credits: auth.face_value, costMicroUsd: 0, usedDefault: true };
  }
  const estimate = auth.estimate === null ? undefined : (JSON.parse(auth.estimate) as Estimate);
  const provider = req.provider ?? estimate?.provider ?? '';
  const model = req.model ?? estimate?.model ?? '';
  const priced = priceActual(
    { action, creditUnitMicroUsd: creditUnit, lookupRate: rateLookup(store, tenantId, store.getTenant(tenantId)?.cost_table_pin ?? null) },
    provider, model, req.actual,
  );
  return { credits: priced.credits, costMicroUsd: priced.costMicroUsd, usedDefault: priced.usedDefault };
}

/** T4 — release an unused hold. Idempotent. */
export function release(store: Store, tenantId: string, id: string, reason = 'released_by_caller'): {
  authorization_id: string; state: string; available: Credits;
} {
  return store.withSubject(() => {
    const auth = store.getAuthorization(tenantId, id);
    if (auth === undefined) throw err.notFound('Authorization', id);
    if (auth.state === 'released') {
      return { authorization_id: id, state: 'released', available: store.balances(tenantId, auth.subject_id).available };
    }
    if (auth.state !== 'issued') throw err.authorizationClosed(id, auth.state);

    store.closeAuthorization(id, { state: 'released' });
    store.releaseReservation(tenantId, auth.subject_id, auth.face_value);
    const entry = store.append(tenantId, auth.subject_id, {
      kind: 'release', delta_amount: 0, authorization_id: id,
      meta: { face_value: auth.face_value, reason },
    });
    assertRegisterEntry(toEntryJson(entry));
    return { authorization_id: id, state: 'released', available: store.balances(tenantId, auth.subject_id).available };
  });
}

/** Direct settlement — no hold, and never refused (PRD §7.9). */
export function directUsage(store: Store, tenantId: string, req: {
  subject_id: string; action: string; actual?: ActualUsage; amount?: Credits;
  cost_micro_usd?: MicroUsd; provider?: string; model?: string; context?: JsonObject;
}): { authorization_id: string; settled: Credits; balance: Credits; available: Credits } {
  const tenant = store.getTenant(tenantId);
  if (tenant === undefined) throw err.notFound('Tenant', tenantId);
  const action = actionOrThrow(store, tenantId, req.action);

  return store.withSubject(() => {
    store.ensureSubject(tenantId, req.subject_id);
    let credits: Credits;
    let costMicroUsd: MicroUsd;
    if (req.amount !== undefined) {
      credits = req.amount;
      costMicroUsd = req.cost_micro_usd ?? 0;
    } else {
      const priced = priceActual(
        { action, creditUnitMicroUsd: tenant.credit_unit_micro_usd, lookupRate: rateLookup(store, tenantId, tenant.cost_table_pin) },
        req.provider ?? '', req.model ?? '', req.actual ?? {},
      );
      credits = priced.credits;
      costMicroUsd = priced.costMicroUsd;
    }
    const before = store.balances(tenantId, req.subject_id);
    // A direct settlement still has an authorization; it is simply born settled, with
    // no hold that ever existed. That keeps every capture in the register pointing at
    // something an auditor can look up, which spec/register.md §3 assumes.
    const id = store.newId();
    store.insertAuthorization({
      authorization_id: id, tenant_id: tenantId, subject_id: req.subject_id, action: req.action,
      state: 'captured', face_value: credits, maturity: store.now(),
      estimate: null, context: req.context === undefined ? null : JSON.stringify(req.context),
      captured_amount: credits, cost_micro_usd: costMicroUsd, dishonor_reason: null,
      provisional: 0, created_at: store.now(), closed_at: store.now(),
    });
    store.drawFromStack(tenantId, req.subject_id, id, credits);
    const entry = store.append(tenantId, req.subject_id, {
      kind: 'capture', delta_amount: -credits, delta_cost_micro_usd: costMicroUsd,
      authorization_id: id,
      meta: { direct: true, action: req.action, face_value: credits, ...(req.context ?? {}) },
    });
    assertRegisterEntry(toEntryJson(entry));
    const after = store.balances(tenantId, req.subject_id);
    if (after.balance < 0 && before.balance >= 0) {
      fireEvent(store, tenantId, 'balance.overdrawn', req.subject_id,
        { balance: after.balance, limit: tenant.max_overdraft_credits });
    }
    emitBalanceSignals(store, tenantId, req.subject_id, before.balance, after.balance, tenant.low_balance_pct);
    return { authorization_id: id, settled: credits, balance: after.balance, available: after.available };
  });
}

/** T5 — a hold that reached maturity releases itself. */
export function expireMatured(store: Store, limit = 500): number {
  const due = store.maturedAuthorizations(store.now(), limit);
  let n = 0;
  for (const auth of due) {
    store.withSubject(() => {
      const fresh = store.getAuthorization(auth.tenant_id, auth.authorization_id);
      if (fresh === undefined || fresh.state !== 'issued') return;
      store.closeAuthorization(auth.authorization_id, { state: 'expired' });
      store.releaseReservation(auth.tenant_id, auth.subject_id, auth.face_value);
      store.append(auth.tenant_id, auth.subject_id, {
        kind: 'expire', delta_amount: 0, authorization_id: auth.authorization_id,
        meta: { face_value: auth.face_value, reason: 'maturity' },
      });
      n++;
    });
  }
  return n;
}

/**
 * The balance crossing a threshold is the most informative moment the system sees,
 * so it is emitted on the crossing, not on every settlement (PRD §10.2).
 */
function emitBalanceSignals(
  store: Store, tenantId: string, subjectId: string,
  before: Credits, after: Credits, lowPct: number,
): void {
  const granted = store.activeEntitlements(tenantId, subjectId)
    .reduce((a, e) => a + e.credits_granted, 0);
  const threshold = Math.floor((granted * lowPct) / 100);
  if (after <= 0 && before > 0) {
    fireEvent(store, tenantId, 'balance.depleted', subjectId, { balance: after });
  } else if (granted > 0 && after <= threshold && before > threshold) {
    fireEvent(store, tenantId, 'balance.low', subjectId,
      { balance: after, threshold, granted, pct: lowPct });
  }
}

export function toEntryJson(e: RegisterEntry): JsonObject {
  const o: JsonObject = {
    seq: e.seq, subject_id: e.subject_id, at: e.at, kind: e.kind,
    delta_amount: e.delta_amount, delta_cost_micro_usd: e.delta_cost_micro_usd,
    meta: e.meta, prev_hash: e.prev_hash, hash: e.hash,
  };
  if (e.authorization_id !== undefined) o.authorization_id = e.authorization_id;
  if (e.entitlement_id !== undefined) o.entitlement_id = e.entitlement_id;
  if (e.policy_ref !== undefined) o.policy_ref = { ...e.policy_ref };
  return o;
}
