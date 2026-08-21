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
