import { randomUUID } from "node:crypto";

export type ProjectStatus = "active" | "deleting";
export type UploadStatus =
  | "reserved"
  | "uploaded"
  | "verifying"
  | "completed"
  | "rejected"
  | "expired";
export type AssetStatus = "pending-verification" | "ready" | "rejected";
export type AuditAction =
  | "PROJECT_CREATED"
  | "PROJECT_RENAMED"
  | "DOCUMENT_UPDATED"
  | "ASSET_UPLOADED"
  | "EXPORT_CREATED"
  | "PROJECT_DELETED";

export interface Principal {
  id: string;
  email: string;
  workspaceId: string;
}
export interface ProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}
export interface DocumentRecord {
  projectId: string;
  revision: number;
  schemaVersion: number;
  document: unknown;
  updatedAt: string;
}
export interface UploadRecord {
  id: string;
  projectId: string;
  assetId: string;
  contentLength: number;
  checksumSha256: string;
  status: UploadStatus;
  expiresAt: string;
  createdAt: string;
}
export interface AssetRecord {
  id: string;
  projectId: string;
  uploadId: string;
  filename: string;
  mimeType: string;
  checksumSha256: string;
  storageKey: string;
  status: AssetStatus;
  widthPx: number;
  heightPx: number;
  bitDepth: 8 | 16;
  channelCount: 1 | 3 | 4;
  metadata: Record<string, unknown>;
  rejectionReason?: string;
  createdAt: string;
}
export interface AuditEvent {
  id: string;
  projectId: string;
  action: AuditAction;
  details: Record<string, unknown>;
  createdAt: string;
}
export interface ExportRecord {
  id: string;
  projectId: string;
  revision: number;
  format: "png";
  widthPx: number;
  heightPx: number;
  checksumSha256: string;
  createdAt: string;
}

