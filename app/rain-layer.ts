import { phtTime } from "../lib/commute-words";
import { LATTICE_DEG, RAIN_CREDIT, type RainReply, type RainStatus } from "../lib/rain";

export type RainBand = "none" | "light" | "moderate" | "heavy";

export const LIGHT_BELOW_MM = 2.5;
export const MODERATE_BELOW_MM = 7.6;

/** Every band carries a word, so the map never relies on colour alone. `none` is never drawn. */
export const RAIN_BANDS: Record<RainBand, { label: string; range: string; fill: string; fillOpacity: number }> = {
  none: { label: "No rain", range: "0 mm", fill: "#000000", fillOpacity: 0 },
  light: { label: "Light rain", range: "under 2.5 mm", fill: "#4fb3ff", fillOpacity: 0.5 },
  moderate: { label: "Moderate rain", range: "2.5 to 7.5 mm", fill: "#2f6fe8", fillOpacity: 0.6 },
  heavy: { label: "Heavy rain", range: "7.6 mm or more", fill: "#a21caf", fillOpacity: 0.7 },
};

export function rainBand(mm: number): RainBand {
  if (!(mm > 0)) return "none";
  if (mm < LIGHT_BELOW_MM) return "light";
  if (mm < MODERATE_BELOW_MM) return "moderate";
  return "heavy";
}

const METRES_PER_DEGREE = 111_320;

export interface RainCircle {
  lat: number;
  lon: number;
  mm: number;
  band: Exclude<RainBand, "none">;
  /** The band's word plus the reading, for a tooltip or screen reader: "Light rain, 0.4 mm". */
  label: string;
  radiusM: number;
  fill: string;
  fillOpacity: number;
}

export interface RainLegend {
  /** The one-line legend row: what the layer is, when the model says it is for, and whose data it is. */
  text: string;
  /** Set when the layer is not showing rain; the map shows it in place of the circles. */
  notice: string | null;
  bands: { band: Exclude<RainBand, "none">; label: string; range: string }[];
}

export interface RainLayer {
  circles: RainCircle[];
  /** Points the model says are dry: counted, not drawn. */
  dryPoints: number;
  legend: RainLegend;
}

const NOTICES: Record<Exclude<RainStatus, "ok">, string> = {
  paused: "Rain layer paused",
  refused: "Zoom in on the Philippines to see rain",
  down: "Rain layer unavailable",
};

const LEGEND_BANDS = (["light", "moderate", "heavy"] as const).map((band) => ({
  band,
  label: RAIN_BANDS[band].label,
  range: RAIN_BANDS[band].range,
}));

/** Grid spacing in degrees, read from the points so a thinned grid (wide view) gets wider circles. */
function spacingDeg(points: RainReply["points"]): number {
  let best = Infinity;
  for (const axis of ["lat", "lon"] as const) {
    const values = [...new Set(points.map((p) => p[axis]))].sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) best = Math.min(best, values[i] - values[i - 1]);
  }
  return Number.isFinite(best) ? best : LATTICE_DEG;
}

export function buildRainLayer(reply: RainReply): RainLayer {
  if (reply.status !== "ok") {
    return {
      circles: [],
      dryPoints: 0,
      legend: { text: `${RAIN_CREDIT}. ${NOTICES[reply.status]}.`, notice: NOTICES[reply.status], bands: LEGEND_BANDS },
    };
  }
  const radiusM = Math.round((spacingDeg(reply.points) / 2) * METRES_PER_DEGREE);
  const circles: RainCircle[] = [];
  let dryPoints = 0;
  for (const p of reply.points) {
    const band = rainBand(p.mm);
    if (band === "none") {
      dryPoints += 1;
      continue;
    }
    const style = RAIN_BANDS[band];
    circles.push({
      lat: p.lat,
      lon: p.lon,
      mm: p.mm,
      band,
      label: `${style.label}, ${p.mm.toFixed(1)} mm`,
      radiusM,
      fill: style.fill,
      fillOpacity: style.fillOpacity,
    });
  }
  const when = reply.modelTime ? `, ${phtTime(reply.modelTime)}` : "";
  return {
    circles,
    dryPoints,
    legend: {
      text: `Rain now: model estimate${when}. Open-Meteo (CC BY 4.0)`,
      notice: null,
      bands: LEGEND_BANDS,
    },
  };
}

/** The legend row's lines for the Rain now layer, in the order a rider reads them. */
export function rainRowLines(layer: RainLayer | null, loading: boolean): string[] {
  if (!layer) return [loading ? "Loading rain for this view…" : "Off. Switch on to see model rain for the map's view.", RAIN_CREDIT];
  const { legend } = layer;
  if (legend.notice) return [legend.notice, RAIN_CREDIT];
  const bands = legend.bands.map((b) => `${b.label}: ${b.range}`).join(" · ");
  return [legend.text, layer.circles.length === 0 ? "No rain in this view." : bands];
}
