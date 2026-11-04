import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const voiceParagraph = (() => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const start = readme.indexOf("- **Voice notes:**");
  return readme.slice(start, readme.indexOf("\n- **", start + 1)).replace(/\s+/g, " ");
})();

it("the README gives the Tagalog and English voice cost as metered usage, not as what Meta billed", () => {
  expect(voiceParagraph).toContain("metered usage prices at about $0.06");
  expect(voiceParagraph).toContain("what Meta bills for Voice Transcribe is unverified");
  expect(voiceParagraph).not.toMatch(/cost \$0\.06/);
});

it("the README says the Tagalog and English notes were synthetic, with their draw count", () => {
  expect(voiceParagraph).toContain("synthetic speech, not real voices");
  expect(voiceParagraph).toContain("8 draws");
  expect(voiceParagraph).not.toContain("not yet tried live");
});
