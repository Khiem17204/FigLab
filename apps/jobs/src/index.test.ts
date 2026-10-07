import { createHash } from "node:crypto";
import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createTaskList, deleteProject, verifyAsset } from "./index.js";

describe("verifyAsset", () => {
  it("rejects a streamed object whose independently computed SHA-256 differs from its reservation", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const store = new FakeObjectStore();
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "image.png",
      mimeType: "image/png",
      contentLength: 3,
      checksumSha256: "0".repeat(64),
      storageKey: "object",
    });
    await store.putForTest("object", new Uint8Array([1, 2, 3]), "image/png");
    await verifyAsset(repository, store, upload.assetId);
    expect((await repository.getAsset(upload.assetId)).rejectionReason).toBe(
      "SHA-256 checksum mismatch",
    );
  });

  it("marks an authoritative PNG ready and deletion removes its immutable object", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const store = new FakeObjectStore();
    const bytes = new Uint8Array(
      await sharp({ create: { width: 2, height: 3, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer(),
    );
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "image.png",
      mimeType: "image/png",
      contentLength: bytes.byteLength,
      checksumSha256,
      storageKey: "object",
    });
    await store.putForTest("object", bytes, "image/png");
    await verifyAsset(repository, store, upload.assetId);
    expect(await repository.getAsset(upload.assetId)).toMatchObject({
      status: "ready",
      widthPx: 2,
      heightPx: 3,
      channelCount: 3,
    });
    await repository.markProjectDeleting(project.id);
    await deleteProject(repository, store, project.id);
    expect(await store.stat("object")).toBeUndefined();
  });

  it("rejects images over the configured decoded-pixel limit", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const store = new FakeObjectStore();
    const bytes = new Uint8Array(
      await sharp({ create: { width: 2, height: 3, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer(),
    );
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "image.png",
      mimeType: "image/png",
      contentLength: bytes.byteLength,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      storageKey: "limited-object",
    });
    await store.putForTest("limited-object", bytes, "image/png");

    await verifyAsset(repository, store, upload.assetId, 5);

    expect(await repository.getAsset(upload.assetId)).toMatchObject({
      status: "rejected",
      rejectionReason: "Image exceeds the configured 5-pixel limit",
    });
  });

  it("routes durable Graphile jobs to verification and deletion handlers", () => {
    const tasks = createTaskList(new InMemoryFigLabRepository(), new FakeObjectStore());
    expect(Object.keys(tasks).sort()).toEqual(["delete_project", "integrity_report", "verify_asset"]);
  });

  it("rejects an undecodable BigTIFF through the shared TIFF decoder", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const store = new FakeObjectStore();
    const bytes = new Uint8Array([0x49, 0x49, 43, 0, 8, 0, 0, 0]);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "image.tif",
      mimeType: "image/tiff",
      contentLength: bytes.byteLength,
      checksumSha256,
      storageKey: "bigtiff",
    });
    await store.putForTest("bigtiff", bytes, "image/tiff");
    await verifyAsset(repository, store, upload.assetId);
    // A truncated BigTIFF header cannot be decoded, so the original is rejected.
    expect(await repository.getAsset(upload.assetId)).toMatchObject({ status: "rejected" });
  });

  it("marks a supported real 16-bit grayscale TIFF ready from shared authoritative metadata", async () => {
    const bytes = grayscaleTiff({ width: 2, height: 1, bitDepth: 16, samples: [0, 32_768] });
    const { repository, store, assetId } = await uploadedTiff(bytes, "supported");
    await verifyAsset(repository, store, assetId);
    expect(await repository.getAsset(assetId)).toMatchObject({
      status: "ready",
      widthPx: 2,
      heightPx: 1,
      bitDepth: 16,
      channelCount: 1,
    });
  });

  it("applies the configured decoded-pixel limit to TIFF", async () => {
    const bytes = grayscaleTiff({ width: 2, height: 1, bitDepth: 8, samples: [0, 255] });
    const { repository, store, assetId } = await uploadedTiff(bytes, "limited");

    await verifyAsset(repository, store, assetId, 1);

    expect(await repository.getAsset(assetId)).toMatchObject({
      status: "rejected",
      rejectionReason: "Image exceeds the configured 1-pixel limit",
    });
  });

  it.each([
    ["signed samples", { compression: 1, sampleFormat: 2 }, /unsigned samples/],
    ["unsupported compression", { compression: 7, sampleFormat: 1 }, /compression/],
  ])("rejects TIFF %s through the shared decoder", async (_name, override, reason) => {
    const bytes = grayscaleTiff({ width: 1, height: 1, bitDepth: 8, samples: [1], ...override });
    const { repository, store, assetId } = await uploadedTiff(bytes, _name);
    await verifyAsset(repository, store, assetId);
    expect((await repository.getAsset(assetId)).rejectionReason).toMatch(reason);
  });

  it("accepts a tiled TIFF and records its layout", async () => {
    const bytes = new Uint8Array(
      await sharp({ create: { width: 32, height: 32, channels: 3, background: "#808080" } })
        .tiff({ tile: true, tileWidth: 16, tileHeight: 16, compression: "lzw" })
        .toBuffer(),
    );
    const { repository, store, assetId } = await uploadedTiff(bytes, "tiled");
    await verifyAsset(repository, store, assetId);
    expect(await repository.getAsset(assetId)).toMatchObject({
      status: "ready",
      widthPx: 32,
      heightPx: 32,
      channelCount: 3,
      metadata: { format: "tiff", planes: 1, tiled: true, bigTiff: false },
    });
  });
});

async function uploadedTiff(bytes: Uint8Array, suffix: string) {
  const repository = new InMemoryFigLabRepository();
  const principal = await repository.bootstrapSingleUser();
  const project = await repository.createProject(principal.workspaceId, "Cells");
  const store = new FakeObjectStore();
  const storageKey = `tiff-${suffix}`;
  const upload = await repository.createUpload({
    projectId: project.id,
    filename: `${suffix}.tif`,
    mimeType: "image/tiff",
    contentLength: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    storageKey,
  });
  await store.putForTest(storageKey, bytes, "image/tiff");
  return { repository, store, assetId: upload.assetId };
}

function grayscaleTiff(input: {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  samples: number[];
  compression?: number;
  sampleFormat?: number;
}): Uint8Array {
  const entries: Array<[number, number, number, number]> = [
    [256, 4, 1, input.width],
    [257, 4, 1, input.height],
    [258, 3, 1, input.bitDepth],
    [259, 3, 1, input.compression ?? 1],
    [262, 3, 1, 1],
    [273, 4, 1, 0],
    [277, 3, 1, 1],
    [278, 4, 1, input.height],
    [279, 4, 1, input.samples.length * (input.bitDepth / 8)],
    [339, 3, 1, input.sampleFormat ?? 1],
  ];
  const pixelOffset = 8 + 2 + entries.length * 12 + 4;
  entries[5] = [273, 4, 1, pixelOffset];
  const bytes = new Uint8Array(pixelOffset + input.samples.length * (input.bitDepth / 8));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4d4d);
  view.setUint16(2, 42);
  view.setUint32(4, 8);
  view.setUint16(8, entries.length);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12;
    view.setUint16(offset, tag);
    view.setUint16(offset + 2, type);
    view.setUint32(offset + 4, count);
    if (type === 3) view.setUint16(offset + 8, value);
    else view.setUint32(offset + 8, value);
  });
  input.samples.forEach((sample, index) => {
    if (input.bitDepth === 8) view.setUint8(pixelOffset + index, sample);
    else view.setUint16(pixelOffset + index * 2, sample);
  });
  return bytes;
}
