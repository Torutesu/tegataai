# The launch reel

Beats two and three of `docs/gtm/launch-storyboard.md`, recorded against a running server.

## Why it is built this way

The storyboard's check V-01 requires the latencies on screen to be measured, not composed.
So nothing here is written by hand:

1. **`capture-session.mjs`** runs the sequence against a real server — authorize, settle, refuse,
   export, verify, tamper, verify again — and writes every response and every timing to
   **`session.json`**. That file is the evidence, and it is committed.
2. **`build-player.mjs`** inlines that session into `player.html`. It chooses which fields to show
   and how long to hold each one, but it cannot invent a value that is not in the capture.
3. **`record.mjs`** plays the page and records it.

If the implementation changes, re-running step 1 changes what the video says. It cannot drift.

```bash
rm -f demo.db*
KEY=$(TEGATA_DB=./demo.db pnpm bootstrap | grep 'secret key' | grep -o 'sk_live_[A-Za-z0-9_-]*')
echo "$KEY" > /tmp/demo.key
TEGATA_DB=./demo.db PORT=8791 pnpm dev &

cd demo && node capture-session.mjs && node build-player.mjs && node record.mjs
```

## What came out

| File | |
|---|---|
| `out/tegata-beats.mp4` | The full sequence, 38s, 1280×720 |
| `out/tegata-refusal-15s.mp4` | The refusal on its own — the cut for social and the site hero |
| `out/poster.png` | The frame the whole thing is about |

Copies of the two videos and a JPEG poster live in `site/media/` for the landing page.

## The captured numbers

From `session.json`, and these are what appear on screen:

| Step | Result | Latency |
|---|---|---|
| authorize | `201 authorized`, face value 12, 988 available after the hold | 16.8ms |
| capture | `200 captured`, 9 settled, 3 returned, balance 991 | 10.4ms |
| authorize, no balance | `200 dishonored`, `insufficient_balance`, 3 available against 12 required | 5.5ms |
| verify export | `chain verifies` — 5 entries, 2 subjects, manifest agrees | |
| verify after one byte changed | `chain FAILED` — hash does not match the entry contents | |

The refusal proposes `chat.completion.mini` at 2 credits, which the subject can actually afford.
A remedy that is not cheaper, or not affordable, is withheld rather than offered.

## Storyboard checks

| | |
|---|---|
| V-01 latencies are measured | Verified against `session.json` — every displayed value appears in the capture |
| V-02 tool output is real | The diagnostic ships at `site/tool/` and computes in the browser |
| V-03 verification is the shipped one | `packages/verify` is the binary the recording invokes |
| V-04 no forbidden vocabulary | Zero hits in `player.html` |
| V-05 "AI" is never the subject | The subjects are the request, the model, the register |
| V-06 length | 38s for beats 2–3. Scenes 1–3 and 5 remain to be shot for the 75s cut |

## Still to shoot

Scenes 1, 2, 3, 5 and 7 of the storyboard: the opening card, the diagnostic result, the
"billing tells you afterwards" contrast, the in-app top-up, and the closing seal. Beat 1
(scene 2) needs the diagnostic driven on camera; the rest are cards and product UI.

The reel deliberately has no audio. The voiceover script is in the storyboard.
