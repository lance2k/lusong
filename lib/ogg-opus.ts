import { OggOpusDecoder } from "ogg-opus-decoder";

/** Opus always decodes at 48 kHz (ogg-opus-decoder's OggOpusDecodedAudio.sampleRate is the literal 48000). */
export const OPUS_RATE = 48_000;
/** Fed to the decoder this much at a time, so the sample count and the clock are checked as it goes. */
const CHUNK_BYTES = 4_096;

export type DecodedVoice = { ok: true; samples: Float32Array; sampleRate: number } | { ok: false; reason: "malformed" | "too_long" | "too_slow" };

/**
 * Decodes a Telegram voice note (OGG/Opus) to mono samples. Stops and refuses once more than `maxMs` of audio has come
 * out, whatever the message said its duration was, or once `deadline` (epoch ms) passes.
 */
export async function decodeVoiceNote(bytes: Uint8Array, opts: { maxMs: number; deadline: number }): Promise<DecodedVoice> {
  const maxSamples = Math.ceil((opts.maxMs / 1000) * OPUS_RATE);
  const decoder = new OggOpusDecoder({ forceStereo: false });
  const parts: Float32Array[] = [];
  let total = 0;
  const take = (decoded: { channelData: Float32Array[]; samplesDecoded: number; errors: unknown[] }) => {
    if (decoded.errors.length > 0) return "malformed" as const;
    if (decoded.samplesDecoded === 0) return null;
    const [first, ...rest] = decoded.channelData;
    const mono = new Float32Array(decoded.samplesDecoded);
    for (let i = 0; i < mono.length; i++) {
      let sum = first[i];
      for (const channel of rest) sum += channel[i];
      mono[i] = sum / (rest.length + 1);
    }
    parts.push(mono);
    total += mono.length;
    return total > maxSamples ? ("too_long" as const) : null;
  };
  try {
    await decoder.ready;
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
      if (Date.now() > opts.deadline) return { ok: false, reason: "too_slow" };
      const stop = take(await decoder.decode(bytes.subarray(at, at + CHUNK_BYTES)));
      if (stop) return { ok: false, reason: stop };
    }
    const stop = take(await decoder.flush());
    if (stop) return { ok: false, reason: stop };
    if (Date.now() > opts.deadline) return { ok: false, reason: "too_slow" };
  } catch {
    return { ok: false, reason: "malformed" };
  } finally {
    decoder.free();
  }
  if (total === 0) return { ok: false, reason: "malformed" };
  const samples = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  return { ok: true, samples, sampleRate: OPUS_RATE };
}
