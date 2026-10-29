import type { MeteredUsage } from "./budget";
import { outputTextOf } from "./sam";

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
 * What a call was, which decides how its usage is read and priced. Voice Transcribe joins this list once a
 * live probe has shown its usage shape and it has a price in lib/budget.ts.
 */
export type Operation = "sam" | "spark-chat" | "spark-responses";

/** Responses-API output items billed only through the reply's tokens. Any other item but `web_search_call`
 *  may carry a fee of its own that the meter cannot count. */
const TOKEN_PRICED_OUTPUT = new Set(["message", "reasoning", "function_call"]);
const WEB_SEARCH_CALL = "web_search_call";

type Usage = Record<string, unknown> | undefined;
/** The counts a reply reports, as a floor; `complete` is false when a billed count may be missing. */
type Reading = {
  samImages?: number;
  museInputTokens?: number;
  museOutputTokens?: number;
  webSearchQueries?: number;
  complete: boolean;
};

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
  // Field names and the `web_search_call` item type from a live probe, 2026-10-30, 3 calls. Whether an `open_page`
  // action bills as a query is not documented, so every web_search_call item is charged as one.
  "spark-responses"(usage, body) {
    const reading = tokens(countOf(usage?.input_tokens), countOf(usage?.output_tokens));
    const output = (body as { output?: unknown } | null)?.output;
    if (!Array.isArray(output)) return { ...reading, complete: false };
    const types = output.map((item: { type?: unknown } | null) => String(item?.type));
    const webSearchQueries = types.filter((t) => t === WEB_SEARCH_CALL).length;
    const unpriced = types.some((t) => t !== WEB_SEARCH_CALL && !TOKEN_PRICED_OUTPUT.has(t));
    return { ...reading, webSearchQueries, complete: reading.complete && !unpriced };
  },
};

/** Adds up what one run's Meta calls report using, attempt by attempt, for the spending budget. */
export class Meter {
  private samImages = 0;
  private museInputTokens = 0;
  private museOutputTokens = 0;
  private webSearchQueries = 0;
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
    this.webSearchQueries += reading.webSearchQueries ?? 0;
  }

  usage(): MeteredUsage {
    const { samImages, museInputTokens, museOutputTokens, webSearchQueries, complete } = this;
    return { samImages, museInputTokens, museOutputTokens, webSearchQueries, complete };
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

/**
 * POSTs JSON with at most one retry, on 429, 5xx or a dropped connection. Every attempt and every
 * wait must fit before `deadline` (epoch ms); a Retry-After that does not fit fails the call rather
 * than retrying early. A timeout is not retried.
 */
async function postJson(
  endpoint: string,
  operation: Operation,
  body: unknown,
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
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
  const body = await postJson(
    "/responses",
    "sam",
    {
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
    20_000,
    deadline,
    meter,
  );
  return outputTextOf(body as Parameters<typeof outputTextOf>[0]);
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
      model: "muse-spark-1.3",
      messages: request.messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, schema: request.schema, strict: true },
      },
      max_completion_tokens: request.maxCompletionTokens,
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
