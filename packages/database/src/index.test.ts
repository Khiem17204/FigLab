import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { InMemoryFigLabRepository, PostgresFigLabRepository } from "./index.js";
import { workspaceMembers } from "./schema.js";

describe("InMemoryFigLabRepository", () => {
  it("bootstraps the configured single-user email", async () => {
    const repository = new InMemoryFigLabRepository();

    const principal = await repository.bootstrapSingleUser("scientist@example.test");

    expect(principal.email).toBe("scientist@example.test");
  });

  it("bootstraps one stable owner and preserves a newer document when a stale save arrives", async () => {
    const repository = new InMemoryFigLabRepository();
    const first = await repository.bootstrapSingleUser();
    const second = await repository.bootstrapSingleUser();
    expect(second).toEqual(first);
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.workspaceId).toMatch(/^[0-9a-f-]{36}$/);

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

  it("derives granular document audit events from object changes", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Experiment");
    const initial = await repository.getDocument(project.id);
    const artboardId = (initial.document as { artboards: { id: string }[] }).artboards[0]?.id ?? "";
    const original = {
      id: "view-1",
      type: "image-view",
      artboardId,
      transform: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 80, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      view: {
        sourceAssetId: "asset-1",
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
      },
    };
    const withObject = { ...(initial.document as object), objects: [original] };
    await repository.saveDocument(project.id, 0, withObject);
    const changed = structuredClone(withObject) as { objects: (typeof original)[] };
    changed.objects[0] = {
      ...original,
      transform: { ...original.transform, xPt: 30 },
      view: {
        ...original.view,
        viewport: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
        display: { ...original.view.display, brightness: 0.25 },
      },
    };
    await repository.saveDocument(project.id, 1, changed);
    await repository.saveDocument(project.id, 2, {
      ...(initial.document as object),
      objects: [],
    });

    const granular = (await repository.listAuditEvents(project.id))
      .filter((event) => event.action !== "PROJECT_CREATED" && event.action !== "DOCUMENT_UPDATED")
      .map(({ action, details }) => ({ action, details }));
    expect(granular).toEqual([
      {
        action: "CROP_CREATED",
        details: { objectId: "view-1", viewport: original.view.viewport },
      },
      {
        action: "CROP_CHANGED",
        details: {
          objectId: "view-1",
          before: original.view.viewport,
          after: changed.objects[0]?.view.viewport,
        },
      },
      {
        action: "DISPLAY_CHANGED",
        details: {
          objectId: "view-1",
          before: original.view.display,
          after: changed.objects[0]?.view.display,
        },
      },
      {
        action: "OBJECT_TRANSFORMED",
        details: {
          objectId: "view-1",
          before: original.transform,
          after: changed.objects[0]?.transform,
        },
      },
      { action: "OBJECT_REMOVED", details: { objectId: "view-1" } },
    ]);
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

  it("exposes a PostgreSQL repository for durable production persistence", () => {
    expect(PostgresFigLabRepository).toBeTypeOf("function");
  });

  it("defines one membership per workspace/user pair in Drizzle", () => {
    const config = getTableConfig(workspaceMembers);
    expect(config.uniqueConstraints.some((constraint) => constraint.columns.length === 2)).toBe(
      true,
    );
  });
});

describe("InMemoryFigLabRepository.ensureAuthUser", () => {
  it("keeps one workspace per authenticated user across sign-ins", async () => {
    const repository = new InMemoryFigLabRepository();
    const id = "6f0d2b8e-1c55-4e7f-9a7c-0c1b2d3e4f50";
    const first = await repository.ensureAuthUser({ id, email: "a@example.test" });
    const again = await repository.ensureAuthUser({ id, email: "a@example.test" });
    const other = await repository.ensureAuthUser({
      id: "8a2c4e6f-3b1d-4c5e-8f7a-1b2c3d4e5f60",
      email: "b@example.test",
    });
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(other.workspaceId).not.toBe(first.workspaceId);
  });
});
