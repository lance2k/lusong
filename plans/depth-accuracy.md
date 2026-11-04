# Depth reader accuracy (step 2 of the unfreeze brief)

## Asked for
Lance, 2026-11-04 22:30 PHT: "Unfreeze and do Order until 1-5 is done". Step 2 of the order he approved: "the depth-reader
work (make it more accurate, measured against the 28 of 64 baseline)". The orchestrator's task for this piece: raise the
match rate on the 45-photo depth set and especially cut too-shallow readings, measured on the same set and scoring,
without weakening any rule (tested code picks the class; the model only chooses from fixed landmarks or other fixed
choices; no model-written centimetres or verdicts on the page). Split tuning/held-out before looking at per-photo
results; held-out is the headline. Keep the old reading path reachable so before/after comes from one harness. If it
doesn't beat baseline on held-out, don't ship it.

## What the baseline gets wrong (tuning split only)
On the tuning split's flood scenes (6fa88e6 run) the too-shallow draws are 5 photos: people whose legs vanish into the
water read as `ankle` or `half_knee` (defense-gov: two men in waders, water about knee; okinawa: a man knee-deep, read
ankle on both draws; texas-004: soldier with water about knee, read ankle/half_knee; miami: legs at night; a 1909
postcard with small figures read knee for waist). Pattern: the model treats the bottom of the visible figure as the feet.

## Change
1. Schema: each reading gains `hidden_under_water`, an enum: `none | feet | shins | knees | thighs | hips | waist | chest
   | cannot_tell` — "the highest body part that is completely under the water (not hidden by an object or the photo's
   edge)". Cars get `cannot_tell` / `none` only (or the field is ignored for cars; decide in implementation, cars keep
   today's path either way).
2. Tested code (lib/readings.ts) maps that answer to a floor landmark: feet→ankle, shins→below_knee, knees→knee,
   thighs→hip, hips→waist, waist→waist, chest→chest; none/cannot_tell→no floor. The reading's landmark becomes the deeper
   of the model's waterline pick and the floor. It only ever deepens. A `not_visible` waterline stays not_visible (the
   floor never makes an unusable reading usable). Children stay unusable. The combined landmark is one of the existing
   landmarks, so intervals are no wider than today and the overlap scoring cannot be gamed by widening.
3. The prompt says: when someone stands in water, the bottom of what you can see is the waterline, not their feet;
   before picking, decide which body parts are hidden by the water.
4. Old path kept: `readWaterlines(..., { reader: "landmark" | "hidden" })`, default the new one if it wins.
   `checkPhoto` gets an option to run both readers on the same SAM replies (`compare`), used only by the harness.
5. Harness: `test/depth-set.test.ts` gains `LUSONG_DEPTH_READER=landmark|hidden|both` and
   `LUSONG_DEPTH_SPLIT=tuning|heldout|all`; with `both`, each draw runs SAM once and both readers on its replies, so the
   before/after is paired. A tuning-only mode replays SAM replies cached from one live SAM pass over the tuning photos
   (`LUSONG_DEPTH_SAM_CACHE=<dir>`), so prompt iterations cost only Muse tokens. depth-report gets per-split tallies.
6. Report: held-out flood scenes headline; tuning and all; draws; cost.

## Measurement and money
2026-10-29 run: 90 draws, $2.06 metered (360 SAM images + 197,946 in / 215,570 out Muse tokens), $0.023 a draw; Muse
$0.013 a draw. Plan: SAM cache for 22 tuning photos ($0.22), up to 3 tuning variants × 44 Muse draws (≈$0.60 each),
then one paired final run of all 45 × 2 draws with both readers (≈ 90 × ($0.01 SAM + 2 × $0.0135) ≈ $3.3; worst case
with every retry bounded by the reserve formula). Tonight's UTC day has ≈ $5.2 left (shared with a parallel probe);
the final run waits for 00:00 UTC if needed. Every call logged in the ledger before reading results.

## Rules kept
Tested code picks the class (decideVerdict unchanged); the model only chooses enums; page text from ids/templates;
hidden floor only deepens (lean safe). MUSE_INPUT_TOKEN_BOUND re-checked against the measured max after the run.

