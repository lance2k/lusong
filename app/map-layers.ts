import { phtTime } from "../lib/commute-words";
import type { MapPin } from "./map";

/** One PAGASA advisory area as the commute reply will carry it; rings are [lat, lon] and read by the even-odd rule. */
export type AdvisoryArea = { kind: string; rings: [number, number][][]; sent: string | null; expires: string | null; headline: string };

/** The map's own controls. Its credits sit top right, which no sheet height covers. */
export const MAP_OPTIONS = { attributionControl: false, zoomControl: false, scrollWheelZoom: true } as const;
export const ATTRIBUTION_CONTROL = { position: "topright" } as const;
export const ZOOM_CONTROL = { position: "bottomright" } as const;

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The reply's advisory areas; until the server sends them the field is absent, and the layer stays off. */
export function advisoryAreasOf(reply: { advisoryAreas?: AdvisoryArea[] | null } | null): AdvisoryArea[] {
  const areas = reply?.advisoryAreas ?? [];
  return Array.isArray(areas) ? areas.filter((a) => Array.isArray(a?.rings) && a.rings.some((r) => Array.isArray(r) && r.length >= 3)) : [];
}

/** An ISO time in PHT words; anything else, such as text the server already wrote, as it is. */
export function timeWords(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)) ? phtTime(value) : value;
}

export function sentExpires(area: Pick<AdvisoryArea, "sent" | "expires">): string | null {
  const parts = [area.sent && `Sent ${timeWords(area.sent)}`, area.expires && `expires ${timeWords(area.expires)}`].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface AreaShape {
  rings: [number, number][][];
  className: string;
  tooltip: string[];
}

export function areaShapes(areas: AdvisoryArea[]): AreaShape[] {
  return areas.map((a) => ({
    rings: a.rings.filter((r) => r.length >= 3),
    className: `lusong-area lusong-area-${a.kind.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    tooltip: [a.headline, sentExpires(a)].filter((line): line is string => Boolean(line)),
  }));
}

export interface RouteStyle {
  className: string;
  weight: number;
  opacity: number;
  dashArray?: string;
}

/** The usual way in the brand colour; the other way dashed. With the other way shown, the usual way fades to half. */
export function routeStyles(hasDetour: boolean): { route: RouteStyle; detour: RouteStyle } {
  return {
    route: { className: "lusong-route", weight: 6, opacity: hasDetour ? 0.5 : 0.9 },
    detour: { className: "lusong-detour", weight: 6, opacity: 0.95, dashArray: "10 8" },
  };
}

export interface PinSpec {
  glyph: "drop" | "tick" | "unknown";
  tone: "wait" | "go" | "unknown" | "stale";
  badge: string;
  sample: boolean;
}

const GLYPHS: Record<MapPin["role"], PinSpec["glyph"]> = { block: "drop", clear: "tick", neutral: "unknown" };
const TONES: Record<MapPin["role"], PinSpec["tone"]> = { block: "wait", clear: "go", neutral: "unknown" };

/** A report pin: its glyph by role, grey once it is over 3 h old (shown, not counted), and its age badge. */
export function pinSpec(pin: MapPin): PinSpec {
  return {
    glyph: GLYPHS[pin.role],
    tone: pin.counts ? TONES[pin.role] : "stale",
    badge: `${pin.sample ? "Sample · " : ""}${pin.age}`,
    sample: pin.sample,
  };
}

/** Minutes in one of the reply's age phrases ("just now", "40 min ago", "2 h 5 min ago"); null for anything else. */
export function ageMinutes(age: string): number | null {
  if (age === "just now") return 0;
  const m = /^(?:(\d+) h)?\s*(?:(\d+) min)? ago$/.exec(age.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

export type LayerId = "routes" | "reports" | "areas";
export type LayerToggles = Record<LayerId, boolean>;
export const ALL_LAYERS: LayerToggles = { routes: true, reports: true, areas: true };

export interface LegendRow {
  id: LayerId | "closures" | "rain";
  label: string;
  /** False when there is nothing to toggle: no answer yet, no area in this reply, or a layer still to come. */
  available: boolean;
  lines: string[];
}

export interface LegendReply {
  detour: unknown | null;
  reports: { age: string; sample: boolean }[];
  advisoryAreas?: AdvisoryArea[] | null;
  advisory: { state: string; note: string | null };
}

export function legendRows(reply: LegendReply | null, checkedAt: string | null): LegendRow[] {
  const areas = advisoryAreasOf(reply);
  const ages = (reply?.reports ?? []).map((r) => ({ age: r.age, min: ageMinutes(r.age) })).filter((a) => a.min !== null);
  ages.sort((a, b) => a.min! - b.min!);
  const reportLines = !reply
    ? []
    : reply.reports.length === 0
      ? ["No reports on this trip."]
      : [ages.length > 1 ? `Newest ${ages[0].age} · oldest ${ages[ages.length - 1].age}` : ages.length === 1 ? ages[0].age : null, "Older than 3 hours: shown, not counted."].filter(
          (l): l is string => Boolean(l),
        );
  const first = areas[0];
  const areaLines = areas.length === 0 ? ["No area in this reply"] : [first.headline, sentExpires(first), "PAGASA, CC BY 4.0"].filter((l): l is string => Boolean(l));
  if (reply?.advisory.state === "unreadable" && reply.advisory.note) areaLines.push(reply.advisory.note);
  return [
    {
      id: "routes",
      label: reply?.detour ? "Your usual way · The other way" : "Route",
      available: reply !== null,
      lines: checkedAt ? [`Checked ${timeWords(checkedAt)}`] : [],
    },
    { id: "reports", label: "Reports", available: Boolean(reply && reply.reports.length > 0), lines: reportLines },
    { id: "areas", label: "PAGASA areas", available: areas.length > 0, lines: areaLines },
    { id: "closures", label: "Road closures", available: false, lines: ["Coming soon"] },
    { id: "rain", label: "Rain now", available: false, lines: ["Coming soon"] },
  ];
}
