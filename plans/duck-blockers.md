# Duck blockers: depth accuracy

Critic: rubber-duck-gpt relay; critique by gpt-6-astra via Codex CLI (session rollout-2026-11-04T22-35-08-01a1a6fc…,
started 2026-11-04 14:35 UTC, 22:35 PHT). Round: plan.

| # | 🔴 | Invariant | Disposition | Closing test |
|---|---|---|---|---|
| P1 | The floor table jumps past the evidence (hips→waist); "bottom of the figure is the waterline" ignores frame/occlusion | A reading may deepen only within the evidence's bound | Table maps each submerged part to the lowest landmark it proves (hips→hip); `cannot_tell` for non-water occlusion; prompt rewritten | open |
| P2 | Overlap scoring can be inflated by deeper, wider landmarks | Accuracy claims must not come from metric artefacts | Report adds signed cm gap, rank error and paired transitions; ship rule requires a real too-shallow fall with bounded too-deep rise | open |
| P3 | Held-out partly exposed; "wins" undefined | The headline must be from data not tuned on | Exposure listed; unexposed held-out reported apart; ship criteria frozen in the plan before the final run | open |
| P4 | Reserve does not cover the paired run; harness has no admission | Dev spend stays under the day's cap | Harness enforces `LUSONG_DEPTH_MAX_USD` with per-draw worst-case reservation and settlement | open |
