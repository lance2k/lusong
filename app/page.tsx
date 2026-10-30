import Checker from "./checker";
import CommuteCheck from "./commute";
import ReportStreet from "./report";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 space-y-8 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Lusong</h1>
        <p className="text-lg leading-snug text-zinc-700 dark:text-zinc-300">
          Should you ride to work now, and which way? Lusong reads PAGASA&apos;s flood advisory for Cebu and the
          reports along your motorbike route, and gives one answer: Go, Wait, or No one knows.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Commute check</h2>
        <CommuteCheck />
      </section>

      <section className="space-y-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        <h2 className="text-xl font-semibold">Report a street</h2>
        <p className="text-[15px] leading-snug text-zinc-700 dark:text-zinc-300">
          On a flooded or a dry street right now? Send a photo with your location. Lusong reads the water, and once the
          report is saved it counts for 3 hours in other riders&apos; commute checks. It keeps the place, the time and its reading,
          not your photo.
        </p>
        <ReportStreet />
      </section>

      <section className="space-y-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        <h2 className="text-xl font-semibold">Check one photo</h2>
        <p className="text-[15px] leading-snug text-zinc-700 dark:text-zinc-300">
          How deep is the flood, and is it too deep for cars? Send a photo of the street. Lusong reads the water
          against the people and cars in it and answers on the MMDA flood gauge.
        </p>
        <Checker />
      </section>

      <footer className="space-y-2 border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800">
        <p>
          An estimate, not a guarantee. If in doubt, don&apos;t drive or wade through floodwater.
        </p>
        <p>
          Lusong does not keep your photo. It is sent to Meta&apos;s Model API (SAM 3.1 and Muse Spark) to be
          measured, under Meta&apos;s terms.
        </p>
        <p>
          Flood advisories from PAGASA&apos;s public alert feed (CC BY 4.0). Routes from Valhalla, run by FOSSGIS, on
          OpenStreetMap data © OpenStreetMap contributors.
        </p>
      </footer>
    </main>
  );
}
