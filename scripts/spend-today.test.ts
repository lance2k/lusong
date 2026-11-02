import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// Port 1 refuses the connection, so the script prints its day lines and then fails before reading anything.
function header(now: string) {
  const run = spawnSync(process.execPath, ["scripts/spend-today.mts"], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, SPEND_TODAY_NOW: now, KV_REST_API_URL: "http://127.0.0.1:1/secret-path", KV_REST_API_READ_ONLY_TOKEN: "t0ken-value" },
    encoding: "utf8",
  });
  return { stdout: run.stdout, stderr: run.stderr, status: run.status };
}

it.each([
  ["2026-11-01T16:00:00Z", "2026-11-02", "2026-11-01", "2026-11-02"], // 00:00 PHT
  ["2026-11-01T23:59:00Z", "2026-11-02", "2026-11-01", "2026-11-02"], // 07:59 PHT
  ["2026-11-02T00:00:00Z", "2026-11-02", "2026-11-01", "2026-11-02"], // 08:00 PHT
  ["2026-11-02T15:59:00Z", "2026-11-02", "2026-11-01", "2026-11-02"], // 23:59 PHT
  ["2026-11-02T16:00:00Z", "2026-11-03", "2026-11-02", "2026-11-03"], // 00:00 PHT the next day
  ["2026-12-31T16:30:00Z", "2027-01-01", "2026-12-31", "2027-01-01"],
])("at %s the PHT day is %s and its budget days are %s and %s", (now, phtDate, first, second) => {
  const { stdout } = header(now);
  expect(stdout).toContain(`PHT day ${phtDate} touches budget days ${first} and ${second} (UTC)`);
});

it("names neither the URL nor the token when Upstash cannot be reached", () => {
  const { stdout, stderr, status } = header("2026-11-02T03:00:00Z");
  expect(status).toBe(1);
  expect(stderr).toContain("spend-today: Upstash unreachable on SCAN");
  for (const leak of ["127.0.0.1:1", "secret-path", "t0ken-value"]) expect(stdout + stderr).not.toContain(leak);
});
