import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { supabaseResolver, UnauthorizedError } from "./auth.js";
import { handleFetchRequest } from "./fetch-adapter.js";
import { buildApp } from "./index.js";

const SUPABASE_URL = "https://project.supabase.example";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const ALICE = "6f0d2b8e-1c55-4e7f-9a7c-0c1b2d3e4f50";
const BOB = "8a2c4e6f-3b1d-4c5e-8f7a-1b2c3d4e5f60";

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "ES256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

async function token(
  sub: string,
  email: string,
  options: { issuer?: string; expiresIn?: string; role?: string } = {},
): Promise<string> {
  return new SignJWT({
    email,
    role: "authenticated",
    app_metadata: options.role ? { role: options.role } : {},
  })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(sub)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(privateKey);
}

describe("supabaseResolver", () => {
  it("provisions one personal workspace per verified user and reads the admin role", async () => {
    const repository = new InMemoryFigLabRepository();
    const resolve = supabaseResolver({ supabaseUrl: SUPABASE_URL, repository, keys });

    const first = await resolve(`Bearer ${await token(ALICE, "alice@example.test")}`);
    const again = await resolve(
      `Bearer ${await token(ALICE, "alice@example.test", { role: "admin" })}`,
    );
    const other = await resolve(`Bearer ${await token(BOB, "bob@example.test")}`);

    expect(first).toMatchObject({ id: ALICE, email: "alice@example.test", role: "member" });
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(again.role).toBe("admin");
    expect(other.workspaceId).not.toBe(first.workspaceId);
  });

  it.each([
    ["a missing header", async () => undefined],
    ["a non-bearer header", async () => "Basic abc"],
    [
      "an expired token",
      async () => `Bearer ${await token(ALICE, "a@x.test", { expiresIn: "-1m" })}`,
    ],
    [
      "another issuer",
      async () =>
        `Bearer ${await token(ALICE, "a@x.test", { issuer: "https://evil.test/auth/v1" })}`,
    ],
    ["a malformed token", async () => "Bearer not-a-jwt"],
  ])("rejects %s", async (_label, header) => {
    const resolve = supabaseResolver({
      supabaseUrl: SUPABASE_URL,
      repository: new InMemoryFigLabRepository(),
      keys,
    });
    await expect(resolve(await header())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("buildApp with Supabase auth", () => {
  async function hostedApp() {
    const repository = new InMemoryFigLabRepository();
    const app = await buildApp({
      repository,
      store: new FakeObjectStore(),
      resolvePrincipal: supabaseResolver({ supabaseUrl: SUPABASE_URL, repository, keys }),
      publicAppUrl: "https://figlab.example",
    });
    return app;
  }

  it("accepts a public URL without the single-user override and requires a session", async () => {
    const app = await hostedApp();
    const anonymous = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ code: "UNAUTHORIZED", message: "Sign in to continue" });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("isolates each user's projects and reports the caller from /v1/me", async () => {
    const app = await hostedApp();
    const alice = {
      authorization: `Bearer ${await token(ALICE, "alice@example.test", { role: "admin" })}`,
    };
    const bob = { authorization: `Bearer ${await token(BOB, "bob@example.test")}` };

    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: alice,
      payload: { name: "Alice blot" },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id;

    expect((await app.inject({ method: "GET", url: "/v1/projects", headers: bob })).json()).toEqual(
      {
        projects: [],
      },
    );
    const stolen = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}`,
      headers: bob,
    });
    expect(stolen.statusCode).toBe(404);
    const owned = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}`,
      headers: alice,
    });
    expect(owned.statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/v1/me", headers: alice })).json()).toEqual({
      email: "alice@example.test",
      role: "admin",
    });
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: bob })).json()).toEqual({
      email: "bob@example.test",
      role: "member",
    });
    await app.close();
  });

  it("signals queued work after upload completion and project deletion", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    let signals = 0;
    const app = await buildApp({
      repository,
      store: new FakeObjectStore(),
      principal,
      onJobsEnqueued: () => {
        signals += 1;
      },
    });
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const deleted = await app.inject({ method: "DELETE", url: `/v1/projects/${project.id}` });
    expect(deleted.statusCode).toBe(202);
    expect(signals).toBe(1);
    await app.close();
  });
});

describe("handleFetchRequest", () => {
  it("round-trips a fetch Request through Fastify, including JSON bodies and headers", async () => {
    const repository = new InMemoryFigLabRepository();
    const principal = await repository.bootstrapSingleUser();
    const app = await buildApp({ repository, store: new FakeObjectStore(), principal });

    const created = await handleFetchRequest(
      app,
      new Request("https://figlab.example/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "From fetch" }),
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toContain("application/json");
    expect(await created.json()).toMatchObject({ name: "From fetch", status: "active" });

    const listed = await handleFetchRequest(
      app,
      new Request("https://figlab.example/v1/projects?unused=1"),
    );
    expect((await listed.json()).projects).toHaveLength(1);
    await app.close();
  });
});
