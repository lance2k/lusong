import { CREDITS_LINE, SAMPLES_LINE, TILES_LINE } from "./credits";
import type { LayerId, LayerToggles, LegendRow } from "./map-layers";

const SWATCHES: Record<LegendRow["id"], React.ReactNode> = {
  routes: (
    <span aria-hidden className="flex w-8 flex-col gap-1">
      <span className="block h-1.5 rounded bg-brand" />
      <span className="block border-t-4 border-dashed border-another" />
    </span>
  ),
  reports: (
    <span aria-hidden className="flex w-8 gap-1">
      <span className="block h-3 w-3 rounded-full bg-wait" />
      <span className="block h-3 w-3 rounded-full bg-go" />
      <span className="block h-3 w-3 rounded-full bg-stale" />
    </span>
  ),
  areas: <span aria-hidden className="block h-5 w-8 rounded border-2 border-advisory bg-advisory/20" />,
  closures: <span aria-hidden className="block h-5 w-8 rounded border-2 border-dashed border-line" />,
  rain: <span aria-hidden className="block h-5 w-8 rounded border-2 border-dashed border-line" />,
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
          const toggle = row.id === "routes" || row.id === "reports" || row.id === "areas";
          const on = toggle && row.available && layers[row.id as LayerId];
          const inputId = `layer-${row.id}`;
          return (
            <li key={row.id} className={`flex items-start gap-3 px-4 py-3 ${row.available ? "" : "opacity-70"}`}>
              <input
                id={inputId}
                type="checkbox"
                role="switch"
                className="mt-1 h-5 w-5 shrink-0 accent-[var(--brand)]"
                checked={on}
                disabled={!row.available}
                onChange={() => toggle && onToggle(row.id as LayerId)}
              />
              <span className="mt-0.5 shrink-0">{SWATCHES[row.id]}</span>
              <span className="min-w-0 space-y-0.5">
                <label htmlFor={inputId} className="block font-semibold">
                  {row.label}
                </label>
                {row.lines.map((line, i) => (
                  <span key={i} className="block text-small text-ink-2">
                    {line}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {samplesShown && <p className="text-small text-ink-2">{SAMPLES_LINE}</p>}
      <footer className="space-y-2 text-small text-ink-2">
        <p>{CREDITS_LINE}</p>
        <p>{TILES_LINE}</p>
      </footer>
    </div>
  );
}
