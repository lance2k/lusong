import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBudget, MemoryBudgetStore, RESERVE_MICROS as R } from "./budget";
import { makeCheckHandler } from "./check-handler";

const photo = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1.jpg"));
const samPersons = readFileSync("test/fixtures/sam/quiapo-1__person.json", "utf8");

type Reply = () => Response | Promise<Response>;

const samEmpty = (usage: object | null = { images_processed: 1 }) => () =>
  Response.json({ output: [{ content: [{ type: "output_text", text: "" }] }], ...(usage ? { usage } : {}) });
const samFixture = () => () => new Response(samPersons, { status: 200 });
const museReply = (usage: object | null) => () =>
  Response.json({
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify({ is_flooded_street: true, caveats: "", readings: [] }) } },
    ],
    ...(usage ? { usage } : {}),
  });
const dropped = () => () => Promise.reject(new TypeError("fetch failed"));
const serverError = () => () => new Response("detail", { status: 500 });

/** Routes each Meta call by endpoint and SAM phrase; each phrase takes its replies in order, then repeats the last. */
function stubMeta(replies: { sam?: Partial<Record<string, Reply[]>>; muse?: Reply[] } = {}) {
  const calls: string[] = [];
  const queues = new Map<string, Reply[]>();
  const next = (key: string, fallback: Reply[]) => {
    const queue = queues.get(key) ?? [...fallback];
    queues.set(key, queue);
    return (queue.length > 1 ? queue.shift() : queue[0])!();
  };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/chat/completions")) return next("muse", replies.muse ?? [museReply({ prompt_tokens: 1, completion_tokens: 1 })]);
    const phrase = JSON.parse(String(init.body)).input[0].content[0].text as string;
    return next(phrase, replies.sam?.[phrase] ?? [samEmpty()]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function post(ip: string, bytes: Uint8Array = photo): Request {
  const form = new FormData();
  form.set("photo", new File([new Uint8Array(bytes)], "photo.jpg", { type: "image/jpeg" }));
  return new Request("http://localhost/api/check", { method: "POST", body: form, headers: { "x-forwarded-for": ip } });
}

function handlerWith(budgetMicros: number, ipLimit = 10) {
  const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: budgetMicros / 1e6, ipLimit });
  return makeCheckHandler({ budget: () => budget });
}

/** Rewrites the frame header's width, so the sanitizer reads a wider photo without a new encode. */
function withWidth(bytes: Uint8Array, width: number): Uint8Array {
  const out = bytes.slice();
  for (let i = 2; i + 8 < out.length; ) {
    const marker = out[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      out[i + 7] = width >> 8;
      out[i + 8] = width & 0xff;
      return out;
    }
    i += 2 + ((out[i + 2] << 8) | out[i + 3]);
  }
  throw new Error("no frame header");
}

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the check handler", () => {
  it("a refused admission makes no Meta call", async () => {
    const calls = stubMeta();
    const res = await handlerWith(R - 1)(post("192.0.2.1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "budget" });
    expect(calls).toHaveLength(0);
  });

  it("a photo over 1600 px is refused before admission", async () => {
    const calls = stubMeta();
    const handler = handlerWith(10 * R, 1);
    expect((await handler(post("192.0.2.1", withWidth(photo, 1601)))).status).toBe(413);
    expect(calls).toHaveLength(0);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
  });

  it("the eleventh check from one address is refused, another address is not", async () => {
    stubMeta();
    const handler = handlerWith(10 * R, 1);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    const refused = await handler(post("192.0.2.1"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: "ip" });
    expect((await handler(post("192.0.2.2"))).status).toBe(200);
  });

  it("a metered check refunds its reservation down to the three SAM images", async () => {
    stubMeta();
    const handler = handlerWith(R + 7_500);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect((await handler(post("192.0.2.2"))).status).toBe(200);
    expect((await handler(post("192.0.2.3"))).status).toBe(503);
  });

  it("charges Muse Spark's tokens as well as SAM's images", async () => {
    const cost = 3 * 2_500 + 2_000 * 1.25 + 3_000 * 4.25;
    for (const [budget, secondStatus] of [
      [R + cost, 200],
      [R + cost - 1, 503],
    ] as const) {
      stubMeta({ sam: { person: [samFixture()] }, muse: [museReply({ prompt_tokens: 2_000, completion_tokens: 3_000 })] });
      const handler = handlerWith(budget);
      expect((await handler(post("192.0.2.1"))).status).toBe(200);
      expect((await handler(post("192.0.2.2"))).status).toBe(secondStatus);
    }
  });

  it("a retried Meta call refunds nothing", async () => {
    const calls = stubMeta({ sam: { car: [dropped(), samEmpty()] } });
    const handler = handlerWith(R + 7_500);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect(calls).toHaveLength(4);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });

  it("a reply without usage refunds nothing", async () => {
    stubMeta({ sam: { "flood water": [samEmpty(null)] } });
    const handler = handlerWith(R + 7_500);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });

  it("a Muse reply without usage refunds nothing", async () => {
    stubMeta({ sam: { person: [samFixture()] }, muse: [museReply(null)] });
    const handler = handlerWith(R + 7_500);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });

  /** Three SAM images plus 2,000 and 3,000 Muse tokens: a refund would leave room for a second check. */
  const MUSE_CHECK = 3 * 2_500 + 2_000 * 1.25 + 3_000 * 4.25;
  const MUSE_USAGE = { prompt_tokens: 2_000, completion_tokens: 3_000 };

  it("a SAM count that is not a whole number refunds nothing", async () => {
    stubMeta({ sam: { car: [samEmpty({ images_processed: "1" })] } });
    const handler = handlerWith(R + 7_500);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });

  it("a negative Muse count refunds nothing", async () => {
    stubMeta({ sam: { person: [samFixture()] }, muse: [museReply({ prompt_tokens: -5, completion_tokens: 3_000 })] });
    const handler = handlerWith(R + MUSE_CHECK);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });

  it("a retried Muse call refunds nothing", async () => {
    stubMeta({ sam: { person: [samFixture()] }, muse: [dropped(), museReply(MUSE_USAGE)] });
    const handler = handlerWith(R + MUSE_CHECK);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });

  it("the same Muse call without a retry does refund (control for the two above)", async () => {
    stubMeta({ sam: { person: [samFixture()] }, muse: [museReply(MUSE_USAGE)] });
    const handler = handlerWith(R + MUSE_CHECK);
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect((await handler(post("192.0.2.2"))).status).toBe(200);
  });

  it("a reply whose body is not JSON fails the check and keeps its reservation", async () => {
    stubMeta({ sam: { person: [() => new Response("<html>gateway</html>", { status: 200 })] } });
    const handler = handlerWith(R + 7_500);
    expect((await handler(post("192.0.2.1"))).status).toBe(502);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });

  it("a failed check keeps its reservation", async () => {
    stubMeta({ sam: { person: [serverError()] } });
    const handler = handlerWith(R + 7_500);
    expect((await handler(post("192.0.2.1"))).status).toBe(502);
    expect((await handler(post("192.0.2.2"))).status).toBe(503);
  });
});
