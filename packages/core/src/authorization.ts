import type { AuthorizationState } from './types.js';

/**
 * The transition table from docs/plan/credits-mvp.md §5.1. Terminal states are
 * terminal: an authorization that was issued cannot later be dishonored, because
 * the action has already been permitted (spec/authorization.md §3).
 */
const TRANSITIONS: Readonly<Record<AuthorizationState, readonly AuthorizationState[]>> = {
  issued: ['captured', 'released', 'expired'],
  captured: [],
  released: [],
  expired: [],
  dishonored: [],
};

export function canTransition(from: AuthorizationState, to: AuthorizationState): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

export function isTerminal(state: AuthorizationState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function isOpen(state: AuthorizationState): boolean {
  return state === 'issued';
}

/** Maturity bounds, in seconds. spec/authorization.md §4.1. */
export const DEFAULT_MATURITY_SECONDS = 300;
export const MAX_MATURITY_SECONDS = 3600;

export function clampMaturitySeconds(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MATURITY_SECONDS;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError(`maturity_seconds must be a positive safe integer, got ${String(requested)}`);
  }
  return Math.min(requested, MAX_MATURITY_SECONDS);
}

export function hasMatured(maturityIso: string, nowIso: string): boolean {
  return nowIso >= maturityIso;
}
