import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createBudget, costMicros, MemoryBudgetStore, type Budget, type MeteredUsage } from "../lib/budget";
import { makeCommuteHandler } from "../lib/commute-handler";
import { makeValhallaGate, MemorySlotStore } from "../lib/router";
import { MemoryKvStore } from "../lib/web-search";

/**
 * One paid demo commute check with Muse Spark: Banilad → IT Park, a flooded spot reported, dry. Real PAGASA, real
 * Valhalla (one slot, at most one request a second), real Meta, the web search included. Estimated at $0.18 × 1.5.
 * Runs only with LUSONG_LIVE=1. vitest hides passing output, so everything goes to LUSONG_LIVE_OUT as JSON.
 */
const OUT = process.env.LUSONG_LIVE_OUT ?? "live-commute-muse.json";

it.skipIf(process.env.LUSONG_LIVE !== "1")(
  "live: a demo commute check with Muse Spark's investigation",
  async () => {
    const realFetch = globalThis.fetch;
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith("https://api.meta.ai/")) return realFetch(url, init);
      const sent = JSON.parse(String(init?.body ?? "{}"));
      const startedAt = Date.now();
      try {
        const res = await realFetch(url, init);
        const body = await res.clone().json().catch(() => null);
        const output = Array.isArray(body?.output) ? body.output : [];
        calls.push({
          kind: (sent.tools ?? []).some((t: { type: string }) => t.type === "web_search") ? "search" : "turn",
          status: res.status,
          ms: Date.now() - startedAt,
          replyStatus: body?.status ?? null,
          incomplete: body?.incomplete_details ?? null,
          usage: body?.usage ?? null,
          items: output.map((i: { type?: string; action?: { type?: string } }) => (i.type === "web_search_call" ? `web_search_call:${i.action?.type}` : i.type)),
          functionCalls: output.filter((i: { type?: string }) => i.type === "function_call").map((i: { name: string; arguments: string }) => ({ name: i.name, arguments: i.arguments })),
          finalText: output
            .filter((i: { type?: string; phase?: string }) => i.type === "message" && i.phase !== "commentary")
            .flatMap((i: { content?: { text?: string }[] }) => (i.content ?? []).map((c) => c.text ?? ""))
            .join("\n")
            .slice(0, 2_000),
          sentTextFormat: sent.text ?? null,
          error: res.ok ? null : JSON.stringify(body).slice(0, 500),
        });
        return res;
      } catch (err) {
        calls.push({ status: 0, ms: Date.now() - startedAt, error: err instanceof Error ? err.name : String(err) });
        throw err;
      }
    });

    let settled: { usage: MeteredUsage; succeeded: boolean; chargedMicros: number } | null = null;
    const inner = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 10 });
    const reserved: number[] = [];
    const budget: Budget = {
      admit: (ip, at, micros) => (reserved.push(micros!), inner.admit(ip, at, micros)),
      settle: (a, usage, succeeded) => {
        settled = { usage, succeeded, chargedMicros: costMicros(usage) };
        return inner.settle(a, usage, succeeded);
      },
    };
    const slots = new MemorySlotStore();
    const searchStore = new MemoryKvStore();
    const searchBudget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 3, ipLimit: 1 });
    const handler = makeCommuteHandler({
      gate: () => makeValhallaGate(slots),
      budget: () => budget,
      muse: { enabled: true, searchStore: () => searchStore, searchBudget: () => searchBudget },
    });

    const started = Date.now();
    const res = await handler(
      new Request("http://localhost/api/commute", {
        method: "POST",
        body: JSON.stringify({ mode: "demo", trip: "banilad-itpark", scenario: "flooded", rainingHere: false }),
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
      }),
    );
    const body = await res.json().catch(() => null);
    const record = {
      at: new Date().toISOString(),
      ms: Date.now() - started,
      status: res.status,
      reservedMicros: reserved,
      settled,
      page: body && {
        answer: body.answer,
        detour: body.detour && { ...body.detour, line: `${body.detour.line.length} points` },
        muse: body.muse,
        advisory: body.advisory?.state,
        reports: body.reports?.map((r: { id: string; role: string; onRoute: boolean; onDetour: boolean }) => ({ id: r.id, role: r.role, onRoute: r.onRoute, onDetour: r.onDetour })),
        error: body.error ?? null,
      },
      calls,
    };
    writeFileSync(OUT, JSON.stringify(record, null, 1));
    vi.unstubAllGlobals();

    expect(res.status).toBe(200);
  },
  120_000,
);
