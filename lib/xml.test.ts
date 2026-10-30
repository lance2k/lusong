import { describe, expect, it } from "vitest";
import { parseXml, XmlError } from "./xml";

const timed = (source: string) => {
  const started = performance.now();
  let error: unknown = null;
  try {
    parseXml(source);
  } catch (err) {
    error = err;
  }
  return { ms: performance.now() - started, error };
};

describe("a pathological document under the byte cap is rejected promptly", () => {
  it.each([
    {
      name: "8,000 nested elements each declaring a new namespace prefix (about 250 KB)",
      source: Array.from({ length: 8_000 }, (_, i) => `<p${i}:a xmlns:p${i}="u">`).join("") + "</x>",
    },
    { name: "30,000 nested elements (about 210 KB)", source: "<a>".repeat(30_000) + "</a>".repeat(30_000) },
    { name: "30,000 sibling elements", source: `<r>${"<a/>".repeat(30_000)}</r>` },
    {
      name: "one element with 3,000 namespace declarations",
      source: `<r ${Array.from({ length: 3_000 }, (_, i) => `xmlns:p${i}="u"`).join(" ")}/>`,
    },
  ])("$name", ({ source }) => {
    expect(source.length).toBeLessThan(256 * 1024);
    const { ms, error } = timed(source);
    expect(error).toBeInstanceOf(XmlError);
    expect(ms).toBeLessThan(250);
  });

  it("the saved PAGASA feed and CAP records stay well inside the bounds", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const name of readdirSync("test/fixtures/pagasa")) {
      expect(() => parseXml(readFileSync(`test/fixtures/pagasa/${name}`, "utf8")), name).not.toThrow();
    }
  });
});

describe("character references", () => {
  it.each([
    ["&#65;", "A"],
    ["&#x41;", "A"],
    ["&amp;&lt;&gt;&quot;&apos;", "&<>\"'"],
    ["&#x1F30A;", "🌊"],
  ])("%s reads as %s", (ref, text) => {
    expect(parseXml(`<a>${ref}</a>`).text).toBe(text);
  });

  it.each(["&#65junk;", "&#;", "&#x;", "&#xG1;", "&#0;", "&#x1;", "&#xD800;", "&#xFFFE;", "&#x110000;", "&nbsp;", "a & b", "&amp"])(
    "%s is malformed",
    (ref) => {
      expect(() => parseXml(`<a>${ref}</a>`)).toThrow(XmlError);
    },
  );

  it("a malformed reference in an attribute is malformed too", () => {
    expect(() => parseXml(`<a href="x&#65junk;"/>`)).toThrow(XmlError);
  });
});
