# tegataai

TEGATA AI（Select KK）の spec-first リポジトリ。**Gate 通過まで実装コードを置かない**
（`docs/00-master.md` §6 参照）。ここにあるのは正本・PRD・規範仕様・GTM 資産のみ。

## 構成と言語

- `docs/` — 内部ドキュメント。**日本語**。`00-master.md` が唯一の正本
- `spec/` / `templates/` / `README.md` — 公開前提。**英語**。RFC 2119 語彙で規範的に書く
- 派生ドキュメントの一覧と Backlog 進捗は `docs/00-master.md` §8

## 不変のルール

1. 金額・クレジットは常に**整数**（クレジット / μUSD / 通貨最小単位）。浮動小数を使わない
2. 台帳規約: 保留は `delta_amount = 0`。残高が動くのは約定のみ（`spec/register.md` §3–4）
3. `spec/examples/register.jsonl` は**検証可能なテストベクタ**。編集したら必ずハッシュチェーンを
   再計算する（JCS = sorted compact JSON、SHA-256、`hash` 列を除いた全体が対象）
4. スキーマや例を触ったら `jsonschema`（Draft 2020-12）で全例の検証を通すこと
5. 用語は Lexicon（`docs/00-master.md` §4.3）に従う: face_value / maturity / dishonor /
   endorsement_chain / counter_seal / register。新しい同義語を発明しない
6. 覆すと高くつく判断は `docs/decisions/README.md` に D-番号で追記する
7. ブランド NG（同 §4.6）: 競合名指し・和風エキゾチシズム・crypto 見せ・規制上の断定をしない

## 検証コマンド（コードはリポジトリに置かない。その場で実行）

```bash
pip install jsonschema  # 初回のみ
python3 - <<'PY'
import json, glob, hashlib
from jsonschema import Draft202012Validator as V
S={p:json.load(open(p)) for p in glob.glob('spec/schema/*.json')}
auth,pol,reg=V(S['spec/schema/authorization.schema.json']),V(S['spec/schema/policy.schema.json']),V(S['spec/schema/register-entry.schema.json'])
for p in glob.glob('spec/examples/*.json'):
    v = pol if 'policy' in p else auth
    for e in v.iter_errors(json.load(open(p))): raise SystemExit(f"{p}: {e.message}")
jcs=lambda o:json.dumps(o,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
prev="0"*64
for i,l in enumerate(open('spec/examples/register.jsonl'),1):
    e=json.loads(l)
    for er in reg.iter_errors(e): raise SystemExit(f"line {i}: {er.message}")
    h=e.pop('hash'); assert e['prev_hash']==prev and hashlib.sha256(jcs(e)).hexdigest()==h, f"chain broken at {i}"
    prev=h
print("all valid, chain verifies")
PY
```
