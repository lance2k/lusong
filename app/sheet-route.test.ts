import { describe, expect, it } from "vitest";
import { backMove, PUSHED_KEY, viewFromSearch } from "./sheet-route";

describe("?sheet= views (S3P-5)", () => {
  it.each([
    ["?sheet=report", "report"],
    ["?sheet=check", "check"],
    ["?sheet=watch", "watch"],
    ["?sheet=about", "about"],
    ["?sheet=legend", "legend"],
    ["?sheet=nope", null],
    ["", null],
  ])("%s opens %s", (search, view) => {
    expect(viewFromSearch(search)).toBe(view);
  });

  it("Back goes through history only for an entry the page pushed; an address opened directly is replaced, so Back never leaves Lusong", () => {
    expect(backMove({ [PUSHED_KEY]: true, __NA: true })).toBe("history-back");
    expect(backMove({ __NA: true })).toBe("replace");
    expect(backMove(null)).toBe("replace");
  });
});
