import { outputTextOf } from "./sam";

const BASE_URL = "https://api.meta.ai/v1";
const MAX_RETRY_WAIT_MS = 3000;

/** Carries only the status, never the upstream body, so nothing from Meta leaks to a client. */
export class MetaApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
  ) {
    super(`Meta API ${endpoint} failed${status ? ` with HTTP ${status}` : ""}`);
  }
}

function apiKey(): string {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set");
  return key;
}

function retryDelayMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : 500;
}

/**
 * POSTs JSON with at most one retry, on 429, 5xx or a dropped connection. A timeout is not
 * retried: a second wait of the same length would overrun the route's time budget.
 */
async function postJson(endpoint: string, body: unknown, timeoutMs: number): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      if (attempt === 1 && !timedOut) continue;
      throw new MetaApiError(endpoint, 0);
    }
    if (res.ok) return res.json();
    if (attempt === 1 && (res.status === 429 || res.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res)));
      continue;
    }
    throw new MetaApiError(endpoint, res.status);
  }
}

/** One SAM 3.1 concept prompt on one image; returns the raw segmentation text. */
export async function segment(imageDataUrl: string, phrase: string): Promise<string> {
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
    45_000,
  )) as ChatCompletion;
  const choice = body.choices?.[0];
  if (!choice?.message?.content || choice.finish_reason === "length") {
    throw new MetaApiError("/chat/completions", 0);
  }
  return JSON.parse(choice.message.content);
}
