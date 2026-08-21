# 実装計画 — TEGATA Credits MVP

Select KK / 2026-08-21 / v1.0
規範: `docs/prd/tegata-credits.md`（PRD）/ `spec/*.md`（プロトコル）/ `docs/00-master.md`（正本）
**本書はゴールモード（自律実行）に渡す実行仕様である。曖昧さを残さない。選択肢を提示しない。**

---

## 0. ゴール定義

> **ゴール（1文）**: `pnpm verify` と `pnpm verify:acceptance` が全て通り、
> ローンチ動画の拍2（authorize → dishonor が実測レイテンシ付きで動く）と
> 拍3（Register エクスポートが `tegata-verify` で検証できる）を撮影できる状態の
> TEGATA Credits MVP を、本リポジトリの `packages/` 配下に実装する。

### 0.1 gate ルールとの関係（M0 で処理）

Master Doc §6 は「gate 通過までコードを書かない」と定める。本計画の実行開始は
**オーナーによる Implementation 着手の意思決定**であり、M0 で以下を行って矛盾を解消する:

1. `docs/00-master.md` の Status 行を `Concept 完了 · GTM Prototype gate 未通過` から
   `Concept 完了 · gate 判定継続中 · Credits MVP 実装先行（D-30）` に変更
2. `docs/decisions/README.md` に D-30 として追記:
   「MVP 実装を gate 判定と並行させる。理由: gate 成果物のうち動画の拍2/拍3（実物の
   enforcement と検証可能な台帳）は実装なしに撮影できず、gate とMVP が循環依存になった。
   ヒアリング（判定材料の残り）は実装と独立に進行する」
3. `CLAUDE.md` の「コードはリポジトリに置かない」を「実装は `packages/` 配下。
   `spec/` は引き続き規範であり、実装の都合で変更しない」に改訂

**この3編集を行わずにコードを書き始めてはならない。**

### 0.2 MVP の存在理由（スコープ判断の基準）

MVP は以下の3つのためだけに存在する。機能追加の判断に迷ったら、この3つに寄与しないものは落とす。

1. **動画の拍2/拍3を実写で撮る**（gate 成果物）
2. **デザインパートナー（`docs/gtm/icp-target-list.md` §1.1 の Tier 1）が SDK 3行で試せる**
3. **spec が実装可能であることを OSS として証明する**（standard を置きに行く戦略の実弾）

---

## 1. MVP スコープ確定

### 1.1 含む（この表が MVP の全機能一覧。これ以外を実装しない）

| # | 機能 | PRD 参照 |
|---|---|---|
| F1 | Subject / Entitlement スタック / 残高（balance・reserved・available） | §5.1, §6 |
| F2 | Authorization: issue / capture / release / 直接計上 / 満期失効 | §7 |
| F3 | 冪等性（Idempotency-Key、24h、再送で元レスポンス） | §12.1 |
| F4 | Register: 追記専用・ハッシュチェーン・JSONL エクスポート | §12.3 |
| F5 | Cost Mapping: コストテーブル + rate_override + クレジット換算 | §9 |
| F6 | Policy 評価（MVP サブセット: `limits` + `scope.actions` + `overdraft` + `degraded`） | spec/policy.md |
| F7 | Stripe entitlement 同期（webhook、fixture 駆動） | §6 |
| F8 | Degraded mode（SDK 側 + 復旧 reconcile） | §8.3–8.4 |
| F9 | イベント発火 + 介入ルール（webhook アクション、cooldown、holdout） | §10 |
| F10 | Margin 集計 API（per-subject rev/cost/margin） | §11.2 |
| F11 | TypeScript SDK（`guard()` ヘルパ、usage 自動抽出、フェイルセーフ） | §7.10 |
| F12 | 検証 CLI `tegata-verify`（JSONL エクスポートのチェーン検証） | §12.3 |
| F13 | テナント bootstrap CLI（tenant 作成・secret key 発行・action 登録） | — |

### 1.2 含まない（明示的 Non-goals。実装しかけたら停止する）

