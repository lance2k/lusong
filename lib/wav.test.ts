import { describe, expect, it } from "vitest";
import { encodeWav, MAX_VOICE_MS, parseVoiceWav, VOICE_SAMPLE_RATE } from "./wav";

/** A WAV file written by hand, field by field, so each test can break exactly one of them. */
function wav(
  opts: {
    format?: number;
    channels?: number;
    rate?: number;
    bits?: number;
    samples?: number;
    dataSize?: number;
    riffSize?: number;
    extraChunk?: boolean;
    trailing?: number;
  } = {},
): Uint8Array {
  const channels = opts.channels ?? 1;
  const rate = opts.rate ?? 16_000;
  const bits = opts.bits ?? 16;
  const samples = opts.samples ?? 16_000;
  const blockAlign = (channels * bits) / 8;
  const data = samples * blockAlign;
  const extra = opts.extraChunk ? 8 + 4 : 0;
  const total = 44 + extra + data + (opts.trailing ?? 0);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, opts.riffSize ?? total - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.format ?? 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  let at = 36;
  if (opts.extraChunk) {
    tag(at, "LIST");
    v.setUint32(at + 4, 4, true);
    tag(at + 8, "INFO");
    at += 12;
  }
  tag(at, "data");
  v.setUint32(at + 4, opts.dataSize ?? data, true);
  if (bits === 16 && channels === 1) for (let i = 0; i < samples; i++) v.setInt16(at + 8 + i * 2, Math.round(Math.sin(i / 10) * 8_000), true);
  return new Uint8Array(buf);
}

describe("a voice note's WAV is checked in full before anything is spent", () => {
  it("16 kHz mono 16-bit PCM, 1 s: accepted with its duration and its samples", () => {
    const clip = parseVoiceWav(wav({ samples: 16_000 }));
    expect(clip).toMatchObject({ ok: true, durationMs: 1_000 });
    if (clip.ok) expect(clip.pcm.length).toBe(32_000);
  });

  it("exactly 30 s is accepted; one sample more is refused as too long", () => {
    expect(parseVoiceWav(wav({ samples: 480_000 }))).toMatchObject({ ok: true, durationMs: 30_000 });
    expect(parseVoiceWav(wav({ samples: 480_001 }))).toEqual({ ok: false, reason: "too_long" });
  });

  it("a header that claims a short data chunk over more audio is refused: the real length is what counts", () => {
    expect(parseVoiceWav(wav({ samples: 320_000, dataSize: 32_000 }))).toEqual({ ok: false, reason: "malformed" });
    expect(parseVoiceWav(wav({ samples: 320_000, dataSize: 32_000, riffSize: 36 + 32_000 }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("a file longer than 30 s of audio can hold is refused as too long from its byte length, whatever its header says", () => {
    expect(parseVoiceWav(wav({ samples: 640_000, dataSize: 32_000, riffSize: 36 + 32_000 }))).toEqual({ ok: false, reason: "too_long" });
  });

  it("a data chunk that claims more bytes than the file holds is refused", () => {
    expect(parseVoiceWav(wav({ samples: 16_000, dataSize: 64_000 }))).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["44.1 kHz", { rate: 44_100 }],
    ["48 kHz", { rate: 48_000 }],
    ["24 kHz", { rate: 24_000 }],
    ["stereo", { channels: 2 }],
    ["8-bit", { bits: 8 }],
    ["32-bit", { bits: 32 }],
    ["IEEE float", { format: 3, bits: 32 }],
  ])("%s is refused as the wrong format", (_name, opts) => {
    expect(parseVoiceWav(wav(opts))).toEqual({ ok: false, reason: "wrong_format" });
  });

  it.each([
    ["empty", new Uint8Array(0)],
    ["a JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(0)])],
    ["a header cut short", wav().slice(0, 30)],
    ["no data chunk", wav().slice(0, 36)],
    ["an odd data length", wav({ trailing: 1, dataSize: 32_001 })],
  ])("%s is refused as malformed", (_name, bytes) => {
    expect(parseVoiceWav(bytes)).toEqual({ ok: false, reason: "malformed" });
  });

  it("bytes after the data chunk are refused, so nothing rides along unchecked", () => {
    expect(parseVoiceWav(wav({ trailing: 4 }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("an extra chunk before the data is skipped, and is not part of the audio", () => {
    const clip = parseVoiceWav(wav({ extraChunk: true }));
    expect(clip).toMatchObject({ ok: true, durationMs: 1_000 });
    if (clip.ok) expect(clip.pcm.length).toBe(32_000);
  });

  it("under half a second is refused as too short", () => {
    expect(parseVoiceWav(wav({ samples: 7_999 }))).toEqual({ ok: false, reason: "too_short" });
  });
});

describe("the page's encoder writes what the server accepts", () => {
  it("48 kHz samples become 16 kHz mono 16-bit WAV of the same duration", () => {
    const seconds = 2;
    const input = Float32Array.from({ length: 48_000 * seconds }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5);
    const clip = parseVoiceWav(encodeWav(input, 48_000));
    expect(clip).toMatchObject({ ok: true, durationMs: 2_000 });
  });

  it("44.1 kHz samples are resampled to 16 kHz", () => {
    const input = new Float32Array(44_100).fill(0.25);
    const clip = parseVoiceWav(encodeWav(input, 44_100));
    expect(clip).toMatchObject({ ok: true, durationMs: 1_000 });
    // A constant level stays that level: 0.25 of full scale is 8,192 (or 8,191 after rounding).
    if (clip.ok) expect(Math.abs(new DataView(clip.pcm.buffer, clip.pcm.byteOffset).getInt16(1_000, true) - 8_192)).toBeLessThanOrEqual(1);
  });

  it("samples past 30 s are cut at 30 s, so a recording that overran is still accepted", () => {
    const input = new Float32Array(48_000 * 31);
    expect(parseVoiceWav(encodeWav(input, 48_000))).toMatchObject({ ok: true, durationMs: MAX_VOICE_MS });
  });

  it("loud samples are clipped to the 16-bit range instead of wrapping", () => {
    const clip = parseVoiceWav(encodeWav(new Float32Array(VOICE_SAMPLE_RATE).fill(3), VOICE_SAMPLE_RATE));
    if (!clip.ok) throw new Error("refused");
    expect(new DataView(clip.pcm.buffer, clip.pcm.byteOffset).getInt16(0, true)).toBe(32_767);
  });
});
