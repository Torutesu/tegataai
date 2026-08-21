import type {
  ActionSpec, Credits, DegradedMode, Entitlement, JsonObject, MicroUsd, PolicyRef,
  RegisterEntry, SubjectStatus,
} from '@tegata/core';

export interface TenantRow {
  tenant_id: string;
  name: string;
  secret_key_hash: string;
  credit_unit_micro_usd: number;
  degraded_mode: DegradedMode;
  max_overdraft_credits: Credits;
  cost_table_pin: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  low_balance_pct: number;
  created_at: string;
}

export interface SubjectRow {
  tenant_id: string;
  subject_id: string;
  status: SubjectStatus;
  external_ref: string | null;
  created_at: string;
}

export interface AuthorizationRow {
  authorization_id: string;
  tenant_id: string;
  subject_id: string;
  action: string;
  state: 'issued' | 'captured' | 'released' | 'expired' | 'dishonored';
  face_value: Credits;
  maturity: string;
  estimate: string | null;
  context: string | null;
  captured_amount: Credits | null;
  cost_micro_usd: MicroUsd | null;
  dishonor_reason: string | null;
  provisional: number;
  created_at: string;
  closed_at: string | null;
}

export interface AppendRequest {
  kind: RegisterEntry['kind'];
  delta_amount: Credits;
  delta_cost_micro_usd?: MicroUsd;
  authorization_id?: string;
  entitlement_id?: string;
  policy_ref?: PolicyRef;
  meta?: JsonObject;
}

export interface OutboxEvent {
  event_id: string;
  tenant_id: string;
  type: string;
  subject_id: string | null;
  payload: JsonObject;
  created_at: string;
  attempts: number;
}

export type { ActionSpec, Entitlement };
