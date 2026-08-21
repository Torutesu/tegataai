# TEGATA AI — Master Document

Select KK / 2026-08-21 / Status: **Concept 完了 · gate 判定継続中 · Credits MVP 実装先行（D-30）**
本ドキュメントは市場調査・事業定義・ブランド・実行計画を統合した単一の正本。

---

# 0. エグゼクティブサマリー

**TEGATA AI** は、エージェント経済における「支払いの約束」を扱うインフラ。
2つのプロダクトラインを、共通の台帳 / ポリシーエンジン / 監査ログの上に構築する。

- **TEGATA Credits**（振出＝受け取る側）: AIアプリ向け。クレジット発行 × 実行前 authorization × 変動コスト管理 × churn 介入
- **TEGATA Wallet**（裏書＝払う側）: エージェント運用者向け。エージェント別ウォレット/カード × 支出ポリシー × 承認ラダー × レール横断監査

**戦略の骨子**: Open-core（AGPLv3）で「エージェント支出ポリシーの標準スキーマ」を置きに行き、SLA・データループ・レール接続をクラウドで課金する。後発の優位は「どのレールにも義理がないこと」＝ Switzerland position。

**現在地**: Comps 調査完了、Concept Doc 完了、Phase 0 成果物ほぼ完了。
gate 判定材料のうち**ローンチ動画の拍2・拍3（実物の enforcement と検証可能な台帳）は実装なしに
撮影できず**、gate と MVP が循環依存になった。よって **D-30 により Credits MVP の実装を
gate 判定と並行させる**。ヒアリング（判定材料の残り）は実装と独立に進行する。

---

# 1. 市場構造（2026-08 時点）

## 1.1 レイヤーマップ

AIエージェント収益化・決済領域は4層に分かれる。

| 層 | 内容 | 主要プレイヤー | 状態 |
|---|---|---|---|
| ① 汎用 usage-based billing | 事後計測・請求 | Stripe Billing, Metronome（Stripeが2026/1に約$1Bで買収完了）, Orb, Lago, Chargebee | レッドオーシャン。エンタープライズ帯はStripeが押さえた |
| ② AIネイティブ課金 | リアルタイム / クレジット | Credyt, Stigg, Flexprice, Solvimon, Nevermined | 乱立中。**争点は invoice-based か real-time か** |
| ③ アウトカム課金・価値証明 | 何に値付けするか | **Paid.ai**（累計$33.3M、val $100M+）, Velocity（$27M seed） | プレイヤー薄。Paidがcategory creation中 |
| ④ エージェント決済プロトコル | エージェントが払う側 | x402(Coinbase), ACP(OpenAI+Stripe), AP2(Google), MPP(Stripe), Visa TAP, Mastercard Agent Pay | 2026年に一気に実用化 |

## 1.2 Paid.ai（起点となった参照点）

- Outreach（val $4.4B）創業者 Manny Medina がロンドンで創業。2025年3月ステルス解除、2025年9月に Lightspeed リードで $21.6M シード
- チーム: Salesforce billing を作った Manoj Ganapathy、Palantir 初期の Raj Dosanjh、Pleo 初期の Arnon Shimoni
- プロダクト: ノーコード pricing エンジン（クレジット/usage/outcome/ハイブリッド）、エージェント別マージン可視化、**Value Receipt**（「486時間節約、ROI 312%」を請求書に添付する価値証明）
- 初期顧客: Artisan、IFS。シード後は脱シート課金を目指すSaaS全般に対象拡大
- 本質は課金インフラではなく「**AIエージェント向け CFO ツール + 価値証明レイヤー**」

## 1.3 決定的な事実（意思決定の根拠）

**A. アーキテクチャの断層**
既存billing（Stripe Billing / Orb / Lago / Metronome / Chargebee）は invoice-based で、**モデル実行前にブロックする enforcement 層を持たない**。real-time で pre-authorization できるのは Credyt と Stigg のみ（Stigg は既存billingの上に載る orchestration で単体完結しない）。Flexprice は Direct Mode でリアルタイム debit はできるが pre-authorization ゲートがなく、枯渇を事後に検知する。

