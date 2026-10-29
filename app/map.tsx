"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./map.css";
import { useEffect, useRef } from "react";
import type { Point } from "../lib/answer";
import { METRO_CEBU_VIEW } from "./map-props";

export interface MapPin {
  id: string;
  at: Point;
  sample: boolean;
  place: string;
  age: string;
  depth: string | null;
  passability: string | null;
  counts: boolean;
  role: "clear" | "block" | "neutral";
}

export interface TripMapProps {
  ends: { at: Point; label: string }[];
  route: Point[] | null;
  detour: Point[] | null;
  pins: MapPin[];
  /** The map fits these points whenever they change; null puts it back on the fixed Metro Cebu view. */
  frame: Point[] | null;
  /** Given only while the commuter is tapping their own trip. */
  onTap?: (at: Point) => void;
}

const PIN_COLOURS: Record<MapPin["role"], string> = { block: "#dc2626", clear: "#059669", neutral: "#d97706" };
/** Older than 3 hours: drawn, but not counted. */
const STALE_COLOUR = "#71717a";

const PIN_LEGEND: [string, string][] = [
  [PIN_COLOURS.block, "Not passable"],
  [PIN_COLOURS.neutral, "Doesn't decide"],
  [PIN_COLOURS.clear, "Clear"],
  [STALE_COLOUR, "Over 3 h old"],
];

const ROUTE_STYLE: L.PolylineOptions = { color: "#0284c7", weight: 5, opacity: 0.85 };
const DETOUR_STYLE: L.PolylineOptions = { color: "#059669", weight: 5, opacity: 0.9, dashArray: "10 8" };

const latLng = (p: Point): L.LatLngTuple => [p.lat, p.lon];

/** Text nodes, not HTML strings: a report's place name comes from a third-party lookup. */
function lines(...texts: (string | null)[]): HTMLElement {
  const box = document.createElement("div");
  for (const text of texts) {
    if (!text) continue;
    const p = document.createElement("p");
    p.textContent = text;
    box.append(p);
  }
  return box;
}

function pinLayer(pin: MapPin): L.Layer {
  const colour = pin.counts ? PIN_COLOURS[pin.role] : STALE_COLOUR;
  const marker = L.circleMarker(latLng(pin.at), {
    radius: 10,
    color: "#ffffff",
    weight: 2,
    fillColor: colour,
    fillOpacity: 1,
    dashArray: pin.sample ? "3 3" : undefined,
  });
  marker.bindTooltip(`${pin.sample ? "Sample · " : ""}${pin.age}`, { permanent: true, direction: "right", offset: [10, 0] });
  marker.bindPopup(
    lines(
      pin.sample ? "Sample: a labelled test photo from elsewhere, pinned here for the demo." : null,
      pin.place,
      pin.age,
      pin.depth && `Water ${pin.depth}.`,
      pin.passability && `${pin.passability}.`,
      pin.counts ? null : "Older than 3 hours: shown, not counted.",
    ),
    // Leaflet's controls sit above its popups, so the popup is panned clear of the 44 px zoom buttons.
    { maxWidth: 240, autoPanPaddingTopLeft: [64, 12] },
  );
  return marker;
}

function endLayer(end: TripMapProps["ends"][number]): L.Layer {
  return L.circleMarker(latLng(end.at), { radius: 8, color: "#18181b", weight: 3, fillColor: "#ffffff", fillOpacity: 1 }).bindTooltip(
    end.label,
    { permanent: true, direction: "top", offset: [0, -8] },
  );
}

export default function TripMap({ ends, route, detour, pins, frame, onTap }: TripMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const drawn = useRef<L.LayerGroup | null>(null);
  const tap = useRef(onTap);

  useEffect(() => {
    tap.current = onTap;
  }, [onTap]);

  useEffect(() => {
    const m = L.map(box.current!, { scrollWheelZoom: false }).setView(latLng(METRO_CEBU_VIEW.centre), METRO_CEBU_VIEW.zoom);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => tap.current?.({ lat: e.latlng.lat, lon: e.latlng.lng }));
    drawn.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // Keyed by content, not identity: a redraw closes an open popup, so only a real change redraws.
  const drawKey = JSON.stringify({ ends, route, detour, pins });
  useEffect(() => {
    const group = drawn.current;
    if (!group) return;
    const { ends, route, detour, pins }: Omit<TripMapProps, "frame" | "onTap"> = JSON.parse(drawKey);
    group.clearLayers();
    if (route) L.polyline(route.map(latLng), ROUTE_STYLE).addTo(group);
    if (detour) L.polyline(detour.map(latLng), DETOUR_STYLE).addTo(group);
    for (const end of ends) endLayer(end).addTo(group);
    for (const pin of pins) pinLayer(pin).addTo(group);
  }, [drawKey]);

  const frameKey = JSON.stringify(frame);
  useEffect(() => {
    const points: Point[] | null = JSON.parse(frameKey);
    if (!map.current) return;
    if (!points) map.current.setView(latLng(METRO_CEBU_VIEW.centre), METRO_CEBU_VIEW.zoom);
    else map.current.fitBounds(L.latLngBounds(points.map(latLng)), { padding: [28, 28] });
  }, [frameKey]);

  return (
    <div className="space-y-2">
      {/* Leaflet adds its own classes to the inner div, so React must never rewrite that div's className. */}
      <div className={onTap ? "[&_.leaflet-container]:cursor-crosshair" : ""}>
        <div
          ref={box}
          role="region"
          aria-label="Map of the trip"
          className="isolate h-72 w-full overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800"
        />
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
        <li className="flex items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden className="inline-block h-1 w-6 rounded bg-sky-600" />
          {detour ? "Your usual way" : "Route"}
        </li>
        {detour && (
          <li className="flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden className="inline-block w-6 border-t-4 border-dashed border-emerald-600" />
            The other way
          </li>
        )}
        {pins.length > 0 &&
          PIN_LEGEND.map(([colour, words]) => (
            <li key={words} className="flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ background: colour }} />
              {words}
            </li>
          ))}
      </ul>
      <p className="text-sm text-zinc-500">Map tiles come from OpenStreetMap&apos;s servers, which see the area you look at.</p>
    </div>
  );
}