## Known risks I want challenged
- Lean-deep combination will raise too-deep; is max(pick, floor) the right combiner?
- Ambiguity of "completely under the water" vs hidden by another object / frame edge / murky water.
- Mapping table choices (shins→below_knee, thighs→hip, hips→waist).
- Paired final run on the same SAM replies vs. two independent live runs.
- Reusing one SAM pass for tuning iterations hides SAM variance during tuning.
- The split was fixed by a salted hash (commit c59bb3e) after I had seen about 16 rows of the old report's per-photo
  table (the report's first rows, alphabetical); the split rule does not depend on outcomes.

## Amendments after the plan duck (gpt-6-astra; its session started 2026-11-04 14:35 UTC, 22:35 PHT)
Dispositions of its four 🔴 are in `plans/duck-blockers.md`. In short:
- Floor table, strictly the lowest landmark the submerged part proves: feet→ankle, shins→below_knee, knees→knee,
  thighs→hip, hips→hip, waist→waist, chest→chest. `cannot_tell` covers legs hidden by anything but water (another
  object, the frame edge, murk). The prompt no longer says the bottom of the figure "is" the waterline; it asks the model
  to tell water from other occlusion. Missing or unknown values are listed as contract problems (reply incomplete).
- A prompt-only candidate (same schema as today, new guidance text) is tried in tuning beside the hidden-field one.
- Scoring adds, per draw, the signed gap in cm between the deciding interval and the caption's (0 on overlap), the
  landmark-rank error, and a paired transition table (old outcome → new outcome, same SAM replies).
- Held-out exposure: before the split I had seen the 6fa88e6 per-photo rows of 10 held-out photos (170901,
  texas-…-015, 7th-communication…, dfc-5296…, dsc-8232…, fisherman…, full-length…, half-length…, hc08187…,
  inondations…). The report gives held-out numbers also for the 13 held-out photos I never saw rows for.
- Each reader in a paired draw gets its own deadline and its own error record.
- The harness enforces a dollar cap itself (`LUSONG_DEPTH_MAX_USD`): a draw starts only if settled spend plus every
  in-flight draw's worst-case reserve stays under the cap; it settles each draw's metered cost when it finishes.

## Ship criteria, frozen before the final run
On held-out flood scenes, paired (same SAM replies, 2 draws × 16 photos = 32 draws per reader), the candidate ships
only if all hold: (a) too shallow falls by at least 4 draws; (b) too deep rises by at most half that fall; (c) matched
does not fall; (d) no reader errors beyond the old reader's. Otherwise the result is reported as not shipped (or
inconclusive), with what was learned. The candidate and this rule are not changed after the final run starts.

## Tuning results (tuning split only; SAM from one cached pass per photo; run 2026-11-04T14-45-43-837Z)
Flood scenes, reader-draws that ran (the harness's cap refused 37 of 132 reader-draws, so counts are uneven):

| Reader | draws | too shallow | matched | too deep | can't measure | error |
|---|---|---|---|---|---|---|
| landmark (frozen 2026-10-29 prompt) | 30 | 8 | 10 | 3 | 8 | 1 |
| guided (prompt-only) | 30 | 8 | 9 | 2 | 10 | 1 |
| hidden (hidden-part floor) | 29 | 8 | 5 | 3 | 9 | 4 |

Neither prompt candidate beats the frozen reader. On the photos read too shallow, the hidden reader answers that the
*feet* are what the water hides (defense-gov, okinawa, miami, west-street): the model sees the bottom of the visible
body as the feet, so asking it differently does not change what it sees. Both are dropped.

Offline on the same records, a head-height estimate from SAM 3.1's `head` masks (`lib/head.ts`: visible
crown-to-waterline height in the person's own head-heights, 7–8 heads to an adult, 145–180 cm), allowed to deepen any
usable person reading: too shallow 8 → 6, too deep 5 → 8, matched 11 → 10 (32 landmark draws, flood and wading). Every
new too-deep draw came from a person the model had read at below_knee or deeper; the draws it fixed had been read at
ankle or half_knee.

## Final candidate, frozen 2026-11-04 14:56 UTC (22:56 PHT), before any held-out run
`landmark` reader unchanged, plus the head-height estimate, which may deepen the verdict only through a usable adult
person reading the model put at `ankle` or `half_knee` (the failure the tuning split shows), and like the tyre
estimate is never counted as a reading. Measured on held-out with the same design as tuning (one SAM pass per photo
including `head`, 2 Muse draws, both arms computed from the same Muse readings), against the ship criteria above.
