import { describe, expect, it } from "vitest";
import { startRecording, type RecorderMedia } from "./voice-recorder";
import { voiceSession } from "./voice-session";

/** A browser whose microphone answers only when `allow` is called, faked far enough to see what was let go. */
function delayedMicrophone() {
  let allow!: () => void;
  const permission = new Promise<void>((resolve) => (allow = resolve));
  const tracks: { stopped: boolean; stop(): void }[] = [];
  const seen = { tracks, capturing: 0 };
  const node = () => ({ connect: () => {}, disconnect: () => {} });
  const media: RecorderMedia = {
    newContext: () =>
      ({
        sampleRate: 48_000,
        destination: node(),
        resume: async () => {},
        close: async () => {},
        createMediaStreamSource: node,
        createGain: () => ({ ...node(), gain: { value: 1 } }),
        audioWorklet: { addModule: async () => {} },
      }) as unknown as AudioContext,
    getUserMedia: async () => {
      await permission;
      const track = { stopped: false, stop: () => void (track.stopped = true) };
      tracks.push(track);
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
    newWorkletNode: () => {
      seen.capturing += 1;
      return { ...node(), port: { onmessage: null } } as unknown as AudioWorkletNode;
    },
  };
  return { media, seen, allow: () => allow() };
}

/** The steps VoiceNote takes: tap record, then the rider leaves Report, and maybe comes back. */
function voiceNoteOn(media: RecorderMedia) {
  const session = voiceSession((signal) => startRecording({ media, signal }));
  let recording = false;
  return {
    tapRecord: async () => {
      const rec = await session.start();
      recording = rec !== null;
      return rec;
    },
    leaveReport: () => session.leave(),
    isRecording: () => recording,
    session,
  };
}

describe("leaving Report while recording (S3D-6)", () => {
  it("leaving Report while the microphone is being set up stops it and never records (S3D-6)", async () => {
    const { media, seen, allow } = delayedMicrophone();
    const note = voiceNoteOn(media);
    const tapped = note.tapRecord();
    expect(note.leaveReport()).toBe(false);
    allow();
    expect(await tapped).toBeNull();
    // Let the permission's late arrival run through the recorder's own clean-up.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.tracks).toHaveLength(1);
    expect(seen.tracks.every((t) => t.stopped)).toBe(true);
    expect(seen.capturing).toBe(0);
    expect(note.isRecording()).toBe(false);
  });

  it("coming back before the microphone is ready doesn't start recording; a fresh tap then records (S3D-6)", async () => {
    const { media, seen, allow } = delayedMicrophone();
    const note = voiceNoteOn(media);
    const abandoned = note.tapRecord();
    note.leaveReport();
    // Back on Report: nothing is tapped, the old request resolves.
    allow();
    expect(await abandoned).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(note.isRecording()).toBe(false);
    expect(seen.capturing).toBe(0);
    expect(note.session.take()).toBeNull();

    const fresh = await note.tapRecord();
    expect(fresh).not.toBeNull();
    expect(seen.capturing).toBe(1);
    expect(note.session.take()).toBe(fresh);
  });

  it("leaving mid-recording cancels it, lets the microphone go and says so; a note taken for sending is left alone", async () => {
    const { media, seen, allow } = delayedMicrophone();
    allow();
    const note = voiceNoteOn(media);
    await note.tapRecord();
    expect(note.leaveReport()).toBe(true);
    expect(seen.tracks[0].stopped).toBe(true);
    expect(note.session.take()).toBeNull();

    const second = await note.tapRecord();
    expect(note.session.take()).toBe(second);
    expect(note.leaveReport()).toBe(false);
    expect(seen.tracks[1].stopped).toBe(false);
  });
});
