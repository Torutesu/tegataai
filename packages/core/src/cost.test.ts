import { describe, expect, it } from 'vitest';
import { costOfEstimate, costOfUsage, creditsForCost, priceActual, priceEstimate } from './cost.js';
import type { ActionSpec, CostRate } from './types.js';

// Rates in micro-USD per token: $15/M input, $75/M output, $1.50/M cached.
const opus: CostRate = {
  provider: 'anthropic', model: 'claude-opus-5', unit: 'token',
  input_micro_usd_per_unit: 15, output_micro_usd_per_unit: 75,
  cached_input_micro_usd_per_unit: 1,
};
const image: CostRate = {
  provider: 'acme', model: 'diffuse-1', unit: 'image',
  input_micro_usd_per_unit: 40_000, output_micro_usd_per_unit: 0, cached_input_micro_usd_per_unit: 0,
};

const action = (over: Partial<ActionSpec> = {}): ActionSpec => ({
  action: 'chat.completion', pricing_mode: 'token_based', fixed_credits: null,
  default_face_value: 25, min_face_value: 1, fallback_action: null, fallback_model: null, markup_milli: 1000, ...over,
});

const lookup = (p: string, m: string): CostRate | undefined =>
  p === 'anthropic' && m === 'claude-opus-5' ? opus : p === 'acme' && m === 'diffuse-1' ? image : undefined;

describe('provider cost', () => {
  it('bills cached input at the cached rate and never twice', () => {
    // 12,400 input of which 8,000 cached: 4,400 fresh at 15 + 8,000 cached at 1 + 1,180 out at 75.
    expect(costOfUsage(opus, { input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 }))
      .toBe(4_400 * 15 + 8_000 * 1 + 1_180 * 75);
  });

  it('treats cached tokens beyond the input count as zero fresh input, not negative', () => {
    expect(costOfUsage(opus, { input_tokens: 100, cached_input_tokens: 500 })).toBe(500 * 1);
  });

  it('prices non-token units per unit', () => {
    expect(costOfUsage(image, { units: 3 })).toBe(120_000);
    expect(costOfUsage(image, {})).toBe(40_000);
  });

  it('takes the stated worst case from an estimate', () => {
    expect(costOfEstimate(opus, { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 1_000, max_output_tokens: 2_000 }))
      .toBe(1_000 * 15 + 2_000 * 75);
  });
});

describe('cost to credits', () => {
  it('rounds up, so arithmetic never costs the tenant money', () => {
    expect(creditsForCost(20_001, 1000, 20_000)).toBe(2);
    expect(creditsForCost(20_000, 1000, 20_000)).toBe(1);
    expect(creditsForCost(1, 1000, 20_000)).toBe(1);
    expect(creditsForCost(0, 1000, 20_000)).toBe(0);
  });

  it('applies markup before dividing, so it never rounds twice', () => {
    // 30,000 micro-USD at x1.5 is 45,000, which is 2.25 credits of 20,000 -> 3.
    expect(creditsForCost(30_000, 1500, 20_000)).toBe(3);
    // Rounding after the division would have given ceil(2) * 1.5 = 3 here too, so use a
    // case where the order matters: 10,001 at x2 is 20,002 -> 2 credits, not ceil(1)*2 = 2.
    expect(creditsForCost(10_001, 2000, 20_000)).toBe(2);
    expect(creditsForCost(10_000, 2000, 20_000)).toBe(1);
  });

  it('honours the tenant peg', () => {
    expect(creditsForCost(100_000, 1000, 20_000)).toBe(5);
    expect(creditsForCost(100_000, 1000, 1_000)).toBe(100);
  });

  it('refuses anything that is not a positive integer configuration', () => {
    expect(() => creditsForCost(1.5, 1000, 20_000)).toThrow(/safe integer/);
    expect(() => creditsForCost(100, 0, 20_000)).toThrow(/markup/);
    expect(() => creditsForCost(100, 1000, 0)).toThrow(/credit_unit/);
    expect(() => creditsForCost(-1, 1000, 20_000)).toThrow(/non-negative/);
  });
});

describe('pricing an authorization', () => {
  const ctx = { action: action(), creditUnitMicroUsd: 20_000, lookupRate: lookup };

  it('prices a token estimate at its ceiling', () => {
    const r = priceEstimate(ctx, { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 12_400, max_output_tokens: 2_000, cached_input_tokens: 8_000 });
    expect(r.usedDefault).toBe(false);
    expect(r.costMicroUsd).toBe(4_400 * 15 + 8_000 + 2_000 * 75);
    expect(r.credits).toBe(Math.ceil(r.costMicroUsd / 20_000));
  });

  it('falls back to the declared default for an unknown model rather than refusing', () => {
    const r = priceEstimate(ctx, { provider: 'openai', model: 'not-in-the-table', input_tokens: 999 });
    expect(r).toEqual({ credits: 25, costMicroUsd: 0, usedDefault: true });
  });

  it('falls back when no estimate is supplied at all', () => {
    expect(priceEstimate(ctx, undefined).usedDefault).toBe(true);
  });

  it('uses the fixed price for a fixed action and ignores any estimate', () => {
    const fixedCtx = { ...ctx, action: action({ pricing_mode: 'fixed', fixed_credits: 12 }) };
    expect(priceEstimate(fixedCtx, { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 1e6 }))
      .toEqual({ credits: 12, costMicroUsd: 0, usedDefault: false });
  });

  it('never prices below the action floor', () => {
    const floored = { ...ctx, action: action({ min_face_value: 10 }) };
    const r = priceEstimate(floored, { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 1 });
    expect(r.credits).toBe(10);
  });

  it('prices a settlement from measured usage', () => {
    const r = priceActual(ctx, 'anthropic', 'claude-opus-5', { input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 });
    expect(r.costMicroUsd).toBe(4_400 * 15 + 8_000 + 1_180 * 75);
    expect(r.credits).toBe(Math.ceil(r.costMicroUsd / 20_000));
  });

  it('does not apply the action floor to a settlement of nothing', () => {
    const r = priceActual(ctx, 'anthropic', 'claude-opus-5', {});
    expect(r.credits).toBe(0);
  });
});
