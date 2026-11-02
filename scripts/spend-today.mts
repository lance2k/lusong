/**
 * Prints today's figures from the production budget ledger, read-only. Run with the production env on disk, e.g.
 *
 *   vercel env pull .env.production.local --environment=production
 *   ENVFILE=.env.production.local withenv pnpm spend-today
 *
 * It reads KV_REST_API_URL and KV_REST_API_READ_ONLY_TOKEN only, so it cannot write, and it never prints either.
 *
 * The ledger keeps one total per UTC day (lib/budget.ts), and a UTC day runs 08:00 to 08:00 in Manila. A Manila
 * calendar day spans two of them and the ledger cannot split one, so this prints both budget days that touch today.
 */

// Key formats from lib/budget.ts (UpstashBudgetStore) and lib/web-search.ts (SEARCH_BUDGET_PREFIX). This file runs
// under plain Node, which cannot resolve lib/'s extensionless imports, so it repeats them.
const LEDGERS = [
  { prefix: "lusong", label: "daily budget", capUsd: Number(process.env.DAILY_BUDGET_USD ?? "10") },
  { prefix: "lusong:search", label: "web search cap (inside the daily budget)", capUsd: 3 },
];
const PHT_OFFSET_MS = 8 * 3_600_000;

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_READ_ONLY_TOKEN;
if (!url || !token) {
  console.error("spend-today: KV_REST_API_URL and KV_REST_API_READ_ONLY_TOKEN must both be set");
  process.exit(2);
}

async function redis(command: (string | number)[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url!, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command.map(String)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // The error text can carry the URL, so name only the command.
    throw new Error(`Upstash unreachable on ${command[0]}`);
  }
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status} on ${command[0]}`);
  return body.result;
}

async function scan(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = (await redis(["SCAN", cursor, "MATCH", pattern, "COUNT", 1000])) as [string, string[]];
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  // SCAN may return a key more than once.
  return [...new Set(keys)].sort();
}

async function mget(keys: string[]): Promise<(string | null)[]> {
  return keys.length === 0 ? [] : ((await redis(["MGET", ...keys])) as (string | null)[]);
}

const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;

function phtWindow(utcDay: string): string {
  const start = new Date(Date.parse(`${utcDay}T00:00:00Z`) + PHT_OFFSET_MS);
  const end = new Date(start.getTime() + 86_400_000);
  const fmt = (d: Date) => `${d.toISOString().slice(0, 10)} 08:00`;
  return `${fmt(start)} to ${fmt(end)} PHT`;
}

/** The Manila date D runs from 08:00 PHT on D-1's UTC day to 08:00 PHT on D's, so it touches UTC days D-1 and D. */
function budgetDaysOf(phtDate: string): [string, string] {
  const previous = new Date(Date.parse(`${phtDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return [previous, phtDate];
}

async function main() {
  // SPEND_TODAY_NOW (an ISO time) exists for scripts/spend-today.test.ts.
  const now = process.env.SPEND_TODAY_NOW ? new Date(process.env.SPEND_TODAY_NOW) : new Date();
  const phtNow = new Date(now.getTime() + PHT_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
  const phtDate = phtNow.slice(0, 10);
  const days = budgetDaysOf(phtDate);
  console.log(`now ${now.toISOString().slice(0, 16).replace("T", " ")} UTC (${phtNow} PHT)`);
  console.log(`PHT day ${phtDate} touches budget days ${days[0]} and ${days[1]} (UTC); each total below is a whole UTC day`);

  for (const ledger of LEDGERS) {
    // Every day key the ledger still holds (they expire after 2 days): if the key format drifted from lib/budget.ts,
    // this shows none at all rather than a quiet $0.
    const spentKeys = await scan(`${ledger.prefix}:spent:*`);
    const spent = new Map(spentKeys.map((k, i) => [k, i]));
    const spentValues = await mget(spentKeys);
    const resKeys = await scan(`${ledger.prefix}:res:*`);
    const open = new Map<string, { count: number; micros: number }>();
    for (const value of await mget(resKeys)) {
      const match = value?.match(/^(\d+):(.+)$/);
      if (!match) continue;
      const day = open.get(match[2]) ?? { count: 0, micros: 0 };
      open.set(match[2], { count: day.count + 1, micros: day.micros + Number(match[1]) });
    }

    console.log(`\n${ledger.label}: cap ${usd(ledger.capUsd * 1e6)} per UTC day; ${spentKeys.length} day key(s) held`);
    for (const day of days) {
      const key = `${ledger.prefix}:spent:${day}`;
      const index = spent.get(key);
      const micros = index === undefined ? 0 : Number(spentValues[index] ?? 0);
      const held = open.get(day);
      // Read apart from the total, so a check admitted or settled in between can make the two disagree.
      const openNote = held ? `; open reservations ${held.count} holding ${usd(held.micros)}` : "";
      const absent = index === undefined ? " (no key: nothing admitted that day)" : "";
      console.log(`  ${key}  ${usd(micros)}${absent}${openNote}  [${phtWindow(day)}]`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(`spend-today: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
});
