export interface PageMuse {
  pick: { shown: boolean; label: string; sentences: string[]; note: string | null };
  web: {
    line: string;
    /** Which provinces the route enters were searched; `note` says what wasn't, and why. */
    coverage: { searched: string[]; missed: string[]; note: string | null };
    findings: { place: string; url: string; site: string; sourceDate: string | null; description: string; counted: boolean; note: string }[];
  };
}

/** The evidence Muse Spark picked, below the rules' own reason, in sentences Lusong wrote. */
export function MusePick({ pick }: { pick: PageMuse["pick"] }) {
  if (!pick.shown && !pick.note) return null;
  return (
    <section className="space-y-1 rounded-card border border-advisory/40 bg-surface px-4 py-3 text-[15px]">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-advisory">{pick.label}</h3>
      {pick.shown ? (
        pick.sentences.map((sentence, i) => <p key={i}>{sentence}</p>)
      ) : (
        <p className="text-ink-2">{pick.note}</p>
      )}
      <p className="text-sm text-ink-2">Muse Spark chose which evidence to show. Lusong wrote these lines, and its rules picked the answer.</p>
    </section>
  );
}

export function WebFindings({ web }: { web: PageMuse["web"] }) {
  return (
    <section className="space-y-2 text-[15px]">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-2">Road closures on the web</h3>
      <p className="text-ink-2">{web.line}</p>
      {web.coverage.note && <p className="font-medium text-warn-ink">{web.coverage.note}</p>}
      {web.findings.length > 0 && (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {web.findings.map((f, i) => (
            <li key={i} className="space-y-1 px-4 py-3">
              <p className="font-medium">{f.place}</p>
              <p>{f.description}</p>
              <p className="text-ink-2">{f.note}</p>
              <a className="break-all text-sm text-brand underline" href={f.url} rel="noopener noreferrer nofollow" target="_blank">
                {f.site}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
