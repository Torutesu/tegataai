# PRD — TEGATA Credits (Product A)

Select KK / 2026-08-21 / v0.1 draft
正本: `docs/00-master.md` — 本書は Master Doc §2.1 を実装可能な粒度まで展開したもの。

> **Gate 注記**: 本書は Phase 1（Gate 通過後）の実装仕様である。GTM Prototype gate 未通過のため、
> 本書に基づく実装コードは書かない。本書の目的は (a) gate 用の spec-first repo / LP / デモの内容を
> 確定させること、(b) gate 通過後に迷わず着手できる状態を作ること、の2点。

---

## 1. スコープ

### 1.1 一行定義

AIプロダクトの「サブスク + クレジット」を、**推論実行前のリアルタイム認可**と **churn 自動介入**込みで
提供する monetization layer。

### 1.2 v1 に含むもの

| # | 機能 | 本書での節 |
|---|---|---|
| A1 | Subject（ユーザー）ごとのクレジット台帳と entitlement 同期 | §5, §6 |
| A2 | Pre-flight Authorization（振出 → 捕捉 → 解放の2フェーズ） | §7, §8 |
| A3 | Cost Mapping（モデル単価テーブル → クレジット換算、BYOK 対応） | §9 |
| A4 | Churn Intervention（イベント発火とルールエンジン） | §10 |
| A5 | Margin Dashboard（ユーザー別・機能別粗利、赤字ユーザー検出） | §11 |

### 1.3 v1 に含まないもの（Non-goals）

- 請求書発行・税務計算・エンタープライズ契約管理 → 既存 billing に委譲
- 決済処理そのもの（カード決済・PSP 機能）→ Stripe の上に載る
- モデル推論のプロキシ（LLM gateway 化）→ §7.6 で明示的に棄却
- 顧客のエンドユーザーに対する直接的な資金保全・払戻義務の引き受け
- 複数AIアプリ横断の共通残高（構想としては保持するが v1 のスコープ外。§14）

### 1.4 v1 の成功定義

1. 導入済みテナントの authorize 呼び出しが **in-region p99 < 50ms**、可用性 **99.95%/月**
2. 導入テナントが「赤字ユーザー %」を導入 30 分以内に自分で見られる
3. churn 介入ルールを1つ以上本番稼働させているテナントが、導入テナントの過半

---

## 2. ICP とユーザー

### 2.1 ICP

月次 $5k–100k MRR の AIアプリ（画像/動画生成、AIコンパニオン、writing、coding tool）を運営する
ソロ〜小規模チーム。Stripe に直接クレジット処理を書き、enforcement と churn に苦しんでいる層。

**除外**: エンタープライズ SaaS の請求要件（契約単位の請求書、SOW、監査法人対応）を持つ層。
そこは既存 billing の戦場であり v1 では戦わない。

### 2.2 ペルソナ

| ペルソナ | 役割 | 主要ジョブ | 成功の定義 |
|---|---|---|---|
| **Founder-Engineer**（主） | AIアプリの開発と経営を兼ねる | クレジット制の実装をやめたい / 赤字ユーザーを止めたい | SDK 3行で enforcement が入り、粗利が見える |
| **Growth 担当**（副） | 転換率・継続率の責任者 | 残高枯渇を収益機会に変えたい | ノーコードで介入ルールを組める |
| **エンドユーザー**（間接） | AIアプリの利用者 | 残高と料金が理解できる | 実行前に「足りない」と分かり、その場で解決できる |

### 2.3 ユーザーストーリー（v1 の受け入れ対象）

**Founder-Engineer**
- US-01: 実行の直前に「このユーザーはこのアクションを実行してよいか」を1リクエストで判定したい
- US-02: 実際に使ったトークン量が見積もりと違ったとき、差分が自動で台帳に反映されてほしい
- US-03: TEGATA が落ちても自分のアプリを止めたくない
- US-04: モデルの値上げ/値下げがあったとき、クレジット換算を1箇所直すだけで済ませたい
- US-05: 自社の交渉済みレート（BYOK / committed use discount）で原価を計算したい
- US-06: 「今月、粗利がマイナスのユーザーは何人・誰か」を見たい

**Growth 担当**
- US-07: 残高が 20% を切ったユーザーに、アプリ内でトップアップを提示したい
- US-08: 先月まで毎日使っていたのに 7 日使っていないユーザーを検出したい
- US-09: 赤字ユーザーに対して、上位プランへの誘導か安価モデルへの降格かを選びたい

