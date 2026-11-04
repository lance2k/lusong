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

## What already exists (on main, in production since #2x)
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