**B. Consumer AI の収益化が壊れている**
- AIアプリはトライアル→課金転換が非AIより52%高い（8.5% vs 5.6%）が、年間サブスクの解約が30%速い＝「売れるが続かない」
- AIの変動コストにより all-you-can-eat サブスクは構造的に破綻。2026年の解はサブスク+クレジットのハイブリッドだが、**true ハイブリッドを運用できているアプリは10%のみ**

**C. アウトカム課金は進んだが、帰属が未解決**
Intercom Fin（解決会話$0.99）、Zendesk（$1.50〜$2.00）、Sierra、HubSpot Breeze（2026/4から解決会話$0.50）と実装は進行。だが「案件を閉じたのはAIか営業か」の帰属問題、成果定義がファジーな業務での計測不能、マルチエージェント協働時の分配・跨ベンダー精算はいずれも未解決。true outcome-based を実装できたエンタープライズSaaSは約17%に留まる（2022年時点）。

**D. エージェント決済のレールは揃った。ガバナンスは無い**
- x402 は初期数ヶ月で1.65億件のエージェント取引を処理、2026/2に Stripe が Base 上で統合
- ACP は ChatGPT Instant Checkout で稼働、PayPal / Salesforce / Shopify 採用。Shared Payment Tokens（スコープ付き・期限付き・失効可能）を導入、Affirm/Klarna が2026/3にBNPL統合
- AP2 は W3C Verifiable Credentials ベースの Mandate で改ざん耐性ある監査証跡、レール非依存
- Mastercard Agent Pay は2025/11に全米展開、2026/3に Santander と欧州初のE2E規制内取引。Visa Intelligent Commerce は100+パートナー
- McKinsey: agentic commerce は2030年までに$3-5兆規模
- **にもかかわらず**「正しいエージェントが、正しい人のために、正しい認可の下で払っているか」を判定するポリシー施行層はインフラとして未成熟

**E. スタートアップの資金流入**
Skyfire $9.5M（a16z CSX/Coinbase Ventures、KYA identity）、Payman AI $13.8M（Visa/Coinbase Ventures）、Natural $9.8M、Kite AI $35M（PayPal/General Catalyst、agent専用L1）、Basis Theory $33M。Agentic Commerce Consortium（Basis Theory, Lithic, Skyfire, Rye, Crossmint 等、2025/9結成）が標準化を推進。

## 1.4 空白（TEGATA が入る場所）

1. **consumer/prosumer AIアプリ × クレジット × 実行前 enforcement × churn データループ** — Credyt は B2B API infra に閉じ、RevenueCat はサブスク管理のまま、Paid は agent maker 向け。3者の間に落ちている
2. **レール横断のポリシー/ガバナンス統一層** — 先行組は全員「自分のレールの囚人」。Skyfire=identity、Crossmint=wallet、Payman=ワークフロー、カードネットワーク=自社レール。横断層を取ろうとすると本業と conflict するため構造的に取れない
3. **「エージェントの経費規程」** — 予算・目的コード・承認閾値・稟議連携という企業経理の語彙でエージェント支出を扱うプロダクトが不在。Ramp/Brex はまだ人間の経費の延長
4. **地域** — プレイヤーはほぼ全員 US / crypto-native。非US エンタープライズ向けは空白

---

# 2. 事業内容

## 2.1 TEGATA Credits（Product A）

**一行**: AIプロダクトの「サブスク+クレジット」を、推論実行前のリアルタイム認可と churn 自動介入込みで提供する monetization layer。

**機能スコープ（v1）**
1. **Wallet & Credits** — サブスクにクレジット entitlement を紐付け（$20/mo に1,000クレジット、リフレッシュ、overage単価）
2. **Pre-flight Authorization** — 各AIアクション実行前に残高チェック → 承認 / ブロック / 安価モデルへの fallback 指示を atomic に返す。**p99 < 50ms 目標**（edge KV + 楽観的残高）
3. **Cost Mapping** — プロバイダ別トークン単価テーブルを保守し、1アクション=何クレジットを自動算出。BYOK 構成対応
4. **Churn Intervention** — 残高枯渇・利用急減・解約予兆をイベント化し、paywall再提示 / top-up offer / win-back を自動発火。**ここがデータループ＝moat**
5. **Margin Dashboard** — ユーザー別・機能別粗利。negative-margin user 検出とポリシー適用

