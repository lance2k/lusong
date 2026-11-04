import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckerBody, checkerAfterPick } from "./checker";
import { afterPick, REPORT_PICK_LINE, REPORT_SHARE_LINE, ReportPanel, type ReportState } from "./report";
import { escapeClosesView } from "./ui/sheet";
import { WatcherPanel, windowLine } from "./watcher-panel";

const noop = () => {};
/** As React writes text into markup. */
const html$ = (text: string) => text.replace(/'/g, "&#x27;");
const PICKED = { photo: new Blob(["jpeg"], { type: "image/jpeg" }), url: "blob:picked-1" };
const NEWER = { photo: new Blob(["jpeg2"], { type: "image/jpeg" }), url: "blob:picked-2" };

function buttons(html: string): { label: string; disabled: boolean }[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    label: m[2].replace(/<[^>]+>/g, ""),
    disabled: /disabled=""/.test(m[1]),
  }));
}

describe("#48 the report shows the photo and asks before sending", () => {
  it("a pick only shows the photo: it never starts finding the location or reading the water", () => {
    const from: ReportState[] = [
      { step: "idle" },
      { step: "opening" },
      { step: "previewing", picked: NEWER },
      { step: "failed", message: "x" },
    ];
    for (const state of from) expect(afterPick(state, PICKED)).toEqual({ step: "previewing", picked: PICKED });
  });

  it("a pick while a report is being sent changes nothing", () => {
    const locating: ReportState = { step: "locating", picked: NEWER };
    const reading: ReportState = { step: "reading", picked: NEWER, startedAt: 1 };
    expect(afterPick(locating, PICKED)).toBe(locating);
    expect(afterPick(reading, PICKED)).toBe(reading);
  });

  it("the preview shows the photo, Send report, Retake and the 3-hour sharing line", () => {
    const html = renderToStaticMarkup(<ReportPanel state={{ step: "previewing", picked: PICKED }} onTake={noop} onSend={noop} />);
    expect(html).toMatch(/<img[^>]*src="blob:picked-1"/);
    expect(buttons(html)).toEqual([
      { label: "Send report", disabled: false },
      { label: "Retake", disabled: false },
    ]);
    expect(html).toContain(html$(REPORT_SHARE_LINE));
    expect(REPORT_SHARE_LINE).toContain("3 hours");
  });

  it("before a pick there is no Send report, and the page no longer says the pick sends", () => {
    const html = renderToStaticMarkup(<ReportPanel state={{ step: "idle" }} onTake={noop} onSend={noop} />);
    expect(buttons(html)).toEqual([{ label: "Report this street", disabled: false }]);
    expect(html).toContain(html$(REPORT_PICK_LINE));
    expect(html).not.toMatch(/sends it at once/);
  });

  it("while a picked photo opens, the pick button stays enabled, so focus back from the picker is kept", () => {
    const html = renderToStaticMarkup(<ReportPanel state={{ step: "opening" }} onTake={noop} onSend={noop} />);
    expect(buttons(html)).toEqual([{ label: "Opening the photo…", disabled: false }]);
  });

  it("while sending, the photo stays shown and neither button can be tapped", () => {
    const html = renderToStaticMarkup(<ReportPanel state={{ step: "locating", picked: PICKED }} onTake={noop} onSend={noop} />);
    expect(html).toMatch(/<img[^>]*src="blob:picked-1"/);
    expect(buttons(html).every((b) => b.disabled)).toBe(true);
    expect(html).not.toContain(html$(REPORT_SHARE_LINE));
  });
});

