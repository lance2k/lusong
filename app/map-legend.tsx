import { CREDITS_LINE, RAIN_CREDIT_LINE, SAMPLES_LINE, TILES_LINE } from "./credits";
import type { LayerId, LayerToggles, LegendRow } from "./map-layers";
import { RAIN_BANDS } from "./rain-layer";

const ROUTE_SWATCH = <span aria-hidden className="block h-1.5 w-8 rounded bg-brand" />;
const BOTH_ROUTES_SWATCH = (
  <span aria-hidden className="flex w-8 flex-col gap-1">
    <span className="block h-1.5 rounded bg-brand/50" />
    <span className="block border-t-4 border-dashed border-another" />
  </span>
);

const SWATCHES: Record<LegendRow["id"], React.ReactNode> = {
  routes: ROUTE_SWATCH,
  reports: (
    <span aria-hidden className="flex w-8 gap-1">
      <span className="block h-3 w-3 rounded-full bg-wait" />
      <span className="block h-3 w-3 rounded-full bg-go" />
      <span className="block h-3 w-3 rounded-full bg-stale" />
    </span>
  ),
  areas: <span aria-hidden className="block h-5 w-8 rounded border-2 border-advisory bg-advisory/20" />,
  closures: <span aria-hidden className="block h-5 w-8 rounded border-2 border-dashed border-warn-ink" />,
  rain: (
    <span aria-hidden className="flex w-8 gap-0.5">
      {(["light", "moderate", "heavy"] as const).map((band) => (
        <span key={band} className="block h-4 w-2.5 rounded-full" style={{ background: RAIN_BANDS[band].fill, opacity: RAIN_BANDS[band].fillOpacity + 0.3 }} />
      ))}
    </span>
  ),
};

/** The map's layers: a switch, a swatch and its time for each, and the map's credits. */
export function MapLegend({
  rows,
  layers,
  onToggle,
  samplesShown,
}: {
  rows: LegendRow[];
  layers: LayerToggles;
  onToggle: (id: LayerId) => void;
  samplesShown: boolean;
}) {
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-line rounded-card border border-line bg-surface">
        {rows.map((row) => {
          const on = row.available && layers[row.id];
          const inputId = `layer-${row.id}`;
          return (
            <li key={row.id} className={row.available ? "" : "opacity-70"}>
              {/* The whole row is the switch's label, so the tap target is the row, not a 20 px box. */}
              <label htmlFor={inputId} className={`flex min-h-11 items-start gap-3 px-4 py-3 ${row.available ? "cursor-pointer" : ""}`}>
                <input
                  id={inputId}
                  type="checkbox"
                  role="switch"
                  aria-labelledby={`${inputId}-name`}
                  aria-describedby={row.lines.length > 0 ? `${inputId}-lines` : undefined}
                  className="mt-1 h-5 w-5 shrink-0 accent-[var(--brand)]"
                  checked={on}
                  disabled={!row.available}
                  onChange={() => onToggle(row.id)}
                />
                <span className="mt-0.5 shrink-0">{row.id === "routes" && row.label !== "Route" ? BOTH_ROUTES_SWATCH : SWATCHES[row.id]}</span>
                <span className="min-w-0 space-y-0.5">
                  <span id={`${inputId}-name`} className="block font-semibold">
                    {row.label}
                  </span>
                  <span id={`${inputId}-lines`} className="block space-y-0.5">
                    {row.lines.map((line, i) => (
                      <span key={i} className="block text-small text-ink-2">
                        {line}
                      </span>
                    ))}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {samplesShown && <p className="text-small text-ink-2">{SAMPLES_LINE}</p>}
      <footer className="space-y-2 text-small text-ink-2">
        <p>{CREDITS_LINE}</p>
        <p>{RAIN_CREDIT_LINE}</p>
        <p>{TILES_LINE}</p>
      </footer>
    </div>
  );
}