**Non-goals（v1）**: 請求書発行・税務・エンタープライズ契約管理（既存に委譲）、決済処理そのもの（Stripe上に載る）

**ICP**: 月次 $5k-100k MRR の AIアプリ（画像/動画生成、AIコンパニオン、writing、coding tool）のソロ〜小規模チーム。Stripe直書きでクレジットを自前実装し、enforcement と churn に苦しんでいる層

**Wedge**: 「あなたのAIアプリ、赤字ユーザーが何%いるか知っていますか?」— margin 可視化を無料フックに、enforcement と churn 介入で課金

**Pricing 仮説**: Free（〜$1k MRR相当）→ $99/mo + 薄い従量、または処理クレジット額の0.5-1%。**%課金は TCO で嫌われるため重くしない**（Flexprice の $500-1,000/mo は アーリーステージを弾いている）

## 2.2 TEGATA Wallet（Product B）

**一行**: 「Ramp / Brex for AI agents」。エージェント別ウォレット/仮想カード、ポリシーベースの支出ガードレール、リアルタイム監査を、レール非依存（x402 / ACP / AP2 / カード横断）で提供。

**機能スコープ（v1）**
1. **Agent Wallet & Card** — エージェント/ワークフロー単位のウォレット + 単発仮想カード（発行は Lithic / Stripe Issuing 等に委譲）。USDC とカードの両レール
2. **Policy Engine** — 上限額・単価上限・許可マーチャント/カテゴリ・時間帯・目的（task ID紐付け）を宣言。**enforcement は実行系の外側（ランタイム/プロキシ）で行い、プロンプトに依存しない**
3. **Approval Ladder** — 金額・カテゴリ閾値で auto → notify → human-in-loop を段階制御
4. **Audit Trail** — どのエージェントが・誰の認可で・何のタスクで・いくら払ったか。AP2 mandate / ACP SPT のメタデータを正規化して一元表示
5. **Spend Analytics** — エージェント別・タスク別・レール別コスト、予算バーンレート、異常検知

**Non-goals（v1）**: 独自レール/独自チェーン、資金移動そのもの（**orchestration + issuing 委譲に徹する。ライセンス業務を自社で持たない**）

**ICP**: エージェントを本番運用し始めた企業の platform / finance 両チーム。(a) agentic workflow で API課金・SaaS購買・広告出稿を自動化し始めた AI-native 企業、(b) Claude Code / Cowork 等でエージェントにタスク委任しているチームの管理者

**Wedge**: 「エージェントに会社のカードを渡す前に読むドキュメント」+ 無料の spend visibility → ポリシー/enforcement で課金

**Pricing 仮説**: per-agent seat（$20-50/agent/mo）+ 決済額連動の薄い bps。カード発行分の interchange が乗れば Ramp 型の実質無料モデルも可能

## 2.3 共通 primitive と投入順序

**A と B は台帳・ポリシーエンジン・監査ログを共有する。** A が「受け取る側」、B が「払う側」。
**A → B の順で投入**するのが資本効率最良。A の埋め込み wallet UI が、将来「ユーザーが複数AIアプリ横断で残高を持つ」構想として B に接続する。

---

# 3. OSS 戦略

## 3.1 位置づけ

**これは「OSSでバズる」プロダクトではない。** Lago も Flexprice もバズったことはない。それでも OSS にする理由は3つ。

1. **金を扱うコードは監査可能性そのものが購買理由になる** — 支払権限を握る policy engine がブラックボックスではエンタープライズを通らない
2. **ソロオペレーターの配布効率** — 営業チーム無しで GitHub がパイプラインになる
3. **ターゲットの購買行動が OSS-first** — Credyt がエディタ内セットアップで刈っている層と同じ

**指標は stars ではない。** 「自前実装しかけた開発者が clone で済ませ、SLAが必要になった時点でクラウドに来る」導線の成立。バズは要らない、デフォルトになればいい。

