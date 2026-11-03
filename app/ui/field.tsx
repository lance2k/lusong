import type { ReactNode } from "react";

/** The label, hint and error shell shared by the place boxes and the watcher's time boxes. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-label text-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-small text-ink-2">{hint}</p>}
      {error && <p className="text-small font-medium text-warn-ink">{error}</p>}
    </div>
  );
}

export const inputClass =
  "min-h-11 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-2";
