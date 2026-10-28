# Meta Model API: what we measured

Notes from building Lusong against `https://api.meta.ai/v1`, October 2026. Each line says how it was
established.

## SAM 3.1 (`POST /responses`, model `sam-3.1`)

- One noun phrase per request. Comma lists return zero matches (docs, `sam/segmenting`), so Lusong
  sends `flood water`, `person` and `car` as three parallel requests. 3–4 s each from the
  Philippines (measured, 2 photos).
- Non-streaming works and returns the same text grammar as streaming (docs). `@meta-sam/parser`
  only advertises stream parsers, but `formats.segmentation.image().createParser()` takes
  `push(text)` and `finish({ status: "completed" })` for a complete reply (from the package's type
  declarations; used in `lib/sam.ts`).
- A mask raster covers its object's box but is not always 1:1 with the photo: person masks were box
  size + 1 px, while large water masks came back downscaled to 1024 px wide (measured on 9 records).
  Use the mask record's `bounds` to scale, never assume 1:1.
- `usage` reports 0 tokens plus `images_processed`; billing is per image, $2.50 per 1,000 (measured
  usage block; price from the docs).

## Muse Spark 1.3 (`POST /chat/completions`)

- It always reasons: 1,956 and 2,452 output tokens on the two probe photos, of which 1,740 and
  2,200 were reasoning; about $0.01 and 10 s each (measured, 2 calls). Reasoning counts against `max_completion_tokens`, so cap
  it with room to spare and treat `finish_reason: "length"` as a failure.
- `usage.prompt_tokens` and `usage.completion_tokens` carry the counts (measured). A 1600×1600 photo with
  12 listed objects took 3,881 input tokens; 1600×1200 took 2,968 (measured, one draw each, 2026-10-28).
  The same two calls used 4,030 and 4,843 output tokens, close to the 5,000 cap. In the first acceptance
  run an 11-object scene used all 5,000 and failed, so the cap is now 8,000 (measured, one failure in 28
  calls). Output ran at 156–264 tokens/s (median 222, 27 calls), so 8,000 tokens can take about 51 s.
  In the second run the same scene used 6,129 and 7,999 of the 8,000 (2 draws; it finished both), so a
  crowded scene can still run out at 8,000.
- A reply cut off at the cap is HTTP 200 with `finish_reason: "length"`, `content: ""` and a full `usage`
  block: `completion_tokens` equals the cap (measured, one draw, 2026-10-29: the Shah Alam scene at a
  1,500 cap, 1,498 of them reasoning; recorded in `test/fixtures/muse/shah-alam-capped-1500.json`). Lusong
  treats it as "too crowded to read" (`cannot_measure`), charges the reported usage and does not retry.
- `response_format: { type: "json_schema" }` constrains decoding to the schema (docs), which lets the
  model choose from a fixed list of landmarks instead of inventing centimetres.
- `web_search` exists only on the Responses and Messages APIs, not on Chat Completions (docs).
- `muse-spark-1.3` is Standard mode, where content is not used for training; `-contributor` models
  trade that for a lower price (docs, `models`).
