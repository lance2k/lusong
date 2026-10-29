import { randomUUID } from "node:crypto";
import { MemoryWatchStore, UpstashWatchStore, type WatchStore } from "../lib/watch-store";

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";

async function upstash(command: (string | number)[]): Promise<unknown> {
  const res = await fetch(upstashUrl!, {
    method: "POST",
    headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(command.map(String)),
  });
  return ((await res.json()) as { result: unknown }).result;
}

/** A store, what it holds (every key with its time to live in ms, -1 for none), and a way to wait out short TTLs. */
export interface StoreUnderTest {
  store: WatchStore;
  held(): Promise<Record<string, number>>;
  /** Passes `ms` of the store's own time: the memory store's clock, or real time for Upstash. */
  wait(ms: number): Promise<void>;
}

export type StoreOptions = { codeTtlMs?: number; ttlMs?: number; maxWatchers?: number };

export const watchStores: [string, (opts?: StoreOptions) => StoreUnderTest][] = [
  [
    "memory store",
    (opts = {}) => {
      let t = Date.parse("2026-10-30T00:00:00Z");
      const store = new MemoryWatchStore({ ...opts, now: () => t });
      return {
        store,
        held: async () => store.ttls(),
        wait: async (ms) => {
          t += ms;
        },
      };
    },
  ],
  ...(upstashUrl
    ? [
        [
          "Upstash store",
          (opts: StoreOptions = {}) => {
            const prefix = `lusong-test-${randomUUID()}`;
            return {
              store: new UpstashWatchStore(upstashUrl, upstashToken, prefix, opts),
              held: async () => {
                const out: Record<string, number> = {};
                let cursor = "0";
                do {
                  const [next, keys] = (await upstash(["SCAN", cursor, "MATCH", `${prefix}:*`, "COUNT", 1000])) as [string, string[]];
                  for (const key of keys) out[key.replace(prefix, "lusong")] = Number(await upstash(["PTTL", key]));
                  cursor = next;
                } while (cursor !== "0");
                return out;
              },
              wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            } satisfies StoreUnderTest;
          },
        ] as [string, (opts?: StoreOptions) => StoreUnderTest],
      ]
    : []),
];
