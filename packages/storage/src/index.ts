import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SupabaseObjectStore } from "./supabase.js";

export interface SignedObjectUrl {
  url: string;
  method: "PUT" | "GET";
  headers: Record<string, string>;
  expiresAt: string;
}
export interface ObjectStat {
  contentLength: number;
  contentType: string;
}
export interface ObjectStore {
  presignPut(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds?: number;
  }): Promise<SignedObjectUrl>;
  presignDownload(key: string, expiresInSeconds?: number): Promise<SignedObjectUrl>;
  stat(key: string): Promise<ObjectStat | undefined>;
  read(key: string): Promise<AsyncIterable<Uint8Array>>;
  delete(key: string): Promise<void>;
}
const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
export class FakeObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async presignPut(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds?: number;
  }): Promise<SignedObjectUrl> {
    const seconds = input.expiresInSeconds ?? 600;
    return {
      url: `fake://private/${encodeURIComponent(input.key)}`,
      method: "PUT",
      headers: {
        "content-type": input.contentType,
        "if-none-match": "*",
      },
      expiresAt: expiry(seconds),
    };
  }
  async presignDownload(key: string, expiresInSeconds = 600): Promise<SignedObjectUrl> {
    return {
      url: `fake://private/${encodeURIComponent(key)}`,
      method: "GET",
      headers: {},
      expiresAt: expiry(expiresInSeconds),
    };
  }
  async stat(key: string): Promise<ObjectStat | undefined> {
    const object = this.objects.get(key);
    return object
      ? { contentLength: object.bytes.byteLength, contentType: object.contentType }
      : undefined;
  }
  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    const object = this.objects.get(key);
    if (!object) throw new Error("Object not found");
    return (async function* () {
      yield object.bytes;
    })();
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async putForTest(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }
}

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  internalEndpoint: string;
  publicEndpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}
export class S3ObjectStore implements ObjectStore {
  private readonly internal: S3Client;
  private readonly public: S3Client;
  constructor(private readonly options: S3ObjectStoreOptions) {
    const config = {
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: options.forcePathStyle ?? true,
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
    };
    this.internal = new S3Client({ ...config, endpoint: options.internalEndpoint });
    this.public = new S3Client({ ...config, endpoint: options.publicEndpoint });
  }
  async presignPut(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds?: number;
  }): Promise<SignedObjectUrl> {
    const seconds = input.expiresInSeconds ?? 600;
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.key,
      ContentType: input.contentType,
      IfNoneMatch: "*",
    });
    return {
      url: await getSignedUrl(this.public, command, { expiresIn: seconds }),
      method: "PUT",
      headers: {
        "content-type": input.contentType,
        "if-none-match": "*",
      },
      expiresAt: expiry(seconds),
    };
  }
  async presignDownload(key: string, expiresInSeconds = 600): Promise<SignedObjectUrl> {
    return {
      url: await getSignedUrl(
        this.public,
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      ),
      method: "GET",
      headers: {},
      expiresAt: expiry(expiresInSeconds),
    };
  }
  async stat(key: string): Promise<ObjectStat | undefined> {
    try {
      const result = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return {
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "$metadata" in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      )
        return undefined;
      throw error;
    }
  }
  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    const result = await this.internal.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    const body = result.Body;
    if (!body) throw new Error("Object body missing");
    return body as AsyncIterable<Uint8Array>;
  }
  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}

export { SupabaseObjectStore, type SupabaseObjectStoreOptions } from "./supabase.js";

/** Chooses the object store from `STORAGE_DRIVER` (`s3`, the default, or `supabase`). */
export function createObjectStoreFromEnv(environment: NodeJS.ProcessEnv): ObjectStore {
  const required = (name: string) => {
    const value = environment[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const driver = environment.STORAGE_DRIVER ?? "s3";
  if (driver === "supabase")
    return new SupabaseObjectStore({
      supabaseUrl: required("SUPABASE_URL"),
      secretKey: required("SUPABASE_SECRET_KEY"),
      bucket: required("OBJECT_STORE_BUCKET"),
    });
  if (driver !== "s3") throw new Error(`Unsupported STORAGE_DRIVER: ${driver}`);
  return new S3ObjectStore({
    bucket: required("OBJECT_STORE_BUCKET"),
    region: environment.OBJECT_STORE_REGION ?? "us-east-1",
    internalEndpoint: required("OBJECT_STORE_INTERNAL_ENDPOINT"),
    publicEndpoint: required("OBJECT_STORE_PUBLIC_ENDPOINT"),
    accessKeyId: required("OBJECT_STORE_ACCESS_KEY"),
    secretAccessKey: required("OBJECT_STORE_SECRET_KEY"),
    forcePathStyle: environment.OBJECT_STORE_FORCE_PATH_STYLE !== "false",
  });
}
