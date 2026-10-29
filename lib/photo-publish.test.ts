import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "./blob-store";
import { blurMasked } from "./blur";
import { readExifTimeText } from "./exif";
import { publishPhoto, type PhotoInput } from "./photo-publish";
import { outputTextOf, parseSamText, type PlacedRaster } from "./sam";

const samText = (name: string) => outputTextOf(JSON.parse(readFileSync(`test/fixtures/sam/${name}.json`, "utf8")));
/** A SAM call whose reply came back with the Responses API status "completed". */
const done = (text: string) => ({ ok: true, text, status: "completed" }) as const;
/** SAM 3.1's recorded reply for `person` on quiapo-1: 7 masks. */
const personText = samText("quiapo-1__person");
/** A recorded reply with 12 masks, standing in for plates; the fake blur below never looks at the pixels. */
const twelveMasks = samText("shah-alam-2021__car");
/** A plate reply whose one object has a canonical 2×2 one_bit mask with no pixel set: it parses with no diagnostic. */
const emptyMaskPlate = "<0f>0<|box;x1=100;y1=200;x2=101;y2=201;w=1280;h=960|><|mask;x=0;y=0;data=2,2,!!!!!&!!!!!|>\n";
/** The recorded person reply cut straight after its first complete object, before the comma that starts the next. */
const personsCutBetweenObjects = personText.slice(0, personText.indexOf("|>,") + 2);
const photo = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1-exif.jpg"));
const BLURRED = new Uint8Array([0xff, 0xd8, 0xb1, 0x0e, 0xff, 0xd9]);

function fakeBlur(result: "ok" | "throws" = "ok") {
  const seen: PlacedRaster[][] = [];
  const blur = async (_jpeg: Uint8Array, masks: readonly PlacedRaster[]) => {
    seen.push([...masks]);
    if (result === "throws") throw new Error("decode failed");
    return BLURRED;
  };
  return { blur, seen };
}

function input(overrides: Partial<PhotoInput> = {}): PhotoInput {
  return {
    jpeg: photo,
    persons: done(personText),
    plates: done(twelveMasks),
    store: new MemoryBlobStore(),
    blur: fakeBlur().blur,
    plateDetectionTrusted: true,
    ...overrides,
  };
}

describe("publishPhoto", () => {
  it("keeps every photo hidden while plate detection is untrusted, the default until the probe says otherwise", async () => {
    const store = new MemoryBlobStore();
    const { blur, seen } = fakeBlur();
    const untold = { jpeg: photo, persons: done(personText), plates: done(twelveMasks), store, blur } as const;
    expect(await publishPhoto(untold)).toEqual({ published: false, reason: "plate_detection_untrusted" });
    expect(seen).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("publishes the blurred photo once plate detection is trusted, with every person and plate mask and no cap", async () => {
    const store = new MemoryBlobStore();
    const { blur, seen } = fakeBlur();
    const outcome = await publishPhoto(input({ store, blur }));
    expect(outcome.published).toBe(true);
    // 7 people and 12 plate masks: more than the depth reader's 12-object selection, and none dropped.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(19);
    expect(store.size).toBe(1);
    expect(store.get((outcome as { url: string }).url)).toEqual(BLURRED);
  });

  it("publishes when SAM found no plate and no person, since an empty reply is a valid zero-match result", async () => {
    const { blur, seen } = fakeBlur();
    const outcome = await publishPhoto(input({ blur, persons: done(""), plates: done("") }));
    expect(outcome.published).toBe(true);
    expect(seen[0]).toHaveLength(0);
  });

  it.each([
    ["the person call failed", { persons: { ok: false } }, "person_segmentation_failed"],
    ["the plate call failed", { plates: { ok: false } }, "plate_segmentation_failed"],
    ["the person reply was cut off (3 of its 7 masks parse)", { persons: done(personText.slice(0, personText.length / 2)) }, "unreadable_masks"],
    ["the plate reply was cut off", { plates: done(twelveMasks.slice(0, twelveMasks.length / 2)) }, "unreadable_masks"],
    ["the person reply ends between two objects, so 1 of its 7 masks parses with no error", { persons: done(personsCutBetweenObjects) }, "unreadable_masks"],
    ["the plate reply is only a cut-off frame header", { plates: done("<0") }, "unreadable_masks"],
    ["the plate reply is prose instead of segmentation", { plates: done("I found no licence plates in this image.\n") }, "unreadable_masks"],
    ["the person reply carries a stray text line after its masks", { persons: done(`${personText}note: more people may be hidden\n`) }, "unreadable_masks"],
    ["Meta marked the person reply incomplete, though its text parses in full", { persons: { ok: true, text: personText, status: "incomplete" } }, "unreadable_masks"],
    ["Meta gave the plate reply no status at all", { plates: { ok: true, text: twelveMasks, status: null } }, "unreadable_masks"],
    ["there is no blob store yet", { store: null }, "no_store"],
  ] as const)("shows no photo when %s, and stores nothing", async (_case, overrides, reason) => {
    const { blur, seen } = fakeBlur();
    const store = new MemoryBlobStore();
    const given = input({ blur, store, ...overrides } as Partial<PhotoInput>);
    expect(await publishPhoto(given)).toEqual({ published: false, reason });
    expect(seen).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("shows no photo when a plate SAM found has a mask with no pixel set, and neither blurs nor stores", async () => {
    expect(parseSamText(emptyMaskPlate)).toHaveLength(1);
    const { blur, seen } = fakeBlur();
    const store = new MemoryBlobStore();
    expect(await publishPhoto(input({ blur, store, plates: done(emptyMaskPlate) }))).toEqual({ published: false, reason: "unreadable_masks" });
    expect(seen).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("shows no photo when the blur fails, and stores nothing", async () => {
    const store = new MemoryBlobStore();
    expect(await publishPhoto(input({ store, blur: fakeBlur("throws").blur }))).toEqual({ published: false, reason: "blur_failed" });
    expect(store.size).toBe(0);
  });

  it("shows no photo when the store refuses the blurred photo", async () => {
    expect(await publishPhoto(input({ store: new MemoryBlobStore({ failPuts: true }) }))).toEqual({ published: false, reason: "store_failed" });
  });
});

describe("publishPhoto with the real blur", () => {
  it("stores a JPEG in which every person SAM found is wiped, with no EXIF, and never the original", async () => {
    const store = new MemoryBlobStore();
    const outcome = await publishPhoto({ jpeg: photo, persons: done(personText), plates: done(""), store, blur: blurMasked, plateDetectionTrusted: true });
    expect(outcome.published).toBe(true);
    const stored = store.get((outcome as { url: string }).url)!;
    expect(Buffer.from(stored).equals(Buffer.from(photo))).toBe(false);
    expect(readExifTimeText(stored)).toBeNull();

    const greyOf = async (jpeg: Uint8Array) => (await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true })).data;
    const [before, after] = [await greyOf(photo), await greyOf(stored)];
    const people = parseSamText(personText);
    expect(people).toHaveLength(7);
    for (const { box } of people) {
      let changed = 0;
      let total = 0;
      for (let y = Math.floor(box.top); y < Math.ceil(box.bottom); y++) {
        for (let x = Math.floor(box.left); x < Math.ceil(box.right); x++) {
          total++;
          if (Math.abs(before[y * 1280 + x] - after[y * 1280 + x]) > 4) changed++;
        }
      }
      expect(changed / total, JSON.stringify(box)).toBeGreaterThan(0.3);
    }
  });
});