**エンドユーザー**
- US-10: 実行を止められたとき、なぜ止まったか・何をすれば動くかが分かってほしい

---

## 3. 用語（Lexicon → 実体マッピング）

Master Doc §4.3 の語彙をそのまま識別子に使う。ブランドと API の一致は本プロダクトの資産である。

| 語 | 識別子 | Credits における意味 |
|---|---|---|
| 振出 | `issue` | authorization の作成。実行前に額面を押さえる |
| 額面 | `face_value` | authorization が押さえる**上限**クレジット数 |
| 満期 | `maturity` | authorization の有効期限。到達で自動解放 |
| 不渡り | `dishonor` | 残高不足・ポリシー違反による実行拒否 |
| 手形帳 | `register` | 追記専用の監査ログ |
| 裏書 | `endorsement` | 権限の再委任。Credits v1 では**未使用**（Wallet で使う）。ただしスキーマ上は場所を空けておく |
| 割印 | `counter_seal` | 二者照合認可。Credits v1 では未使用 |

**Subject（主体）**: クレジットを保有する単位。通常はテナントのエンドユーザー1人。
チーム課金の場合は組織が Subject になりうる。`subject_id` はテナント側の ID をそのまま使う（外部ID方式）。

---

## 4. 全体アーキテクチャ

```
テナントのアプリ
      │  ① authorize（実行前・同期・低レイテンシ）
      ▼
┌──────────────────────────┐
│  Enforcement Edge        │  リージョン分散。Subject 単位の単一書き手。
│  （残高 + 保留の権威）    │  Primary DB を同期パスで触らない。
└──────────────────────────┘
      │  ② 非同期レプリケーション（追記のみ）
      ▼
┌──────────────────────────┐
│  Register（追記専用台帳） │  監査・再計算・分析の唯一の真実
└──────────────────────────┘
      │            │             │
      ▼            ▼             ▼
  Cost Ledger   Event Bus     Analytics
  （原価:μUSD） （churn 介入） （margin dashboard）
      ▲
      │  Stripe Webhook → entitlement 同期
```

**設計原則**

1. **同期パスは Subject に閉じる。** authorize は当該 Subject の状態だけを読み書きする。
   クロス Subject の集計・ポリシー評価を同期パスに入れない。
2. **Register が唯一の真実。** 残高はすべて Register から再構築可能でなければならない。
   Edge のキャッシュはあくまで導出物。
3. **原価と売価は別台帳。** クレジット（売価側）と μUSD（原価側）を混ぜない。粗利はこの2つの差。
4. **止めない設計を先に決める。** degraded mode（§8）は後付けではなく初期設計に含める。

---

## 5. データモデル

### 5.1 中核エンティティ

#### `tenant`
| 列 | 型 | 備考 |
|---|---|---|
| `tenant_id` | ULID | |
| `credit_unit_micro_usd` | int | 1 クレジットの**売価**ペグ。例: 20000 = $0.02/credit |
| `degraded_mode` | enum | `allow` / `allow_cheap_only` / `deny`。§8 |
| `max_overdraft_credits` | int | degraded 時・見積誤差時に許容する負残高の絶対値上限 |
| `cost_table_pin` | string \| null | コストテーブルのバージョン固定（null = 最新追従） |

> **決定事項**: クレジットは**整数**。小数を持たない。テナントは `credit_unit_micro_usd` で粒度を選ぶ。
> 端数処理は常に切り上げ（テナント側が損をしない方向）。理由: 金額の丸め差異による台帳不整合を
> 構造的に排除するため。

#### `subject`
| 列 | 型 | 備考 |
|---|---|---|
| `subject_id` | string | テナント側の外部 ID。テナント内で一意 |
| `tenant_id` | ULID | |
| `status` | enum | `active` / `suspended` / `deleted` |
| `region` | string | Edge の配置決定に使う。初回 authorize 時に確定 |
| `external_ref` | jsonb | Stripe customer id など |

#### `entitlement`（サブスクから導出される付与権）
| 列 | 型 | 備考 |
|---|---|---|
| `entitlement_id` | ULID | |
| `subject_id` | string | |
| `source` | enum | `subscription` / `topup` / `grant` / `promo` |
| `credits_granted` | int | |
| `credits_remaining` | int | |
| `effective_from` / `expires_at` | timestamptz | |
| `refresh_policy` | enum | `reset` / `rollover` / `rollover_capped` |
| `rollover_cap_credits` | int \| null | |
| `priority` | int | 消費順序。小さいほど先に消費 |

