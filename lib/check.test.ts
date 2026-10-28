import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
