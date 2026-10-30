import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { locateSpot } from "./locate";
import { VALHALLA_URL, type ValhallaGate } from "./router";

/** One /locate request for five pins, 2026-10-30 01:32 PHT; a request for one pin answers with one such entry. */
const LOCATE = JSON.parse(readFileSync("test/fixtures/valhalla/locate-sample-pins.json", "utf8")) as {
  input_lat: number;
  input_lon: number;
}[];

function valhalla(reply: () => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return reply();
  });
  return { fetch: fetchMock as unknown as typeof fetch, requests };
}

const open: ValhallaGate = { acquire: async () => "ok" };
const pinOf = (i: number) => ({ lat: LOCATE[i].input_lat, lon: LOCATE[i].input_lon });

describe("the reported spot's road, from one Valhalla /locate (🔴P4)", () => {
  it("names the OSM way and street the pin is on, in one motorcycle /locate request through the gate", async () => {
    const acquire = vi.fn(async () => "ok" as const);
    const { fetch, requests } = valhalla(() => Response.json([LOCATE[0]]));
    expect(await locateSpot(pinOf(0), { fetch, gate: { acquire } })).toEqual({
      wayId: 1116002958,
      place: "Governor M. Cuenco Avenue",
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${VALHALLA_URL}/locate`);
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      locations: [{ lat: 10.338566, lon: 123.911461 }],
      costing: "motorcycle",
      verbose: true,
    });
    const headers = new Headers(requests[0].init.headers);
    expect(headers.get("user-agent")).toMatch(/^Lusong\//);
    expect(headers.get("x-client-id")).toBe("lusong");
  });

  it("a pin on a corner has no way id and names both streets", async () => {
    const { fetch } = valhalla(() => Response.json([LOCATE[2]]));
    expect(await locateSpot(pinOf(2), { fetch, gate: open })).toEqual({
      wayId: null,
      place: "M.J. Cuenco Avenue at H. Joaquino Street",
    });
  });

  it.each([
    ["the gate is busy", { acquire: async () => "busy" as const }, () => Response.json([LOCATE[0]])],
    ["the gate has no store", { acquire: async () => "unavailable" as const }, () => Response.json([LOCATE[0]])],
  ])("no request when %s, and no way id", async (_why, gate, reply) => {
    const { fetch, requests } = valhalla(reply);
    expect(await locateSpot(pinOf(0), { fetch, gate })).toEqual({ wayId: null, place: null });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["the server is unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    ["the server errs", () => new Response("busy", { status: 503 })],
    ["the reply is not JSON", () => new Response("<html>", { status: 200 })],
    ["the reply has no entries", () => Response.json([])],
    ["the reply is for no edges", () => Response.json([{ edges: null }])],
  ])("%s: one request, no retry, no way id", async (_why, reply) => {
    const { fetch, requests } = valhalla(reply);
    expect(await locateSpot(pinOf(0), { fetch, gate: open })).toEqual({ wayId: null, place: null });
    expect(requests).toHaveLength(1);
  });
});
