# Lusong

Before you ride to work in Cebu, Lusong answers "should I leave now, and which way?": **Go**, **Go another way**,
**Wait** or **No one knows**, with the evidence under the answer. The evidence is PAGASA's flood advisory for Cebu and
photo reports from people at the water, each read by Lusong's depth reader: send a photo of a flooded street and it
reads how deep the water is on the MMDA flood gauge, with the waterline drawn on the photo.

**Try it:** https://lusong-mocha.vercel.app (10 checks per address per day; when the day's budget runs out it
shows sample results).

Built with Meta's SAM 3.1 and Muse Spark 1.3 through the Meta Model API.

## Why

In Metro Manila the MMDA reports flood depth on a gauge people can picture: gutter, half-knee, half tire,
knee, tire, waist and chest deep, each with whether light vehicles or any vehicle can pass. Drivers at the
edge of a flooded street still have to guess which one they are looking at. Someone on the street can take a photo;
Lusong reads the depth from the people and cars already standing in the water, and says whether that is too
deep for cars on the same gauge.

## The commute check

Pick a trip (a preset one such as Banilad → IT Park, or your own two points on the map) and tap Check.

- **The answer comes from fixed rules**, tested in `lib/answer.ts`. A photo report counts for 3 hours. A reading of
  "not passable to light vehicles" or deeper blocks its spot. Only a photo taken within the hour that shows no flood
  water clears one. Voice notes and web findings can warn, never clear.
- **Which way:** the plain route and a way around a blocked spot come from the public Valhalla router (motorcycle
  costing, the blocked spots excluded). Lusong checks the way around against the reports too. Plain route clear ⇒ Go.
  Plain blocked and the way around clear ⇒ Go another way. No way around, or it is blocked too ⇒ Wait.
- **Under an advisory or rain**, a Go needs clear reports every 500 m of the route. Without them the answer is No one
  knows, because nobody has looked yet. An advisory Lusong can't read counts as active.
- **Muse Spark investigates** through the Responses API: it calls Lusong's tools (read the advisory, list the reports
  near a route) and its own web search for road closures in Cebu today. It returns which evidence matters, as ids.
  Lusong writes every sentence on the page from those ids, so the model can't change the answer or put its own words
  in front of the rider. A closure it finds blocks a way only when it is dated today and placed on that way.
- **Voice notes:** someone at the water can record up to 30 seconds in Tagalog or English, recorded in the browser
  as 16 kHz WAV. Meta's Voice Transcribe turns it into words, and Muse Spark turns the words into a fixed-choice
  claim (a place, a depth, passable or not). Neither the audio nor the words are kept or shown, and a voice note
  can warn but never clear. Bisaya is off until it is tested on a real clip.
- **Blurred photos:** a report's photo is shown to others only after SAM 3.1 has found and pixelated every person and
  licence plate in it. SAM found all 9 clear plates on the 5 test photos that show plates, on both of 2 runs. That
  is too few photos to trust, so photos stay hidden for now, and a report shows its pin and reading.
- **A watcher** re-runs the check every 10 minutes during a window you pick (6–8 a.m., say) and sends a Telegram
  message when the window opens and whenever the answer changes. Switching it off deletes the trip and its history.
  It needs a Telegram bot and an outside scheduler, which `docs/watcher-setup.md` describes; Vercel's free plan runs
  scheduled jobs once a day.
- **The demo trips** are recorded routes with sample reports. Every sample says it is a sample and where the photo was
  really taken (Cavite, Manila or Shah Alam in Malaysia, from Lusong's labelled test photos), so it is never
  mistaken for a report from Cebu.

## Built during the hackathon

Lusong is an entry to the Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026, Indie Developer
track). Everything in this repository was written during the event; the commit history is the record.

