import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { USER_AGENT } from "./advisory";

/**
 * Fetches a page the sweep's model named, without letting it reach anything but a public HTTPS host on the allowlist
 * (disposition S4P-4). Every address a name resolves to is checked, the whole host is refused if any is private, and the
 * connection is handed the address that was checked, so a second resolution can't swap it (DNS rebinding). The hostname
 * still drives SNI and the certificate check. A redirect is refused, one deadline and one decoded-byte limit cover the
 * fetch, and every way out destroys the request and the response.
 */

export const SAFE_FETCH_LIMITS = { deadlineMs: 8_000, maxBytes: 512 * 1024 };

export type Resolver = (host: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))));

const PRIVATE_V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, and the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4],
] as const) {
  PRIVATE_V4.addSubnet(net, bits, "ipv4");
}

const PRIVATE_V6 = new BlockList();
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4, which carries an IPv4 address
  ["fc00::", 7], // unique local, AWS's fd00:ec2::254 metadata among them
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE_V6.addSubnet(net, bits, "ipv6");
}

/** The 16 bytes of an IPv6 address, or null when it can't be read. */
function v6Bytes(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    tail = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** True for any address a request must never go to: private, loopback, link-local, CGNAT, multicast, metadata, reserved. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.check(address, "ipv4");
  if (family !== 6) return true;
  const bytes = v6Bytes(address);
  if (!bytes) return true;
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  const embedded = bytes.slice(12).join(".");
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return PRIVATE_V4.check(embedded, "ipv4");
  if (zeros(0, 12)) return true;
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return PRIVATE_V4.check(embedded, "ipv4");
  return PRIVATE_V6.check(address.split("%")[0], "ipv6");
}

export class Refused extends Error {}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for `https.request`: resolves the name once, refuses the whole host if any answer is private, and gives the
 * connection only the addresses it checked. Called again on every connection, so an answer that changes is checked again.
 */
export function guardedLookup(resolver: Resolver) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(Object.assign(new Refused(`${hostname} has no address`), { code: "ENOTFOUND" }), []);
        const bad = addresses.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(Object.assign(new Refused(`${hostname} resolves to a private address`), { code: "EREFUSED" }), []);
        if (typeof options === "object" && options?.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

export type SafeFetchResult = { ok: true; url: string; status: number; contentType: string; body: string } | { ok: false; why: string };

export type Transport = (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => {
  on(event: "error", listener: (err: Error) => void): unknown;
  end(): unknown;
  destroy(err?: Error): unknown;
};

export interface SafeFetchDeps {
  /** The hostnames a request may go to; an IP literal never may. */
  allowHost: (host: string) => boolean;
  resolver?: Resolver;
  /** Node's https.request; tests replace it. */
  transport?: Transport;
  limits?: Partial<typeof SAFE_FETCH_LIMITS>;
}

function checkUrl(raw: string, allowHost: (host: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refused("not a URL");
  }
  if (url.protocol !== "https:") throw new Refused("not HTTPS");
  if (url.username || url.password) throw new Refused("a URL with credentials");
  if (url.port && url.port !== "443") throw new Refused("not port 443");
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) throw new Refused("an IP address, not a name");
  if (!allowHost(host)) throw new Refused(`${host} is not on the allowlist`);
  return url;
}

function decoded(res: IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(createGunzip());
  if (encoding === "deflate") return res.pipe(createInflate());
  if (encoding === "br") return res.pipe(createBrotliDecompress());
  if (encoding === "identity" || encoding === "") return res;
  throw new Refused(`content-encoding ${encoding}`);
}

/**
 * GET with every check above. Never throws; a refusal says why. A redirect is refused, never followed (S4D-3): the
 * robots check and the attribution then always describe the one page fetched.
 */
export async function safeFetch(rawUrl: string, deps: SafeFetchDeps): Promise<SafeFetchResult> {
  const limits = { ...SAFE_FETCH_LIMITS, ...deps.limits };
  const lookup = guardedLookup(deps.resolver ?? systemResolver);
  const transport: Transport = deps.transport ?? ((options, onResponse) => httpsRequest(options, onResponse));
  try {
    const url = checkUrl(rawUrl, deps.allowHost);
    const outcome = await new Promise<{ status: number; contentType: string; body: string }>((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | null = null;
      // Every way out ends the request and the response, so nothing is left reading after the fetch has answered.
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const stop = (err: unknown) =>
        finish(() => {
          req.destroy();
          response?.destroy();
          reject(err);
        });
      const req = transport(
        {
          protocol: "https:",
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          servername: url.hostname,
          lookup: lookup as RequestOptions["lookup"],
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "Accept-Encoding": "gzip, deflate, br" },
        },
        (res) => {
          try {
            response = res;
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) return stop(new Refused("redirected"));
            const stream = decoded(res);
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > limits.maxBytes) {
                stream.destroy();
                return stop(new Refused(`larger than ${limits.maxBytes} bytes`));
              }
              chunks.push(chunk);
            });
            stream.on("end", () => {
              try {
                const body = new TextDecoder().decode(Buffer.concat(chunks));
                finish(() => resolve({ status, contentType: String(res.headers["content-type"] ?? ""), body }));
              } catch (err) {
                stop(err);
              }
            });
            stream.on("error", stop);
          } catch (err) {
            stop(err);
          }
        },
      );
      const timer = setTimeout(() => stop(new Refused("out of time")), limits.deadlineMs);
      req.on("error", stop);
      req.end();
    });
    return { ok: true, url: url.href, ...outcome };
  } catch (err) {
    return { ok: false, why: err instanceof Refused ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : "failed" };
  }
}

/** robots.txt's rules for Lusong's agent (the `lusong` groups, else `*`): the longest matching Allow or Disallow wins. */
export function robotsAllow(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; prefix: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current && value !== "") current.rules.push({ allow: field === "allow", prefix: value });
    } else {
      lastWasAgent = false;
    }
  }
  // Every group naming Lusong counts, else every `*` group: their rules are combined before precedence (S4D-7).
  const named = groups.filter((g) => g.agents.includes("lusong"));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  if (chosen.length === 0) return true;
  const mine = { rules: chosen.flatMap((g) => g.rules) };
  const matches = (prefix: string) => {
    const pattern = new RegExp(`^${prefix.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    return pattern.test(path);
  };
  const hit = mine.rules.filter((r) => matches(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length || Number(b.allow) - Number(a.allow))[0];
  return hit ? hit.allow : true;
}