## 3.2 Open-core の線引き

| OSS（AGPLv3） | クラウド（課金） |
|---|---|
| wallet / 台帳 primitive | hosted enforcement の SLA（落ちたら顧客が止まる部分こそ金を払う理由） |
| policy engine（宣言スキーマ + evaluator） | モデル別コストテーブルの保守 |
| 監査ログフォーマット | churn 介入ループとそのデータ |
| 各レール（x402/ACP/カード）アダプタ | カード発行パートナーシップ |
| | ダッシュボード |

- ライセンスは **AGPLv3**。cloud copycat 対策になり、Lago / Flexprice で顧客側の受容も実証済み。MIT/Apache は Stripe に丸呑みされるリスクを自ら作る
- Flexprice / Lago は production機能（customer portal, credit notes, dunning, tax）を有料層に置く構造で成立している（Flexprice: Starter $500/mo, Premium $1,000/mo, 3.6k stars）

## 3.3 後発の戦い方

1. **Switzerland position** — どのレールにも義理がないので、メタレイヤー（ポリシー+監査の統一層）を最初から取れる。先行組は本業と conflict するため構造的に真似できない
2. **値付けの地雷マップが公開済み** — %課金は TCO で嫌われる、$500/mo は アーリーを弾く。最初から正解の価格構造で入れる
3. **標準への相乗り** — x402 / ACP / MCP と乗るべき標準が確定しつつある。「標準のリファレンス実装」ポジションは後発の特権

---

# 4. ブランド

## 4.1 定義

**TEGATA AI**（テガタ）
- EN 一行: **TEGATA — the oldest payment instrument, rebuilt for machines.**
- JA 一行: 手形。機械のために作り直された、最も古い支払いの約束。

## 4.2 Origin Story

手形は数百年、日本の商取引を支えた。買い手には信用供与、売り手には流動性という二重機能。だが物理的な紙の証券だった。印刷し、押印し、郵送し、保管し、銀行窓口に持参する — その全工程に紛失・毀損・盗難・偽造のリスクがあり、一枚の紛失は法的拘束力のある支払義務の喪失を意味した。そして今、紙の約束手形は制度として終わろうとしている。

**紙は死ぬ。概念は残る。**

x402 の payment payload、AP2 の signed mandate、ACP の Shared Payment Token — すべて「スコープと期限と署名を持つ、譲渡可能な支払いの約束」。手形が数百年やってきたことと構造が同じで、違いは紙が暗号署名に置き換わったことだけ。

## 4.3 用語辞書（Lexicon）— 最大のブランド資産

| 手形語彙 | EN | プロダクト概念 |
|---|---|---|
| 振出 | Issue | 権限/クレジットの発行 |
| 振出人 | Drawer | エージェントに権限を委任する人間・企業 |
| 受取人 | Payee | 支払いを受けるサービス/API |
| **裏書** | **Endorsement** | **権限の再委任。マルチエージェントの委任チェーンを1語で説明できる** |
| 満期 | Maturity | mandate の有効期限 |
| 額面 | Face value | 承認された上限額 |
| 割印 | Counter-seal | 二者照合による認可（human + agent） |
| 不渡り | Dishonor | 残高不足/ポリシー違反による実行拒否 |
| 手形帳 | Register | 監査ログ・台帳 |

**「裏書」は業界がまだ言葉を持っていない領域（マルチエージェントの委任連鎖）を1語で説明できる。** スキーマ名にそのまま使う: `endorsement_chain`, `maturity`, `face_value`, `dishonor`。OSS で標準を置きに行く戦略と噛み合う。

## 4.4 Voice & Tone

**Precise · Institutional · Quiet**

- 信頼 > 新奇性。誇張・煽り・絵文字を使わない
- 断定的に、短く。仕様を語れるなら形容詞は要らない
- 「AI」を主語にしない。主語は常に「あなたのエージェント」「あなたの支出」
- 歴史への参照は1回だけ強く打ち、繰り返さない。ノスタルジーではなく構造の相似