> **決定事項**: 残高は単一の数値ではなく **entitlement のスタック**として持つ。
> 「サブスク分を先に使い、余ったトップアップは後」「期限が近いものから消費」を表現するため。
> 消費順序は `priority ASC, expires_at ASC NULLS LAST, created_at ASC` で決定的に定まる。

#### `authorization`（振出された手形）
| 列 | 型 | 備考 |
|---|---|---|
| `authorization_id` | ULID | |
| `subject_id` | string | |
| `action` | string | アクションカタログのキー。例 `image.generate` |
| `face_value` | int | 押さえた上限クレジット |
| `state` | enum | §7.2 の状態機械 |
| `maturity` | timestamptz | 既定 now+300s、上限 now+3600s |
| `captured_credits` | int \| null | 実績 |
| `cost_micro_usd` | int \| null | 実績原価 |
| `dishonor_reason` | enum \| null | §7.5 |
| `idempotency_key` | string | テナント内一意。24h 保持 |
| `provisional` | bool | degraded mode 下で発行されたか（§8） |

#### `register_entry`（手形帳 / 追記専用）
| 列 | 型 |
|---|---|
| `seq` | bigint（Subject 内で単調増加） |
| `subject_id` | string |
| `at` | timestamptz |
| `kind` | enum: `issue` / `capture` / `release` / `dishonor` / `grant` / `expire` / `adjust` |
| `delta_credits` | int（符号付き） |
| `delta_cost_micro_usd` | int |
| `authorization_id` | ULID \| null |
| `entitlement_id` | ULID \| null |
| `meta` | jsonb |
| `prev_hash` / `hash` | bytes（§12.3） |

**不変条件**: `balance(subject) = Σ delta_credits over register_entry`。
Edge のキャッシュ値がこれとずれた場合、Register が勝つ。

#### `action_catalog`（テナントが定義するアクション）
| 列 | 型 | 備考 |
|---|---|---|
| `action` | string | `image.generate` |
| `pricing_mode` | enum | `token_based` / `fixed` / `unit_based` |
| `fixed_credits` | int \| null | `fixed` 用 |
| `default_face_value` | int | 見積不能時のフォールバック額面 |
| `fallback_action` | string \| null | 不渡り時に提案する安価な代替（§7.4） |
| `min_face_value` | int | 過小見積の下限 |

### 5.2 原価台帳（Cost Ledger）

売価（クレジット）とは別に、**プロバイダ原価を μUSD 整数で**記録する。
`register_entry.delta_cost_micro_usd` がそれ。粗利計算はこの列と収益の突合で行う（§11）。

---

## 6. Entitlement 同期（Stripe 連携）

### 6.1 モデル

Stripe を**サブスク状態の真実**とし、TEGATA を**残高の真実**とする。二重管理はしない。

```
Stripe subscription.* / invoice.paid webhook
   → plan_id → credit_grant_rule → entitlement を issue
```

### 6.2 `credit_grant_rule`

| 列 | 内容 |
|---|---|
| `stripe_price_id` | 対象価格 |
| `credits_per_period` | 付与クレジット |
| `refresh_policy` | `reset` / `rollover` / `rollover_capped` |
| `rollover_cap_credits` | 繰越上限 |
| `overage_price_id` | 超過分を Stripe に計上する price（任意） |

### 6.3 決めるべきこと

- **付与タイミング**: `invoice.paid` を採用する（`subscription.created` ではない）。未払いで付与しないため。
  ただしトライアルは `subscription.trial_will_end` ではなく `customer.subscription.created` で付与し、
  `trial_end` を entitlement の `expires_at` に設定する。
- **解約時**: 期末まで entitlement を残す（`cancel_at_period_end` を尊重）。即時解約は残高を失効させ、
  `kind=expire` を Register に記録する。返金は行わない（Non-goal）。
- **プラン変更**: proration はしない。新プランの entitlement を追加し、旧 entitlement を
  `refresh_policy` に従って処理する。理由: 日割りクレジットは説明不能な残高を生む。
- **冪等性**: Stripe の `event.id` を一意キーとして重複付与を防ぐ。

---

## 7. Pre-flight Authorization（中核）

### 7.1 なぜ2フェーズか

AI アクションは**実行前に正確なコストが分からない**（出力トークン数は生成してみないと確定しない）。
一方、実行後に課金すると残高を超過する。したがって:

