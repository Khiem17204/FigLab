import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import { describe, expect, it } from "vitest";
import { assertSingleUserConfiguration, bootstrapSingleUserFromEnv, buildApp } from "./index.js";

describe("buildApp", () => {
  it("threads SINGLE_USER_EMAIL into single-user bootstrap", async () => {
    const repository = new InMemoryFigLabRepository();

    const principal = await bootstrapSingleUserFromEnv(repository, {
      SINGLE_USER_EMAIL: "scientist@example.test",
    });

    expect(principal.email).toBe("scientist@example.test");
  });

  it("creates a schema-v1 project document and returns a typed stale-save conflict", async () => {
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
    expect(document.json()).toMatchObject({ revision: 0, document: { schemaVersion: 1 } });
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
