"use client";

import { useEffect, useState } from "react";
import { CHECKING_LINE } from "./credits";
import { LoadingBar } from "./ui/states";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))}</>;
}

/**
 * While a check runs: a bar that says Lusong is working, never how far (the reply carries no steps), what it reads,
 * and the seconds so far by the real clock.
 */
export function CheckProgress({ since }: { since: number }) {
  return (
    <div className="space-y-3 rounded-card border border-line bg-surface px-5 py-4" data-testid="check-progress">
      <LoadingBar label="Checking your trip" />
      <p className="text-[15px] text-ink-2">
        {CHECKING_LINE} <span className="tabular-nums">
          <Elapsed since={since} />
        </span>{" "}
        s
      </p>
    </div>
  );
}
