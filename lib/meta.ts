import type { MeteredUsage } from "./budget";
import { samReplyOf, type SamReply } from "./sam";

const BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_RETRY_WAIT_MS = 500;
/** A retry is only worth starting if this much time is left after its wait. */
const MIN_ATTEMPT_MS = 2000;

/** Carries only the status, never the upstream body, so nothing from Meta leaks to a client. */
export class MetaApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
  ) {
    super(`Meta API ${endpoint} failed${status ? ` with HTTP ${status}` : ""}`);
  }
}

/**
 * Muse Spark stopped at max_completion_tokens before writing its answer (finish_reason "length"; the
 * reasoning counts against the cap). Measured 2026-10-29 at a 1,500 cap: HTTP 200, empty content, usage
 * present, so the meter has already charged it. Not retried: the same photo would run out again.
 */
export class OutputCapError extends MetaApiError {
  constructor() {
    super("/chat/completions", 0);
  }
}

function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * What a call was, which decides how its usage is read and priced. web_search joins this list once a
 * live probe has shown its usage shape and it has a price in lib/budget.ts.
 */
export type Operation = "sam" | "spark-chat" | "spark-responses" | "voice-transcribe";

/** Responses-API output items billed only through the reply's tokens. Any other item, such as
 *  `web_search_call`, may carry a fee of its own that the meter cannot count yet. */
const TOKEN_PRICED_OUTPUT = new Set(["message", "reasoning", "function_call"]);

type Usage = Record<string, unknown> | undefined;
/** The counts a reply reports, as a floor; `complete` is false when a billed count may be missing. */
type Reading = { samImages?: number; museInputTokens?: number; museOutputTokens?: number; transcribeSeconds?: number; complete: boolean };

function tokens(input: number | null, output: number | null): Reading {
  return { museInputTokens: input ?? 0, museOutputTokens: output ?? 0, complete: input !== null && output !== null };
}

const READERS: Record<Operation, (usage: Usage, body: unknown) => Reading> = {
  sam(usage) {
    const images = countOf(usage?.images_processed);
    return { samImages: images ?? 0, complete: images !== null };
  },
  "spark-chat"(usage) {
    return tokens(countOf(usage?.prompt_tokens), countOf(usage?.completion_tokens));
  },
  // Field names and the `web_search_call` item type from a live probe, 2026-10-30, 3 calls.
  "spark-responses"(usage, body) {
    const reading = tokens(countOf(usage?.input_tokens), countOf(usage?.output_tokens));
    const output = (body as { output?: unknown } | null)?.output;
    const unreadable = !Array.isArray(output);
    const unpriced = !unreadable && output.some((item: { type?: unknown } | null) => !TOKEN_PRICED_OUTPUT.has(String(item?.type)));
    return unreadable || unpriced ? { ...reading, complete: false } : reading;
  },
  /**
   * Billed per whole second of audio, rounded down; `audioDurationMs` is the reply's "Total audio duration processed"
   * (dev.meta.ai/docs/api-reference/voice/schemas, read 2026-10-30). UNVERIFIED: no live call has shown that field or
   * that it is what is billed, so the count is never complete and a settle keeps the whole reservation.
   */
  "voice-transcribe"(_usage, body) {
    const ms = countOf((body as { audioDurationMs?: unknown } | null)?.audioDurationMs);
    return { transcribeSeconds: ms === null ? 0 : Math.floor(ms / 1000), complete: false };
  },
};

/** Adds up what one run's Meta calls report using, attempt by attempt, for the spending budget. */
export class Meter {
  private samImages = 0;
  private museInputTokens = 0;
  private museOutputTokens = 0;
  private transcribeSeconds = 0;
  private complete = true;

  /** A failed attempt may still have been billed, and it is the only way a call gets retried. */
  failedAttempt(): void {
    this.complete = false;
  }

  reply(operation: Operation, body: unknown): void {
    const usage = (body as { usage?: Record<string, unknown> } | null)?.usage;
    const reading = READERS[operation](usage, body);
    if (!reading.complete) this.complete = false;
    this.samImages += reading.samImages ?? 0;
    this.museInputTokens += reading.museInputTokens ?? 0;
    this.museOutputTokens += reading.museOutputTokens ?? 0;
    this.transcribeSeconds += reading.transcribeSeconds ?? 0;
  }

  usage(): MeteredUsage {
    const { samImages, museInputTokens, museOutputTokens, transcribeSeconds, complete } = this;
    return { samImages, museInputTokens, museOutputTokens, transcribeSeconds, complete };
  }
}

function apiKey(): string {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set");
  return key;
}

/** Retry-After is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3). */
function retryWaitMs(res: Response): number {
  const header = res.headers.get("retry-after")?.trim();
  if (!header) return DEFAULT_RETRY_WAIT_MS;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : DEFAULT_RETRY_WAIT_MS;
}

