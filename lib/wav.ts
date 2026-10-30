/**
 * The one audio format voice reports take: RIFF/WAVE, integer PCM, 16 kHz, mono, 16-bit. Voice Transcribe accepts
 * "mono, 16-bit integer PCM at 16 kHz or 24 kHz" (dev.meta.ai/docs/speech-to-text, 2026-10-30); the page always
 * writes 16 kHz, so anything else did not come from it.
 */
export const VOICE_SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = VOICE_SAMPLE_RATE * BYTES_PER_SAMPLE;
export const MAX_VOICE_MS = 30_000;
/** Shorter than this holds no report worth paying to transcribe. */
export const MIN_VOICE_MS = 500;
const MAX_PCM_BYTES = (MAX_VOICE_MS / 1000) * BYTES_PER_SECOND;
/** The canonical header, plus room for a few small chunks some encoders add before the data. */
export const MAX_VOICE_FILE_BYTES = MAX_PCM_BYTES + 44 + 4_096;

export type VoiceClip = { ok: true; durationMs: number; pcm: Uint8Array };
export type VoiceRefusal = { ok: false; reason: "malformed" | "wrong_format" | "too_long" | "too_short" };

function tagAt(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

/**
 * Walks every chunk to the end of the file: the data chunk's length must be the bytes actually there and must end the
 * file, so the duration comes from the audio itself and not from a header's claim alone.
 */
export function parseVoiceWav(bytes: Uint8Array): VoiceClip | VoiceRefusal {
  const malformed: VoiceRefusal = { ok: false, reason: "malformed" };
  if (bytes.length > MAX_VOICE_FILE_BYTES) return { ok: false, reason: "too_long" };
  if (bytes.length < 12) return malformed;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tagAt(v, 0) !== "RIFF" || tagAt(v, 8) !== "WAVE" || v.getUint32(4, true) !== bytes.length - 8) return malformed;

  let fmt: { format: number; channels: number; rate: number; byteRate: number; blockAlign: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tagAt(v, at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > bytes.length) return malformed;
    if (id === "fmt ") {
      if (fmt || size < 16) return malformed;
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true),
        byteRate: v.getUint32(body + 8, true),
        blockAlign: v.getUint16(body + 12, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt || body + size !== bytes.length) return malformed;
      const pcmFormat = fmt.format === 1 && fmt.channels === 1 && fmt.rate === VOICE_SAMPLE_RATE && fmt.bits === 16;
      if (!pcmFormat) return { ok: false, reason: "wrong_format" };
      if (fmt.blockAlign !== BYTES_PER_SAMPLE || fmt.byteRate !== BYTES_PER_SECOND || size % BYTES_PER_SAMPLE !== 0) return malformed;
      if (size > MAX_PCM_BYTES) return { ok: false, reason: "too_long" };
      const durationMs = (size / BYTES_PER_SECOND) * 1000;
      if (durationMs < MIN_VOICE_MS) return { ok: false, reason: "too_short" };
      return { ok: true, durationMs, pcm: bytes.subarray(body, body + size) };
    }
    // RIFF pads odd-sized chunks to an even length.
    at = body + size + (size % 2);
  }
  return malformed;
}

/** The canonical file for `pcm` (16 kHz mono 16-bit samples): only the fmt and data chunks. */
export function wavFromPcm(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, VOICE_SAMPLE_RATE, true);
  v.setUint32(28, BYTES_PER_SECOND, true);
  v.setUint16(32, BYTES_PER_SAMPLE, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Resamples to 16 kHz and writes the WAV the server takes, cut at 30 s. Downsampling averages each output sample's
 * span of input (a box filter), which keeps speech intelligible without a full anti-aliasing filter.
 */
export function encodeWav(samples: Float32Array, inputRate: number): Uint8Array<ArrayBuffer> {
  const ratio = inputRate / VOICE_SAMPLE_RATE;
  const outLength = Math.min(Math.floor(samples.length / ratio), (MAX_VOICE_MS / 1000) * VOICE_SAMPLE_RATE);
  const pcm = new Uint8Array(outLength * BYTES_PER_SAMPLE);
  const v = new DataView(pcm.buffer);
  for (let i = 0; i < outLength; i++) {
    let value: number;
    if (ratio >= 1) {
      const from = Math.floor(i * ratio);
      const to = Math.max(from + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let k = from; k < to; k++) sum += samples[k];
      value = sum / (to - from);
    } else {
      const pos = i * ratio;
      const k = Math.floor(pos);
      const next = samples[Math.min(k + 1, samples.length - 1)];
      value = samples[k] + (next - samples[k]) * (pos - k);
    }
    const clipped = Math.max(-1, Math.min(1, value));
    v.setInt16(i * BYTES_PER_SAMPLE, Math.round(clipped < 0 ? clipped * 32_768 : clipped * 32_767), true);
  }
  return wavFromPcm(pcm);
}
