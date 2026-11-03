import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advisoryAreasOf,
  ageMinutes,
  areaShapes,
  ATTRIBUTION_CONTROL,
  fitPadding,
  legendRows,
  MAP_OPTIONS,
  pinSpec,
  routeStyles,
  textBlock,
  type AdvisoryArea,
  type LegendReply,
} from "./map-layers";

const RING: [number, number][] = [
  [10.3, 123.85],
  [10.36, 123.85],
  [10.36, 123.95],
  [10.3, 123.95],
];
const HOLE: [number, number][] = [
  [10.32, 123.88],
  [10.34, 123.88],
  [10.34, 123.9],
];
const AREA: AdvisoryArea = {
  kind: "General Flood Advisory",
  rings: [RING, HOLE],
  sent: "2026-11-03T13:12:00+08:00",
  expires: "2026-11-03T19:12:00+08:00",
  headline: "General Flood Advisory for Cebu",
};

function reply(extra: Partial<LegendReply> = {}): LegendReply {
  return { detour: null, reports: [], advisory: { state: "active", note: null }, ...extra };
}

describe("PAGASA areas on the map", () => {
  it("a reply with polygons draws one shaded shape per area, rings kept as [lat, lon] with the hole, and a tooltip of headline and times", () => {
    const shapes = areaShapes(advisoryAreasOf(reply({ advisoryAreas: [AREA] })));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].rings).toEqual([RING, HOLE]);
    expect(shapes[0].className).toBe("lusong-area lusong-area-general-flood-advisory");
    expect(shapes[0].tooltip).toEqual([
      "General Flood Advisory for Cebu",
      "Sent 3 Nov, 1:12 p.m. PHT · expires 3 Nov, 7:12 p.m. PHT",
    ]);
  });

  it("times the server already wrote as text are shown as they are", () => {
    const [shape] = areaShapes([{ ...AREA, sent: "3 Nov, 1:12 p.m. PHT", expires: null }]);
    expect(shape.tooltip[1]).toBe("Sent 3 Nov, 1:12 p.m. PHT");
  });

  it.each([
    ["absent", reply()],
    ["empty", reply({ advisoryAreas: [] })],
    ["only rings too short to be shapes", reply({ advisoryAreas: [{ ...AREA, rings: [[[10.3, 123.85]]] }] })],
  ])("with the field %s, the layer is off and the legend says so", (_why, r) => {
    expect(advisoryAreasOf(r)).toEqual([]);
    const row = legendRows(r, null).find((x) => x.id === "areas")!;
    expect(row.available).toBe(false);
    expect(row.lines).toEqual(["No area in this reply"]);
  });

  it("before any answer the legend has no area either", () => {
    expect(legendRows(null, null).find((x) => x.id === "areas")!.lines).toEqual(["No area in this reply"]);
  });

  it("with areas, the legend row can be switched and names the times and PAGASA's licence", () => {
    const row = legendRows(reply({ advisoryAreas: [AREA] }), null).find((x) => x.id === "areas")!;
    expect(row.available).toBe(true);
    expect(row.lines).toContain("PAGASA, CC BY 4.0");
    expect(row.lines).toContain("Sent 3 Nov, 1:12 p.m. PHT · expires 3 Nov, 7:12 p.m. PHT");
  });

  it("an unreadable PAGASA reading carries its own note into the legend row", () => {
    const note = "Lusong couldn't read PAGASA's alert feed, so it counts an advisory as active.";
    const row = legendRows(reply({ advisory: { state: "unreadable", note } }), null).find((x) => x.id === "areas")!;
    expect(row.lines).toContain(note);
  });
});

describe("the legend's other rows", () => {
  it("road closures and rain now are shown but can't be switched on yet, and rain names no provider", () => {
    const rows = legendRows(reply(), null);
    for (const id of ["closures", "rain"] as const) {
      const row = rows.find((r) => r.id === id)!;
      expect(row.available).toBe(false);
      expect(row.lines).toEqual(["Coming soon"]);
    }
    expect(JSON.stringify(rows)).not.toMatch(/RainViewer/i);
  });

  it("reports give their newest and oldest age, from the reply's own words", () => {
    const row = legendRows(reply({ reports: [{ age: "2 h 5 min ago", sample: false }, { age: "40 min ago", sample: false }, { age: "just now", sample: true }] }), null).find(
      (r) => r.id === "reports",
    )!;
    expect(row.lines[0]).toBe("Newest just now · oldest 2 h 5 min ago");
    expect(row.lines).toContain("Older than 3 hours: shown, not counted.");
  });

  it("the route row says when the check ran, in PHT", () => {
    const row = legendRows(reply(), "2026-11-03T13:12:00Z").find((r) => r.id === "routes")!;
    expect(row.lines).toEqual(["Checked 3 Nov, 9:12 p.m. PHT"]);
  });

  it.each([
    ["just now", 0],
    ["40 min ago", 40],
    ["3 h ago", 180],
    ["2 h 5 min ago", 125],
    ["yesterday", null],
  ])("reads the age %s as %s minutes", (age, min) => {
    expect(ageMinutes(age)).toBe(min);
  });
});