1. **振出（issue）** — 上限見積 = `face_value` を保留する
2. **捕捉（capture）** — 実績で確定し、差分を解放する

これは手形の額面と実際の決済の関係そのものであり、カード決済の auth/capture とも同型。

### 7.2 状態機械

```
                 ┌──────────► dishonored（発行時に拒否）
                 │
  (request) ──► issued ──► captured        （正常系）
                 │  │
                 │  └────► released        （テナントが明示的に解放）
                 │
                 └───────► expired         （maturity 到達 / 自動解放）

  captured ──► adjusted   （事後の補正。Register に adjust を追記）
```

- `issued` → `captured` / `released` / `expired` のみが遷移可能。`captured` から戻れない。
- `expired` は保留を解放するだけで、実行が行われたかは分からない。テナントは maturity 内に
  必ず capture すること。maturity 超過後の capture は `409 authorization_matured` を返し、
  `adjust` エントリでの事後計上を促す。

### 7.3 `POST /v1/authorizations`（振出）

**Request**
```jsonc
{
  "subject_id": "user_8f21",
  "action": "chat.completion",
  "estimate": {                      // pricing_mode=token_based の場合
    "provider": "anthropic",
    "model": "claude-opus-5",
    "input_tokens": 12400,
    "max_output_tokens": 2000,
    "cached_input_tokens": 8000
  },
  "maturity_seconds": 300,           // 省略時 300、上限 3600
  "context": {                       // 分析・介入ルールで使う自由メタデータ
    "feature": "long_document_summary",
    "surface": "web"
  }
}
```
ヘッダ `Idempotency-Key` 必須。

**Response（承認）** `201`
```jsonc
{
  "authorization_id": "01JXXX...",
  "decision": "authorized",
  "face_value": 47,
  "balance_after_hold": 953,
  "maturity": "2026-08-21T04:05:00Z"
}
```

**Response（不渡り）** `200`（HTTP エラーにしない — §7.5）
```jsonc
{
  "decision": "dishonored",
  "reason": "insufficient_balance",
  "balance": 12,
  "required": 47,
  "remedy": {
    "topup_url": "https://pay.tegata.../t/01JYYY",
    "fallback_action": "chat.completion.mini",
    "fallback_face_value": 9
  }
}
```

> **決定事項**: 不渡りは HTTP 402 ではなく **200 + `decision` フィールド**で返す。
> 理由: (a) 402 は多くの HTTP クライアント/プロキシで例外扱いされ、テナントの実装が
> リトライループに落ちやすい、(b) 不渡りは異常系ではなく正常な業務判断結果である。
> ただし互換のため `Tegata-Decision: dishonored` ヘッダも併記する。

### 7.4 Fallback の設計

不渡り時に `remedy.fallback_action` を返す。これは「安価モデルへの降格を TEGATA が**指示**する」
のではなく「テナントが事前に定義した代替を**提示**する」もの。実行判断は常にテナント側にある。

**理由**: TEGATA がモデル選択を決めると、テナントの品質責任と TEGATA の責任境界が混ざる。
提示に留めれば、TEGATA は「認可の層」に留まり続けられる（Master Doc §4.4 の positioning と一致）。

### 7.5 不渡り理由（`dishonor_reason`）

| 値 | 意味 | remedy |
|---|---|---|
| `insufficient_balance` | 残高不足 | topup_url, fallback |
| `entitlement_expired` | 有効な entitlement なし | topup_url |
| `policy_denied` | ポリシー違反（モデル/機能の非許可） | なし |
| `budget_exhausted_period` | 期間予算の上限到達 | retry_after |
| `rate_limited` | レート制限 | retry_after |
| `subject_suspended` | 主体が停止中 | なし |
| `action_unknown` | 未登録アクション | なし（実装エラー） |

### 7.6 プロキシ化を採らない理由

「テナントの推論リクエストを TEGATA が中継すれば見積もりが正確になる」という案は棄却する。

- テナントのレイテンシとプロバイダ可用性に TEGATA が直接責任を負うことになる
- ストリーミング・ツール利用・マルチモーダルの全形態を追随し続けるコストが無限
- 顧客のプロンプトが TEGATA を通過する = データ処理の同意設計が重くなり、導入障壁になる
- Master Doc §5 の「enforcement 層が落ちたら顧客が止まる」リスクを最大化する

