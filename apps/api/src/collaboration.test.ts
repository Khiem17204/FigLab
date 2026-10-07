import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { supabaseResolver } from "./auth.js";
import { buildApp } from "./index.js";

const SUPABASE_URL = "https://project.supabase.example";
const PI = "6f0d2b8e-1c55-4e7f-9a7c-0c1b2d3e4f50";
const STUDENT = "8a2c4e6f-3b1d-4c5e-8f7a-1b2c3d4e5f60";
const STRANGER = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "ES256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

async function bearer(sub: string, email: string, role?: string) {
  const token = await new SignJWT({
    email,
    role: "authenticated",
    app_metadata: role ? { role } : {},
  })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(sub)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  return { authorization: `Bearer ${token}` };
}

// Loosely typed response bodies keep these HTTP-level assertions readable.
// biome-ignore lint/suspicious/noExplicitAny: test-only JSON access
type Json = Record<string, any>;

async function lab() {
  const repository = new InMemoryFigLabRepository();
  const app = await buildApp({
    repository,
    store: new FakeObjectStore(),
    resolvePrincipal: supabaseResolver({ supabaseUrl: SUPABASE_URL, repository, keys }),
    publicAppUrl: "https://figlab.example",
  });
  const pi = await bearer(PI, "pi@lab.test", "admin");
  const student = await bearer(STUDENT, "student@lab.test");
  const stranger = await bearer(STRANGER, "stranger@else.test");
  const call = async (
    headers: Record<string, string>,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (response.json() as Json) : {},
    };
  };
  return { app, repository, pi, student, stranger, call };
}

