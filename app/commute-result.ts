import type { AnswerKind, Point, RouteState } from "../lib/answer";
import type { DemoTripId } from "../lib/samples";
import type { PageMuse } from "./commute-muse";
import type { AdvisoryArea } from "./map-layers";
import type { PageReport } from "./report-evidence";

export interface PageProduct {
  counts: boolean;
  event: string;
  area: string;
  sent: string;
  expires: string;
  link: string;
  rainForecast: string | null;
  rivers: string | null;
}

/** Every PAGASA product covering the way the answer recommends, and those Lusong couldn't place on the map. */
export interface PageAdvisory {
  state: "active" | "none" | "unreadable";
  about: "your way" | "the other way";
  products: PageProduct[];
  warnings: PageProduct[];
  incomplete: boolean;
  note: string | null;
}

/** The commute reply as the page reads it. */
export interface CommuteResult {
  trip: { id: DemoTripId | null; label: string };
  rainingHere: boolean;
  answer: { kind: AnswerKind; title: string; reason: string; thin: string | null };
  route: { lengthKm: number; timeMin: number; streets: string[]; line: Point[] };
  detour: {
    state: RouteState;
    proposedBy: "rules" | "muse_spark";
    lengthKm: number;
    timeMin: number;
    extraKm: number;
    extraMin: number;
    streets: string[];
    line: Point[];
  } | null;
  advisory: PageAdvisory;
  /** The PAGASA areas covering any checked way; optional so an older reply still renders. */
  advisoryAreas?: AdvisoryArea[];
  muse: PageMuse;
  reports: PageReport[];
  mmdaCredit: string;
}
