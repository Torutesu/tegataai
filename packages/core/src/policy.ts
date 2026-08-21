import type { Credits, DishonorReason, PolicyRef } from './types.js';

/**
 * The MVP subset of spec/policy.md: limits, scope.actions, overdraft, degraded.
 * Schedule, purpose, merchants, and the approval ladder are Wallet-side and are
 * deliberately absent (docs/plan/credits-mvp.md §1.2) rather than half-implemented.
 */
export interface Policy {
  policy_id: string;
  version: number;
  limits?: {
    per_action?: { max: Credits };
    per_period?: { window: string; max: Credits; align?: 'rolling' | 'calendar' };
    aggregate?: { max: Credits };
  };
  scope?: {
    actions?: { allow?: string[]; deny?: string[] };
  };
  overdraft?: { max: Credits };
}

export interface PolicyInput {
  action: string;
  faceValue: Credits;
  available: Credits;
  /** Settled within the policy's rolling window. */
  periodSettled: Credits;
  /** Settled over the subject's lifetime. */
  aggregateSettled: Credits;
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: DishonorReason; rule: PolicyViolation };

export interface PolicyViolation {
  policy_id: string;
  version: number;
  clause: string;
  detail: Record<string, number | string>;
}

/**
 * Evaluate in the order spec/policy.md §4 fixes, and report which clause refused.
 * "Denied" without a clause is unoperable: the holder needs to know which limit to
 * raise (spec/policy.md §4).
 */
export function evaluate(policies: readonly Policy[], input: PolicyInput): PolicyDecision {
  for (const p of policies) {
    const ref: PolicyRef = { policy_id: p.policy_id, version: p.version };

    const deny = p.scope?.actions?.deny;
    if (deny !== undefined && matches(deny, input.action)) {
      return refuse(ref, 'scope.actions.deny', { action: input.action });
    }
    const allow = p.scope?.actions?.allow;
    if (allow !== undefined && !matches(allow, input.action)) {
      // An empty or non-matching allow list means nothing is allowed, not everything.
      return refuse(ref, 'scope.actions.allow', { action: input.action });
    }

    const perAction = p.limits?.per_action;
    if (perAction !== undefined && input.faceValue > perAction.max) {
      return refuse(ref, 'limits.per_action', { max: perAction.max, requested: input.faceValue });
    }

    const perPeriod = p.limits?.per_period;
    if (perPeriod !== undefined && input.periodSettled + input.faceValue > perPeriod.max) {
      return refuse(ref, 'limits.per_period', {
        window: perPeriod.window, max: perPeriod.max,
        used: input.periodSettled, requested: input.faceValue,
      }, 'budget_exhausted_period');
    }

    const aggregate = p.limits?.aggregate;
    if (aggregate !== undefined && input.aggregateSettled + input.faceValue > aggregate.max) {
      return refuse(ref, 'limits.aggregate', {
        max: aggregate.max, used: input.aggregateSettled, requested: input.faceValue,
      }, 'budget_exhausted_period');
    }
  }
  return { allowed: true };
}

function refuse(
  ref: PolicyRef,
  clause: string,
  detail: Record<string, number | string>,
  reason: DishonorReason = 'policy_denied',
): PolicyDecision {
  return { allowed: false, reason, rule: { ...ref, clause, detail } };
}

/** Glob matching limited to a trailing '*', which is all the schema's patterns use. */
export function matches(patterns: readonly string[], value: string): boolean {
  for (const p of patterns) {
    if (p === '*') return true;
    if (p.endsWith('*')) { if (value.startsWith(p.slice(0, -1))) return true; }
    else if (p === value) return true;
  }
  return false;
}

/** ISO 8601 durations restricted to days, hours and minutes (spec/policy.md §3.2). */
export function parseWindowMs(window: string): number {
  // Same shape as the pattern in spec/schema/policy.schema.json: the lookaheads reject
  // the empty designators 'P', 'PT' and a dangling 'P1DT'.
  const m = /^P(?=.)(?:(\d+)D)?(?:T(?=.)(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(window);
  if (m === null) {
    throw new TypeError(`unsupported window '${window}': use days, hours, or minutes (P1D, PT6H)`);
  }
  const days = Number(m[1] ?? 0), hours = Number(m[2] ?? 0), mins = Number(m[3] ?? 0);
  const ms = ((days * 24 + hours) * 60 + mins) * 60_000;
  if (ms <= 0) throw new TypeError(`window '${window}' must be a positive duration`);
  return ms;
}
