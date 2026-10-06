import { StorageClient } from "@supabase/storage-js";
import type { ObjectStat, ObjectStore, SignedObjectUrl } from "./index.js";

export interface SupabaseObjectStoreOptions {
  /** Project URL, for example `https://<ref>.supabase.co`. */
  supabaseUrl: string;
  /** Server-only secret (or legacy service-role) key. Never send it to the browser. */
  secretKey: string;
  bucket: string;
  fetch?: typeof fetch;
}

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/**
 * Supabase Storage adapter. Uploads use Supabase's own signed upload URLs with `x-upsert: false`,
 * which refuse to overwrite an existing object: the S3 protocol endpoint does not honour
 * `If-None-Match` on PUT, so it cannot keep originals immutable.
 */
export class SupabaseObjectStore implements ObjectStore {
  private readonly client: StorageClient;
  constructor(private readonly options: SupabaseObjectStoreOptions) {
    const base = options.supabaseUrl.replace(/\/+$/, "");
    this.client = new StorageClient(
      `${base}/storage/v1`,
      { apikey: options.secretKey, Authorization: `Bearer ${options.secretKey}` },
      options.fetch,
    );
  }
  private get bucket() {
    return this.client.from(this.options.bucket);
  }
  async presignPut(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds?: number;
  }): Promise<SignedObjectUrl> {
    // Supabase fixes signed upload URLs at two hours; the upload session's own expiry, checked
    // at completion, remains the effective limit.
    const { data, error } = await this.bucket.createSignedUploadUrl(input.key, { upsert: false });
    if (error) throw error;
    return {
      url: data.signedUrl,
      method: "PUT",
      headers: { "content-type": input.contentType, "x-upsert": "false" },
      expiresAt: expiry(input.expiresInSeconds ?? 600),
    };
  }
  async presignDownload(key: string, expiresInSeconds = 600): Promise<SignedObjectUrl> {
    const { data, error } = await this.bucket.createSignedUrl(key, expiresInSeconds);
    if (error) throw error;
    return { url: data.signedUrl, method: "GET", headers: {}, expiresAt: expiry(expiresInSeconds) };
  }
  async stat(key: string): Promise<ObjectStat | undefined> {
    const { data, error } = await this.bucket.info(key);
    if (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (typeof data.size !== "number") return undefined;
    return {
      contentLength: data.size,
      contentType: data.contentType ?? "application/octet-stream",
    };
  }
  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    const { data, error } = await this.bucket.download(key);
    if (error) throw error;
    const bytes = new Uint8Array(await data.arrayBuffer());
    return (async function* () {
      yield bytes;
    })();
  }
  async delete(key: string): Promise<void> {
    const { error } = await this.bucket.remove([key]);
    if (error && !isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const status = String(record.statusCode ?? record.status ?? "");
  return status === "404" || /not.?found/i.test(String(record.message ?? ""));
}