describe("#48 the photo checker shows the photo and asks before checking", () => {
  it("a shrunk pick only previews; one landing during a paid check is dropped", () => {
    const blob = new Blob(["jpeg"]);
    expect(checkerAfterPick({ step: "preparing" }, "blob:c1", blob)).toEqual({ step: "previewing", previewUrl: "blob:c1", blob });
    const measuring = { step: "measuring", previewUrl: "blob:c0", startedAt: 1 } as const;
    expect(checkerAfterPick(measuring, "blob:c1", blob)).toBe(measuring);
  });

  it("the preview shows the photo with Check this photo and Retake", () => {
    const html = renderToStaticMarkup(
      <CheckerBody state={{ step: "previewing", previewUrl: "blob:c1", blob: new Blob([]) }} onTake={noop} onCheck={noop} onShow={noop} />,
    );
    expect(html).toMatch(/<img[^>]*src="blob:c1"/);
    expect(buttons(html)).toEqual([
      { label: "Check this photo", disabled: false },
      { label: "Retake", disabled: false },
    ]);
  });

  it("before a pick there is only the pick button", () => {
    const html = renderToStaticMarkup(<CheckerBody state={{ step: "idle" }} onTake={noop} onCheck={noop} onShow={noop} />);
    expect(buttons(html)).toEqual([{ label: "Choose or take a photo", disabled: false }]);
  });
});

describe("#51 Escape closes a sheet view as Back does", () => {
  const el = (tagName: string, extra: { type?: string; inOpenList?: boolean } = {}) => ({
    tagName,
    type: extra.type,
    closest: (selector: string) => (extra.inOpenList && selector.includes("aria-expanded") ? {} : null),
  });
  const key = (k: string, target: unknown, more: Partial<{ defaultPrevented: boolean; isComposing: boolean }> = {}) => ({
    key: k,
    target,
    defaultPrevented: false,
    isComposing: false,
    ...more,
  });

  it("closes on Escape from a heading, a button or a text box", () => {
    expect(escapeClosesView(key("Escape", el("H2")))).toBe(true);
    expect(escapeClosesView(key("Escape", el("BUTTON")))).toBe(true);
    expect(escapeClosesView(key("Escape", el("INPUT", { type: "text" })))).toBe(true);
  });

  it("ignores other keys, a handled Escape and one ending an IME composition", () => {
    expect(escapeClosesView(key("Enter", el("H2")))).toBe(false);
    expect(escapeClosesView(key("Escape", el("H2"), { defaultPrevented: true }))).toBe(false);
    expect(escapeClosesView(key("Escape", el("INPUT", { type: "text" }), { isComposing: true }))).toBe(false);
  });

  it("does not fire while a place list is open", () => {
    expect(escapeClosesView(key("Escape", el("INPUT", { type: "text", inOpenList: true })))).toBe(false);
  });

  it.each(["time", "date", "file"])("does not fire from a %s box, whose native picker may be open", (type) => {
    expect(escapeClosesView(key("Escape", el("INPUT", { type })))).toBe(false);
  });

  it("does not fire from a select, whose native list may be open", () => {
    expect(escapeClosesView(key("Escape", el("SELECT")))).toBe(false);
  });
});

describe("#52 the watcher's window is also said in 24-hour time", () => {
  const trip = { home: { lat: 10.3561, lon: 123.9131 }, work: { lat: 10.3301, lon: 123.9061 } };

  it("says the boxes' window in the trip line's 24-hour format, tied to both boxes", () => {
    const html = renderToStaticMarkup(<WatcherPanel trip={trip} leaveAt="07:30" />);
    const line = windowLine({ start: "06:30", end: "07:30" });
    expect(line).toBe("Window: 06:30 to 07:30 PHT, on the 24-hour clock.");
    expect(html).toContain(`id="watch-window-24h"`);
    expect(html).toContain(line);
    const boxes = [...html.matchAll(/<input[^>]*type="time"[^>]*>/g)].map((m) => m[0]);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toContain('aria-describedby="watch-window-24h"');
  });

  it("says nothing while a box is empty or half typed", () => {
    expect(windowLine({ start: "", end: "07:30" })).toBeNull();
    expect(windowLine({ start: "06:30", end: "7:3" })).toBeNull();
  });
});