- マルチリージョン / Edge 分散（Q-03 の本回答は据え置き。§2.1 参照）
- ダッシュボード UI（margin は API のみ。可視化は診断ツールの流用で後続）
- publishable key + Subject JWT（クライアント直叩き）— MVP はサーバ間のみ
- `pending_seal` / counter_seal / endorsement（Credits のラダーは `auto` のみ。PRD §7.2）
- `offer` / `flag` 介入アクション（webhook のみ。PRD §10.3 の残りは後続）
- `usage.dropoff` / `margin.negative` イベント（履歴依存。後続）
- Stripe 以外の課金基盤（Q-05 のとおり）
- 本番デプロイ構成（Dockerfile は作る。IaC・監視・SLO 運用は作らない）
- 管理 UI・請求・複数 API キー・キーローテーション

### 1.3 PRD からの MVP 縮退（明示）

| PRD | MVP での扱い |
|---|---|
| p99 < 50ms（リージョン内） | **単一ノード・localhost で計測**し、ハーネスと数値をコミット。分散時の再計測は後続 |
| 可用性 99.95% | 対象外（運用目標であり実装物ではない） |
| degraded = Edge 判断不能時の server 側動作 | **MVP では SDK 側で実装**（D-28）。server 側は「provisional capture の受理と reconcile」のみ |
| Idempotency 24h 保持 | sweeper で削除。保持自体は同じ |

---

## 2. 技術スタック（確定。変更はゴールモードの権限外）

| 層 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript（strict）、Node 22 | SDK と同一言語で core を共有。ICP のスタック第一位 |
| HTTP | Fastify 5 | スキーマ検証内蔵、十分速い |
| ストレージ | better-sqlite3（WAL モード） | **同期 API = subject 単位の直列化が構造的に成立**。単一ノード MVP に分散 DB は過剰。Q-06 とも整合 |
| スキーマ検証 | Ajv（Draft 2020-12） | **`spec/schema/*.json` をそのまま読み込む。スキーマの二重定義を作らない** |
| テスト | vitest | — |
| 負荷計測 | autocannon | AC-P1 用 |
| モノレポ | pnpm workspaces | — |
| ID | ULID（自前 or `ulid` パッケージ） | spec の ID 形式 |

