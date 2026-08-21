# アウトリーチ設計

Select KK / 2026-08-21 / v0.1
対象リスト: `docs/gtm/icp-target-list.md` / 質問設計: `docs/gtm/icp-interviews.md`

> **前提**: 本書は内部ドキュメント。Master Doc §4.6-1「競合を名指ししない」は**公開コピー**の規則であり、
> 内部のターゲット選定・比較検討には適用しない。ただし対外文面に競合名を書かないことは本書でも守る。

---

## 0. 原則

1. **売らない。** 最初の接触の目的は面談の獲得ではなく、**相手が話したいと思うこと**。
   プロダクトを説明した時点で、相手は「売り込み」のモードに切り替わり、以後の回答が汚染される
   （`icp-interviews.md` §1-2）
2. **非対称な価値を先に置く。** こちらが差し出すものが先、依頼が後。
   Product A は診断ツール、Product B はポリシーテンプレ。どちらも相手が単独で使える完成品
3. **短い。** 初回接触は **120語以内 / 日本語なら250字以内**。スクロールが必要な時点で読まれない
4. **1通で完結させない。** 返信がない = 拒否ではない。§4 のフォローを機械的に回す
5. **嘘をつかない。** 「〇〇さんの記事を読んで」と書くなら、実際に読んで具体を1つ引く。
   一般化した褒め言葉は自動生成に見え、それは事実として自動生成と区別できない

---

## 1. 経路の優先順位

強い順。**弱い経路から始めない**（弱い経路で母集団を消費すると、強い経路の学習が遅れる）。

| 順 | 経路 | 適用 | 想定返信率 |
|---|---|---|---|
| 1 | **紹介** | 面談した相手からの紹介（`icp-interviews.md` §2.2 質問16 / §3.2 質問15） | 高 |
| 2 | **公開の問題提起への応答** | 相手が X / HN / Reddit / GitHub issue で当該の困りごとを書いている | 高 |
| 3 | **成果物の配布経由** | 診断ツール結果画面 / テンプレ DL からの自発予約 | 高（母数は小） |
| 4 | **OSS / コミュニティ接点** | 既存 billing OSS の issue 投稿者、関連 Discord | 中 |
| 5 | **公開登壇・記事の著者** | 当該テーマで公に話している人 | 中 |
| 6 | **コールドメール** | 上記が尽きた場合のみ | 低 |

**Product B は経路2と5が主戦場**になる。エージェント支出の事故や恐怖を公に書いている人は、
すでにその問題を言語化できている＝ヒアリングの質が最も高い。

---

## 2. 文面（Product A）

### 2.1 コールド（EN・120語以内）

> Subject: what % of your users are negative-margin
>
> Hi {name} — you mentioned {specific thing they said, with where}. I built a small thing for
> exactly that question.
>
> It's one HTML file. Drop in a Stripe export and a provider usage export, and it tells you what
> share of your users cost more than they pay, and what share of your model spend those users
> consume. Nothing uploads — there's no server. You can check the network tab.
>
> {link}
>
> No signup, nothing to buy. I'm researching how AI apps handle this and would take 30 minutes of
> your time if the number surprises you — but the tool is yours either way.
>
> — {sender}

**構造**: 具体の引用 → 完成品 → 送信しない旨（最大の障壁の先回り）→ 対価なしの明示 → 依頼は最後。

### 2.2 公開の問題提起への応答（経路2）

相手のスレッドに**公開で**返す。DM から始めない。

> This is the part existing billing doesn't cover — it tells you after the month closed.
> I made a browser-only tool that computes negative-margin users from a Stripe export +
> a usage export, no upload: {link}. Curious what your number comes out as.

**返信が来てから** DM で30分を打診する。

### 2.3 紹介依頼（面談の最後・経路1）

> Who else is fighting this? I'd rather talk to someone you'd actually vouch for than
> cold-email twenty people.

---

## 3. 文面（Product B）

### 3.1 コールド（EN・120語以内）

> Subject: the doc you need before an agent gets a card
>
> Hi {name} — {specific evidence: their talk / post / job posting}.
>
> I wrote a template for the thing that's usually missing: who is accountable for what an agent
> spends, what it may buy, and what happens when the control layer is down. It's a fill-in
> document, usable with no software behind it.
>
> {link}
>
> I'm researching how teams actually govern agent spend before building anything. If you've had an
> incident — or you're deliberately not letting agents pay for things yet — I'd value 30 minutes.
> The template is yours regardless.
>
> — {sender}

**「事故があったか」と「わざと止めているか」を並べて聞く**のが要点。後者のほうが多いはずで、
それも gate の合格条件に計上される（`icp-interviews.md` §0）。恥ずかしくない聞き方にしておく。

### 3.2 JA 版（国内向け・250字以内）

> 件名: エージェントに会社のカードを渡す前のドキュメント
>
> {name}さん、{具体の引用}を拝見しました。
>
> 「そのエージェントの支出に誰が責任を持つか」を書き出すためのテンプレートを作りました。
> 記入式で、ソフトウェアなしで使えます。{link}
>
> エージェントの支出統制について調べています。事故があった、あるいは怖いので自律的な支払いを
> **あえて止めている**——どちらでも30分いただけると助かります。テンプレートは無条件でお使いください。

---

## 4. フォロー

| 回 | タイミング | 内容 |
|---|---|---|
| 1 | 初回 | §2 / §3 |
| 2 | +5営業日 | **新しい情報を1つ足す**。同じ依頼を繰り返さない（例: 他社の匿名化した所見1つ） |
| 3 | +12営業日 | 1行で終了通知。「クローズします。ツールはそのまま使えます」 |

3回で打ち切る。4回目以降の反応率は運用コストに見合わない。

---

## 5. 送ってはいけないもの

- カレンダーリンクを初回に貼る（依頼が先、価値が後になる）
- 「15分だけ」（時間の短さを売りにすると、相手は雑談として扱う。30分と言い切る）
- プロダクトのスクリーンショット・デッキ・機能一覧
- 競合名（内部で比較するのは可、対外文面に書くのは不可）
- 相手の会社について検証していない推測（「御社は月間◯◯万リクエストと拝察し」等）
- 自動生成に見える褒め言葉

---

## 6. 計測

| 指標 | 目的 |
|---|---|
| 経路別の返信率 | どの経路を伸ばすか。経路6が唯一の経路になっていたら選定基準が間違っている |
| 返信率ではなく**面談実施率** | 返信しても実施に至らないなら文面ではなく依頼内容の問題 |
| ICP 外判明率 | 高いなら `icp-target-list.md` の選定基準を締める。**Product B ではこれ自体が市場の早さの証拠**になる |
| 成果物 DL → 自発予約率 | wedge の温度。`margin-diagnostic.md` §6.1 と同じ数字 |
