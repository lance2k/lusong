import type { Point } from "./answer";
import { judgeArea, type CapArea } from "./advisory-geo";
import { COUNTING_KINDS, type SnapshotReading } from "./advisory-snapshot";

/** One CAP area that covers a checked route, for the map: every field is PAGASA's own, never a model's. */
export interface AdvisoryArea {
  /** The CAP event, e.g. "General Flood Advisory (Moderate)". */
  kind: string;
  /** [lat, lon] rings; empty when the area has no polygon Lusong draws. */
  rings: [number, number][][];
  /** CAP times as PAGASA wrote them (ISO 8601, +08:00). */
  sent: string | null;
  expires: string | null;
  headline: string;
}

export const MAX_MAP_AREAS = 8;
export const MAX_MAP_POINTS = 2_000;
/** A ring wider than this is the Philippine Area of Responsibility or similar: it would paint the whole map. */
export const MAX_RING_SPAN_DEG = 6;

const MIN_RING_POINTS = 4;

function spanDeg(ring: readonly number[]): number {
  const lons = ring.filter((_, i) => i % 2 === 0);
  const lats = ring.filter((_, i) => i % 2 === 1);
  return Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats));
}

function asLatLon(ring: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i + 1], ring[i]]);
  return out;
}

const pointCount = (areas: readonly AdvisoryArea[]) => areas.reduce((n, a) => n + a.rings.reduce((m, r) => m + r.length, 0), 0);

/** Keeps every stride-th point and the closing one; a ring left too small to draw is dropped. */
function thin(ring: [number, number][], stride: number): [number, number][] | null {
  if (stride <= 1) return ring;
  const kept = ring.filter((_, i) => i % stride === 0);
  const last = ring[ring.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept.length >= MIN_RING_POINTS ? kept : null;
}

function withinPointCap(areas: AdvisoryArea[]): AdvisoryArea[] {
  const total = pointCount(areas);
  if (total <= MAX_MAP_POINTS) return areas;
  const stride = Math.ceil(total / MAX_MAP_POINTS) + 1;
  const thinned = areas.map((a) => ({ ...a, rings: a.rings.map((r) => thin(r, stride)).filter((r): r is [number, number][] => r !== null) }));
  let budget = MAX_MAP_POINTS;
  return thinned.map((a) => ({
    ...a,
    rings: a.rings.filter((r) => (r.length <= budget ? ((budget -= r.length), true) : false)),
  }));
}

/**
 * The CAP areas that cover any of the checked lines (the plain route and every detour judged), counting products
 * first, newest first, at most MAX_MAP_AREAS areas and MAX_MAP_POINTS points in all.
 */
export function advisoryAreasFor(reading: SnapshotReading, lines: readonly (readonly Point[])[], now: Date): AdvisoryArea[] {
  const products = [...(reading.snapshot?.products ?? [])].sort(
    (a, b) => Number(COUNTING_KINDS.has(b.kind)) - Number(COUNTING_KINDS.has(a.kind)) || Date.parse(b.sent) - Date.parse(a.sent),
  );
  const seen = new Set<string>();
  const areas: AdvisoryArea[] = [];
  for (const product of products) {
    for (const info of product.infos) {
      if (Date.parse(info.expires) <= now.getTime()) continue;
      for (const area of info.areas) {
        const key = JSON.stringify([product.id, area.desc, area.polygons]);
        if (seen.has(key) || !lines.some((line) => judgeArea(area, line) === "covers")) continue;
        seen.add(key);
        areas.push(mapArea(area, product, info.expires));
      }
    }
  }
  return withinPointCap(areas.slice(0, MAX_MAP_AREAS));
}

function mapArea(area: CapArea, product: { event: string; headline: string | null; sent: string }, expires: string): AdvisoryArea {
  const drawable = area.polygons.every((ring) => spanDeg(ring) <= MAX_RING_SPAN_DEG);
  return {
    kind: product.event,
    rings: drawable ? area.polygons.map(asLatLon) : [],
    sent: product.sent,
    expires,
    headline: product.headline ?? product.event,
  };
}
