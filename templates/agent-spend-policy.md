# Agent Spend Policy — Template

A starting point for the document you need before an autonomous agent touches a payment method.

Copy it, fill in the blanks, and put it where your finance and platform teams can both see it.
It is written to be usable on its own, with no particular software behind it. The machine-readable
form of the same structure is at [`spec/policy.md`](../spec/policy.md).

---

## Why this document exists

An agent that can spend is a delegation of authority. Every other delegation of spending authority
in a company has paperwork behind it — a corporate card has a cardholder agreement, a purchase
order has an approver, an expense claim has a policy. Agents got the authority without the
paperwork, because they arrived faster than the process did.

The gap that causes trouble is rarely technical. It is that **nobody wrote down who is answerable
for what the agent spends.** This template makes that person explicit, first, before anything else.

A caution about how this is enforced: a spending limit written into a system prompt is a request,
not a control. It survives exactly as long as the agent behaves as expected. Anything in this
document that matters should be enforced outside the agent's runtime — at the card, at the payment
gateway, or at the tool boundary — where a misbehaving or compromised agent cannot route around it.

---

## 1. Agent register

One row per agent that can spend. An agent with no named drawer does not get a payment method.

| Agent | Drawer (accountable human) | What it does | Environment | Started |
|---|---|---|---|---|
| `agent:` | | | prod / staging | |
| `agent:` | | | | |

**Drawer** — the person answerable for this agent's spending, in the way a cardholder is answerable
for a card. Not a team, not a mailing list. One name.

---

## 2. Limits

Set these per agent. Rolling windows are safer than calendar months: a calendar reset gives a
compromised agent a predictable moment when its full allowance returns.

| Agent | Per transaction | Per day | Per month | Lifetime cap |
|---|---|---|---|---|
| | | | | |

Start lower than feels necessary. Raising a limit takes a minute. Explaining an unexpected charge
takes considerably longer.

---

## 3. What it may buy

List what is permitted, not what is forbidden. A deny list is only as good as your imagination; an
allow list fails safe.

| Agent | Permitted categories | Permitted vendors | Explicitly denied |
|---|---|---|---|
| | e.g. SaaS, data, compute | | |

**Denials are absolute.** If a vendor appears on both lists, it is denied.

---

## 4. Purpose codes

Every charge carries a purpose. This is the field that lets finance close the books without asking
an engineer what a line item was.

| Code | Meaning | Cost centre / account |
|---|---|---|
| `research` | | |
| `infra` | | |
| `ads` | | |
| `vendor-trial` | | |

Decide whether a purpose is **required** or optional per agent. Required is the right default once
you are past the observation stage.

---

## 5. Approval ladder

Escalation by amount. The top rung requires a human to agree before the money moves — two parties
sealing the same instrument, neither sufficient alone.

| Amount | Decision | Who |
|---|---|---|
| up to _____ | Proceed automatically | — |
| up to _____ | Proceed, and notify | |
| above _____ | **Hold for human approval** | |

Set a timeout on held requests — four hours is a reasonable default — after which the request
lapses rather than sitting open indefinitely.

Two failure modes to watch, in opposite directions:

- **Approval fatigue.** If a rung approves more than about 95% of what reaches it, it is not a
  control; it is a delay that people have learned to click through. Raise the threshold.
- **Blocking.** If agents wait synchronously for approval, engineering will route around the whole
  system. Held requests should suspend and resume, not block.

---

## 6. Time and place

| Agent | Permitted hours | Timezone | Notes |
|---|---|---|---|
| | | | |

Spending outside declared hours is worth refusing on its own — not because night-time purchases are
inherently wrong, but because an agent spending at 03:00 when it has never done so before is the
cheapest anomaly signal you will ever get.

---

## 7. Delegation

When an agent hands part of its authority to a sub-agent, the authority must narrow. Three rules,
and they are not negotiable:

1. The sub-agent's limit **must not exceed** the limit it was granted from.
2. The sub-agent's expiry **must not extend** beyond its parent's.
3. The sub-agent's permitted categories **must be a subset** of its parent's.

Revoking an agent revokes everything it delegated, all the way down. There is no partial revocation
that leaves a sub-agent alive — that is precisely the state an attacker wants.

| Parent | Sub-agent | Limit granted | Expires | Scope |
|---|---|---|---|---|
| | | | | |

---

## 8. Revocation

| Question | Your answer |
|---|---|
| Who can revoke an agent's spending authority? | |
| How long does revocation take to take effect? | |
| How is it done outside business hours? | |
| Who is notified? | |

Time this. An answer of "we'd have to ask someone" is the answer, and it is not a good one.

---

## 9. What happens when the control layer is unavailable

Whatever sits between your agents and their payment method will be unavailable at some point.
Decide now which way it fails, and write it down. Discovering it during an incident is expensive in
both directions — a system that fails open spends money nobody approved; one that fails closed
stops work nobody meant to stop.

| Agent or tier | If the check cannot be made | Reasoning |
|---|---|---|
| | Refuse / Allow up to _____ / Allow | |

For outbound payments, refusing is usually right: not spending is recoverable, and an unexplained
charge is not.

---

## 10. Audit

You should be able to answer these four questions about any charge, in one place, without asking an
engineer to run a query:

1. **Which agent** made it.
2. **Whose authority** it was made under — the drawer, and the delegation chain if there was one.
3. **What purpose** it served — the code, and the task it belonged to.
4. **How much**, on which rail, and whether the final amount differed from what was authorised.

| Question | Where you would find the answer today | Gap |
|---|---|---|
| Which agent | | |
| Whose authority | | |
| What purpose | | |
| How much | | |

The gaps column is the point of this section. Fill it in honestly; it is the list of what to fix.

---

## 11. Review

| Item | Frequency | Owner |
|---|---|---|
| Limits still appropriate | Monthly | |
| Agents still in use (retire the dormant ones) | Monthly | |
| Approval rates per rung | Quarterly | |
| Unattributed spend as a share of total | Monthly | |

**Unattributed spend is the number to drive down.** Money you cannot attribute to an agent, a
drawer, and a purpose is money you cannot govern, whatever the policy says.

---

*This template is published by Select KK alongside [TEGATA](https://github.com/Torutesu/tegataai) — an open
specification for authorising, bounding, and auditing what autonomous agents spend. Use it with or
without the software.*
