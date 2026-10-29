import type { VoiceLanguage } from "../lib/voice-language";
import { encodeWav } from "../lib/wav";

/** Copies each block of microphone samples to the page. Loaded from a Blob URL, so it needs no file of its own. */
const CAPTURE_PROCESSOR = `
class LusongCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("lusong-capture", LusongCapture);
`;

export interface Recording {
  /** Stops the microphone and returns the note as 16 kHz mono 16-bit WAV, cut at 30 s. */
  stop(): Promise<Blob>;
  cancel(): void;
}

/** The browser's audio objects, passed in so the recorder's clean-up can be tested without a browser. */
export interface RecorderMedia {
  newContext(): AudioContext;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  newWorkletNode(ctx: AudioContext, name: string, options: AudioWorkletNodeOptions): AudioWorkletNode;
}

export const browserMedia = (): RecorderMedia => ({
  newContext: () => new AudioContext(),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  newWorkletNode: (ctx, name, options) => new AudioWorkletNode(ctx, name, options),
});

/**
 * Raw samples from the microphone at the device's own rate, through an AudioWorklet where the browser has one and a
 * ScriptProcessor where it doesn't; resampled to 16 kHz only when the note is encoded.
 *
 * However setup fails, the microphone's tracks are stopped and the audio context closed before the error is thrown.
 * `signal` is the page's: aborted while recording is starting, the start is given up and everything let go once the
 * pending step returns (an AbortError is thrown); aborted after, the recording is cancelled at once.
 */
export async function startRecording(opts: { media?: RecorderMedia; signal?: AbortSignal } = {}): Promise<Recording> {
  const media = opts.media ?? browserMedia();
  const signal = opts.signal;
  // Created inside the tap, before any await, so Safari lets it start.
  const ctx = media.newContext();
  let stream: MediaStream | null = null;
  const nodes: AudioNode[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const node of nodes) node.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    void ctx.close();
  };
  const unlessGivenUp = () => {
    if (signal?.aborted) throw new DOMException("The page stopped the recording while it was starting.", "AbortError");
  };

  const chunks: Float32Array[] = [];
  try {
    stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    unlessGivenUp();
    await ctx.resume();
    unlessGivenUp();
    const source = ctx.createMediaStreamSource(stream);
    nodes.push(source);
    // Silent output: Chrome only runs nodes that lead to the destination.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    nodes.push(mute);
    let node: AudioNode;
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      unlessGivenUp();
      const worklet = media.newWorkletNode(ctx, "lusong-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => chunks.push(e.data);
      node = worklet;
    } else {
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      node = processor;
    }
    nodes.push(node);
    source.connect(node);
    node.connect(mute);
  } catch (err) {
    release();
    throw err;
  }
  signal?.addEventListener("abort", release, { once: true });

  return {
    async stop() {
      const rate = ctx.sampleRate;
      release();
      const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        samples.set(c, offset);
        offset += c.length;
      }
      return new Blob([encodeWav(samples, rate)], { type: "audio/wav" });
    },
    cancel: release,
  };
}

/** What the page posts to /api/report/voice: the note, the phone's location and the language the rider picked. */
export function voiceNoteForm(audio: Blob, at: { lat: number; lon: number }, language: VoiceLanguage): FormData {
  const form = new FormData();
  form.append("audio", audio, "note.wav");
  form.append("lat", String(at.lat));
  form.append("lon", String(at.lon));
  form.append("language", language);
  return form;
}
