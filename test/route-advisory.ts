import type { ProductView, RouteAdvisory } from "../lib/advisory-snapshot";

/** A covering product as judgeRoute shows it; the fields default to Central Visayas's GFA of 2026-10-25 for Cebu. */
export function productView(overrides: Partial<ProductView> = {}): ProductView {
  return {
    id: "f1232c02-5d52-4786-90aa-46865ab991a4",
    kind: "flood",
    counts: true,
    event: "General Flood Advisory (Moderate)",
    headline: "General Flood Advisory",
    areas: ["Cebu"],
    sent: "2026-10-25T17:27:04+08:00",
    expires: "2026-10-26T05:27:04+08:00",
    link: "https://publicalert.pagasa.dost.gov.ph/output/gfa/f1232c02-5d52-4786-90aa-46865ab991a4.cap",
    rainForecast: "light to moderate rains and thunderstorms",
    rivers: "Cebu: Kotkot, Mananga, Guinabasan, Balamban and Sabangdaku",
    ...overrides,
  };
}

export const NO_ROUTE_ADVISORY: RouteAdvisory = { state: "none", covering: [], warnings: [], incomplete: null, readAt: null };
export const UNREADABLE_ROUTE_ADVISORY: RouteAdvisory = { state: "unreadable", covering: [], warnings: [], incomplete: "no snapshot of PAGASA's feed", readAt: null };
export const activeRouteAdvisory = (...covering: ProductView[]): RouteAdvisory => ({
  state: "active",
  covering: covering.length > 0 ? covering : [productView()],
  warnings: [],
  incomplete: null,
  readAt: null,
});
