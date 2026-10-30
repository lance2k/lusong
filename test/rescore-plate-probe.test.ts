import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runPlateProbe, type ProbeLabels } from "./plate-recall";

const labels = JSON.parse(readFileSync("test/fixtures/sam/plates-labels.json", "utf8")) as ProbeLabels;

interface RecordedProbe {
  recordedAt: string;
  prompts: string[];
  photos: { file: string; calls: { prompt: string; ok: boolean; rawText?: string }[] }[];
  result: unknown;
}

/**
 * Scores recorded plate-probe runs again, offline and free, under the strict reply check: no SAM call is made. The
 * recorded runs kept each reply's text but not Meta's status for it, so every recorded reply is taken as completed
 * (the call returned HTTP 200 with a JSON body); the text checks are the ones applied for real. Runs only with
 * LUSONG_RESCORE_IN=<file,file…> and LUSONG_RESCORE_OUT=<path>.
 */
it.skipIf(!process.env.LUSONG_RESCORE_IN || !process.env.LUSONG_RESCORE_OUT)("re-scores recorded plate probes under the strict check", async () => {
  const draws = [];
  for (const path of process.env.LUSONG_RESCORE_IN!.split(",")) {
    const recorded = JSON.parse(readFileSync(path, "utf8")) as RecordedProbe;
    const replay = await runPlateProbe(labels, recorded.prompts, async (file, prompt) => {
      const call = recorded.photos.find((p) => p.file === file)?.calls.find((c) => c.prompt === prompt);
      if (!call?.ok || call.rawText === undefined) throw new Error("no recorded reply");
      return { text: call.rawText, status: "completed" };
    });
    const { result } = replay;
    draws.push({
      source: path,
      recordedAt: recorded.recordedAt,
      upstreamStatus: "not recorded; taken as completed",
      platesFoundOn: `${result.both.photosWithEverySurePlateFound} of ${result.platePhotos} plate photos (every sure plate, both prompts together)`,
      malformed: replay.photos.flatMap((p) => p.calls.filter((c) => c.malformed).map((c) => ({ file: p.file, prompt: c.prompt, error: c.error }))),
      strict: result,
      recorded: recorded.result,
    });
  }
  writeFileSync(process.env.LUSONG_RESCORE_OUT!, JSON.stringify({ rescoredAt: new Date().toISOString(), draws }, null, 1));
  expect(draws.length).toBeGreaterThan(0);
});
