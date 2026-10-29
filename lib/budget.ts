import { createHash, randomUUID } from "node:crypto";
import { MUSE_MAX_COMPLETION_TOKENS } from "./readings";

/**
 * Meta's list prices (docs, 2026-10): SAM $2.50 per 1,000 images; Muse Spark $1.25 / $4.25 per 1M tokens; Voice
 * Transcribe $0.18 per hour of audio, "metered in whole seconds" and "rounded down to whole seconds"
 * (dev.meta.ai/docs/pricing-rate-limits, read 2026-10-30).
 */
const SAM_IMAGE_MICROS = 2_500;
export const MUSE_INPUT_MICROS_PER_TOKEN = 1.25;
export const MUSE_OUTPUT_MICROS_PER_TOKEN = 4.25;
export const TRANSCRIBE_MICROS_PER_SECOND = 180_000 / 3_600;

/** lib/meta.ts makes at most this many attempts per call; lib/check.ts makes 4 SAM calls and 1 Muse call. */
const ATTEMPTS_PER_CALL = 2;
const SAM_CALLS = 4;
/** 1.5 × the 3,881 input tokens measured on a 1600×1600 photo with 12 objects, the largest the route
 *  accepts (one draw, 2026-10-28; 1600×1200 measured 2,968). */
export const MUSE_INPUT_TOKEN_BOUND = 5_822;

/** The most one admitted check can cost with every retry used, in micro-dollars. */
export const RESERVE_MICROS =
  SAM_CALLS * ATTEMPTS_PER_CALL * SAM_IMAGE_MICROS +
  ATTEMPTS_PER_CALL *
    Math.ceil(
      MUSE_INPUT_TOKEN_BOUND * MUSE_INPUT_MICROS_PER_TOKEN + MUSE_MAX_COMPLETION_TOKENS * MUSE_OUTPUT_MICROS_PER_TOKEN,
    );

/** A photo report that may publish its photo adds one SAM call, for plates; the depth reader's person reply is reused. */
export const PHOTO_REPORT_RESERVE_MICROS = RESERVE_MICROS + ATTEMPTS_PER_CALL * SAM_IMAGE_MICROS;

/** What one check's Meta calls cost, as metered by lib/meta.ts. */
export interface MeteredUsage {
  samImages: number;
  museInputTokens: number;
  museOutputTokens: number;
  /** Whole seconds of audio Voice Transcribe processed. */
  transcribeSeconds: number;
  /** False when any call was retried, failed, or came back without a usage block: a billed attempt may
   *  be missing from the counts, so the counts are a floor, not the cost. */
  complete: boolean;
}

export function costMicros(usage: MeteredUsage): number {
  return Math.ceil(
    usage.samImages * SAM_IMAGE_MICROS +
      usage.museInputTokens * MUSE_INPUT_MICROS_PER_TOKEN +
      usage.museOutputTokens * MUSE_OUTPUT_MICROS_PER_TOKEN +
      usage.transcribeSeconds * TRANSCRIBE_MICROS_PER_SECOND,
  );
}

export type RefusalReason = "budget" | "ip" | "unavailable";
export type Admitted = { ok: true; id: string; day: string; reservedMicros: number };
export type Admission = Admitted | { ok: false; reason: RefusalReason };

export interface BudgetStore {
  /** Atomic: admits only if the IP's count stays within ipLimit and spend + reserve stays within the
   *  budget, then records both plus the reservation under `id`. A refusal changes nothing. A null
   *  ipKey (a run no client asked for) skips the IP count entirely. */
  admit(a: {
    id: string;
    day: string;
    ipKey: string | null;
    reserveMicros: number;
    budgetMicros: number;
    ipLimit: number;
  }): Promise<"admitted" | "budget" | "ip">;
  /** Atomic and once only: if reservation `id` is still open, closes it and moves that day's spend by
   *  (charge − reserved). Returns false when it was already settled. */
  settle(s: { id: string; day: string; chargeMicros: number }): Promise<boolean>;
}

export interface Budget {
  /** A null ip is a scheduled run: it reserves against the daily budget and no address's limit. */
  admit(ip: string | null, now: Date, reserveMicros?: number): Promise<Admission>;
  /** Never throws: a settle that fails leaves the whole reservation charged. */
  settle(admission: Admitted, usage: MeteredUsage, succeeded: boolean): Promise<void>;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Hashed so the store never holds a plain IP; the day in the input stops keys linking across days. */
function ipKeyFor(day: string, ip: string): string {
  return createHash("sha256").update(`${day}:${ip}`).digest("hex").slice(0, 32);
}

export function createBudget(options: { store: BudgetStore | null; budgetUsd: number; ipLimit: number }): Budget {
  const { store, ipLimit } = options;
  const budgetMicros = Math.floor(options.budgetUsd * 1e6);
  return {
    async admit(ip, now, reserveMicros = RESERVE_MICROS) {
      if (!store || !Number.isFinite(budgetMicros) || budgetMicros <= 0) return { ok: false, reason: "unavailable" };
      // A negative reservation would lower the day's spend, and Redis's INCRBY takes only integers.
      if (!Number.isSafeInteger(reserveMicros) || reserveMicros <= 0) {
        console.error(`refused a reservation of ${reserveMicros} µ$: it must be a positive whole number`);
        return { ok: false, reason: "unavailable" };
      }
      const day = utcDay(now);
      const id = randomUUID();
      let outcome: Awaited<ReturnType<BudgetStore["admit"]>>;
      try {
        outcome = await store.admit({
          id,
          day,
          ipKey: ip === null ? null : ipKeyFor(day, ip),
          reserveMicros,
          budgetMicros,
          ipLimit,
        });
      } catch (err) {
        console.error("budget store unreachable on admit:", err instanceof Error ? err.message : err);
        return { ok: false, reason: "unavailable" };
      }
      return outcome === "admitted" ? { ok: true, id, day, reservedMicros: reserveMicros } : { ok: false, reason: outcome };
    },

    async settle(admission, usage, succeeded) {
      if (!store) return;
      const actual = costMicros(usage);
      const chargeMicros = succeeded && usage.complete ? actual : Math.max(admission.reservedMicros, actual);
      if (actual > admission.reservedMicros) {
        console.error(`check cost ${actual} µ$ against a ${admission.reservedMicros} µ$ reservation`);
      }
      try {
        await store.settle({ id: admission.id, day: admission.day, chargeMicros });
      } catch (err) {
        console.error("budget store unreachable on settle:", err instanceof Error ? err.message : err);
      }
    },
  };
}

const sharedMemoryStore = (() => {
  let store: MemoryBudgetStore | null = null;
  return () => (store ??= new MemoryBudgetStore());
})();

function storeFromEnv(env: Record<string, string | undefined>): BudgetStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashBudgetStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  /** The names Vercel's Upstash integration sets when a database is connected to the project. */
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return new UpstashBudgetStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  }
  return null;
}

