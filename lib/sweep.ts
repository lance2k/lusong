import { randomUUID } from "node:crypto";
import type { AlertStore } from "./alerts";
import { ATTEMPTS_PER_CALL, WEB_SEARCH_QUERY_MICROS, budgetStoreFromEnv, type MeteredUsage, type SweepLedger } from "./budget";
import { Meter, MetaApiError, sparkResponse } from "./meta";
import { readReply } from "./spark-responses";
import { admitCandidate, robotsChecker, type AdmitDeps, type Candidate } from "./sweep-admit";

/**
 * The Muse Wonder sweep (plan S4b, dispositions S4P-3 and S4P-8): at most 4 a UTC day, at least 3 hours apart, each one
 * Wonder call with web search capped provider-side at 4 tool calls. Its reply is a list of pages to check and nothing
 * more; admission (lib/sweep-admit.ts) fetches each one and keeps only what the page itself supports. Discovery
 * persists its candidates, so admission works through them across invocations of POST /api/alerts/sweep.
 */

export const SWEEP_MODEL = "muse-wonder-1.0";
/**
 * Meta's pricing page gives muse-wonder-1.0 "Input $4.00" and "Output $20.00" per 1M tokens (dev.meta.ai/docs/
 * pricing-rate-limits). UNVERIFIED: quotecheck of those two quotes is the main session's (plan S4b, "Price").
 */
export const WONDER_INPUT_MICROS_PER_TOKEN = 4;
export const WONDER_OUTPUT_MICROS_PER_TOKEN = 20;
/** Enforced provider-side: the S4P-3 probe (2026-11-03 ~13:40 UTC, 2 of 2 draws) got at most the cap in web_search_calls. */
export const SWEEP_MAX_TOOL_CALLS = 4;
export const SWEEP_MAX_OUTPUT_TOKENS = 3_000;
/** About 3 × the probe's 4,037 input tokens at 2 tool calls, scaled to 4 (plan S4b, S4P-3 probe result). */
export const SWEEP_INPUT_TOKEN_BOUND = 20_000;
/** 2 attempts × (4 searches + the input bound + the output cap) at Wonder's rates: $0.30. */
export const SWEEP_RESERVE_MICROS =
  ATTEMPTS_PER_CALL *
  (SWEEP_MAX_TOOL_CALLS * WEB_SEARCH_QUERY_MICROS + SWEEP_INPUT_TOKEN_BOUND * WONDER_INPUT_MICROS_PER_TOKEN + SWEEP_MAX_OUTPUT_TOKENS * WONDER_OUTPUT_MICROS_PER_TOKEN);
/** Riders keep at least this much of the day's budget, whatever the sweeps do. */
export const RIDER_FLOOR_MICROS = 7_000_000;
export const SWEEP_DAILY_CAP_MICROS = 1_500_000;
export const SWEEPS_PER_DAY = 4;
export const SWEEP_GAP_MS = 3 * 3_600_000;
export const MAX_CANDIDATES = 12;
/** Candidates wait this long for admission, then are dropped. */
export const CANDIDATES_TTL_MS = 6 * 3_600_000;

export interface SweepLimits {
  /** The whole invocation, under the route's maxDuration (60 s). */
  budgetMs: number;
  /** The Wonder call's attempt timeout. */
  wonderAttemptMs: number;
  /** Pages fetched at a time. */
  concurrency: number;
  /** No page is started with less than this left: robots.txt and the page (8 s each at most) and a geocode (7 s). */
  minAdmitMs: number;
}

/** Wonder's call can take the whole budget; admission then waits for the next invocation, its candidates kept. */
export const SWEEP_LIMITS: SweepLimits = { budgetMs: 45_000, wonderAttemptMs: 40_000, concurrency: 4, minAdmitMs: 23_000 };

/** What Wonder bills: tokens at Wonder's rates and every web_search_call item as a query. */
export function wonderCostMicros(usage: MeteredUsage): number {
  return Math.ceil(usage.museInputTokens * WONDER_INPUT_MICROS_PER_TOKEN + usage.museOutputTokens * WONDER_OUTPUT_MICROS_PER_TOKEN + usage.webSearchQueries * WEB_SEARCH_QUERY_MICROS);
}

export interface StoredCandidate extends Candidate {
  /** Set once admission has decided it. */
  done?: string;
}

