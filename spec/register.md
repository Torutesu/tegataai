# TEGATA Register Format

Draft · 2026-08-21 · unstable

RFC 2119 keywords apply.

---

## 1. Purpose

The register is the append-only book of record. Every balance, every margin figure, and every audit
answer is derived from it. Nothing else in a TEGATA implementation is authoritative.

A ledger that can be edited is a report, not a record. The format below is designed so that a third
party holding an export can independently recompute every balance and detect any alteration,
without access to the system that produced it.

---

## 2. Entry

```jsonc
{
  "seq": 10482,
  "subject_id": "user_8f21",
  "at": "2026-08-21T04:00:03.412Z",
  "kind": "capture",
  "delta_amount": -31,
  "delta_cost_micro_usd": 620000,
  "authorization_id": "01JXXXXXXXXXXXXXXXXXXXXXXX",
  "entitlement_id": "01JZZZZZZZZZZZZZZZZZZZZZZZ",
  "policy_ref": { "policy_id": "eng-research-agents", "version": 3 },
  "meta": { "action": "chat.completion", "model": "claude-opus-5", "provisional": false },
  "prev_hash": "b2f1...",
  "hash": "9ac4..."
}
```

| Field | Rules |
|---|---|
| `seq` | Strictly increasing within a subject. Gaps MUST NOT occur |
| `at` | RFC 3339, UTC, millisecond precision |
| `kind` | §3 |
| `delta_amount` | Signed integer, in the subject's unit. Credits, or minor currency units |
| `delta_cost_micro_usd` | Signed integer provider cost. Zero where not applicable |
| `policy_ref` | The policy version that authorized this entry, where one applied |
| `meta` | Free-form. MUST NOT contain personal data |

Two ledgers run side by side in one entry: `delta_amount` is what the account was charged, and
`delta_cost_micro_usd` is what it cost to serve. Margin is the difference between them, and it is
only computable because they were never merged into one number.

---

## 3. Entry kinds

| Kind | Effect |
|---|---|
| `grant` | Credits or funds made available |
| `issue` | Reservation of a face value |
| `capture` | Settlement of a reserved authorization |
| `release` | Return of an unused reservation |
| `expire` | Return of a reservation at maturity, or lapse of an entitlement |
| `dishonor` | A refused authorization. `delta_amount` is 0 |
| `adjust` | A correction, referencing the entry it corrects in `meta.corrects` |

`dishonor` entries carry no balance effect but MUST be recorded. The moment a request was refused,
and why, is the most informative event the system observes — for the account holder, for the
auditor, and for understanding why customers leave.

There is no `delete` and no `update`. Corrections are appended as `adjust`.

---

## 4. Invariants

For any subject, at any point:

```
balance = Σ delta_amount over all entries with seq ≤ n
```

An implementation MUST be able to reconstruct a subject's balance from its register alone. Any
cached balance that disagrees with this sum is wrong by definition and MUST be reconciled toward the
register.

Reserved-but-unsettled funds are the sum of `issue` entries whose authorizations have not yet
reached a terminal state. Available balance is `balance` minus that sum.

---

## 5. Integrity

Each entry is chained to its predecessor within the subject:

```
hash = SHA-256( prev_hash ‖ canonical_json(entry without hash) )
```

Canonicalization follows RFC 8785 (JCS). The first entry for a subject uses 32 zero bytes as
`prev_hash`.

Implementations SHOULD periodically sign a root over all subject chain heads — daily is sufficient
for most purposes — and retain those signatures alongside the register. A verifier holding an export
and the signed roots can then detect insertion, deletion, or modification of any entry without
trusting the exporting system.

---

## 6. Export

Exports are JSON Lines, one entry per line, ordered by `subject_id` then `seq`, with a trailing
manifest line:

```jsonc
{ "manifest": true, "subjects": 1204, "entries": 3391884, "range": ["2026-01-01", "2026-08-21"], "roots": [...] }
```

An export MUST be verifiable offline. This is the reason the format is specified publicly rather
than treated as an internal detail: a customer whose spending authority runs through a third party
should be able to check that third party's arithmetic without asking its permission.
