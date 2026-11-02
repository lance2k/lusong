/**
 * Bisaya (Cebuano) is not among Voice Transcribe's 25 languages, so it goes through Muse Spark 1.2's own audio input
 * instead (lib/voice-claim.ts). In since the owner's 10 s clip probe passed (lance2k/lusong#9); false takes it off the
 * page and refuses a Bisaya note before anything is spent.
 */
export const BISAYA_VOICE_ENABLED = true;

/**
 * The language a rider says their note is in. Lusong can't tell a note's language without sending it to Meta, so it
 * goes by what the rider picked before recording.
 */
export type VoiceLanguage = "ceb" | "tl" | "en";

const ALL_VOICE_LANGUAGES: readonly { value: VoiceLanguage; label: string }[] = [
  { value: "ceb", label: "Bisaya" },
  { value: "tl", label: "Tagalog" },
  { value: "en", label: "English" },
];

/** The choices the page offers, in order: Bisaya first, since Cebu speaks it. */
export const VOICE_LANGUAGES = ALL_VOICE_LANGUAGES.filter((l) => BISAYA_VOICE_ENABLED || l.value !== "ceb");

export const VOICE_LANGUAGE_NAMES: Record<VoiceLanguage, string> = { ceb: "Cebuano (Bisaya)", tl: "Tagalog", en: "English" };

/** The rider's pick from the form, or null when it is missing, empty, or not offered. */
export function voiceLanguageFrom(value: FormDataEntryValue | null): VoiceLanguage | null {
  return VOICE_LANGUAGES.some((l) => l.value === value) ? (value as VoiceLanguage) : null;
}

/** The refusal when no offered language was picked, naming the ones that are. */
export const PICK_A_LANGUAGE = `Pick ${VOICE_LANGUAGES.map((l) => l.label)
  .join(", ")
  .replace(/, ([^,]*)$/, " or $1")} for your voice note, then record it.`;