export interface SweepStore {
  /**
   * Atomic: claims the next of the UTC day's SWEEPS_PER_DAY slots (`lusong:sweep:slot:<day>:<n>`, SET NX) if the last
   * sweep was at least `gapMs` ago. The slot number, or null.
   */
  claimSlot(day: string, nowMs: number, gapMs: number, max: number): Promise<number | null>;
  saveCandidates(run: string, candidates: Candidate[]): Promise<void>;
  /** The open run's candidates, if one is still within CANDIDATES_TTL_MS. */
  openRun(): Promise<{ run: string; candidates: StoredCandidate[] } | null>;
  markCandidate(run: string, index: number, outcome: string): Promise<void>;
  closeRun(run: string): Promise<void>;
}

export class MemorySweepStore implements SweepStore {
  private slots = new Set<string>();
  private last = 0;
  private open: { run: string; candidates: StoredCandidate[]; until: number } | null = null;
  constructor(private readonly clock: () => number = Date.now) {}

  async claimSlot(day: string, nowMs: number, gapMs: number, max: number) {
    if (nowMs - this.last < gapMs) return null;
    for (let n = 1; n <= max; n++) {
      if (this.slots.has(`${day}:${n}`)) continue;
      this.slots.add(`${day}:${n}`);
      this.last = nowMs;
      return n;
    }
    return null;
  }

  async saveCandidates(run: string, candidates: Candidate[]) {
    this.open = { run, candidates: candidates.map((c) => ({ ...c })), until: this.clock() + CANDIDATES_TTL_MS };
  }

  async openRun() {
    if (!this.open || this.open.until <= this.clock()) return null;
    return { run: this.open.run, candidates: this.open.candidates.map((c) => ({ ...c })) };
  }

  async markCandidate(run: string, index: number, outcome: string) {
    if (this.open?.run === run && this.open.candidates[index]) this.open.candidates[index].done = outcome;
  }

  async closeRun(run: string) {
    if (this.open?.run === run) this.open = null;
  }
}

/** KEYS: last sweep, slot prefix. ARGV: now ms, gap ms, max, ttl ms. */
const CLAIM_SLOT_SCRIPT = `
local now = tonumber(ARGV[1])
if now - tonumber(redis.call('GET', KEYS[1]) or '0') < tonumber(ARGV[2]) then return 0 end
for n = 1, tonumber(ARGV[3]) do
  if redis.call('SET', KEYS[2] .. n, ARGV[1], 'NX', 'PX', ARGV[4]) then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
    return n
  end
end
return 0
`;

const SLOT_TTL_MS = 2 * 24 * 3_600_000;

export class UpstashSweepStore implements SweepStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "lusong",
  ) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }

  private get openKey() {
    return `${this.prefix}:sweep:open:v1`;
  }
  private candidatesKey(run: string) {
    return `${this.prefix}:sweep:candidates:v1:${run}`;
  }

  async claimSlot(day: string, nowMs: number, gapMs: number, max: number) {
    const n = Number(await this.command(["EVAL", CLAIM_SLOT_SCRIPT, 2, `${this.prefix}:sweep:last`, `${this.prefix}:sweep:slot:${day}:`, nowMs, gapMs, max, SLOT_TTL_MS]));
    return n > 0 ? n : null;
  }

  async saveCandidates(run: string, candidates: Candidate[]) {
    const fields = candidates.flatMap((c, i) => [String(i), JSON.stringify(c)]);
    if (fields.length > 0) {
      await this.command(["HSET", this.candidatesKey(run), ...fields]);
      await this.command(["PEXPIRE", this.candidatesKey(run), CANDIDATES_TTL_MS]);
    }
    await this.command(["SET", this.openKey, run, "PX", CANDIDATES_TTL_MS]);
  }

  async openRun() {
    const run = await this.command(["GET", this.openKey]);
    if (typeof run !== "string") return null;
    const flat = await this.command(["HGETALL", this.candidatesKey(run)]);
    if (!Array.isArray(flat)) return null;
    const candidates: StoredCandidate[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const at = Number(flat[i]);
      try {
        if (Number.isInteger(at) && at >= 0 && at < MAX_CANDIDATES) candidates[at] = JSON.parse(String(flat[i + 1])) as StoredCandidate;
      } catch {
        // An unreadable entry is skipped; the rest are still admitted.
      }
    }
    return { run, candidates: candidates.filter(Boolean) };
  }

  async markCandidate(run: string, index: number, outcome: string) {
    const key = this.candidatesKey(run);
    const current = await this.command(["HGET", key, String(index)]);
    if (typeof current !== "string") return;
    await this.command(["HSET", key, String(index), JSON.stringify({ ...(JSON.parse(current) as Candidate), done: outcome })]);
  }

  async closeRun(run: string) {
    await this.command(["EVAL", "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end return 1", 1, this.openKey, run]);
  }
}

const CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: MAX_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "place", "province", "kind", "organisation", "event_date"],
        properties: {
          url: { type: "string" },
          place: { type: "string" },
          province: { type: "string" },
          kind: { type: "string", enum: ["closure", "flood"] },
          organisation: { type: "string" },
          event_date: { type: "string" },
        },
      },
    },
  },
} as const;

/** The sweep's instructions. Whatever the reply says is checked against the page it names; nothing of it is shown. */
export function sweepPrompt(now: Date): string {
  return [
    `Today is ${now.toISOString().slice(0, 10)} (UTC). Find road closures and flooded roads in the Philippines reported in the last 48 hours.`,
    "Use at most 4 web searches. Prefer posts by city, municipal or provincial disaster risk reduction offices (CDRRMO, MDRRMO, PDRRMO),",
    "the DPWH, the MMDA, PAGASA, and other *.gov.ph pages, then rappler.com, inquirer.net, philstar.com, gmanetwork.com, news.abs-cbn.com,",
    "sunstar.com.ph or mb.com.ph. Never use Facebook or any social media page.",
    `Return at most ${MAX_CANDIDATES} items, each: the page's https URL, the road or barangay named on the page (place), the province it is in`,
    "as the page names it (Metro Manila for its cities), kind closure or flood, the organisation, and the event date. JSON only.",
  ].join(" ");
}

function candidatesFrom(text: string): Candidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const object = /\{[\s\S]*\}/.exec(text)?.[0];
    try {
      parsed = object ? JSON.parse(object) : null;
    } catch {
      parsed = null;
    }
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: Candidate[] = [];
  for (const item of items.slice(0, MAX_CANDIDATES)) {
    const i = (item ?? {}) as Record<string, unknown>;
    if (typeof i.url !== "string" || typeof i.place !== "string" || typeof i.province !== "string") continue;
    if (i.url.length > 500 || i.place.length > 120 || i.province.length > 60) continue;
    if (i.kind !== "closure" && i.kind !== "flood") continue;
    // The organisation and date the model wrote are dropped here: both come from the page and its host (S4P-7).
    out.push({ url: i.url, place: i.place, province: i.province, kind: i.kind });
  }
  return out;
}

export interface SweepDeps {
  sweeps: SweepStore;
  alerts: AlertStore;
  ledger: SweepLedger | null;
  /** The day's whole budget, as riders' admission reads it. */
  budgetMicros: number;
  /** One Wonder Responses call; returns the raw reply. Tests stub it; nothing in a test reaches Meta. */
  wonder: (body: Record<string, unknown>, attemptMs: number, deadline: number, meter: Meter) => Promise<unknown>;
  admit: Omit<AdmitDeps, "now">;
  now: () => Date;
  limits?: Partial<SweepLimits>;
  /** False keeps discovery off (no paid call); admission of stored candidates still runs. */
  enabled: boolean;
}

export type SweepSummary = {
  ok: boolean;
  /** What discovery did this invocation. */
  discovery: "ran" | "off" | "not_due" | "budget" | "sweep_cap" | "failed" | "continued" | "unavailable";
  slot: number | null;
  chargedMicros: number;
  candidates: number;
  admitted: number;
  refused: number;
  /** Candidates left for the next invocation. */
  left: number;
};

/** One invocation: admit the open run's candidates, else, when a slot is due, discover new ones and start on them. */
export async function runSweep(deps: SweepDeps): Promise<SweepSummary> {
  const limits = { ...SWEEP_LIMITS, ...deps.limits };
  const deadline = Date.now() + limits.budgetMs;
  const summary: SweepSummary = { ok: true, discovery: "continued", slot: null, chargedMicros: 0, candidates: 0, admitted: 0, refused: 0, left: 0 };

  let open = await deps.sweeps.openRun();
  if (!open || open.candidates.every((c) => c.done)) {
    if (open) await deps.sweeps.closeRun(open.run);
    open = null;
    const discovered = await discover(deps, limits, deadline, summary);
    if (discovered) open = discovered;
  }
  if (!open) return summary;
  await admitAll(deps, limits, deadline, open, summary);
  return summary;
}

