import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { guardedLookup, isPrivateAddress, robotsAllow, safeFetch, type Resolver, type Transport } from "./safe-fetch";

type Reply = { status?: number; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[]; stall?: boolean };

/**
 * A fake network: every request first resolves its host through the `lookup` it was given, exactly as Node's socket
 * would, and records the address it would connect to; only then does the page answer.
 */
function network(pages: Record<string, Reply>) {
  const connectedTo: string[] = [];
  const asked: string[] = [];
  const transport: Transport = (options, onResponse) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(err?: Error): void };
    let destroyed = false;
    req.destroy = () => {
      destroyed = true;
    };
    req.end = () => {
      const lookup = options.lookup as unknown as (h: string, o: { all: boolean }, cb: (err: Error | null, a: { address: string }[]) => void) => void;
      lookup(String(options.hostname), { all: true }, (err, addresses) => {
        if (err) return void req.emit("error", err);
        connectedTo.push(addresses[0].address);
        const key = `${options.hostname}${options.path}`;
        asked.push(key);
        const reply = pages[key] ?? { status: 404, body: "" };
        if (reply.stall) return;
        const chunks = reply.chunks ?? [Buffer.from(reply.body ?? "")];
        const res = Readable.from(
          (async function* () {
            for (const c of chunks) {
              if (destroyed) return;
              yield c;
            }
          })(),
        ) as unknown as IncomingMessage;
        Object.assign(res, { statusCode: reply.status ?? 200, headers: reply.headers ?? { "content-type": "text/html" } });
        onResponse(res);
      });
    };
    return req;
  };
  return { transport, connectedTo, asked };
}

const publicDns: Resolver = async () => [{ address: "203.0.114.10", family: 4 }];
const allowGov = (host: string) => host === "gov.ph" || host.endsWith(".gov.ph") || host === "www.rappler.com";

