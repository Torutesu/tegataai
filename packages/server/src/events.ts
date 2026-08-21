import { createHmac } from 'node:crypto';
import type { JsonObject } from '@tegata/core';
import type { OutboxEvent, Store } from '@tegata/store';

/**
 * Events go to an outbox inside the caller's transaction, so an event is never
 * emitted for a settlement that rolled back, and never lost for one that did not.
 */
export function fireEvent(
  store: Store, tenantId: string, type: string, subjectId: string | null, payload: JsonObject,
): void {
  const eventId = store.enqueueEvent(tenantId, type, subjectId, payload);
  applyRules(store, tenantId, type, subjectId, payload, eventId);
}

interface RuleRow {
  rule_id: string;
  on_event: string;
  when_expr: string;
  cooldown_hours: number;
  holdout_pct: number;
  action: string;
}

type Comparison = { gt?: number; gte?: number; lt?: number; lte?: number; eq?: number | string };

/**
 * condition -> action, evaluated when the event fires. Every rule carries a holdout
 * group by default, so the dashboard can answer whether the intervention worked
 * rather than whether it ran (PRD §10.4).
 */
export function applyRules(
  store: Store, tenantId: string, type: string, subjectId: string | null,
  payload: JsonObject, sourceEventId: string,
): void {
  if (subjectId === null) return;
  const rules = store.db.prepare(
    'SELECT rule_id,on_event,when_expr,cooldown_hours,holdout_pct,action FROM intervention_rule WHERE tenant_id = ? AND on_event = ? AND enabled = 1',
  ).all(tenantId, type) as RuleRow[];

  for (const rule of rules) {
    if (!conditionHolds(store, tenantId, subjectId, payload, JSON.parse(rule.when_expr) as Record<string, Comparison>)) continue;
    if (inCooldown(store, tenantId, rule, subjectId)) continue;

    // Seeded by subject and rule, so a subject's group assignment is stable and a
    // replay lands in the same arm.
    const holdout = pickHoldout(store, tenantId, rule.rule_id, subjectId, rule.holdout_pct);
    store.db.prepare(
      'INSERT OR REPLACE INTO rule_firing (tenant_id,rule_id,subject_id,fired_at,holdout) VALUES (?,?,?,?,?)',
    ).run(tenantId, rule.rule_id, subjectId, store.now(), holdout ? 1 : 0);

    if (holdout) continue;
    const action = JSON.parse(rule.action) as { type: string };
    if (action.type === 'webhook') {
      store.enqueueEvent(tenantId, 'intervention', subjectId, {
        rule_id: rule.rule_id, on: type, source_event_id: sourceEventId, event: payload,
      });
    }
  }
}

function conditionHolds(
  store: Store, tenantId: string, subjectId: string,
  payload: JsonObject, when: Record<string, Comparison>,
): boolean {
  for (const [field, cmp] of Object.entries(when)) {
    const actual = resolveField(store, tenantId, subjectId, payload, field);
    if (actual === undefined) return false;
    if (cmp.gt !== undefined && !(Number(actual) > cmp.gt)) return false;
    if (cmp.gte !== undefined && !(Number(actual) >= cmp.gte)) return false;
    if (cmp.lt !== undefined && !(Number(actual) < cmp.lt)) return false;
    if (cmp.lte !== undefined && !(Number(actual) <= cmp.lte)) return false;
    if (cmp.eq !== undefined && actual !== cmp.eq) return false;
  }
  return true;
}

function resolveField(
  store: Store, tenantId: string, subjectId: string, payload: JsonObject, field: string,
): number | string | undefined {
  if (field.startsWith('event.')) {
    const v = payload[field.slice(6)];
    return typeof v === 'number' || typeof v === 'string' ? v : undefined;
  }
  switch (field) {
    case 'subject.balance':
      return store.balances(tenantId, subjectId).balance;
    case 'subject.available':
      return store.balances(tenantId, subjectId).available;
    case 'subject.lifetime_credits_purchased': {
      const r = store.db.prepare(
        "SELECT COALESCE(SUM(credits_granted),0) AS n FROM entitlement WHERE tenant_id = ? AND subject_id = ? AND source IN ('topup','subscription')",
      ).get(tenantId, subjectId) as { n: number };
      return r.n;
    }
    case 'subject.days_since_signup': {
      const s = store.getSubject(tenantId, subjectId);
      if (s === undefined) return undefined;
      return Math.floor((store.nowMs() - Date.parse(s.created_at)) / 86_400_000);
    }
    default:
      return undefined;
  }
}

function inCooldown(store: Store, tenantId: string, rule: RuleRow, subjectId: string): boolean {
  if (rule.cooldown_hours <= 0) return false;
  const since = new Date(store.nowMs() - rule.cooldown_hours * 3_600_000).toISOString();
  const row = store.db.prepare(
    'SELECT 1 AS x FROM rule_firing WHERE tenant_id = ? AND rule_id = ? AND subject_id = ? AND fired_at >= ? LIMIT 1',
  ).get(tenantId, rule.rule_id, subjectId, since);
  return row !== undefined;
}

function pickHoldout(store: Store, tenantId: string, ruleId: string, subjectId: string, pct: number): boolean {
  if (pct <= 0) return false;
  // A stable hash of (tenant, rule, subject) — not the live RNG, so the arm does not
  // depend on how many events happened to fire before this one.
  let h = 2166136261 >>> 0;
  for (const ch of `${tenantId}:${ruleId}:${subjectId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  void store;
  return h % 100 < pct;
}

export interface DeliveryResult { delivered: number; failed: number; }

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number }>;

const BACKOFF_MS = [60_000, 300_000, 1_800_000, 10_800_000, 21_600_000];

/** Deliver what is due. Signature covers timestamp and body, with a five-minute window. */
export async function deliverDue(store: Store, fetcher: Fetcher, limit = 50): Promise<DeliveryResult> {
  const due = store.dueEvents(store.now(), limit);
  let delivered = 0, failed = 0;
  for (const ev of due) {
    const tenant = store.getTenant(ev.tenant_id);
    if (tenant?.webhook_url == null || tenant.webhook_secret == null) {
      store.markDelivered(ev.event_id);
      continue;
    }
    const body = JSON.stringify(envelope(ev));
    const ts = Math.floor(store.nowMs() / 1000);
    const sig = createHmac('sha256', tenant.webhook_secret).update(`${ts}.${body}`).digest('hex');
    try {
      const res = await fetcher(tenant.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'tegata-signature': `t=${ts},v1=${sig}` },
        body,
      });
      if (res.ok) { store.markDelivered(ev.event_id); delivered++; continue; }
      throw new Error(`status ${res.status}`);
    } catch {
      failed++;
      const next = BACKOFF_MS[ev.attempts];
      store.markAttempted(ev.event_id, next === undefined ? null : new Date(store.nowMs() + next).toISOString());
    }
  }
  return { delivered, failed };
}

export function envelope(ev: OutboxEvent): JsonObject {
  return {
    id: ev.event_id, type: ev.type, created_at: ev.created_at,
    subject_id: ev.subject_id, data: ev.payload,
  };
}

export function signatureFor(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
