# 実装 decision log

`docs/plan/credits-mvp.md` §12 の運転規則に従い、以下を記録する。

- spec / PRD の欠陥や矛盾（**spec は変更せず**、発見・提案・暫定実装を書く）
- 依存 allowlist からの逸脱と、その理由
- 計画が沈黙していて「最も可逆な選択」で進んだ箇所

形式: `## YYYY-MM-DD / M<n> / 種別` + 発見 / 影響 / 採った手 / 提案。

---

## 2026-08-21 / M0 / 依存追加

**追加**: `@typescript-eslint/*`, `eslint`, `tsx`, `@types/node`, `@types/better-sqlite3`。
**理由**: 計画 §2 の allowlist に `typescript, tsx, @types/*` は含まれる。eslint 本体と
TS プラグインは allowlist に明記がなかったが、§11 の共通 DoD が `eslint` を要求しているため
必須。ランタイム依存ではなく devDependency に閉じる。

## 2026-08-21 / M0 / 計画の沈黙（最も可逆な選択）

**発見**: 計画 §4 の DDL は `markup_milli`（千分率）を使うが、PRD §9.2 は `markup` を
実数（既定 1.0）として書いている。整数規則（CLAUDE.md 1）と衝突する。
**採った手**: DDL どおり `markup_milli INTEGER`（1000 = ×1.0）で実装。
換算は `ceil(cost_micro_usd × markup_milli / 1000 / credit_unit_micro_usd)` を
**整数演算の順序で**行う（先に乗算、後に除算）。
**提案**: PRD §9.2 の `markup` 表記を千分率に改める。gate 後の PRD 改訂でまとめて。

## 2026-08-21 / M1 / 設計欠陥（不変条件テストが検出）

**発見**: オーバードラフト後の付与で、entitlement スタックと残高が**恒久的に乖離**する。
capture が スタック残高を超えた場合、超過分は balance のみが負担し（PRD §7.7）、
スタックはゼロのまま。その後 N クレジットを付与すると balance = N − D、
スタック = N となり、以後スタックは「実際にある金」を表さなくなる。

**影響**: 承認判定は balance 由来の available を使うため**過剰支出は起きない**。
しかし entitlement 単位の残高表示・消費順序・失効計算が実態とずれる。
時間が経つほど乖離が累積し、監査で説明できなくなる。

**採った手**: `overdraftRepayment(balanceBeforeGrant, granted)` を core に追加。
付与は**まず不足分を返済**し、残りだけがスタックに載る。これにより
「solvent ならスタック合計 = balance、overdrawn ならスタックは空」が常に成立する。

**INV-8 の記述も修正**: 計画 §4.1 は「balance ≥ 0 の範囲では Σremaining = balance」と
書いていたが、正しくは `stackRemaining === max(0, balance)` が**常に**成立する。
より強い条件であり、テストはこちらで書いた。

**提案**: PRD §5.1 と 計画 §4.1 の INV-8 を上記に改める。gate 後の改訂でまとめて。

## 2026-08-21 / M1 / spec との差異（spec は変更せず）

**発見**: `spec/schema/policy.schema.json` の duration パターンは `P` / `PT` / `P1DT` を
正しく弾くが、実装の初版正規表現はこれらを通していた（`P1DT` が days=1 として通過）。
**採った手**: 実装の正規表現をスキーマと**同一の lookahead 形**に揃えた。spec は無変更。
テストで両者が同じ入力集合を受理・拒否することを確認。

## 2026-08-21 / M1 / purity 例外

**発見**: `systemClock`（実時刻への唯一のアダプタ）が purity チェックに抵触する。
**採った手**: `purity-ok` マーカーで明示的に例外化し、**さらにチェッカー自身に
「このマーカーは `packages/core/src/clock.ts` 以外に現れてはならない」を実装**した。
例外を許す仕組みが、その例外の拡散も同時に取り締まる。
