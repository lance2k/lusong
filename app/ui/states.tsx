import type { ReactNode } from "react";
import { Button } from "./button";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[15px] text-ink-2">{children}</p>;
}

/** An indeterminate bar: it says something is running, never how far along it is. */
export function LoadingBar({ label }: { label: string }) {
  return (
    <div role="progressbar" aria-label={label} className="h-1.5 w-full overflow-hidden rounded-chip bg-brand/15">
      <div className="progress-indeterminate h-full w-2/5 rounded-chip bg-brand" />
    </div>
  );
}

export function ErrorNote({ children, onRetry, retryLabel = "Try again" }: { children: ReactNode; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="space-y-3 rounded-card border border-unknown bg-unknown/15 px-5 py-4 font-semibold text-ink">
      <p>{children}</p>
      {onRetry && (
        <Button look="outline" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
