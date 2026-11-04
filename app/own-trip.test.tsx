import { describe, expect, it } from "vitest";
import { boxAfterPick } from "./own-trip";

const HOME = { lat: 16.4124, lon: 120.5932 };
const WORK = { lat: 16.4155, lon: 120.604 };

describe("where focus goes after a From or To pick (#50)", () => {
  it("a From pick with To still empty moves on to To", () => {
    expect(boxAfterPick("from", { step: "home" })).toBe("to");
  });

  it("stays put when To is already set, by a pick, a tap or a saved trip", () => {
    expect(boxAfterPick("from", { step: "home", work: WORK })).toBeNull();
    expect(boxAfterPick("from", { step: "set", trip: { home: HOME, work: WORK } })).toBeNull();
  });

  it("never pulls focus from where the rider went while a slow pick (Use my location) was pending", () => {
    expect(boxAfterPick("from", { step: "home" }, true)).toBeNull();
    expect(boxAfterPick("from", { step: "home" }, false)).toBe("to");
  });

  it("a To pick never moves focus", () => {
    expect(boxAfterPick("to", { step: "home" })).toBeNull();
    expect(boxAfterPick("to", { step: "work", home: HOME })).toBeNull();
  });
});
