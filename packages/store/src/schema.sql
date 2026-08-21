PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE tenant (
  tenant_id            TEXT PRIMARY KEY,          -- ULID
  name                 TEXT NOT NULL,
  secret_key_hash      TEXT NOT NULL,             -- SHA-256(hex)
  credit_unit_micro_usd INTEGER NOT NULL DEFAULT 20000 CHECK (credit_unit_micro_usd > 0),
  degraded_mode        TEXT NOT NULL DEFAULT 'allow'
                         CHECK (degraded_mode IN ('allow','allow_cheap_only','deny')),
  max_overdraft_credits INTEGER NOT NULL DEFAULT 200 CHECK (max_overdraft_credits >= 0),
  cost_table_pin       TEXT,                      -- NULL = 最新追従
  webhook_url          TEXT,
  webhook_secret       TEXT,
  low_balance_pct      INTEGER NOT NULL DEFAULT 20 CHECK (low_balance_pct BETWEEN 1 AND 99),
  created_at           TEXT NOT NULL
);

CREATE TABLE subject (
  tenant_id   TEXT NOT NULL REFERENCES tenant(tenant_id),
  subject_id  TEXT NOT NULL,                      -- テナント側外部ID（不透明）
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  external_ref TEXT,                              -- JSON: {stripe_customer_id?}
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, subject_id)
);

CREATE TABLE entitlement (
  entitlement_id    TEXT PRIMARY KEY,             -- ULID
  tenant_id         TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('subscription','topup','grant','promo')),
  credits_granted   INTEGER NOT NULL CHECK (credits_granted > 0),
  credits_remaining INTEGER NOT NULL CHECK (credits_remaining >= 0),
  effective_from    TEXT NOT NULL,
  expires_at        TEXT,                          -- NULL = 無期限
  refresh_policy    TEXT NOT NULL DEFAULT 'reset'
                      CHECK (refresh_policy IN ('reset','rollover','rollover_capped')),
  rollover_cap_credits INTEGER,
  priority          INTEGER NOT NULL DEFAULT 100,  -- 小さいほど先に消費
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  amount_micro_usd  INTEGER NOT NULL DEFAULT 0,    -- 収益認識用の対価（promo は 0）
  source_ref        TEXT,                          -- stripe invoice id 等
  created_at        TEXT NOT NULL,
  FOREIGN KEY (tenant_id, subject_id) REFERENCES subject(tenant_id, subject_id)
);
CREATE INDEX idx_ent_subject ON entitlement(tenant_id, subject_id, status);

CREATE TABLE authorization_ (
  authorization_id TEXT PRIMARY KEY,               -- ULID
  tenant_id        TEXT NOT NULL,
  subject_id       TEXT NOT NULL,
  action           TEXT NOT NULL,
  state            TEXT NOT NULL
                     CHECK (state IN ('issued','captured','released','expired','dishonored')),
  face_value       INTEGER NOT NULL CHECK (face_value >= 0),
  maturity         TEXT NOT NULL,
  estimate         TEXT,                           -- JSON 原文
  context          TEXT,                           -- JSON 原文
  captured_amount  INTEGER CHECK (captured_amount >= 0),
  cost_micro_usd   INTEGER CHECK (cost_micro_usd >= 0),
  dishonor_reason  TEXT,
  provisional      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  closed_at        TEXT
);
CREATE INDEX idx_auth_open ON authorization_(tenant_id, subject_id, state)
  WHERE state = 'issued';
CREATE INDEX idx_auth_maturity ON authorization_(maturity) WHERE state = 'issued';

CREATE TABLE register (
  tenant_id            TEXT NOT NULL,
  subject_id           TEXT NOT NULL,
  seq                  INTEGER NOT NULL,           -- subject 内 1 始まり、欠番なし
  at                   TEXT NOT NULL,
  kind                 TEXT NOT NULL
    CHECK (kind IN ('grant','issue','capture','release','expire','dishonor','event','adjust')),
  delta_amount         INTEGER NOT NULL,
  delta_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  authorization_id     TEXT,
  entitlement_id       TEXT,
  policy_ref           TEXT,                       -- JSON {policy_id,version}
  meta                 TEXT NOT NULL DEFAULT '{}', -- JSON
  prev_hash            TEXT NOT NULL,              -- 64 hex
  hash                 TEXT NOT NULL,              -- 64 hex
  PRIMARY KEY (tenant_id, subject_id, seq)
);
-- UPDATE/DELETE の物理禁止（spec/register.md §3）
CREATE TRIGGER register_no_update BEFORE UPDATE ON register
  BEGIN SELECT RAISE(ABORT, 'register is append-only'); END;