**依存の allowlist**: fastify, better-sqlite3, ajv, ajv-formats, ulid, vitest, autocannon,
typescript, tsx, @types/*。**これ以外を追加する場合は理由を `docs/plan/decision-log.md` に
記録してから**（ORM・DI コンテナ・ロガーFW は追加禁止。console + 構造化 JSON で足りる）。

### 2.1 Q-03（Edge 基盤）への MVP 回答

単一ノード TS + SQLite。ただし **`packages/core` は I/O を持たない純粋層**とし、
`packages/store` を Storage アダプタ境界にする（D-27）。分散化の際に core を書き直さないための
唯一の防衛線であり、**core に I/O・wall-clock・乱数を入れた時点で本計画は失敗**である。

### 2.2 決定論の規律（D-29）

- core / store は `Clock` インターフェース（`now(): number`）を注入される。`Date.now()` 直呼び禁止
- 乱数（holdout 抽選、ULID）は `Rng` 注入。テストはシード固定
- 金額・クレジットは **integer のみ**。`Number.isSafeInteger` を境界で assert。float が現れたら throw
- CI に禁止パターン検査を置く: `packages/core` `packages/store` 内の
  `Date.now|Math.random|toFixed|parseFloat` を grep して検出したら fail

---

## 3. リポジトリ構成

```
packages/
  core/         # 純粋層: 台帳規則・状態機械・ポリシー評価・コスト換算・JCS/hash
    src/
      ledger.ts        # register エントリ生成・チェーン・残高導出
      authorization.ts # 状態機械（遷移表 §5 の実装）
      entitlement.ts   # スタック消費順序
      policy.ts        # 評価器（MVP サブセット）
      cost.ts          # コストテーブル→credits 換算
      jcs.ts           # RFC 8785 サブセット（int/string/bool/null/object/array のみ）
      clock.ts, rng.ts, errors.ts, types.ts
  store/        # SQLite アダプタ: トランザクション・projection・idempotency・sweeper
    src/
      schema.sql       # §4 の DDL（正本）
      store.ts         # withSubject() 直列化境界
      migrate.ts
  server/       # Fastify: API・webhook・イベント配送・CLI
    src/
      app.ts, routes/, stripe.ts, events.ts, cli.ts
  sdk/          # @tegata/sdk
    src/index.ts       # TegataClient / guard()
  verify/       # tegata-verify CLI（core の jcs/hash を再利用）
tools/margin-diagnostic/   # 既存。触らない
spec/                      # 既存。規範。実装の都合で変更しない
```

**依存方向**: `core ← store ← server`、`core ← sdk`、`core ← verify`。逆流禁止。
`server` が `core` の型を再エクスポートするのは可。

---

## 4. データモデル（DDL 正本）

`packages/store/src/schema.sql` に以下をそのまま置く。時刻は ISO-8601 UTC 文字列。
金額は全て INTEGER。JSON 列は TEXT（書き込み時に JCS 正規化はしない。Register の hash 計算のみ JCS）。

```sql
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
  delta_credits        INTEGER NOT NULL,
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
```

### 4.1 不変条件（property テストとして実装。M1 の中核）

| ID | 不変条件 |
|---|---|
| INV-1 | `balance = Σ delta_credits`（任意時点・任意 subject） |
| INV-2 | `reserved = Σ meta.face_value`（state='issued' の authorization の issue エントリ） |
| INV-3 | `available = balance − reserved` かつ authorize は available に対して判定する |
| INV-4 | register の seq は subject 内で 1 から欠番なく単調増加 |
| INV-5 | `hash = SHA-256(JCS(entry − hash列))`、`prev_hash` は直前の hash、先頭は 64個の'0' |
| INV-6 | kind ∈ {issue, release, dishonor, event} ⇒ delta_credits = 0（authorization の expire も 0） |
| INV-7 | balance ≥ −tenant.max_overdraft_credits（capture の overdraft 許容後も） |
| INV-8 | Σ entitlement.credits_remaining ≥ 0 かつ balance ≥ 0 の範囲では Σ remaining = balance |
| INV-9 | 同一 Idempotency-Key の N 回並列送信で register への追記は正確に1回分 |
| INV-10 | balance_projection はいつでも register からの再計算と一致（`store.rebuild()` で検証） |
| INV-11 | 全ての register エントリは `spec/schema/register-entry.schema.json` に適合 |

---

## 5. 状態の完全列挙

### 5.1 Authorization 状態機械（遷移表 = 実装仕様）

状態: `issued` / `captured` / `released` / `expired` / `dishonored`
（`pending_seal` は spec に存在するが Credits MVP では**到達不能**。到達したら実装バグ）

| # | 遷移 | トリガ | ガード | Register 追記 | イベント |
|---|---|---|---|---|---|
| T1 | (request)→issued | POST /authorizations | subject.status=active ∧ policy 通過 ∧ available ≥ face_value | `issue`(Δ0, meta.face_value) | — |
| T2 | (request)→dishonored | 同上 | いずれかのガード不成立 | `dishonor`(Δ0, meta.reason/required/available) | `authorization.dishonored`、N回/24h で `dishonor.repeated` |
| T3 | issued→captured | POST /:id/capture | state=issued ∧ now < maturity | `capture`(Δ=−captured, cost) | balance 閾値割れで `balance.low` / `balance.depleted`、超過時 `balance.overdrawn` |
| T4 | issued→released | POST /:id/release | state=issued | `release`(Δ0, meta.face_value, meta.reason='released_by_caller') | — |
| T5 | issued→expired | sweeper / 遅延評価 | state=issued ∧ now ≥ maturity | `expire`(Δ0, meta.face_value, meta.reason='maturity') | — |
| T6 | captured→(adjusted) | 復旧 reconcile（§8） | provisional=1 だった分の差分 | `adjust`(Δ=差分, meta.corrects=元seq) | `authorization.reconciled` |

**終端状態からの遷移は全て 409。** capture 済みへの capture 再送は冪等キーが同一なら元レスポンス、
異なるキーなら `409 authorization_closed`。maturity 超過後の capture は `409 authorization_matured`
（spec/authorization.md §3。usage 直接計上を案内する）。

**T3 の詳細（capture の確定額決定）**:
1. `actual`（トークン実測）が来たら cost.ts で `cost_micro_usd` → `credits = ceil(cost × markup_milli / 1000 / credit_unit_micro_usd)`
2. `amount` 直接指定ならそれを使う（`cost_micro_usd` 併記は任意）
3. `captured > face_value` の場合も**必ず成功**（spec §4.2）。ただし
   `balance − captured < −max_overdraft` になる分は**それでも記帳する**（実行は済んでいる）。
   `balance.overdrawn` を発火し、以後の issue は T2（insufficient_balance）で落ちる
4. entitlement 消費: `priority ASC, expires_at ASC NULLS LAST, created_at ASC` で
   remaining を減算。balance が負になる分はどの entitlement も減らさない（負担は balance のみ）

### 5.2 Entitlement 状態

| 状態 | 遷移条件 | Register |
|---|---|---|
| active | 付与時（grant） | `grant`(Δ=+credits, meta.source/amount_micro_usd) |
| expired | now ≥ expires_at（sweeper） | `expire`(Δ=−remaining, meta.reason='entitlement_expired', entitlement_id) |
| revoked | Stripe 即時解約（§7） | `expire`(Δ=−remaining, meta.reason='revoked') |

refresh（`invoice.paid` の周期到来）:
- `reset`: 旧 entitlement を expired にし（remaining を Δ− で失効）、新規 grant
- `rollover`: 旧はそのまま、新規 grant を追加
- `rollover_capped`: 旧 remaining を `min(remaining, cap)` に切り下げ（超過分を expire で失効）、新規 grant

### 5.3 Subject 状態

`active` ⇄ `suspended`（API で変更、suspended 中の issue は T2 `subject_suspended`）、
`deleted`（issue/capture 全拒否。register は保持）。

### 5.4 サーバ・SDK の運転状態（degraded の完全定義。D-28）

| 状態 | 定義 | 挙動 |
|---|---|---|
| server: healthy | プロセス稼働・SQLite 書込可 | 通常 |
| server: down | プロセス停止 / 応答なし | SDK が判定（下記） |
| sdk: normal | 直近の authorize が成功 | サーバ判定に従う |
| sdk: degraded | authorize がタイムアウト（既定 200ms）or 接続不能 | tenant 設定（SDK 初期化時に取得しキャッシュ）に従う: `allow` → ローカル承認（`provisional: true` を記録、face_value はローカル見積、上限 = キャッシュ済み available + max_overdraft）/ `allow_cheap_only` → fallback_action があるアクションのみ / `deny` → dishonor(`service_degraded`) 相当を返す |
| sdk: recovering | 接続回復 | ローカルキューの capture を冪等キー付きで送信。サーバは authorization 不在の capture を `POST /v1/usage` 相当 + `adjust` として記帳し、`authorization.reconciled` を発火 |

SDK のローカルキューはプロセス内メモリ + 任意でファイル（`queuePath` オプション）。

---

## 6. API 契約

共通: `Authorization: Bearer <secret>`。エラーは
`{"error":{"code":"<snake_case>","message":"...","details":{...}}}`。
書込系は `Idempotency-Key` ヘッダ必須（欠落は `400 idempotency_key_required`）。
同一キー・異ボディは `409 idempotency_key_reuse`（request_hash 比較）。

### 6.1 `POST /v1/authorizations` — 振出

Request（Ajv で検証。`estimate` の形は PRD §7.3）:
```jsonc
{ "subject_id": "user_8f21", "action": "chat.completion",
  "estimate": { "provider": "anthropic", "model": "claude-opus-5",
                "input_tokens": 12400, "max_output_tokens": 2000, "cached_input_tokens": 8000 },
  "maturity_seconds": 300, "context": { "feature": "summary" } }
```
- subject が未知なら**自動作成**する（外部ID方式。PRD §5.1）
- face_value 決定: `token_based` → estimate から算出（max_output_tokens で上限見積）/
  `fixed` → fixed_credits / 見積不能（未知モデル等）→ default_face_value + `cost_table.unknown_model` イベント
- `min_face_value` を下回る見積は min まで引き上げ

Response 201（承認）:
```jsonc
{ "authorization_id": "01J…", "decision": "authorized", "face_value": 47,
  "available_after_hold": 953, "maturity": "2026-08-21T04:05:00.000Z" }
```
Response 200（不渡り。**HTTP エラーにしない**。`Tegata-Decision: dishonored` ヘッダ併記）:
```jsonc
{ "decision": "dishonored", "reason": "insufficient_balance",
  "available": 12, "required": 47,
  "remedy": { "fallback_action": "chat.completion.mini", "fallback_face_value": 9 } }
```
（MVP の remedy は fallback のみ。topup_url はホスト決済を持たないため出さない）

dishonor_reason は spec §5 の8種のうち MVP は
`insufficient_balance / entitlement_expired / policy_denied / budget_exhausted_period /
subject_suspended / action_unknown` を実装（`rate_limited` と `service_degraded` の
server 発行は後続。SDK は `service_degraded` を合成しうる）。

### 6.2 `POST /v1/authorizations/{id}/capture`

`{ "actual": {…} }` または `{ "amount": 31, "cost_micro_usd": 620000 }`。挙動は §5.1 T3。
Response 200: `{ "authorization_id", "state": "captured", "captured_amount": 31,
"released_remainder": 16, "balance": 969, "available": 969 }`

### 6.3 `POST /v1/authorizations/{id}/release` → T4。冪等（released 済みへの再送は 200 同値）
### 6.4 `POST /v1/usage` — 直接計上

`{ "subject_id", "action", "actual"|"amount", "cost_micro_usd"? }`。
authorize なしで `capture` 相当を記帳（authorization_id なし、kind=capture、Δ負）。
残高不足でも拒否しない（PRD §7.9）。

### 6.5 参照系
- `GET /v1/subjects/{id}` → `{ subject_id, status, balance, reserved, available, entitlements:[…] }`
- `GET /v1/subjects/{id}/register?after_seq=&limit=` → JSONL（`Content-Type: application/jsonl`）
- `GET /v1/register/export` → テナント全件 JSONL ストリーム + 末尾 manifest 行（spec/register.md §6）
- `GET /v1/metrics/margin?window_days=30` → §10 の定義で
  `{ window:{…}, subjects:[{subject_id, revenue_micro_usd, cost_micro_usd, margin_micro_usd, negative:bool}…],
     summary:{subjects, negative_count, negative_cost_share_milli} }`

### 6.6 管理系
- `POST /v1/subjects/{id}/grants` `{ credits, source:'grant'|'promo', expires_at?, amount_micro_usd? }`
- `PUT /v1/actions/{action}` — action_catalog upsert
- `PUT /v1/cost-table` — 新バージョン一括投入（追記。既存バージョンの変更は 409）
- `PUT /v1/rules/{rule_id}` — 介入ルール upsert
- `POST /v1/webhooks/stripe` — §7（これのみ Bearer でなく Stripe 署名検証）

### 6.7 エラーコード全列挙

| HTTP | code | 発生箇所 |
|---|---|---|
| 400 | `validation_failed` | Ajv 不適合（details にパス） |
| 400 | `idempotency_key_required` | 書込系でキー欠落 |
| 401 | `unauthorized` | key 不一致 |
| 404 | `not_found` | authorization / subject / action |
| 409 | `idempotency_key_reuse` | 同一キー・異ボディ |
| 409 | `authorization_closed` | 終端状態への操作 |
| 409 | `authorization_matured` | maturity 超過後の capture |
| 409 | `cost_table_version_exists` | 既存バージョン再投入 |
| 422 | `integer_required` | 金額系に非整数 |
| 500 | `internal` | 想定外。**残高系の書込途中では絶対に返さない**（トランザクション境界内） |

---

## 7. Stripe 同期（F7）

- 検証: `Stripe-Signature`（HMAC-SHA256、tolerance 300s）。**stripe SDK は使わない**
  （署名検証は 30 行で書ける。依存を増やさない）
- 冪等: `stripe_event.event_id` で重複破棄（AC-08）
- ハンドリング（PRD §6.3 の決定に従う）:

| イベント | 処理 |
|---|---|
| `invoice.paid` | line item の price_id → credit_grant_rule → refresh_policy 適用 + grant。`revenue_event(kind=subscription, period=invoice period)` を記録。`entitlement.refreshed` 発火 |
| `checkout.session.completed`（mode=payment） | metadata.tegata_credits があれば topup grant + `revenue_event(kind=topup, period=[now, now+30d])` |
| `customer.subscription.updated` | `cancel_at_period_end=true` は何もしない（期末失効は expires_at が処理） |
| `customer.subscription.deleted` | 当該 subscription 由来の entitlement を revoked（§5.2） |
| その他 | 200 を返して無視（ログのみ） |

- subject 解決: `customer` → `subject.external_ref.stripe_customer_id`。未知なら
  metadata.tegata_subject_id を見る。どちらも無ければ `stripe.unmatched_customer` イベントを
  発火して 200（**取りこぼしを黙って捨てない**）
- テストは fixture JSON（実イベント形状を模した静的ファイル）で駆動。実 Stripe 接続は MVP 外

---

## 8. イベントと介入（F9）

- 発火点は §5.1 の表の通り。event_outbox に書き、配送ワーカー（1s tick、指数バックオフ
  1m/5m/30m/3h、5回で放棄・`delivery_failed` マーク）が tenant.webhook_url へ POST
- 署名: `Tegata-Signature: t=<unix>,v1=<hmac_sha256(webhook_secret, t + '.' + body)>`
- 介入ルール評価: イベント発火時に `on_event` 一致ルールを取り、`when_expr`
  （`{gt,gte,lt,lte,eq}` の AND のみ。対象フィールドは
  `subject.balance / subject.lifetime_credits_purchased / subject.days_since_signup / event.*`）
  → cooldown 内なら skip → holdout 抽選（`Rng`、subject+rule 固定シードで**再現可能**）
  → holdout=0 なら action 実行、1 なら記録のみ。どちらも rule_firing に記録
- MVP の action は `webhook` のみ（type=intervention として通常の webhook と同形で配送）

---

## 9. SDK（F11）

```ts
const tegata = new TegataClient({ baseUrl, secretKey,
  timeoutMs: 200, degraded: 'inherit' /* tenant設定を起動時取得 */ });

