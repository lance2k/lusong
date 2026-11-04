import type { CommuteResult, PageAdvisory, PageProduct } from "./commute-result";
import { MusePick, WebFindings } from "./commute-muse";
import { ADVISORY_INCOMPLETE_LINE, ROUTE_CREDIT } from "./credits";
import { ReportEvidence } from "./report-evidence";
import { detourWords } from "../lib/commute-words";
import { roadGapWords } from "../lib/detour";

function Product({ product }: { product: PageProduct }) {
  return (
    <li className="space-y-0.5">
      <p className="font-medium">
        {product.event} for {product.area}
        {product.counts ? "" : " (shown only)"}
      </p>
      {product.rainForecast && <p>Rain forecast: {product.rainForecast}.</p>}
      {product.rivers && <p>Rivers named: {product.rivers}.</p>}
      <p className="text-ink-2">
        Sent {product.sent}. Expires {product.expires}.
      </p>
      <a className="break-all text-brand underline" href={product.link}>
        PAGASA&apos;s record
      </a>
    </li>
  );
}

/** Every PAGASA product on the recommended way, an incomplete read flagged first, then those not placed on the map. */
export function Advisory({ advisory }: { advisory: PageAdvisory }) {
  return (
    <section className="space-y-1 rounded-card border border-line bg-surface px-4 py-3 text-[15px]">
      <h3 className="text-label uppercase tracking-wide text-ink-2">PAGASA advisories on {advisory.about}</h3>
      {advisory.incomplete && <p className="font-medium text-warn-ink">{ADVISORY_INCOMPLETE_LINE}</p>}
      {advisory.products.length > 0 && (
        <ul className="space-y-2">
          {advisory.products.map((p) => (
            <Product key={p.link} product={p} />
          ))}
        </ul>
      )}
      {advisory.note && !advisory.incomplete && <p>{advisory.note}</p>}
      {advisory.warnings.length > 0 && (
        <>
          <p className="text-ink-2">PAGASA advisories Lusong couldn&apos;t place on the map:</p>
          <ul className="space-y-2">
            {advisory.warnings.map((p) => (
              <Product key={`w-${p.link}`} product={p} />
            ))}
          </ul>
        </>
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

      {result.sweepWarnings && result.sweepWarnings.length > 0 && (
        <section className="space-y-2 text-[15px]">
          <h3 className={heading}>Posts near your way</h3>
          <p className="text-ink-2">Lusong found these online and hasn&apos;t confirmed them. They don&apos;t change the answer.</p>
          <ul className="space-y-2">
            {result.sweepWarnings.map((w) => (
              <li key={w.id}>
                {w.text}{" "}
                <a href={w.link} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand underline">
                  Source
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

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
          {roadGapWords(route.roadGap) && <p className="text-small text-ink-2">{roadGapWords(route.roadGap)}</p>}
        </div>
        {detour && (
          <div>
            <h3 className={heading}>The other way</h3>
            <p>
              {detour.lengthKm.toFixed(2)} km, about {detour.timeMin} min by motorbike
              {detour.streets.length > 0 && <>, via {detour.streets.join(", ")}</>}.
            </p>
            {roadGapWords(detour.roadGap) && <p className="text-small text-ink-2">{roadGapWords(detour.roadGap)}</p>}
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
