import type { AdvisoryArea } from "../lib/advisory-areas";
import { phtTime } from "../lib/commute-words";
import { ADVISORY_INCOMPLETE_LINE } from "./credits";
import type { MapPin } from "./map";

/** The server's own type (a type-only import, so none of its geometry code reaches the page); rings are [lat, lon]. */
export type { AdvisoryArea };

const drawable = (ring: unknown): ring is [number, number][] => Array.isArray(ring) && ring.length >= 3;

/** The map's own controls. Its credits sit top right, which no sheet height covers. */
export const MAP_OPTIONS = { attributionControl: false, zoomControl: false, scrollWheelZoom: true } as const;
export const ATTRIBUTION_CONTROL = { position: "topright" } as const;
export const ZOOM_CONTROL = { position: "bottomright" } as const;

/** The keys Leaflet's keyboard handler pans or zooms with; it ignores them under Alt, Ctrl or Meta, and so does this. */
const MAP_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "+", "=", "-", "_"]);

/** Whether a key pressed on the map moved it, so it stops refitting. Tabbing through the map moves nothing. */
export function movesTheMap(e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  return !e.altKey && !e.ctrlKey && !e.metaKey && MAP_KEYS.has(e.key);
}

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The reply's advisory areas, drawn or not: an area with no ring (no polygon, or PAGASA's whole area of responsibility) is listed only. */
export function advisoryAreasOf(reply: { advisoryAreas?: AdvisoryArea[] | null } | null): AdvisoryArea[] {
  const areas = reply?.advisoryAreas ?? [];
  return Array.isArray(areas) ? areas.filter((a) => typeof a?.headline === "string" && Array.isArray(a.rings)) : [];
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
  /** One CAP polygon, [lat, lon]. */
  ring: [number, number][];
  className: string;
  tooltip: string[];
}

/**
 * The shapes the map shades: one per CAP polygon. An area's polygons are separate pieces of ground (the server counts
 * a route covered by any of them), so they are never joined into one shape, where a second ring would cut a hole.
 */
export function areaShapes(areas: AdvisoryArea[]): AreaShape[] {
  return areas.flatMap((a) => {
    const className = `lusong-area lusong-area-${a.kind.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const tooltip = [a.headline, sentExpires(a)].filter((line): line is string => Boolean(line));
    return a.rings.filter(drawable).map((ring) => ({ ring, className, tooltip }));
  });
}

export interface FitPadding {
  topLeft: [number, number];
  bottomRight: [number, number];
}

/**
 * What a fit keeps clear: the top band always, and the sheet on a phone. A sheet taller than half the screen is
 * fitted as if at half, so the map always keeps room to fit into (a full sheet would leave it none).
 */
export function fitPadding(input: { desktop: boolean; sheetPx: number; vh: number }): FitPadding {
  if (input.desktop) return { topLeft: [440, 96], bottomRight: [80, 24] };
  return { topLeft: [24, 96], bottomRight: [24, Math.min(input.sheetPx, Math.round(input.vh / 2)) + 24] };
}

/** Leaflet sets a string tooltip as HTML, and an area's headline comes from the reply, so it gets text nodes only. */
export function textBlock(lines: string[], doc: Pick<Document, "createElement">): HTMLElement {
  const box = doc.createElement("div");
  for (const line of lines) {
    const p = doc.createElement("p");
    p.textContent = line;
    box.append(p);
  }
  return box;
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
  advisory: { state: string; note: string | null; incomplete?: boolean };
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
  const drawn = areaShapes(areas).length;
  const areaLines =
    areas.length === 0
      ? ["No area in this reply"]
      : [...areas.flatMap((a) => [a.headline, sentExpires(a)]), "PAGASA, CC BY 4.0"].filter((l): l is string => Boolean(l));
  if (reply?.advisory.incomplete) areaLines.push(ADVISORY_INCOMPLETE_LINE);
  else if (reply?.advisory.state === "unreadable" && reply.advisory.note) areaLines.push(reply.advisory.note);
  return [
    {
      id: "routes",
      label: reply?.detour ? "Your usual way · The other way" : "Route",
      available: reply !== null,
      lines: checkedAt ? [`Checked ${timeWords(checkedAt)}`] : [],
    },
    { id: "reports", label: "Reports", available: Boolean(reply && reply.reports.length > 0), lines: reportLines },
    { id: "areas", label: "PAGASA areas", available: drawn > 0, lines: areaLines },
    { id: "closures", label: "Road closures", available: false, lines: ["Coming soon"] },
    { id: "rain", label: "Rain now", available: false, lines: ["Coming soon"] },
  ];
}
