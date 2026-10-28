import Checker from "./checker";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 space-y-6 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Lusong</h1>
        <p className="text-lg leading-snug text-zinc-700 dark:text-zinc-300">
          How deep is the flood, and is it too deep for cars? Send a photo of the street. Lusong reads the water
          against the people and cars in it and answers on the MMDA flood gauge.
        </p>
      </header>

      <Checker />

      <footer className="space-y-2 border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800">
        <p>
          An estimate from your photo, not a guarantee. If in doubt, don&apos;t drive or wade through floodwater.
        </p>
        <p>
          Lusong does not keep your photo. It is sent to Meta&apos;s Model API (SAM 3.1 and Muse Spark) to be
          measured, under Meta&apos;s terms.
        </p>
      </footer>
    </main>
  );
}
