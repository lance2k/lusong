import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeVoiceNote, OPUS_RATE } from "./ogg-opus";
import { encodeWav, parseVoiceWav } from "./wav";

const fixture = (name: string) => new Uint8Array(readFileSync(`test/fixtures/telegram/${name}`));
const ample = () => ({ maxMs: 30_500, deadline: Date.now() + 10_000 });

describe("decoding a Telegram voice note", () => {
  it("a 3 s mono tone decodes to about 3 s at 48 kHz and becomes a WAV the voice route takes", async () => {
    const decoded = await decodeVoiceNote(fixture("tone-3s.ogg"), ample());
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.sampleRate).toBe(OPUS_RATE);
    expect(decoded.samples.length / OPUS_RATE).toBeGreaterThan(2.9);
    expect(decoded.samples.length / OPUS_RATE).toBeLessThan(3.1);
    const clip = parseVoiceWav(encodeWav(decoded.samples, decoded.sampleRate));
    expect(clip.ok && Math.round(clip.durationMs / 100) / 10).toBe(3);
  });

  it("a stereo note is mixed down to one channel", async () => {
    const decoded = await decodeVoiceNote(fixture("tone-3s-stereo.ogg"), ample());
    expect(decoded.ok && Math.round(decoded.samples.length / OPUS_RATE)).toBe(3);
  });

  it("stops and refuses past 30.5 s of decoded audio (S6P-4)", async () => {
    expect(await decodeVoiceNote(fixture("tone-40s.ogg"), ample())).toEqual({ ok: false, reason: "too_long" });
  });

  it("refuses bytes that aren't OGG/Opus: noise, a cut-off file, Vorbis (S6P-4)", async () => {
    const noise = new Uint8Array(4_000).map((_, i) => (i * 7919) % 256);
    expect(await decodeVoiceNote(noise, ample())).toEqual({ ok: false, reason: "malformed" });
    expect(await decodeVoiceNote(fixture("tone-3s.ogg").subarray(0, 60), ample())).toEqual({ ok: false, reason: "malformed" });
    expect(await decodeVoiceNote(fixture("tone-3s-vorbis.ogg"), ample())).toEqual({ ok: false, reason: "malformed" });
  });

  it("stops once its deadline has passed (S6P-3)", async () => {
    expect(await decodeVoiceNote(fixture("tone-3s.ogg"), { maxMs: 30_500, deadline: Date.now() - 1 })).toEqual({ ok: false, reason: "too_slow" });
  });
});
