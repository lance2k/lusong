import { randomUUID } from "node:crypto";
import { MemoryTelegramStore, UpstashTelegramStore, type TelegramStore } from "../lib/telegram-store";

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

/** A store, what it holds (every key with its value), and a way to let its short expiries pass. */
export interface TelegramStoreUnderTest {
  store: TelegramStore;
  held(): Promise<Record<string, string>>;
  /** Passes `ms` of the store's own time: the memory store's clock, or real time for Upstash. */
  wait(ms: number): Promise<void>;
}

export type TelegramStoreOptions = { pendingTtlMs?: number; processingMs?: number };

export const telegramStores: [string, (opts?: TelegramStoreOptions) => TelegramStoreUnderTest][] = [
  [
    "memory store",
    (opts = {}) => {
      let t = Date.parse("2026-11-03T01:00:00Z");
      const store = new MemoryTelegramStore({ ...opts, now: () => t });
      return {
        store,
        held: async () => store.dump(),
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
          (opts: TelegramStoreOptions = {}) => {
            const prefix = `lusong-test-${randomUUID()}`;
            return {
              store: new UpstashTelegramStore(upstashUrl, upstashToken, prefix, opts),
              held: async () => {
                const out: Record<string, string> = {};
                let cursor = "0";
                do {
                  const [next, keys] = (await upstash(["SCAN", cursor, "MATCH", `${prefix}:*`, "COUNT", 1000])) as [string, string[]];
                  for (const key of keys) out[key.replace(prefix, "lusong")] = String(await upstash(["GET", key]));
                  cursor = next;
                } while (cursor !== "0");
                return out;
              },
              wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            } satisfies TelegramStoreUnderTest;
          },
        ] as [string, (opts?: TelegramStoreOptions) => TelegramStoreUnderTest],
      ]
    : []),
];