<!-- commits:start -->
- 2026-10-28 09:12 PHT `aa3fcb8` chore: start Lusong for the Meta Global AI Developer Hackathon
- 2026-10-28 10:19 PHT `4948dc5` wip(slice-1): photo in, MMDA passability and waterline overlay out
- 2026-10-28 10:31 PHT `a415284` wip(slice-1): address review: reading integrity, full-file JPEG strip, deadline
- 2026-10-28 10:36 PHT `581ce9e` wip(slice-1): address re-review: field-typed readings, JPEG structure, retry dates
- 2026-10-28 11:19 PHT `ebf09c3` wip(slice-2): daily dollar budget, sample results, zoomed crops, acceptance gate
- 2026-10-28 11:34 PHT `98ee4a4` wip(slice-2): address diff review: day-bound Upstash settle, billing-case tests, unique manifest, sample load outside the upload lock
- 2026-10-28 11:48 PHT `f0db601` wip(slice-2): acceptance set (15 Commons photos) and gate run 1: FAILED, 5 false PATV draws on 3 knee-deep photos
- 2026-10-28 11:56 PHT `0d4312b` wip(slice-2): never answer PATV, raise the Muse output cap to 8,000
- 2026-10-28 11:59 PHT `50f774c` wip(slice-2): acceptance gate run 2 passed (no PATV possible, 6 of 16 deep draws under-read)
- 2026-10-28 23:37 PHT `db60cca` chore: link to the personal Vercel project; never upload .env files
- 2026-10-29 00:00 PHT `4d2ce2b` fix(budget): read the KV_REST_API_* names Vercel's Upstash integration sets
- 2026-10-29 02:33 PHT `4e95d5a` fix: address the overnight diff review of 0d4312b^..4d2ce2b
- 2026-10-29 02:37 PHT `90dd53e` fix: crowded photos that hit Muse Spark's output cap say they can't measure
- 2026-10-29 02:42 PHT `079d166` fix: a missing only reading is "cannot measure", never "no flood found"
- 2026-10-29 02:59 PHT `06e8e8a` wip(slice-3): a 45-photo labelled depth set and a paid runner with an error report
- 2026-10-29 03:03 PHT `3e160c6` wip(slice-3): address the harness review; record SAM tyre masks for slice 3b
- 2026-10-29 03:10 PHT `1d33d26` wip(slice-3): baseline error report on the depth set, 45 photos × 2 draws at 3e160c6
- 2026-10-29 03:12 PHT `01443fa` wip(slice-3b): a depth estimate from each car's tyre, which can only deepen the verdict
- 2026-10-29 03:16 PHT `6fa88e6` wip(slice-3b): address the tyre review: no estimate when nothing is hidden, limits on the page
- 2026-10-29 03:23 PHT `ed206ea` wip(slice-3b): after-run on the depth set with the tyre estimate, 45 photos × 2 draws at 6fa88e6
- 2026-10-29 03:26 PHT `6ac9f55` wip(slice-3b): acceptance gate passes with the tyre estimate, 15 photos × 2 draws at 6fa88e6
<!-- commits:end -->

## How it works

1. The browser shrinks the photo to at most 1600 px and re-encodes it as JPEG, which drops EXIF and
   GPS. The server strips metadata again in case a client skipped that step.
2. SAM 3.1 segments `flood water`, `person`, `car` and `tire`, one request each, in parallel.
3. Muse Spark 1.3 gets the photo and the list of people and cars SAM found (boxes on its 0–1000
   grid). A JSON schema makes it report, for each one, where the waterline sits from a fixed list
   of landmarks (ankle, half-knee, knee… or a quarter, half, the top of a tyre).
4. Lusong turns each landmark into a depth interval in centimetres, anchored on the MMDA gauge
   where MMDA names that body part. The deepest reading decides: 33–66 cm not passable to light
   vehicles (NPLV), 66 cm and up not passable to any (NPATV). Under 33 cm, where MMDA would say
   passable to all vehicles (PATV), Lusong says "shallow where measured" and never PATV: the photo
   shows only the spots where someone stands, not the deepest part of the street. With no person
   or car in the water, it says it can't measure.
   A second estimate comes from geometry: a wheel is round, so a tyre seen side-on at the
   waterline gives its diameter from its width, and the part hidden below the water gives the
   depth, taking a car tyre as 58–70 cm across (an assumption, not measured). It can only make
   the verdict deeper, never shallower, and it never measures a photo on its own. It counts a
   tyre top hidden by the wheel arch as water, so it errs deep, and a box shape cannot prove a
   wheel is side-on, so on an angled wheel it can read shallow; that is why it never lowers a
   verdict.
