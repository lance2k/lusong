import { sparkResponse, type Meter } from "./meta";

/** Muse Spark on the Responses API: request shapes and reply items as measured in the 2026-10-30 probe (3 calls). */

export interface FunctionCall {
  callId: string;
  name: string;
  /** The model's arguments as it wrote them: a JSON string, unparsed. */
  arguments: string;
}

export interface WebSearchAction {
  type: string;
  query?: string;
  url?: string;
}

export interface SparkReply {
  id: string | null;
  /** "completed", "incomplete" (e.g. max_output_tokens) or "failed"; a malformed reply is "failed". */
  status: string;
  functionCalls: FunctionCall[];
  /** Every non-commentary message's text, joined. Commentary is the model narrating before a tool call. */
  answerText: string;
  webSearchActions: WebSearchAction[];
}

type Item = Record<string, unknown>;

function messageText(item: Item): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((part: Item | null) => part?.type === "output_text" && typeof part.text === "string")
    .map((part: Item) => part.text as string)
    .join("");
}

export function readReply(body: unknown): SparkReply {
  const b = (typeof body === "object" && body !== null ? body : {}) as Item;
  const output = Array.isArray(b.output) ? (b.output as unknown[]).filter((i): i is Item => typeof i === "object" && i !== null) : null;
  const status = output && typeof b.status === "string" ? b.status : "failed";
  const items = output ?? [];
  const functionCalls: FunctionCall[] = [];
  const texts: string[] = [];
  const webSearchActions: WebSearchAction[] = [];
  for (const item of items) {
    if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      functionCalls.push({ callId: item.call_id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "" });
    } else if (item.type === "message" && item.phase !== "commentary") {
      texts.push(messageText(item));
    } else if (item.type === "web_search_call") {
      const action = (typeof item.action === "object" && item.action !== null ? item.action : {}) as Item;
      webSearchActions.push({
        type: typeof action.type === "string" ? action.type : "unknown",
        ...(typeof action.query === "string" ? { query: action.query } : {}),
        ...(typeof action.url === "string" ? { url: action.url } : {}),
      });
    }
  }
  return { id: typeof b.id === "string" ? b.id : null, status, functionCalls, answerText: texts.join("\n").trim(), webSearchActions };
}

export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: object;
}

/**
 * One Responses-API call. The first turn's input is a plain string and each later turn sends the function outputs with
 * `previous_response_id`: both shapes were measured. Throws MetaApiError on failure.
 */
export async function respond(request: {
  input: string | { type: "function_call_output"; call_id: string; output: string }[];
  previousResponseId?: string;
  tools: readonly (FunctionTool | { type: "web_search" })[];
  maxOutputTokens: number;
  attemptTimeoutMs: number;
  deadline: number;
  meter: Meter;
}): Promise<SparkReply> {
  const body = await sparkResponse(
    {
      input: request.input,
      ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
      tools: request.tools,
      max_output_tokens: request.maxOutputTokens,
    },
    request.attemptTimeoutMs,
    request.deadline,
    request.meter,
  );
  return readReply(body);
}
