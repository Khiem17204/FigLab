import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  AssetRecord,
  AuditEvent,
  AuthUserIdentity,
  DocumentRecord,
  ExportRecord,
  FigLabRepository,
  Principal,
  ProjectRecord,
  UploadRecord,
} from "./index.js";
import {
  assertResourceId,
  deriveDocumentAuditEvents,
  NotFoundError,
  schemaVersionOf,
  UploadExpiredError,
} from "./index.js";
import * as schema from "./schema.js";

const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const LOCAL_MEMBERSHIP_ID = "00000000-0000-4000-8000-000000000003";
const defaultDocument = () => ({
  schemaVersion: 2,
  artboards: [
    { id: randomUUID(), name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" },
  ],
  objects: [],
  groups: [],
  constraints: [],
  styles: [],
});

export class PostgresFigLabRepository implements FigLabRepository {
  readonly db: NodePgDatabase<typeof schema>;
  constructor(private readonly pool: Pool) {
    this.db = drizzle(pool, { schema });
  }

  async bootstrapSingleUser(email = "local-admin@figlab.invalid"): Promise<Principal> {
    return this.transaction(async (client) => {
      const now = new Date();
      await client.query(
        "INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(email) DO UPDATE SET updated_at=users.updated_at",
        [LOCAL_USER_ID, email, now],
      );
      await client.query(
        "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(id) DO NOTHING",
        [LOCAL_WORKSPACE_ID, "Default workspace", now],
      );
      await client.query(
        "INSERT INTO workspace_members(id,workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,'owner',$4,$4) ON CONFLICT(workspace_id,user_id) DO NOTHING",
        [LOCAL_MEMBERSHIP_ID, LOCAL_WORKSPACE_ID, LOCAL_USER_ID, now],
      );
      return {
        id: LOCAL_USER_ID,
        email,
        workspaceId: LOCAL_WORKSPACE_ID,
      };
    });
  }
  async ensureAuthUser(identity: AuthUserIdentity): Promise<Principal> {
    assertResourceId(identity.id);
    return this.transaction(async (client) => {
      // Serialize first sign-in per user so concurrent requests cannot create two workspaces.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [identity.id]);
      const now = new Date();
      await client.query(
        "INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email, updated_at=CASE WHEN users.email=EXCLUDED.email THEN users.updated_at ELSE EXCLUDED.updated_at END",
        [identity.id, identity.email, now],
      );
      const membership = await client.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ORDER BY created_at LIMIT 1",
        [identity.id],
      );
      const existing = membership.rows[0]?.workspace_id;
      if (existing) return { id: identity.id, email: identity.email, workspaceId: existing };
      const workspaceId = randomUUID();
      await client.query(
        "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES($1,$2,$3,$3)",
        [workspaceId, "Personal workspace", now],
      );
      await client.query(
        "INSERT INTO workspace_members(id,workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,'owner',$4,$4)",
        [randomUUID(), workspaceId, identity.id, now],
      );
      return { id: identity.id, email: identity.email, workspaceId };
    });
  }
  async createProject(workspaceId: string, name: string): Promise<ProjectRecord> {
    assertResourceId(workspaceId);
    return this.transaction(async (client) => {
      const id = randomUUID();
      const now = new Date();
      const document = defaultDocument();
      const result = await client.query(
        "INSERT INTO projects(id,workspace_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'active',$4,$4) RETURNING *",
        [id, workspaceId, name, now],
      );
      await client.query(
        "INSERT INTO project_documents(project_id,revision,schema_version,document,created_at,updated_at) VALUES($1,0,$2,$3,$4,$4)",
        [id, document.schemaVersion, document, now],
      );
      await this.insertAudit(client, id, "PROJECT_CREATED", { name });
      return projectRow(first(result.rows));
    });
  }
  async listProjects(workspaceId: string): Promise<ProjectRecord[]> {
    assertResourceId(workspaceId);
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(
        and(eq(schema.projects.workspaceId, workspaceId), eq(schema.projects.status, "active")),
      )
      .orderBy(schema.projects.createdAt);
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      status: row.status as ProjectRecord["status"],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
  async getProject(projectId: string): Promise<ProjectRecord> {
    assertResourceId(projectId);
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    const row = rows[0];
    if (!row) throw new NotFoundError();
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      status: row.status as ProjectRecord["status"],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  async renameProject(projectId: string, name: string): Promise<ProjectRecord> {
    assertResourceId(projectId);
    return this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE projects SET name=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [projectId, name],
      );
      const project = projectRow(first(result.rows));
      await this.insertAudit(client, projectId, "PROJECT_RENAMED", { name });
      return project;
    });
  }
  async markProjectDeleting(projectId: string): Promise<ProjectRecord> {
    assertResourceId(projectId);
    return this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE projects SET status='deleting',updated_at=now() WHERE id=$1 RETURNING *",
        [projectId],
      );
      const project = projectRow(first(result.rows));
      await addJob(client, "delete_project", { projectId }, `delete_project:${projectId}`);
      return project;
    });
  }
  async getDocument(projectId: string): Promise<DocumentRecord> {
    assertResourceId(projectId);
    const result = await this.pool.query("SELECT * FROM project_documents WHERE project_id=$1", [
      projectId,
    ]);
    return documentRow(first(result.rows));
  }
  async saveDocument(
    projectId: string,
    baseRevision: number,
    document: unknown,
  ): Promise<
    { kind: "saved"; document: DocumentRecord } | { kind: "conflict"; currentRevision: number }
  > {
    assertResourceId(projectId);
    return this.transaction(async (client) => {
      const prior = await client.query(
        "SELECT document FROM project_documents WHERE project_id=$1",
        [projectId],
      );
      if (prior.rowCount === 0) throw new NotFoundError();
      const updated = await client.query(
        "UPDATE project_documents SET revision=revision+1,schema_version=$4,document=$3,updated_at=now() WHERE project_id=$1 AND revision=$2 RETURNING *",
        [projectId, baseRevision, document, schemaVersionOf(document)],
      );
      if (updated.rowCount === 0) {
        const current = await client.query(
          "SELECT revision FROM project_documents WHERE project_id=$1",
          [projectId],
        );
        return { kind: "conflict", currentRevision: Number(first(current.rows).revision) };
      }
      const record = documentRow(first(updated.rows));
      await client.query(
        "INSERT INTO project_versions(id,project_id,revision,schema_version,document,created_at) VALUES($1,$2,$3,$4,$5,now())",
        [randomUUID(), projectId, record.revision, schemaVersionOf(document), document],
      );
      await this.insertAudit(
        client,
        projectId,
        "DOCUMENT_UPDATED",
        documentDiff(first(prior.rows).document, document),
      );
      for (const event of deriveDocumentAuditEvents(first(prior.rows).document, document))
        await this.insertAudit(client, projectId, event.action, event.details);
      return { kind: "saved", document: record };
    });
  }
  async createUpload(input: {
    projectId: string;
    filename: string;
    mimeType: string;
    contentLength: number;
    checksumSha256: string;
    storageKey: string;
    expiresAt?: string;
    assetId?: string;
  }): Promise<UploadRecord> {
    assertResourceId(input.projectId);
    if (input.assetId !== undefined) assertResourceId(input.assetId);
    return this.transaction(async (client) => {
      const id = randomUUID();
      const assetId = input.assetId ?? randomUUID();
      const now = new Date();
      const expiresAt = new Date(input.expiresAt ?? Date.now() + 600_000);
      await client.query(
        "INSERT INTO upload_sessions(id,project_id,status,content_length,checksum_sha256,expires_at,created_at) VALUES($1,$2,'reserved',$3,$4,$5,$6)",
        [id, input.projectId, input.contentLength, input.checksumSha256, expiresAt, now],
      );
      await client.query(
        "INSERT INTO assets(id,upload_id,project_id,storage_key,filename,mime_type,checksum_sha256,status,width_px,height_px,bit_depth,channel_count,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending-verification',1,1,8,3,'{}'::jsonb,$8)",
        [
          assetId,
          id,
          input.projectId,
          input.storageKey,
          input.filename,
          input.mimeType,
          input.checksumSha256,
          now,
        ],
      );
      return {
        id,
        projectId: input.projectId,
        assetId,
        contentLength: input.contentLength,
        checksumSha256: input.checksumSha256,
        status: "reserved",
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString(),
      };
    });
  }
  async getUpload(id: string): Promise<UploadRecord> {
    assertResourceId(id);
    const result = await this.pool.query(
      "SELECT u.*,a.id asset_id FROM upload_sessions u JOIN assets a ON a.upload_id=u.id WHERE u.id=$1",
      [id],
    );
    return uploadRow(first(result.rows));
  }
  async getAsset(id: string): Promise<AssetRecord> {
    assertResourceId(id);
    const result = await this.pool.query("SELECT * FROM assets WHERE id=$1", [id]);
    return assetRow(first(result.rows));
  }
  async completeUpload(id: string): Promise<AssetRecord> {
    assertResourceId(id);
    const result = await this.transaction(async (client) => {
      const uploadResult = await client.query(
        "SELECT status,expires_at FROM upload_sessions WHERE id=$1 FOR UPDATE",
        [id],
      );
      const upload = first(uploadResult.rows) as { status: string; expires_at: Date };
      if (upload.status === "expired") return { kind: "expired" as const };
      if (upload.status === "reserved" && upload.expires_at.getTime() <= Date.now()) {
        await client.query("UPDATE upload_sessions SET status='expired' WHERE id=$1", [id]);
        return { kind: "expired" as const };
      }
      const updated =
        upload.status === "reserved"
          ? await client.query(
              "UPDATE upload_sessions SET status='verifying' WHERE id=$1 AND status='reserved' RETURNING id",
              [id],
            )
          : undefined;
      const assetResult = await client.query("SELECT * FROM assets WHERE upload_id=$1", [id]);
      const asset = assetRow(first(assetResult.rows));
      if ((updated?.rowCount ?? 0) > 0)
        await addJob(client, "verify_asset", { assetId: asset.id }, `verify_asset:${asset.id}`);
      return { kind: "complete" as const, asset };
    });
    if (result.kind === "expired") throw new UploadExpiredError();
    return result.asset;
  }
  async updateAsset(
    id: string,
    update: Partial<
      Pick<
        AssetRecord,
        | "status"
        | "widthPx"
        | "heightPx"
        | "bitDepth"
        | "channelCount"
        | "metadata"
        | "rejectionReason"
      >
    >,
  ): Promise<AssetRecord> {
    assertResourceId(id);
    return this.transaction(async (client) => {
      const currentResult = await client.query("SELECT * FROM assets WHERE id=$1", [id]);
      const current = assetRow(first(currentResult.rows));
      const next = { ...current, ...update };
      const result = await client.query(
        "UPDATE assets SET status=$2,width_px=$3,height_px=$4,bit_depth=$5,channel_count=$6,metadata=$7,rejection_reason=$8 WHERE id=$1 RETURNING *",
        [
          id,
          next.status,
          next.widthPx,
          next.heightPx,
          next.bitDepth,
          next.channelCount,
          next.metadata,
          next.rejectionReason ?? null,
        ],
      );
      await client.query("UPDATE upload_sessions SET status=$2 WHERE id=$1", [
        current.uploadId,
        next.status === "ready"
          ? "completed"
          : next.status === "rejected"
            ? "rejected"
            : "verifying",
      ]);
      if (next.status === "ready" && current.status !== "ready")
        await this.insertAudit(client, current.projectId, "ASSET_UPLOADED", { assetId: id });
      return assetRow(first(result.rows));
    });
  }
  async assertReadyAssets(projectId: string, ids: Iterable<string>): Promise<void> {
    assertResourceId(projectId);
    const values = [...new Set(ids)];
    for (const id of values) assertResourceId(id);
    if (values.length === 0) return;
    const result = await this.pool.query(
      "SELECT count(*)::int count FROM assets WHERE project_id=$1 AND status='ready' AND id=ANY($2::uuid[])",
      [projectId, values],
    );
    if (Number(first(result.rows).count) !== values.length) throw new NotFoundError();
  }
  async recordExport(input: Omit<ExportRecord, "id" | "createdAt">): Promise<ExportRecord> {
    assertResourceId(input.projectId);
    return this.transaction(async (client) => {
      const revision = await client.query(
        "SELECT 1 FROM project_documents WHERE project_id=$1 AND revision=$2",
        [input.projectId, input.revision],
      );
      if (revision.rowCount === 0) throw new NotFoundError();
      const id = randomUUID();
      const result = await client.query(
        "INSERT INTO export_records(id,project_id,revision,format,width_px,height_px,checksum_sha256,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,now()) RETURNING *",
        [
          id,
          input.projectId,
          input.revision,
          input.format,
          input.widthPx,
          input.heightPx,
          input.checksumSha256,
        ],
      );
      await this.insertAudit(client, input.projectId, "EXPORT_CREATED", {
        exportId: id,
        revision: input.revision,
      });
      return exportRow(first(result.rows));
    });
  }
  async listAuditEvents(projectId: string): Promise<AuditEvent[]> {
    assertResourceId(projectId);
    const result = await this.pool.query(
      "SELECT * FROM audit_events WHERE project_id=$1 ORDER BY created_at",
      [projectId],
    );
    return result.rows.map(auditRow);
  }
  async listProjectAssets(projectId: string): Promise<AssetRecord[]> {
    assertResourceId(projectId);
    const result = await this.pool.query("SELECT * FROM assets WHERE project_id=$1", [projectId]);
    return result.rows.map(assetRow);
  }
  async deleteProjectData(projectId: string): Promise<void> {
    assertResourceId(projectId);
    await this.transaction(async (client) => {
      await client.query("DELETE FROM export_records WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM audit_events WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM assets WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM upload_sessions WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM project_versions WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM project_documents WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM projects WHERE id=$1", [projectId]);
    });
  }
  private async insertAudit(
    client: PoolClient,
    projectId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_events(id,project_id,action,details,created_at) VALUES($1,$2,$3,$4,now())",
      [randomUUID(), projectId, action, details],
    );
  }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface PgPoolOptions {
  maxConnections?: number;
  /** PEM CA that must have signed the server certificate (for example Supabase's root CA). */
  caCert?: string;
}

