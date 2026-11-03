"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./map.css";
import { useEffect, useRef } from "react";
import type { Point } from "../lib/answer";
import {
  DEFAULT_LAYERS,
  ATTRIBUTION_CONTROL,
  MAP_OPTIONS,
  movesTheMap,
  pinSpec,
  routeStyles,
  TILE_ATTRIBUTION,
  TILE_URL,
  ZOOM_CONTROL,
  textBlock,
  type AreaShape,
  type FitPadding,
  type LayerToggles,
  type PinSpec,
} from "./map-layers";
import { PHILIPPINES_VIEW, pinPopup } from "./map-props";
import type { RainCircle } from "./rain-layer";

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
  /** The blurred copy of the report's photo, when one was published. */
  photoUrl?: string | null;
}

export interface TripMapProps {
  ends: { at: Point; label: string }[];
  route: Point[] | null;
  detour: Point[] | null;
  pins: MapPin[];
  /** The map fits these points whenever they change; null puts it back on the fixed view of the Philippines. */
  frame: Point[] | null;
  /** Given only while the commuter is tapping their own trip. */
  onTap?: (at: Point) => void;
}

export interface MapView {
  areas: AreaShape[];
  layers: LayerToggles;
  /** What covers the map's edges (the sheet, the top band), so a fit keeps the trip in the part left showing. */
  padding: FitPadding;
  /** The sheet's height over the map's bottom edge: the zoom buttons sit just above it. */
  bottomInset: number;
  /** A report to fly to and open; `n` changes on every request, so the same pin can be asked for twice. */
  focusPin: { id: string; n: number } | null;
  /** The sheet covers the bottom of the map, so the zoom buttons are hidden. */
  hideBottom: boolean;
  /** The rain circles to draw, under the routes and pins. Empty while the Rain row is off. */
  rain: RainCircle[];
  /** Called with the map's visible box after every move, including the first fit. */
  onView: (view: { south: number; west: number; north: number; east: number }) => void;
}

const RAIN_PANE = "lusong-rain";

const latLng = (p: Point): L.LatLngTuple => [p.lat, p.lon];

const GLYPH_SVG: Record<PinSpec["glyph"], string> = {
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  tick: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  unknown: '<path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
};

/** Text nodes and attributes, not HTML strings: a report's place name comes from a third-party lookup. */
function popupElement(pin: MapPin): HTMLElement {
  const { lines, photo } = pinPopup(pin);
  const box = document.createElement("div");
  if (photo) {
    const img = document.createElement("img");
    img.src = photo.src;
    img.alt = photo.alt;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.style.cssText = "display:block;width:100%;max-height:160px;object-fit:cover;border-radius:6px;margin-bottom:4px";
    box.append(img);
  }
  for (const text of lines) {
    const p = document.createElement("p");
    p.textContent = text;
    box.append(p);
  }
  return box;
}