describe("pins and routes", () => {
  const PIN = { id: "r1", at: { lat: 10.3, lon: 123.9 }, sample: false, place: "A street", age: "40 min ago", depth: null, passability: null, counts: true, role: "block" as const };

  it("a pin's glyph follows its role, and a pin over 3 h old turns grey but keeps its age", () => {
    expect(pinSpec(PIN)).toEqual({ glyph: "drop", tone: "wait", badge: "40 min ago", sample: false });
    expect(pinSpec({ ...PIN, role: "clear" }).glyph).toBe("tick");
    expect(pinSpec({ ...PIN, role: "neutral" }).glyph).toBe("unknown");
    expect(pinSpec({ ...PIN, counts: false, age: "4 h ago" })).toMatchObject({ tone: "stale", badge: "4 h ago" });
  });

  it("a sample pin says so on its badge", () => {
    expect(pinSpec({ ...PIN, sample: true })).toMatchObject({ sample: true, badge: "Sample · 40 min ago" });
  });

  it("with the other way shown, the usual way fades to half and the other way is dashed", () => {
    expect(routeStyles(false).route.opacity).toBeGreaterThan(0.5);
    expect(routeStyles(true).route.opacity).toBe(0.5);
    expect(routeStyles(true).detour.dashArray).toBeTruthy();
  });
});

describe("the map's credits (S3P-4)", () => {
  it("the map container sets attributionControl with position topright, which no sheet height covers", () => {
    expect(MAP_OPTIONS.attributionControl).toBe(false);
    expect(ATTRIBUTION_CONTROL.position).toBe("topright");
    // Leaflet needs a browser, so the map file itself is read: it must build the map from these options.
    const source = readFileSync(new URL("./map.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/L\.map\(box\.current!, MAP_OPTIONS\)/);
    expect(source).toMatch(/L\.control\.attribution\(ATTRIBUTION_CONTROL\)\.addTo\(m\)/);
    expect(source).not.toMatch(/attributionControl:\s*true/);
  });
});

describe("fitting the map (duck round 1, finding 1)", () => {
  it.each(["peek", "half", "full"] as const)("on a 390×844 phone at %s, the padding always leaves the map room to fit into", (detent) => {
    const sheetPx = { peek: 176, half: 422, full: 844 - 84 }[detent];
    const { topLeft, bottomRight } = fitPadding({ desktop: false, sheetPx, vh: 844 });
    expect(844 - topLeft[1] - bottomRight[1]).toBeGreaterThan(200);
    expect(390 - topLeft[0] - bottomRight[0]).toBeGreaterThan(200);
  });

  it("a short landscape phone with a full sheet still leaves room", () => {
    const { topLeft, bottomRight } = fitPadding({ desktop: false, sheetPx: 400 - 84, vh: 400 });
    expect(400 - topLeft[1] - bottomRight[1]).toBeGreaterThan(40);
  });
});

describe("area tooltips are text, never HTML (duck round 1, finding 2)", () => {
  interface FakeNode {
    tag: string;
    children: FakeNode[];
    textContent: string;
    innerHTMLSet: boolean;
    append: (...n: FakeNode[]) => void;
  }
  const fakeDoc = {
    createElement(tag: string) {
      const node: FakeNode = {
        tag,
        children: [],
        textContent: "",
        innerHTMLSet: false,
        append: (...n) => node.children.push(...n),
      };
      return new Proxy(node, {
        set(target, key, value) {
          if (key === "innerHTML" || key === "outerHTML") target.innerHTMLSet = true;
          (target as unknown as Record<string | symbol, unknown>)[key] = value;
          return true;
        },
      }) as unknown as HTMLElement;
    },
  };

  it("a headline with markup in it stays literal text", () => {
    const [shape] = areaShapes([{ ...AREA, headline: '<img src=x onerror="alert(1)">' }]);
    const box = textBlock(shape.tooltip, fakeDoc) as unknown as FakeNode;
    expect(box.innerHTMLSet).toBe(false);
    expect(box.children.map((c) => c.textContent)).toEqual(['<img src=x onerror="alert(1)">', shape.tooltip[1]]);
    expect(box.children.every((c) => !c.innerHTMLSet && c.tag === "p")).toBe(true);
  });

  it("the map hands Leaflet the text block, never a joined string", () => {
    const source = readFileSync(new URL("./map.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/bindTooltip\(textBlock\(area\.tooltip, document\)/);
    expect(source).not.toMatch(/area\.tooltip\.join/);
  });
});
