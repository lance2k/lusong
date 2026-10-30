import { distanceM, type Point } from "../lib/answer";
import { decodePolyline6 } from "../lib/router";

/**
 * Test-only Valhalla replies derived from a saved real record: the reply is kept as Valhalla sent it and only the
 * leg's shape is edited, so every derived fixture names the record it came from and the edit made to it.
 */

function encodeValue(v: number): string {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let out = "";
  while (n >= 0x20) {
    out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>>= 5;
  }
  return out + String.fromCharCode(n + 63);
}

export function encodePolyline6(line: readonly Point[]): string {
  let lat = 0;
  let lon = 0;
  let out = "";
  for (const p of line) {
    const la = Math.round(p.lat * 1e6);
    const lo = Math.round(p.lon * 1e6);
    out += encodeValue(la - lat) + encodeValue(lo - lon);
    lat = la;
    lon = lo;
  }
  return out;
}

const between = (a: Point, b: Point, t: number): Point => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });

/** The line with its last `metres` (measured along it) cut off, ending at the exact cut point. */
export function cutEnd(line: readonly Point[], metres: number): Point[] {
  let left = metres;
  for (let i = line.length - 1; i > 0; i--) {
    const seg = distanceM(line[i - 1], line[i]);
    if (seg >= left) return [...line.slice(0, i), between(line[i], line[i - 1], left / seg)];
    left -= seg;
  }
  throw new Error("line shorter than the cut");
}

export function cutStart(line: readonly Point[], metres: number): Point[] {
  return cutEnd([...line].reverse(), metres).reverse();
}

/** The saved reply with its leg's shape replaced by `edit` of the saved shape. */
export function derivedReply(savedJson: string, edit: (line: Point[]) => Point[]): string {
  const body = JSON.parse(savedJson);
  body.trip.legs[0].shape = encodePolyline6(edit(decodePolyline6(body.trip.legs[0].shape)));
  return JSON.stringify(body);
}
