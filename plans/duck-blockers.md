# Duck blockers: feat/blur-evidence

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
