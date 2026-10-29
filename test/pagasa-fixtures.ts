import { readFileSync } from "node:fs";

const fixture = (name: string) => readFileSync(`test/fixtures/pagasa/${name}`, "utf8");

export const FEED = fixture("feed-2026-10-29.xml");
export const GFA_URL = (id: string) => `https://publicalert.pagasa.dost.gov.ph/output/gfa/${id}.cap`;

export const CV_GFA5 = GFA_URL("f1232c02-5d52-4786-90aa-46865ab991a4");
export const CV_GFA6_FINAL = GFA_URL("da3e8383-a066-49ed-99ef-8dd3fe93fb55");

/** Every real CAP record saved from PAGASA, by the URL the feed links it at. */
export const SAVED: Record<string, string> = {
  [CV_GFA5]: fixture("central-visayas-gfa-2026-10-25T1727.cap"),
  [CV_GFA6_FINAL]: fixture("central-visayas-gfa-final-2026-10-26T0522.cap"),
  [GFA_URL("bc03a078-80b2-4f2c-9bfd-b4ea606cdcdf")]: fixture("eastern-visayas-gfa-final-2026-10-26T0526.cap"),
  [GFA_URL("b83d7200-67eb-44a1-9d73-da74b3634b9f")]: fixture("western-visayas-gfa-final-2026-10-26T0520.cap"),
  [GFA_URL("e615201c-d5a9-49ed-880e-052a3a781da7")]: fixture("negros-island-gfa-final-2026-10-25T1729.cap"),
  [GFA_URL("f1ef7728-3f16-4522-843f-db5d951a5baa")]: fixture("cagayan-valley-gfa-final-2026-10-25T0522.cap"),
  [GFA_URL("9c46f1ee-c145-4f09-877b-c41b031ec7d1")]: fixture("barmm-gfa-final-2026-10-25T0515.cap"),
  [GFA_URL("4cd25719-0f85-43f8-8aa7-8eb83f23e565")]: fixture("ilocos-gfa-final-2026-10-23T0516.cap"),
  [GFA_URL("00bbef1f-9d73-438b-9e2a-26172d8688b8")]: fixture("car-gfa-final-2026-10-23T0514.cap"),
};

/** The newest record of each of the feed's eight regions: all Final, all-clear advisories. */
export const NEWEST_PER_REGION = Object.keys(SAVED).filter((url) => url !== CV_GFA5);

/**
 * Derived, not real: the Central Visayas record of 2026-10-25 17:27 PHT with only its expiry moved to 2026-10-28 05:27
 * PHT, standing for an advisory still active more than 24 h after it was sent.
 */
export const CV_GFA5_LONG = fixture("DERIVED-central-visayas-gfa-2026-10-25T1727-expires-moved-to-2026-10-28T0527.cap");

/** The feed with only the entries whose title passes `keep`, as PAGASA would list them had the others not been sent. */
export function feedWith(keep: (title: string) => boolean): string {
  return FEED.replace(/<entry>[\s\S]*?<\/entry>\s*/g, (e) => (keep(/<title>([^<]*)<\/title>/.exec(e)?.[1] ?? "") ? e : ""));
}

/** Edits of the saved active Cebu record, each taking away or garbling something its state depends on. */
export const CAP_EDITS: { name: string; edit: (cap: string) => string }[] = [
  { name: "status removed", edit: (c) => c.replace("<status>Actual</status>", "") },
  { name: "status not a CAP value", edit: (c) => c.replace("<status>Actual</status>", "<status>Actul</status>") },
  { name: "msgType removed", edit: (c) => c.replace("<msgType>Update</msgType>", "") },
  { name: "msgType not a CAP value", edit: (c) => c.replace("<msgType>Update</msgType>", "<msgType>Updte</msgType>") },
  { name: "identifier removed", edit: (c) => c.replace(/<identifier>[^<]*<\/identifier>/, "") },
  { name: "sent removed", edit: (c) => c.replace(/<sent>[^<]*<\/sent>/, "") },
  { name: "expires removed", edit: (c) => c.replace(/<expires>[^<]*<\/expires>/, "") },
  { name: "responseType not a CAP value", edit: (c) => c.replace("<responseType>Monitor</responseType>", "<responseType>Monitr</responseType>") },
  { name: "every area removed", edit: (c) => c.replace(/<area>[\s\S]*<\/area>/, "") },
  { name: "every areaDesc removed", edit: (c) => c.replace(/<areaDesc>[^<]*<\/areaDesc>/g, "") },
  { name: "an empty areaDesc", edit: (c) => c.replace("<areaDesc>Bohol</areaDesc>", "<areaDesc> </areaDesc>") },
  { name: "info removed", edit: (c) => c.replace(/<info>[\s\S]*<\/info>/, "") },
];
