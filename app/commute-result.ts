import type { AnswerKind, Point, RouteState } from "../lib/answer";
import type { DemoTripId } from "../lib/samples";
import type { PageMuse } from "./commute-muse";
import type { AdvisoryArea } from "./map-layers";
import type { PageReport } from "./report-evidence";

export interface PageAdvisory {
  state: "active" | "none" | "unreadable";
  headline?: string | null;
  rainForecast?: string | null;
  rivers?: string | null;
  sent?: string;
  expires?: string;
  link?: string;
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
  /** Not sent yet: the server adds it when the province polygons land. */
  advisoryAreas?: AdvisoryArea[];
  muse: PageMuse;
  reports: PageReport[];
  mmdaCredit: string;
}
