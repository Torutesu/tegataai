# @tegata/server

Reference implementation of the TEGATA Credits authorization service.

## Quickstart

```bash
pnpm install
pnpm bootstrap          # creates ./tegata.db, prints a secret key
export TEGATA_KEY=sk_live_...
pnpm dev                # listens on 127.0.0.1:8787
```

Then, in another shell:

```bash
A="Authorization: Bearer $TEGATA_KEY"; J="content-type: application/json"

# Give a user 1,000 credits.
curl -s -X POST localhost:8787/v1/subjects/user_1/grants \
  -H "$A" -H "$J" -H "idempotency-key: g1" -d '{"credits":1000}'

# Authorize before the model runs.
curl -s -X POST localhost:8787/v1/authorizations \
  -H "$A" -H "$J" -H "idempotency-key: a1" -d '{
    "subject_id": "user_1", "action": "chat.completion",
    "estimate": {"provider":"anthropic","model":"claude-opus-5",
                 "input_tokens":12400,"max_output_tokens":2000,"cached_input_tokens":8000}}'

# Settle with what was actually used.
curl -s -X POST localhost:8787/v1/authorizations/<id>/capture \
  -H "$A" -H "$J" -H "idempotency-key: c1" \
  -d '{"actual":{"input_tokens":12400,"output_tokens":1180,"cached_input_tokens":8000}}'

# Export the register and verify it without trusting this server.
curl -s localhost:8787/v1/register/export -H "$A" | pnpm tegata-verify
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TEGATA_DB` | `./tegata.db` | SQLite file |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/authorizations` | Issue. A refusal is 200 with `decision: "dishonored"`, not an error status |
| `POST` | `/v1/authorizations/:id/capture` | Settle. Succeeds past the face value; the action already ran |
| `POST` | `/v1/authorizations/:id/release` | Return an unused hold. Idempotent |
| `POST` | `/v1/usage` | Direct settlement, no hold, never refused |
| `GET` | `/v1/subjects/:id` | Balance, reserved, available, and the entitlement stack |
| `GET` | `/v1/subjects/:id/register` | That subject's entries as JSONL |
| `GET` | `/v1/register/export` | The whole tenant's register plus a manifest |
| `GET` | `/v1/metrics/margin` | Revenue, cost and margin per subject, in micro-USD |
| `PUT` | `/v1/actions/:action` | Register an action and how it is priced |
| `PUT` | `/v1/cost-table` | Publish a rate table version. Versions are append-only |
| `PUT` | `/v1/rules/:rule_id` | An intervention rule, with a holdout arm |
| `POST` | `/v1/webhooks/stripe` | Entitlement sync. Requires a `Tegata-Tenant` header |
| `POST` | `/v1/admin/sweep` | Expire matured holds and lapsed grants; purge idempotency keys |

Writes require an `Idempotency-Key`. Replaying a key returns the original response;
reusing it with a different body is a 409.

## What this implementation is not

Single node, single SQLite file, no clustering. It is the reference the spec is
checked against and the service a design partner can run, not a multi-region
deployment.

Measured on one node over sixty seconds per level (`docs/plan/perf/authorize.json`):
throughput sits near **1,750 authorizations per second** regardless of concurrency,
and **p99 stays under 50ms up to about 25 concurrent connections** (29ms there, 51ms
at 50, 87ms at 100). Because throughput is flat across those levels and close to the
raw storage ceiling, the latency beyond that point is requests queueing on the single
writer rather than any one of them costing more. Distributing the writer is the
answer, and it is deliberately out of scope here — see `docs/plan/credits-mvp.md`
§1.2 and §2.1.
