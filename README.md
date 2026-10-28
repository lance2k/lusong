# Lusong

Send a photo of a flooded street and find out how deep the water is and whether a car can get through,
on the MMDA flood gauge, with the waterline drawn on the photo as the evidence.

Built with Meta's SAM 3.1 and Muse Spark through the Meta Model API.

## Built during the hackathon

Lusong is an entry to the Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026, Indie Developer
track). Everything in this repository was written during the event; the commit history is the record.

## How it works

1. The browser shrinks the photo to at most 1600 px and re-encodes it as JPEG, which drops EXIF and
   GPS. The server strips metadata again in case a client skipped that step.
2. SAM 3.1 segments `flood water`, `person` and `car`, one request each, in parallel.
3. Muse Spark 1.3 gets the photo and the list of people and cars SAM found (boxes on its 0–1000
   grid). A JSON schema makes it report, for each one, where the waterline sits from a fixed list
   of landmarks (ankle, half-knee, knee… or a quarter, half, the top of a tyre).
4. Lusong turns each landmark into a depth interval in centimetres, anchored on the MMDA gauge
   where MMDA names that body part. The deepest reading decides: 33–66 cm not passable to light
   vehicles (NPLV), 66 cm and up not passable to any (NPATV). Under 33 cm, where MMDA would say
   passable to all vehicles (PATV), Lusong says "shallow where measured" and never PATV: the photo
   shows only the spots where someone stands, not the deepest part of the street. With no person
   or car in the water, it says it can't measure.
5. The page draws the water mask, boxes each person and car it measured, and marks the waterline
   where SAM's mask of that person or car meets the water.

## Run it locally

Needs Node 22.9+ and pnpm, and a Meta Model API key.

```sh
pnpm install
printf 'MODEL_API_KEY=…\nLUSONG_BUDGET_STORE=memory\n' > .env.local
pnpm dev
```

`pnpm test` runs the unit tests against saved SAM responses; they make no API calls.

### Spending limits

Every check reserves its worst-case cost ($0.098: six SAM images and two Muse Spark attempts at the
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
