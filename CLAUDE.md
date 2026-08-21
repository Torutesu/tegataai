# tegataai

TEGATA AI（Select KK）のリポジトリ。正本は `docs/00-master.md`。
**Credits MVP を実装中**（`docs/plan/credits-mvp.md` が実行仕様、D-30 により gate 判定と並行）。
Wallet（Product B）は実装しない — 市場が EARLY と実証済み（`docs/gtm/icp-target-list.md` §2）。

## 構成と言語

- `docs/` — 内部ドキュメント。**日本語**。`00-master.md` が唯一の正本
- `spec/` / `templates/` / `README.md` — 公開前提。**英語**。RFC 2119 語彙で規範的に書く
- `packages/` — 実装（TypeScript）。`core ← store ← server`、`core ← sdk`、`core ← verify`。**逆流禁止**
- `tools/margin-diagnostic/` — 無料フック。依存ゼロの単一 HTML。**実装作業では触らない**
- `brand/` — ロゴ・OG。**実装作業では触らない**

## 不変のルール

1. 金額・クレジットは常に**整数**（クレジット / μUSD / 通貨最小単位）。浮動小数を使わない。
   `packages/core` `packages/store` での `toFixed` / `parseFloat` は CI で検出して fail
2. 台帳規約: 保留は `delta = 0`。残高が動くのは約定のみ（`spec/register.md` §3–4）。
   `balance = Σdelta` / `reserved = Σ meta.face_value`（未終端 issue）/ `available = balance − reserved`
3. `packages/core` と `packages/store` は `Date.now()` / `Math.random()` を直接呼ばない。
   `Clock` / `Rng` を注入する（D-29）。CI で検出
4. **`spec/` と `docs/prd/` を実装の都合で変更しない。** 欠陥を見つけたら
   `docs/plan/decision-log.md` に記録し、spec は触らずに進む
5. `spec/examples/register.jsonl` は**検証可能なテストベクタ**。編集したらハッシュチェーンを
   再計算する（JCS = sorted compact JSON、SHA-256、`hash` 列を除いた全体が対象）
6. JSON スキーマは `spec/schema/*.json` が唯一の定義。**実装側で再定義しない**（Ajv に直接読ませる）
7. 用語は Lexicon（`docs/00-master.md` §4.3）に従う: face_value / maturity / dishonor /
   endorsement_chain / counter_seal / register。新しい同義語を発明しない
8. 覆すと高くつく判断は `docs/decisions/README.md` に D-番号で追記する
9. 依存追加は `docs/plan/credits-mvp.md` §2 の allowlist のみ。逸脱は decision-log に理由を先に書く
10. ブランド NG（Master §4.6）: 競合名指し・和風エキゾチシズム・crypto 見せ・規制上の断定をしない

## コマンド

```bash
pnpm install
pnpm verify          # tsc + eslint + vitest + spec 検証 + 禁止パターン検査
pnpm verify:spec     # spec/schema と examples の検証（チェーン含む）
pnpm dev             # server 起動
pnpm bootstrap       # テナント作成 + サンプル action 登録
```
