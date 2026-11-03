"use client";

import { useState } from "react";
import Checker from "./checker";
import { ABOUT_INTRO, CHECK_INTRO, CREDITS_LINE, ESTIMATE_LINE, PHOTO_PRIVACY_LINE, REPORT_INTRO, TILES_LINE } from "./credits";
import ReportStreet from "./report";
import type { Trip } from "./trip";
import { Chip } from "./ui/chip";
import VoiceNote from "./voice-note";
import { WatcherPanel } from "./watcher-panel";

/** Kept mounted while hidden, so a send in flight lands and is told even after the rider leaves the view. */
export function ReportView({ shown, notify }: { shown: boolean; notify: (line: string) => void }) {
  const [tab, setTab] = useState<"photo" | "voice">("photo");
  return (
    <div className="space-y-4 text-[15px]">
      <p className="leading-snug text-ink-2">{REPORT_INTRO}</p>
      <div role="group" aria-label="Report with" className="flex gap-2">
        <Chip pressed={tab === "photo"} onClick={() => setTab("photo")}>
          Photo
        </Chip>
        <Chip pressed={tab === "voice"} onClick={() => setTab("voice")}>
          Voice note
        </Chip>
      </div>
      <div hidden={tab !== "photo"} className="space-y-3">
        <p className="text-small text-ink-2">{PHOTO_PRIVACY_LINE}</p>
        <ReportStreet shown={shown && tab === "photo"} notify={notify} />
      </div>
      <div hidden={tab !== "voice"}>
        <VoiceNote shown={shown && tab === "voice"} notify={notify} />
      </div>
    </div>
  );
}

export function CheckView() {
  return (
    <div className="space-y-4 text-[15px]">
      <p className="leading-snug text-ink-2">{CHECK_INTRO}</p>
      <p className="text-small text-ink-2">{PHOTO_PRIVACY_LINE}</p>
      <Checker />
    </div>
  );
}

export function WatchView({ trip }: { trip: Trip | null }) {
  return <WatcherPanel trip={trip} />;
}

export function AboutView() {
  return (
    <div className="space-y-4 text-[15px] leading-relaxed">
      <p className="text-lg leading-snug">{ABOUT_INTRO}</p>
      <p>{ESTIMATE_LINE}</p>
      <p>{PHOTO_PRIVACY_LINE}</p>
      <p>{CREDITS_LINE}</p>
      <p>{TILES_LINE}</p>
    </div>
  );
}
