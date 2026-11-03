import { describe, expect, it } from "vitest";
import { boxReducer, initialBox, isOpen, searchFor, shownValue, type BoxEvent, type BoxState } from "./place-box";

const run = (events: BoxEvent[], from: BoxState = initialBox) => events.reduce(boxReducer, from);

describe("a From or To box", () => {
  it("typing after picking a suggestion, without leaving the box, searches again", () => {
    const picked = run([{ type: "focus" }, { type: "type", value: "ayala" }, { type: "picked" }]);
    expect(shownValue(picked, "Ayala Center Cebu")).toBe("");
    const again = boxReducer(picked, { type: "type", value: "colon" });
    expect(searchFor(again)).toBe("colon");
    expect(shownValue(again, "Ayala Center Cebu")).toBe("colon");
  });

  it("typing after Escape searches again", () => {
    const escaped = run([{ type: "focus" }, { type: "type", value: "ayala" }, { type: "escape" }]);
    expect(isOpen(escaped)).toBe(false);
    expect(searchFor(boxReducer(escaped, { type: "type", value: "talisay" }))).toBe("talisay");
  });

  it("typing after the box lost focus starts editing again", () => {
    const left = run([{ type: "focus" }, { type: "picked" }, { type: "blur" }]);
    expect(shownValue(left, "Cebu IT Park")).toBe("Cebu IT Park");
    expect(searchFor(boxReducer(left, { type: "type", value: "banilad" }))).toBe("banilad");
  });

  it("shows built-in matches at once and sends nothing under 3 characters", () => {
    const short = run([{ type: "focus" }, { type: "type", value: "it" }]);
    expect(searchFor(short)).toBeNull();
    const typed = boxReducer(short, { type: "type", value: "it park" });
    expect(typed.lookup.status).toBe("searching");
    expect(typed.lookup.places.map((p) => p.id)).toContain("built-in:cebu-it-park");
  });

  it("arrow keys wrap through the suggestions", () => {
    let s = run([{ type: "focus" }, { type: "type", value: "city hall" }]);
    const n = s.lookup.places.length;
    expect(n).toBeGreaterThan(1);
    s = boxReducer(s, { type: "move", by: -1 });
    expect(s.active).toBe(n - 1);
    s = boxReducer(s, { type: "move", by: 1 });
    expect(s.active).toBe(0);
  });

  it("results arriving after the box closed are ignored", () => {
    const left = run([{ type: "focus" }, { type: "type", value: "ayala" }, { type: "blur" }]);
    expect(boxReducer(left, { type: "results", lookup: { status: "ok", places: [] } })).toBe(left);
  });
});
