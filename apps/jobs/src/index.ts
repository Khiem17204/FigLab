import { createHash } from "node:crypto";
import type { InMemoryFigLabRepository } from "@figlab/database";
import type { ObjectStore } from "@figlab/storage";
import sharp, { type Metadata } from "sharp";

const MAX_IMAGE_PIXELS = 100_000_000;
export async function verifyAsset(
  repository: InMemoryFigLabRepository,
  store: ObjectStore,
  assetId: string,
): Promise<void> {
  const asset = await repository.getAsset(assetId);
  try {
    const bytes = await streamBytes(await store.read(asset.storageKey));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== asset.checksumSha256)
      return reject(repository, assetId, "SHA-256 checksum mismatch");
    const metadata = await sharp(bytes, { animated: false, pages: 1 }).metadata();
    if (!metadata.format || !matchesMime(asset.mimeType, metadata.format))
      return reject(repository, assetId, "Image signature does not match declared MIME type");
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS)
      return reject(repository, assetId, "Image exceeds the 100M-pixel limit");
    const bitDepth = metadata.depth === "ushort" ? 16 : metadata.depth === "uchar" ? 8 : undefined;
    const channelCount = metadata.channels;
    if (!bitDepth || (channelCount !== 1 && channelCount !== 3 && channelCount !== 4))
      return reject(repository, assetId, "Unsupported image sample format");
    if (
      metadata.format === "tiff" &&
      (!isSupportedTiff(metadata, bitDepth, channelCount) || metadata.pages !== 1)
    )
      return reject(repository, assetId, "Unsupported TIFF layout");
    await repository.updateAsset(assetId, {
      status: "ready",
      widthPx: metadata.width,
      heightPx: metadata.height,
      bitDepth,
      channelCount,
      metadata: { format: metadata.format, space: metadata.space, density: metadata.density },
    });
  } catch (error) {
    await reject(
      repository,
      assetId,
      error instanceof Error ? `Verification failed: ${error.message}` : "Verification failed",
    );
  }
}
export async function deleteProject(
  repository: InMemoryFigLabRepository,
  store: ObjectStore,
  projectId: string,
): Promise<void> {
  for (const asset of await repository.listProjectAssets(projectId))
    await store.delete(asset.storageKey);
  await repository.deleteProjectData(projectId);
}
async function streamBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const hashChunks: Uint8Array[] = [];
  for await (const chunk of stream) hashChunks.push(chunk);
  const length = hashChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of hashChunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function reject(
  repository: InMemoryFigLabRepository,
  assetId: string,
  reason: string,
): Promise<void> {
  await repository.updateAsset(assetId, { status: "rejected", rejectionReason: reason });
}
function matchesMime(mimeType: string, format: string): boolean {
  return (
    (mimeType === "image/png" && format === "png") ||
    (mimeType === "image/jpeg" && format === "jpeg") ||
    (mimeType === "image/tiff" && format === "tiff")
  );
}
function isSupportedTiff(metadata: Metadata, bitDepth: 8 | 16, channels: 1 | 3 | 4): boolean {
  return (
    metadata.format === "tiff" &&
    (bitDepth === 8 || bitDepth === 16) &&
    (channels === 1 || channels === 3)
  );
}
