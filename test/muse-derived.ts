import { readFileSync } from "node:fs";
import { vi } from "vitest";

/**
 * Scripted Muse Spark replies, each derived from a real Responses-API record of the 2026-10-30 probe
 * (test/fixtures/muse/real-2026-10-30-*.json): the real envelope and item shapes, with the id, the items' content and
 * the usage replaced.
 */

const real = (name: string) =>
  JSON.parse(readFileSync(`test/fixtures/muse/real-2026-10-30-responses-${name}.json`, "utf8")).body as Record<string, unknown> & {
    output: Record<string, unknown>[];
  };
const CALL = real("function-call");
const RESULT = real("function-result");
const SEARCH = real("web-search-capped-3000");

export const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
/** q1b's measured usage, the function-output turn. */
export const TURN_USAGE: Usage = { input_tokens: 679, output_tokens: 327 };

function withoutUsage(body: Record<string, unknown>) {
  const copy = { ...body };
  delete copy.usage;
  return copy;
}

function usageBlock(usage: Usage | null) {
  if (usage === null) return {};
  return {
    usage: {
      ...usage,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
  };
}

/** A reply that calls function tools: the real reasoning and commentary items, then one function_call per call. */
export function callsReply(id: string, calls: { name: string; args: unknown }[], usage: Usage | null = TURN_USAGE) {
  const [reasoning, commentary, template] = CALL.output;
  const fc = calls.map((c, i) => ({
    ...template,
    id: `fc_${id}_${i}`,
    call_id: `call_${id}_${i}`,
    name: c.name,
    arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
  }));
  const envelope = withoutUsage(CALL);
  return { ...envelope, id, output: [reasoning, commentary, ...fc], ...usageBlock(usage) };
}

/** A reply whose final message is `text`: the real reasoning item and final message, text replaced. */
export function textReply(id: string, text: string, usage: Usage | null = TURN_USAGE, status = "completed") {
  const [reasoning, message] = RESULT.output;
  const content = (message.content as Record<string, unknown>[]).map((c) => ({ ...c, text }));
  const envelope = withoutUsage(RESULT);
  return { ...envelope, id, status, output: [reasoning, { ...message, content }], ...usageBlock(usage) };
}

/**
 * A web search reply: the real record's first `actions` items' worth of web_search_call (repeating its 11 if more are
 * asked for), then a final message with `text`. The real reply ran out of tokens before any final message.
 */
export function searchReply(text: string | null, actions = 11, usage: Usage | null = { input_tokens: 90_257, output_tokens: 3_000 }) {
  const calls = SEARCH.output.filter((i) => i.type === "web_search_call");
  const searches = Array.from({ length: actions }, (_, i) => ({ ...calls[i % calls.length], id: `ws_call_${i}` }));
  const [reasoning] = SEARCH.output;
  const final = text === null ? [] : [{ type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] }];
  const envelope = withoutUsage(SEARCH);
  return { ...envelope, id: "resp_search", status: text === null ? "incomplete" : "completed", output: [reasoning, ...searches, ...final], ...usageBlock(usage) };
}

export type Scripted =
  | object
  | Response
  | ((body: Record<string, unknown>, signal: AbortSignal | undefined) => object | Response | Promise<object | Response>);

/** A Meta call that never answers until its abort signal fires, as a hung connection would. */
export const hangs: Scripted = (_body, signal) =>
  new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

/**
 * Stubs the global fetch so Meta's Responses endpoint answers from the scripts: web_search requests from `search`,
 * every other request from `turns` in order. Anything else, or a request past the script, fails the test.
 */
export function fakeMeta(script: { turns?: Scripted[]; search?: Scripted[] }) {
  const turns = [...(script.turns ?? [])];
  const searches = [...(script.search ?? [])];
  const requests: Record<string, unknown>[] = [];
  const searchRequests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== META_RESPONSES_URL) throw new Error(`unexpected fetch ${String(url)}`);
    const body = JSON.parse(String(init?.body));
    const isSearch = (body.tools as { type: string }[]).some((t) => t.type === "web_search");
    (isSearch ? searchRequests : requests).push(body);
    const next = (isSearch ? searches : turns).shift();
    if (next === undefined) throw new Error(`no scripted reply for ${isSearch ? "search" : "turn"} ${requests.length}`);
    const value = typeof next === "function" ? await next(body, init?.signal ?? undefined) : next;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, searchRequests, fetchMock };
}
