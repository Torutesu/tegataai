# tegata.ai

Two pages and a tool. No framework, no build step, no JavaScript on the marketing pages.

```
index.html      Credits — the product (EN)
ja/index.html   Credits — 日本語. Written independently, not translated
agents.html     The Agent Spend Policy Template and the schema. Not a product page
tool/           The margin diagnostic, copied from tools/margin-diagnostic/
```

## Measured, not claimed

Lighthouse against a local static server, all four pages:

| Page | Performance | Accessibility | Best practices | SEO | LCP | CLS |
|---|---|---|---|---|---|---|
| `/` | 100 | 100 | 100 | 100 | 0.9s | 0 |
| `/ja/` | 100 | 100 | 100 | 100 | 0.9s | 0 |
| `/agents.html` | 100 | 100 | 100 | 100 | 0.9s | 0 |
| `/tool/` | 100 | 100 | 100 | 100 | 0.9s | 0 |

Also verified: no horizontal overflow at 375px, no page errors, and the tool still makes no
network request beyond its own document.

```bash
cd site && python3 -m http.server 8080
CHROME_PATH=/opt/pw-browsers/chromium lighthouse http://127.0.0.1:8080/ --view
```

## Before this goes public

1. **The trademark answer** (`docs/gtm/trademark-brief.md`). Nothing here ships under the name
   until that comes back.
2. **The waitlist form has no backend.** Both `action="#"` attributes are marked `TODO(launch)`.
   A form that silently discards an address is worse than no form.
3. `/tool/` is a copy. Before launch it moves to its own repository with its source published,
   which is the whole basis of the "nothing is uploaded" claim.

## Why there is no Wallet page

`agents.html` gives away the template and points at the schema. It does not collect a waitlist,
because we decided not to build that product (D-30) and collecting addresses for it would be
collecting them under false pretences. The page says so in its own last section.

## Notes

- The diagnostic tool's JavaScript is deliberately unminified. Being readable is the argument
  for trusting it, so shipping it minified would trade away the point of the page.
- The pages commit to one palette rather than following the OS theme: this is securities
  stationery, and a dark mode would be a different object.
