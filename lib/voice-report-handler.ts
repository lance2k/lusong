import { createHash, randomUUID } from "node:crypto";
import { admit } from "./admission";
import { counts, REPORT_LIFETIME_MS, roleOf, type Point, type Role } from "./answer";
import { budgetFromEnv, MUSE_INPUT_MICROS_PER_TOKEN, MUSE_OUTPUT_MICROS_PER_TOKEN, TRANSCRIBE_MICROS_PER_SECOND, type Budget } from "./budget";
import { clientIp } from "./check-handler";
import { phtTime, voiceHeard } from "./commute-words";
import { beforeDeadline, readBody } from "./deadline";
import { locateSpot } from "./locate";
import { MetaApiError, transcribe } from "./meta";
import { inMetroCebu } from "./metro-cebu";
import { reportStoreFromEnv, toReport, type ReportStore, type StoredVoiceReport } from "./report-store";
import { durationWords, type Timing } from "./report-handler";
import type { ValhallaGate } from "./router";
import { voiceLanguageFrom } from "./voice-language";
import { readVoiceClaim, VOICE_CLAIM_INPUT_TOKEN_BOUND, VOICE_CLAIM_MAX_COMPLETION_TOKENS, type VoiceClaim } from "./voice-claim";
import { MAX_VOICE_FILE_BYTES, MAX_VOICE_MS, parseVoiceWav, wavFromPcm } from "./wav";

/** Voice Transcribe's language hint (dev.meta.ai/docs/speech-to-text: a list of language names). */
const TRANSCRIBE_LANGUAGES = ["Tagalog", "English"] as const;

/** lib/meta.ts makes at most this many attempts per call; a voice report makes one transcribe and one Spark call. */
const ATTEMPTS_PER_CALL = 2;

/** The most one voice report can cost with every retry used, in micro-dollars: 30 s of audio twice, and two claim reads at their caps. */
export const VOICE_RESERVE_MICROS =
  ATTEMPTS_PER_CALL * Math.ceil((MAX_VOICE_MS / 1000) * TRANSCRIBE_MICROS_PER_SECOND) +
  ATTEMPTS_PER_CALL *
    Math.ceil(
      VOICE_CLAIM_INPUT_TOKEN_BOUND * MUSE_INPUT_MICROS_PER_TOKEN + VOICE_CLAIM_MAX_COMPLETION_TOKENS * MUSE_OUTPUT_MICROS_PER_TOKEN,
    );

/** The photo route's timing, with `minReadMs` held back for each of the two calls: transcribe, then the claim. */
export type VoiceTiming = Timing;
export const VOICE_TIMING: VoiceTiming = { budgetMs: 110_000, storeCallMs: 5_000, responseMs: 2_000, minReadMs: 20_000, locateMinMs: 3_000 };

