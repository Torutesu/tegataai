# TEGATA Authorization Protocol

Draft · 2026-08-21 · unstable

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in
RFC 2119.

---

## 1. Purpose

An autonomous action whose cost is not known until after it runs cannot be metered safely after the
fact, and cannot be priced exactly before it. This protocol resolves that with two phases:

1. **Issue** — reserve a ceiling (`face_value`) before the action runs.
2. **Capture** — settle the actual amount once it is known, releasing the remainder.

A third terminal outcome, **dishonor**, refuses the action before it runs and states why.

This is the structure of a bill of exchange, and the same structure as card authorization and
capture. It applies to a language model call, an API purchase, or a card payment without change.

---

## 2. Object model

### 2.1 Authorization

| Field | Type | Required | Description |
|---|---|---|---|
| `authorization_id` | string (ULID) | yes | Server-assigned |
| `subject_id` | string | yes | The account whose balance is affected. Opaque to TEGATA |
| `action` | string | yes | Key into the action catalog, e.g. `chat.completion` |
| `face_value` | integer | yes | Reserved ceiling, in credits. MUST be non-negative |
| `state` | enum | yes | §3 |
| `maturity` | timestamp | yes | RFC 3339. After this, the reservation is released |
| `captured_amount` | integer | no | Present once `state = captured` |
| `cost_micro_usd` | integer | no | Provider cost of the settled action |
| `dishonor_reason` | enum | no | Present only when `state = dishonored`. §5 |
| `endorsement_chain` | array | no | §6. Empty or absent in single-holder use |
| `provisional` | boolean | no | Issued while the authority was degraded. §7 |
| `context` | object | no | Caller-supplied metadata. MUST NOT contain personal data |

`face_value` is denominated in credits, an integer unit whose retail peg is set per tenant. Costs
are denominated separately, in integer micro-USD (10^-6 USD). Implementations MUST NOT represent
either as a floating-point number.

### 2.2 Estimate

An estimate supplies what is known before execution, so the authority can compute `face_value`.

```jsonc
{
  "provider": "anthropic",
  "model": "claude-opus-5",
  "input_tokens": 12400,
  "max_output_tokens": 2000,
  "cached_input_tokens": 8000
}
```

If the authority cannot price the estimate — an unknown model, a missing rate — it MUST fall back
to the action's declared default ceiling rather than refuse, and SHOULD emit a signal that the rate
table is incomplete.

---

## 3. State machine

```
   request ──┬─► issued ──────► captured ──► (adjusted)
             │      │  │
             │      │  ├──────► released
             │      │  └──────► expired
             │      │
             ├──────┴─────────► dishonored
             │
             └─► pending_seal ─┬─► issued        (approved: quorum reached)
                               ├─► dishonored    (rejected by an approver)
                               └─► expired       (approval timeout)
```

- `pending_seal` occurs only when a policy ladder resolves to `counter_seal` (see
  `spec/policy.md` §3.6): the request is held for human agreement before any reservation takes
  effect. The issue call MUST return immediately with this state rather than blocking; the caller
  learns the outcome asynchronously. While pending, nothing is reserved and nothing may be
  captured. Approval and rejection are themselves recorded in the register as `event` entries, so
  that both seals — the requesting agent's and the approving human's — appear against the same
  authorization.
- `dishonored` is assigned before execution only, at issue time or on rejection of a held request. An authorization that was issued cannot later be
  dishonored; the action has already been permitted.
- `captured` is terminal for the reservation. Later corrections MUST be appended as separate
  adjustment entries in the register, not by mutating the authorization.
- `expired` releases the reservation when `maturity` passes with no capture. It does not assert
  that the action did or did not run.
- A capture attempted after `maturity` MUST be refused with `authorization_matured`, and the caller
  SHOULD record the usage as an adjustment instead.

---

## 4. Operations

### 4.1 Issue

```
POST /v1/authorizations
Idempotency-Key: <opaque, required>
```

The request carries `subject_id`, `action`, an optional `estimate`, an optional
`maturity_seconds`, and optional `context`.

`maturity_seconds` defaults to 300 and MUST NOT exceed 3600.

A successful issue returns the authorization with `state = issued`.

A dishonor returns HTTP 200 with a decision body, **not** an HTTP error status:

```jsonc
{
  "decision": "dishonored",
  "reason": "insufficient_balance",
  "available": 12,
  "required": 47,
  "remedy": {
    "topup_url": "https://...",
    "fallback_action": "chat.completion.mini",
    "fallback_face_value": 9
  }
}
```