export class NotFoundError extends Error {
  constructor() {
    super("Resource not found");
    this.name = "NotFoundError";
  }
}
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
export class UploadExpiredError extends Error {
  constructor() {
    super("Upload reservation has expired");
    this.name = "UploadExpiredError";
  }
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertResourceId(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new NotFoundError();
}
const timestamp = () => new Date().toISOString();
const defaultDocument = (id: string) => ({
  schemaVersion: 1,
  artboards: [{ id, name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" }],
  objects: [],
  groups: [],
  constraints: [],
  styles: [],
});

export interface Authorizer {
  requireWorkspace(principal: Principal, workspaceId: string): Promise<void>;
  requireProject(principal: Principal, project: ProjectRecord): Promise<void>;
}

export interface FigLabRepository {
  bootstrapSingleUser(): Promise<Principal>;
  createProject(workspaceId: string, name: string): Promise<ProjectRecord>;
  listProjects(workspaceId: string): Promise<ProjectRecord[]>;
  getProject(projectId: string): Promise<ProjectRecord>;
  renameProject(projectId: string, name: string): Promise<ProjectRecord>;
  markProjectDeleting(projectId: string): Promise<ProjectRecord>;
  getDocument(projectId: string): Promise<DocumentRecord>;
  saveDocument(
    projectId: string,
    baseRevision: number,
    document: unknown,
  ): Promise<
    { kind: "saved"; document: DocumentRecord } | { kind: "conflict"; currentRevision: number }
  >;
  createUpload(input: {
    projectId: string;
    filename: string;
    mimeType: string;
    contentLength: number;
    checksumSha256: string;
    storageKey: string;
    expiresAt?: string;
    assetId?: string;
  }): Promise<UploadRecord>;
  getUpload(id: string): Promise<UploadRecord>;
  getAsset(id: string): Promise<AssetRecord>;
  completeUpload(id: string): Promise<AssetRecord>;
  updateAsset(
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
  ): Promise<AssetRecord>;
  assertReadyAssets(projectId: string, ids: Iterable<string>): Promise<void>;
  recordExport(input: Omit<ExportRecord, "id" | "createdAt">): Promise<ExportRecord>;
  listAuditEvents(projectId: string): Promise<AuditEvent[]>;
  listProjectAssets(projectId: string): Promise<AssetRecord[]>;
  deleteProjectData(projectId: string): Promise<void>;
}
export class SingleUserAuthorizer implements Authorizer {
  async requireWorkspace(principal: Principal, workspaceId: string): Promise<void> {
    if (principal.workspaceId !== workspaceId) throw new NotFoundError();
  }
  async requireProject(principal: Principal, project: ProjectRecord): Promise<void> {
    await this.requireWorkspace(principal, project.workspaceId);
  }
}

export class InMemoryFigLabRepository implements FigLabRepository {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly assets = new Map<string, AssetRecord>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly exports: ExportRecord[] = [];
  private readonly queuedJobs: { name: string; payload: Record<string, unknown> }[] = [];
  private principal?: Principal;

  async bootstrapSingleUser(): Promise<Principal> {
    if (!this.principal)
      this.principal = {
        id: "00000000-0000-4000-8000-000000000001",
        email: "local-admin@figlab.invalid",
        workspaceId: "00000000-0000-4000-8000-000000000002",
      };
    return { ...this.principal };
  }
  async createProject(workspaceId: string, name: string): Promise<ProjectRecord> {
    const now = timestamp();
    const project = {
      id: randomUUID(),
      workspaceId,
      name,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.documents.set(project.id, {
      projectId: project.id,
      revision: 0,
      schemaVersion: 1,
      document: defaultDocument(randomUUID()),
      updatedAt: now,
    });
    this.recordAudit(project.id, "PROJECT_CREATED", { name });
    return { ...project };
  }
  async listProjects(workspaceId: string): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .filter((project) => project.workspaceId === workspaceId && project.status === "active")
      .map((project) => ({ ...project }));
  }
  async getProject(projectId: string): Promise<ProjectRecord> {
    const value = this.projects.get(projectId);
    if (!value) throw new NotFoundError();
    return { ...value };
  }
  async renameProject(projectId: string, name: string): Promise<ProjectRecord> {
    const project = await this.getProject(projectId);
    project.name = name;
    project.updatedAt = timestamp();
    this.projects.set(projectId, project);
    this.recordAudit(projectId, "PROJECT_RENAMED", { name });
    return { ...project };
  }
  async markProjectDeleting(projectId: string): Promise<ProjectRecord> {
    const project = await this.getProject(projectId);
    project.status = "deleting";
    project.updatedAt = timestamp();
    this.projects.set(projectId, project);
    this.enqueue("delete_project", { projectId });
    return { ...project };
  }
  async getDocument(projectId: string): Promise<DocumentRecord> {
    const value = this.documents.get(projectId);
    if (!value) throw new NotFoundError();
    return structuredClone(value);
  }
  async saveDocument(
    projectId: string,
    baseRevision: number,
    document: unknown,
  ): Promise<
    { kind: "saved"; document: DocumentRecord } | { kind: "conflict"; currentRevision: number }
  > {
    const old = await this.getDocument(projectId);
    if (old.revision !== baseRevision) return { kind: "conflict", currentRevision: old.revision };
    const updated = {
      ...old,
      revision: old.revision + 1,
      schemaVersion: 1,
      document: structuredClone(document),
      updatedAt: timestamp(),
    };
    this.documents.set(projectId, updated);
    this.recordAudit(projectId, "DOCUMENT_UPDATED", deriveDocumentDiff(old.document, document));
    return { kind: "saved", document: structuredClone(updated) };
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
    if ([...this.assets.values()].some((asset) => asset.storageKey === input.storageKey))
      throw new ConflictError("Storage key already exists");
    await this.getProject(input.projectId);
    const id = randomUUID();
    const assetId = input.assetId ?? randomUUID();
    const now = timestamp();
    const upload: UploadRecord = {
      id,
      projectId: input.projectId,
      assetId,
      contentLength: input.contentLength,
      checksumSha256: input.checksumSha256,
      status: "reserved",
      expiresAt: input.expiresAt ?? new Date(Date.now() + 600_000).toISOString(),
      createdAt: now,
    };
    this.uploads.set(id, upload);
    await this.createAssetForUpload(id, {
      filename: input.filename,
      mimeType: input.mimeType,
      checksumSha256: input.checksumSha256,
      storageKey: input.storageKey,
    });
    return { ...upload };
  }
  async createAssetForUpload(
    uploadId: string,
    input: { filename: string; mimeType: string; checksumSha256: string; storageKey: string },
  ): Promise<AssetRecord> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new NotFoundError();
    if ([...this.assets.values()].some((asset) => asset.uploadId === uploadId))
      throw new ConflictError("Upload already has an asset");
    const asset: AssetRecord = {
      id: upload.assetId,
      projectId: upload.projectId,
      uploadId,
      ...input,
      status: "pending-verification",
      widthPx: 1,
      heightPx: 1,
      bitDepth: 8,
      channelCount: 3,
      metadata: {},
      createdAt: timestamp(),
    };
    this.assets.set(asset.id, asset);
    return structuredClone(asset);
  }
  async getUpload(id: string): Promise<UploadRecord> {
    const upload = this.uploads.get(id);
    if (!upload) throw new NotFoundError();
    return { ...upload };
  }
  async getAsset(id: string): Promise<AssetRecord> {
    const asset = this.assets.get(id);
    if (!asset) throw new NotFoundError();
    return structuredClone(asset);
  }
  async completeUpload(id: string): Promise<AssetRecord> {
    const upload = await this.getUpload(id);
    const asset = await this.getAsset(upload.assetId);
    if (upload.status === "expired") throw new UploadExpiredError();
    if (upload.status === "reserved") {
      if (new Date(upload.expiresAt).getTime() <= Date.now()) {
        upload.status = "expired";
        this.uploads.set(id, upload);
        throw new UploadExpiredError();
      }
      upload.status = "verifying";
      this.uploads.set(id, upload);
      this.enqueue("verify_asset", { assetId: asset.id });
    }
    return asset;
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
    const asset = await this.getAsset(id);
    const next = { ...asset, ...update };
    this.assets.set(id, next);
    const upload = await this.getUpload(next.uploadId);
    if (next.status === "ready") {
      upload.status = "completed";
      this.recordAudit(next.projectId, "ASSET_UPLOADED", { assetId: id });
    } else if (next.status === "rejected") upload.status = "rejected";
    this.uploads.set(upload.id, upload);
    return structuredClone(next);
  }
  async assertReadyAssets(projectId: string, ids: Iterable<string>): Promise<void> {
    for (const id of ids) {
      const asset = await this.getAsset(id);
      if (asset.projectId !== projectId || asset.status !== "ready") throw new NotFoundError();
    }
  }
  async recordExport(input: Omit<ExportRecord, "id" | "createdAt">): Promise<ExportRecord> {
    const document = await this.getDocument(input.projectId);
    if (document.revision !== input.revision) throw new NotFoundError();
    const record = { ...input, id: randomUUID(), createdAt: timestamp() };
    this.exports.push(record);
    this.recordAudit(input.projectId, "EXPORT_CREATED", {
      exportId: record.id,
      revision: input.revision,
    });
    return { ...record };
  }
  async listAuditEvents(projectId: string): Promise<AuditEvent[]> {
    return this.auditEvents
      .filter((event) => event.projectId === projectId)
      .map((event) => structuredClone(event));
  }
  async listProjectAssets(projectId: string): Promise<AssetRecord[]> {
    return [...this.assets.values()]
      .filter((asset) => asset.projectId === projectId)
      .map((asset) => structuredClone(asset));
  }
  async deleteProjectData(projectId: string): Promise<void> {
    const project = await this.getProject(projectId);
    for (const asset of await this.listProjectAssets(projectId)) this.assets.delete(asset.id);
    for (const [id, upload] of this.uploads)
      if (upload.projectId === projectId) this.uploads.delete(id);
    this.documents.delete(projectId);
    this.projects.delete(projectId);
    this.recordAudit(projectId, "PROJECT_DELETED", { name: project.name });
  }
  enqueue(name: string, payload: Record<string, unknown>): void {
    this.queuedJobs.push({ name, payload });
  }
  async dequeue(): Promise<{ name: string; payload: Record<string, unknown> } | undefined> {
    return this.queuedJobs.shift();
  }
  private recordAudit(
    projectId: string,
    action: AuditAction,
    details: Record<string, unknown>,
  ): void {
    this.auditEvents.push({ id: randomUUID(), projectId, action, details, createdAt: timestamp() });
  }
}

function deriveDocumentDiff(before: unknown, after: unknown): Record<string, unknown> {
  const oldDocument = before as { objects?: unknown[]; artboards?: unknown[] };
  const newDocument = after as { objects?: unknown[]; artboards?: unknown[] };
  return {
    objectCountBefore: oldDocument.objects?.length ?? 0,
    objectCountAfter: newDocument.objects?.length ?? 0,
    artboardCountBefore: oldDocument.artboards?.length ?? 0,
    artboardCountAfter: newDocument.artboards?.length ?? 0,
  };
}

export { createPostgresRepository, PostgresFigLabRepository } from "./postgres.js";