**Do**: authorize / enforce / ledger / mandate / scope / audit / settle
**Don't**: revolutionary / seamless / effortless / magical / unleash / supercharge

## 4.5 コピーテンプレート

**Hero（Credits）**
> Know which users lose you money — before the model runs.
> Credits, real-time authorization, and margin per user. One SDK.

**Hero（Wallet）**
> Your agents can spend. Decide how much, on what, and prove it later.
> Policy-enforced wallets and cards for autonomous agents. Rail-agnostic.

**Positioning**
> Billing systems tell you what happened. TEGATA decides what's allowed to happen.

**OSS**
> Money-handling code should be readable. The ledger, the policy engine, and the audit format are open source. The uptime is what you pay for.

## 4.6 NG ルール

1. **競合を名指ししない**（Select KK 標準）。"other tools" / "existing billing systems" を使う
2. **和風エキゾチシズムに寄せない**。侍・忍者・桜・筆文字は使わない。手形は美学ではなく商業制度
3. **暗号通貨プロダクトに見せない**。ステーブルコイン対応は機能であって思想ではない
4. **規制上の断定をしない**。「送金する」「資金を保管する」と書かない
5. 日本語コピーで「手形」を一般名詞として使わない。常に **TEGATA** 表記

## 4.7 表記・ビジュアル

- 英語圏: **TEGATA**（全大文字）/ 日本語: **TEGATA**（読み仮名は初出時のみ）
- ライン名: TEGATA Credits / TEGATA Wallet
- 「TEGATA AI」は法人・ドメイン文脈のみ
- ビジュアル: 紙ではなく**証券の構造**を借りる。割印 / ミシン目 / 罫線 / 通し番号
- ロゴ第一候補: **割印の抽象化** — 二つの矩形にまたがる一つの印影。振出と裏書、Credits と Wallet の二面性を1マークで表す
- カラー: 証券用紙の質感（極薄ウォームグレー）× 印影の朱 or 黒。SHOGUN の #C8A96E とは意図的に差別化
- 禁止: 影・グラデーション・イラスト調・和柄テクスチャ

---

# 5. リスク

## Product A
1. **RevenueCat / Stripe の機能追加で空白が埋まる**（最大リスク。12-24ヶ月レンジ。スピード勝負）
2. Credyt が consumer 文脈に伸びる
3. **enforcement 層はミッションクリティカル** — 落ちたら顧客のプロダクトが止まる。SLA / フェイルオープン設計が信頼の生命線
4. モデル価格の激変にコストテーブル保守が追われる

## Product B
1. **Ramp / Brex の本格参入**（expense agents から自然拡張。最大リスク）
2. プロトコル勝敗の不確実性 → レール非依存設計で対応するが抽象化コストは高い
3. 規制: 資金移動・カード発行のライセンス境界。**orchestration に徹する設計判断を厳守**
4. **市場タイミング** — **仮説ではなく実証済み（2026-08 調査）。`docs/gtm/icp-target-list.md` §2.4 参照。**
   本番でエージェントが外部ベンダーに払っていると確証できた非 crypto 企業は2社のみ。
   x402 の実取扱高は日次約$28,000 で、アナリストは約半分を自己取引/ウォッシュトレードと評価。
   Shopify で Instant Checkout を稼働させた加盟店は30社未満、OpenAI は2026年初頭に撤退。
   ソフトウェア企業の AI 支出は中央値でエンジニア1人あたり年$137（上位1%は$89k、680倍の差）。
   **痛みが実在するのは「エージェントの推論費」側であり、そこは $20/dev/月 でコモディティ化しつつある。**
   → **A → B の順序（§2.3）はこの調査で決定的に補強された。順序を変える理由はない。**
5. **プラットフォームが政策レイヤーを吸収する**（新規・構造的リスク）— エージェント購買が実際に
   規模を持つ場所では、購買先のプラットフォーム自身が既に統制を出荷している
   （ワークブック単位のクレジット上限、マーチャント/カテゴリ制限付きのエージェント用カード等）。
   **レール非依存の独立ウォレットは、エージェントが買っている当のものに無料で付いてくる統制に
   勝たなければならない。** 2026-08 時点で直接競合が当該機能を投入済み