/** The WAV plus the form's boundaries, the two coordinates and the language. */
const MAX_BODY_BYTES = MAX_VOICE_FILE_BYTES + 64 * 1024;
const OUT_OF_TIME = "Lusong ran out of time for this voice note. Try sending it again in a minute.";
const TOO_LONG = "Voice notes can be up to 30 seconds. Record a shorter one.";

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pinFrom(form: FormData): Point | null {
  const lat = Number(form.get("lat"));
  const lon = Number(form.get("lon"));
  if (form.get("lat") === null || form.get("lon") === null || form.get("lat") === "" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/** What the reporter is shown: fixed sentences from the claim's choices, and the place they named. Never the transcript. */
export interface VoiceReportView {
  id: string;
  kind: "voice";
  /** The street /locate named at the phone's location. */
  place: string | null;
  /** The place the speaker named, in their own words, or null. */
  saidPlace: string | null;
  received: string;
  heard: string;
  role: Role;
  counts: boolean;
  effect: string;
}

function viewOf(report: StoredVoiceReport, now: Date, stored: boolean): VoiceReportView {
  const asRule = toReport(report);
  const role = roleOf(asRule, now);
  const live = stored && counts(asRule, now);
  const left = durationWords(REPORT_LIFETIME_MS - (now.getTime() - asRule.receivedAt.getTime()));
  const effect = !stored
    ? "Lusong couldn't save the report, so it doesn't count in anyone's check. Try sending it again in a minute."
    : !live
      ? "Lusong received this voice note over 3 hours ago, so it no longer counts in anyone's check. Record a new one."
      : role === "block"
        ? `Others checking a trip through here will count this spot as not passable for the next ${left}, unless a newer photo of the same road shows it clear.`
        : "Others will see this report, but a voice report can't mark a street clear: only a recent photo can.";
  return {
    id: report.id,
    kind: "voice",
    place: report.place,
    saidPlace: report.claim.place,
    received: phtTime(report.receivedAt),
    heard: voiceHeard(report.claim),
    role,
    counts: live,
    effect,
  };
}

export function makeVoiceReportHandler(deps: {
  gate: () => ValhallaGate;
  budget?: () => Budget;
  store?: () => ReportStore | null;
  fetch?: typeof fetch;
  now?: () => Date;
  timing?: VoiceTiming;
}) {
  const timing = deps.timing ?? VOICE_TIMING;
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.store ?? reportStoreFromEnv;
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const now = deps.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    const receivedAt = now();
    // The same chain as lib/report-handler.ts, with a read's minimum held back for each of the two Meta calls.
    const deadline = Date.now() + timing.budgetMs;
    const settleBy = deadline - timing.responseMs;
    const releaseBy = settleBy - timing.storeCallMs;
    const saveBy = releaseBy - timing.storeCallMs;
    const finishBy = deadline - (3 * timing.storeCallMs + timing.responseMs);
    const transcribeBy = finishBy - timing.minReadMs;
    const admitBy = transcribeBy - timing.minReadMs;
    const claimBy = admitBy - timing.storeCallMs;

    const body = await readBody(request, { maxBytes: MAX_BODY_BYTES, deadline: claimBy });
    if (body === "too_large") return fail(413, TOO_LONG);
    if (body === "too_slow") return fail(408, "Lusong didn't receive the whole voice note in time. Try again on a steadier connection.");
    let form: FormData;
    try {
      form = await new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    } catch {
      return fail(400, "Send the voice note as a form upload.");
    }
    const at = pinFrom(form);
    if (!at) return fail(400, "Lusong needs your phone's location to place the report.");
    if (!inMetroCebu(at)) return fail(400, "Lusong takes reports from streets in Metro Cebu only.");
    // Bisaya is refused here too while it is out: voiceLanguageFrom only knows the languages the page offers.
    const language = voiceLanguageFrom(form.get("language"));
    if (!language) return fail(400, "Pick Tagalog or English for your voice note, then record it.");
    const audio = form.get("audio");
    if (!(audio instanceof File)) return fail(400, "No voice note was attached.");
    if (audio.size > MAX_VOICE_FILE_BYTES) return fail(413, TOO_LONG);

    const clip = parseVoiceWav(new Uint8Array(await audio.arrayBuffer()));
    if (!clip.ok) {
      if (clip.reason === "too_long") return fail(413, TOO_LONG);
      if (clip.reason === "wrong_format") return fail(415, "Lusong takes voice notes recorded on this page only (16 kHz mono WAV).");
      if (clip.reason === "too_short") return fail(400, "That voice note is too short. Hold record and say where you are and how deep the water is.");
      return fail(400, "Lusong couldn't read that recording. Record it again on this page.");
    }
    // The samples alone, so a resend with different headers is still the same note.
    const audioHash = createHash("sha256").update(clip.pcm).digest("hex");

    const store = reportStore();
    if (!store) return fail(503, "Lusong can't take reports right now.");
    const release = (by: number) =>
      beforeDeadline(store.releaseVoice(audioHash), by).catch((err: unknown) => {
        console.error("report store unreachable on release:", err instanceof Error ? err.message : err);
      });

    if (Date.now() > claimBy) return fail(503, OUT_OF_TIME);
    const claiming = store.claimVoice(audioHash);
    let claim: Awaited<ReturnType<ReportStore["claimVoice"]>> | "late";
    try {
      claim = await beforeDeadline(claiming, admitBy);
    } catch (err) {
      console.error("report store unreachable on claim:", err instanceof Error ? err.message : err);
      return fail(503, "Lusong can't take reports right now.");
    }
    if (claim === "late") {
      void claiming.then(
        async (c) => {
          if (c.state === "claimed") await release(Infinity);
        },
        () => {},
      );
      return fail(503, OUT_OF_TIME);
    }
    if (claim.state === "duplicate") return Response.json({ duplicate: true, stored: true, report: viewOf(claim.report, receivedAt, true) });
    if (claim.state === "in_flight") return fail(409, "Lusong is already reading this voice note.");

    const admitting = admit(budget(), { clientIp: clientIp(request), reserveMicros: VOICE_RESERVE_MICROS, now: receivedAt });
    const admission = await beforeDeadline(admitting, admitBy);
    if (admission === "late") {
      // No Meta call will start, so a reservation that lands late is refunded in full.
      void admitting.then(
        async (a) => {
          if (a.ok) await a.run.settle(true);
        },
        () => {},
      );
      await release(releaseBy);
      return fail(503, OUT_OF_TIME);
    }
    if (!admission.ok) {
      await release(releaseBy);
      return admission.response();
    }

    const { run } = admission;
    let succeeded = false;
    try {
      if (Date.now() > admitBy) {
        await release(releaseBy);
        succeeded = true;
        return fail(503, OUT_OF_TIME);
      }
      let words: string;
      try {
        words = await transcribe(wavFromPcm(clip.pcm), { languages: TRANSCRIBE_LANGUAGES, deadline: transcribeBy, meter: run.meter });
      } catch (err) {
        console.error("voice transcribe failed:", err instanceof MetaApiError ? err.message : err);
        await release(releaseBy);
        return fail(502, "The transcribing service didn't answer. Try again in a minute.");
      }
      if (words.trim() === "") {
        succeeded = true;
        await release(releaseBy);
        return fail(422, "Lusong couldn't hear any words in that note. Record it again closer to the phone.");
      }

      let said: VoiceClaim;
      try {
        said = await readVoiceClaim(words, { language, meter: run.meter, deadline: finishBy });
      } catch (err) {
        console.error("voice claim failed:", err instanceof MetaApiError ? err.message : err);
        await release(releaseBy);
        return fail(502, "Lusong couldn't make out the report. Try again in a minute.");
      }
      succeeded = true;

      const spot =
        finishBy - Date.now() >= timing.locateMinMs
          ? await locateSpot(at, { fetch: doFetch, gate: deps.gate() }, { deadline: finishBy })
          : { wayId: null, place: null };
      const report: StoredVoiceReport = {
        id: randomUUID(),
        kind: "voice",
        at,
        wayId: spot.wayId,
        place: spot.place,
        receivedAt: receivedAt.toISOString(),
        claim: said,
        audioHash,
      };
      let saved: void | "late";
      try {
        saved = await beforeDeadline(store.save(report), saveBy);
      } catch (err) {
        console.error("report store unreachable on save:", err instanceof Error ? err.message : err);
        saved = "late";
      }
      if (saved === "late") {
        await release(releaseBy);
        return Response.json({ duplicate: false, stored: false, report: viewOf(report, receivedAt, false) });
      }
      return Response.json({ duplicate: false, stored: true, report: viewOf(report, receivedAt, true) });
    } finally {
      // A settle cut off here keeps the whole reservation charged: the safe side.
      await beforeDeadline(run.settle(succeeded), settleBy);
    }
  };
}
