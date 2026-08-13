import { createHash } from "node:crypto";
import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { deleteProject, verifyAsset } from "./index.js";

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
});
