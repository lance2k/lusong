import type { Recording } from "./voice-recorder";

/**
 * The voice note's microphone, from the tap on record to the note being taken for sending. VoiceNote stays mounted
 * while the rider is elsewhere, so leaving Report has to let go of the microphone however far it got.
 */
export interface VoiceSession {
  /** Starts recording. Null when the rider left (or the page went) before the microphone was ready. */
  start(): Promise<Recording | null>;
  /** Hands over the recording under way, for sending; leaving after this no longer touches it. */
  take(): Recording | null;
  /**
   * The rider left Report: a microphone still being set up is let go as soon as it arrives, and a recording under way
   * is cancelled. True when a recording was under way, so the rider can be told it stopped.
   */
  leave(): boolean;
}

export function voiceSession(begin: (signal: AbortSignal) => Promise<Recording>): VoiceSession {
  let attempt: AbortController | null = null;
  let active: Recording | null = null;
  return {
    async start() {
      attempt?.abort();
      const mine = new AbortController();
      attempt = mine;
      try {
        const rec = await begin(mine.signal);
        if (mine.signal.aborted) {
          rec.cancel();
          return null;
        }
        active = rec;
        return rec;
      } catch (err) {
        if (mine.signal.aborted) return null;
        throw err;
      } finally {
        if (attempt === mine) attempt = null;
      }
    },
    take() {
      const rec = active;
      active = null;
      return rec;
    },
    leave() {
      attempt?.abort();
      attempt = null;
      const rec = active;
      active = null;
      rec?.cancel();
      return rec !== null;
    },
  };
}
