import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import { describe, expect, it } from "vitest";
import { assertSingleUserConfiguration, bootstrapSingleUserFromEnv, buildApp } from "./index.js";

describe("buildApp", () => {
  it("publishes the project license in generated OpenAPI metadata", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    await app.ready();

    expect(app.swagger().info.license).toEqual({ name: "AGPL-3.0-only" });
    await app.close();
  });

  it("threads SINGLE_USER_EMAIL into single-user bootstrap", async () => {
    const repository = new InMemoryFigLabRepository();

    const principal = await bootstrapSingleUserFromEnv(repository, {
      SINGLE_USER_EMAIL: "scientist@example.test",
    });

    expect(principal.email).toBe("scientist@example.test");
  });

  it("creates a current-schema project document and returns a typed stale-save conflict", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Cells" },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const document = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/document`,
    });
    expect(document.json()).toMatchObject({ revision: 0, document: { schemaVersion: 2 } });
    const first = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}/document`,
      payload: { baseRevision: 0, document: document.json().document },
    });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}/document`,
      payload: { baseRevision: 0, document: document.json().document },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      code: "REVISION_CONFLICT",
      message: "Document revision conflict",
      currentRevision: 1,
    });
    await app.close();
  });

  it("serves stored v1 documents as v2 and stores v1 saves as v2", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Legacy");
    const v1 = {
      schemaVersion: 1,
      artboards: [
        { id: "board", name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" },
      ],
      objects: [],
      groups: [],
      constraints: [],
      styles: [],
    };
    await repository.saveDocument(project.id, 0, v1);
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const read = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/document` });
    expect(read.statusCode).toBe(200);
    expect(read.json().document).toEqual({ ...v1, schemaVersion: 2 });

    const saved = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}/document`,
      payload: { baseRevision: 1, document: v1 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().document.schemaVersion).toBe(2);
    expect((await repository.getDocument(project.id)).schemaVersion).toBe(2);

    const future = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}/document`,
      payload: { baseRevision: 2, document: { ...v1, schemaVersion: 3 } },
    });
    expect(future.statusCode).toBe(400);
    await app.close();
  });

  it("renames a project and marks deletion for durable background cleanup", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });

    const renamed = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}`,
      payload: { name: "Tissue panel" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      id: project.id,
      name: "Tissue panel",
      status: "active",
    });

    const deleted = await app.inject({ method: "DELETE", url: `/v1/projects/${project.id}` });
    expect(deleted.statusCode).toBe(202);
    expect(deleted.json()).toMatchObject({
      id: project.id,
      name: "Tissue panel",
      status: "deleting",
    });
    expect((await app.inject({ method: "GET", url: "/v1/projects" })).json()).toEqual({
      projects: [],
    });
    expect(await repository.dequeue()).toEqual({
      name: "delete_project",
      payload: { projectId: project.id },
    });
    await app.close();
  });

  it("returns a typed bad-request envelope for semantically invalid figure documents", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const current = await repository.getDocument(project.id);
    const document = structuredClone(current.document) as {
      objects: Record<string, unknown>[];
    };
    document.objects.push({
      id: "view-1",
      type: "image-view",
      artboardId: (current.document as { artboards: { id: string }[] }).artboards[0]?.id,
      transform: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      view: {
        sourceAssetId: "asset-1",
        viewport: { x: 0.8, y: 0.2, width: 0.3, height: 0.5 },
        display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
      },
    });
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });

    const response = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}/document`,
      payload: { baseRevision: 0, document },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "BAD_REQUEST",
      message: "Object view-1 has a viewport outside the source image",
    });
    await app.close();
  });

  it("rejects client-supplied audit events instead of persisting them", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const current = await repository.getDocument(project.id);
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });

    const response = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}/document`,
      payload: {
        baseRevision: 0,
        document: current.document,
        auditEvents: [{ action: "PROJECT_DELETED", details: { forged: true } }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((await repository.getDocument(project.id)).revision).toBe(0);
    expect((await repository.listAuditEvents(project.id)).map((event) => event.action)).toEqual([
      "PROJECT_CREATED",
    ]);
    await app.close();
  });

  it("returns a typed bad-request envelope for a future figure document version", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });

    const response = await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}/document`,
      payload: { baseRevision: 0, document: { schemaVersion: 2 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "BAD_REQUEST", message: "Invalid request" });
    await app.close();
  });

  it("rejects invalid upload claims before reserving immutable storage", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/uploads`,
      payload: {
        filename: "bad.gif",
        contentType: "image/gif",
        contentLength: 1,
        checksumSha256: "not-a-sha",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("UPLOAD_INVALID");
    await app.close();
  });

  it("applies a configured maximum upload size", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const app = await buildApp({
      repository,
      store: new FakeObjectStore(),
      principal,
      maxUploadBytes: 10,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/uploads`,
      payload: {
        filename: "cells.png",
        contentType: "image/png",
        contentLength: 11,
        checksumSha256: "a".repeat(64),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("UPLOAD_INVALID");
    await app.close();
  });

  it("rejects exports over 100 million pixels at the Fastify route boundary", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/exports`,
      payload: {
        format: "png",
        revision: 0,
        widthPx: 10_001,
        heightPx: 10_000,
        checksumSha256: "a".repeat(64),
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("caps upload URL lifetimes at 600 seconds", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const store = new FakeObjectStore();
    const app = await buildApp({ repository, store, principal, uploadTtlSeconds: 900 });
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/uploads`,
      payload: {
        filename: "cells.png",
        contentType: "image/png",
        contentLength: 12,
        checksumSha256: "a".repeat(64),
      },
    });
    const remaining = new Date(response.json().upload.expiresAt).getTime() - Date.now();
    expect(remaining).toBeLessThanOrEqual(600_000);
    await app.close();
  });

  it("returns UPLOAD_EXPIRED without enqueueing verification for an expired reservation", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const store = new FakeObjectStore();
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "cells.png",
      mimeType: "image/png",
      contentLength: 1,
      checksumSha256: "a".repeat(64),
      storageKey: "expired-upload",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.putForTest("expired-upload", new Uint8Array([1]), "image/png");
    const app = await buildApp({ repository, store, principal });

    const response = await app.inject({
      method: "POST",
      url: `/v1/uploads/${upload.id}/complete`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "UPLOAD_EXPIRED",
      message: "Upload reservation has expired",
    });
    const retry = await app.inject({
      method: "POST",
      url: `/v1/uploads/${upload.id}/complete`,
    });
    expect(retry.statusCode).toBe(400);
    expect(retry.json().code).toBe("UPLOAD_EXPIRED");
    expect(await repository.dequeue()).toBeUndefined();
    await app.close();
  });

  it("keeps successful upload completion idempotent", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const store = new FakeObjectStore();
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "cells.png",
      mimeType: "image/png",
      contentLength: 1,
      checksumSha256: "a".repeat(64),
      storageKey: "valid-upload",
    });
    await store.putForTest("valid-upload", new Uint8Array([1]), "image/png");
    const app = await buildApp({ repository, store, principal });

    const first = await app.inject({
      method: "POST",
      url: `/v1/uploads/${upload.id}/complete`,
    });
    const retry = await app.inject({
      method: "POST",
      url: `/v1/uploads/${upload.id}/complete`,
    });

    expect([first.statusCode, retry.statusCode]).toEqual([202, 202]);
    expect(await repository.dequeue()).toEqual({
      name: "verify_asset",
      payload: { assetId: upload.assetId },
    });
    expect(await repository.dequeue()).toBeUndefined();
    await app.close();
  });

  it("serves the audit trail newest first with actors and paging", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser("pi@example.test");
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const project = (
      await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "Audit" } })
    ).json();
    await app.inject({
      method: "PUT",
      url: `/v1/projects/${project.id}`,
      payload: { name: "Audit 2" },
    });
    const page = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/audit-events?limit=1`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      events: [
        {
          action: "PROJECT_RENAMED",
          details: { name: "Audit 2" },
          actor: { id: principal.id, email: "pi@example.test" },
        },
      ],
      nextBeforeSequence: expect.any(Number),
    });
    const older = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/audit-events?beforeSequence=${page.json().nextBeforeSequence}`,
    });
    expect(older.json().events.map((event: { action: string }) => event.action)).toEqual([
      "PROJECT_CREATED",
    ]);
    expect(
      (await app.inject({ method: "GET", url: `/v1/projects/${project.id}/audit-events?limit=0` }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });

  it("lists versions and returns each revision migrated to the current schema", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Versions");
    const v1 = {
      schemaVersion: 1,
      artboards: [
        { id: "b", name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" },
      ],
      objects: [],
      groups: [],
      constraints: [],
      styles: [],
    };
    await repository.saveDocument(project.id, 0, v1);
    await repository.saveDocument(project.id, 1, { ...v1, schemaVersion: 2 });
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const list = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/versions` });
    expect(list.json().versions.map((version: { revision: number }) => version.revision)).toEqual([
      2, 1,
    ]);
    const first = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/versions/1` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      revision: 1,
      schemaVersion: 1,
      document: { schemaVersion: 2 },
    });
    expect(
      (await app.inject({ method: "GET", url: `/v1/projects/${project.id}/versions/7` }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });

  it("records exports per figure and lists them, rejecting unknown figures", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Exports");
    const artboardId = (
      (await repository.getDocument(project.id)).document as { artboards: { id: string }[] }
    ).artboards[0]?.id;
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const payload = {
      format: "tiff",
      artboardId,
      dpi: 300,
      revision: 0,
      widthPx: 2550,
      heightPx: 3300,
      checksumSha256: "a".repeat(64),
    };
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/exports`,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ format: "tiff", artboardId, dpi: 300 });
    const unknown = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/exports`,
      payload: { ...payload, artboardId: "elsewhere" },
    });
    expect(unknown.statusCode).toBe(400);
    const listed = await app.inject({ method: "GET", url: `/v1/projects/${project.id}/exports` });
    expect(listed.json().exports).toHaveLength(1);
    await app.close();
  });

  it("hides deleted projects and another workspace's history", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Gone");
    const stranger = await repository.ensureAuthUser({
      id: "00000000-0000-4000-8000-0000000000aa",
      email: "stranger@example.test",
    });
    const strangerApp = await buildApp({
      repository,
      store: new FakeObjectStore(),
      principal: stranger,
    });
    for (const path of ["audit-events", "versions", "exports"])
      expect(
        (await strangerApp.inject({ method: "GET", url: `/v1/projects/${project.id}/${path}` }))
          .statusCode,
      ).toBe(404);
    await strangerApp.close();

    await repository.markProjectDeleting(project.id);
    await repository.deleteProjectData(project.id);
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    expect(
      (await app.inject({ method: "GET", url: `/v1/projects/${project.id}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/v1/projects/${project.id}/audit-events` }))
        .statusCode,
    ).toBe(404);
    expect((await repository.listAuditEvents(project.id)).at(-1)?.action).toBe("PROJECT_DELETED");
    await app.close();
  });

  it("rejects remote single-user startup unless explicitly allowed", async () => {
    expect(() => assertSingleUserConfiguration("https://figlab.example")).toThrow(/loopback/);
    await expect(
      buildApp({
        repository: new InMemoryFigLabRepository(),
        store: new FakeObjectStore(),
        principal: { id: "u", email: "u@example.test", workspaceId: "w" },
        publicAppUrl: "https://figlab.example",
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("accepts bracketed IPv6 loopback as a safe single-user origin", () => {
    expect(() => assertSingleUserConfiguration("http://[::1]:3000")).not.toThrow();
  });

  it("returns not-found for malformed public resource IDs", async () => {
    class RepositoryMustNotReceiveMalformedIds extends InMemoryFigLabRepository {
      override async getProject(): Promise<never> {
        throw new Error("repository received malformed ID");
      }
      override async getUpload(): Promise<never> {
        throw new Error("repository received malformed ID");
      }
      override async getAsset(): Promise<never> {
        throw new Error("repository received malformed ID");
      }
    }
    const repository = new RepositoryMustNotReceiveMalformedIds();
    const principal = await repository.bootstrapSingleUser();
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/v1/projects/not-a-uuid" }),
      app.inject({ method: "POST", url: "/v1/uploads/not-a-uuid/complete" }),
      app.inject({ method: "GET", url: "/v1/assets/not-a-uuid" }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    await app.close();
  });
});
