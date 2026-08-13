import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresFigLabRepository } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgresFigLabRepository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const repository = new PostgresFigLabRepository(pool);

  beforeAll(async () => {
    const migration = await readFile(
      new URL("../migrations/0000_initial.sql", import.meta.url),
      "utf8",
    );
    await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    await pool.query(
      "DROP TABLE IF EXISTS export_records,audit_events,assets,upload_sessions,project_versions,project_documents,projects,workspace_members,workspaces,users CASCADE",
    );
    await pool.query(migration);
    await pool.query("CREATE SCHEMA graphile_worker");
    await pool.query(
      "CREATE TABLE graphile_worker.jobs(identifier text, payload jsonb, job_key text UNIQUE)",
    );
    await pool.query(
      "CREATE FUNCTION graphile_worker.add_job(text,json,job_key text DEFAULT NULL,max_attempts int DEFAULT 25) RETURNS json LANGUAGE plpgsql AS $$ BEGIN INSERT INTO graphile_worker.jobs VALUES ($1,$2,$3) ON CONFLICT ON CONSTRAINT jobs_job_key_key DO NOTHING; RETURN '{}'::json; END $$",
    );
  });
  afterAll(() => pool.end());

  it("persists idempotent bootstrap, atomic revision CAS, and durable verification enqueue", async () => {
    const principal = await repository.bootstrapSingleUser();
    expect(await repository.bootstrapSingleUser()).toEqual(principal);
    const project = await repository.createProject(principal.workspaceId, "Cells");
    const document = await repository.getDocument(project.id);
    const [left, right] = await Promise.all([
      repository.saveDocument(project.id, 0, document.document),
      repository.saveDocument(project.id, 0, document.document),
    ]);
    expect([left.kind, right.kind].sort()).toEqual(["conflict", "saved"]);
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "a.png",
      mimeType: "image/png",
      contentLength: 1,
      checksumSha256: "a".repeat(64),
      storageKey: "key",
    });
    await repository.completeUpload(upload.id);
    await repository.completeUpload(upload.id);
    const jobs = await pool.query("SELECT identifier FROM graphile_worker.jobs");
    expect(jobs.rows).toEqual([{ identifier: "verify_asset" }]);
  });

  it("maps malformed resource IDs to not-found before PostgreSQL UUID coercion", async () => {
    await expect(repository.getProject("not-a-uuid")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("persists expiry without enqueueing verification", async () => {
    await pool.query("DELETE FROM graphile_worker.jobs");
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Expired upload");
    const upload = await repository.createUpload({
      projectId: project.id,
      filename: "expired.png",
      mimeType: "image/png",
      contentLength: 1,
      checksumSha256: "a".repeat(64),
      storageKey: `expired-${project.id}`,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await expect(repository.completeUpload(upload.id)).rejects.toMatchObject({
      name: "UploadExpiredError",
    });
    await expect(repository.completeUpload(upload.id)).rejects.toMatchObject({
      name: "UploadExpiredError",
    });
    expect((await pool.query("SELECT identifier FROM graphile_worker.jobs")).rows).toEqual([]);
  });

  it("persists server-derived granular document audit events", async () => {
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Audit derivation");
    const current = await repository.getDocument(project.id);
    const artboardId = (current.document as { artboards: { id: string }[] }).artboards[0]?.id ?? "";
    await repository.saveDocument(project.id, 0, {
      ...(current.document as object),
      objects: [
        {
          id: "view-1",
          type: "image-view",
          artboardId,
          transform: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
          zIndex: 0,
          locked: false,
          hidden: false,
          view: {
            sourceAssetId: "asset-1",
            viewport: { x: 0, y: 0, width: 1, height: 1 },
            display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
          },
        },
      ],
    });

    expect(
      (await repository.listAuditEvents(project.id))
        .filter((event) => event.action === "CROP_CREATED")
        .map(({ action, details }) => ({ action, details })),
    ).toEqual([
      {
        action: "CROP_CREATED",
        details: {
          objectId: "view-1",
          viewport: { x: 0, y: 0, width: 1, height: 1 },
        },
      },
    ]);
  });
});
