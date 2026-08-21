import type { Credits, Entitlement } from './types.js';

/**
 * Consumption order (PRD §5.1). Deterministic and total, so a replay consumes the
 * same grants in the same order: cheapest-to-lose first, then oldest.
 */
export function consumptionOrder(a: Entitlement, b: Entitlement): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ax = a.expires_at, bx = b.expires_at;
  if (ax !== bx) {
    if (ax === null) return 1;      // no expiry sorts last
    if (bx === null) return -1;
    return ax < bx ? -1 : 1;
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.entitlement_id < b.entitlement_id ? -1 : a.entitlement_id > b.entitlement_id ? 1 : 0;
}

export interface Consumption {
  entitlement_id: string;
  credits: Credits;
}

/**
 * Draw `amount` from the entitlement stack. Returns what each grant gave up and
 * what could not be covered — the shortfall goes to the balance as an overdraft
 * rather than being silently dropped (PRD §7.7).
 */
export function consume(stack: readonly Entitlement[], amount: Credits): {
  consumptions: Consumption[];
  shortfall: Credits;
} {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError(`consume: amount must be a non-negative safe integer, got ${String(amount)}`);
  }
  const ordered = [...stack].filter((e) => e.status === 'active' && e.credits_remaining > 0).sort(consumptionOrder);
  const consumptions: Consumption[] = [];
  let left = amount;
  for (const e of ordered) {
    if (left === 0) break;
    const take = Math.min(left, e.credits_remaining);
    if (take > 0) {
      consumptions.push({ entitlement_id: e.entitlement_id, credits: take });
      left -= take;
    }
  }
  return { consumptions, shortfall: left };
}

/**
 * How much of a new grant is spent immediately repaying an overdraft.
 *
 * A capture that exceeds the stack settles anyway (PRD §7.7); the shortfall lands on
 * the balance alone, so the balance goes negative while the stack sits at zero. If the
 * next grant were credited in full, the stack would permanently exceed the balance and
 * stop describing the money that is actually there. Repaying first keeps
 * `stackRemaining === balance` true whenever the subject is solvent.
 */
export function overdraftRepayment(balanceBeforeGrant: Credits, granted: Credits): Credits {
  if (balanceBeforeGrant >= 0) return 0;
  return Math.min(granted, -balanceBeforeGrant);
}

/** Credits still available across a stack. */
export function stackRemaining(stack: readonly Entitlement[]): Credits {
  let total = 0;
  for (const e of stack) if (e.status === 'active') total += e.credits_remaining;
  return total;
}

/** Grants whose expiry has passed, in a deterministic order. */
export function expiredEntitlements(stack: readonly Entitlement[], nowIso: string): Entitlement[] {
  return stack
    .filter((e) => e.status === 'active' && e.expires_at !== null && e.expires_at <= nowIso)
    .sort(consumptionOrder);
}

/**
 * What a periodic refresh does to the grant being replaced (PRD §5.2).
 * `carry` is what survives into the new period; `expire` is what lapses now.
 */
export function refreshOutcome(
  previous: Entitlement,
  policy: Entitlement['refresh_policy'],
  cap: number | null,
): { carry: Credits; expire: Credits } {
  const remaining = previous.credits_remaining;
  switch (policy) {
    case 'reset':
      return { carry: 0, expire: remaining };
    case 'rollover':
      return { carry: remaining, expire: 0 };
    case 'rollover_capped': {
      const kept = cap === null ? remaining : Math.min(remaining, cap);
      return { carry: kept, expire: remaining - kept };
    }
  }
}
