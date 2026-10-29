import type { VoiceLanguage } from "../lib/voice-language";

/** What the page posts to /api/report/voice: the note, the phone's location and the language the rider picked. */
export function voiceNoteForm(audio: Blob, at: { lat: number; lon: number }, language: VoiceLanguage): FormData {
  const form = new FormData();
  form.append("audio", audio, "note.wav");
  form.append("lat", String(at.lat));
  form.append("lon", String(at.lon));
  form.append("language", language);
  return form;
}