function pinIcon(spec: PinSpec): L.DivIcon {
  const root = document.createElement("div");
  root.className = `lusong-pin tone-${spec.tone}${spec.sample ? " sample" : ""}`;
  const drop = document.createElement("span");
  drop.className = "drop";
  const glyph = document.createElement("span");
  glyph.className = "glyph";
  // A fixed constant, never report text.
  glyph.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH_SVG[spec.glyph]}</svg>`;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = spec.badge;
  root.append(drop, glyph, badge);
  return L.divIcon({ html: root, className: "lusong-pin-box", iconSize: [44, 48], iconAnchor: [22, 44], popupAnchor: [0, -40] });
}

function pinLayer(pin: MapPin): L.Marker {
  const spec = pinSpec(pin);
  const marker = L.marker(latLng(pin.at), { icon: pinIcon(spec), title: `${spec.badge}, ${pin.place}`, alt: pin.place, keyboard: true });
  // Leaflet's controls sit above its popups, so the popup is panned clear of the map's buttons.
  marker.bindPopup(popupElement(pin), { maxWidth: 240, autoPanPaddingTopLeft: [16, 96], autoPanPaddingBottomRight: [64, 24] });
  return marker;
}

function endLayer(end: TripMapProps["ends"][number]): L.Layer {
  return L.circleMarker(latLng(end.at), { radius: 8, weight: 3, fillOpacity: 1, className: "lusong-end" }).bindTooltip(end.label, {
    permanent: true,
    direction: "top",
    offset: [0, -8],
  });
}

export default function TripMap({
  ends,
  route,
  detour,
  pins,
  frame,
  onTap,
  areas = [],
  layers = DEFAULT_LAYERS,
  padding = { topLeft: [24, 24], bottomRight: [24, 24] },
  bottomInset = 0,
  focusPin = null,
  hideBottom = false,
  rain = [],
  onView,
}: TripMapProps & Partial<MapView>) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<Record<"routes" | "ends" | "reports" | "areas" | "rain", L.LayerGroup> | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const tap = useRef(onTap);
  const viewed = useRef(onView);
  const pad = useRef(padding);
  /** The points the current frame fits, kept so a resize or a new padding can fit them again. */
  const framed = useRef<Point[] | null>(null);
  /** The rider panned or zoomed since the last frame: a resize or a sheet move then leaves the view alone. */
  const userMoved = useRef(false);

  useEffect(() => {
    tap.current = onTap;
    viewed.current = onView;
    pad.current = padding;
  });

  /** Fits the framed points into the part of the map the sheet and the top band leave showing. */
  const fit = useRef(() => {
    const m = map.current;
    if (!m) return;
    m.invalidateSize();
    const points = framed.current;
    if (!points) {
      m.setView(latLng(PHILIPPINES_VIEW.centre), PHILIPPINES_VIEW.zoom);
      return;
    }
    const size = m.getSize();
    const { topLeft, bottomRight } = pad.current;
    // Padding that leaves no room would give Leaflet a negative area to fit into, and a non-finite view.
    const roomy = size.x - topLeft[0] - bottomRight[0] > 40 && size.y - topLeft[1] - bottomRight[1] > 40;
    m.fitBounds(L.latLngBounds(points.map(latLng)), {
      paddingTopLeft: roomy ? topLeft : [24, 24],
      paddingBottomRight: roomy ? bottomRight : [24, 24],
      // A single end would otherwise zoom to the street's last tile level.
      maxZoom: 15,
    });
  });

  useEffect(() => {
    const m = L.map(box.current!, MAP_OPTIONS).setView(latLng(PHILIPPINES_VIEW.centre), PHILIPPINES_VIEW.zoom);
    L.control.attribution(ATTRIBUTION_CONTROL).addTo(m);
    L.control.zoom(ZOOM_CONTROL).addTo(m);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION, className: "lusong-tiles" }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => tap.current?.({ lat: e.latlng.lat, lon: e.latlng.lng }));
    // Below Leaflet's overlay pane (400), where areas and routes are, and above the tiles (200).
    m.createPane(RAIN_PANE).style.zIndex = "350";
    m.on("moveend", () => {
      const b = m.getBounds();
      viewed.current?.({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
    });
    groups.current = { rain: L.layerGroup(), areas: L.layerGroup(), routes: L.layerGroup(), ends: L.layerGroup().addTo(m), reports: L.layerGroup() };
    map.current = m;
    const el = box.current!;
    const moved = () => {
      userMoved.current = true;
    };
    const keyed = (e: KeyboardEvent) => {
      if (movesTheMap(e)) moved();
    };
    const pinched = (e: TouchEvent) => {
      if (e.touches.length > 1) moved();
    };
    m.on("dragstart", moved);
    el.addEventListener("wheel", moved, { passive: true });
    el.addEventListener("dblclick", moved);
    el.addEventListener("keydown", keyed);
    el.addEventListener("touchstart", pinched, { passive: true });
    el.querySelector(".leaflet-control-zoom")?.addEventListener("pointerdown", moved);
    // A new size (a rotated phone, a resized window, the stylesheet arriving late) refits, unless the rider has moved the map.
    let pending = 0;
    const resized = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        if (userMoved.current) m.invalidateSize();
        else fit.current();
      });
    });
    resized.observe(el);
    return () => {
      cancelAnimationFrame(pending);
      resized.disconnect();
      el.removeEventListener("wheel", moved);
      el.removeEventListener("dblclick", moved);
      el.removeEventListener("keydown", keyed);
      el.removeEventListener("touchstart", pinched);
      m.remove();
      map.current = null;
      groups.current = null;
    };
  }, []);

  // Keyed by content, not identity: a redraw closes an open popup, so only a real change redraws.
  const drawKey = JSON.stringify({ ends, route, detour, pins, areas });
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    const { ends, route, detour, pins, areas }: Pick<TripMapProps, "ends" | "route" | "detour" | "pins"> & { areas: AreaShape[] } = JSON.parse(drawKey);
    for (const group of Object.values(g)) group.clearLayers();
    markers.current.clear();
    for (const area of areas) {
      L.polygon(area.ring, { className: area.className, weight: 1.5, interactive: true })
        .bindTooltip(textBlock(area.tooltip, document), { sticky: true, className: "lusong-area-tip" })
        .addTo(g.areas);
    }
    const styles = routeStyles(Boolean(detour));
    if (route) L.polyline(route.map(latLng), styles.route).addTo(g.routes);
    if (detour) L.polyline(detour.map(latLng), styles.detour).addTo(g.routes);
    for (const end of ends) endLayer(end).addTo(g.ends);
    for (const pin of pins) {
      const marker = pinLayer(pin).addTo(g.reports);
      markers.current.set(pin.id, marker);
    }
  }, [drawKey]);

  const rainKey = JSON.stringify(rain);
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.rain.clearLayers();
    for (const c of JSON.parse(rainKey) as RainCircle[]) {
      L.circle([c.lat, c.lon], { radius: c.radiusM, pane: RAIN_PANE, stroke: false, fillColor: c.fill, fillOpacity: c.fillOpacity, className: `lusong-rain lusong-rain-${c.band}` })
        .bindTooltip(c.label, { sticky: true })
        .addTo(g.rain);
    }
  }, [rainKey]);

  const layerKey = JSON.stringify(layers);
  useEffect(() => {
    const m = map.current;
    const g = groups.current;
    if (!m || !g) return;
    const on: LayerToggles = JSON.parse(layerKey);
    for (const id of ["rain", "areas", "routes", "reports"] as const) {
      if (on[id]) g[id].addTo(m);
      else g[id].remove();
    }
  }, [layerKey]);

  const frameKey = JSON.stringify(frame);
  useEffect(() => {
    framed.current = JSON.parse(frameKey);
    userMoved.current = false;
    fit.current();
  }, [frameKey]);

  // The sheet moved or the layout changed: the same frame is fitted to the room now showing.
  const padKey = JSON.stringify(padding);
  useEffect(() => {
    if (!userMoved.current) fit.current();
  }, [padKey]);

  useEffect(() => {
    if (!focusPin || !map.current) return;
    const marker = markers.current.get(focusPin.id);
    if (!marker) return;
    // The rider asked for this pin, so a later sheet move must not fit the map away from it.
    userMoved.current = true;
    map.current.flyTo(marker.getLatLng(), Math.max(map.current.getZoom(), 16), { duration: 0.6 });
    map.current.once("moveend", () => marker.openPopup());
  }, [focusPin]);

  return (
    // Leaflet adds its own classes to the inner div, so React must never rewrite that div's className.
    <div
      data-hide-bottom={hideBottom}
      className={`lusong-map fixed inset-0 ${onTap ? "[&_.leaflet-container]:cursor-crosshair" : ""}`}
      style={{ "--map-bottom": `${bottomInset}px` } as React.CSSProperties}
    >
      <div ref={box} role="region" aria-label="Map of the trip" className="isolate h-full w-full" />
    </div>
  );
}
