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
- **Authority only narrows along an endorsement chain.** See `authorization.md` §6.
