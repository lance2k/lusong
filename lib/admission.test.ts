import { describe, expect, it } from "vitest";
import { admit } from "./admission";
import { createBudget, MemoryBudgetStore, type Budget } from "./budget";
import type { Meter } from "./meta";

const NOON = new Date("2026-11-05T04:00:00Z");
const RESERVE = 100_000;
/** 2,000 tokens in and 3,000 out at $1.25 and $4.25 per 1M tokens. */
const SPARK_COST = 2_000 * 1.25 + 3_000 * 4.25;
const SPARK_USAGE = { input_tokens: 2_000, output_tokens: 3_000 };
const sparkReply = (usage: object | null) => ({ output: [{ type: "message" }], ...(usage ? { usage } : {}) });

function budgetOf(micros: number, ipLimit = 10): Budget {
  return createBudget({ store: new MemoryBudgetStore(), budgetUsd: micros / 1e6, ipLimit });
}

function admitted(result: Awaited<ReturnType<typeof admit>>) {
  if (!result.ok) throw new Error(`expected an admission, got ${result.reason}`);
  return result.run;
}

/** Runs one admitted job, then reports whether a second reservation of the same size still fits. */
async function roomForAnother(budgetMicros: number, spend: (meter: Meter) => void, succeeded = true): Promise<boolean> {
  const budget = budgetOf(budgetMicros);
  const run = admitted(await admit(budget, { clientIp: "192.0.2.1", reserveMicros: RESERVE, now: NOON }));
  spend(run.meter);
  await run.settle(succeeded);
  return (await admit(budget, { clientIp: "192.0.2.2", reserveMicros: RESERVE, now: NOON })).ok;
}

describe("a refused admission", () => {
  it("says the day's checks are used up when the daily cap is reached (503)", async () => {
    const refusal = await admit(budgetOf(RESERVE - 1), { clientIp: "192.0.2.1", reserveMicros: RESERVE, now: NOON });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.reason).toBe("budget");
    const res = refusal.response();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Today's free checks are used up. They start again at 8:00 a.m. Philippine time.",
      reason: "budget",
    });
  });

  it("says this address has used its checks when its limit is reached (429)", async () => {
    const budget = budgetOf(10 * RESERVE, 1);
    admitted(await admit(budget, { clientIp: "192.0.2.1", reserveMicros: RESERVE, now: NOON }));
    const refusal = await admit(budget, { clientIp: "192.0.2.1", reserveMicros: RESERVE, now: NOON });
    if (refusal.ok) throw new Error("expected a refusal");
    expect(refusal.reason).toBe("ip");
    const res = refusal.response();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "You've used today's checks. They start again at 8:00 a.m. Philippine time.",
      reason: "ip",
    });
  });

  it("says Lusong can't take checks when there is no ledger (503)", async () => {
    const budget = createBudget({ store: null, budgetUsd: 10, ipLimit: 10 });
    const refusal = await admit(budget, { clientIp: "192.0.2.1", reserveMicros: RESERVE, now: NOON });
    if (refusal.ok) throw new Error("expected a refusal");
    expect(refusal.reason).toBe("unavailable");
    const res = refusal.response();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Lusong can't take new checks right now.", reason: "unavailable" });
  });
});

describe("admission", () => {
  it("reserves the amount the caller names", async () => {
    const budget = budgetOf(1_000);
    admitted(await admit(budget, { clientIp: "192.0.2.1", reserveMicros: 600, now: NOON }));
    expect((await admit(budget, { clientIp: "192.0.2.2", reserveMicros: 400, now: NOON })).ok).toBe(true);
    const refusal = await admit(budget, { clientIp: "192.0.2.3", reserveMicros: 1, now: NOON });
    expect(refusal.ok ? null : refusal.reason).toBe("budget");
  });

  it("admits a run with no client address against the daily cap, with no per-address limit", async () => {
    const budget = budgetOf(3 * RESERVE, 1);
    const scheduled = { clientIp: null, reserveMicros: RESERVE, now: NOON };
    admitted(await admit(budget, scheduled));
    admitted(await admit(budget, scheduled));
    admitted(await admit(budget, scheduled));
    const refusal = await admit(budget, scheduled);
    if (refusal.ok) throw new Error("expected a refusal");
    expect(refusal.reason).toBe("budget");
    expect(refusal.response().status).toBe(503);
  });
});

describe("settling a Muse Spark Responses-API run", () => {
  it("refunds down to the tokens it used on success", async () => {
    const spend = (meter: Meter) => meter.reply("spark-responses", sparkReply(SPARK_USAGE));
    expect(await roomForAnother(RESERVE + SPARK_COST, spend)).toBe(true);
    expect(await roomForAnother(RESERVE + SPARK_COST - 1, spend)).toBe(false);
  });

  it("refunds nothing when a call was retried", async () => {
    const spend = (meter: Meter) => {
      meter.failedAttempt();
      meter.reply("spark-responses", sparkReply(SPARK_USAGE));
    };
    expect(await roomForAnother(RESERVE + SPARK_COST, spend)).toBe(false);
  });

  it("refunds nothing when its usage is partial", async () => {
    const spend = (meter: Meter) => meter.reply("spark-responses", sparkReply({ input_tokens: 2_000 }));
    expect(await roomForAnother(RESERVE + SPARK_COST, spend)).toBe(false);
  });

  it("refunds nothing when its usage is missing", async () => {
    const spend = (meter: Meter) => meter.reply("spark-responses", sparkReply(null));
    expect(await roomForAnother(RESERVE + SPARK_COST, spend)).toBe(false);
  });

  it("refunds nothing when the run failed", async () => {
    const spend = (meter: Meter) => meter.reply("spark-responses", sparkReply(SPARK_USAGE));
    expect(await roomForAnother(RESERVE + SPARK_COST, spend, false)).toBe(false);
  });

  it("charges SAM images and Spark tokens together when one run uses both", async () => {
    const spend = (meter: Meter) => {
      meter.reply("sam", { usage: { input_tokens: 0, output_tokens: 0, images_processed: 1 } });
      meter.reply("spark-responses", sparkReply(SPARK_USAGE));
    };
    expect(await roomForAnother(RESERVE + 2_500 + SPARK_COST, spend)).toBe(true);
    expect(await roomForAnother(RESERVE + 2_500 + SPARK_COST - 1, spend)).toBe(false);
  });

  it("refunds once when settled twice", async () => {
    const budget = budgetOf(2 * RESERVE + RESERVE - 1);
    const run = admitted(await admit(budget, { clientIp: "192.0.2.1", reserveMicros: RESERVE, now: NOON }));
    admitted(await admit(budget, { clientIp: "192.0.2.2", reserveMicros: RESERVE, now: NOON }));
    await run.settle(true);
    await run.settle(true);
    admitted(await admit(budget, { clientIp: "192.0.2.3", reserveMicros: RESERVE, now: NOON }));
    expect((await admit(budget, { clientIp: "192.0.2.4", reserveMicros: RESERVE, now: NOON })).ok).toBe(false);
  });
});
