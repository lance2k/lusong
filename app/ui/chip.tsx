import type { ReactNode } from "react";

export function Chip({
  pressed,
  onClick,
  children,
  disabled,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-chip border border-line bg-surface px-4 text-[15px] font-medium text-ink transition-colors duration-(--dur-1) aria-pressed:border-brand aria-pressed:bg-brand aria-pressed:text-on-brand disabled:opacity-55"
    >
      {children}
    </button>
  );
}

/** A fieldset, so the group's name is read before its chips. */
export function ChipGroup({ legend, children, hideLegend }: { legend: string; children: ReactNode; hideLegend?: boolean }) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className={hideLegend ? "sr-only" : "text-label text-ink-2 uppercase tracking-wide"}>{legend}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}