Dishonor is a business outcome, not a transport failure. Returning 402 causes generic HTTP clients
to treat a correct answer as an exception and retry it. Implementations MUST also set a
`Tegata-Decision` header so that proxies and logs can distinguish the two outcomes without parsing
the body.

`remedy` is advisory. The authority proposes a cheaper alternative; the caller decides whether to
take it. An authorization service MUST NOT select the model or route the request itself.

### 4.2 Capture

```
POST /v1/authorizations/{id}/capture
Idempotency-Key: <opaque, required>
```

The body carries either measured usage, or a settled amount directly:

```jsonc
{ "actual": { "input_tokens": 12400, "output_tokens": 1180, "cached_input_tokens": 8000 } }
```
```jsonc
{ "amount": 31, "cost_micro_usd": 620000 }
```

Capture MUST succeed even when the settled amount exceeds `face_value`. The action has already run;
refusing to record it produces an inaccurate ledger, which is worse than an overdraft. The excess is
debited, bounded by the subject's declared overdraft allowance, and an overdraft signal is emitted.

When the settled amount is below `face_value`, the difference MUST be released automatically.

### 4.3 Release

```
POST /v1/authorizations/{id}/release
```

Releases the reservation when the action did not run. Idempotent.

### 4.4 Direct settlement

```
POST /v1/usage
```

For actions whose cost is known in advance and small enough that a reservation is not worth a round
trip. It settles immediately and does not gate execution.

---

## 5. Dishonor reasons

| Reason | Meaning |
|---|---|
| `insufficient_balance` | Balance below the required face value |
| `entitlement_expired` | No entitlement is currently in effect |
| `policy_denied` | A policy rule refused the action. See `spec/policy.md` |
| `budget_exhausted_period` | A periodic budget ceiling was reached |
| `rate_limited` | Request rate exceeded |
| `subject_suspended` | The subject is not permitted to transact |
| `action_unknown` | The action is not registered |
| `service_degraded` | The authority could not decide and the configured posture is to refuse |

A reason MUST be accompanied by a `remedy` object whenever a remedy exists. `policy_denied`,
`subject_suspended`, and `action_unknown` have no remedy and MUST NOT invent one.

---

## 6. Endorsement

`endorsement_chain` records re-delegation: a holder of authority granting a bounded, revocable
subset of it to another party. It is an ordered array, oldest first.

```jsonc
{
  "endorsement_chain": [
    {
      "endorser": "agent:orchestrator-7",
      "endorsee": "agent:researcher-2",
      "face_value": 500,
      "maturity": "2026-08-21T06:00:00Z",
      "scope": ["search.query", "http.fetch"],
      "signature": "..."
    }
  ]
}
```

Rules:

- Each endorsement MUST NOT grant a `face_value` greater than the one it received.
- Each endorsement MUST NOT extend `maturity` beyond the one it received.
- Each endorsement's `scope` MUST be a subset of the scope it received.
- Revoking an endorsement MUST revoke everything endorsed downstream of it.

These constraints are what make a delegation chain auditable: authority only ever narrows as it is
passed along.

TEGATA Credits does not populate this field in its first version; the field is specified now so
that ledgers written today remain readable when it is.

---

## 7. Degraded operation

An authorization service sits in the critical path of its customers' products. Its failure
behaviour is therefore part of its contract, and MUST be declared rather than discovered.

| Posture | Behaviour when the authority cannot decide |
|---|---|
| `allow` | Issue with `provisional = true`, bounded by the overdraft allowance |
| `allow_cheap_only` | Issue only for actions that declare a cheaper fallback |
| `deny` | Dishonor with `service_degraded` |

`allow` SHOULD be the default. Halting a customer's product to avoid a small accounting error is a
poor trade for a layer whose value is trust.

On recovery, every provisional authorization MUST be re-evaluated against the register, with any
shortfall appended as an adjustment, and the outcome reported to the tenant.

---

## 8. Idempotency

`issue`, `capture`, `release`, and direct settlement MUST accept an idempotency key and retain it
for at least 24 hours.

- Replaying a key MUST return the original response verbatim, without recomputation.
- Reusing a key with a different request body MUST fail with `idempotency_key_reuse`.

Concurrent replays of the same key MUST result in exactly one ledger effect.

---

## 9. Consistency

- Operations on a single `subject_id` MUST be serializable with respect to one another.
- A read of a subject's balance MUST reflect that subject's own prior writes.
- Propagation to the register MAY be asynchronous, but the register MUST converge to the same
  balance. Where a cache and the register disagree, the register wins.

No ordering guarantee is made across different subjects. Cross-subject aggregation MUST NOT appear
in the issue path.