5. The page draws the water mask, boxes each person and car it measured, and marks the waterline
   where SAM's mask of that person or car meets the water.

## Why SAM 3.1 and Muse Spark

- **SAM 3.1 finds and outlines.** One text prompt per request (`flood water`, `person`, `car`, `tire`) gives
  pixel masks with no training data of our own. The masks are the evidence: the waterline on the page is where a
  person's or car's mask meets the water's.
- **Muse Spark 1.3 reads.** Where the water sits on a body or a tyre is a visual judgement. A JSON schema holds it
  to a fixed list of landmarks, so it never writes centimetres, a verdict or any text that reaches the page.
- **Plain code decides.** Landmarks become depth intervals and the deepest reading sets the MMDA class, by
  rules with unit tests (`lib/verdict.test.ts`, `lib/tyre.test.ts`). `docs/meta-api-notes.md` records what we measured about both models' API behaviour.

## How accurate it is

Two sets of openly licensed Wikimedia Commons photos run through the real pipeline. Their labels are the depth
words in each photo's caption (knee-deep, waist-deep…), not measured depths, so they test whether Lusong picks
the right landmark rather than whether its centimetres are right.

**Depth set** (`test/fixtures/depth-set/`, 45 photos, 2 draws each = 90 draws). 32 are flood scenes; 13 show
people wading in rivers or the sea, which Lusong is not built for but which carry a depth in the caption, so they
are counted apart. It measures and was never tuned on: nothing in the prompt or rules changed after seeing it. A
draw is "too shallow" when the whole interval of the reading that decided the verdict sits below the caption's;
touching or overlapping counts as a match.

| Run (2026-10-29) | Photos | Draws | too shallow | matched | too deep | can't measure | errors |
|---|---|---|---|---|---|---|---|
| baseline, `3e160c6`: flood scenes | 32 | 64 | 22 | 30 | 2 | 10 | 0 |
| baseline: wading in rivers or the sea | 13 | 26 | 11 | 10 | 2 | 3 | 0 |
| baseline: all | 45 | 90 | 33 | 40 | 4 | 13 | 0 |
| with the tyre estimate, `6fa88e6`: flood scenes | 32 | 64 | 22 | 28 | 2 | 12 | 0 |
| with the tyre estimate: wading | 13 | 26 | 11 | 11 | 2 | 2 | 0 |
| with the tyre estimate: all | 45 | 90 | 33 | 39 | 4 | 14 | 0 |

Too shallow is the error that matters, and it is high: on the flood scenes 22 of 64 draws in both runs (33 of
90 with the wading photos). Most of those still came with a cautious answer: on flood scenes whose caption says
knee-deep or deeper (56 draws), Lusong answered "shallow" on 8 in each run (10 of 82 with the wading photos), and
even then the page says "not a go-ahead". The tyre estimate appeared on 2 of 90 draws and decided none, so it
changed nothing here; 6 of the 45 photos changed outcome between the two runs from draw-to-draw variation
alone. Reports: `test/depth-runs/`.

**Acceptance gate** (`test/fixtures/acceptance/`, 15 photos × 2 draws = 30). It fails on "no flood found" for a
knee-deep-or-deeper photo and on any measurement of a photo with no person or car in the water. On `6fa88e6`
it passed with 0 failures; it listed 5 under-reads ("shallow" or "unsure" on a knee-deep photo, on 3 photos),
against 6 on the previous run. The tyre estimate appeared on 4 of the 30 draws and decided none.


## Limits

- The commute check knows only what was reported in the last 3 hours, what PAGASA's advisory says and what the
  web search found today. A street nobody photographed is unknown, which is why rain with no reports gives
  No one knows rather than Go.
- Routes come from the public FOSSGIS Valhalla server, shared by everyone and limited to one request a second.
  When it can't be reached, the check gives no answer rather than a guess.
- Map tiles come from OpenStreetMap's servers, which see the area you view. The map opens on all of Metro Cebu
  and moves to your trip only when you check it.

