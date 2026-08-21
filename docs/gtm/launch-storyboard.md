# ローンチ動画 — ストーリーボード（TEGATA Credits）

Select KK / 2026-08-21 / v0.1
Master Doc §7 Backlog #7 / **これが gate の合否そのもの**（§6.1: 説得力ある動画/ストーリーボードが
明確に作れないなら Concept 段階に戻す）

---

## 0. 合否の自己判定を先に定義する

このストーリーボードが「作れている」と言えるのは、次の3拍が**実画面で**成立するときだけ。

| 拍 | 内容 | 依存する画面 |
|---|---|---|
| **1. 痛み** | 赤字ユーザーの % が、視聴者自身の想像できるダッシュボードに出る | margin 診断 / Overview |
| **2. 転換** | 実行の**前**に止まる瞬間。リクエストが飛び、モデルが走らず、理由と remedy が返る | authorize の実演 |
| **3. 証明** | 止めた事実と通した事実が、追記専用の台帳に検証可能な形で残っている | Register 画面 |

**判定基準**: 3拍のうち1つでもモックで誤魔化さないと成立しない場合、この動画は作れていない。
拍2は特に、**本物のレイテンシで**見せられなければ嘘になる（「実行前に」が主張の全部だから）。

**帰結**: 拍1は margin 診断ツール（`margin-diagnostic.md`）がそのまま画面になる。
拍2・3はデモ環境が必要 = **動画の完成は Phase 1 の最小実装後**。gate 時点ではこのストーリー
ボード + 拍1の実画面 + 拍2/3 の詳細コンテ で判定する。

---

## 1. フォーマット

- **長さ**: 75秒（X / LP 埋め込み兼用。90秒を超えたら削る）
- **語り**: EN ナレーション + EN 字幕（JA 字幕版を別途）。声は低く、速くしない
- **音**: 環境音レベルの最小限。効果音は「不渡り」の一箇所のみ
- **画**: 実 UI スクリーンキャスト + 割印モチーフのタイトルカードのみ。
  イラスト・3D・人物・株価風グラフは使わない（Master Doc §4.6/4.7）
- **色**: 極薄ウォームグレー地 + 印影の朱。UI はライトテーマで統一

---

## 2. シーン表

VO = ナレーション（EN 確定稿）。**形容詞を使わない。数字と動詞で運ぶ**（Master Doc §4.4）。

| # | 秒 | 画面 | VO | 演出メモ |
|---|---|---|---|---|
| 1 | 0–6 | 黒地に1行タイプ: `Your AI app has users who cost you money.` | *Some of your users cost more to serve than they pay you.* | 無音→タイプ音のみ。ロゴなし |
| 2 | 6–16 | margin 診断の実画面。CSV 2枚を drop → 数字が立ち上がる: **14% negative margin / 61% of model spend** | *Fourteen percent, for this app. They burn sixty-one percent of its model spend. Most founders find out at the end of the month, from the provider's invoice.* | 数字2つ以外は視線を置かせない。ドラッグ&ドロップは実速 |
| 3 | 16–24 | ターミナル分割画面。左: アプリのコード（authorize 呼び出し3行）。右: 空のログ | *Billing systems tell you what happened. The month is already over when they do.* | ここまでが「既存の世界」。まだ TEGATA の名は出さない |
| 4 | 24–38 | **拍2**。右ペインでリクエスト実行 → `decision: authorized / face_value: 47 / 12ms` が返り、モデルが走る。続けて残高の少ないユーザーで同じ操作 → `decision: dishonored / insufficient_balance / remedy: {...}` が返り、**モデルが走らない** | *This is an authorization. Forty-seven credits held, twelve milliseconds, then the model runs. Same request, empty balance — the model does not run. The user sees why, and what fixes it.* | **動画の心臓。** レイテンシ表示は実測値。効果音はここの dishonor 1回だけ（低く短い印を押す音） |
| 5 | 38–48 | アプリ側 UI: エンドユーザーに paywall が出て、top-up → 再実行 → 成功。その間ダッシュボードの残高とイベント（`balance.low` → `offer`）が動く | *The refusal is not an error. It is the moment your revenue happens — if something is standing there when it does.* | 「不渡り = 収益機会」を言葉でなく画で言う |
| 6 | 48–60 | **拍3**。Register 画面をスクロール: grant → issue → capture → dishonor が並ぶ。1行を開くとハッシュチェーンと `policy_ref`。エクスポート → 検証コマンドが `chain verifies` を返す | *Every hold, every settlement, every refusal — one append-only register. Export it, verify it yourself. You do not have to trust our arithmetic.* | 検証はターミナル実写。「監査可能性が購買理由」（Master §3.1）の30秒版 |
| 7 | 60–70 | 黒地に戻る。2行: `Billing systems tell you what happened.` / `TEGATA decides what's allowed to happen.` → 割印ロゴが2つの矩形にまたがって押される | *Billing systems tell you what happened. TEGATA decides what's allowed to happen.* | Positioning line（Master §4.5）をそのまま。ロゴはここが初出 |
| 8 | 70–75 | `TEGATA — the oldest payment instrument, rebuilt for machines.` / URL / `The spec is public.` | （無音） | 歴史への参照はこの1回だけ。それ以上語らない（Master §4.4） |

