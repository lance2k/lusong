import { describe, expect, it } from "vitest";
import { startRecording, type RecorderMedia } from "./voice-recorder";

/** The browser's audio objects, faked far enough to see whether the microphone and the audio context were let go. */
function fakeMedia(opts: { permission?: Promise<void>; resume?: () => Promise<void>; addModule?: () => Promise<void>; worklet?: () => void } = {}) {
  const track = { stopped: false, stop: () => void (track.stopped = true) };
  const node = () => ({ connect: () => {}, disconnect: () => {} });
  const seen = { track, contextClosed: false, workletNodes: 0, granted: false };
  const ctx = {
    sampleRate: 48_000,
    destination: node(),
    resume: opts.resume ?? (async () => {}),
    close: async () => void (seen.contextClosed = true),
    createMediaStreamSource: node,
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    audioWorklet: { addModule: opts.addModule ?? (async () => {}) },
  };
  const media: RecorderMedia = {
    newContext: () => ctx as unknown as AudioContext,
    getUserMedia: async () => {
      await opts.permission;
      seen.granted = true;
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
    newWorkletNode: () => {
      opts.worklet?.();
      seen.workletNodes += 1;
      return { ...node(), port: { onmessage: null } } as unknown as AudioWorkletNode;
    },
  };
  return { media, seen };
}

describe("the microphone is let go on every way recording can fail to start (🟡T9-3)", () => {
  it.each([
    ["the capture module fails to load after the microphone was allowed", { addModule: () => Promise.reject(new Error("module load failed")) }],
    ["the audio context won't resume", { resume: () => Promise.reject(new Error("not allowed")) }],
    ["the capture node can't be made", { worklet: () => { throw new Error("no such processor"); } }],
  ])("%s: every track stopped, the audio context closed", async (_why, failure) => {
    const { media, seen } = fakeMedia(failure);
    await expect(startRecording({ media })).rejects.toThrow();
    expect(seen.granted).toBe(true);
    expect(seen.track.stopped).toBe(true);
    expect(seen.contextClosed).toBe(true);
  });

  it("the microphone refused: the audio context closed", async () => {
    const { media, seen } = fakeMedia({ permission: Promise.reject(new Error("denied")) });
    await expect(startRecording({ media })).rejects.toThrow("denied");
    expect(seen.contextClosed).toBe(true);
  });
});
