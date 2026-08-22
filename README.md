# TEGATA

**The oldest payment instrument, rebuilt for machines.**

TEGATA is infrastructure for promises to pay in the agent economy. Two product lines sit on one
shared ledger, policy engine, and audit format:

- **TEGATA Credits** — for services that *receive* payment. Credit entitlements, pre-execution
  authorization, variable-cost accounting, and retention intervention for AI products.
- **TEGATA Wallet** — for operators that *make* payment. Per-agent wallets and cards, spend
  policy, approval ladders, and rail-agnostic audit.

Billing systems tell you what happened. TEGATA decides what's allowed to happen.

---

## Status

**The specification is normative; the Credits implementation is a working MVP.** Wallet is
specified but deliberately unbuilt.

| Document | Contents |
|---|---|
| [`spec/authorization.md`](spec/authorization.md) | The issue / capture / release protocol |
| [`spec/policy.md`](spec/policy.md) | Spend policy schema, shared by Credits and Wallet |
| [`spec/register.md`](spec/register.md) | Append-only audit ledger format |
| [`spec/schema/`](spec/schema/) | JSON Schema for the above |
| [`spec/examples/`](spec/examples/) | Documents that validate against the schemas, including a register whose hash chain is a test vector |

| Package | Contents |
|---|---|
| [`packages/core`](packages/core) | Ledger rules, canonicalisation, pricing, policy evaluation. No I/O, no clock, no randomness |
| [`packages/store`](packages/store) | SQLite storage. The register is append-only because triggers refuse otherwise |
| [`packages/server`](packages/server) | The authorization service. [Quickstart](packages/server/README.md) |
| [`packages/sdk`](packages/sdk) | `issue` before, `capture` after, `release` on failure — and a declared posture for when we are unreachable |
| [`packages/verify`](packages/verify) | `tegata-verify`: check an exported register offline, without trusting the server that produced it |

The JSON schemas are read from `spec/schema` at runtime rather than restated in code, and every
register entry the server emits is validated against them before it leaves.

```bash
pnpm install && pnpm try        # the whole lifecycle, one shell, ~1s
pnpm verify                     # types, lint, determinism, spec, and the full test suite
```

`pnpm try` funds a subject, authorizes before the model runs, settles with what was actually
used, and then verifies the resulting register without trusting the server that produced it —
against a database it deletes afterwards. Every number it prints comes from that run.

[`templates/agent-spend-policy.md`](templates/agent-spend-policy.md) is a plain-language version of
the policy schema, meant to be filled in by a finance and platform team before an agent is given a
payment method. It is usable on its own, with no software behind it.

---

## Why a paper instrument

A *tegata* (手形) was a written promise to pay, used in Japanese commerce for centuries. It carried
a face value, a maturity date, a drawer, a payee, and a chain of endorsements transferring the
obligation onward. It was enforceable, transferable, and auditable — and it was paper, so it could
be lost, forged, or destroyed.

The paper is ending. The structure is not.

An x402 payment payload, an AP2 signed mandate, an ACP shared payment token — each is a scoped,
time-bounded, signed, transferable promise to pay. That is a tegata with the paper replaced by a
signature. We took the vocabulary along with the structure, because the vocabulary is more precise
than what the industry currently uses:

| Term | Field | Meaning |
|---|---|---|
| Face value | `face_value` | The authorized ceiling — not the amount finally settled |
| Maturity | `maturity` | When the authorization expires on its own |
| Dishonor | `dishonor` | Refusal to execute, with a stated reason |
| Endorsement | `endorsement_chain` | Re-delegation of authority from one holder to the next |
| Register | `register` | The append-only book in which all of it is recorded |

`endorsement_chain` is the one that matters most. Multi-agent delegation — an agent handing part of
its spending authority to a sub-agent, bounded and revocable — has no settled name in this
industry. It has had one for four hundred years.

---

## Design commitments

These hold across both product lines and constrain everything in `spec/`.

1. **Authorization is separate from execution.** TEGATA decides whether spending is permitted. It
   does not proxy inference, route model calls, or move funds. Enforcement happens outside the
   runtime, so it never depends on prompt compliance.
2. **The register is the only truth.** Every balance is reconstructible from the append-only log.
   Caches are derived and disposable. Corrections are appended, never overwritten.
3. **Cost and price are separate ledgers.** Provider cost is recorded in integer micro-USD. Retail
   credits are a separate unit. Margin is the difference, and it is only meaningful if the two are
   never conflated.
4. **Rail-agnostic.** No preference for a card network, a chain, or a protocol. Adapters are
   peripheral; the policy and audit layer is the product.
5. **Fail chosen, not fail silent.** Degraded behaviour is a declared setting, not an accident. The
   default keeps the customer's product running and reconciles afterwards.

---

## License

The specification, the ledger primitives, the policy engine, and the audit format are
[AGPL-3.0](LICENSE). Hosted enforcement, cost table maintenance, the intervention loop, and the
dashboards are commercial.

Money-handling code should be readable. The uptime is what you pay for.

---

## Comment

Open an issue. The schemas are not stable; nothing here is versioned as `1.0` yet, and field names
are still being argued over.
