import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPgPool, createPostgresRepository, type FigLabRepository } from "@figlab/database";
import { type TiffDescription, verifyTiff } from "@figlab/image-processing";
import { createObjectStoreFromEnv, type ObjectStore } from "@figlab/storage";
import { type Runner, run, runMigrations, runOnce, type TaskList } from "graphile-worker";
import sharp from "sharp";

const DEFAULT_MAX_IMAGE_PIXELS = 100_000_000;

export async function verifyAsset(
  repository: FigLabRepository,
  store: ObjectStore,
  assetId: string,
  maxImagePixels = DEFAULT_MAX_IMAGE_PIXELS,
): Promise<void> {
  const asset = await repository.getAsset(assetId);
  const bytes = await streamBytes(await store.read(asset.storageKey));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== asset.checksumSha256)
    return reject(repository, assetId, "SHA-256 checksum mismatch");

  try {
    if (asset.mimeType === "image/tiff") {
      const description = await decodeTiffAuthoritatively(bytes);
      if (description.widthPx * description.heightPx > maxImagePixels)
        return reject(repository, assetId, pixelLimitMessage(maxImagePixels));
      await repository.updateAsset(assetId, {
        status: "ready",
        widthPx: description.widthPx,
        heightPx: description.heightPx,
        bitDepth: description.bitDepth,
        channelCount: description.channels,
        metadata: {
          format: "tiff",
          planes: description.planes,
          planeLabels: description.planeLabels,
          ome: description.ome,
          tiled: description.tiled,
          bigTiff: description.bigTiff,
          ...(description.calibration ? { calibration: description.calibration } : {}),
        },
      });
      return;
    }
    const metadata = await sharp(bytes, { animated: false, pages: 1 }).metadata();
    if (!metadata.format || !matchesMime(asset.mimeType, metadata.format))
      return reject(repository, assetId, "Image signature does not match declared MIME type");
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxImagePixels)
      return reject(repository, assetId, pixelLimitMessage(maxImagePixels));
    const bitDepth = metadata.depth === "ushort" ? 16 : metadata.depth === "uchar" ? 8 : undefined;
    const channelCount = metadata.channels;
    if (!bitDepth || (channelCount !== 1 && channelCount !== 3 && channelCount !== 4))
      return reject(repository, assetId, "Unsupported image sample format");
    await repository.updateAsset(assetId, {
      status: "ready",
      widthPx: metadata.width,
      heightPx: metadata.height,
      bitDepth,
      channelCount,
      metadata: { format: metadata.format, space: metadata.space, density: metadata.density },
    });
  } catch (error) {
    await reject(repository, assetId, error instanceof Error ? error.message : "Unsupported image");
  }
}

export async function deleteProject(
  repository: FigLabRepository,
  store: ObjectStore,
  projectId: string,
): Promise<void> {
  for (const asset of await repository.listProjectAssets(projectId))
    await store.delete(asset.storageKey);
  await repository.deleteProjectData(projectId);
}

export function createTaskList(
  repository: FigLabRepository,
  store: ObjectStore,
  maxImagePixels = DEFAULT_MAX_IMAGE_PIXELS,
): TaskList {
  return {
    verify_asset: async (payload) => {
      const assetId = requiredPayloadId(payload, "assetId");
      await verifyAsset(repository, store, assetId, maxImagePixels);
    },
    delete_project: async (payload) => {
      const projectId = requiredPayloadId(payload, "projectId");
      await deleteProject(repository, store, projectId);
    },
  };
}

export async function startJobsFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Runner> {
  const databaseUrl = required(environment, "DATABASE_URL");
  const caCert = environment.DATABASE_CA_CERT;
  const { repository, close } = createPostgresRepository(databaseUrl, caCert ? { caCert } : {});
  const pgPool = createPgPool(databaseUrl, caCert ? { caCert } : {});
  const runner = await run(
    { pgPool, concurrency: Number(environment.JOB_CONCURRENCY ?? 2) },
    taskListFromEnv(repository, environment),
  );
  runner.events.once("stop", () => {
    void close();
    void pgPool.end();
  });
  return runner;
}

/**
 * Runs every job that is due now, then returns. Serverless hosts call this from a triggered
 * background function and a periodic sweep instead of keeping a worker process alive; failed
 * jobs keep Graphile's retry schedule and are picked up by a later drain.
 */
export async function drainJobsOnce(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = required(environment, "DATABASE_URL");
  const caCert = environment.DATABASE_CA_CERT;
  const pool = { maxConnections: 2, ...(caCert ? { caCert } : {}) };
  const { repository, close } = createPostgresRepository(databaseUrl, pool);
  const pgPool = createPgPool(databaseUrl, pool);
  try {
    await runOnce(
      { pgPool, concurrency: Number(environment.JOB_CONCURRENCY ?? 2), noHandleSignals: true },
      taskListFromEnv(repository, environment),
    );
  } finally {
    await Promise.all([close(), pgPool.end()]);
  }
}

/** Installs or upgrades Graphile Worker's own schema. */
export async function migrateJobsSchema(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const caCert = environment.DATABASE_CA_CERT;
  const pgPool = createPgPool(required(environment, "DATABASE_URL"), caCert ? { caCert } : {});
  try {
    await runMigrations({ pgPool });
  } finally {
    await pgPool.end();
  }
}

function taskListFromEnv(repository: FigLabRepository, environment: NodeJS.ProcessEnv): TaskList {
  return createTaskList(
    repository,
    createObjectStoreFromEnv(environment),
    configuredPositiveInteger(
      environment.MAX_IMAGE_PIXELS,
      DEFAULT_MAX_IMAGE_PIXELS,
      "MAX_IMAGE_PIXELS",
    ),
  );
}

/** Decodes every page of the TIFF, so only fully readable originals become editable. */
async function decodeTiffAuthoritatively(bytes: Uint8Array): Promise<TiffDescription> {
  const exact = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return verifyTiff(exact);
}

async function streamBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function reject(
  repository: FigLabRepository,
  assetId: string,
  reason: string,
): Promise<void> {
  await repository.updateAsset(assetId, { status: "rejected", rejectionReason: reason });
}

function matchesMime(mimeType: string, format: string): boolean {
  return (
    (mimeType === "image/png" && format === "png") ||
    (mimeType === "image/jpeg" && format === "jpeg")
  );
}

function requiredPayloadId(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null || !(key in payload))
    throw new Error(`Job payload requires ${key}`);
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Job payload requires ${key}`);
  return value;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pixelLimitMessage(maxImagePixels: number): string {
  return `Image exceeds the configured ${maxImagePixels}-pixel limit`;
}

function configuredPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startJobsFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