/**
 * Creates a pool for the given URL. With `caCert`, TLS is required and the server certificate
 * and host name are verified against that CA; `sslmode`/`sslrootcert` URL parameters are ignored.
 */
export function createPgPool(connectionString: string, options: PgPoolOptions = {}): Pool {
  let url = connectionString;
  if (options.caCert) {
    const parsed = new URL(connectionString);
    for (const parameter of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"])
      parsed.searchParams.delete(parameter);
    url = parsed.toString();
  }
  const pool = new Pool({
    connectionString: url,
    ...(options.maxConnections ? { max: options.maxConnections } : {}),
    ...(options.caCert ? { ssl: { ca: options.caCert, rejectUnauthorized: true } } : {}),
  });
  // An idle client can be dropped by a pooler; log it instead of crashing the process.
  pool.on("error", (error) => console.error("PostgreSQL pool error", error));
  return pool;
}

export function createPostgresRepository(
  connectionString: string,
  options: PgPoolOptions = {},
): {
  repository: PostgresFigLabRepository;
  close: () => Promise<void>;
} {
  const pool = createPgPool(connectionString, options);
  return { repository: new PostgresFigLabRepository(pool), close: () => pool.end() };
}

async function addJob(
  client: PoolClient,
  name: string,
  payload: Record<string, unknown>,
  jobKey: string,
): Promise<void> {
  await client.query(
    "SELECT graphile_worker.add_job($1,$2::json,job_key := $3,max_attempts := 10)",
    [name, JSON.stringify(payload), jobKey],
  );
}
function first<T extends QueryResultRow>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}
function date(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function projectRow(row: QueryResultRow): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
function documentRow(row: QueryResultRow): DocumentRecord {
  return {
    projectId: row.project_id,
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    document: row.document,
    updatedAt: date(row.updated_at),
  };
}
function uploadRow(row: QueryResultRow): UploadRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    contentLength: Number(row.content_length),
    checksumSha256: row.checksum_sha256,
    status: row.status,
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
  };
}
function assetRow(row: QueryResultRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    uploadId: row.upload_id,
    filename: row.filename,
    mimeType: row.mime_type,
    checksumSha256: row.checksum_sha256,
    storageKey: row.storage_key,
    status: row.status,
    widthPx: Number(row.width_px),
    heightPx: Number(row.height_px),
    bitDepth: Number(row.bit_depth) as 8 | 16,
    channelCount: Number(row.channel_count) as 1 | 3 | 4,
    metadata: row.metadata ?? {},
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
    createdAt: date(row.created_at),
  };
}
function exportRow(row: QueryResultRow): ExportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: Number(row.revision),
    format: row.format,
    widthPx: Number(row.width_px),
    heightPx: Number(row.height_px),
    checksumSha256: row.checksum_sha256,
    createdAt: date(row.created_at),
  };
}
function auditRow(row: QueryResultRow): AuditEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    action: row.action,
    details: row.details,
    createdAt: date(row.created_at),
  };
}
function documentDiff(before: unknown, after: unknown): Record<string, unknown> {
  const left = before as { objects?: unknown[]; artboards?: unknown[] };
  const right = after as { objects?: unknown[]; artboards?: unknown[] };
  return {
    objectCountBefore: left.objects?.length ?? 0,
    objectCountAfter: right.objects?.length ?? 0,
    artboardCountBefore: left.artboards?.length ?? 0,
    artboardCountAfter: right.artboards?.length ?? 0,
  };
}
