import { inBound, type Bound } from "./trip-bound";

export interface Place {
  id: string;
  name: string;
  /** Where it is: district, city, province, from the source's own fields. */
  area: string;
  lat: number;
  lon: number;
  source: "built-in" | "osm";
  /** Photon's osm_key and type ("highway", "street"), so a caller can tell a road from a city's centroid. */
  feature?: { key: string; type: string };
}

/** ok: Photon answered. busy: the shared queue was full or Photon throttled. down: Photon or the queue's store
 *  couldn't be reached. short: the query was too short or too long to send. */
export type PlacesStatus = "ok" | "busy" | "down" | "short";

export interface PlacesReply {
  status: PlacesStatus;
  places: Place[];
}

export const MIN_QUERY = 3;
export const MAX_QUERY = 80;
export const MAX_PLACES = 8;
const MAX_BUILT_IN = 5;

/** The query as sent: trimmed, spaces collapsed, control characters dropped; null outside 3–80 characters. */
export function placeQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return q.length >= MIN_QUERY && q.length <= MAX_QUERY ? q : null;
}

/** Points from Photon (OSM), 2026-11-03, one lookup each; names and areas are Lusong's. */
export const BUILT_IN_PLACES: readonly Place[] = [
  ["cebu-it-park", "Cebu IT Park", "Lahug, Cebu City", 10.33174, 123.90656],
  ["sm-city-cebu", "SM City Cebu", "North Reclamation, Cebu City", 10.31138, 123.91689],
  ["ayala-center-cebu", "Ayala Center Cebu", "Cebu Business Park, Cebu City", 10.3181, 123.90516],
  ["fuente-osmena", "Fuente Osmeña Circle", "Cebu City", 10.30919, 123.89323],
  ["talamban", "Talamban (USC campus)", "Cebu City", 10.35594, 123.90715],
  ["banilad", "Banilad", "Cebu City", 10.33307, 123.91061],
  ["colon-street", "Colon Street", "Cebu City", 10.29444, 123.89389],
  ["carbon-market", "Carbon Market", "Cebu City", 10.29204, 123.89781],
  ["mandaue-centre", "Mandaue City centre", "Mandaue, Cebu", 10.32698, 123.93432],
  ["mactan-airport", "Mactan–Cebu International Airport", "Lapu-Lapu, Cebu", 10.31606, 123.97831],
  ["lapu-lapu-city-hall", "Lapu-Lapu City Hall", "Lapu-Lapu, Cebu", 10.31646, 123.96523],
  ["talisay-city-hall", "Talisay City Hall", "Talisay, Cebu", 10.25341, 123.82933],
  ["quiapo-church", "Quiapo Church", "Manila, Metro Manila", 14.59886, 120.9838],
  ["sm-megamall", "SM Megamall", "Mandaluyong, Metro Manila", 14.58473, 121.05688],
  ["bgc", "Bonifacio Global City", "Taguig, Metro Manila", 14.55081, 121.05097],
  ["makati-city-hall", "Makati City Hall", "Makati, Metro Manila", 14.57049, 121.02722],
  ["naia", "Ninoy Aquino International Airport", "Parañaque, Metro Manila", 14.51225, 121.02192],
  ["cubao", "Araneta City, Cubao", "Quezon City, Metro Manila", 14.62291, 121.05326],
  ["monumento", "Monumento", "Caloocan, Metro Manila", 14.65431, 120.98384],
  ["ust", "University of Santo Tomas", "Sampaloc, Manila", 14.60984, 120.98946],
  ["marikina-city-hall", "Marikina City Hall", "Marikina, Metro Manila", 14.63303, 121.09895],
  ["quezon-city-hall", "Quezon City Hall", "Quezon City, Metro Manila", 14.64638, 121.05001],
  ["baguio-city-hall", "Baguio City Hall", "Baguio, Benguet", 16.41374, 120.59152],
  ["sm-clark", "SM City Clark", "Angeles, Pampanga", 15.16884, 120.58017],
  ["iloilo-city-hall", "Iloilo City Hall", "Iloilo City", 10.69336, 122.57323],
  ["bacolod-city-hall", "Bacolod (old City Hall)", "Bacolod, Negros Occidental", 10.66761, 122.94497],
  ["tacloban-city-hall", "Tacloban City Hall", "Tacloban, Leyte", 11.24365, 125.00795],
  ["tagbilaran-city-hall", "Tagbilaran City Hall", "Tagbilaran, Bohol", 9.65388, 123.86605],
  ["dumaguete-city-hall", "Dumaguete City Hall", "Dumaguete, Negros Oriental", 9.30499, 123.30954],
  ["davao-city-hall", "Davao City Hall", "Davao City", 7.06466, 125.60796],
  ["cdo-city-hall", "Cagayan de Oro City Hall", "Cagayan de Oro, Misamis Oriental", 8.47695, 124.64117],
  ["zamboanga-city-hall", "Zamboanga City Hall", "Zamboanga City", 6.90391, 122.07648],
  ["gensan-city-hall", "General Santos City Hall", "General Santos, South Cotabato", 6.11307, 125.17173],
].map(([id, name, area, lat, lon]) => ({
  id: `built-in:${id}`,
  name: name as string,
  area: area as string,
  lat: lat as number,
  lon: lon as number,
  source: "built-in" as const,
}));

export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function words(s: string): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean);
}

/** Built-in places inside the bound whose name or area has a word starting with each word of the query. */
export function builtInMatches(query: string, bound: Bound, limit = MAX_BUILT_IN): Place[] {
  const wanted = words(query);
  if (wanted.length === 0) return [];
  return BUILT_IN_PLACES.filter((p) => {
    if (!inBound(bound, p)) return false;
    const have = words(`${p.name} ${p.area}`);
    return wanted.every((w) => have.some((h) => h.startsWith(w)));
  }).slice(0, limit);
}

/** Places in the bound a phone can offer before it has typed anything. */
export function builtInPlaces(bound: Bound): Place[] {
  return BUILT_IN_PLACES.filter((p) => inBound(bound, p));
}
