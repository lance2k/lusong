import { detourWords } from "../lib/commute-words";
import type { CommuteResult } from "./commute-result";
import { ESTIMATE_LINE } from "./credits";
import { AnswerBadge, ANSWER_TONES } from "./ui/answer-badge";

/** The one answer: its fixed words in display type, the rules' reason, and the estimate line last. */
export function AnswerCard({ result }: { result: CommuteResult }) {
  const { answer, detour } = result;
  return (
    <section aria-label="Answer" className="overflow-hidden rounded-card border border-line bg-surface shadow-sm">
      <div className={`space-y-1 px-5 py-4 ${ANSWER_TONES[answer.kind]}`}>
        <AnswerBadge kind={answer.kind} title={answer.title} />
        {answer.kind === "go_another_way" && detour && (
          <p className="text-lg font-semibold">
            {detourWords(detour)}
            {detour.streets.length > 0 && <>, via {detour.streets[0]}</>}
          </p>
        )}
      </div>
      <div className="space-y-2 px-5 py-4 text-[15px] leading-relaxed">
        <p>{answer.reason}</p>
        {answer.thin && <p className="text-ink-2">{answer.thin}</p>}
        {result.rainingHere && <p className="text-ink-2">You tapped &ldquo;raining here&rdquo;.</p>}
        <p className="text-small text-ink-2">{ESTIMATE_LINE}</p>
      </div>
    </section>
  );
}
