# デプロイ手順

2026-08-21 / 商標 OK 済み。**これが公開までの残り全部。**

構成: **LP は静的配信、API は別ドメイン。** フォームはクロスオリジンで API に POST する。

```
tegata.ai       →  静的（site/）        Cloudflare Pages 等
api.tegata.ai   →  Fastify（Docker）    どこでも可。永続ボリュームが要る
```

---

## 1. 先に確保する（名前の話）

商標は承認済み。以下は**取得と使用が別**なので、取れた順に押さえる。

| 資産 | 優先度 | 備考 |
|---|---|---|
| **npm scope `@tegata`** | **最優先** | SDK が `@tegata/sdk` を名乗る。ドメインは代替が効くが、公開後のパッケージ改名は利用者を壊す |
| `tegata.ai` | 高 | LP |
| `api.tegata.ai` | 高 | サブドメインなので上と同時 |
| GitHub org `tegata` | 中 | 現在は `Torutesu/tegataai` |
| X `@tegata` / `@tegata_ai` | 中 | |

---

## 2. 静的サイト

```bash
# ビルド不要。site/ をそのまま配信する
Build command:      (なし)
Build output:       site
```

`site/_headers` と `site/_redirects` は Cloudflare Pages がそのまま解釈する。
別のホストを使う場合は、**この2ファイルの内容を等価な設定に移すこと**（下記が要点）。

### ヘッダの要点

- **CSP が実際に効くことを検証済み**（`_headers` を適用した状態で全ページを読み込み、違反ゼロ）。
  インラインの style と script は**そのために全部外に出した**。`'unsafe-inline'` を足して通すのは、
  ポリシーを書いた意味を消すのと同じ
- `/tool/*` は **`connect-src 'none'`**。診断ツールの「送信しない」は、ページ上の主張ではなく
  **ヘッダで強制された事実**にしてある。ここを緩めると、あのツールの存在理由が消える
- `connect-src https://api.tegata.ai` — フォームの送信先。**API のドメインを変えるならここも変える**

### 配信側の必須事項

- `.js` を `text/javascript` で返すこと（`type="module"` は MIME が違うと**黙って読み込まれない**）
- `.mp4` に Range リクエスト対応（動画のシーク）

---

## 3. API

```bash
docker build -t tegata-api .
docker run -d --name tegata-api \
  -p 8787:8787 \
  -v tegata-data:/data \
  -e TEGATA_SITE_ORIGINS="https://tegata.ai" \
  -e TEGATA_TENANT_RPS=1000 \
  -e TEGATA_SUBJECT_RPS=20 \
  -e TEGATA_WAITLIST_RPM=5 \
  tegata-api
```

### 環境変数

| 変数 | 既定 | 注意 |
|---|---|---|
| `TEGATA_DB` | `/data/tegata.db` | **永続ボリューム必須。** register が記録そのものなので、失えば台帳を失う |
| `TEGATA_SITE_ORIGINS` | *(空)* | **公開前に必ず実ドメインを入れる。** 空だと同一オリジンのみ受け付け、フォームが黙って 403 |
| `TEGATA_TENANT_RPS` | 1000 | 超過は 429 |
| `TEGATA_SUBJECT_RPS` | 20 | 超過は**不渡り** `rate_limited` |
| `TEGATA_WAITLIST_RPM` | 5 | 呼び出し元あたり |

### 前段（CDN / LB）で必要なもの

アプリ内のレート制限は**認証後にしか効かない**。認証前の物量は前段で止める。

- TLS 終端
- IP 単位のレート制限（`/v1/waitlist` は特に）
- `X-Forwarded-For` を渡すこと（waitlist の制限がこれを見る）
- リクエストボディ上限 1MB（アプリ側にも同じ制限がある）

### イメージに入っているもの / 入っていないもの

本番イメージは **`pnpm install --prod`** の結果だけを載せる。
vitest / vite / esbuild / autocannon / playwright は入っていない。**動かさないから安全**ではなく、
**入っていないものは悪用できない**という理由による（これらは常に何らかの advisory を持つ）。
CI の `pnpm audit --prod` は、実際に出荷する依存に脆弱性が出たときだけ落ちる。

実行時に pnpm も corepack も使わない — `node --import tsx …` の**単一プロセス**である。
シグナルがそのままサーバに届くので、`docker stop` がデータベースを閉じる終了処理を実行する。

**root で走らない**（`USER node`）。`/data` は起動前に所有権を渡してある。
`HEALTHCHECK` つき。

### イメージは CI でビルドし、起動まで確認している

`.github/workflows/verify.yml` の `image` ジョブが、push ごとに
**ビルド → 起動 → bootstrap → 認証つきの読み取り → 再起動後も同じ鍵で読める**
ところまで通す。`better-sqlite3` はインストール時にコンパイルするので、
「手元では通るが slim イメージで落ちる」典型であり、ビルドしていないイメージは
本番用の成果物として数えない。再起動の確認は台帳が**キャッシュではない**ことの確認でもある。

`packageManager` を `package.json` に固定してある（pnpm 10.33.0）。
corepack が別バージョンを引くと lockfile の解釈が変わり得るため。