## 全体
- SHOGUN とのリソース競合（Select KK は SHOGUN 専業方針。本件を立てるなら配分の明示的な意思決定が必要）
- **商標** — Paygent の件（NTTデータ・三菱UFJニコス折半出資の決済代行会社が PAYGENT として実在、加盟店1.3万店）を踏まえ、着手前に必ず調査

---

# 6. 満たすべき条件（Gate）

Select KK launch equation: **① Comps → ② Concept Doc → ③ GTM Prototype gate → ④ Implementation**

**現在 ② 完了、③ 進行中。③ と ④ を D-30 により並行させる**（下記 6.0 参照）。

## 6.0 gate と実装の並行（D-30）

§6.1 の共通条件は「説得力あるローンチ動画/ストーリーボードが明確に作れないなら Concept に戻す」
と定める。`docs/gtm/launch-storyboard.md` の自己判定により、動画は3拍で構成され、
**拍2（実行前に止まる瞬間・実測レイテンシ）と拍3（検証可能な台帳）は実装なしに撮影不能**である。
したがって gate 通過の判定材料が実装を要求し、実装が gate 通過を待つという循環が生じた。

**解**: Credits MVP を `docs/plan/credits-mvp.md` に従って実装する。gate の残りの判定材料
（ICP ヒアリング・診断ツールの反応）は実装と独立に進める。**Wallet（Product B）は実装しない**
— `docs/gtm/icp-target-list.md` §2 の調査により市場が EARLY と実証されたため、§2.3 の
A → B 順序を維持する。

## 6.1 GTM Prototype gate 通過条件

**Product A**
- [ ] margin 診断ツール（Stripe / OpenAI の export を食わせて赤字ユーザー% を出す無料ツール）を公開
- [ ] LP + デモで waitlist / 商談 N件（N は着手時に確定）
- [ ] ICP 10社ヒアリングで「enforcement を自前実装済み or 諦めた」が**過半**

**Product B**
- [ ] 「Agent Spend Policy Template」（経費規程テンプレ + 可視化デモ）を無料配布、DL / 商談 N件
- [ ] エージェント本番運用企業 10社ヒアリングで「支出事故 or その恐怖で自律化を止めている」が**過半**

**共通**
- [ ] spec-first public repo（README + policy schema 仕様のみ、コードなし）への反応で温度を測る
- [ ] **ルール**: 説得力あるローンチ動画/ストーリーボードが明確に作れないなら、Concept 段階に戻す

## 6.2 着手前に必ず潰すもの（Blocker）

- [ ] **弁理士による日米の TEGATA 類似商標調査**（Paygent の教訓。最優先）
- [ ] tegata.ai / tegata.com のドメイン取得可否
- [ ] GitHub org / X handle の確保
- [ ] 国内出願時の指定役務設計（日本では「手形」が一般名詞。Oracle NetSuite Japan edition も機能名で tegata を使用しており識別力に注意）

---

# 7. 作るべきもの（Backlog）

## Phase 0 — Gate 前（コードなし）
| # | 成果物 | 目的 |
|---|---|---|
| 1 | 商標調査依頼・ドメイン/ハンドル確保 | Blocker 解消 |
| 2 | ロゴ（割印の抽象化）+ 最小ブランドキット | 全アセットの前提 |
| 3 | **spec-first public repo**: README + policy schema 仕様（`endorsement_chain` / `maturity` / `face_value` / `dishonor`） | 標準を置きに行く。gate 判定材料 |
| 4 | LP 骨子（Credits / Wallet 2ページ） | waitlist 獲得 |
| 5 | margin 診断ツール（Product A の無料フック） | gate 判定材料 |
| 6 | Agent Spend Policy Template（Product B の無料フック） | gate 判定材料 |
| 7 | ローンチ動画 or ストーリーボード | **gate の合否そのもの** |
| 8 | ICP ヒアリングリスト（各10社）+ 質問設計 | gate 判定材料 |