代わりに **SDK が実測値を capture で送る**方式を採る。SDK はプロバイダの SDK をラップし、
レスポンスの usage オブジェクトから実測トークンを自動抽出する。

### 7.7 `POST /v1/authorizations/{id}/capture`（捕捉）

```jsonc
{
  "actual": {
    "input_tokens": 12400,
    "output_tokens": 1180,
    "cached_input_tokens": 8000
  }
}
```
または実測クレジットを直接:
```jsonc
{ "credits": 31, "cost_micro_usd": 620000 }
```

- `captured_credits > face_value` の場合: 超過分を追加で引き落とす。残高が足りなければ
  `max_overdraft_credits` の範囲で負残高を許容し、`register_entry.meta.overdraft=true` を立てる。
  超えた場合も**捕捉は必ず成功させる**（実行はもう終わっているため拒否に意味がない）。
  代わりに `balance.overdrawn` イベントを発火する。
- `captured_credits < face_value` の場合: 差分を自動解放。

### 7.8 `POST /v1/authorizations/{id}/release`（解放）

実行が行われなかった場合（例外、ユーザーキャンセル）に保留を戻す。冪等。

### 7.9 直接計上 `POST /v1/usage`

コストが事前に確定していて残高チェック不要な軽量操作（埋め込み生成、分類など）向け。
authorize/capture の往復を省く。残高が負になっても拒否しない。

### 7.10 SDK の想定インターフェース

```ts
// 仕様であって実装ではない
const guard = tegata.guard({ subjectId, action: "chat.completion" });

const decision = await guard.issue({ model, inputTokens, maxOutputTokens });
if (decision.dishonored) return renderPaywall(decision.remedy);

try {
  const res = await anthropic.messages.create({ ... });
  await guard.capture(res.usage);          // usage を自動マッピング
} catch (e) {
  await guard.release();
  throw e;
}
```

言語優先度: TypeScript → Python → Go。理由: ICP のスタックがこの順。

---

## 8. レイテンシと可用性

### 8.1 目標

| 指標 | 目標 |
|---|---|
| `authorize` p50（同一リージョン） | < 15ms |
| `authorize` p99（同一リージョン） | < 50ms |
| `capture` p99 | < 100ms（非同期化可） |
| 月次可用性（authorize） | 99.95% |

### 8.2 到達手段

- **Subject 単位の単一書き手**をリージョン Edge に置く。残高と保留の読み書きが1ノードに閉じるため、
  分散ロックもクォーラム読みも不要。競合はノード内で直列化される。
- Primary DB を同期パスに入れない。Register への書き込みは非同期レプリケーション。
- Subject の `region` は初回 authorize 時に確定し、以後固定。移動は明示 API のみ。
- **クロスリージョンの authorize は目標対象外**とし、実測 RTT を正直に開示する。

### 8.3 Degraded mode（フェイル設計）

Master Doc §5 の最大の信頼リスク。**先に決めておく。**

| `degraded_mode` | 挙動 |
|---|---|
| `allow`（既定） | Edge が判断不能時、`provisional=true` で承認。`max_overdraft_credits` を上限に許容 |
| `allow_cheap_only` | `fallback_action` を持つアクションのみ承認 |
| `deny` | 拒否（`dishonor_reason=service_degraded`） |

**既定を `allow` にする理由**: 顧客のプロダクトを止めないことが、この層への信頼の前提。
TEGATA の障害でテナントの収益機会を止めるほうが、少額の取りこぼしより高くつく。

**復旧後**: `provisional` の authorization を Register に対して再評価し、超過分は
`kind=adjust` で計上する。テナントには `authorization.reconciled` イベントで通知する。

### 8.4 SDK 側のフェイルセーフ

- SDK は authorize のタイムアウトを既定 **200ms** とし、超過時は `degraded_mode` に従って
  ローカル判断する（直近の残高スナップショットをキャッシュ）。
- SDK はオフライン時の capture をローカルキューに積み、復帰後に冪等キー付きで送信する。

---

## 9. Cost Mapping

### 9.1 コストテーブル

| 列 | 内容 |
|---|---|
| `provider` / `model` | `anthropic` / `claude-opus-5` |
| `effective_from` | 適用開始日時 |
| `unit` | `token` / `image` / `second` / `request` |
| `input_micro_usd_per_unit` | |
| `output_micro_usd_per_unit` | |
| `cached_input_micro_usd_per_unit` | |
| `version` | テーブル全体のバージョン |