---

## 3. 検収基準

| # | 基準 |
|---|---|
| V-01 | シーン4のレイテンシ表示が実測値（合成でない）。撮影ログを残す |
| V-02 | シーン2の数字が診断ツールの実出力（サンプルデータで可、ただしツール自体は本物） |
| V-03 | シーン6の検証コマンドが `spec/examples/register.jsonl` と同一の検証ロジックで通る |
| V-04 | 全 VO に Don't リスト（revolutionary / seamless / effortless / magical …）の語が0回 |
| V-05 | 「AI」を主語にした文が0回（主語は your users / your agents / the model / the register） |
| V-06 | 75秒以内。超えたらシーン5から削る（3拍は削らない） |

## 3.1 撮影結果（2026-08-21 完了）

**`demo/out/tegata-launch.mp4` — 1分12秒、1280×720、1.4MB。** 全8シーン撮影済み。

| シーン | 素材 | 尺 | 実体 |
|---|---|---|---|
| 1 | カード | 4.1s | — |
| 2 | **診断ツールの実写** | 8.9s | 実 CSV を drop → ブラウザ内計算。**実出力は 16% / 63%**（表の 14%/61% は執筆時の仮値） |
| 3 | 分割ターミナル | 8.8s | — |
| 4 | **拍2** | 23.3s | 実サーバ。authorize 16.8ms / capture 10.4ms / dishonor 5.5ms |
| 5 | **デモアプリの実写** | 8.4s | 実サーバ。paywall は不渡りレスポンスから生成、トップアップ・再実行も実 API |
| 6+7+8 | **拍3** + カード | 19.4s | 実 `tegata-verify`。`chain verifies` → 1バイト改竄で `chain FAILED` |

### 検収結果

| # | 基準 | 結果 |
|---|---|---|
| V-01 | レイテンシが実測値 | ✅ 表示3値すべてが `demo/session.json` に存在することを機械検査 |
| V-02 | シーン2 が診断ツールの実出力 | ✅ `site/tool/` を実 CSV で駆動 |
| V-03 | 検証が `spec/examples/register.jsonl` と同一ロジック | ✅ `packages/verify` の CLI をそのまま実行 |
| V-04 | Don't リストの語が0回 | ✅ 0 hits |
| V-05 | 「AI」が主語の文が0回 | ✅ 主語は request / model / register |
| V-06 | 75秒以内 | ✅ 72.8s。超過分はシーン5と2から削り、**3拍は削っていない** |

### この動画が壊れない理由

素材は3種類しかない。**カードと分割ターミナルだけが台本で、残りは全部実物の記録である。**

- 拍2・拍3 → `demo/capture-session.mjs` が実サーバに対して実行し `session.json` に記録。
  プレイヤーはそれを再生するだけで、**記録にない値は表示できない**
- シーン2 → 実ツールを Playwright で駆動して画面収録
- シーン5 → 実サーバに話すデモアプリを画面収録
  （CORS のためブラウザからの呼び出しは録画側で実サーバへ転送している。
  **製品に CORS を足すことはしない** — MVP はサーバ間のみと決めているため。§1.2）

実装が変われば `capture-session.mjs` を回し直すだけで動画の内容も変わる。**乖離しようがない。**

## 4. 派生物

- **15秒版**（X 用）: シーン4のみ + positioning line。dishonor の瞬間だけで1本になる
- **静止コンテ版**（gate 判定用・今すぐ作れる）: シーン表の8コマを1枚画像に。LP とデッキに流用
- **Wallet 版**は gate 通過後。構成は同型（痛み: 帰属不明の支出 → 転換: counter_seal → 証明: 4つの監査質問に1画面）
