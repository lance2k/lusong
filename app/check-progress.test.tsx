import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckProgress } from "./check-progress";

const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("while a check runs (S3P-2, S3P-3)", () => {
  it("the checking view renders an indeterminate progressbar and no completed-step marks", () => {
    const html = renderToStaticMarkup(<CheckProgress since={Date.now()} />);
    const bars = html.match(/<[^>]*role="progressbar"[^>]*>/g) ?? [];
    expect(bars).toHaveLength(1);
    expect(bars[0]).not.toMatch(/aria-valuenow|aria-valuemax|aria-valuetext/);
    expect(html).not.toMatch(/✓|✔|aria-checked|data-done|\bdone\b|%/i);
    expect(html).not.toMatch(/<li/);
  });

  it("says what Lusong reads, and the seconds so far", () => {
    const text = unescape(renderToStaticMarkup(<CheckProgress since={Date.now()} />).replace(/<[^>]+>/g, ""));
    expect(text).toContain(
      "Reading PAGASA's flood advisory, getting the motorbike route, gathering reports, checking the web for road closures and, if your way is blocked, looking for another…",
    );
    expect(text).toMatch(/0 s$/);
  });
});