/** A JSON request body, or a multipart form (fetch writes its boundary). A FormData can be sent again on a retry. */
type Payload = { json: unknown } | { form: FormData };

function requestOf(payload: Payload): { headers: Record<string, string>; body: string | FormData } {
  const auth = { Authorization: `Bearer ${apiKey()}` };
  if ("form" in payload) return { headers: { ...auth, Accept: "application/json" }, body: payload.form };
  return { headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(payload.json) };
}

/**
 * POSTs with at most one retry, on 429, 5xx or a dropped connection, and returns the JSON reply. Every
 * attempt and every wait must fit before `deadline` (epoch ms); a Retry-After that does not fit fails
 * the call rather than retrying early. A timeout is not retried.
 */
async function postJson(
  endpoint: string,
  operation: Operation,
  payload: Payload,
  attemptTimeoutMs: number,
  deadline: number,
  meter: Meter,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new MetaApiError(endpoint, 0);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        ...requestOf(payload),
        signal: AbortSignal.timeout(Math.min(attemptTimeoutMs, remaining)),
      });
    } catch (err) {
      meter.failedAttempt();
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      if (attempt === 1 && !timedOut && deadline - Date.now() > MIN_ATTEMPT_MS) continue;
      throw new MetaApiError(endpoint, 0);
    }
    if (res.ok) {
      const reply = await res.json().catch(() => {
        meter.failedAttempt();
        throw new MetaApiError(endpoint, res.status);
      });
      meter.reply(operation, reply);
      return reply;
    }
    meter.failedAttempt();
    const wait = retryWaitMs(res);
    if (attempt === 1 && (res.status === 429 || res.status >= 500) && deadline - Date.now() - wait > MIN_ATTEMPT_MS) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    throw new MetaApiError(endpoint, res.status);
  }
}

/** One SAM 3.1 concept prompt on one image; returns the raw segmentation text. */
export async function segment(imageDataUrl: string, phrase: string, deadline: number, meter: Meter): Promise<string> {
  return (await segmentReply(imageDataUrl, phrase, deadline, meter)).text;
}

/** One SAM 3.1 concept prompt on one image; returns the segmentation text with Meta's status for the response. */
export async function segmentReply(imageDataUrl: string, phrase: string, deadline: number, meter: Meter): Promise<SamReply> {
  const body = await postJson(
    "/responses",
    "sam",
    {
      json: {
        model: "sam-3.1",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: phrase },
              { type: "input_image", image_url: imageDataUrl },
            ],
          },
        ],
        metadata: { mask_encoding: "one_bit" },
      },
    },
    20_000,
    deadline,
    meter,
  );
  return samReplyOf(body as Parameters<typeof samReplyOf>[0]);
}

interface ChatCompletion {
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
}

/** Muse Spark 1.3 chat completion constrained to a JSON schema; returns the parsed object. */
export async function chatJson(request: {
  messages: unknown[];
  schemaName: string;
  schema: object;
  maxCompletionTokens: number;
  deadline: number;
  meter: Meter;
}): Promise<unknown> {
  const body = (await postJson(
    "/chat/completions",
    "spark-chat",
    {
      json: {
        model: "muse-spark-1.3",
        messages: request.messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: request.schemaName, schema: request.schema, strict: true },
        },
        max_completion_tokens: request.maxCompletionTokens,
      },
    },
    // 8,000 output tokens at the slowest measured rate (156 tokens/s, 27 draws) take about 51 s.
    70_000,
    request.deadline,
    request.meter,
  )) as ChatCompletion;
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") throw new OutputCapError();
  if (!choice?.message?.content) throw new MetaApiError("/chat/completions", 0);
  return JSON.parse(choice.message.content);
}

/**
 * Muse Voice Transcribe on one complete clip, as the buffered JSON reply (dev.meta.ai/docs/api-reference/voice/transcribe
 * and /voice/schemas, read 2026-10-30): a `request` part of settings as JSON and an `audio` part holding the WAV. From
 * the docs only; no live call has been made. UNVERIFIED: the reply's `transcript` field and the endpoint's behaviour on
 * a 16 kHz clip, beyond the docs' word that 16 kHz is accepted and resampled.
 */
export async function transcribe(
  wav: Uint8Array<ArrayBuffer>,
  opts: { languages: readonly string[]; deadline: number; meter: Meter },
): Promise<string> {
  const form = new FormData();
  const settings = { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", languageBias: opts.languages };
  form.append("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
  form.append("audio", new File([wav], "note.wav", { type: "audio/wav" }));
  // UNVERIFIED: how long a 30 s clip takes; 20 s per attempt is a guess with room for one retry inside the deadline.
  const reply = await postJson("/asr/transcribe", "voice-transcribe", { form }, 20_000, opts.deadline, opts.meter);
  const body = reply as { transcript?: unknown } | null;
  if (typeof body?.transcript !== "string") throw new MetaApiError("/asr/transcribe", 0);
  return body.transcript;
}
