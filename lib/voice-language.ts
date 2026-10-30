/**
 * Bisaya (Cebuano) is not among Voice Transcribe's 25 languages, so it would go through Muse Spark's own audio input
 * instead. Out until the owner's 10 s clip probe passes (lance2k/lusong#9); no Spark audio call is written, and a
 * Bisaya note is refused before anything is spent.
 */
export const BISAYA_VOICE_ENABLED = false;

/**
 * The language a rider says their note is in. Lusong can't tell a note's language without sending it to Meta, so it
 * goes by what the rider picked before recording.
 */
export type VoiceLanguage = "tl" | "en";

/** The choices the page offers, in order. Bisaya joins them only once it has a path of its own. */
export const VOICE_LANGUAGES: readonly { value: VoiceLanguage; label: string }[] = [
  { value: "tl", label: "Tagalog" },
  { value: "en", label: "English" },
];

export const VOICE_LANGUAGE_NAMES: Record<VoiceLanguage, string> = { tl: "Tagalog", en: "English" };

/** The rider's pick from the form, or null when it is missing, empty, unknown, or Bisaya. */
export function voiceLanguageFrom(value: FormDataEntryValue | null): VoiceLanguage | null {
  return VOICE_LANGUAGES.some((l) => l.value === value) ? (value as VoiceLanguage) : null;
}
