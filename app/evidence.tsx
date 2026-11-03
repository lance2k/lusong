import type { CommuteResult, PageAdvisory } from "./commute-result";
import { MusePick, WebFindings } from "./commute-muse";
import { ROUTE_CREDIT } from "./credits";
import { ReportEvidence } from "./report-evidence";
import { detourWords } from "../lib/commute-words";

function Advisory({ advisory }: { advisory: PageAdvisory }) {
  return (
    <section className="space-y-1 rounded-card border border-line bg-surface px-4 py-3 text-[15px]">
      <h3 className="text-label uppercase tracking-wide text-ink-2">PAGASA flood advisory for this trip</h3>
      {advisory.state === "active" ? (
        <>
          <p className="font-medium">{advisory.headline ?? "General Flood Advisory"}: active</p>
          {advisory.rainForecast && <p>Rain forecast: {advisory.rainForecast}.</p>}
          {advisory.rivers && <p>Rivers named in the advisory: {advisory.rivers}.</p>}
          <p className="text-ink-2">
            Sent {advisory.sent}. Expires {advisory.expires}.
          </p>
          {advisory.link && (
            <a className="break-all text-brand underline" href={advisory.link}>
              PAGASA&apos;s record
            </a>
          )}
        </>
      ) : (
        <p className={advisory.state === "unreadable" ? "font-medium text-warn-ink" : ""}>{advisory.note}</p>
      )}
    </section>
  );
}

const heading = "mb-2 text-label uppercase tracking-wide text-ink-2";

/** Everything behind the answer: Muse Spark's pick, PAGASA, the reports, the web, the routes. */
export function Evidence({
  result,
  onShowReport,
  onWatch,
  onReport,
}: {
  result: CommuteResult;
  onShowReport: (id: string) => void;
  /** Given for the rider's own trip only. */
  onWatch?: () => void;
  onReport: () => void;
}) {
  const { route, detour } = result;
  return (
    <div className="space-y-4">
      <h2 className="text-title">Evidence</h2>
      {result.muse && <MusePick pick={result.muse.pick} />}

      <Advisory advisory={result.advisory} />

      <section>
        <h3 className={heading}>Reports</h3>
        {result.reports.length === 0 ? (
          <p className="text-[15px] text-ink-2">No reports on this trip.</p>
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface text-[15px]">
            {result.reports.map((r) => (
              <ReportEvidence key={r.id} r={r} onShow={() => onShowReport(r.id)} />
            ))}
          </ul>
        )}
        <p className="mt-2 text-small text-ink-2">{result.mmdaCredit}</p>
        <button type="button" onClick={onReport} className="mt-2 min-h-11 text-[15px] font-semibold text-brand underline">
          Report a street
        </button>
      </section>

      {result.muse && <WebFindings web={result.muse.web} />}

      <section className="space-y-3 text-[15px]">
        <div>
          <h3 className={heading}>{detour ? "Your usual way" : "Route"}</h3>
          <p>
            {route.lengthKm.toFixed(2)} km, about {route.timeMin} min by motorbike
            {route.streets.length > 0 && <>, via {route.streets.join(", ")}</>}.
          </p>
        </div>
        {detour && (
          <div>
            <h3 className={heading}>The other way</h3>
            <p>
              {detour.lengthKm.toFixed(2)} km, about {detour.timeMin} min by motorbike
              {detour.streets.length > 0 && <>, via {detour.streets.join(", ")}</>}.
            </p>
            <p className="font-semibold">{detourWords(detour)}.</p>
            {detour.proposedBy === "muse_spark" && (
              <p className="text-small text-ink-2">Muse Spark suggested this way; Lusong&apos;s rules judged it on the reports along it.</p>
            )}
          </div>
        )}
        <p className="mt-1 text-small text-ink-2">{ROUTE_CREDIT}</p>
      </section>

      {onWatch && (
        <button type="button" onClick={onWatch} className="min-h-11 w-full rounded-control border border-line bg-surface px-4 text-[15px] font-semibold text-ink">
          Watch this trip
        </button>
      )}
    </div>
  );
}
