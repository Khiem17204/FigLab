import { describe, expect, it } from "vitest";
import { InMemoryFigLabRepository } from "./index.js";

describe("InMemoryFigLabRepository", () => {
  it("bootstraps one stable owner and preserves a newer document when a stale save arrives", async () => {
    const repository = new InMemoryFigLabRepository();
    const first = await repository.bootstrapSingleUser();
    const second = await repository.bootstrapSingleUser();
    expect(second).toEqual(first);

    const project = await repository.createProject(first.workspaceId, "Experiment");
    const initial = await repository.getDocument(project.id);
    expect(initial.revision).toBe(0);
    const document = {
      schemaVersion: 1,
      artboards: [
        {
          id: "artboard-next",
          name: "Figure 1",
          widthPt: 612,
          heightPt: 792,
          backgroundHex: "#FFFFFF",
        },
      ],
      objects: [],
      groups: [],
      constraints: [],
      styles: [],
    };
    const saved = await repository.saveDocument(project.id, 0, document);
    expect(saved.kind).toBe("saved");
    const stale = await repository.saveDocument(project.id, 0, document);
    expect(stale).toEqual({ kind: "conflict", currentRevision: 1 });
    expect((await repository.getDocument(project.id)).revision).toBe(1);
  });

  it("creates exactly one asset record for an upload session", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Experiment");
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "image.png",
      mimeType: "image/png",
      contentLength: 12,
      checksumSha256: "a".repeat(64),
      storageKey: "immutable-key",
    });
    expect((await repository.getAsset(upload.assetId)).id).toBe(upload.assetId);
    await expect(
      repository.createAssetForUpload(upload.id, {
        filename: "again.png",
        mimeType: "image/png",
        checksumSha256: "b".repeat(64),
        storageKey: "other-key",
      }),
    ).rejects.toThrow("already has an asset");
  });
});
