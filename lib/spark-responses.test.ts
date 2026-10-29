import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readReply } from "./spark-responses";

const real = (name: string) => JSON.parse(readFileSync(`test/fixtures/muse/real-2026-10-30-responses-${name}.json`, "utf8"));

describe("reading a Muse Spark Responses-API reply (real records, 2026-10-30)", () => {
  it("a reply that calls a function tool gives its call id, name and JSON arguments, and no answer text", () => {
    const reply = readReply(real("function-call").body);
    expect(reply).toMatchObject({ id: "resp_6ae3820750fb519b169a45d3", status: "completed", answerText: "" });
    expect(reply.functionCalls).toEqual([
      { callId: "call_6a6a4d14-b7e6-4d51-a805-6b04c66aca04", name: "read_advisory", arguments: '{"city":"Cebu City"}' },
    ]);
  });

  it("the commentary message before a tool call is not the answer; the final message is", () => {
    const reply = readReply(real("function-result").body);
    expect(reply.functionCalls).toEqual([]);
    expect(reply.answerText).toBe("Cebu City is under an orange flood advisory with Mananga Rd closed.");
  });

  it("a web search reply cut off at max_output_tokens is incomplete, with its 11 search actions and no answer", () => {
    const reply = readReply(real("web-search-capped-3000").body);
    expect(reply.status).toBe("incomplete");
    expect(reply.answerText).toBe("");
    expect(reply.webSearchActions).toHaveLength(11);
    expect(reply.webSearchActions.filter((a) => a.type === "search")).toHaveLength(6);
    expect(reply.webSearchActions.filter((a) => a.type === "open_page")).toHaveLength(5);
  });

  it("the real web search reply cites no page: its messages' annotations are all empty", () => {
    expect(readReply(real("web-search-capped-3000").body).citedUrls).toEqual([]);
  });

  it("a message's url_citation annotations give the pages the search cited; other annotations and non-string urls are ignored", () => {
    const text = (annotations: unknown[]) => ({ type: "output_text", text: "x", annotations });
    const reply = readReply({
      id: "resp_x",
      status: "completed",
      output: [
        { type: "message", phase: "commentary", content: [text([{ type: "url_citation", url: "https://a.example.ph/one", start_index: 0, end_index: 1 }])] },
        {
          type: "message",
          content: [
            text([
              { type: "url_citation", url: "https://b.example.ph/two" },
              { type: "file_citation", url: "https://c.example.ph/three" },
              { type: "url_citation", url: 7 },
            ]),
          ],
        },
      ],
    });
    expect(reply.citedUrls).toEqual(["https://a.example.ph/one", "https://b.example.ph/two"]);
  });

  it("a malformed reply reads as failed with nothing in it, never as a completed empty answer", () => {
    for (const body of [null, "text", {}, { output: "x" }, { status: "completed" }]) {
      const reply = readReply(body);
      expect(reply.status).not.toBe("completed");
      expect(reply.functionCalls).toEqual([]);
      expect(reply.answerText).toBe("");
    }
  });

  it("a function call missing its call id or name is dropped, and one whose arguments aren't a string keeps an empty string", () => {
    const reply = readReply({
      id: "resp_x",
      status: "completed",
      output: [
        { type: "function_call", name: "read_advisory", arguments: "{}" },
        { type: "function_call", call_id: "c1", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "read_advisory", arguments: { a: 1 } },
      ],
    });
    expect(reply.functionCalls).toEqual([{ callId: "c2", name: "read_advisory", arguments: "" }]);
  });
});
