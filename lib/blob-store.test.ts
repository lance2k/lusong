import { describe, expect, it } from "vitest";
import { blobStoreFromEnv, MemoryBlobStore, VercelBlobStore } from "./blob-store";

describe("blobStoreFromEnv", () => {
  it("returns no store while BLOB_READ_WRITE_TOKEN is unset or empty, so photos stay hidden", () => {
    expect(blobStoreFromEnv({})).toBeNull();
    expect(blobStoreFromEnv({ BLOB_READ_WRITE_TOKEN: "" })).toBeNull();
  });

  it("returns the Vercel Blob store once the token is set", () => {
    expect(blobStoreFromEnv({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test_token" })).toBeInstanceOf(VercelBlobStore);
  });
});

describe("MemoryBlobStore", () => {
  it("gives each photo its own URL and hands back the bytes it was given", async () => {
    const store = new MemoryBlobStore();
    const first = new Uint8Array([1, 2, 3]);
    const a = await store.put(first);
    const b = await store.put(new Uint8Array([4]));
    expect(a).not.toBe(b);
    first[0] = 9;
    expect(store.get(a)).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.get(b)).toEqual(new Uint8Array([4]));
  });

  it("forgets a deleted photo", async () => {
    const store = new MemoryBlobStore();
    const url = await store.put(new Uint8Array([1]));
    await store.delete(url);
    expect(store.get(url)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("refuses every put when told to fail, as a store outage would", async () => {
    const store = new MemoryBlobStore({ failPuts: true });
    await expect(store.put(new Uint8Array([1]))).rejects.toThrow();
    expect(store.size).toBe(0);
  });
});
