import type { Point } from "./answer";
import type { RefusalReason } from "./budget";
import { channelFromEnv, type Channel } from "./channel";
import { decodeVoiceNote } from "./ogg-opus";
import { MAX_BYTES as MAX_PHOTO_BYTES, MAX_SIDE, makePhotoReporter, photoSchedule, TIMING, type PhotoReportDeps, type PhotoReportOutcome, type Timing } from "./report-handler";
import { telegramStoreFromEnv, type Half, type LocationHalf, type MediaHalf, type TelegramStore } from "./telegram-store";
import { telegramFilesFromEnv, type TelegramFiles } from "./telegram-files";
import { inServerTripBound } from "./province-index";
import { TRIP_AREA_NAME } from "./trip-bound";
import { BISAYA_VOICE_ENABLED, VOICE_LANGUAGES, type VoiceLanguage } from "./voice-language";
import { makeVoiceReporter, VOICE_TIMING, voiceSchedule, type VoiceReportDeps, type VoiceReportOutcome, type VoiceTiming } from "./voice-report-handler";
import { encodeWav, MAX_VOICE_MS, parseVoiceWav } from "./wav";

/** The whole update is handled within this of its arrival, under the webhook route's 120 s maxDuration. */
export const WEBHOOK_BUDGET_MS = 100_000;
/** Kept back at the end for marking the update handled and sending the reply (lib/channel.ts SEND_TIMEOUT_MS). */
export const REPLY_RESERVE_MS = 10_000;
/** An update older than this when it is handled is refused, so a backlog doesn't place an old flood as current. */
export const STALE_AFTER_S = 10 * 60;
/** Telegram voice notes are Opus at a low bit rate; 30 s of one is far under this (S6P-4). */
export const MAX_VOICE_NOTE_BYTES = 512 * 1024;
/** The decoder stops this far past 30 s; anything over 30 s of decoded audio is then refused. */
const DECODER_STOP_SLACK_MS = 500;

const LANGUAGE_COMMANDS: Record<string, VoiceLanguage> = { bisaya: "ceb", tagalog: "tl", english: "en" };
const COMMAND_OF: Record<VoiceLanguage, string> = { ceb: "/bisaya", tl: "/tagalog", en: "/english" };
const LANGUAGE_COMMAND = /^\/(bisaya|tagalog|english)(?:@\w+)?\s*$/i;
const offeredCommands = VOICE_LANGUAGES.map((l) => COMMAND_OF[l.value])
  .join(", ")
  .replace(/, ([^,]*)$/, " or $1");

/** Everything the bot says about reports. Only these fixed sentences, filled from the report's fixed fields, are sent. */
export const TELEGRAM_REPLIES = {
  askLanguage: `Which language is your voice note in? Send ${offeredCommands}, then send the voice note again.`,
  languageSet: (language: VoiceLanguage) =>
    `Voice notes from this chat will be read as ${VOICE_LANGUAGES.find((l) => l.value === language)?.label}. To change it, send ${offeredCommands}.`,
  bisayaOff: `Lusong can't read Bisaya voice notes right now. Send ${offeredCommands}, or send a photo instead.`,
  photoWaiting: "Got your photo. Now send your location (attach, then Location) within 2 minutes, so Lusong knows which street it shows.",
  voiceWaiting: "Got your voice note. Now send your location (attach, then Location) within 2 minutes, so Lusong knows which street you mean.",
  locationWaiting: "Got your location. Now send a photo of the street or a voice note about it within 2 minutes.",
  forwarded: "Lusong takes only photos, voice notes and locations you send yourself, not forwarded ones.",
  venue: "Lusong needs the location you are at, not a place picked from a list. Send your location instead.",
  stale: "That message is more than 10 minutes old, so Lusong didn't use it. Send a new photo or voice note and your location.",
  outside: `Lusong takes reports from streets in ${TRIP_AREA_NAME} only.`,
  photoTooLarge: "That photo is too large. Send it again as a photo, not as a file.",
  voiceTooLong: "Voice notes can be up to 30 seconds. Record a shorter one.",
  voiceTooShort: "That voice note is too short. Say where you are and how deep the water is.",
  noWords: "Lusong couldn't hear any words in that note. Record it again closer to the phone.",
  couldntGet: "Lusong couldn't get the file from Telegram. Send it again in a minute.",
  couldntRead: "Lusong couldn't read it. Send it again in a minute.",
  inFlight: "Lusong is already reading this. Wait a minute for its answer.",
  outOfTime: "Lusong ran out of time for this report. Send it and your location again in a minute.",
  storeDown: "Lusong can't take reports right now. Try again later.",
  chatLimit: "This chat has sent today's reports. They start again at 8:00 a.m. Philippine time.",
  budget: "Today's free checks are used up. They start again at 8:00 a.m. Philippine time.",
  unavailable: "Lusong can't take new reports right now. Try again later.",
} as const;