## Phase 1 — Gate 通過後
| # | 成果物 |
|---|---|
| 9 | 共通 primitive（台帳 / policy engine / 監査ログ）の OSS 実装 |
| 10 | TEGATA Credits SDK + hosted enforcement（p99 < 50ms） |
| 11 | Cost mapping テーブルと保守フロー |
| 12 | Churn intervention イベント基盤 |
| 13 | Margin dashboard |

## Phase 2
| # | 成果物 |
|---|---|
| 14 | TEGATA Wallet: レールアダプタ（x402 / ACP / カード） |
| 15 | Approval ladder + 監査 UI |
| 16 | Issuing パートナー接続（Lithic / Stripe Issuing） |

---

# 8. 派生ドキュメント

| ドキュメント | 内容 | 言語 | Backlog |
|---|---|---|---|
| `docs/prd/tegata-credits.md` | Product A の要件定義（実装可能粒度） | JA | Phase 1 |
| `docs/prd/tegata-wallet.md` | Product B の要件定義（実装可能粒度） | JA | Phase 2 |
| `docs/gtm/icp-interviews.md` | ICP ヒアリング設計と gate 判定基準 | JA | #8 |
| `docs/gtm/margin-diagnostic.md` | margin 診断ツールの仕様（無料フック） | JA | #5 |
| `docs/gtm/launch-storyboard.md` | ローンチ動画ストーリーボード + 合否自己判定 | JA | #7 |
| `docs/gtm/lp-skeleton.md` | LP 骨子（Credits / Wallet、EN コピー確定稿） | JA/EN | #4 |
| `docs/gtm/icp-target-list.md` | ヒアリング対象リストと市場実態の調査結果 | JA | #8 |
| `docs/gtm/outreach.md` | 接点設計とアウトリーチ文面 | JA/EN | #8 |
| `docs/plan/credits-mvp.md` | Credits MVP 実装計画（ゴールモード実行仕様） | JA | Phase 1 #9–10 |
| `templates/agent-spend-policy.md` | Agent Spend Policy Template（無料配布物・完成品） | EN | #6 |
| `brand/` + `docs/brand/brand-kit.md` | ロゴ（割印）・カラートークン・タイポ・モチーフ規則 | JA | #2 |
| `tools/margin-diagnostic/` | margin 診断ツール実装（単一HTML・送信ゼロ） | EN | #5 |
| `spec/authorization.md` | Authorization protocol（振出→捕捉→解放）の規範仕様 | EN | #3 |
| `spec/policy.md` | Policy schema（Credits / Wallet 共通） | EN | #3 |
| `spec/register.md` | Register（追記専用台帳）フォーマット | EN | #3 |
| `spec/schema/*.json` | JSON Schema 2020-12 + 検証済みサンプル | — | #3 |
| `docs/decisions/` | ADR（設計判断の記録） | JA | — |

## 8.1 Backlog 進捗（Phase 0）

| # | 成果物 | 状態 |
|---|---|---|
| 1 | 商標調査・ドメイン/ハンドル確保 | **未着手（Blocker）** |
| 2 | ロゴ + 最小ブランドキット | **完了**（`brand/` + `docs/brand/brand-kit.md`。ワードマークのアウトライン化のみ残） |
| 3 | spec-first public repo | **仕様完了・LICENSE 配置済（AGPL-3.0）。公開タイミング判断のみ残** |
| 4 | LP 骨子（Credits / Wallet） | **骨子完了**（`docs/gtm/lp-skeleton.md`）。実装が残 |
| 5 | margin 診断ツール | **実装完了**（`tools/margin-diagnostic/`、M-01〜M-07 検証済み）。公開時に別リポジトリへ移す |
| 6 | Agent Spend Policy Template | **完了** |
| 7 | ローンチ動画 / ストーリーボード | **ストーリーボード完了**（`docs/gtm/launch-storyboard.md`）。拍1は診断ツール実装後、拍2/3 は Phase 1 最小実装後に撮影可 |
| 8 | ICP ヒアリングリスト + 質問設計 | **完了**（`icp-target-list.md` / `outreach.md`）。**Product B の gate 条件に改訂提案あり — 要判断** |
