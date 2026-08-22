import { createHmac, timingSafeEqual } from 'node:crypto';
import { type JsonObject, err, toIso } from '@tegata/core';
import { stmt } from '@tegata/store';
import type { Store } from '@tegata/store';
import { fireEvent } from './events.js';
import { refreshOutcome } from '@tegata/core';

const TOLERANCE_SECONDS = 300;

/**
 * Signature verification, written out rather than pulled in: it is thirty lines, and
 * a payment webhook is the last place to add a dependency we have not read.
 */
export function verifyStripeSignature(payload: string, header: string, secret: string, nowMs: number): void {
  // The header carries one `t` and one or more `v1`. More than one appears while a
  // secret is being rotated — Stripe signs with both, and a reader that keeps only the
  // last one rejects perfectly good deliveries for as long as the rotation lasts.
  let t = NaN;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') t = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (!Number.isFinite(t) || signatures.length === 0) throw err.validation('Malformed Stripe-Signature header');
  if (Math.abs(Math.floor(nowMs / 1000) - t) > TOLERANCE_SECONDS) {
    throw err.validation('Stripe signature timestamp outside tolerance');
  }
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'), 'utf8',
  );
  // Every candidate is compared, and compared in constant time: returning early on the
  // first match would leak which one matched through timing, and a length check that
  // short-circuits leaks nothing more than the length, which is fixed anyway.
  let matched = false;
  for (const candidate of signatures) {
    const given = Buffer.from(candidate, 'utf8');
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) throw err.validation('Stripe signature mismatch');
}

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

export interface StripeResult {
  received: true;
  handled: string;
  duplicate?: boolean;
  subject_id?: string;
  credits?: number;
}

/**
 * Stripe owns subscription state; we own the balance. Credits are granted on
 * invoice.paid rather than on subscription.created, so an unpaid subscription never
 * funds anything (PRD §6.3).
 */
export function handleStripeEvent(store: Store, tenantId: string, raw: JsonObject): StripeResult {
  const ev = raw as StripeEvent;
  const eventId = ev.id;
  const type = ev.type ?? 'unknown';
  if (typeof eventId !== 'string') throw err.validation('Stripe event is missing an id');

  if (!store.recordStripeEvent(eventId, tenantId)) {
    return { received: true, handled: type, duplicate: true };
  }
  const obj = ev.data?.object ?? {};

  switch (type) {
    case 'invoice.paid':
      return handleInvoicePaid(store, tenantId, obj, eventId);
    case 'checkout.session.completed':
      return handleCheckout(store, tenantId, obj, eventId);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(store, tenantId, obj);
    case 'customer.subscription.updated':
      // cancel_at_period_end needs no action: the entitlement's own expiry handles it.
      return { received: true, handled: type };
    default:
      return { received: true, handled: type };
  }
}

function resolveSubject(store: Store, tenantId: string, obj: Record<string, unknown>): string | undefined {
  const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
  const fromMetadata = metadata.tegata_subject_id;
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) {
    const s = store.ensureSubject(tenantId, fromMetadata);
    const customer = obj.customer;
    if (typeof customer === 'string') store.setSubjectExternalRef(tenantId, s.subject_id, { stripe_customer_id: customer });
    return s.subject_id;
  }
  const customer = obj.customer;
  if (typeof customer === 'string') {
    const found = store.subjectByStripeCustomer(tenantId, customer);
    if (found !== undefined) return found.subject_id;
  }
  return undefined;
}