const ADMISSION_REPLIES: Record<RefusalReason, string> = {
  ip: TELEGRAM_REPLIES.chatLimit,
  budget: TELEGRAM_REPLIES.budget,
  unavailable: TELEGRAM_REPLIES.unavailable,
};

/** The location is the one the rider sent, so the reply says where the report was placed in those terms. */
const placedAt = (place: string | null) => (place ? `at the location you sent, on ${place}` : "at the location you sent");

function photoReply(outcome: PhotoReportOutcome): string {
  if (!outcome.ok) {
    if (outcome.refused === "admission") return ADMISSION_REPLIES[outcome.reason];
    return {
      too_large: TELEGRAM_REPLIES.photoTooLarge,
      not_jpeg: TELEGRAM_REPLIES.couldntRead,
      store_down: TELEGRAM_REPLIES.storeDown,
      out_of_time: TELEGRAM_REPLIES.outOfTime,
      in_flight: TELEGRAM_REPLIES.inFlight,
      unread: TELEGRAM_REPLIES.couldntRead,
    }[outcome.refused];
  }
  const r = outcome.report;
  const head = outcome.duplicate ? `Lusong already read this photo, ${placedAt(r.place)}.` : `Lusong read your photo, ${placedAt(r.place)}.`;
  return [head, `Depth: ${r.depth}.`, `${r.passability}.`, r.effect].join("\n");
}

function voiceReply(outcome: VoiceReportOutcome): string {
  if (!outcome.ok) {
    if (outcome.refused === "admission") return ADMISSION_REPLIES[outcome.reason];
    return {
      store_down: TELEGRAM_REPLIES.storeDown,
      out_of_time: TELEGRAM_REPLIES.outOfTime,
      in_flight: TELEGRAM_REPLIES.inFlight,
      no_words: TELEGRAM_REPLIES.noWords,
      unheard: TELEGRAM_REPLIES.couldntRead,
      untranscribed: TELEGRAM_REPLIES.couldntRead,
    }[outcome.refused];
  }
  const r = outcome.report;
  const head = outcome.duplicate ? `Lusong already heard this voice note, ${placedAt(r.place)}.` : `Lusong heard your voice note, ${placedAt(r.place)}.`;
  return [head, r.heard, r.effect].join("\n");
}

