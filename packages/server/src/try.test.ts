import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * `tegata try` is the first thing anyone runs, and the only claim it makes is that the
 * numbers on screen came from the run. So this checks the arithmetic rather than the
 * wording: a printed constant would pass a snapshot test and fail this one.
 */
const run = (): string => execFileSync(
  process.execPath,
  ['--import', 'tsx', 'packages/server/src/cli.ts', 'try'],
  { encoding: 'utf8', timeout: 60_000 },
);

const money = (s: string): number => Math.round(Number(s.replace('$', '')) * 1_000_000);

describe('the first command anyone runs', () => {
  const out = run();

  it('goes all the way to a verified ledger', () => {
    expect(out).toContain('authorized');
    expect(out).toMatch(/hash chain intact/);
    expect(out).not.toMatch(/BROKEN/);
  });

  it('settles for less than it held, because the estimate was an estimate', () => {
    const held = /face value (\d+)/.exec(out);
    const charged = /charged (\d+) of the (\d+) held/.exec(out);
    expect(held).not.toBeNull();
    expect(charged).not.toBeNull();
    expect(Number(charged![1])).toBeLessThan(Number(charged![2]));
    expect(charged![2]).toBe(held![1]);
  });

  it('shows a balance that agrees with what it charged', () => {
    const charged = Number(/charged (\d+) of/.exec(out)![1]);
    const balance = Number(/balance {3}(\d+) credits/.exec(out)![1]);
    expect(balance).toBe(1000 - charged);
    // Nothing is held any more, so all of it is spendable.
    expect(out).toMatch(new RegExp(`balance {3}${String(balance)} credits, 0 reserved, ${String(balance)} available`));
  });

  it('and a margin that is the subtraction it claims to be', () => {
    const m = /charged (\$[\d.]+), the model cost (\$[\d.]+), kept (\$[\d.]+)/.exec(out);
    expect(m).not.toBeNull();
    const [, charged, cost, kept] = m!;
    expect(money(charged!) - money(cost!)).toBe(money(kept!));
    // The charge is the credits it settled, at the tenant's credit unit.
    expect(money(charged!)).toBe(Number(/charged (\d+) of/.exec(out)![1]) * 20_000);
  });

  it('reports its own elapsed time, and leaves nothing behind', () => {
    expect(out).toMatch(/\d+ms, start to verified ledger/);
    const dir = /database in (\S+)/.exec(out)![1];
    expect(existsSync(dir!)).toBe(false);
  });

  it('never prints the key it made', () => {
    expect(out).not.toMatch(/sk_live_/);
  });
});
