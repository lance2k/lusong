import { randomUUID } from "node:crypto";
import { del, put } from "@vercel/blob";

/** Where blurred report photos live. Only ever handed a blurred JPEG; the original photo is never stored. */
export interface BlobStore {
  /** Stores the JPEG under a new random name and returns the URL a page can show it from. */
  put(jpeg: Uint8Array, signal?: AbortSignal): Promise<string>;
  delete(url: string): Promise<void>;
}

/** In-process store for tests and local runs. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  constructor(private readonly opts: { failPuts?: boolean } = {}) {}

  async put(jpeg: Uint8Array): Promise<string> {
    if (this.opts.failPuts) throw new Error("memory blob store refused the put");
    const url = `https://blob.test/report-photos/${randomUUID()}.jpg`;
    this.blobs.set(url, jpeg.slice());
    return url;
  }

  async delete(url: string): Promise<void> {
    this.blobs.delete(url);
  }

  get(url: string): Uint8Array | undefined {
    return this.blobs.get(url);
  }

  get size(): number {
    return this.blobs.size;
  }
}

/**
 * Vercel Blob through @vercel/blob 2.3.0, typed from its index.d.ts; no store exists yet and no call has been made.
 * UNVERIFIED: that the owner's store accepts `access: "public"` (the SDK also offers private stores, whose blobs need
 * a token to read, which a pin's <img> can't send); a refusal fails the put, and the report then shows no photo.
 * UNVERIFIED: that the returned `url` is servable at once, with the content type set here.
 */
export class VercelBlobStore implements BlobStore {
  constructor(private readonly token: string) {}

  async put(jpeg: Uint8Array, signal?: AbortSignal): Promise<string> {
    const { url } = await put(`report-photos/${randomUUID()}.jpg`, Buffer.from(jpeg), {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: false,
      token: this.token,
      abortSignal: signal,
    });
    return url;
  }

  async delete(url: string): Promise<void> {
    await del(url, { token: this.token });
  }
}

/** The blurred-photo store, or null until the owner creates one and BLOB_READ_WRITE_TOKEN is set: photos stay hidden. */
export function blobStoreFromEnv(env: Record<string, string | undefined> = process.env): BlobStore | null {
  const token = env.BLOB_READ_WRITE_TOKEN;
  return token ? new VercelBlobStore(token) : null;
}
