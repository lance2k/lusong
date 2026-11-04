# Duck blockers: feat/vehicle-blur

Critic: `rubber-duck-gpt`, model `gpt-6-astra` via Codex CLI (session rollout-2026-11-05T00-14-03-01a1a756), plan round,
2026-11-04 16:14 UTC (2026-11-05 00:14 PHT).

## Plan round

### 🔴 V1. The planned cap counted metered images, a billing floor, not the most the probe could spend
Invariant: the whole-vehicle probe never spends more than $1.40 (560 SAM images), counting every attempt that may
have been billed, across both draws and any restart.
Disposition: `ImageAllowance` (test/whole-blur.ts) keeps one allowance on disk for both draws. Each call reserves both
attempts before it runs and settles to `billedUpperBound`: its metered image only when the call was clean, both
attempts when it threw, retried or came back without usage. A crash leaves the reservation counted, and a refused call
is recorded as a failed call (the photo is hidden), never as "found nothing". Ledger rows are written before each draw
runs.
Closed by: `test/whole-blur.test.ts` "is the metered image for a clean call, and both attempts for anything else",
"reserves two images before each call, refuses a call the cap can't hold, and settles to the upper bound", "keeps the
whole reservation while a call is unsettled, and carries the total across a restart".

### 🟡 dispositions
- The "contact band" is reported as detected water near detected people and vehicles, not as the waterline; an
  unusable band reply makes it unavailable; rendered flood examples are looked at by eye. Tests: "gives no band when a
  band prompt's reply is missing or unreadable", "reports a water reply with no mask as no water, and an empty band as
  unavailable rather than kept".
- Evidence figures only for photos the set would publish, over one cohort every set could publish. Test: "gives no
  evidence figures for a photo the set would hide, so a failed call can't look like evidence kept".
- The bar is labelled-identifier coverage, not whole-object coverage; PR #67's per-prompt bar is the empty set's row.
- Pairing with PR #67's runs is by file name and size (those runs kept no hashes); the new runs record sha256.

# Duck blockers: feat/blur-evidence (PR #67)

Critic: `rubber-duck-gpt`, model `gpt-6-astra` via Codex CLI (session rollout-2026-11-04T22-35-05-01a1a6fc), plan round,
2026-11-04 14:37 UTC (22:37 PHT).

## Plan round

### 🔴 P1. A 0.9 share of a loose box can pass a plate with an uncovered character or a face with uncovered features
Invariant: a labelled plate or face counts as covered only when no pixel of it is left out of the blur.
Disposition: the bar is now full coverage (every pixel of the labelled box under the grown masks); boxes are drawn
tight; coverage under 1 is a miss, listed with its value, and a miss that is only label slop is said so after looking.
Unsure labels are scored too, and the bar is stated with them included and without.
Closed by: `test/blur-recall.test.ts` "counts a box with one uncovered column as not covered" and "counts a box over a
hole in the mask as not covered".

### 🔴 P2. Judging the bar on the union lets the wrong prompt rescue a miss, and a failed call is read as empty masks
Invariant: the bar is per prompt (plates by grown `license plate` masks, faces by grown `person` masks), and a photo
whose required call failed or was refused by the strict reader is not covered, as `publishPhoto` would hide it.
Disposition: per-prompt is the primary bar; the union is reported beside it; a failed required call makes the photo
fail the bar, negatives included.
Closed by: `test/blur-recall.test.ts` "fails a photo whose plate call failed even when person masks cover every plate".

## Diff round

Critic: `rubber-duck-gpt`, model `gpt-6-astra` via Codex CLI (session rollout-2026-11-04T23-21-12-01a1a726), range
origin/main..820421b, 2026-11-04 15:22 UTC (23:22 PHT). No 🔴. Its review found the `grown()` extraction
behaviour-identical, that required-call failures and unsure labels fail the bar, and that the flag stays false.

- 🟡 The union included the experimental `face` masks, which publishPhoto never blurs. Fixed. Test: "leaves the face
  prompt's masks out of the union, which is what publishPhoto blurs".
- 🟡 A required call that was never recorded was missing from `failedCalls`, and strict-reader reasons were dropped.
  Fixed (`failures` keeps each prompt's reason). Test: "names a required call that was never recorded, and keeps each
  failure's reason". Both draws re-scored offline after the fix: unchanged.
