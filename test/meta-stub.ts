import { readFileSync } from "node:fs";
import { vi } from "vitest";

/** Meta's Model API faked at fetch, the way lib/check-handler.test.ts fakes it: no request leaves the test. */
type Reply = () => Response | Promise<Response>;

export const samEmpty = (): Reply => () =>
  Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: "" }] }], usage: { images_processed: 1 } });
/** A completed SAM reply with this segmentation text. */
export const samText = (text: string): Reply => () =>
  Response.json({ status: "completed", output: [{ status: "completed", content: [{ type: "output_text", text }] }], usage: { images_processed: 1 } });
export const samFixture = (file: string): Reply => {
  const body = readFileSync(file, "utf8");
  return () => new Response(body, { status: 200 });
};
export const museReadings = (readings: object[]): Reply => () =>
  Response.json({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ is_flooded_street: true, caveats: "", readings }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
export const serverError = (): Reply => () => new Response("detail", { status: 500 });

const META = "https://api.meta.ai/";

/**
 * Routes each Meta call by endpoint and SAM phrase; returns the URL of every Meta call made. The local Upstash
 * stand-in still gets real requests; any other request fails as a dropped connection.
 */
export function stubMeta(replies: { sam?: Partial<Record<string, Reply>>; muse?: Reply } = {}): string[] {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const upstash = process.env.LUSONG_TEST_UPSTASH_URL;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (upstash && String(url).startsWith(upstash)) return realFetch(url, init);
      if (!String(url).startsWith(META)) throw new TypeError("fetch failed");
      calls.push(url);
      if (url.endsWith("/chat/completions")) return (replies.muse ?? museReadings([]))();
      const phrase = JSON.parse(String(init.body)).input[0].content[0].text as string;
      return (replies.sam?.[phrase] ?? samEmpty())();
    }),
  );
  return calls;
}
