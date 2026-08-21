# Margin Diagnostic

One HTML file. Two exports in — Stripe billing, provider usage — two numbers out: what share of
your users are negative-margin, and what share of your model spend they consume.

## The claim, and how to check it

**Nothing leaves the page.** There is no server, no analytics, no external font, no request of any
kind. Three ways to verify, in increasing order of paranoia:

1. Open the network tab, run the tool. Zero requests.
2. Disconnect from the network entirely. Everything still works.
3. Read the source. It is one file, dependency-free, and short.

## Use

Open `index.html` in a browser. Drop in a Stripe payments/invoices CSV and a provider usage CSV.
Columns are auto-detected and can be corrected by hand. If your usage export has no per-user key
that matches a `cus_…` id, add a two-column key map — or let the tool prorate, in which case every
figure is labeled as the estimate it is.

`index.html?sample=1` loads a synthetic dataset so you can see the output shape without your data.

## Definitions

Identical to the TEGATA Credits metric definitions (`docs/prd/tegata-credits.md` §11.2), with one
stated approximation: exports cannot show when a top-up was *consumed*, so one-time payments are
recognized straight-line over the 30 days after the charge. The assumptions panel in the output
repeats this next to the numbers it affects.

## Status

Lives here while the project is spec-first; moves to its own repository before public launch
(per `docs/gtm/margin-diagnostic.md` §7). No build step, no dependencies — edit the file, reload.
