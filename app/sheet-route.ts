/** The views that replace the commute content in the one sheet, each with its own `?sheet=` address. */
export const SHEET_VIEWS = ["report", "check", "watch", "about", "legend"] as const;
export type SheetView = (typeof SHEET_VIEWS)[number];

export function viewFromSearch(search: string): SheetView | null {
  const value = new URLSearchParams(search).get("sheet");
  return (SHEET_VIEWS as readonly string[]).includes(value ?? "") ? (value as SheetView) : null;
}

/** Marks a history entry this page pushed, so Back can tell it from a `?sheet=` address opened directly. */
export const PUSHED_KEY = "lusongSheet";

/**
 * How Back leaves a view: through the browser's history when this page pushed the entry, or, for an address opened
 * directly (nothing of ours behind it), by replacing it with the plain page so Back never leaves Lusong.
 */
export function backMove(historyState: unknown): "history-back" | "replace" {
  return typeof historyState === "object" && historyState !== null && (historyState as Record<string, unknown>)[PUSHED_KEY] === true
    ? "history-back"
    : "replace";
}
