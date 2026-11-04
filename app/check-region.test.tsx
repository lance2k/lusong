import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHECK_REGION_ID, CheckRegion } from "./check-region";

describe("the check's region (#55)", () => {
  it("can take focus from a script but is not a tab stop, and wraps the progress and the answer", () => {
    const html = renderToStaticMarkup(
      <CheckRegion>
        <p>Checking</p>
      </CheckRegion>,
    );
    expect(html).toMatch(new RegExp(`^<div id="${CHECK_REGION_ID}" tabindex="-1"[^>]*><p>Checking</p></div>$`));
  });
});
