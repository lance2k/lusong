export interface PageMuse {
  pick: { shown: boolean; label: string; sentences: string[]; note: string | null };
  web: {
    line: string;
    findings: { place: string; url: string; site: string; sourceDate: string | null; description: string; counted: boolean; note: string }[];
  };
}

/** The evidence Muse Spark picked, below the rules' own reason, in sentences Lusong wrote. */
export function MusePick({ pick }: { pick: PageMuse["pick"] }) {
  if (!pick.shown && !pick.note) return null;
  return (
    <section className="space-y-1 rounded-2xl border border-violet-200 px-4 py-3 text-[15px] dark:border-violet-900">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">{pick.label}</h3>
      {pick.shown ? (
        pick.sentences.map((sentence, i) => <p key={i}>{sentence}</p>)
      ) : (
        <p className="text-zinc-600 dark:text-zinc-400">{pick.note}</p>
      )}
      <p className="text-sm text-zinc-500">Muse Spark chose which evidence to show. Lusong wrote these lines, and its rules picked the answer.</p>
    </section>
  );
}

export function WebFindings({ web }: { web: PageMuse["web"] }) {
  return (
    <section className="space-y-2 text-[15px]">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Road closures on the web</h3>
      <p className="text-zinc-600 dark:text-zinc-400">{web.line}</p>
      {web.findings.length > 0 && (
        <ul className="divide-y divide-zinc-200 rounded-2xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {web.findings.map((f, i) => (
            <li key={i} className="space-y-1 px-4 py-3">
              <p className="font-medium">{f.place}</p>
              <p>{f.description}</p>
              <p className="text-zinc-600 dark:text-zinc-400">{f.note}</p>
              <a className="break-all text-sm text-sky-700 underline dark:text-sky-400" href={f.url} rel="noopener noreferrer nofollow" target="_blank">
                {f.site}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