describe("lab workspaces over HTTP", () => {
  it("invites by link, enforces roles per route, and keeps outsiders out", async () => {
    const { app, pi, student, stranger, call } = await lab();
    const workspace = (await call(pi, "POST", "/v1/workspaces", { name: "Ramos Lab" })).body;
    expect(workspace).toMatchObject({ kind: "lab", role: "owner", memberCount: 1 });
    const project = (
      await call(pi, "POST", `/v1/workspaces/${workspace.id}/projects`, { name: "pERK blots" })
    ).body;
    expect(project).toMatchObject({ workspaceId: workspace.id, createdBy: PI });

    const created = await call(pi, "POST", `/v1/workspaces/${workspace.id}/invites`, {
      role: "viewer",
      email: "student@lab.test",
    });
    expect(created.status).toBe(201);
    const { token } = created.body;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      JSON.stringify((await call(pi, "GET", `/v1/workspaces/${workspace.id}/invites`)).body),
    ).not.toContain(token);
    expect((await call(student, "GET", `/v1/invites/${token}`)).body).toMatchObject({
      workspaceName: "Ramos Lab",
      role: "viewer",
      status: "pending",
    });
    const wrongAccount = await call(stranger, "POST", `/v1/invites/${token}/accept`);
    expect(wrongAccount).toMatchObject({
      status: 409,
      body: { code: "INVITE_UNAVAILABLE", details: ["email-mismatch"] },
    });
    expect((await call(student, "POST", `/v1/invites/${token}/accept`)).body).toMatchObject({
      id: workspace.id,
      role: "viewer",
    });
    expect((await call(student, "GET", "/v1/workspaces")).body.workspaces).toHaveLength(2);
    expect((await call(stranger, "GET", `/v1/invites/not-a-token`)).status).toBe(400);

    // Viewers read and comment but cannot save; outsiders see nothing.
    const document = await call(student, "GET", `/v1/projects/${project.id}/document`);
    expect(document.status).toBe(200);
    const save = await call(student, "PUT", `/v1/projects/${project.id}/document`, {
      baseRevision: 0,
      document: document.body.document,
    });
    expect(save).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect((await call(stranger, "GET", `/v1/projects/${project.id}/document`)).status).toBe(404);
    expect((await call(stranger, "GET", `/v1/workspaces/${workspace.id}/projects`)).status).toBe(
      404,
    );
    expect((await call(student, "DELETE", `/v1/projects/${project.id}`)).status).toBe(403);

    const comment = (
      await call(pi, "POST", `/v1/projects/${project.id}/comments`, {
        body: "Check lane 3 exposure",
        anchor: { artboardId: "board", xPt: 10, yPt: 20 },
      })
    ).body;
    const reply = await call(student, "POST", `/v1/projects/${project.id}/comments`, {
      body: "Will re-image",
      parentId: comment.id,
    });
    expect(reply.status).toBe(201);
    expect(
      (
        await call(student, "PATCH", `/v1/projects/${project.id}/comments/${comment.id}`, {
          resolved: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(student, "DELETE", `/v1/projects/${project.id}/comments/${comment.id}`)).status,
    ).toBe(403);

    // Promotion makes the student an editor who can save and resolve.
    const promoted = await call(pi, "PUT", `/v1/workspaces/${workspace.id}/members/${STUDENT}`, {
      role: "editor",
    });
    expect(promoted.body).toMatchObject({ email: "student@lab.test", role: "editor" });
    expect(
      (
        await call(student, "PUT", `/v1/projects/${project.id}/document`, {
          baseRevision: 0,
          document: document.body.document,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(student, "PATCH", `/v1/projects/${project.id}/comments/${comment.id}`, {
          resolved: true,
        })
      ).body,
    ).toMatchObject({ resolvedBy: { email: "student@lab.test" } });
    // Editors cannot manage members or invite.
    expect(
      (await call(student, "POST", `/v1/workspaces/${workspace.id}/invites`, { role: "viewer" }))
        .status,
    ).toBe(403);
    // The last owner cannot leave; personal workspaces cannot be shared.
    expect(
      (await call(pi, "DELETE", `/v1/workspaces/${workspace.id}/members/${PI}`)).body.code,
    ).toBe("CONFLICT");
    const personal = (await call(pi, "GET", "/v1/me")).body.personalWorkspaceId;
    expect(
      (await call(pi, "POST", `/v1/workspaces/${personal}/invites`, { role: "viewer" })).body.code,
    ).toBe("CONFLICT");
    // Members may leave on their own.
    expect(
      (await call(student, "DELETE", `/v1/workspaces/${workspace.id}/members/${STUDENT}`)).status,
    ).toBe(204);
    expect((await call(student, "GET", `/v1/projects/${project.id}`)).status).toBe(404);
    await app.close();
  });

  it("files projects in folders, searches, and starts projects from image-free templates", async () => {
    const { app, pi, student, call } = await lab();
    const personal = (await call(pi, "GET", "/v1/me")).body.personalWorkspaceId;
    const folder = (await call(pi, "POST", `/v1/workspaces/${personal}/folders`, { name: "Blots" }))
      .body;
    const project = (await call(pi, "POST", "/v1/projects", { name: "Akt figure" })).body;
    expect(
      (await call(pi, "PUT", `/v1/projects/${project.id}/folder`, { folderId: folder.id })).body,
    ).toMatchObject({ folderId: folder.id });
    expect(
      (await call(pi, "GET", `/v1/workspaces/${personal}/projects?folderId=root`)).body.projects,
    ).toEqual([]);
    expect(
      (await call(pi, "GET", `/v1/workspaces/${personal}/projects?folderId=${folder.id}`)).body
        .projects,
    ).toHaveLength(1);
    expect((await call(pi, "GET", "/v1/search?q=akt")).body.results).toEqual([
      expect.objectContaining({ projectName: "Akt figure", workspaceName: "Personal workspace" }),
    ]);
    expect((await call(student, "GET", "/v1/search?q=akt")).body.results).toEqual([]);
    expect(
      (
        await call(pi, "PATCH", `/v1/workspaces/${personal}/folders/${folder.id}`, {
          parentId: folder.id,
        })
      ).body.code,
    ).toBe("CONFLICT");

    const template = await call(pi, "POST", `/v1/workspaces/${personal}/templates`, {
      name: "Blot layout",
      projectId: project.id,
    });
    expect(template.status).toBe(201);
    const fromTemplate = (
      await call(pi, "POST", `/v1/workspaces/${personal}/projects`, {
        name: "From layout",
        templateId: template.body.id,
        folderId: folder.id,
      })
    ).body;
    const started = (await call(pi, "GET", `/v1/projects/${fromTemplate.id}/document`)).body;
    expect(started.document.sources).toEqual([]);
    expect(fromTemplate.folderId).toBe(folder.id);
    // Templates belong to their workspace.
    const otherLab = (await call(pi, "POST", "/v1/workspaces", { name: "Other" })).body;
    expect(
      (
        await call(pi, "POST", `/v1/workspaces/${otherLab.id}/projects`, {
          name: "x",
          templateId: template.body.id,
        })
      ).status,
    ).toBe(404);
    await app.close();
  });

  it("limits admin views to FigLab administrators", async () => {
    const { app, pi, student, call } = await lab();
    await call(student, "GET", "/v1/me");
    expect((await call(student, "GET", "/v1/admin/overview")).status).toBe(403);
    const overview = await call(pi, "GET", "/v1/admin/overview");
    expect(overview).toMatchObject({ status: 200, body: { users: 2, personalWorkspaces: 2 } });
    expect((await call(pi, "GET", "/v1/admin/users?limit=10")).body.users).toHaveLength(2);
    expect((await call(pi, "GET", "/v1/admin/workspaces")).body.workspaces).toHaveLength(2);
    expect((await call(pi, "GET", "/v1/admin/jobs")).body).toEqual({ jobs: [] });
    await app.close();
  });

  it("signs derived previews the worker recorded, and nothing else", async () => {
    const { app, repository, pi, stranger, call } = await lab();
    const project = (await call(pi, "POST", "/v1/projects", { name: "Previews" })).body;
    const key = `workspaces/w/projects/${project.id}/assets/a/original`;
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "big.tif",
      mimeType: "image/tiff",
      contentLength: 10,
      checksumSha256: "a".repeat(64),
      storageKey: key,
    });
    await repository.updateAsset(upload.assetId, {
      status: "ready",
      widthPx: 4000,
      heightPx: 3000,
      bitDepth: 16,
      channelCount: 1,
      metadata: { previews: [{ maxEdge: 256, widthPx: 256, heightPx: 192, stretched: true }] },
    });
    const signed = await call(pi, "POST", `/v1/assets/${upload.assetId}/previews/256/download-url`);
    expect(signed.status).toBe(201);
    expect(decodeURIComponent(signed.body.url)).toContain(`assets/a/preview-256.png`);
    expect(decodeURIComponent(signed.body.url)).not.toContain("original");
    expect(
      (await call(pi, "POST", `/v1/assets/${upload.assetId}/previews/1024/download-url`)).status,
    ).toBe(404);
    expect(
      (await call(stranger, "POST", `/v1/assets/${upload.assetId}/previews/256/download-url`))
        .status,
    ).toBe(404);
    await app.close();
  });
});
