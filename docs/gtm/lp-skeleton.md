# LP 骨子 — Credits / Wallet

Select KK / 2026-08-21 / v0.1
Master Doc §7 Backlog #4。コピーは EN 確定稿、注記は JA。
実装時は `landing-seo-perf` スキル準拠（Lighthouse 95+、OGP、構造化データ）。

---

## 共通原則

1. **1ページ1主張。** Credits は「実行前に止まる」、Wallet は「渡す前に決める」。それ以外は補強
2. **各セクションに証拠を1つ。** 主張だけのセクションは置かない。証拠が用意できないセクションは
   実装しない（≠ 後で足す。**最初から置かない**）
3. CTA は各ページ2種まで: 無料フック（主）+ waitlist（従）。デモ予約は診断ツール/テンプレの
   結果画面側に置く（`margin-diagnostic.md` §6.1 と同じ思想: 押した人だけが温度の高いリード）
4. waitlist フォームは **email 1欄のみ**。属性はヒアリングで聞く。フォームで聞くほど落ちる
5. Voice: Master Doc §4.4。ヒアリングで採れた「相手が使った言葉」（`icp-interviews.md` §6）で
   随時差し替える。**自分の言葉より ICP の言葉**

---

## Page 1 — TEGATA Credits（tegata.ai/credits）

### §1 Hero

> **Know which users lose you money — before the model runs.**
> Credits, real-time authorization, and margin per user. One SDK.

- CTA 主: `Check your margin — free, nothing uploaded` → 診断ツール
- CTA 従: `Join the waitlist`
- 直下にシーン4相当の15秒ループ（authorize → dishonor）。動画未完成の間は
  ターミナル風のテキストアニメーション（実レスポンス形式そのまま）で代替

### §2 問題（数字は3つまで）

> AI apps convert 52% better than non-AI apps — and churn 30% faster.
> Subscriptions sell. Variable costs decide whether they were worth selling.
> Only one in ten apps runs a working hybrid of subscription and credits.

証拠: 出典リンク（Master Doc §1.3-B の元データ）。**出典が張れない数字は載せない**

### §3 転換（プロダクトの心臓）

> **An authorization, not an invoice.**
> Before each action, one call: allowed, refused, or "offer the cheaper model."
> A refusal is not an error — it returns the reason and the fix, so the moment
> a user hits the wall becomes the moment they top up.

証拠: 実 API のリクエスト/レスポンス（PRD §7.3 の JSON をそのまま）+ `12ms` の実測表示

### §4 SDK（3行で入ることを見せる）

PRD §7.10 のコードをそのまま掲載。行数を増やさない。

> Wrap the call you already make. `issue` before, `capture` after, `release` on failure.
> If TEGATA is unreachable, your app keeps running — degraded mode is a setting you choose,
> not an outage you discover.

証拠: コード + degraded mode の説明1行（信頼の生命線。Master Doc §5-A3 への先回り）

### §5 データループ

> **The refusal is data.**
> Balance low, usage dropping, margin gone negative — each fires an event with a
> holdout group attached. You see whether the intervention worked, not whether it ran.

証拠: ルール定義 JSON（PRD §10.3）+ ホールドアウト差分のダッシュボード断片

### §6 監査可能性 / OSS

> Money-handling code should be readable. The ledger, the policy engine, and the
> audit format are open source. The uptime is what you pay for.
> Export your register. Verify the chain yourself.

証拠: spec repo リンク + 検証コマンドの出力 `chain verifies`

### §7 FAQ（ヒアリングの反対理由から逆算。初期4つ）

1. **Does my prompt data pass through you?** — No. We never see your prompts. The SDK sends
   token counts, not content.（プロキシ化しない設計 = D-01 がそのまま回答になる）
2. **What happens when you're down?** — Your choice, declared in advance: allow with a bounded
   overdraft, cheap-only, or deny. Default is allow. Your app does not stop because we did.
3. **Do you replace Stripe?** — No. Stripe stays your billing system of record. We decide what's
   allowed to happen between invoices.
4. **What does it cost?** — （価格未定のため gate 期間中は）Early access is free while we finish
   the spec. Pricing will be flat-rate first, not a percentage of your revenue.

### §8 フッター

> TEGATA — the oldest payment instrument, rebuilt for machines.

歴史はここで1回だけ。§1〜§7 では手形に言及しない（Master Doc §4.4「1回だけ強く打つ」）。

---

## Page 2 — TEGATA Wallet（tegata.ai/wallet）

### §1 Hero

> **Your agents can spend. Decide how much, on what, and prove it later.**
> Policy-enforced wallets and cards for autonomous agents. Rail-agnostic.

- CTA 主: `Get the Agent Spend Policy Template — free` → `templates/agent-spend-policy.md` の
  整形版（PDF/Notion 複製可）
- CTA 従: `Join the waitlist`

### §2 問題

> Somewhere in your company, an agent already has a payment method.
> A shared corporate card. Someone's API key. A limit written in a prompt.
> A limit written in a prompt is a request, not a control.

証拠: なし（この3行自体がヒアリング §3.2-A の実態の要約。採れた実言葉に差し替え予定）。
最後の1行はテンプレ本文と同一表現 — LP・テンプレ・スキーマで同じ文が出ることが一貫性の証拠

### §3 転換

> **The policy is enforced where the agent cannot reach it.**
> Per-agent limits, allowed categories, purpose codes, approval above a threshold —
> declared once, enforced at the card, the gateway, and the tool boundary.
> Compromised or not, the agent cannot spend around it.

証拠: policy JSON（spec/examples/policy-agent-research.json をそのまま）

### §4 委任（業界に語彙がない領域 = 差別化の最深部）

> **Delegation that only narrows.**
> An agent grants a sub-agent part of its authority: less money, shorter expiry,
> narrower scope — never more. Revoke the parent, and everything downstream dies with it.
> The chain is recorded. It is called an endorsement, and it is four hundred years old.

証拠: `endorsement_chain` の実 JSON（examples/authorization-endorsed.json）。
歴史への言及はこの1文で終える

### §5 監査

> **Four questions, one screen.**
> Which agent. Whose authority. What purpose. How much.
> If your last audit took a spreadsheet and three engineers, this section is for you.

証拠: 監査画面モック（gate 期間中は静止画で可）+ register エクスポートの検証出力

### §6 FAQ（初期4つ）

1. **Do you hold our money?** — No. Funds stay with your issuer and your custodian. We decide
   whether a payment is authorized, record it, and explain it. Nothing else.（D-13 がそのまま回答）
2. **Which rails?** — Cards via your issuing partner, x402, ACP, AP2. No preference — the policy
   layer is the product, adapters are open source.
3. **What if TEGATA is unreachable?** — Wallet defaults to deny: no decision, no spend. The
   opposite default from our Credits product, and deliberately so.
4. **Can we start without giving agents a card?** — Yes. Observe mode ingests what your agents
   already spend and attributes it. Nothing is blocked until you say so.

### §7 フッター

Credits と同一。

---

## 実装メモ

- 骨子承認後の実装は `landing-seo-perf` + `dribbble-to-lovable` は使わず素の静的ページで
  （証券的ビジュアル: 罫線・通し番号・割印。Master Doc §4.7 の禁止事項に注意）
- OGP: 各ページの Hero 1行目をそのまま og:title に。og:image は割印モチーフ + 1行
- 計測: 訪問 → 無料フック CTA click / waitlist submit の2転換のみ。ヒートマップ等は入れない
