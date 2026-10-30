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
  as 16 kHz WAV. Meta's Voice Transcribe turns it into words (written from Meta's docs; not yet tried live), and Muse Spark turns the words into a fixed-choice
  claim (a place, a depth, passable or not). Neither the audio nor the words are kept or shown, and a voice note
  can warn but never clear. Bisaya is off until it is tested on a real clip.
- **Blurred photos:** a report's photo is shown to others only after SAM 3.1 has found and pixelated every person and
  licence plate in it. SAM found all 9 plates labelled on the 5 test photos that show plates, on both of 2 runs. That
  is too few photos to trust, so photos stay hidden for now, and a report shows its pin and reading.
- **A watcher** re-runs the check every 10 minutes during a window you pick (6–8 a.m., say) and sends a Telegram
  message when the window opens and whenever the answer changes. Switching it off deletes the trip and its history.
  It is live on Telegram through `@lusong_cebu_bot`. A GitHub Actions job runs the 10-minute tick, because Vercel's
  free plan runs scheduled jobs once a day; `docs/watcher-setup.md` has the setup.
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
- 2026-10-29 03:26 PHT `0ff3ac4` docs: README for judges: why, the commits built during the event, why SAM 3.1 and Muse Spark, accuracy, limits
- 2026-10-29 09:45 PHT `e1543a3` docs: split the depth-set numbers into flood scenes and wading scenes
- 2026-10-29 12:52 PHT `ada28af` test: tyre estimates the geometry can produce: an incomplete set stays unsure below 66 cm, confidence at the 25 and 40 cm widths
- 2026-10-29 12:52 PHT `6e08b5f` fix: the page says the tyre estimate assumes a side-on wheel and can read shallow on an angled one
- 2026-10-30 01:16 PHT `cab5003` docs: glossary for the commute check: answer, verdict, report, trip, route, watcher, light vehicle, flood advisory
- 2026-10-30 01:17 PHT `3ec9321` test: real records for the commute check: PAGASA feed and the Central Visayas flood advisory sent 2026-10-25 17:27 PHT, Valhalla Banilad to IT Park plain and with a 330 m box excluded
- 2026-10-30 01:29 PHT `37c648d` feat: a run with no client address reserves against the daily cap and skips the per-address limit
- 2026-10-30 01:30 PHT `01bcdf3` feat: the meter reads usage by operation, so a Muse Spark Responses-API call is charged its tokens, not as SAM images
- 2026-10-30 01:31 PHT `57487da` feat: shared admission: reserve a named amount, meter the run, settle once, refuse with today's messages
- 2026-10-30 01:32 PHT `33da9a4` refactor: the single-photo check admits, meters and settles through the shared admission
- 2026-10-30 01:35 PHT `52a3cf2` fix: a reservation that is not a positive whole number of µ$ is refused as unavailable before either store is touched
- 2026-10-30 01:36 PHT `af5e6ec` fix: a Spark Responses-API reply with no output list keeps its reservation; usage field names cite the live probe
- 2026-10-30 01:36 PHT `279c9fd` merge: #2 shared admission and metering for handlers that call Meta
- 2026-10-30 01:34 PHT `f70ec53` test: real records for the demo trips: Valhalla Mabolo to Business Park plain route, /locate way ids for five sample pins (fetched 2026-10-30 01:32 PHT), and the three Final flood advisories PAGASA sent 2026-10-26 05:20-05:26 PHT
- 2026-10-30 01:39 PHT `94013ef` feat: answer rules v2 as one pure module: counting under 3 h, clear/block/neutral by capability, same spot = newer clear photo within 50 m on the same OSM way, 30 m corridor to the route line, 500 m clear cover under rain, each route judged the same way
- 2026-10-30 01:42 PHT `213786d` test: the first-clear-at-501-m row keeps a 999 m gap, so only the start check can fail it
- 2026-10-30 01:46 PHT `12c2a65` feat: PAGASA flood advisory reader: namespace-aware CAP Atom feed, GFA entries newest first, every area, all-clear and replaced records not active, bounded fetches, bytes and time; anything malformed or failed is unreadable
- 2026-10-30 01:49 PHT `a24ebda` feat: Valhalla motorbike router behind a shared 1-request-a-second slot (SET lusong:valhalla:slot NX PX) claimed before every attempt, bounded wait then busy, no store means no request; way ids from /locate
- 2026-10-30 01:52 PHT `9a09f69` feat: demo sample reports: five labelled test-set photos with their recorded verdicts, real origins and credits, pinned on Apas, Mabolo and Business Park streets of the demo routes with /locate way ids
- 2026-10-30 01:52 PHT `d40a590` test: commute-level gate: every recorded depth-set verdict (180 draws) covering the Banilad route under an active advisory is never Go
- 2026-10-30 01:53 PHT `a14a07e` feat: commute check wording: depth in body-part words, passability lines credited to Metro Manila's MMDA gauge, report ages and advisory times in PHT
- 2026-10-30 01:56 PHT `e6542d0` feat: the Valhalla slot store from the same environment as the budget; none configured means no routing request
- 2026-10-30 01:56 PHT `9184629` feat: POST /api/commute demo commute check: live PAGASA advisory and Valhalla route, sample reports for the chosen scenario, answer rules pick the answer; unreachable router gives no answer; demo requests only
- 2026-10-30 02:00 PHT `9f9028a` feat: commute check on the page: demo trip and sample-report choice, raining-here tap, the answer first with its reason, the PAGASA advisory, each report with its age, body-part depth, MMDA credit and real origin, route length and time; the single-photo check stays below
- 2026-10-30 02:02 PHT `96671e6` feat: commute checks go through the shared daily admission (1 µ$ reserve, the client's address), before PAGASA or Valhalla is asked; a refusal returns the admission's response
- 2026-10-30 02:09 PHT `86e18c1` test: the newest PAGASA record of the five other regions in the feed (Final advisories, fetched once each 2026-10-30 02:09 PHT), so every region's current state is a real record
- 2026-10-30 02:10 PHT `45b39dc` fix: a Valhalla slot grant is used only when its acknowledgement took at most 500 ms, inside a 1.5 s lease, so request starts stay at least 1 s apart however late the store answers
- 2026-10-30 02:13 PHT `3adad53` fix: the advisory is decided from each region's newest CAP record whatever its age, and a record missing or garbling status, msgType, identifier, sent, expires, responseType or its areas is unreadable, never inactive
- 2026-10-30 02:13 PHT `a930c76` docs: mark the CAP code lists as written from memory, not checked against the OASIS spec
- 2026-10-30 02:13 PHT `ef06fa9` fix: a Valhalla reply with a malformed shape, off-earth points or malformed maneuvers is unreachable, not a thrown error
- 2026-10-30 02:14 PHT `23e435a` fix: the XML reader bounds depth (32), elements (5,000) and namespace declarations (32) and shares scopes, so a pathological document under the byte cap is rejected in milliseconds; a character reference must be whole and an XML character
- 2026-10-30 02:15 PHT `cffe481` fix: an unreadable PAGASA reading is reused for a minute, so demo clicks while PAGASA is down don't each fetch the feed; clicking through every demo choice asks Valhalla once per trip and the feed once
- 2026-10-30 02:16 PHT `fe46d56` fix: changing the trip, the sample reports or the rain tap clears the shown answer and drops any check still in flight; the answer names the inputs it was checked for
- 2026-10-30 02:18 PHT `288f636` merge: #3 demo commute check on preset trips
- 2026-10-30 02:24 PHT `5d6b488` feat: the area excluded around a blocked spot is one 330 m box, matching the 2026-10-30 probe's request; a detour counts only if no segment meets or enters any box and no blocked spot is within its 30 m corridor
- 2026-10-30 02:31 PHT `086aa4d` test: real Valhalla records for go another way (2026-10-30 02:24-02:25 PHT, 3 requests through the gate): Mabolo to Business Park with the flooded corner's 330 m box excluded, no route with IT Park itself excluded, and /locate at the Banilad route's midpoint
- 2026-10-30 02:31 PHT `ba5c256` feat: each route judgement names the reports that block it; on the real Banilad records an unreported detour is Go another way and a detour with its own blocker is Wait
- 2026-10-30 02:31 PHT `9525c1b` feat: a blocked demo route gets one more Valhalla request through the gate with a 330 m box around each blocked spot; a reply that meets a box or passes a blocked spot is no detour; the detour is judged on its own reports and shown with its extra km and minutes; the Banilad flooded sample moves to the probe's spot so the demo reaches Go another way
- 2026-10-30 02:32 PHT `76344b4` feat: the page shows the other way beside the usual one: its length, time and streets, how much longer it is in km and minutes, and which reports lie on it
- 2026-10-30 02:41 PHT `da575e5` test: a route lying inside an excluded box, or starting there, enters it; the end-point inside test after the first point is dropped, since a connected line can only get in by crossing an edge
- 2026-10-30 02:51 PHT `f28641c` feat: demo scenario 'a flooded spot with no way around' on Banilad → IT Park: a labelled Shah Alam 2021 sample with its recorded NPATV verdict at IT Park, where the saved Valhalla reply found no path, gives Wait; scenarios can belong to one trip; handler tests answer each detour request only with the saved reply to that exact request
- 2026-10-30 02:51 PHT `23bf004` feat: the page offers each trip only its own scenarios, and switching to a trip that lacks the chosen one falls back to no reports
- 2026-10-30 03:00 PHT `d984131` fix: every route is judged with the trip's own start and end joined on, and only when its ends lie within 50 m of them: a plain route that doesn't reach them gives no answer, a detour that doesn't is no way around (tests on fixtures derived from the saved Banilad records)
- 2026-10-30 03:03 PHT `e932435` fix: an advisory area is in Cebu when its name, a SAME geocode starting 0722 or a polygon holding Cebu City says so, outside only when every indicator is readable and says outside and one is a geocode or polygon, otherwise the record is unreadable; all 24 areas of the 10 saved PAGASA records read as before
- 2026-10-30 03:05 PHT `a10ac84` fix: a route shape with a character outside the polyline encoding, or a value longer than six 5-bit chunks, is unreadable rather than decoded into plausible points
- 2026-10-30 03:09 PHT `9aa3611` test: an advisory polygon whose ring isn't closed is unreadable, not outside Cebu
- 2026-10-30 03:12 PHT `571ae91` merge: #4 go another way
- 2026-10-30 02:24 PHT `a8a4a50` feat: read a photo's EXIF capture time (DateTimeOriginal, as PHT) before metadata is stripped, and carry only that field past the page's canvas re-encode; real fixture: the Commons original's EXIF from a realme GT 6
- 2026-10-30 02:26 PHT `04aceaf` feat: report store in the budget's Upstash database: record, index and photo hash written with one expiry (3 h + a 10 min margin), reads only reports under 3 h old, one claim per photo hash so a resend is a duplicate; memory store never chosen when deployed
- 2026-10-30 02:27 PHT `69f24fe` feat: a reported spot's OSM way and street from one Valhalla /locate through the shared gate, never retried; any failure is no way id
- 2026-10-30 02:31 PHT `abf73db` feat: POST /api/report: a photo report with the phone's location goes through the shared admission, the depth reader and one /locate, and stores pin, times, verdict and photo hash, never the photo; a resend of the same stripped photo within 3 h is the same report, found before admission and the paid read; a dry photo clears only if its EXIF time is within the hour before receipt
- 2026-10-30 02:34 PHT `b81771f` feat: Report a street on the page: the phone's location and a photo whose only kept metadata is its capture time; the reporter sees Lusong's reading in body-part words, the MMDA line, the street, and whether the report can clear or block the spot for others
- 2026-10-30 02:42 PHT `a60c0b0` fix: one deadline for the whole report request (110 s, under the route's 120 s): the photo read ends 12 s before it to leave saving and settling their time, /locate is skipped with under 3 s to spare and its gate wait and request are cut off at the deadline
- 2026-10-30 02:43 PHT `0f337e4` fix: the reporter is told what the report does as of now: the time it still counts, that a resend after 3 h no longer counts, and that an unsaved report counts in no one's check
- 2026-10-30 02:43 PHT `2f9ce80` docs: photo-report freshness limits beside the 1 h clearing rule and the 3 h lifetime: phone-set capture time, read as PHT, re-encoded copies not caught as duplicates, upload recency unprovable
- 2026-10-30 03:22 PHT `5577beb` test: real Responses-API records from the 2026-10-30 01:27 PHT probe (3 calls): a custom function call, its function_call_output turn, and a web_search reply capped at 3,000 output tokens with 11 search actions
- 2026-10-30 03:23 PHT `68e0afe` feat: the meter counts each web_search_call item as one search query and the cost adds $2.50 per 1,000 queries to the tokens, so a search is charged in full and an overrun past the reservation is charged too
- 2026-10-30 03:24 PHT `77384db` feat: Muse Spark Responses-API reader and call: function calls with their call ids, the final message apart from commentary, web search actions, and a malformed reply read as failed (tests on the three real probe records)
- 2026-10-30 03:26 PHT `5730229` feat: real commute checks: a trip's start and end in the body (Philippines, up to 50 km), the same admission, the stored real reports read before routing and judged on the plain route and any detour; no sample ever, a failed or missing report store gives no answer, and nothing about the trip is cached or stored; demo checks never read the store
- 2026-10-30 03:27 PHT `a3c2e2f` feat: Muse Spark investigation: reports gathered along the plain route and the rules' way around, the model's read_advisory and reports_near_route calls answered from that evidence, its final message shown as its explanation under the rules' answer
- 2026-10-30 03:28 PHT `a52f41d` feat: the model's explanation is shown only when it agrees with the rules' answer: naming another answer, calling the way safe or clear under anything but Go, empty, over 600 characters or over five sentences gives the rules' own reason; control characters flattened
- 2026-10-30 03:29 PHT `0d3121a` feat: a Muse Spark error, timeout, cut-off or malformed reply leaves the rules' answer and its evidence, with "Muse Spark's explanation is unavailable"; no call is started past the deadline
- 2026-10-30 03:30 PHT `9974137` feat: route_around: the model may ask once for a way around up to three Metro Cebu spots; Lusong also avoids every blocked spot, rejects a way that still meets one, gathers the reports along it and judges it by the same rules; a report store that can't be read, there or anywhere, gives no answer
- 2026-10-30 03:31 PHT `8beb20b` feat: the investigation's cost bounds: at most 3 model calls, 3 tool calls a turn and 5 in all (more ends it without an explanation), 3,000 output tokens a call, tool results cut to 2,000 bytes and the first turn's summary to 3,000, with a last-turn note to write
- 2026-10-30 03:34 PHT `cf5e444` feat: one Muse Spark web search for road closures in Metro Cebu today, shared by every check for 30 minutes under lusong:muse:road-closures (a failed one for 5): findings need a place and an http(s) link, keep a location only inside Metro Cebu and a date only as YYYY-MM-DD; a located finding goes to the rules as a web report, which blocks only when dated today and never clears; no shared store means no search
- 2026-10-30 03:35 PHT `1879da5` feat: the investigation reserves its bounded worst case through the shared admission: three turns at their input and output caps, every call retried, plus a cold check's one search at 200,000 input tokens, 4,000 output and 22 queries; settlement charges the search fee, keeps the reservation on a retry or partial or missing usage, and charges a search overrun in full
- 2026-10-30 03:36 PHT `e296892` feat: the shared web search store from the budget's environment (Upstash or Vercel KV names, the local memory switch, none when deployed with it), tested against the local Upstash stand-in when one is up
- 2026-10-30 03:37 PHT `af07de0` fix: real trips and photo reports are taken in Metro Cebu only (a named box over Cebu City, Mandaue, Lapu-Lapu, Talisay, Consolacion, Liloan, Minglanilla and Cordova), since the advisory Lusong reads is Cebu's; anything else is refused before any request
- 2026-10-30 03:37 PHT `d4356ea` feat: the investigation's model calls end 45 s after the check starts (investigationDeadline), and the model's way around is asked for only with 12 s left
- 2026-10-30 03:43 PHT `b54e592` test: the rules' own way around that still meets a blocked spot is not taken, a stored search past its own expiry is searched again, at most 8 findings are kept; the loop's turn cap is its only bound, and the deadline is checked where the call starts
- 2026-10-30 03:43 PHT `f3e7ab2` fix: the report deadline starts at the first byte: the body is read under a size cap and cut off with 408 when it stalls, claim and admission start only with time left for a read and are abandoned (claim freed, late reservation refunded in full) when they run late, and save, release and settle each get a 5 s slot of the 17 s reserve
- 2026-10-30 03:47 PHT `538d244` fix: one deadline for the whole commute check (50 s, under the route's 60 s): the body, the admission, the report read, the advisory and every routing attempt and gate wait end in time for the settle; running short is a 503 with no answer
- 2026-10-30 03:50 PHT `50f314e` fix: a web finding enters the answer rules only when located and dated today in PHT; an undated one, one dated yesterday, or one cached from before PHT midnight is shown and leaves the answer as it was without it (review 🟡1, per 🔴P8)
- 2026-10-30 03:52 PHT `34db1eb` fix: Muse Spark writes a structured summary (answer, one to four sentences each citing gathered evidence ids) shown below the rules' reason only when its answer is the rules', every citation was gathered, it is within bounds, it has no PATV wording and, unless the answer is Go, no English, Tagalog or Cebuano words telling the rider to go; otherwise only the rules' reason shows (review 🟡2)
- 2026-10-30 03:53 PHT `dc9e23e` build: add Leaflet 1.9.4 (and its types) for the trip map, bundled rather than from a CDN
- 2026-10-30 03:54 PHT `65139b8` feat: a trip module: home then work tapped once in Metro Cebu, kept on the phone and cleared on request, working without storage
- 2026-10-30 03:54 PHT `3528754` test: the page's own-trip check request is a real check's start and end only, and leaves the report store as it was
- 2026-10-30 03:55 PHT `2a1623d` feat: each report in a commute answer carries its spot, for its pin on the map
- 2026-10-30 03:55 PHT `374bec6` fix: web search has its own daily cap ($3, ledger under lusong:search in the budget's store), reserved before a cold search and settled at the search's metered cost; past it, or with the ledger unreadable, the check runs without web search and says why; one search now serves every check for 60 minutes (review 🟡3)
- 2026-10-30 03:58 PHT `25c2d4f` feat: the commute check's state has a choice of your own trip, which never carries a sample scenario
- 2026-10-30 03:58 PHT `823e9fb` feat: a Leaflet map on OpenStreetMap tiles shows the route, the detour dashed and the report pins with their ages; your trip is tapped on it, kept on the phone and checked for real
- 2026-10-30 04:02 PHT `64b3922` feat: the demo commute check runs Muse Spark's investigation: the shared web search planned before admission and released on refusal, the investigation reserved on top of the 1 µ$, the rules' reason first with the labelled summary and the web findings (each with its link and whether it counts) beside it; one 80 s deadline for the whole check under a 90 s maxDuration, a way around started only with time for Valhalla's worst case, else a controlled 503
- 2026-10-30 04:03 PHT `2293796` feat: the commute page shows Muse Spark's labelled summary below the rules' reason as plain text (or that it is unavailable), the web search line and each web finding with its link and whether it counts, and says when Muse Spark suggested the way around
- 2026-10-30 04:04 PHT `98218b2` fix: the map keeps Leaflet's classes when tapping starts (React no longer rewrites its div), its zoom buttons stay 44 px, popups open clear of them, the legend doesn't break mid-label, and a saved trip is chosen on reload
- 2026-10-30 04:05 PHT `ed7f437` test: a demo check with Muse Spark settles through the shared admission at its metered cost: success, retry, partial usage, missing usage, and a search overrun charged in full past the reservation
- 2026-10-30 04:07 PHT `213034c` test: one live demo commute check with Muse Spark, behind LUSONG_LIVE, writing its calls, usage and page to JSON
- 2026-10-30 04:14 PHT `161002e` fix: the map opens and stays on a fixed Metro Cebu view until a check is sent, so OpenStreetMap's tile server never sees a saved trip's area on load; after a check it fits the routes only, and the page says the tile server sees the area you look at
- 2026-10-30 04:16 PHT `9dc730a` fix: a real commute answer carries only the reports on its routes; one off both routes played no part, and its exact spot isn't sent to the rider
- 2026-10-30 04:18 PHT `b75dd26` fix: a trip cleared or changed in another tab is cleared or changed here too, with any shown answer dropped; a clear the phone refuses keeps showing the trip and says it is still saved
- 2026-10-30 04:52 PHT `9a8b34d` fix: rain_tap is gathered evidence whether or not the rider tapped (review 🟡4)
- 2026-10-30 05:03 PHT `6342022` fix: no word Muse Spark writes reaches the page: it picks up to 4 gathered evidence ids for the rules' answer, and Lusong describes each in its own sentence from the evidence's checked fields; the phrase checks are gone (review 🔴1)
- 2026-10-30 05:08 PHT `693813a` fix: a web finding keeps no words of the source's but a checked place name: it is shown as Lusong's description of its kind (closed, flooded, not passable or blocked), site and date, and stored findings are re-checked (review 🔴2)
- 2026-10-30 05:12 PHT `ec0d7b2` fix: one web search at a time: a shared lease (SET NX PX under lusong:) taken after a cache miss, the cache read again once held and the lease given back on every path; a result never replaces one from a later search, nor a fresh success with a failure (review 🟡3)
- 2026-10-30 05:18 PHT `c7f31ca` test: a 13-word place is dropped, and a stored record is re-searched for its finding alone (mutation pass 4 survivors)
- 2026-10-30 05:28 PHT `96b9d82` merge: #6 and #5 into the candidate (decision 4 pending; not commute-check)
- 2026-10-30 05:38 PHT `dd00d8f` fix: a web finding's link counts only if it is a page the search tool itself opened (open_page) or cited (url_citation) in the same reply, compared without its fragment and with the length limit on the normalised link; any other finding is dropped (review 🔴T7-8)
- 2026-10-30 05:38 PHT `576430f` fix: a web finding's link reads as its site alone on the page, never its path, query or fragment (review 🔴T7-8)
- 2026-10-30 05:38 PHT `9b93643` test: a search with links to Unicode paths is stored and read back from the cache with no second search: the link's limit applies to its normalised form on both sides (review 🟡T7-9)
- 2026-10-30 05:38 PHT `1fcb7b1` fix: a stored search keeps the pages its search opened or cited, and a stored finding whose link isn't one of them, or a record without them, is searched again (review 🔴T7-8)
- 2026-10-30 05:40 PHT `f6e8478` fix: a search is stored only over the stored value it read (compare-and-set: one Lua script on Upstash), so an older search that outlived its lease can't overwrite a newer one stored between its read and its write (review 🟡T7-10)
- 2026-10-30 05:40 PHT `11636fe` feat: a voice note's WAV is checked in full (16 kHz mono 16-bit PCM, the data chunk's real length ending the file, 0.5 to 30 s), and the page's encoder resamples to exactly that
- 2026-10-30 05:41 PHT `cb87db0` feat: the commute check has a scheduled entry for a stored trip: the same real check, admitted with no address so it counts against the daily cap and no address's limit, giving the answer's kind or the status a page would have got
- 2026-10-30 05:41 PHT `036330d` feat: Voice Transcribe is metered as its own operation, in whole seconds at $0.18 per hour, and never counts as a complete reading until a live call has shown its usage
- 2026-10-30 05:42 PHT `2f0bcd6` feat: a Voice Transcribe client from the docs: the WAV and its settings as a multipart upload to /asr/transcribe, retried once like every Meta call, metered as its own operation
- 2026-10-30 05:43 PHT `d92e428` feat: a watch store: a watcher's trip, PHT window, Telegram chat and last answer under lusong:watch:, with a single-use link code under lusong:watch-code:, every key expiring (30 days, 15 minutes), at most 100 live, and runs and answers claimed only for the watcher's current generation
- 2026-10-30 05:44 PHT `5b55507` feat: Muse Spark turns a voice note's words into a claim of fixed choices (depth, passable) and a place label that must be the speaker's own words, capped at 12 words and 80 characters; a claim that says neither is neutral
- 2026-10-30 05:44 PHT `fca87b7` feat: the watcher's tick: each linked watcher in its PHT window is checked at most once in 10 minutes and messaged on Telegram when the window opens and when the answer changes, in Lusong's fixed answer words; a failed check, a switch-off mid-run or an unchanged answer sends nothing, and a tick is capped at 20 checks inside 45 s
- 2026-10-30 05:46 PHT `6f797e7` feat: the report store keeps voice reports (kind voice: pin, way, times, the claim's choices and the audio's hash) under the same keys and expiry as photos, with their own duplicate claim; no audio or transcript
- 2026-10-30 05:47 PHT `f7de992` feat: /api/watch switches a watcher on (through the per-address admission, a token for the phone and a 15-minute Telegram link), reports it, relinks it and switches it off, deleting every key; /api/watch/telegram binds a private chat on /start with the code, and /api/watch/tick runs the tick; both refuse every call while their secret is unset and compare it in constant time
- 2026-10-30 05:50 PHT `a5bbea1` feat: the own-trip panel has the watcher's switch: a PHT window, a Telegram link that works once for 15 minutes, its state once linked, and off; the phone keeps the token, and the panel says the server keeps the trip's points, window and chat while it is on and how they are deleted
- 2026-10-30 05:50 PHT `53bbc51` docs: the owner's watcher setup: BotFather, the four env vars for Vercel Preview, setWebhook with its secret token, a QStash schedule every 10 minutes, and a one-message test; the glossary gains window and tick
- 2026-10-30 05:50 PHT `a78c6ff` test: on the saved Banilad → IT Park route, a voice report saying passable clears nothing (a blocking photo still blocks, and alone it is no Go) and one saying knee-deep blocks; a commute answer shows a voice report in fixed sentences from its claim
- 2026-10-30 05:56 PHT `4ec3b24` feat: POST /api/report/voice: a voice note with the phone's location is checked in full before admission, reserved as its own operation, transcribed (Tagalog and English), read into a claim by Muse Spark and stored with its pin, all inside one 110 s deadline; Bisaya is refused until the clip probe
- 2026-10-30 05:59 PHT `d16b84e` feat: Record a voice note on the report form: the microphone is asked for only on the tap, PCM is captured through an AudioWorklet (ScriptProcessor where there is none), encoded as 16 kHz mono 16-bit WAV in the browser, stopped at 30 s with a visible countdown, and sent with the phone's location
- 2026-10-30 06:01 PHT `8cc751a` merge: #7 into the candidate (decision 8 pending; not commute-check)
- 2026-10-30 06:01 PHT `86f9cf9` fix: the watcher reads the clock again before each check and before it sends, so a check that runs past the window's end, or starts after it, sends nothing, and a message tells the time it was sent
- 2026-10-30 06:04 PHT `7db9b35` fix: the watcher records the answer it is about to send before it sends it, so a message Telegram took is never sent again when recording it fails or Telegram's reply times out; only a message Telegram refused (a 4XX) is tried again at the next check
- 2026-10-30 06:06 PHT `6d09cac` fix: switching a watcher off waits for a message being sent to it (up to 10 s) before deleting it, and a tick sends only while it holds the watcher's send lease, so no message arrives after the phone hears the watcher is off
- 2026-10-30 06:07 PHT `b4d6394` fix: when the browser won't keep the watcher's key, switching on switches the watcher off again at once (trying three times), shows no Telegram link and says why, so no watcher is left on the server with nothing able to delete it
- 2026-10-30 06:07 PHT `0e33ccc` test: a real-trip check runs Muse Spark's investigation on the stored reports it read, as a demo check does; one whose report store, router or slot store stalls ends by the deadline with its reservation settled and an unused web search given back
- 2026-10-30 06:10 PHT `c1ce6a3` fix: a voice note must say which language it is in, Tagalog or English; one with no language, an empty or unknown one, or Bisaya while it is out is refused before admission, with nothing reserved, sent to Meta or stored, and the old tl-en default is gone
- 2026-10-30 06:11 PHT `222b0c5` fix: Muse Spark is told which language the rider picked and answers unsure when the words can't be read as a flood report in it; an unsure note is stored as saying nothing about the water, so it blocks nothing
- 2026-10-30 06:13 PHT `3c4280d` fix: the voice note asks Tagalog or English before recording, with neither picked, and can't record until one is; the page always sends that language, offers no Bisaya while it is out, and says in one line that Bisaya notes aren't supported yet
- 2026-10-30 06:18 PHT `a075709` fix: each claim on a photo or voice note carries its own token, and a save writes only while that token still holds the hash; once a hash names a saved report, another save hands that report back and writes no second report or index entry
- 2026-10-30 06:18 PHT `73cdb98` fix: a message whose delivery was uncertain stays the last one sent when the next answer is refused or called off, so the rider never gets the same answer twice
- 2026-10-30 06:20 PHT `8fd79e1` fix: a voice report whose save times out or fails without an answer keeps its claim until it lapses, so a resend isn't read and paid for again, and the reporter is told Lusong couldn't confirm the save instead of being told it wasn't stored
- 2026-10-30 06:20 PHT `2c624e8` fix: the watcher reads the clock again after recording the answer it is about to send, so a recording that runs past the window's end sends nothing and keeps the last answer sent
- 2026-10-30 06:22 PHT `4737678` fix: when a voice recording fails to start after the microphone was allowed (the capture module won't load, the audio context won't resume, the capture node can't be made), the microphone's tracks are stopped and the audio context closed
- 2026-10-30 06:22 PHT `9fde17c` fix: a voice recording that finishes starting after the page has gone away is let go at once: the microphone's tracks stopped, the audio context closed, and nothing captured
- 2026-10-30 06:27 PHT `f49fd5a` fix: Muse Spark's pick is described only from the reports the response sends, so a real report off both routes never reaches the rider through it, even when the model names its id (review 🔴C-3)
- 2026-10-30 06:27 PHT `47ce549` fix: Muse Spark can pick only the reports on a judged route; a stored report off every route is no evidence it can name (review 🔴C-3)
- 2026-10-30 06:28 PHT `6e4032a` test: a test of a web search that never answers now reaches it and says so: the room kept for the model's pick is part of the timing tests scale down, where a fixed 15 s ended the search before it started (review 🔴C-2)
- 2026-10-30 06:31 PHT `e119bec` fix: planning the web search ends by the check's deadline: no cache read, lease or search reservation starts after it, one granted too late is given back in the background (a reservation settled as failed), and a check whose planning used the deadline reserves nothing and says it ran out of time (review 🔴C-1)
- 2026-10-30 06:33 PHT `8fe5dce` fix: a page that goes away while a voice recording is still starting lets the microphone go at once, even when the audio context's resume or the capture module's load never returns, and the start gives up instead of waiting on it
- 2026-10-30 06:35 PHT `6a4c221` fix: a voice recording that is stopped or cancelled stops listening for the page going away, detaches its capture callback and drops its audio, so repeated recordings no longer pile up audio and browser objects until the page closes
- 2026-10-30 06:36 PHT `dc76067` fix: a web search that ran ends by the check's deadline too: its settle, the cache read and write and the lease's release are each cut off there, nothing is stored after it and the lease is still given back, so the check's own settle is always reached (review 🔴C-2)
- 2026-10-30 06:15 PHT `49472e6` build: add sharp (already locked through next) to decode and re-encode report photos, and @vercel/blob for the blurred-photo store
- 2026-10-30 06:15 PHT `20f4883` test: plate probe for SAM 3.1: 5 fixture photos with 9 sure plates and 2 vehicle negatives, both prompts scored by mask coverage of hand-drawn boxes, skipped unless LUSONG_LIVE=1 with LUSONG_LIVE_OUT
- 2026-10-30 06:17 PHT `18bc5ba` feat: blurMasked pixelates every pixel under a SAM mask, grown by a margin, to coarse block means and encodes a new JPEG from the pixels alone, with no EXIF, XMP or ICC and no byte of the original
- 2026-10-30 06:18 PHT `745d3b8` feat: BlobStore for blurred report photos: an in-memory store for tests, a Vercel Blob store behind BLOB_READ_WRITE_TOKEN, and no store at all while the token is unset
- 2026-10-30 06:20 PHT `4364bae` feat: publishPhoto shows a report photo only when both SAM calls parsed in full, the blur worked and the store took the blurred JPEG; PLATE_DETECTION_TRUSTED = false keeps every photo hidden until the plate probe is in
- 2026-10-30 06:41 PHT `fd1db0a` fix: a SAM reply counts toward a published photo only when Meta says the response completed, its text ends on a line break, and it holds no parse error, no stray text and no unpaired box; a reply cut between two objects, a cut-off header or prose now shows no photo
- 2026-10-30 06:43 PHT `b0e4801` fix: a SAM reply with a mask that has no pixel set shows no photo, since blurring that mask would leave its person or plate in plain view; neither the blur nor the store runs
- 2026-10-30 06:44 PHT `2e8f1ba` fix: the plate probe reads each SAM reply with the same strict check publishing uses, records a malformed reply as a failed call that finds nothing, keeps Meta's status, and counts calls that ran apart from calls that failed for plate photos and negatives alike
- 2026-10-30 06:44 PHT `3353f29` test: re-score recorded plate probes offline under the strict reply check, from each call's recorded text, skipped unless LUSONG_RESCORE_IN and LUSONG_RESCORE_OUT are set; no SAM call
- 2026-10-30 06:53 PHT `b7b922a` feat: a photo report publishes a blurred copy of its photo once plate detection is trusted and a blob store exists: the depth reader's person reply is reused, one license plate call is made on the same meter and covered by a larger reservation, and only the blurred photo's URL is saved on the record; any failure, or too little time left, keeps the pin and reading with no photo
- 2026-10-30 06:55 PHT `930a262` feat: a commute check sends each real report's blurred photo URL to the page when one was published, and null otherwise; sample reports carry none
- 2026-10-30 06:56 PHT `6a794d6` feat: a report's blurred photo shows on its map pin's popup and in the commute check's evidence list when the report has one, with a plain alt text; the evidence item moves to its own file so it can be rendered in a test
- 2026-10-30 06:59 PHT `dcca8c4` fix: a report the rules count on any way around Lusong judged can be picked and is always sent, with the routes it lies on, so a pick of one on a way around the page doesn't show is no longer dropped with the rest of the pick (review 🔴C-4)
- 2026-10-30 07:10 PHT `35fe3cc` fix: a SAM reply counts as zero objects only when Meta's completed reply holds explicit output_text strings; a bare completed status, a refusal, missing or non-string text, no output, or a message with no status of its own is a failed call, so the photo is not published
- 2026-10-30 07:16 PHT `90f9eba` merge: #9 voice reports into candidate/all
- 2026-10-30 07:17 PHT `3e47326` test: a stored voice report reaches Muse Spark's investigation as a photo report does: reports_near_route reads it as voice, its pick is shown in Lusong's words and never the speaker's place, one off both judged routes is no more pickable than a photo there, and an unsure one is neutral evidence
- 2026-10-30 07:17 PHT `3389a8e` fix: a report save that times out or fails no longer deletes its blurred photo while the save may still commit; the photo is deleted only once the store answers that it wrote nothing, so no stored report points at a deleted photo
- 2026-10-30 07:21 PHT `df0b7e6` fix: a photo reads as no flood only when all four SAM calls completed; a failed or malformed flood water, person, car or tire reply makes the reading set incomplete, so a dry-looking photo cannot be measured instead of clearing a blocked spot
- 2026-10-30 07:25 PHT `8c8688b` merge: #10 watcher into candidate/all
- 2026-10-30 07:35 PHT `7bd2ca8` test: the watcher's scheduled check runs Muse Spark's investigation as the page's check does: the same reservation, the stored report read through reports_near_route, only the answer's kind returned; one whose search and model never answer ends by the caller's deadline with its settle
- 2026-10-30 07:36 PHT `9ad1f57` docs: README for judges: the commute check, its answer rules, Muse Spark's investigation and its limits
- 2026-10-30 07:36 PHT `cf3c2a3` docs: the README names where the sample photos were really taken
- 2026-10-30 07:44 PHT `c113d76` merge: #8 blurred photos into candidate/all
- 2026-10-30 07:58 PHT `0de874f` test: commute-handler tests never reach Meta for real: each test refuses and records any api.meta.ai call and fails on one, and the six handlers built without muse now pass MUSE_OFF, since the file's MODEL_API_KEY turned Muse Spark on for them
- 2026-10-30 07:58 PHT `07961cf` test: commute-handler tests never reach Meta for real: each test refuses and records any api.meta.ai call and fails on one, and the six handlers built without muse now pass MUSE_OFF, since the file's MODEL_API_KEY turned Muse Spark on for them
- 2026-10-30 08:08 PHT `f35012e` merge: the README and the test guard from candidate/with-6-5
- 2026-10-30 08:08 PHT `a072800` docs: the README describes voice notes, blurred photos and the watcher
- 2026-10-30 08:08 PHT `fa4d6a9` docs: the README says how far the plate probe and the voice path were tested
- 2026-10-30 08:21 PHT `c3e73ab` test: acceptance gate passes on candidate/all, 15 photos × 2 draws at fa4d6a9 (5 under-reads, 6 can't-measure, as at 6fa88e6)
- 2026-10-30 08:21 PHT `04ea1a8` docs: README commit list rebuilt from git
- 2026-10-30 09:15 PHT `a95cd47` merge: #5–#10 into commute-check (Lance said yes to decisions 4, 8 and 9)
- 2026-10-30 09:36 PHT `1a36cfb` docs: README commit list rebuilt from git
- 2026-10-31 04:21 PHT `2b445ae` ci: run the watcher's tick every 10 minutes from GitHub Actions
- 2026-10-31 06:29 PHT `a211104` test: the Upstash store takes a clock, so report tests no longer fail once their fixed date is older than the TTL
- 2026-10-31 06:30 PHT `494d9f8` ci: the watcher's tick runs off the round minutes, since no scheduled run had started 2 h after the schedule merged
- 2026-10-31 06:37 PHT `55a115e` test: a save prunes index entries older than its clock minus the expiry and keeps the one exactly at it
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
