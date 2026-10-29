import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Meter, MetaApiError } from "./meta";
import { placeLabel, readVoiceClaim, voiceSays, type VoiceClaim } from "./voice-claim";

const TAGALOG = "Baha dito sa A. Soriano Avenue sa Mabolo, hanggang tuhod na, hindi na madaanan ng motor.";

/** Muse Spark faked at fetch with one claim; returns the request bodies it was sent. */
function sparkReplies(claim: object) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(claim) } }],
        usage: { prompt_tokens: 500, completion_tokens: 300 },
      });
    }),
  );
  return sent;
}

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Muse Spark turns a voice note's words into a claim of fixed choices", () => {
  it("a Tagalog note: the place in the speaker's words, knee-deep or deeper, not passable", async () => {
    const sent = sparkReplies({ place: "A. Soriano Avenue sa Mabolo", depth: "knee_or_deeper", passable: "no" });
    const claim = await readVoiceClaim(TAGALOG, { meter: new Meter(), deadline: Date.now() + 30_000 });
    expect(claim).toEqual({ place: "A. Soriano Avenue sa Mabolo", depth: "knee_or_deeper", passable: "no" });

    expect(sent[0].url).toBe("https://api.meta.ai/v1/chat/completions");
    const format = sent[0].body.response_format as { json_schema: { strict: boolean; schema: { properties: Record<string, { enum?: string[] }> } } };
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.properties.depth.enum).toEqual(["dry", "below_knee", "knee_or_deeper", "not_said"]);
    expect(format.json_schema.schema.properties.passable.enum).toEqual(["yes", "no", "not_said"]);
    expect(JSON.stringify(sent[0].body.messages)).toContain(TAGALOG);
  });

  it("a place the speaker never said is dropped: the label is the note's own words or nothing", async () => {
    sparkReplies({ place: "Mabolo Church, safe to pass", depth: "below_knee", passable: "yes" });
    const claim = await readVoiceClaim(TAGALOG, { meter: new Meter(), deadline: Date.now() + 30_000 });
    expect(claim.place).toBeNull();
  });

  it("an empty place is no place", async () => {
    sparkReplies({ place: "  ", depth: "not_said", passable: "not_said" });
    expect((await readVoiceClaim(TAGALOG, { meter: new Meter(), deadline: Date.now() + 30_000 })).place).toBeNull();
  });

  it.each([
    ["a depth outside the choices", { place: "", depth: "waist", passable: "no" }],
    ["a passability outside the choices", { place: "", depth: "dry", passable: "maybe" }],
    ["a missing field", { place: "", depth: "dry" }],
  ])("%s is a failed reading, never a guess", async (_name, claim) => {
    sparkReplies(claim);
    await expect(readVoiceClaim(TAGALOG, { meter: new Meter(), deadline: Date.now() + 30_000 })).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("the place label is capped like every other label on the page", () => {
  it("at 12 words", () => {
    const words = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    expect(placeLabel(words, words)).toBe("one two three four five six seven eight nine ten eleven twelve");
  });

  it("at 80 characters, cut at a whole word", () => {
    const long = "Barangay Kasambagan Mabolo Cebu City Philippines Juan Luna Avenue Extension Northbound Lane";
    const label = placeLabel(long, long)!;
    expect(label.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(label)).toBe(true);
    expect(long[label.length]).toBe(" ");
  });

  it("matched against the note without regard to case, spacing or punctuation", () => {
    expect(placeLabel("a soriano avenue", "Baha sa A. Soriano  Avenue!")).toBe("a soriano avenue");
  });

  it("control characters never reach the page", () => {
    expect(placeLabel("Mabolo\u0007", "baha sa Mabolo")).toBe("Mabolo");
  });
});

describe("what a claim says, in the answer rules' words (rules v2: knee-deep or deeper, or not passable, blocks)", () => {
  const claim = (depth: VoiceClaim["depth"], passable: VoiceClaim["passable"]): VoiceClaim => ({ place: null, depth, passable });
  it.each([
    [claim("knee_or_deeper", "no"), "knee_deep_or_deeper"],
    [claim("knee_or_deeper", "yes"), "knee_deep_or_deeper"],
    [claim("knee_or_deeper", "not_said"), "knee_deep_or_deeper"],
    [claim("below_knee", "no"), "not_passable"],
    [claim("not_said", "no"), "not_passable"],
    [claim("dry", "yes"), "passable"],
    [claim("below_knee", "yes"), "passable"],
    [claim("below_knee", "not_said"), "unsure"],
    [claim("not_said", "not_said"), "unsure"],
    [claim("dry", "not_said"), "passable"],
  ])("%o says %s", (c, says) => {
    expect(voiceSays(c)).toBe(says);
  });
});