CREATE TRIGGER register_no_delete BEFORE DELETE ON register
  BEGIN SELECT RAISE(ABORT, 'register is append-only'); END;

CREATE TABLE balance_projection (     -- 導出物。register が常に勝つ
  tenant_id  TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  balance    INTEGER NOT NULL,
  reserved   INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, subject_id)
);

CREATE TABLE idempotency (
  tenant_id    TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  request_hash TEXT NOT NULL,          -- SHA-256(JCS(body) ‖ path)
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,          -- JSON 原文
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idem_key)
);

CREATE TABLE action_catalog (
  tenant_id          TEXT NOT NULL,
  action             TEXT NOT NULL,
  pricing_mode       TEXT NOT NULL CHECK (pricing_mode IN ('token_based','fixed','unit_based')),
  fixed_credits      INTEGER,
  default_face_value INTEGER NOT NULL,
  min_face_value     INTEGER NOT NULL DEFAULT 1,
  fallback_action    TEXT,
  fallback_model     TEXT,
  markup_milli       INTEGER NOT NULL DEFAULT 1000,  -- 1000 = ×1.0（整数のみ規則のため千分率）
  PRIMARY KEY (tenant_id, action)
);

CREATE TABLE cost_table (
  version        TEXT NOT NULL,        -- 'v2026-08-21.1' 形式。追記のみ
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  unit           TEXT NOT NULL CHECK (unit IN ('token','image','second','request')),
  input_micro_usd_per_unit  INTEGER NOT NULL DEFAULT 0,
  output_micro_usd_per_unit INTEGER NOT NULL DEFAULT 0,
  cached_input_micro_usd_per_unit INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT NOT NULL,
  PRIMARY KEY (version, provider, model)
);

CREATE TABLE rate_override (
  tenant_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_micro_usd_per_unit INTEGER NOT NULL DEFAULT 0,
  output_micro_usd_per_unit INTEGER NOT NULL DEFAULT 0,
  cached_input_micro_usd_per_unit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, provider, model)
);

CREATE TABLE credit_grant_rule (
  tenant_id        TEXT NOT NULL,
  stripe_price_id  TEXT NOT NULL,
  credits_per_period INTEGER NOT NULL CHECK (credits_per_period > 0),
  refresh_policy   TEXT NOT NULL DEFAULT 'reset',
  rollover_cap_credits INTEGER,
  priority         INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY (tenant_id, stripe_price_id)
);

CREATE TABLE stripe_event (            -- webhook 冪等（PRD §6.3）
  event_id     TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE revenue_event (           -- 収益認識の元データ（PRD §11.2）
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('subscription','topup')),
  amount_micro_usd INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,          -- topup は start+30d（診断ツールと同一の近似）
  source_ref   TEXT
);

CREATE TABLE event_outbox (
  event_id   TEXT PRIMARY KEY,         -- ULID
  tenant_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  subject_id TEXT,
  payload    TEXT NOT NULL,            -- JSON
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT
);
CREATE INDEX idx_outbox_pending ON event_outbox(next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE intervention_rule (
  rule_id      TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  on_event     TEXT NOT NULL,
  when_expr    TEXT NOT NULL DEFAULT '{}',  -- JSON: {field:{op:value}} AND 結合のみ
  cooldown_hours INTEGER NOT NULL DEFAULT 72,
  holdout_pct  INTEGER NOT NULL DEFAULT 10 CHECK (holdout_pct BETWEEN 0 AND 50),
  action       TEXT NOT NULL,               -- JSON: {type:'webhook', target:'tenant_default'}
  enabled      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, rule_id)
);

CREATE TABLE rule_firing (
  tenant_id  TEXT NOT NULL,
  rule_id    TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  fired_at   TEXT NOT NULL,
  holdout    INTEGER NOT NULL,              -- 1 = ホールドアウト群（アクション抑制、記録のみ）
  PRIMARY KEY (tenant_id, rule_id, subject_id, fired_at)
);

-- Which grants a settlement drew from. Needed to reverse a consumption during
-- reconciliation, and to explain a per-grant balance without replaying the register.
CREATE TABLE consumption (
  tenant_id        TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  entitlement_id   TEXT NOT NULL,
  credits          INTEGER NOT NULL CHECK (credits > 0),
  at               TEXT NOT NULL,
  PRIMARY KEY (tenant_id, authorization_id, entitlement_id)
);

-- Settled totals, so a period or lifetime ceiling does not require a table scan.
CREATE TABLE settlement_window (
  tenant_id  TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  credits    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, subject_id, at)
);
CREATE INDEX idx_settlement_at ON settlement_window(tenant_id, subject_id, at);

CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
