# Specification

Normative documents. No implementation lives in this repository.

| File | Contents |
|---|---|
| [`authorization.md`](authorization.md) | Issue / capture / release, the state machine, dishonor reasons, endorsement, degraded operation, idempotency |
| [`policy.md`](policy.md) | Spend policy grammar: limits, scope, schedule, purpose, approval ladder |
| [`register.md`](register.md) | Append-only ledger format, entry kinds, invariants, hash chaining, export |
| [`schema/`](schema/) | JSON Schema (2020-12) for the objects above |
| [`examples/`](examples/) | Documents that validate against the schemas |

## Stability

Nothing here is stable. Field names are still being argued over, and no `1.0` has been cut.
Breaking changes will land without deprecation until a version is tagged.

## The parts most worth arguing about

- **Dishonor is not an HTTP error.** A refusal is a correct answer, and returning 402 makes generic
  clients retry it. See `authorization.md` §4.1.
- **Capture never fails.** The action already ran; refusing to record it only corrupts the ledger.
  See `authorization.md` §4.2.
- **Degraded behaviour is declared, not discovered.** See `authorization.md` §7.
- **Policies compose by intersection.** There is no override, because an override makes it
  impossible to say which rule is in force. See `policy.md` §3.1.
- **A reservation is not a balance movement.** Holds carry `delta_amount = 0`; the balance moves
  only when something settles. This is what keeps `available = balance − reserved` from
  double-counting. See `register.md` §3–4.
- **Authority only narrows along an endorsement chain.** See `authorization.md` §6.

## Test vector

[`examples/register.jsonl`](examples/register.jsonl) is not illustrative data: its hash chain is
computed under the exact definition in `register.md` §5 (SHA-256 over the RFC 8785 canonical form
of each entry with the `hash` field removed, `prev_hash` carried inside the entry). An
implementation of the verifier should accept it unchanged, and reject it if any byte of any entry
is altered.
