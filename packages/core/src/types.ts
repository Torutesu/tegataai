/** Shared vocabulary. The names come from the lexicon in docs/00-master.md §4.3. */

/** Credits are integers. Costs are integer micro-USD. Never a float. */
export type Credits = number;
export type MicroUsd = number;

export type SubjectStatus = 'active' | 'suspended' | 'deleted';

export type AuthorizationState =
  | 'issued'
  | 'captured'
  | 'released'
  | 'expired'
  | 'dishonored';

/** spec/authorization.md §5. `rate_limited` and `service_degraded` are reserved for later. */
export type DishonorReason =
  | 'insufficient_balance'
  | 'entitlement_expired'
  | 'policy_denied'
  | 'budget_exhausted_period'
  | 'rate_limited'
  | 'subject_suspended'
  | 'action_unknown'
  | 'service_degraded';

/** spec/register.md §3. Holds carry delta 0; only settlement moves the balance. */
export type RegisterKind =
  | 'grant'
  | 'issue'
  | 'capture'
  | 'release'
  | 'expire'
  | 'dishonor'
  | 'event'
  | 'adjust';

export type EntitlementSource = 'subscription' | 'topup' | 'grant' | 'promo';
export type RefreshPolicy = 'reset' | 'rollover' | 'rollover_capped';
export type DegradedMode = 'allow' | 'allow_cheap_only' | 'deny';
export type PricingMode = 'token_based' | 'fixed' | 'unit_based';

export interface PolicyRef {
  policy_id: string;
  version: number;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** One line of the book of record. spec/register.md §2. */
export interface RegisterEntry {
  seq: number;
  subject_id: string;
  at: string;
  kind: RegisterKind;
  delta_amount: Credits;
  delta_cost_micro_usd: MicroUsd;
  authorization_id?: string;
  entitlement_id?: string;
  policy_ref?: PolicyRef;
  meta: JsonObject;
  prev_hash: string;
  hash: string;
}

/** An entry before it is sealed into the chain. */
export type UnsealedEntry = Omit<RegisterEntry, 'seq' | 'prev_hash' | 'hash'>;

export interface Entitlement {
  entitlement_id: string;
  subject_id: string;
  source: EntitlementSource;
  credits_granted: Credits;
  credits_remaining: Credits;
  effective_from: string;
  expires_at: string | null;
  refresh_policy: RefreshPolicy;
  rollover_cap_credits: number | null;
  priority: number;
  status: 'active' | 'expired' | 'revoked';
  amount_micro_usd: MicroUsd;
  source_ref: string | null;
  created_at: string;
}

/** The three derived figures. spec/register.md §4. */
export interface Balances {
  balance: Credits;
  reserved: Credits;
  available: Credits;
}

export interface ActionSpec {
  action: string;
  pricing_mode: PricingMode;
  fixed_credits: number | null;
  default_face_value: Credits;
  min_face_value: Credits;
  fallback_action: string | null;
  /** The model the fallback action would use, so a remedy can be priced honestly. */
  fallback_model: string | null;
  /** Thousandths. 1000 = x1.0 — a multiplier without a float. */
  markup_milli: number;
}

export interface CostRate {
  provider: string;
  model: string;
  unit: 'token' | 'image' | 'second' | 'request';
  input_micro_usd_per_unit: MicroUsd;
  output_micro_usd_per_unit: MicroUsd;
  cached_input_micro_usd_per_unit: MicroUsd;
}

export interface Estimate {
  provider: string;
  model: string;
  input_tokens?: number;
  max_output_tokens?: number;
  cached_input_tokens?: number;
  units?: number;
}

export interface ActualUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  units?: number;
}