- バージョンは**追記のみ**。過去の計算は当時のバージョンで再現可能でなければならない。
- テナントは `cost_table_pin` でバージョンを固定できる。既定は最新追従。
- 更新時は `cost_table.updated` イベントを発火し、変更差分（値上げ/値下げ %）を通知する。

### 9.2 クレジット換算

```
cost_micro_usd = Σ (units × rate)
credits        = ceil( cost_micro_usd × markup / tenant.credit_unit_micro_usd )
```

`markup` はテナントがアクション単位で設定する（既定 1.0）。粗利をクレジット定義に織り込むか、
価格側で取るかはテナントの選択。

### 9.3 BYOK / レート上書き

テナントが自社の交渉レート（committed use discount、Bedrock/Vertex 経由の別単価、
自前ホスティング）を持つ場合、`rate_override` で provider/model 単位に上書きする。
上書きがある場合、margin dashboard の原価はそちらを使う。

### 9.4 保守フロー（運用要件）

Master Doc §5「モデル価格の激変にコストテーブル保守が追われる」への対応:

1. 主要プロバイダの価格ページを日次でクロールし、差分を検出
2. 差分は**自動反映しない**。人間の承認を経て新バージョンを発行する
3. 未知モデルが `estimate` に現れた場合、`action_catalog.default_face_value` にフォールバックし、
   `cost_table.unknown_model` イベントを発火（＝テーブル追加のトリガー）

> **これはクラウド側の課金価値そのもの**（Master Doc §3.2）。OSS 実装ではテーブルは
> テナントが自分で管理する。

---

## 10. Churn Intervention

### 10.1 位置づけ

Master Doc §2.1 が「ここがデータループ＝moat」と定義した部分。
enforcement が生む**実行前の意思決定イベント**は、既存 billing が構造的に取得できないデータである。
「止められた瞬間」を持っているのは enforcement 層だけ。

### 10.2 イベント

| イベント | 発火条件 |
|---|---|
| `balance.low` | 残高が entitlement 付与額の閾値 %（既定 20%）を下回った |
| `balance.depleted` | 残高が 0 以下 |
| `balance.overdrawn` | 負残高が発生（§7.7） |
| `authorization.dishonored` | 不渡り。`reason` 付き |
| `dishonor.repeated` | 同一 Subject が 24h 内に N 回（既定 3）不渡り |
| `usage.dropoff` | 直近 7 日の利用が、前 28 日平均の X%（既定 20%）未満 |
| `margin.negative` | 直近 30 日の Subject 粗利が負に転じた |
| `entitlement.refreshed` | 期次リフレッシュ完了 |
| `authorization.reconciled` | degraded 発行分の事後確定（§8.3） |

### 10.3 介入ルール

宣言的な condition → action。ノーコード UI と YAML/JSON の両方から定義できる。

```jsonc
{
  "rule_id": "low_balance_topup_offer",
  "on": "balance.low",
  "when": {
    "subject.lifetime_credits_purchased": { "gt": 0 },
    "subject.days_since_signup": { "gt": 7 }
  },
  "cooldown_hours": 72,
  "then": [
    { "type": "webhook", "target": "tenant_default" },
    { "type": "offer", "template": "topup_20pct_bonus", "surface": "in_app" }
  ]
}
```

**アクション種別（v1）**
- `webhook` — テナントのエンドポイントへ署名付き POST（テナント側で好きに使う）
- `offer` — TEGATA がホストするトップアップリンクを生成し、SDK 経由でアプリ内提示
- `flag` — Subject にタグを付ける（分析・後続ルールの条件に使える）

**v1 に含まないアクション**: メール/プッシュ送信そのもの。テナントの ESP に webhook で渡す。
理由: 送信インフラを持つと配信到達率・法規制（特商法/CAN-SPAM）の責任が発生し、
Non-goal の境界を越える。

### 10.4 効果測定

すべての介入ルールは既定でホールドアウト群（既定 10%）を持つ。
ダッシュボードは「ルールあり群 vs ホールドアウト群」の
トップアップ率・継続率・30日粗利の差分を表示する。

> **決定事項**: 効果測定なしの介入ルールは作らせない。介入が効いているかを示せることが、
> このデータループの価値の証明であり、そのまま販売材料になる。

---

## 11. Margin Dashboard

### 11.1 なぜ最初に作るか

Wedge が「あなたのAIアプリ、赤字ユーザーが何%いるか知っていますか?」（Master Doc §2.1）である以上、
margin 可視化は無料フックであり、**プロダクト内で最初に価値を返す画面**でなければならない。