const guard = tegata.guard({ subjectId, action: 'chat.completion' });
const d = await guard.issue({ provider:'anthropic', model, inputTokens, maxOutputTokens });
if (d.dishonored) { /* d.reason, d.remedy */ }
try {
  const res = await anthropic.messages.create({...});
  await guard.capture(res.usage);   // {input_tokens, output_tokens, cache_read_input_tokens} を自動マップ
} catch (e) { await guard.release(); throw e; }
```

- `capture(usage)` は Anthropic / OpenAI の usage オブジェクト形状を自動判別
  （`input_tokens/output_tokens` ⇔ `prompt_tokens/completion_tokens`、cache 系の対応表をコードに明記）
- degraded 挙動は §5.4。`guard.issue` は**例外を投げない**（ネットワーク失敗も decision で返す）
- 冪等キーは SDK が ULID で自動生成。リトライ（1回、100ms）は同一キー

---

## 10. Margin 集計（F10）

PRD §11.2 の定義をそのまま実装（診断ツールと文言一致が AC）:
- `provider_cost(subject) = Σ register.delta_cost_micro_usd`（窓内）
- `recognized_revenue(subject) = Σ revenue_event の窓との重なりの日割り`（topup は 30日按分 = 診断ツールと同一近似）
- promo/grant は 0
- 出力は integer（micro-USD）と千分率のみ。float を返さない

---

## 11. マイルストーン（実行順。各 DoD は機械検証可能）

**共通 DoD（全マイルストーン）**: `pnpm verify` green =
`tsc --noEmit` + `eslint`（未使用/暗黙any禁止）+ `vitest run` + spec 検証
（CLAUDE.md の検証スクリプトを `scripts/verify-spec.mjs` 化）+ 禁止パターン grep（§2.2）。

| M | 内容 | 固有 DoD（コマンドで判定） |
|---|---|---|
| **M0** | §0.1 の3編集 / pnpm workspace / tsconfig / eslint / vitest / CI（GitHub Actions: `pnpm verify`） / `docs/plan/decision-log.md` 作成 | CI が green。`git grep "コードを書かない" CLAUDE.md` が空 |
| **M1** | core: jcs / ledger / entitlement / clock / errors。INV-1〜8,11 の property テスト（fast-check は**使わず**、シード付き自作ランダム系列で 1,000 ケース） | `vitest run packages/core` で INV テスト全通過。1,000件のランダム操作列後に INV-10 相当（再計算一致） |
| **M2** | store: schema.sql / withSubject 直列化 / idempotency / sweeper（clock 注入） | AC-04: 同一キー100並列で追記1回。AC-05: 残高1に50並列 issue で承認1件。register トリガが UPDATE/DELETE を拒否するテスト |
| **M3** | server: 認証 / §6.1〜6.3, 6.5, 6.7 / Ajv に spec/schema を接続 | 全エンドポイントの契約テスト（fixture リクエスト→レスポンス JSON 完全一致）。register 出力行が spec スキーマ適合（INV-11 を API 経由で） |
| **M4** | cost.ts / action_catalog / cost_table API / /v1/usage / 未知モデル fallback | 換算テーブル（8ケース以上: cached 有無・markup・ceil 境界・未知モデル）が期待値一致 |
| **M5** | Stripe webhook + grant/refresh/revoke + revenue_event | AC-08: 同一 event_id 10回で grant 1回。refresh 3方式のテスト。unmatched_customer イベント |
| **M6** | sweeper 本組込（maturity expire / entitlement expire / idempotency TTL）+ reconcile 受理 | 時計を進めるテストで T5/entitlement expire が発火し INV 全維持。AC-03: provisional capture 流入→adjust→残高一致 |
| **M7** | event_outbox + 配送 + 署名 + 介入ルール + holdout | AC-06: overdraft 超過 capture で `balance.overdrawn` 配送。holdout が固定シードで再現。cooldown テスト |
| **M8** | /v1/metrics/margin + /v1/register/export + `tegata-verify` CLI + bootstrap CLI | AC-07: エクスポートを1バイト改竄すると `tegata-verify` が失敗し、無改竄なら成功。margin が手計算 fixture と一致 |
| **M9** | SDK（guard / degraded / キュー / usage マップ） | AC-02: サーバを落として `degraded:'allow'` でアプリコード（テスト内の擬似アプリ）が動き続け、復旧後 reconcile で残高一致（AC-03 と接続） |
| **M10** | perf ハーネス + README（quickstart: `pnpm bootstrap && pnpm dev` から curl 3本で authorize→capture→export）+ Dockerfile | **AC-P1（改訂・decision-log 2026-08-21/M10）**: 並列度 1/10/25/50/100 でそれぞれ 60s 計測し、**p99 < 50ms が成立する並列度とスループット上限を報告**する。エラー・タイムアウト・非2xx はいずれの水準でも0。結果 JSON を `docs/plan/perf/` にコミット。単一の並列度だけで合否を言わない（選び方でどうとでもなるため）。quickstart を README の記載通り実行するスモークテスト |

**順序は固定。**ゴールモードは M(n) の DoD が green になるまで M(n+1) に進んではならない。

### 11.1 PRD 受け入れ基準との対応

| PRD AC | MVP での判定 |
|---|---|
| AC-01（p99） | M10 AC-P1（単一ノード計測に縮退。§1.3） |
| AC-02/03（degraded/reconcile） | M9（SDK 側実装に読み替え。D-28） |
| AC-04/05（冪等・競合） | M2 |
| AC-06（overdraft+イベント） | M7 |
| AC-07（改竄検出） | M8 |
| AC-08（Stripe 冪等） | M5 |
| AC-09（30分オンボード） | README quickstart のスモークテストで代替（実測は design partner で） |
| AC-10（介入+holdout） | M7（7日差分表示はダッシュボード外のため rule_firing の集計クエリまで） |

---

## 12. ゴールモード運転規則

1. **spec/ と docs/prd/ を実装の都合で変更しない。** 実装中に spec の欠陥・矛盾を見つけたら
   `docs/plan/decision-log.md` に「発見・提案・暫定実装」を記録し、spec は触らずに進む。
   （例外: 明白な typo。その場合もログに残す）
2. **依存追加は §2 の allowlist のみ。** 追加が必要と判じたら decision-log に理由を書いてから
3. **金額に float が現れたら即修正。** `toFixed / parseFloat / 0.1` 系のパターンは禁止検査対象
4. コミットは **マイルストーン単位以下の粒度**で、各コミット前に `pnpm verify`。
   push は各マイルストーン完了時。ブランチは現行（`claude/tegata-ai-master-doc-7a4k35`）を継続
5. **性能値は測定値のみ。** ドキュメントに書く数字は必ずハーネスの出力ファイルを根拠にする
6. テストからネットワークに出ない。Stripe も webhook 配送も全て fixture / ローカル HTTP
7. 迷ったら: PRD → spec → 本計画 の優先順で解決。3つで決まらない場合のみ decision-log に
   「未決」を書き、**最も可逆な選択**をして進む（停止しない）
8. `tools/margin-diagnostic/` と `brand/` は触らない
9. 各マイルストーン完了時、本書 §11 の表に `✅ 完了 (commit hash)` を追記する

## 12.1 実行結果（2026-08-21 完了）

| M | 内容 | 状態 |
|---|---|---|
| M0 | gate 処理・workspace・CI・検証スクリプト | ✅ `e4fe0ae` |
| M1 | core（純粋層）+ 不変条件 1,000系列 | ✅ `1f2c46b` — **設計欠陥1件を検出**（オーバードラフト後の付与でスタックが恒久乖離） |
| M2 | store（追記専用・直列化・冪等） | ✅ `538ddbe` — AC-04 / AC-05 |
| M3 | server（API 全面・スキーマ強制） | ✅ `b1dc7be` — **spec 適合の緩み1件を検出**（直接計上が公開スキーマ違反） |
| M4–M8 | コスト換算・Stripe・sweep・イベント・エクスポート・margin | ✅ `f76421e` — **実装欠陥1件**（rollover_capped が繰越分まで失効） |
| M9 | SDK・degraded・reconcile | ✅ `7d93ebc` — **堅牢性バグ1件**（AbortSignal 依存でハング） |
| M10 | CLI・Docker・quickstart 実行テスト・perf | ✅ `3d5ef45` / `b39618f` — **AC-P1 を実測に基づき改訂** |

**テスト 173件 / 実装 3,560行 / テスト 2,297行。** `pnpm verify` と `pnpm verify:acceptance` 全通過。

**テストが検出した実質的な欠陥は5件**で、いずれも「テストが通るように実装を緩める」のではなく
実装を直して解決した。内訳は decision-log 参照。

## 13. 完了の定義（MVP Done）

- [x] M0〜M10 全 DoD green、CI green
- [x] §11.1 の AC 全消化（AC-01 のみ改訂形。§12.1 と decision-log 参照）
- [x] README quickstart が記載通り動く（`smoke.test.ts` が bootstrap → 起動 → curl 相当を実行）
- [x] `docs/gtm/launch-storyboard.md` 拍2: authorize→dishonor が実サーバで動作
      （実測 authorize 11ms / dishonor 3ms、`Tegata-Decision` ヘッダ付き）
- [x] 同 拍3: `GET /v1/register/export | tegata-verify` が `chain verifies` を出力し、
      1バイト改竄で `chain FAILED` + exit 1
- [x] decision-log に未解決の「停止」項目がない

## 13.1 MVP に残る既知の限界（隠さない）

1. **単一ノードのスループット上限 約1,750 req/s。** p99 < 50ms は約25並列まで
   （50並列で 51ms、100並列で 87ms）。これは Q-03 据え置きの直接的な帰結
2. **Wallet は実装しない**（D-30）。市場が EARLY と実証済み
3. **ダッシュボード UI なし。** margin は API のみ
4. **publishable key / Subject JWT なし。** サーバ間利用のみ
5. **`Content-Type: application/jsonl` は `application/json` を部分文字列に含む**
   — 素朴なクライアントが誤解しうる。公開前に `application/x-ndjson` を検討