/** Anything missing or unreadable resolves to a budget that refuses every check. */
export function budgetFromEnv(env: Record<string, string | undefined> = process.env): Budget {
  const budgetUsd = Number(env.DAILY_BUDGET_USD ?? "10");
  const ipLimit = Number(env.PER_IP_DAILY ?? "10");
  const readable = Number.isFinite(budgetUsd) && budgetUsd > 0 && Number.isInteger(ipLimit) && ipLimit > 0;
  return createBudget({ store: readable ? storeFromEnv(env) : null, budgetUsd, ipLimit });
}

/** For local development and tests only: each server instance would keep its own ledger. */
export class MemoryBudgetStore implements BudgetStore {
  private spent = new Map<string, number>();
  private perIp = new Map<string, number>();
  private reservations = new Map<string, { day: string; reserved: number }>();

  async admit(a: Parameters<BudgetStore["admit"]>[0]) {
    const spent = this.spent.get(a.day) ?? 0;
    const ipKey = a.ipKey === null ? null : `${a.day}:${a.ipKey}`;
    const ipCount = ipKey === null ? 0 : (this.perIp.get(ipKey) ?? 0);
    if (spent + a.reserveMicros > a.budgetMicros) return "budget" as const;
    if (ipKey !== null && ipCount + 1 > a.ipLimit) return "ip" as const;
    this.spent.set(a.day, spent + a.reserveMicros);
    if (ipKey !== null) this.perIp.set(ipKey, ipCount + 1);
    this.reservations.set(a.id, { day: a.day, reserved: a.reserveMicros });
    return "admitted" as const;
  }

  async settle(s: Parameters<BudgetStore["settle"]>[0]) {
    const open = this.reservations.get(s.id);
    if (!open || open.day !== s.day) return false;
    this.reservations.delete(s.id);
    this.spent.set(s.day, (this.spent.get(s.day) ?? 0) + s.chargeMicros - open.reserved);
    return true;
  }
}

/** KEYS are spend, then the IP count unless the run has no address, then the reservation. */
const ADMIT_SCRIPT = `
local hasIp = #KEYS == 3
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserve, budget, limit, ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
if spent + reserve > budget then return 'budget' end
if hasIp and tonumber(redis.call('GET', KEYS[2]) or '0') + 1 > limit then return 'ip' end
redis.call('INCRBY', KEYS[1], reserve)
redis.call('EXPIRE', KEYS[1], ttl)
if hasIp then
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ttl)
end
redis.call('SET', KEYS[#KEYS], reserve .. ':' .. ARGV[5], 'EX', ttl)
return 'admitted'
`;

/** A reservation settles only against the day it was made on. The spend key may have expired by
 *  settle time; INCRBY would then recreate it with no TTL. */
const SETTLE_SCRIPT = `
local open = redis.call('GET', KEYS[1])
if not open then return 0 end
local reserved, day = string.match(open, '^(%d+):(.+)$')
if day ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('INCRBY', KEYS[2], tonumber(ARGV[1]) - tonumber(reserved))
end
return 1
`;

/** Two days, so a check admitted just before midnight UTC still finds its keys when it settles. */
const KEY_TTL_SECONDS = 172_800;

/** Upstash's REST API: one POST per command, the command as a JSON array. */
export class UpstashBudgetStore implements BudgetStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "lusong",
  ) {}

  private async evalScript(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["EVAL", script, keys.length, ...keys, ...args.map(String)]),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }

  async admit(a: Parameters<BudgetStore["admit"]>[0]) {
    const ipKeys = a.ipKey === null ? [] : [`${this.prefix}:ip:${a.day}:${a.ipKey}`];
    const result = await this.evalScript(
      ADMIT_SCRIPT,
      [`${this.prefix}:spent:${a.day}`, ...ipKeys, `${this.prefix}:res:${a.id}`],
      [a.reserveMicros, a.budgetMicros, a.ipLimit, KEY_TTL_SECONDS, a.day],
    );
    if (result === "admitted" || result === "budget" || result === "ip") return result;
    throw new Error(`unexpected admit result ${JSON.stringify(result)}`);
  }

  async settle(s: Parameters<BudgetStore["settle"]>[0]) {
    const result = await this.evalScript(
      SETTLE_SCRIPT,
      [`${this.prefix}:res:${s.id}`, `${this.prefix}:spent:${s.day}`],
      [s.chargeMicros, s.day],
    );
    return result === 1;
  }
}