### 11.2 指標定義（曖昧さを残さない）

| 指標 | 定義 |
|---|---|
| `provider_cost` | `Σ register_entry.delta_cost_micro_usd`（当該期間・当該 Subject） |
| `recognized_revenue` | サブスク: 期間按分（日割り）。トップアップ: 消費されたクレジット分を按分計上。プロモ付与: 0 |
| `gross_margin` | `recognized_revenue − provider_cost` |
| `negative_margin_subject` | 直近 30 日 rolling の `gross_margin < 0` |
| `credit_burn_rate` | 直近 7 日の1日あたり消費クレジット中央値 |
| `days_to_depletion` | `balance / credit_burn_rate` |
| `cost_per_active_subject` | `provider_cost / 当該期間の active subject 数` |

> **決定事項**: トップアップ収益は**購入時ではなく消費時**に認識する。
> 理由: 購入時認識だと「大量購入して使わないユーザー」が異常な高粗利として現れ、
> 赤字ユーザー検出の信号を汚す。会計上の収益認識とは別物であることを UI で明示する。

### 11.3 画面（v1）

1. **Overview** — 全体粗利率、赤字ユーザー数と % 、原価トップ機能
2. **Subjects** — Subject 別の粗利・残高・バーンレート。赤字順ソート。介入ルールの適用状況
3. **Actions** — アクション別の原価・粗利・不渡り率
4. **Register** — 監査ログの検索（Subject / 期間 / kind / authorization_id）

### 11.4 無料診断ツール（Gate 用・製品外）

Master Doc §7 Backlog #5。Stripe と OpenAI/Anthropic の CSV export を食わせて
赤字ユーザー % を返す**製品とは独立した**静的ツール。
指標定義は §11.2 と一致させる（本製品への導線としての一貫性のため）。

---

## 12. 非機能要件

### 12.1 冪等性

- `authorize` / `capture` / `release` / `topup` はすべて `Idempotency-Key` を要求。保持 24h。
- 同一キーの再送は**元のレスポンスをそのまま返す**（再計算しない）。
- キー衝突（同一キー・異なるボディ）は `409 idempotency_key_reuse`。

### 12.2 整合性モデル

| 操作 | 保証 |
|---|---|
| 同一 Subject の authorize/capture | 直列化・強整合 |
| 残高読み取り（別セッション） | Read-your-writes（同一 Subject） |
| Register への反映 | 結果整合（目標 < 5s） |
| ダッシュボード集計 | 結果整合（目標 < 60s） |

### 12.3 監査可能性

- Register は追記専用。UPDATE / DELETE を物理的に禁止する。
- 各エントリは `hash = H(prev_hash ‖ canonical(entry))` でチェーンする。
  Subject 単位のチェーンとし、日次でルートを署名して保管する。
- 訂正は削除ではなく `kind=adjust` の追記で行う。
- 監査ログのエクスポート（JSONL）を API で提供する。

> 「金を扱うコードは監査可能性そのものが購買理由になる」（Master Doc §3.1）を、
> ログ形式のレベルで満たす。形式は `spec/register.md` として公開する。

### 12.4 セキュリティ

- API キーは `publishable`（authorize のみ、Subject を SDK 側で詐称できないよう署名付き Subject トークン必須）と
  `secret`（全操作）に分ける。
- Subject トークンはテナントのサーバが署名して発行する短命 JWT。クライアント直叩きを安全にする。
- webhook 署名は HMAC-SHA256 + タイムスタンプ、リプレイ許容窓 5 分。
- PII は保持しない。`subject_id` は不透明 ID であることをドキュメントで要求する。
  `context` に PII を入れないよう SDK 側で警告する。

### 12.5 データ保持

| データ | 保持 |
|---|---|
| Register | 無期限（テナント削除まで） |
| Authorization 詳細 | 25 か月 |
| Idempotency レコード | 24h |
| 集計テーブル | 無期限 |

### 12.6 レート制限

- テナント単位: authorize 既定 1,000 rps（要相談で引き上げ）
- Subject 単位: 既定 20 rps。超過は `dishonor_reason=rate_limited`

---

## 13. Open-core 境界（本プロダクトにおける適用）

Master Doc §3.2 を Credits に落とすと以下になる。

