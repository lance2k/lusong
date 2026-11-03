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

/** The feed as saved 2026-11-03 21:20 PHT: 51 entries, the newest Davao Region's GFA #3 (Final) of 2026-10-31. */
export const FEED_2026_11_03 = fixture("feed-2026-11-03.xml");

const CAP_URL = (path: string) => `https://publicalert.pagasa.dost.gov.ph/output/${path}.cap`;

/** Records saved 2026-11-03 for the nationwide snapshot (plan S1 §2), by the URL the feed links them at. */
export const DAVAO_GFA1_ALERT = CAP_URL("gfa/7b675765-3a4d-42b0-944c-2605f7ed77d8");
export const DAVAO_GFA1_UPDATE = CAP_URL("gfa/07812736-4c94-43c1-8e5a-81b5af762876");
export const DAVAO_GFA2 = CAP_URL("gfa/16fce3a2-607c-4033-9493-fca8e0c9945c");
export const DAVAO_GFA3_FINAL = CAP_URL("gfa/8f31a2e1-0276-450c-b711-053a4441b709");
export const CAGAYAN_GFA4 = CAP_URL("gfa/fef26327-8053-41e5-a433-8e24347d148f");
export const CAGAYAN_GFA4_CANCEL = CAP_URL("gfa/0b388184-2411-4eed-8933-a3b64b259b02");
export const CAGAYAN_GFA4_REISSUED = CAP_URL("gfa/855536fb-a3b5-4721-9015-92cc1dd493dc");
export const CAGAYAN_GFA6_BATANES = CAP_URL("gfa/550ec3d6-d549-463e-a7d2-133da7dad7c6");
export const ROSAL_SIGNAL1_BATANES = CAP_URL("wcp/21b29a06-e297-47bd-a79d-20826e724a2c");
export const ROSAL_SIGNAL2_BATANES = CAP_URL("wcp/b6cb7676-9a0a-4072-8d5f-e554de03422d");
export const ROSAL_ALERT_PAR = CAP_URL("acp/a431156f-570f-403a-8391-b384d23fc11c");

export const SAVED_2026_11_03: Record<string, string> = {
  [DAVAO_GFA1_ALERT]: fixture("davao-gfa1-alert-2026-10-30T2106.cap"),
  [DAVAO_GFA1_UPDATE]: fixture("davao-gfa1-update-2026-10-30T2111.cap"),
  [DAVAO_GFA2]: fixture("davao-gfa2-2026-10-31T0515.cap"),
  [DAVAO_GFA3_FINAL]: fixture("davao-gfa3-final-2026-10-31T1702.cap"),
  [CAGAYAN_GFA4]: fixture("cagayan-valley-gfa4-2026-10-23T0533.cap"),
  [CAGAYAN_GFA4_CANCEL]: fixture("cagayan-valley-gfa4-cancel-2026-10-23T0534.cap"),
  [CAGAYAN_GFA4_REISSUED]: fixture("cagayan-valley-gfa4-reissued-2026-10-23T0539.cap"),
  [CAGAYAN_GFA6_BATANES]: fixture("cagayan-valley-gfa6-batanes-2026-10-24T0519.cap"),
  [ROSAL_SIGNAL1_BATANES]: fixture("rosal-tcws1-batanes-2026-10-24T0450.cap"),
  [ROSAL_SIGNAL2_BATANES]: fixture("rosal-tcws2-batanes-2026-10-23T1652.cap"),
  [ROSAL_ALERT_PAR]: fixture("rosal-tc-alert-par-2026-10-24T1052.cap"),
};

/** Every saved record, either save. */
export const ALL_SAVED: Record<string, string> = { ...SAVED, ...SAVED_2026_11_03 };

/** The feed entry for each link, from whichever saved feed lists it. */
function entryFor(link: string): string {
  for (const feed of [FEED_2026_11_03, FEED]) {
    const entry = [...feed.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((m) => m[0]).find((e) => e.includes(`href="${link}"`));
    if (entry) return entry;
  }
  throw new Error(`no saved feed lists ${link}`);
}

/**
 * A feed listing only these records, with their real entries (title, id, updated), as PAGASA would have listed them had
 * it sent no others. `edit` changes an entry's text, e.g. its updated time.
 */
export function feedOf(links: readonly string[], edit: (entry: string, link: string) => string = (e) => e): string {
  const head = FEED.slice(0, FEED.indexOf("<entry>"));
  return `${head}${links.map((l) => edit(entryFor(l), l)).join("\n")}\n</feed>\n`;
}

/** The 2026-10-29 feed listing only the records saved from it, so a whole-feed snapshot of it can be complete. */
export const SAVED_FEED = feedOf(Object.keys(SAVED));
