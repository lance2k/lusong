import type { AnswerKind } from "../../lib/answer";
import { IconAnother, IconGo, IconUnknown, IconWait } from "./icons";

export const ANSWER_TONES: Record<AnswerKind, string> = {
  go: "bg-go text-on-go",
  go_another_way: "bg-another text-on-another",
  wait: "bg-wait text-on-wait",
  no_one_knows: "bg-unknown text-on-unknown",
};

const ICONS: Record<AnswerKind, (p: { size?: number }) => React.ReactNode> = {
  go: IconGo,
  go_another_way: IconAnother,
  wait: IconWait,
  no_one_knows: IconUnknown,
};

/** The answer's icon and its fixed words, in display type. The words are the server's TITLES, never rewritten. */
export function AnswerBadge({ kind, title }: { kind: AnswerKind; title: string }) {
  const Icon = ICONS[kind];
  return (
    <p className="flex items-start gap-3 text-display">
      <span className="mt-1 shrink-0">
        <Icon size={32} />
      </span>
      <span>{title}</span>
    </p>
  );
}