| OSS（AGPLv3） | クラウド |
|---|---|
| Register 形式と検証ツール | hosted enforcement の SLA（99.95%） |
| 台帳・entitlement スタックの実装 | コストテーブルの保守と配信（§9.4） |
| authorize/capture プロトコルのリファレンス実装 | churn 介入エンジンと効果測定データ |
| SDK（TS / Python / Go） | Margin dashboard |
| policy schema と evaluator | マネージド Edge・マルチリージョン |

**OSS 版で意図的に落とすもの**: マルチリージョン Edge、コストテーブル配信、介入ルールの
ホールドアウト測定、ダッシュボード。単体で動くが、規模と運用が必要になった時点でクラウドに来る。

---

## 14. 将来の接続点（v1 では作らない）

- **Wallet への接続**: Credits の Subject 残高は「振出人が持つ額面」であり、Wallet の
  agent wallet と同じ台帳 primitive に載る。将来、エンドユーザーが複数AIアプリ横断で
  残高を持つ構想（Master Doc §2.3）はここで接続する。
- **`endorsement_chain`**: Credits v1 では未使用だが、スキーマに場所を空けておく。
  「ユーザーがエージェントに自分のクレジットを再委任する」が最初のユースケースになる。
- **Outcome-based**: `action` に成果イベントを紐づけ、成果あたりクレジットを定義する拡張。
  帰属問題（Master Doc §1.3-C）が未解決のため v1 では扱わない。

---

## 15. 受け入れ基準（v1 Done の定義）

| # | 基準 |
|---|---|
| AC-01 | authorize が in-region p99 < 50ms を7日間連続で満たす（合成監視） |
| AC-02 | Edge を強制的に落とした状態で、`degraded_mode=allow` のテナントのアプリが動作し続ける |
| AC-03 | 復旧後、provisional authorization がすべて reconcile され、Register 残高と Edge 残高が一致する |
| AC-04 | 同一 `Idempotency-Key` の 100 並列再送で、台帳への計上が正確に1回 |
| AC-05 | 残高 1 クレジットの Subject に対する 50 並列 authorize で、承認が正確に1件 |
| AC-06 | capture が face_value を超えたケースで、overdraft 上限まで許容し `balance.overdrawn` が発火 |
| AC-07 | Register のハッシュチェーン検証ツールが、改竄されたエントリを検出する |
| AC-08 | Stripe の `invoice.paid` を10回再送しても entitlement が1回だけ付与される |
| AC-09 | 導入 30 分以内に赤字ユーザー % が表示される（オンボーディング計測） |
| AC-10 | 介入ルール1つをホールドアウト付きで作成でき、7日後に差分が表示される |

---

## 16. 未決事項（要判断）

| # | 論点 | 選択肢 | 現時点の推奨 |
|---|---|---|---|
| Q-01 | クレジットの売価ペグをテナント設定にするか、TEGATA 固定にするか | テナント設定 / 固定 | **テナント設定**（既に §5.1 で採用。ただし UI の複雑さは要検証） |
| Q-02 | degraded 既定を `allow` にするリスク（悪用による原価流出）をどう抑えるか | overdraft 上限 / 時間窓上限 / 併用 | 併用。ただし上限値の妥当な既定が未定 |
| Q-03 | v1 のプラットフォーム構成（Edge の実装基盤） | Cloudflare DO / 自前 Rust + Raft / マネージド KV | Gate 通過後に PoC で決定。PRD では実装非依存に保つ |
| Q-04 | 価格設定 | $99/mo 定額 / クレジット流通額の 0.5–1% / ハイブリッド | Master Doc は「%は重くしない」。ICP ヒアリングで検証する |
| Q-05 | Stripe 以外の課金基盤（Paddle / RevenueCat / LemonSqueezy）を v1 で対応するか | Stripe のみ / RevenueCat も | **Stripe のみ**。ただしモバイル比率の高い ICP には RevenueCat が必須になりうる。ヒアリング項目に入れる |
| Q-06 | OSS 版で Edge をどこまで動かせるようにするか | 単一ノードのみ / マルチノード可 | 単一ノード。§13 の境界と整合 |
| Q-07 | 収益認識（§11.2）の「消費時認識」が会計担当に誤解を生まないか | UI 注記 / 二本立て表示 | 二本立て（Cash view / Consumption view）を検討 |

---

## 17. 変更履歴

| 日付 | 版 | 内容 |
|---|---|---|
| 2026-08-21 | v0.1 | 初版。Master Doc §2.1 を実装可能粒度に展開 |
