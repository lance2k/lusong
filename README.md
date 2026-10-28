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
   where MMDA names that body part. The deepest reading decides: under 33 cm passable to all
   vehicles (PATV), 33–66 cm not passable to light vehicles (NPLV), 66 cm and up not passable to
   any (NPATV). One reading alone never says "passable". With no person or car in the water, it
   says it can't measure.
5. The page draws the water mask, boxes each person and car it measured, and marks the waterline
   where SAM's mask of that person or car meets the water.

## Run it locally

Needs Node 22.9+ and pnpm, and a Meta Model API key.

```sh
pnpm install
echo 'MODEL_API_KEY=…' > .env.local
pnpm dev
```

`pnpm test` runs the unit tests against saved SAM responses; they make no API calls.
