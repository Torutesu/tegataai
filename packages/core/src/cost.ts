import type { ActionSpec, ActualUsage, CostRate, Credits, Estimate, MicroUsd } from './types.js';

export interface RateLookup {
  (provider: string, model: string): CostRate | undefined;
}

/**
 * Provider cost in integer micro-USD. Token counts are integers, rates are
 * micro-USD per unit, so nothing here is ever fractional.
 */
export function costOfUsage(rate: CostRate, usage: ActualUsage): MicroUsd {
  if (rate.unit === 'token') {
    const cached = usage.cached_input_tokens ?? 0;
    const input = Math.max(0, (usage.input_tokens ?? 0) - cached);
    const output = usage.output_tokens ?? 0;
    return (
      input * rate.input_micro_usd_per_unit +
      output * rate.output_micro_usd_per_unit +
      cached * rate.cached_input_micro_usd_per_unit
    );
  }
  const units = usage.units ?? 1;
  return units * rate.input_micro_usd_per_unit;
}

/** The ceiling an estimate implies: the caller's stated worst case. */
export function costOfEstimate(rate: CostRate, estimate: Estimate): MicroUsd {
  return costOfUsage(rate, {
    input_tokens: estimate.input_tokens ?? 0,
    output_tokens: estimate.max_output_tokens ?? 0,
    cached_input_tokens: estimate.cached_input_tokens ?? 0,
    units: estimate.units ?? 1,
  });
}

/**
 * Cost to credits. Multiply before dividing so the markup never rounds twice, and
 * round up — the tenant should not lose money to arithmetic (PRD §5.1, §9.2).
 * `markup_milli` is thousandths (1000 = x1.0): a multiplier without a float.
 */
export function creditsForCost(
  costMicroUsd: MicroUsd,
  markupMilli: number,
  creditUnitMicroUsd: number,
): Credits {
  if (!Number.isSafeInteger(costMicroUsd) || costMicroUsd < 0) {
    throw new TypeError(`creditsForCost: cost must be a non-negative safe integer, got ${String(costMicroUsd)}`);
  }
  if (!Number.isSafeInteger(markupMilli) || markupMilli <= 0) {
    throw new TypeError(`creditsForCost: markup_milli must be a positive safe integer, got ${String(markupMilli)}`);
  }
  if (!Number.isSafeInteger(creditUnitMicroUsd) || creditUnitMicroUsd <= 0) {
    throw new TypeError(`creditsForCost: credit_unit_micro_usd must be positive, got ${String(creditUnitMicroUsd)}`);
  }
  const scaled = costMicroUsd * markupMilli;
  const divisor = 1000 * creditUnitMicroUsd;
  return Math.ceil(scaled / divisor);
}

export interface PricingContext {
  action: ActionSpec;
  creditUnitMicroUsd: number;
  lookupRate: RateLookup;
}

export interface PricingResult {
  credits: Credits;
  costMicroUsd: MicroUsd;
  /** True when no rate was found and the action's declared default was used instead. */
  usedDefault: boolean;
}

/**
 * Face value for an issue. An unknown model falls back to the action's declared
 * default rather than refusing — a missing rate is our gap, not the caller's
 * (spec/authorization.md §2.2).
 */
export function priceEstimate(ctx: PricingContext, estimate: Estimate | undefined): PricingResult {
  const { action } = ctx;
  if (action.pricing_mode === 'fixed') {
    const credits = Math.max(action.fixed_credits ?? action.default_face_value, action.min_face_value);
    return { credits, costMicroUsd: 0, usedDefault: false };
  }
  if (estimate === undefined) {
    return { credits: Math.max(action.default_face_value, action.min_face_value), costMicroUsd: 0, usedDefault: true };
  }
  const rate = ctx.lookupRate(estimate.provider, estimate.model);
  if (rate === undefined) {
    return { credits: Math.max(action.default_face_value, action.min_face_value), costMicroUsd: 0, usedDefault: true };
  }
  const costMicroUsd = costOfEstimate(rate, estimate);
  const credits = Math.max(
    creditsForCost(costMicroUsd, action.markup_milli, ctx.creditUnitMicroUsd),
    action.min_face_value,
  );
  return { credits, costMicroUsd, usedDefault: false };
}

/** Settled amount for a capture, from measured usage. */
export function priceActual(ctx: PricingContext, provider: string, model: string, usage: ActualUsage): PricingResult {
  const rate = ctx.lookupRate(provider, model);
  if (rate === undefined) {
    return { credits: Math.max(ctx.action.default_face_value, ctx.action.min_face_value), costMicroUsd: 0, usedDefault: true };
  }
  const costMicroUsd = costOfUsage(rate, usage);
  return {
    credits: creditsForCost(costMicroUsd, ctx.action.markup_milli, ctx.creditUnitMicroUsd),
    costMicroUsd,
    usedDefault: false,
  };
}