### 初回セットアップ

```bash
docker exec -it tegata-api node --import tsx packages/server/src/cli.ts bootstrap
```

**secret key は一度しか表示されない**（ハッシュしか保存していない）。その場で保管する。

---

## 4. 診断ツールは別リポジトリに出す

`tools/margin-diagnostic/` を独立リポジトリへ。**「何も送信しない」の根拠はソースが読めることなので、
公開しないなら主張を取り下げるべき。**

```bash
# 単一ファイル。ビルドもテストもない
margin-diagnostic/
  index.html
  README.md          ← tools/margin-diagnostic/README.md をそのまま
  LICENSE            ← AGPL-3.0
```

`site/tool/index.html` はそのコピー。**両方を同時に更新すること**（現在は手動。
乖離すると、公開ソースと実際に配信されているものが違うという最悪の形になる）。

---

## 4.5 公開した直後に必ず走らせる

```bash
pnpm check:deployed https://tegata.ai https://api.tegata.ai --key sk_live_…
```

**リポジトリ上は正しく、ホスト上で間違っていられるもの**だけを見る。
ホストが `_headers` を適用しなかった / `.js` の content-type が違う /
CSP が実際とは別の API を指している / `TEGATA_SITE_ORIGINS` が違う、など。

送信テストはハニーポットを埋めて出すので、**ウェイトリストに行は残らない**
（サーバの応答は人が出したときと一字一句同じ）。`--key` を省くとテナント鍵が要る項目は
「合格」ではなく**スキップと表示**される。

検出できることは、故意に壊して確認済み:

| 壊したもの | 出る失敗 |
|---|---|
| `.js` を `application/octet-stream` で配信 | `and as a script, so type="module" loads it` |
| `TEGATA_SITE_ORIGINS` が実ドメインでない | `it accepts a submission from …  — 403` |
| ホストが `_headers` を適用していない | CSP / HSTS / nosniff / X-Frame-Options が7件 |

---

## 5. 公開前チェックリスト

**名前**
- [ ] npm scope `@tegata` 確保
- [ ] `tegata.ai` / `api.tegata.ai` DNS

**静的サイト**
- [ ] `site/` をデプロイ、`_headers` / `_redirects` が効いていること
- [x] ~~CSP 検証~~ → `pnpm verify:csp` が CI で回る。
      `_headers` を実際に適用した状態で全ページを読み込み、違反があれば fail する
- [x] ~~フォームが実際に届くか~~ → `pnpm verify:e2e` が CI で回る。
      実サーバ・実 `_headers`・実ブラウザでボタンを押し、行が入るところまで確認する。
      **スクリプトを無効にした経路も含む**（これは実装が壊れていることを実際に見つけた）
- [ ] `/tool/` が `connect-src 'none'` で、ネットワークタブが空であること（前者は `check:deployed` が見る）
- [ ] `.js` が `text/javascript` で返ること（`pnpm verify:e2e` が同じ失敗をローカルで再現する。
      本番では、送信して**遷移せずに**確認文が出れば module として読み込まれている）
- [ ] OGP が X / Slack で展開されること（タグと画像の到達性は `check:deployed` が見る。
      実際の展開は各サービスのキャッシュ次第なので目視）
- [ ] Lighthouse 全4ページ 100（現状の実測値）

**API**
- [ ] `TEGATA_SITE_ORIGINS` が実ドメイン
- [ ] `/data` が永続ボリューム
- [ ] bootstrap を実行、secret key 保管（上のコマンド。コンテナ内に pnpm は要らない）
- [ ] `POST /v1/waitlist` を**本番の LP から**実際に送信して 202 が返ること
      （`TEGATA_SITE_ORIGINS` が違っていると、ブラウザには「接続できませんでした」としか出ない）
- [ ] `GET /v1/waitlist/count` がテナント鍵で引けること
- [ ] Stripe webhook を使うなら、**テナントに webhook secret を設定**すること
      （未設定なら 401 になるので事故にはならないが、連携が黙って動かない）

**取り下げ忘れ** — `pnpm verify:site` が機械的に検出する（CI に入っている）

検出できることを、実際に壊して確認済み:

| わざと入れた間違い | 検出 |
|---|---|
| ローカルのアドレスがページに残っている | ✅ |
| インライン style / script（CSP が拒否する） | ✅ |
| フォームの `action` がプレースホルダ | ✅ |
| `connect-src` がフォームの送信先を許可していない | ✅ |
| `form-action` が同上 | ✅ |
| `/tool/` の `connect-src 'none'` が外れている | ✅ |
| 配信中のツールが公開ソースと乖離 | ✅ |

---

## 6. 公開しないもの

| | 理由 |
|---|---|
| `docs/` | 内部資料。市場調査・対象企業リスト・価格の前提を含む |
| `demo/` | 動画の素材。`session.json` は実データではないが、内部の作り方が露出する |
| `wl.db` / `tegata.db` | データ。`.gitignore` 済み |

`spec/` `packages/` `templates/` `brand/` `README.md` `LICENSE` は公開前提。
