import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPhoto } from "./check";
import { Meter } from "./meta";

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("a SAM call that fails waits for the others, so their usage is metered before the check fails", async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const phrase = JSON.parse(String(init.body)).input[0].content[0].text as string;
    if (phrase === "flood water") return new Response("bad request", { status: 400 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return Response.json({ output: [{ content: [{ type: "output_text", text: "" }] }], usage: { images_processed: 1 } });
  });
  const meter = new Meter();
  await expect(checkPhoto("data:image/jpeg;base64,", { width: 100, height: 100 }, meter)).rejects.toThrow("HTTP 400");
  expect(meter.usage().samImages).toBe(3);
});

const emptyCompleted = JSON.parse(readFileSync("test/fixtures/sam/quiapo-2__person.json", "utf8")) as unknown;
const malformed: Record<string, unknown> = {
  "a bare completed status": { status: "completed" },
  "a refusal": {
    status: "completed",
    output: [{ type: "message", status: "completed", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
  },
  "an output_text with no text": { status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text" }] }] },
};

function stubSam(replyFor: (phrase: string) => unknown) {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const phrase = JSON.parse(String(init.body)).input[0].content[0].text as string;
    return Response.json(replyFor(phrase));
  });
}

it("a dry photo where every SAM call completed with Meta's recorded empty reply reads as no flood", async () => {
  stubSam(() => emptyCompleted);
  const result = await checkPhoto("data:image/jpeg;base64,", { width: 100, height: 100 }, new Meter());
  expect(result.verdict).toEqual({ kind: "no_flood" });
});

describe.each(["flood water", "person", "car", "tire"])("a dry photo whose %s call did not complete", (prompt) => {
  it.each(Object.keys(malformed))("cannot be measured when that call returns %s", async (shape) => {
    stubSam((phrase) => (phrase === prompt ? malformed[shape] : emptyCompleted));
    const result = await checkPhoto("data:image/jpeg;base64,", { width: 100, height: 100 }, new Meter());
    expect(result.verdict).toEqual({ kind: "cannot_measure" });
  });
});