async function discover(deps: SweepDeps, limits: SweepLimits, deadline: number, summary: SweepSummary) {
  if (!deps.enabled) {
    summary.discovery = "off";
    return null;
  }
  if (!deps.ledger) {
    summary.discovery = "unavailable";
    return null;
  }
  const now = deps.now();
  const day = now.toISOString().slice(0, 10);
  const slot = await deps.sweeps.claimSlot(day, now.getTime(), SWEEP_GAP_MS, SWEEPS_PER_DAY);
  if (slot === null) {
    summary.discovery = "not_due";
    return null;
  }
  summary.slot = slot;
  const id = randomUUID();
  const admitted = await deps.ledger.admitSweep({
    id,
    day,
    reserveMicros: SWEEP_RESERVE_MICROS,
    totalCapMicros: deps.budgetMicros - RIDER_FLOOR_MICROS,
    sweepCapMicros: SWEEP_DAILY_CAP_MICROS,
  });
  if (admitted !== "admitted") {
    summary.discovery = admitted === "budget" ? "budget" : "sweep_cap";
    return null;
  }

  const meter = new Meter();
  let reply: unknown = null;
  try {
    reply = await deps.wonder(
      {
        model: SWEEP_MODEL,
        input: sweepPrompt(now),
        tools: [{ type: "web_search" }],
        max_tool_calls: SWEEP_MAX_TOOL_CALLS,
        max_output_tokens: SWEEP_MAX_OUTPUT_TOKENS,
        text: { format: { type: "json_schema", name: "sweep_candidates", schema: CANDIDATE_SCHEMA, strict: true } },
      },
      limits.wonderAttemptMs,
      deadline,
      meter,
    );
  } catch (err) {
    console.error("sweep: Wonder call failed:", err instanceof MetaApiError ? err.message : "error");
  }
  const usage = meter.usage();
  const actual = wonderCostMicros(usage);
  // A reply over the input bound is still charged in full; a call whose counts may be missing keeps the reservation.
  const charge = reply !== null && usage.complete ? actual : Math.max(SWEEP_RESERVE_MICROS, actual);
  summary.chargedMicros = charge;
  await deps.ledger.settleSweep({ id, day, chargeMicros: charge }).catch((err) => console.error("sweep: settle failed:", err instanceof Error ? err.message : err));
  if (reply === null) {
    summary.discovery = "failed";
    summary.ok = false;
    return null;
  }
  const read = readReply(reply);
  // The provider enforces the cap; a reply that still carries more is refused whole.
  if (read.webSearchActions.length > SWEEP_MAX_TOOL_CALLS) {
    console.error(`sweep: ${read.webSearchActions.length} tool calls against a cap of ${SWEEP_MAX_TOOL_CALLS}; reply dropped`);
    summary.discovery = "failed";
    summary.ok = false;
    return null;
  }
  const candidates = candidatesFrom(read.answerText);
  summary.discovery = "ran";
  const run = randomUUID();
  await deps.sweeps.saveCandidates(run, candidates);
  return { run, candidates: candidates.map((c) => ({ ...c })) as StoredCandidate[] };
}

async function admitAll(deps: SweepDeps, limits: SweepLimits, deadline: number, open: { run: string; candidates: StoredCandidate[] }, summary: SweepSummary) {
  summary.candidates = open.candidates.length;
  const pending = open.candidates.map((c, i) => ({ c, i })).filter(({ c }) => !c.done);
  const robots = robotsChecker(deps.admit.fetchPage);
  let next = 0;
  const worker = async () => {
    while (next < pending.length && deadline - Date.now() >= limits.minAdmitMs) {
      const { c, i } = pending[next++];
      let outcome: string;
      try {
        const result = await admitCandidate(c, { ...deps.admit, robots, now: deps.now() });
        if (result.outcome === "retry") continue;
        if (result.outcome === "admitted") {
          await deps.alerts.addIfAbsent([result.alert]);
          summary.admitted += 1;
          outcome = "admitted";
        } else {
          summary.refused += 1;
          outcome = `refused: ${result.why}`;
          console.info(`sweep: candidate ${i} refused: ${result.why}`);
        }
      } catch (err) {
        console.error("sweep: admission failed:", err instanceof Error ? err.message : err);
        summary.ok = false;
        continue;
      }
      await deps.sweeps.markCandidate(open.run, i, outcome).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, pending.length) }, worker));
  const after = await deps.sweeps.openRun().catch(() => null);
  summary.left = after?.run === open.run ? after.candidates.filter((c) => !c.done).length : 0;
}

/** The deployed sweep's Wonder call: Meta's Responses API with the Wonder model named in the body. */
export const wonderFromEnv: SweepDeps["wonder"] = (body, attemptMs, deadline, meter) => sparkResponse(body, attemptMs, deadline, meter);

export function sweepLedgerFromEnv(env: Record<string, string | undefined> = process.env): SweepLedger | null {
  return budgetStoreFromEnv(env) as unknown as SweepLedger | null;
}

const sharedMemorySweepStore = (() => {
  let store: MemorySweepStore | null = null;
  return () => (store ??= new MemorySweepStore());
})();

/** The same database and switches as the budget (lib/budget.ts); the memory store is never chosen when deployed. */
export function sweepStoreFromEnv(env: Record<string, string | undefined> = process.env): SweepStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemorySweepStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashSweepStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashSweepStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}
