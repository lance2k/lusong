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
