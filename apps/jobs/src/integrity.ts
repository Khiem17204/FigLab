import type { AssetRecord, FigLabRepository } from "@figlab/database";
import { migrateFigureDocument } from "@figlab/figure-schema";
import {
  type AssetFacts,
  buildIntegrityReport,
  documentSourceSizes,
  openTiffWindowSource,
  type RasterDescription,
  type RasterRegion,
  type RasterSourceResolver,
  type SourcePixelRect,
  type TiffWindowSource,
  tiffReadOptions,
} from "@figlab/image-processing";
import type { ObjectStore } from "@figlab/storage";
import sharp from "sharp";

type Decoded =
  | { kind: "tiff"; source: TiffWindowSource }
  | { kind: "raster"; region: RasterRegion };

/**
 * Reads verified originals from storage and decodes them the way the browser does (PNG as
 * RGBA, JPEG as RGB, TIFF through the shared windowed reader), so server reports measure the
 * same samples that figures are rendered from.
 */
export function createStoredOriginalResolver(
  store: ObjectStore,
  assets: ReadonlyMap<string, AssetRecord>,
  readBytes: (stream: AsyncIterable<Uint8Array>) => Promise<Uint8Array>,
): RasterSourceResolver {
  const decoded = new Map<string, Promise<Decoded>>();
  const decode = (assetId: string): Promise<Decoded> => {
    let pending = decoded.get(assetId);
    if (!pending) {
      pending = (async () => {
        const asset = assets.get(assetId);
        if (asset?.status !== "ready" || !asset)
          throw new Error(`Original ${assetId} is not ready`);
        const bytes = await readBytes(await store.read(asset.storageKey));
        if (asset.mimeType === "image/tiff") {
          const exact = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          return { kind: "tiff", source: await openTiffWindowSource(exact) };
        }
        const pipeline = sharp(bytes, { animated: false, pages: 1 }).toColourspace("srgb");
        const { data, info } = await (asset.mimeType === "image/png"
          ? pipeline.ensureAlpha()
          : pipeline.removeAlpha()
        )
          .raw()
          .toBuffer({ resolveWithObject: true });
        return {
          kind: "raster",
          region: {
            data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            sourceRect: { x: 0, y: 0, width: info.width, height: info.height },
            widthPx: info.width,
            heightPx: info.height,
            bitDepth: 8,
            channels: info.channels as 3 | 4,
            pyramidLevel: 0,
          },
        };
      })();
      decoded.set(assetId, pending);
    }
    return pending;
  };
  return {
    async describe(assetId): Promise<RasterDescription> {
      const value = await decode(assetId);
      if (value.kind === "tiff") return value.source.description;
      const { widthPx, heightPx, bitDepth, channels } = value.region;
      return { widthPx, heightPx, bitDepth, channels };
    },
    async getRegion(assetId, rect, _level = 0, plane = 0): Promise<RasterRegion> {
      const value = await decode(assetId);
      if (value.kind === "tiff") {
        const description = value.source.description;
        return {
          data: await value.source.readRasters(tiffReadOptions(rect), plane),
          sourceRect: rect,
          widthPx: rect.width,
          heightPx: rect.height,
          bitDepth: description.bitDepth,
          channels: description.channels,
          pyramidLevel: 0,
        };
      }
      if (plane !== 0) throw new Error("Only TIFF originals have more than one page");
      return cropRegion(value.region, rect);
    },
  };
}

function cropRegion(source: RasterRegion, rect: SourcePixelRect): RasterRegion {
  const data = new Uint8Array(rect.width * rect.height * source.channels);
  for (let row = 0; row < rect.height; row += 1) {
    const start = ((rect.y + row) * source.widthPx + rect.x) * source.channels;
    data.set(
      source.data.subarray(start, start + rect.width * source.channels),
      row * rect.width * source.channels,
    );
  }
  return { ...source, data, sourceRect: rect, widthPx: rect.width, heightPx: rect.height };
}

/** The integrity_report task: computes a pending report from original pixels and stores it. */
export async function computeIntegrityReport(
  repository: FigLabRepository,
  store: ObjectStore,
  reportId: string,
  readBytes: (stream: AsyncIterable<Uint8Array>) => Promise<Uint8Array>,
): Promise<void> {
  const record = await repository.getIntegrityReport(reportId);
  if (record.status !== "pending") return;
  try {
    const project = await repository.getProject(record.projectId);
    const stored = await repository.getDocumentAtRevision(record.projectId, record.revision);
    const document = migrateFigureDocument(stored.document);
    const assetRecords = await repository.listProjectAssets(record.projectId);
    const assets = new Map(assetRecords.map((asset) => [asset.id, asset]));
    const resolver = createStoredOriginalResolver(store, assets, readBytes);
    const facts = new Map<string, AssetFacts>(
      assetRecords.map((asset) => [
        asset.id,
        {
          filename: asset.filename,
          checksumSha256: asset.checksumSha256,
          ...(Array.isArray(asset.metadata.planeLabels)
            ? { planeLabels: asset.metadata.planeLabels as string[] }
            : {}),
        },
      ]),
    );
    const report = await buildIntegrityReport({
      document,
      revision: record.revision,
      projectName: project.name,
      resolver,
      sizes: documentSourceSizes(document, resolver),
      assets: facts,
    });
    await repository.completeIntegrityReport(reportId, { report });
  } catch (error) {
    await repository.completeIntegrityReport(reportId, {
      error: error instanceof Error ? error.message : "The report could not be computed",
    });
  }
}
