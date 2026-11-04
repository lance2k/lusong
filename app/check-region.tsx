import type { ReactNode, Ref } from "react";

export const CHECK_REGION_ID = "check-region";

/**
 * The check's progress and its answer. A check collapses the trip panel, which unmounts the button that started it,
 * so focus moves here instead of falling to the page body (#55). Not a tab stop: only a script focuses it.
 */
export function CheckRegion({ ref, children }: { ref?: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div id={CHECK_REGION_ID} tabIndex={-1} ref={ref} className="space-y-5 outline-none">
      {children}
    </div>
  );
}
