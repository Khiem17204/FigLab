import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import { describe, expect, it } from "vitest";
import { assertSingleUserConfiguration, buildApp } from "./index.js";

describe("buildApp", () => {
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
});
