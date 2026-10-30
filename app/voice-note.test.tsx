import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import VoiceNote from "./voice-note";
import { voiceNoteForm } from "./voice-recorder";

const PIN = { lat: 10.338566, lon: 123.911461 };

describe("the voice note's language", () => {
  it.each(["tl", "en"] as const)("the form the page sends carries the picked language, %s", (language) => {
    const form = voiceNoteForm(new Blob(["RIFF"], { type: "audio/wav" }), PIN, language);
    expect(form.get("language")).toBe(language);
    expect(form.get("audio")).toBeInstanceOf(Blob);
    expect([form.get("lat"), form.get("lon")]).toEqual([String(PIN.lat), String(PIN.lon)]);
  });

  it("before a language is picked, Tagalog and English are offered, neither is chosen, and record can't be tapped", () => {
    const html = renderToStaticMarkup(<VoiceNote />);
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios.map((r) => /value="(\w+)"/.exec(r)?.[1])).toEqual(["tl", "en"]);
    expect(radios.some((r) => r.includes("checked"))).toBe(false);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record a voice note/);
  });

  it("while Bisaya is out, it is not offered, and a plain line says so", () => {
    const html = renderToStaticMarkup(<VoiceNote />);
    expect(html).not.toMatch(/value="ceb"/);
    expect(html).toContain("Bisaya voice notes aren&#x27;t supported yet.");
  });
});
