# TEGATA Policy Schema

Draft · 2026-08-21 · unstable

RFC 2119 keywords apply.

---

## 1. Purpose

A spend policy declares what an agent, or an account, is permitted to spend — how much, on what,
within what period, and above what threshold a human must agree. It is evaluated *outside* the
runtime that spends. A policy expressed as an instruction to a model is a request; a policy
enforced at the authorization boundary is a control.

One schema serves both directions of the product: an account consuming credits inside an AI
product, and an agent paying external merchants. The evaluated subject differs; the grammar does
not.

---

## 2. Document shape

```jsonc
{
  "policy_id": "eng-research-agents",
  "version": 3,
  "applies_to": { "subject": "agent:researcher-*" },
  "limits": {
    "per_action": { "max": 500 },
    "per_period": { "window": "P1D", "max": 20000 },
    "aggregate":  { "max": 200000 }
  },
  "scope": {
    "actions":   { "allow": ["search.query", "http.fetch", "chat.completion"] },
    "providers": { "deny": ["*"] , "allow": ["anthropic", "openai"] },
    "merchants": { "allow_categories": ["saas", "data"], "deny": ["*.gambling"] }
  },
  "schedule": { "allow": [{ "days": "MON-FRI", "from": "08:00", "to": "20:00", "tz": "Asia/Tokyo" }] },
  "purpose":  { "require": true, "allowed": ["research", "eval"] },
  "ladder": [
    { "up_to": 1000,  "decision": "auto" },
    { "up_to": 10000, "decision": "notify", "notify": ["team:platform"] },
    { "decision": "counter_seal", "approvers": ["role:finance"], "quorum": 1 }
  ],
  "degraded": "allow",
  "overdraft": { "max": 200 }
}
```

All monetary fields are integers. In a credits context they are credits; in a payments context they
are minor currency units, with `currency` declared alongside. Implementations MUST NOT use
floating-point for any of them.

---

## 3. Fields

### 3.1 `applies_to`

Selects the subjects governed by the policy. Matching MAY use glob patterns on the subject
identifier, and MAY match on labels. When several policies match one subject, **all** of them apply
and the most restrictive outcome wins. Policies compose by intersection; there is no override.

### 3.2 `limits`

| Field | Meaning |
|---|---|
| `per_action.max` | Ceiling on a single authorization's face value |
| `per_period` | Ceiling on the sum settled within a rolling window, expressed as an ISO 8601 duration (days, hours, and minutes — `P1D`, `PT6H`; smaller units are not supported) |
| `aggregate.max` | Lifetime ceiling for the subject under this policy |

Periodic windows are rolling, not calendar-aligned, unless `align: "calendar"` is set. Rolling is
the default because calendar alignment creates a predictable moment at which a compromised agent
regains its full allowance.

### 3.3 `scope`

Restricts *what* may be paid for.

- `actions` — action catalog keys.
- `providers` — inference or API providers.
- `merchants` — for outbound payments: identifiers, categories, or patterns.

Each accepts `allow` and `deny` lists. `deny` MUST be evaluated first and is absolute. An empty
`allow` list means nothing is allowed, not everything.

### 3.4 `schedule`

Time windows during which spending is permitted, with an explicit IANA timezone. Outside the
declared windows, authorization is dishonored with `policy_denied`.

### 3.5 `purpose`

When `require` is true, an authorization MUST carry a purpose code drawn from `allowed`. This is
the field that makes agent spending legible to a finance function: it is the accounting code, the
task reference, and the audit justification in one place.

### 3.6 `ladder`

An ordered escalation. Each rung declares a ceiling and the decision that applies at or below it;
the final rung MUST omit `up_to` and acts as the catch-all.

| Decision | Meaning |
|---|---|
| `auto` | Authorize without human involvement |
| `notify` | Authorize, and inform the named parties |
| `counter_seal` | Hold pending explicit human agreement before authorizing |
| `deny` | Refuse |

`counter_seal` takes its name from the practice of validating an instrument by two parties sealing
across the same document: neither seal is sufficient alone. A counter-sealed authorization records
both the requesting agent and the approving human, and both appear in the register.

A `counter_seal` rung MUST declare `approvers` and MAY declare a `quorum` (default 1) and a
`timeout` after which the pending authorization expires unapproved.

### 3.7 `degraded`

`allow` | `allow_cheap_only` | `deny`. See `spec/authorization.md` §7. A policy that omits this
inherits the tenant default.

### 3.8 `overdraft`

The amount by which settlement may exceed the available balance, which arises legitimately when a
completed action costs more than its reserved face value. Settlement is never refused; this bounds
how far it may go before the subject is suspended.

---

## 4. Evaluation

Evaluation is a pure function of `(policy set, subject state, authorization request)` and MUST NOT
depend on wall-clock ordering across subjects, network calls to third parties, or model output.

Order:

1. Subject status. A suspended subject is refused.
2. `scope` denials.
3. `scope` allowances.
4. `schedule`.
5. `purpose`.
6. `limits`, most specific first: `per_action`, then `per_period`, then `aggregate`.
7. `ladder`, to determine the decision for a request that has passed everything above.

The first refusal wins and MUST be reported with the specific rule that produced it. A policy
engine that reports only "denied" cannot be operated: the holder needs to know which limit to
raise.

---

## 5. Versioning

`version` increments on every change. An evaluation MUST record the policy id and version that
produced its outcome, and implementations MUST retain superseded versions for as long as they
retain the register entries that reference them. A past decision that cannot be re-derived from the
policy in force at the time is not auditable.
