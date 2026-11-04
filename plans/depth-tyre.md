# Depth reader: tyre-cap geometry (step 2, second attempt)

## Asked for
Lance, 2026-11-04 22:30 PHT: "Unfreeze and do Order until 1-5 is done". Step 2 of the order he approved: "the depth-reader
work (make it more accurate, measured against the 28 of 64 baseline)".
Lance, 2026-11-05 01:00 PHT: "let's not wait for 8am, deadline is close. Increse budget if needed". The step this starts,
which the orchestrator had offered: "tyre geometry for the depth reader", after the head-height attempt
(`plans/depth-accuracy.md`) failed its held-out criteria.

The orchestrator's spec for this piece: a tyre is close to a circle; when water covers its lower part, SAM's `tire` mask
is a cap above the waterline. From the chord width w and cap height h, R = (w²/4 + h²)/(2h), submerged height 2R − h;
if h > R the widest width is the diameter. Depth ≈ submerged height (the tyre's bottom is the road), reported as a
fraction of the diameter mapped to MMDA classes, with real tyre sizes (car about 60–65 cm, motorbike about 45–55 cm) only
as stated, sourced assumptions. Tested code does all of it; the model is never asked for numbers. Combined so it can only
deepen a reading within what the geometry supports. Guards, each tested: an angled tyre (ellipse), a tyre hidden by
something other than water (cut edge on or near SAM's `flood water` mask), a cap too small (minimum h), no tyre. Freeze
criteria and candidate in a commit before any held-out run; same criteria as the head attempt; tune only on tuning.
Report the held-out headline before/after with draws, and how many held-out flood photos have a usable tyre at all.
Ship behind a constant that's on only if it passes; otherwise no PR, push the branch, report.

## What already exists (on main since 01443fa, slice 3b; in the production build b46bd2f)
`lib/tyre.ts` already does tyre-cap geometry, and `lib/check.ts` already feeds it into `decideVerdict` as
`tyreEstimates` (deepen-only, never counted as a reading). So today's held-out baseline (13 too shallow, 17 matched,
0 too deep, 16 flood photos × 2 draws) already includes it. Today's version:
- uses the box: if h ≥ w/2 the width is the diameter, else D = w²/(4h) + h (same circle formula);
- rejects h > 1.1 w (angled), w < 16 px, nothing hidden;
- requires the tyre's centre inside a SAM `car` box (smallest box wins) — tyres outside every car box are dropped;
- requires `waterlineY` (some column of the mask's bottom edge within max(3 px, 3 % of box height) of a water pixel);
- cm from a 58–70 cm diameter (UNVERIFIED in the code).
Gaps against the spec: no minimum cap height (w = 40, h = 2 gives D = 202 px, 99 % hidden, 57–70 cm: the blow-up the
spec warns of); one water-touching column is enough for "cut by water"; no motorbike or other non-car tyres; no
fraction-of-diameter reporting; the angle guard looks only at the cut tyre.

## What the tuning split shows (cached SAM replies, one pass per photo; free)
`test/depth-tyre-census.mts tuning`: of 16 tuning flood photos, 3 have any `tire` mask and 2 have one touching water:
- olga-stranded-motorist (knee): one tyre 54 × 69 px, touching water: taller than wide, rejected as angled.
- texas-…-004 (thigh): 4 tyres touching water, no `car` box at all (military trucks, UNVERIFIED by eye): 39×70 and 42×50
  angled; 100×73 → 27 % hidden; 52×47 → 10 % hidden. Even with a 70 cm diameter that is ≤ 19 cm, far under thigh.
- flooded-street (ankle): 4 dry tyres (no water mask at all).
Car scenes at knee depth (banks-street, cavite) have cars but **no** tyre masks: at knee depth a 60 cm tyre is ~80 %
under, and SAM finds no tyre. Wading scenes have none. So on tuning the geometry can reach at most 1–2 photos, and on
those it reads shallower than the model already does. Expected held-out effect: small. That is itself the main finding to
report if it holds on held-out.

## Candidate (v2), behind `TYRE_GEOMETRY` constant ("v1" today's, "v2" candidate)
1. Geometry from the mask, not the box: chord w = width of the mask's lowest row band (the cut edge), cap h = box
   height, widest width W = box width. If h ≥ W/2 (more than half showing): D = W. Else R = (w²/4 + h²)/(2h), D = 2R.
   Fraction submerged f = (D − h)/D. (Box width equals chord when under half shows, so this mostly matters for noisy
   bottoms; it also lets the angle guard compare W against D.)
2. Minimum cap: h ≥ max(6 px, 0.2 w); otherwise null. At h = 0.2 w the formula allows f up to ≈ 0.86.
3. Cut by water: at least half of the cut edge's columns must have a `flood water` pixel within the existing tolerance
   (today: one column).
4. Angle: reject h > 1.1 W (as today). And when another tyre in the same vehicle box is dry and whole (not touching
   water, h ≥ W/2 … i.e. not cut), its h/W gives the view's squash: if outside [0.85, 1.15], reject that vehicle's cut
   tyres (a vertically squashed view makes the cap look flat and the estimate too deep).
5. Tyres outside every car box are kept as their own estimate (label `T<n>`), with diameter 45–70 cm (motorbike low to
   car high, so a larger truck tyre reads shallower, never deeper). Tyres inside a car box keep 58–70 cm (a range that
   holds the spec's 60–65 cm; computed from tyre size codes: 155/80R13 ≈ 57.8 cm, 205/55R16 ≈ 63.2 cm, 265/70R16 ≈
   77.7 cm; motorbike 70/90-14 ≈ 48.2 cm, 80/90-17 ≈ 57.6 cm — arithmetic on the ISO size code, UNVERIFIED which sizes
   are in any photo).
6. Output per estimate: f and the cm interval floor(f·Dlow)…ceil(f·Dhigh). The MMDA class comes from the cm interval
   through `decideVerdict` as today (half tire 33 cm = f 0.5 of a 66 cm tyre). Estimates only deepen (deepest-high
   rule, unchanged) and never count as readings, so a photo with no usable reading stays cannot_measure.
7. No tyre → no estimates → verdict identical to v1 (test).

## Measurement
- Tuning: offline on run 2026-11-04T14-45-43-837Z (landmark reader, cached SAM), `test/depth-tyre-offline.mts`, arms
  v1 vs v2 from the same readings. Free.
- Freeze commit (candidate + criteria) before any held-out evaluation.
- Held-out: offline on run 2026-11-04T14-56-37-720Z — the same records the 13/17/0 baseline came from, same SAM pass,
  same Muse readings, both arms. Free. This held-out set was already used once (the head candidate's evaluation); the
  tyre census of held-out has not been looked at.
- If, and only if, the offline held-out passes: one fresh live held-out run (new SAM pass of 23 photos with the 4
  phrases, landmark reader × 2 draws; ≈ $0.91 measured last time, harness cap LUSONG_DEPTH_MAX_USD=1.60) as a second
  sample, both arms computed from it; the PR reports both. Ledger row before reading results.
- Ship criteria, unchanged from 3349e15, on held-out flood scenes (16 photos × 2 draws): (a) too shallow falls by ≥ 4;
  (b) too deep rises by ≤ half that fall; (c) matched does not fall; (d) no errors beyond v1's. Plus the commute gate tests
  still hold.
- Report: held-out headline before/after; the count of held-out flood photos with a usable v2 tyre; tuning; draws; cost.

## Rules kept
Tested code computes everything; no model numbers; deepen-only; page text unchanged (decidedBy "tyre_geometry" exists).

## Known risks I want challenged
- Is reusing the held-out records a second time (after the head candidate) acceptable as the headline?
- Diameter 45–70 for unboxed tyres: is lower-bound-from-motorbike the safe direction? (a smaller assumed D reads
  shallower, which can't deepen.)
- Cut-edge-on-water at ≥ 50 % of columns: too strict for a tyre whose cut edge is partly behind a leg or a wave?
- The dry-sibling squash test: right threshold? Most photos have no dry sibling.
- A floating or lying tyre outside any vehicle box: reads as submerged, "deeper" — bounded by the too-deep criterion only.

## Amendments after the plan duck (gpt-6-astra, session rollout-2026-11-05T01-05-29-01a1a785, 2026-11-04 17:05 UTC, 2026-11-05 01:05 PHT)
Three 🔴, dispositions in `plans/duck-blockers.md`:
- 🔴 T1, held-out reuse: no untouched labelled set exists before the deadline. The held-out result is reported as
  **exploratory**: the split's held-out photos already decided the head candidate, so a pass here is a weaker claim than
  a first-use held-out pass and the report says so; a fail is still a fail. Independent validation remains incomplete.
- 🔴 T2, replay provenance: the replay reads each record's SAM replies from the run's own `sam/<file>.d<draw>.json` when
  the run saved them, else from the shared cache, and it refuses a record whose v1 arm does not reproduce the verdict
  recorded in the run (same passability, same deciding interval). That proves the replay used the masks the run used.
- 🔴 T3, accounting: the replay expects every photo of the split × every draw exactly once; a missing or duplicated
  pair aborts; an error record counts as an error in both arms.
- 🟡 Diameter: a lower assumed low bound does not stop over-deepening (the verdict reads the high bound, 70 cm). Unboxed
  tyres keep 45–70 cm because the vehicle is unknown, and that is stated as an assumption, not as a safety property.
  Sizes are arithmetic on the ISO size code (rim inches × 2.54 + 2 × section width × aspect ratio).
- 🟡 Top occlusion (wheel arch) reads deeper, as today's v1 already does; v2 does not fix it. A floating tyre is not
  guarded beyond the cut-on-water and flat-cut checks.
- 🟡 Decision rule for the fresh run, frozen now: if the offline held-out replay passes and a fresh live held-out run is
  made, the fresh run must pass the same criteria too; an incomplete fresh run is inconclusive and nothing ships.
- Simplification: for a cap under half (h < W/2) the chord is measured from the mask's bottom-edge columns (never wider
  than the box), so a ragged bottom reads a narrower chord, a smaller circle and a shallower depth.

## Tuning result (offline replay of run 2026-11-04T14-45-43-837Z, landmark reader, cached SAM; free)
`npx tsx test/depth-tyre-offline.mts test/depth-runs/2026-11-04T14-45-43-837Z tuning`: every replayed record's v1 arm
reproduced the verdict the run recorded. Flood scenes, 30 reader-draws (11 photo-draws were refused by that run's cap):

| Tuning flood (30 draws) | too shallow | matched | too deep | can't measure | error |
|---|---|---|---|---|---|
| v1 (shipped) | 8 | 10 | 3 | 8 | 1 |
| v2 (candidate) | 8 | 10 | 3 | 8 | 1 |

One tuning flood photo has a v2 tyre estimate (texas-…-002, thigh: two tyres outside any car box, 12–19 and 4–7 cm),
and both read shallower than the model's own `hip`, so nothing changes. v1 finds none on tuning. Nothing was tuned:
there is no signal on the tuning split to tune against. On the recorded fixtures v2 keeps Manila's tyre (27–34 cm, as
v1) and drops Shah Alam's (water under 3 of its 14 cut columns; v1 read 21–26 cm).

## Candidate and criteria, frozen before any held-out replay
Frozen at the commit that adds this section (candidate code at b2a32a9): `tyreEstimates(..., { geometry: "v2" })`
against `{ geometry: "v1" }`, combined through `decideVerdict` unchanged.
Held-out evaluation: `test/depth-tyre-offline.mts test/depth-runs/2026-11-04T14-56-37-720Z heldout`, which must account
for all 23 photos × 2 draws and reproduce every recorded verdict in its v1 arm, or the result is void.
Ship criteria on held-out flood scenes (16 × 2 = 32 draws), unchanged from 3349e15: (a) too shallow falls by ≥ 4;
(b) too deep rises by ≤ half that fall; (c) matched does not fall; (d) no errors beyond v1's. The result is labelled
exploratory (🔴 T1). If it passes, one fresh live held-out run (cap $1.60) must pass the same criteria before a PR;
an incomplete fresh run is inconclusive and nothing ships. If it fails, nothing ships and no PR is opened.

## Held-out result (offline replay of run 2026-11-04T14-56-37-720Z, 2026-11-04 17:14 UTC, 2026-11-05 01:14 PHT): not shipped
Exploratory (🔴 T1: this split already decided the head candidate). All 23 photos × 2 draws accounted for, 0 missing;
every v1 arm reproduced the verdict the run recorded (46 of 46). Per-draw rows: `tyre-offline.txt` beside the run.
$0: no network calls.

| Held-out flood scenes (16 photos × 2 draws) | too shallow | matched | too deep | can't measure | error |
|---|---|---|---|---|---|
| v1 (shipped tyre geometry, today's baseline) | 13 | 17 | 0 | 2 | 0 |
| v2 (frozen candidate) | 13 | 17 | 0 | 2 | 0 |

Wading (7 photos × 2): 7 / 4 / 0 / 3 / 0 in both arms. Criteria: (a) too shallow fell by 0 (needs ≥ 4): fail. (b), (c),
(d) hold. So v2 does not ship, `TYRE_GEOMETRY` stays "v1", no fresh live run was made, and no PR is opened.

How many held-out flood photos have a usable tyre at all: **3 of 16** under v2 (statelibqld-1-79551, knee;
texas-national-guard-…-1, thigh; 2016-…-015, thigh), 1 of 16 under v1 (79551). On tuning, 1 of 16 under v2, 0 under v1.
v2 changed one deciding interval in 46 draws (texas-national-guard d1: ankle 5–10 → tyre 14–23 cm, still too shallow
against thigh) and no outcome.

What it shows:
- The too-shallow draws are not where the tyres are. The 13 too-shallow held-out flood draws sit on 6 photos; 4 of them
  have no tyre mask at all (people only: paddock, knee-deep, 1910 Paris, 109124).
- Where tyres exist, they read shallower than the caption: the vehicles stand in shallower water than the people the
  caption measures. By eye on texas-national-guard-…-1 (one look): the army truck is parked where its wheels are about a
  quarter under, while the guardsmen wade thigh-deep in the foreground. Its tyres are also larger than the 45–70 cm
  assumed for a vehicle of unknown kind (a truck tyre about 1 m across, UNVERIFIED), so the cm reads low too.
- On cars in knee-deep water (tuning: banks-street, cavite) SAM returns no `tire` mask, so the geometry cannot reach
  the depths where it would matter most for NPLV/NPATV. The tyre path helps only shallow water on side-on vehicles.
- The v2 guards are real but cost a little: on the recorded Shah Alam fixture v2 drops the one tyre v1 measured, because
  water touches only 3 of its 14 cut columns.