describe("which addresses are private (S4P-4)", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "not an address",
  ])("%s is refused", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["203.0.114.10", "8.8.8.8", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("the guarded lookup (S4P-4)", () => {
  const lookupOnce = (resolver: Resolver) =>
    new Promise<{ err: Error | null; addresses: unknown }>((resolve) => guardedLookup(resolver)("x.gov.ph", { all: true }, (err, addresses) => resolve({ err, addresses })));

  it("refuses the whole host when any answer is private, even beside a public one", async () => {
    const mixed: Resolver = async () => [
      { address: "203.0.114.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    expect((await lookupOnce(mixed)).err?.message).toBe("x.gov.ph resolves to a private address");
  });

  it("checks every resolution: a rebinding answer on the second call is refused", async () => {
    let calls = 0;
    const rebinding: Resolver = async () => (++calls === 1 ? [{ address: "203.0.114.10", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    expect((await lookupOnce(rebinding)).err).toBeNull();
    expect((await lookupOnce(rebinding)).err?.message).toBe("x.gov.ph resolves to a private address");
  });

  it("hands the connection exactly the addresses it checked", async () => {
    expect(await lookupOnce(publicDns)).toEqual({ err: null, addresses: [{ address: "203.0.114.10", family: 4 }] });
  });
});

describe("safeFetch (S4P-4, ledger #5)", () => {
  it("fetches a public page on the allowlist, connecting to the address it checked", async () => {
    const net = network({ "www.cebucity.gov.ph/advisory": { body: "<p>Road closed</p>" } });
    const got = await safeFetch("https://www.cebucity.gov.ph/advisory", { allowHost: allowGov, resolver: publicDns, transport: net.transport });
    expect(got).toEqual({ ok: true, url: "https://www.cebucity.gov.ph/advisory", status: 200, contentType: "text/html", body: "<p>Road closed</p>" });
    expect(net.connectedTo).toEqual(["203.0.114.10"]);
  });

  it.each([
    ["a private answer", async () => [{ address: "192.168.0.10", family: 4 }]],
    ["the metadata address", async () => [{ address: "169.254.169.254", family: 4 }]],
    ["an IPv4-mapped loopback", async () => [{ address: "::ffff:127.0.0.1", family: 6 }]],
    ["a CGNAT address", async () => [{ address: "100.64.1.1", family: 4 }]],
    ["a link-local IPv6 address", async () => [{ address: "fe80::1", family: 6 }]],
  ] as [string, Resolver][])("refuses a host with %s and never connects", async (_name, resolver) => {
    const net = network({ "x.gov.ph/": { body: "secret" } });
    const got = await safeFetch("https://x.gov.ph/", { allowHost: allowGov, resolver, transport: net.transport });
    expect(got).toEqual({ ok: false, why: "x.gov.ph resolves to a private address" });
    expect(net.connectedTo).toEqual([]);
  });

  it.each([
    ["http://x.gov.ph/", "not HTTPS"],
    ["https://127.0.0.1/", "an IP address, not a name"],
    ["https://[::1]/", "an IP address, not a name"],
    ["https://x.gov.ph:8443/", "not port 443"],
    ["https://user:pw@x.gov.ph/", "a URL with credentials"],
    ["https://www.facebook.com/cebucitydrrmo", "www.facebook.com is not on the allowlist"],
    ["https://evilgov.ph/", "evilgov.ph is not on the allowlist"],
  ])("refuses %s before any request", async (url, why) => {
    const net = network({});
    expect(await safeFetch(url, { allowHost: allowGov, resolver: publicDns, transport: net.transport })).toEqual({ ok: false, why });
    expect(net.asked).toEqual([]);
  });

  it("follows a redirect on the allowlist, and refuses one off it", async () => {
    const net = network({
      "a.gov.ph/old": { status: 301, headers: { location: "https://b.gov.ph/new" } },
      "b.gov.ph/new": { body: "here" },
      "a.gov.ph/out": { status: 302, headers: { location: "https://metadata.internal/latest" } },
      "a.gov.ph/plain": { status: 302, headers: { location: "http://b.gov.ph/new" } },
    });
    const deps = { allowHost: allowGov, resolver: publicDns, transport: net.transport };
    expect(await safeFetch("https://a.gov.ph/old", deps)).toMatchObject({ ok: true, url: "https://b.gov.ph/new", body: "here" });
    expect(await safeFetch("https://a.gov.ph/out", deps)).toEqual({ ok: false, why: "metadata.internal is not on the allowlist" });
    expect(await safeFetch("https://a.gov.ph/plain", deps)).toEqual({ ok: false, why: "not HTTPS" });
  });

  it("re-checks each redirect's address: an allowed name that resolves privately is refused", async () => {
    const net = network({ "a.gov.ph/": { status: 302, headers: { location: "https://inside.gov.ph/" } }, "inside.gov.ph/": { body: "secret" } });
    const resolver: Resolver = async (host) => (host === "inside.gov.ph" ? [{ address: "10.0.0.1", family: 4 }] : [{ address: "203.0.114.10", family: 4 }]);
    expect(await safeFetch("https://a.gov.ph/", { allowHost: allowGov, resolver, transport: net.transport })).toEqual({ ok: false, why: "inside.gov.ph resolves to a private address" });
    expect(net.asked).toEqual(["a.gov.ph/"]);
  });

  it("stops after 3 redirects", async () => {
    const net = network(Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`a.gov.ph/${i}`, { status: 302, headers: { location: `/${i + 1}` } }])));
    expect(await safeFetch("https://a.gov.ph/0", { allowHost: allowGov, resolver: publicDns, transport: net.transport })).toEqual({ ok: false, why: "more than 3 redirects" });
    expect(net.asked).toHaveLength(4);
  });

  it("refuses an oversize page, counting decoded bytes: a small gzip that inflates past 512 KB too", async () => {
    const big = Buffer.alloc(600 * 1024, "a");
    const net = network({
      "a.gov.ph/big": { chunks: [big.subarray(0, 300 * 1024), big.subarray(300 * 1024)] },
      "a.gov.ph/bomb": { headers: { "content-encoding": "gzip" }, body: gzipSync(big) },
    });
    const deps = { allowHost: allowGov, resolver: publicDns, transport: net.transport };
    expect(gzipSync(big).length).toBeLessThan(10_000);
    expect(await safeFetch("https://a.gov.ph/big", deps)).toEqual({ ok: false, why: "larger than 524288 bytes" });
    expect(await safeFetch("https://a.gov.ph/bomb", deps)).toEqual({ ok: false, why: "larger than 524288 bytes" });
  });

  it("gives up on a stalled response at its deadline", async () => {
    const net = network({ "a.gov.ph/slow": { stall: true } });
    const started = Date.now();
    expect(await safeFetch("https://a.gov.ph/slow", { allowHost: allowGov, resolver: publicDns, transport: net.transport, limits: { deadlineMs: 300 } })).toEqual({
      ok: false,
      why: "out of time",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("uses Node's https.request with the guarded lookup when no transport is given (a refused name never connects)", async () => {
    const got = await safeFetch("https://x.gov.ph/", { allowHost: allowGov, resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(got).toEqual({ ok: false, why: expect.stringContaining("x.gov.ph resolves to a private address") });
  });
});

describe("robots.txt", () => {
  const robots = "User-agent: *\nDisallow: /private\nAllow: /private/advisories\n\nUser-agent: BadBot\nDisallow: /\n";

  it("follows the * group's longest matching rule", () => {
    expect(robotsAllow(robots, "/news/flood")).toBe(true);
    expect(robotsAllow(robots, "/private/x")).toBe(false);
    expect(robotsAllow(robots, "/private/advisories/1")).toBe(true);
  });

  it("a group naming Lusong wins over *, and Disallow: / refuses everything", () => {
    expect(robotsAllow("User-agent: *\nAllow: /\n\nUser-agent: lusong\nDisallow: /\n", "/a")).toBe(false);
    expect(robotsAllow("User-agent: *\nDisallow: /\n", "/")).toBe(false);
    expect(robotsAllow("", "/anything")).toBe(true);
  });
});
