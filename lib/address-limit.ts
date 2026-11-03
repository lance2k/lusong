import { ipKeyFor, utcDay } from "./budget";

/**
 * A per-address count for one feature, per UTC day, under its own keys: it never touches the daily checks' count. The
 * address is hashed with the day, as the budget's is, so the store never holds a plain IP.
 */
export interface CountStore {
  /** Atomic: adds one to `key` and returns true only if the count stays within `limit`; a refusal changes nothing. */
  take(key: string, limit: number, ttlSeconds: number): Promise<boolean>;
}

export type LimitOutcome = "ok" | "limited" | "unavailable";

export interface AddressLimit {
  take(ip: string, now: Date): Promise<LimitOutcome>;
}

/** Two days, so a count made just before midnight UTC outlives its day. */
const KEY_TTL_SECONDS = 172_800;

export function addressLimitKey(prefix: string, ip: string, now: Date): string {
  const day = utcDay(now);
  return `${prefix}:ip:${day}:${ipKeyFor(day, ip)}`;
}

export function createAddressLimit(opts: { store: CountStore | null; prefix: string; limit: number }): AddressLimit {
  return {
    async take(ip, now) {
      if (!opts.store) return "unavailable";
      try {
        return (await opts.store.take(addressLimitKey(opts.prefix, ip, now), opts.limit, KEY_TTL_SECONDS)) ? "ok" : "limited";
      } catch (err) {
        console.error("address limit store unreachable:", err instanceof Error ? err.message : err);
        return "unavailable";
      }
    },
  };
}

/** For local development and tests only: each server instance would keep its own counts. */
export class MemoryCountStore implements CountStore {
  private counts = new Map<string, number>();

  async take(key: string, limit: number) {
    const n = this.counts.get(key) ?? 0;
    if (n + 1 > limit) return false;
    this.counts.set(key, n + 1);
    return true;
  }
}

const TAKE_SCRIPT = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n + 1 > tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

export class UpstashCountStore implements CountStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async take(key: string, limit: number, ttlSeconds: number) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["EVAL", TAKE_SCRIPT, "1", key, String(limit), String(ttlSeconds)]),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    if (body.result !== 0 && body.result !== 1) throw new Error("Upstash: unexpected reply");
    return body.result === 1;
  }
}

const sharedMemoryCounts = (() => {
  let store: MemoryCountStore | null = null;
  return () => (store ??= new MemoryCountStore());
})();

/** The same database as the budget, from the same variables; null when none is configured or memory is asked for when deployed. */
export function countStoreFromEnv(env: Record<string, string | undefined> = process.env): CountStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryCounts();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashCountStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashCountStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}