function handleInvoicePaid(store: Store, tenantId: string, obj: Record<string, unknown>, eventId: string): StripeResult {
  const subjectId = resolveSubject(store, tenantId, obj);
  if (subjectId === undefined) {
    // Never drop a payment silently: an unmatched customer is a signal, not a no-op.
    fireEvent(store, tenantId, 'stripe.unmatched_customer', null,
      { event_id: eventId, customer: (obj.customer ?? null) as never, type: 'invoice.paid' });
    return { received: true, handled: 'invoice.paid' };
  }
  const lines = ((obj.lines as { data?: Record<string, unknown>[] } | undefined)?.data ?? []);
  let granted = 0;
  store.withSubject(() => {
    for (const line of lines) {
      const priceId = ((line.price ?? {}) as Record<string, unknown>).id;
      if (typeof priceId !== 'string') continue;
      const rule = stmt(store.db, 
        'SELECT credits_per_period,refresh_policy,rollover_cap_credits,priority FROM credit_grant_rule WHERE tenant_id = ? AND stripe_price_id = ?',
      ).get(tenantId, priceId) as {
        credits_per_period: number; refresh_policy: 'reset' | 'rollover' | 'rollover_capped';
        rollover_cap_credits: number | null; priority: number;
      } | undefined;
      if (rule === undefined) continue;

      // Apply the refresh policy to what the previous period left behind. Only the
      // part that does not carry lapses — a capped rollover must keep what fits.
      for (const prev of store.entitlementsBySourceRef(tenantId, priceId)) {
        const outcome = refreshOutcome(prev, rule.refresh_policy, rule.rollover_cap_credits);
        if (outcome.expire > 0) {
          store.expirePartialEntitlement(
            tenantId, subjectId, prev, outcome.expire, `refresh_${rule.refresh_policy}`,
          );
        }
      }
      const periodStart = numberOr(obj.period_start, store.nowMs() / 1000);
      const periodEnd = numberOr(obj.period_end, periodStart + 30 * 86_400);
      store.grant(tenantId, subjectId, {
        source: 'subscription', credits: rule.credits_per_period,
        expires_at: toIso(periodEnd * 1000), refresh_policy: rule.refresh_policy,
        rollover_cap_credits: rule.rollover_cap_credits, priority: rule.priority,
        amount_micro_usd: 0, source_ref: priceId,
      });
      granted += rule.credits_per_period;
    }
    const paid = numberOr(obj.amount_paid, 0);
    if (paid > 0) {
      const periodStart = numberOr(obj.period_start, store.nowMs() / 1000);
      const periodEnd = numberOr(obj.period_end, periodStart + 30 * 86_400);
      store.recordRevenue(tenantId, subjectId, 'subscription', paid * 10_000,
        toIso(periodStart * 1000), toIso(periodEnd * 1000), eventId);
    }
  });
  if (granted > 0) fireEvent(store, tenantId, 'entitlement.refreshed', subjectId, { credits: granted });
  return { received: true, handled: 'invoice.paid', subject_id: subjectId, credits: granted };
}

function handleCheckout(store: Store, tenantId: string, obj: Record<string, unknown>, eventId: string): StripeResult {
  if (obj.mode !== 'payment') return { received: true, handled: 'checkout.session.completed' };
  const subjectId = resolveSubject(store, tenantId, obj);
  const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
  const credits = Number(metadata.tegata_credits ?? 0);
  if (subjectId === undefined || !Number.isSafeInteger(credits) || credits <= 0) {
    fireEvent(store, tenantId, 'stripe.unmatched_customer', null,
      { event_id: eventId, customer: (obj.customer ?? null) as never, type: 'checkout.session.completed' });
    return { received: true, handled: 'checkout.session.completed' };
  }
  const amount = numberOr(obj.amount_total, 0) * 10_000;
  store.withSubject(() => {
    store.grant(tenantId, subjectId, { source: 'topup', credits, priority: 200, amount_micro_usd: amount });
    if (amount > 0) {
      store.recordRevenue(tenantId, subjectId, 'topup', amount,
        store.now(), toIso(store.nowMs() + 30 * 86_400_000), eventId);
    }
  });
  return { received: true, handled: 'checkout.session.completed', subject_id: subjectId, credits };
}

function handleSubscriptionDeleted(store: Store, tenantId: string, obj: Record<string, unknown>): StripeResult {
  const subjectId = resolveSubject(store, tenantId, obj);
  if (subjectId === undefined) return { received: true, handled: 'customer.subscription.deleted' };
  store.withSubject(() => {
    for (const ent of store.activeEntitlements(tenantId, subjectId)) {
      if (ent.source !== 'subscription') continue;
      store.expireEntitlement(tenantId, subjectId, ent, 'revoked');
    }
  });
  return { received: true, handled: 'customer.subscription.deleted', subject_id: subjectId };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
