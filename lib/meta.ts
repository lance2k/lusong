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

function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Adds up what one check's Meta calls report using, attempt by attempt, for the spending budget. */
export class Meter {
  private samImages = 0;
  private museInputTokens = 0;
  private museOutputTokens = 0;
  private complete = true;

  /** A failed attempt may still have been billed, and it is the only way a call gets retried. */
  failedAttempt(): void {
    this.complete = false;
  }

  reply(endpoint: string, body: unknown): void {
    const usage = (body as { usage?: Record<string, unknown> } | null)?.usage;
    if (endpoint === "/responses") {
      const images = countOf(usage?.images_processed);
      if (images === null) this.complete = false;
      else this.samImages += images;
      return;
    }
    const input = countOf(usage?.prompt_tokens);
    const output = countOf(usage?.completion_tokens);
    if (input === null || output === null) this.complete = false;
    this.museInputTokens += input ?? 0;
    this.museOutputTokens += output ?? 0;
  }

  usage(): MeteredUsage {
    const { samImages, museInputTokens, museOutputTokens, complete } = this;
    return { samImages, museInputTokens, museOutputTokens, complete };
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
      meter.reply(endpoint, reply);
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
  if (!choice?.message?.content || choice.finish_reason === "length") {
    throw new MetaApiError("/chat/completions", 0);
  }
  return JSON.parse(choice.message.content);
}
