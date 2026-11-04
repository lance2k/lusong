# Duck blockers: depth accuracy

Critic: rubber-duck-gpt relay; critique by gpt-6-astra via Codex CLI (session rollout-2026-11-04T22-35-08-01a1a6fc…,
started 2026-11-04 14:35 UTC, 22:35 PHT). Round: plan.

| # | 🔴 | Invariant | Disposition | Closing test |
|---|---|---|---|---|
| P1 | The floor table jumps past the evidence (hips→waist); "bottom of the figure is the waterline" ignores frame/occlusion | A reading may deepen only within the evidence's bound | Table maps each submerged part to the lowest landmark it proves (hips→hip); `cannot_tell` for non-water occlusion; prompt rewritten. The hidden reader was then dropped on tuning. | closed: `lib/readings.test.ts` "hidden floor: each submerged part raises the pick to exactly the landmark it proves, never past it" |
| P2 | Overlap scoring can be inflated by deeper, wider landmarks | Accuracy claims must not come from metric artefacts | Report adds signed cm gap, rank error and paired transitions; ship rule requires a real too-shallow fall with bounded too-deep rise (it is what stopped the candidate) | closed: `test/depth-report.test.ts` "gap and rank error: a chest reading on a waist caption scores a match but a positive rank error" |
| P3 | Held-out partly exposed; "wins" undefined | The headline must be from data not tuned on | Exposure listed in split.json; unexposed held-out reported apart; ship criteria and the candidate frozen (commit 3349e15) before the held-out run | closed: `test/depth-report.test.ts` "split tallies: exposed held-out photos are counted apart" |
| P4 | Reserve does not cover the paired run; harness has no admission | Dev spend stays under the day's cap | Harness enforces `LUSONG_DEPTH_MAX_USD` with per-draw worst-case reservation and settlement (it refused 37 reader-draws in tuning pass 1) | closed: `test/depth-report.test.ts` "spend cap: a draw whose reserve would cross the cap does not start" |

No diff duck: nothing from this branch ships (the held-out run failed the frozen criteria), so no PR was opened. Final review skipped.