- It measures only where a person or car stands in the water. The deepest part of the street may be
  elsewhere, which is why it never says "passable to all vehicles".
- The centimetres behind each landmark (knee 38–54 cm, and so on) are estimates for an adult, not
  measurements; children are left out of the reading.
- A scene with too many people and cars for Muse Spark's output cap gets "can't measure", not a guess.
- The tyre estimate assumes a 58–70 cm car tyre, errs deep when the body hides the tyre's top, and can read
  shallow on a wheel seen at an angle; it can only make a verdict deeper.
- A photo report counts for 3 hours from when Lusong receives it, and a photo showing no flood water marks the
  spot clear only if it was taken within the hour before it was sent. Neither rule can prove the photo is recent:
  - the capture time comes from the phone's EXIF data, which anyone can edit;
  - EXIF carries no time zone, so Lusong reads it as Philippine time;
  - the same photo sent again is caught as one report only when its image bytes match, so a re-encoded or
    cropped copy is counted as a new report;
  - upload recency can't be proven: an old photo with a fresh capture time looks fresh.
- It is a guide, not a safety system. Don't drive into flood water you can't see the bottom of.

## Run it locally

Needs Node 22.9+ and pnpm, and a Meta Model API key.

```sh
pnpm install
printf 'MODEL_API_KEY=…\nLUSONG_BUDGET_STORE=memory\n' > .env.local
pnpm dev
```

`pnpm test` runs the unit tests against saved SAM responses; they make no API calls.

### Spending limits

Every check reserves its worst-case cost ($0.103: eight SAM images and two Muse Spark attempts at the
measured input bound and the 8,000-token output cap) against a daily dollar budget before any paid
call, then settles to what Meta's usage blocks report. A failed or retried call keeps the whole
reservation. When the budget or an address's daily checks run out, the page shows sample results.

This is an estimated guard, not a hard cap. Meta bills tokens after the call and has no per-request
limit, so the reservation rests on a measured bound: 1.5× the input tokens of the largest photo the
server accepts (1600×1600, 12 objects). An overrun that Meta reports is charged, which refuses later
checks, so the daily total can pass the budget only by that overrun on the checks already in flight.

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_BUDGET_USD` | `10` | Spend allowed per UTC day (resets 8:00 a.m. in Manila). |
| `PER_IP_DAILY` | `10` | Checks per client address per UTC day. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`, `KV_REST_API_TOKEN`, which Vercel's Upstash integration sets) | none | The shared ledger. Its keys all start with `lusong:`, so it can share a database. Without them every check is refused. |
| `LUSONG_BUDGET_STORE=memory` | unset | An in-process ledger for local development. Refused when `VERCEL` is set or `NODE_ENV=production`. |

The ledger's Lua scripts run against real Redis behind
[serverless-redis-http](https://github.com/hiett/serverless-redis-http), which speaks Upstash's REST API:

```sh
docker run -d --rm --name lusong-test-redis redis:7.4-alpine
docker run -d --rm --name lusong-test-srh -p 127.0.0.1:8079:80 -e SRH_MODE=env -e SRH_TOKEN=local-test-token \
  -e SRH_CONNECTION_STRING="redis://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' lusong-test-redis):6379" \
  hiett/serverless-redis-http:latest
LUSONG_TEST_UPSTASH_URL=http://127.0.0.1:8079 LUSONG_TEST_UPSTASH_TOKEN=local-test-token pnpm test lib/budget.test.ts
```

### Acceptance set

`LUSONG_LIVE=1 pnpm test test/acceptance.test.ts` runs every photo in `test/fixtures/acceptance/` twice
through the real pipeline (about $0.70 a run) and writes the results to `test/acceptance-runs/`.

Lusong never answers PATV (passable to all vehicles). The first run gave PATV on 3 of 8 photos whose
captions say knee-deep or deeper, so where the MMDA table would say PATV the page now says "shallow
where measured, but not a go-ahead". The run fails on "no flood found" for a knee-deep-or-deeper photo
and on any measurement of a photo with no person or car standing in the water, and it lists every
"shallow" or "unsure" answer on a deep photo as an under-read. It is a screen with two draws per photo,
not an accuracy measure.