/** UNVERIFIED beyond the docs: the fields read here are from core.telegram.org/bots/api (Update, Message, PhotoSize, Voice, Location). */
interface TelegramMessage {
  date?: unknown;
  chat?: { id?: unknown; type?: unknown };
  text?: unknown;
  photo?: { file_id?: unknown; width?: unknown; height?: unknown; file_size?: unknown }[];
  voice?: { file_id?: unknown; duration?: unknown; file_size?: unknown };
  location?: { latitude?: unknown; longitude?: unknown };
  venue?: unknown;
  forward_origin?: unknown;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

type Arrival =
  | { kind: "language"; language: VoiceLanguage }
  | { kind: "photo"; message: TelegramMessage }
  | { kind: "voice"; message: TelegramMessage }
  | { kind: "location"; message: TelegramMessage };

function arrivalOf(message: TelegramMessage): Arrival | null {
  if (typeof message.text === "string") {
    const command = LANGUAGE_COMMAND.exec(message.text.trim());
    return command ? { kind: "language", language: LANGUAGE_COMMANDS[command[1].toLowerCase()] } : null;
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) return { kind: "photo", message };
  if (message.voice && typeof message.voice === "object") return { kind: "voice", message };
  if (message.location && typeof message.location === "object") return { kind: "location", message };
  if (message.venue !== undefined) return { kind: "location", message };
  return null;
}

/** The largest of Telegram's sizes that the photo route would take, or null when even the smallest is too big. */
function photoSize(sizes: NonNullable<TelegramMessage["photo"]>): string | null {
  const fitting = sizes
    .filter((s) => typeof s.file_id === "string" && isNumber(s.width) && isNumber(s.height))
    .filter((s) => Math.max(s.width as number, s.height as number) <= MAX_SIDE && (!isNumber(s.file_size) || s.file_size <= MAX_PHOTO_BYTES))
    .sort((a, b) => (a.width as number) * (a.height as number) - (b.width as number) * (b.height as number));
  return (fitting.at(-1)?.file_id as string | undefined) ?? null;
}

export interface TelegramReportDeps {
  store: TelegramStore;
  channel: Channel;
  files: TelegramFiles;
  /** The report steps' own dependencies, as the page's routes take them. Publishing is always off here. */
  reports: PhotoReportDeps & VoiceReportDeps & { photoTiming?: Timing; voiceTiming?: VoiceTiming };
  now?: () => Date;
  budgetMs?: number;
  replyReserveMs?: number;
}

export interface TelegramReports {
  /** Null when the update isn't about reports, so the webhook handles it as before. */
  handle(update: unknown): Promise<Response | null>;
}

const ok = () => Response.json({ ok: true });
const storeFailed = () => Response.json({ error: "Lusong couldn't reach its store." }, { status: 500 });

/**
 * Photo and voice reports through the bot (plans/s6-telegram-reports.md). Done within the request, so a reply means
 * the work is over; each update is worked on once (its id is claimed first, then marked done), and a photo or voice
 * note pairs with a location atomically, so a redelivered update can never pay for a read or save a report twice.
 */
export function makeTelegramReports(deps: TelegramReportDeps): TelegramReports {
  const now = deps.now ?? (() => new Date());
  const budgetMs = deps.budgetMs ?? WEBHOOK_BUDGET_MS;
  const replyReserveMs = deps.replyReserveMs ?? REPLY_RESERVE_MS;
  const photoTiming = deps.reports.photoTiming ?? TIMING;
  const voiceTiming = deps.reports.voiceTiming ?? VOICE_TIMING;
  const processPhotoReport = makePhotoReporter({ ...deps.reports, timing: photoTiming });
  const processVoiceReport = makeVoiceReporter({ ...deps.reports, timing: voiceTiming });
  const { store, channel, files } = deps;

  async function report(chat: string, media: MediaHalf, location: LocationHalf, receivedAt: Date, deadline: number): Promise<string> {
    const at: Point = { lat: location.lat, lon: location.lon };
    const admitKey = `tg:${chat}`;
    if (media.kind === "photo") {
      const { claimBy } = photoSchedule(deadline, photoTiming);
      const download = await files.download(media.fileId, { maxBytes: MAX_PHOTO_BYTES, deadline: claimBy });
      if (!download.ok) return { too_large: TELEGRAM_REPLIES.photoTooLarge, too_slow: TELEGRAM_REPLIES.outOfTime, failed: TELEGRAM_REPLIES.couldntGet }[download.reason];
      // Telegram strips EXIF from photos, so there is no capture time: a clear photo can't mark the spot clear.
      return photoReply(await processPhotoReport({ upload: download.bytes, at, capturedAt: null, receivedAt, admitKey, deadline, publish: "never" }));
    }
    const { claimBy } = voiceSchedule(deadline, voiceTiming);
    const download = await files.download(media.fileId, { maxBytes: MAX_VOICE_NOTE_BYTES, deadline: claimBy });
    if (!download.ok) return { too_large: TELEGRAM_REPLIES.voiceTooLong, too_slow: TELEGRAM_REPLIES.outOfTime, failed: TELEGRAM_REPLIES.couldntGet }[download.reason];
    const decoded = await decodeVoiceNote(download.bytes, { maxMs: MAX_VOICE_MS + DECODER_STOP_SLACK_MS, deadline: claimBy });
    if (!decoded.ok) return { malformed: TELEGRAM_REPLIES.couldntRead, too_long: TELEGRAM_REPLIES.voiceTooLong, too_slow: TELEGRAM_REPLIES.outOfTime }[decoded.reason];
    // encodeWav cuts at 30 s, so the decoded length is checked first: a longer note is refused, never sent cut short.
    if ((decoded.samples.length / decoded.sampleRate) * 1000 > MAX_VOICE_MS) return TELEGRAM_REPLIES.voiceTooLong;
    const clip = parseVoiceWav(encodeWav(decoded.samples, decoded.sampleRate));
    if (!clip.ok) return clip.reason === "too_short" ? TELEGRAM_REPLIES.voiceTooShort : clip.reason === "too_long" ? TELEGRAM_REPLIES.voiceTooLong : TELEGRAM_REPLIES.couldntRead;
    return voiceReply(await processVoiceReport({ clip, language: media.language, at, receivedAt, admitKey, deadline }));
  }

  return {
    async handle(raw) {
      const update = raw as { update_id?: unknown; message?: TelegramMessage } | null;
      const message = update?.message;
      if (!message || typeof message !== "object") return null;
      const arrival = arrivalOf(message);
      if (!arrival) return null;
      const updateId = update?.update_id;
      const chatId = message.chat?.id;
      // Only private chats: a report is one rider's, and a group's messages aren't for the bot to answer.
      if (message.chat?.type !== "private" || !isNumber(chatId) || !Number.isSafeInteger(chatId) || !Number.isSafeInteger(updateId)) return ok();
      const chat = String(chatId);
      const reply = (text: string) => channel.send(chat, text);
      const started = Date.now();
      const receivedAt = now();

      const id = updateId as number;
      try {
        if (!(await store.claimUpdate(id))) return ok();
      } catch (err) {
        console.error("telegram store failed on update claim:", err instanceof Error ? err.message : err);
        return storeFailed();
      }
      // Marked handled before the reply, so a reply that never arrives can't bring the update back to be worked again.
      const finish = async (text: string) => {
        await store.finishUpdate(id).catch((err: unknown) => {
          console.error("telegram store failed on update finish:", err instanceof Error ? err.message : err);
        });
        await reply(text);
        return ok();
      };
      const giveBack = async () => {
        await store.releaseUpdate(id).catch(() => {});
        return storeFailed();
      };

      if (message.forward_origin !== undefined) return finish(TELEGRAM_REPLIES.forwarded);
      if (!isNumber(message.date) || receivedAt.getTime() / 1000 - message.date > STALE_AFTER_S) return finish(TELEGRAM_REPLIES.stale);
      const date = message.date;

      if (arrival.kind === "language") {
        if (arrival.language === "ceb" && !BISAYA_VOICE_ENABLED) return finish(TELEGRAM_REPLIES.bisayaOff);
        try {
          await store.setLanguage(chat, arrival.language);
        } catch (err) {
          console.error("telegram store failed on language:", err instanceof Error ? err.message : err);
          return giveBack();
        }
        return finish(TELEGRAM_REPLIES.languageSet(arrival.language));
      }
      // A picked place arrives with both venue and location set (Message.venue in the Bot API docs), so venue goes first.
      if (message.venue !== undefined) return finish(TELEGRAM_REPLIES.venue);
      let half: Half;
      if (arrival.kind === "photo") {
        const fileId = photoSize(message.photo!);
        if (!fileId) return finish(TELEGRAM_REPLIES.photoTooLarge);
        half = { side: "media", kind: "photo", fileId, date };
      } else if (arrival.kind === "voice") {
        const voice = message.voice!;
        if (typeof voice.file_id !== "string" || !isNumber(voice.duration)) return finish(TELEGRAM_REPLIES.couldntRead);
        const fileSize = isNumber(voice.file_size) ? voice.file_size : null;
        if (voice.duration > MAX_VOICE_MS / 1000 || (fileSize !== null && fileSize > MAX_VOICE_NOTE_BYTES)) return finish(TELEGRAM_REPLIES.voiceTooLong);
        let language: VoiceLanguage | null;
        try {
          language = await store.language(chat);
        } catch (err) {
          console.error("telegram store failed on language read:", err instanceof Error ? err.message : err);
          return giveBack();
        }
        // Nothing of the note is kept: once a language is chosen, the rider sends it again.
        if (!language || (language === "ceb" && !BISAYA_VOICE_ENABLED)) return finish(TELEGRAM_REPLIES.askLanguage);
        half = { side: "media", kind: "voice", fileId: voice.file_id, date, durationS: voice.duration, fileSize, language };
      } else {
        const { latitude: lat, longitude: lon } = message.location ?? {};
        // The same check as a web report: inside the box and inside a Philippine province.
        if (!isNumber(lat) || !isNumber(lon) || !inServerTripBound({ lat, lon })) return finish(TELEGRAM_REPLIES.outside);
        half = { side: "location", lat, lon, date };
      }

      let pairing: Awaited<ReturnType<TelegramStore["pair"]>>;
      try {
        pairing = await store.pair(chat, half, id);
      } catch (err) {
        console.error("telegram store failed on pairing:", err instanceof Error ? err.message : err);
        return giveBack();
      }
      if (!pairing.paired) {
        const waiting = half.side === "location" ? TELEGRAM_REPLIES.locationWaiting : half.kind === "photo" ? TELEGRAM_REPLIES.photoWaiting : TELEGRAM_REPLIES.voiceWaiting;
        return finish(waiting);
      }
      let text: string;
      try {
        text = await report(chat, pairing.media, pairing.location, receivedAt, started + budgetMs - replyReserveMs);
      } catch (err) {
        console.error("telegram report failed:", err instanceof Error ? err.message : err);
        text = TELEGRAM_REPLIES.couldntRead;
      }
      return finish(text);
    },
  };
}

/** The bot as deployed: its store, Telegram and the report steps from the environment; null when any is missing. */
export function telegramReportsFromEnv(reports: TelegramReportDeps["reports"]): TelegramReports | null {
  const store = telegramStoreFromEnv();
  const channel = channelFromEnv();
  const files = telegramFilesFromEnv();
  if (!store || !channel || !files) return null;
  return makeTelegramReports({ store, channel, files, reports });
}

