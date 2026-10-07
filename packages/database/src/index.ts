import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type AdminJob,
  type AdminOverview,
  type AdminUser,
  type AdminWorkspace,
  type CollaborationRepository,
  type CommentAnchor,
  type CommentRecord,
  type FolderRecord,
  ForbiddenError,
  type InvitePreview,
  type InviteRecord,
  type InviteRole,
  type InviteStatus,
  InviteUnavailableError,
  type ProjectFilter,
  type ProjectSearchHit,
  roleAllows,
  type TemplateRecord,
  type TemplateSummary,
  type WorkspaceAccess,
  type WorkspaceKind,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "./collaboration.js";

export * from "./collaboration.js";

export type ProjectStatus = "active" | "deleting" | "deleted";
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
  | "CROP_CREATED"
  | "CROP_CHANGED"
  | "DISPLAY_CHANGED"
  | "OBJECT_TRANSFORMED"
  | "OBJECT_REMOVED"
  | "OBJECT_CREATED"
  | "OBJECT_CHANGED"
  | "ARTBOARD_CREATED"
  | "ARTBOARD_CHANGED"
  | "ARTBOARD_REMOVED"
  | "GROUPS_CHANGED"
  | "ASSET_UPLOADED"
  | "EXPORT_CREATED"
  | "PROJECT_DELETION_REQUESTED"
  | "INTEGRITY_REPORT_REQUESTED"
  | "PROJECT_MOVED"
  | "COMMENT_ADDED"
  | "COMMENT_RESOLVED"
  | "COMMENT_REOPENED"
  | "COMMENT_DELETED"
  | "PROJECT_DELETED";

export type PrincipalRole = "admin" | "member";
export interface Principal {
  id: string;
  email: string;
  workspaceId: string;
  role?: PrincipalRole;
}
export interface AuthUserIdentity {
  id: string;
  email: string;
}
export interface ProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: ProjectStatus;
  folderId?: string;
  /** The user who created the project; absent for projects created before labs. */
  createdBy?: string;
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
  /** The user who caused the event; absent for background work and older events. */
  actor?: { id: string; email: string };
  /** Monotonic order across the whole trail; events from one save share `createdAt`. */
  sequence: number;
  createdAt: string;
}
export interface AuditEventPage {
  events: AuditEvent[];
  /** Pass as `beforeSequence` to read older events; absent on the last page. */
  nextBeforeSequence?: number;
}
export interface VersionSummary {
  revision: number;
  schemaVersion: number;
  createdAt: string;
}
export interface VersionRecord extends VersionSummary {
  projectId: string;
  document: unknown;
}
export type ExportFormat = "png" | "tiff" | "pdf" | "svg";
export interface ExportRecord {
  id: string;
  projectId: string;
  revision: number;
  format: ExportFormat;
  artboardId?: string;
  dpi?: number;
  widthPx: number;
  heightPx: number;
  checksumSha256: string;
  createdAt: string;
}
export type IntegrityReportStatus = "pending" | "ready" | "failed";
export interface IntegrityReportRecord {
  id: string;
  projectId: string;
  revision: number;
  status: IntegrityReportStatus;
  /** The report JSON once ready (see @figlab/image-processing `IntegrityReport`). */
  report?: unknown;
  error?: string;
  requestedBy?: string;
  createdAt: string;
  completedAt?: string;
}
/** Optional attribution for audited writes. */
export type ActorOptions = { actorUserId?: string };
export type CreateProjectOptions = ActorOptions & {
  folderId?: string;
  /** Starting document (for example from a template); the default empty figure otherwise. */
  document?: unknown;
};

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
  schemaVersion: 3,
  sources: [],
  artboards: [{ id, name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" }],
  objects: [],
  groups: [],
  constraints: [],
  styles: [],
});

/**
 * Membership checks. Non-members get `NotFoundError` (nothing is revealed); members whose role
 * is too low for the access get `ForbiddenError`. `access` defaults to `write`.
 */
export interface Authorizer {
  requireWorkspace(
    principal: Principal,
    workspaceId: string,
    access?: WorkspaceAccess,
  ): Promise<WorkspaceRole>;
  requireProject(
    principal: Principal,
    project: ProjectRecord,
    access?: WorkspaceAccess,
  ): Promise<WorkspaceRole>;
}

export interface FigLabRepository extends CollaborationRepository {
  bootstrapSingleUser(email?: string): Promise<Principal>;
  /** Records an externally authenticated user and provisions their personal workspace once. */
  ensureAuthUser(identity: AuthUserIdentity): Promise<Principal>;
  createProject(
    workspaceId: string,
    name: string,
    options?: CreateProjectOptions,
  ): Promise<ProjectRecord>;
  /** Active projects, oldest first. */
  listProjects(workspaceId: string, filter?: ProjectFilter): Promise<ProjectRecord[]>;
  /** Throws `NotFoundError` when the folder is not in the project's workspace. */
  moveProject(
    projectId: string,
    folderId: string | null,
    options?: ActorOptions,
  ): Promise<ProjectRecord>;
  /** Throws `NotFoundError` for missing and for deleted (tombstoned) projects. */
  getProject(projectId: string): Promise<ProjectRecord>;
  renameProject(projectId: string, name: string, options?: ActorOptions): Promise<ProjectRecord>;
  markProjectDeleting(projectId: string, options?: ActorOptions): Promise<ProjectRecord>;
  getDocument(projectId: string): Promise<DocumentRecord>;
  saveDocument(
    projectId: string,
    baseRevision: number,
    document: unknown,
    options?: ActorOptions,
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
  recordExport(
    input: Omit<ExportRecord, "id" | "createdAt">,
    options?: ActorOptions,
  ): Promise<ExportRecord>;
  listExports(projectId: string): Promise<ExportRecord[]>;
  /** Every event for a project, oldest first. */
  listAuditEvents(projectId: string): Promise<AuditEvent[]>;
  /** Newest-first page of events strictly older than `beforeSequence`. */
  pageAuditEvents(
    projectId: string,
    page: { limit: number; beforeSequence?: number },
  ): Promise<AuditEventPage>;
  /** Saved revisions, newest first, strictly older than `beforeRevision`. */
  listVersions(
    projectId: string,
    page: { limit: number; beforeRevision?: number },
  ): Promise<VersionSummary[]>;
  getVersion(projectId: string, revision: number): Promise<VersionRecord>;
  /** The document as saved at a revision: the current one, or a stored version. */
  getDocumentAtRevision(projectId: string, revision: number): Promise<DocumentRecord>;
  /** Records a pending report for a saved revision and enqueues the job that computes it. */
  requestIntegrityReport(
    projectId: string,
    revision: number,
    options?: ActorOptions,
  ): Promise<IntegrityReportRecord>;
  getIntegrityReport(id: string): Promise<IntegrityReportRecord>;
  /** Newest first. */
  listIntegrityReports(projectId: string, limit: number): Promise<IntegrityReportRecord[]>;
  completeIntegrityReport(
    id: string,
    outcome: { report: unknown } | { error: string },
  ): Promise<IntegrityReportRecord>;
  listProjectAssets(projectId: string): Promise<AssetRecord[]>;
  /**
   * Removes a project's content (documents, versions, uploads, assets) and leaves a tombstone:
   * the project row (status `deleted`), its audit events, and its export records remain.
   */
  deleteProjectData(projectId: string): Promise<void>;
}
/** Grants the principal's own (personal) workspace only, as its owner. */
export class SingleUserAuthorizer implements Authorizer {
  async requireWorkspace(principal: Principal, workspaceId: string): Promise<WorkspaceRole> {
    if (principal.workspaceId !== workspaceId) throw new NotFoundError();
    return "owner";
  }
  async requireProject(principal: Principal, project: ProjectRecord): Promise<WorkspaceRole> {
    return this.requireWorkspace(principal, project.workspaceId);
  }
}

/** Checks workspace membership roles; the principal's personal workspace needs no lookup. */
export class MembershipAuthorizer implements Authorizer {
  constructor(private readonly repository: Pick<CollaborationRepository, "getWorkspaceRole">) {}
  async requireWorkspace(
    principal: Principal,
    workspaceId: string,
    access: WorkspaceAccess = "write",
  ): Promise<WorkspaceRole> {
    assertResourceId(workspaceId);
    const role =
      principal.workspaceId === workspaceId
        ? "owner"
        : await this.repository.getWorkspaceRole(workspaceId, principal.id);
    if (!role) throw new NotFoundError();
    if (!roleAllows(role, access)) throw new ForbiddenError();
    return role;
  }
  async requireProject(
    principal: Principal,
    project: ProjectRecord,
    access: WorkspaceAccess = "write",
  ): Promise<WorkspaceRole> {
    return this.requireWorkspace(principal, project.workspaceId, access);
  }
}

export class InMemoryFigLabRepository implements FigLabRepository {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly assets = new Map<string, AssetRecord>();
  private readonly auditEvents: (Omit<AuditEvent, "actor"> & { actorUserId?: string })[] = [];
  private readonly versions: VersionRecord[] = [];
  private readonly exports: ExportRecord[] = [];
  private readonly integrityReports: IntegrityReportRecord[] = [];
  private nextSequence = 1;
  private readonly queuedJobs: { name: string; payload: Record<string, unknown> }[] = [];
  private readonly users = new Map<string, { id: string; email: string; createdAt: string }>();
  private readonly personalWorkspaces = new Map<string, string>();
  private readonly workspaces = new Map<
    string,
    { id: string; name: string; kind: WorkspaceKind; createdAt: string }
  >();
  private readonly members: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    createdAt: string;
  }[] = [];
  private readonly invites: {
    id: string;
    workspaceId: string;
    tokenSha256: string;
    role: InviteRole;
    email?: string;
    createdBy: string;
    expiresAt: string;
    acceptedBy?: string;
    revokedAt?: string;
    createdAt: string;
  }[] = [];
  private readonly folders = new Map<string, FolderRecord>();
  private readonly templates = new Map<
    string,
    Omit<TemplateRecord, "createdBy"> & { createdById?: string }
  >();
  private readonly comments = new Map<string, CommentRow>();

  async bootstrapSingleUser(email = "local-admin@figlab.invalid"): Promise<Principal> {
    const id = "00000000-0000-4000-8000-000000000001";
    const workspaceId = "00000000-0000-4000-8000-000000000002";
    const existing = this.users.get(id);
    if (!existing) {
      this.users.set(id, { id, email, createdAt: timestamp() });
      this.addPersonalWorkspace(id, workspaceId, "Default workspace");
    }
    return { id, email: existing?.email ?? email, workspaceId };
  }
  async ensureAuthUser(identity: AuthUserIdentity): Promise<Principal> {
    assertResourceId(identity.id);
    const existing = this.users.get(identity.id);
    this.users.set(identity.id, {
      id: identity.id,
      email: identity.email,
      createdAt: existing?.createdAt ?? timestamp(),
    });
    const workspaceId =
      this.personalWorkspaces.get(identity.id) ??
      this.addPersonalWorkspace(identity.id, randomUUID(), "Personal workspace");
    return { id: identity.id, email: identity.email, workspaceId };
  }
  private addPersonalWorkspace(userId: string, workspaceId: string, name: string): string {
    const createdAt = timestamp();
    this.workspaces.set(workspaceId, { id: workspaceId, name, kind: "personal", createdAt });
    this.members.push({ workspaceId, userId, role: "owner", createdAt });
    this.personalWorkspaces.set(userId, workspaceId);
    return workspaceId;
  }
  async createProject(
    workspaceId: string,
    name: string,
    options: CreateProjectOptions = {},
  ): Promise<ProjectRecord> {
    if (options.folderId) await this.folderIn(workspaceId, options.folderId);
    const now = timestamp();
    const project: ProjectRecord = {
      id: randomUUID(),
      workspaceId,
      name,
      status: "active",
      ...(options.folderId ? { folderId: options.folderId } : {}),
      ...(options.actorUserId ? { createdBy: options.actorUserId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const document = options.document ?? defaultDocument(randomUUID());
    this.projects.set(project.id, project);
    this.documents.set(project.id, {
      projectId: project.id,
      revision: 0,
      schemaVersion: schemaVersionOf(document),
      document: structuredClone(document),
      updatedAt: now,
    });
    this.recordAudit(project.id, "PROJECT_CREATED", { name }, options.actorUserId);
    return { ...project };
  }
  async listProjects(workspaceId: string, filter: ProjectFilter = {}): Promise<ProjectRecord[]> {
    const query = filter.query?.trim().toLowerCase();
    return [...this.projects.values()]
      .filter(
        (project) =>
          project.workspaceId === workspaceId &&
          project.status === "active" &&
          (!query || project.name.toLowerCase().includes(query)) &&
          (filter.folderId === undefined || (project.folderId ?? null) === filter.folderId) &&
          (!filter.createdBy || project.createdBy === filter.createdBy),
      )
      .map((project) => ({ ...project }));
  }
  async moveProject(
    projectId: string,
    folderId: string | null,
    options: ActorOptions = {},
  ): Promise<ProjectRecord> {
    const project = await this.getProject(projectId);
    if (folderId) await this.folderIn(project.workspaceId, folderId);
    const { folderId: _previous, ...rest } = project;
    const moved: ProjectRecord = {
      ...rest,
      ...(folderId ? { folderId } : {}),
      updatedAt: timestamp(),
    };
    this.projects.set(projectId, moved);
    this.recordAudit(projectId, "PROJECT_MOVED", { folderId }, options.actorUserId);
    return { ...moved };
  }
  private async folderIn(workspaceId: string, folderId: string): Promise<FolderRecord> {
    const folder = await this.getFolder(folderId);
    if (folder.workspaceId !== workspaceId) throw new NotFoundError();
    return folder;
  }
  async getProject(projectId: string): Promise<ProjectRecord> {
    const value = this.projects.get(projectId);
    if (!value || value.status === "deleted") throw new NotFoundError();
    return { ...value };
  }
  async renameProject(
    projectId: string,
    name: string,
    options: ActorOptions = {},
  ): Promise<ProjectRecord> {
    const project = await this.getProject(projectId);
    project.name = name;
    project.updatedAt = timestamp();
    this.projects.set(projectId, project);
    this.recordAudit(projectId, "PROJECT_RENAMED", { name }, options.actorUserId);
    return { ...project };
  }
  async markProjectDeleting(projectId: string, options: ActorOptions = {}): Promise<ProjectRecord> {
    const project = await this.getProject(projectId);
    project.status = "deleting";
    project.updatedAt = timestamp();
    this.projects.set(projectId, project);
    this.recordAudit(projectId, "PROJECT_DELETION_REQUESTED", {}, options.actorUserId);
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
    options: ActorOptions = {},
  ): Promise<
    { kind: "saved"; document: DocumentRecord } | { kind: "conflict"; currentRevision: number }
  > {
    const old = await this.getDocument(projectId);
    if (old.revision !== baseRevision) return { kind: "conflict", currentRevision: old.revision };
    const updated = {
      ...old,
      revision: old.revision + 1,
      schemaVersion: schemaVersionOf(document),
      document: structuredClone(document),
      updatedAt: timestamp(),
    };
    this.documents.set(projectId, updated);
    this.versions.push({
      projectId,
      revision: updated.revision,
      schemaVersion: updated.schemaVersion,
      document: structuredClone(document),
      createdAt: updated.updatedAt,
    });
    const actor = options.actorUserId;
    this.recordAudit(
      projectId,
      "DOCUMENT_UPDATED",
      deriveDocumentDiff(old.document, document),
      actor,
    );
    for (const event of deriveDocumentAuditEvents(old.document, document))
      this.recordAudit(projectId, event.action, event.details, actor);
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
  async recordExport(
    input: Omit<ExportRecord, "id" | "createdAt">,
    options: ActorOptions = {},
  ): Promise<ExportRecord> {
    const document = await this.getDocument(input.projectId);
    if (document.revision !== input.revision) throw new NotFoundError();
    const record = { ...input, id: randomUUID(), createdAt: timestamp() };
    this.exports.push(record);
    this.recordAudit(
      input.projectId,
      "EXPORT_CREATED",
      exportAuditDetails(record),
      options.actorUserId,
    );
    return { ...record };
  }
  async listExports(projectId: string): Promise<ExportRecord[]> {
    return this.exports
      .filter((record) => record.projectId === projectId)
      .reverse()
      .map((record) => ({ ...record }));
  }
  async listAuditEvents(projectId: string): Promise<AuditEvent[]> {
    return this.auditEvents
      .filter((event) => event.projectId === projectId)
      .map((event) => this.withActor(event));
  }
  async pageAuditEvents(
    projectId: string,
    page: { limit: number; beforeSequence?: number },
  ): Promise<AuditEventPage> {
    const matching = this.auditEvents
      .filter(
        (event) =>
          event.projectId === projectId &&
          (page.beforeSequence === undefined || event.sequence < page.beforeSequence),
      )
      .reverse();
    const events = matching.slice(0, page.limit).map((event) => this.withActor(event));
    const last = events.at(-1);
    return matching.length > page.limit && last
      ? { events, nextBeforeSequence: last.sequence }
      : { events };
  }
  async listVersions(
    projectId: string,
    page: { limit: number; beforeRevision?: number },
  ): Promise<VersionSummary[]> {
    return this.versions
      .filter(
        (version) =>
          version.projectId === projectId &&
          (page.beforeRevision === undefined || version.revision < page.beforeRevision),
      )
      .reverse()
      .slice(0, page.limit)
      .map(({ revision, schemaVersion, createdAt }) => ({ revision, schemaVersion, createdAt }));
  }
  async getVersion(projectId: string, revision: number): Promise<VersionRecord> {
    const version = this.versions.find(
      (candidate) => candidate.projectId === projectId && candidate.revision === revision,
    );
    if (!version) throw new NotFoundError();
    return structuredClone(version);
  }
  async listProjectAssets(projectId: string): Promise<AssetRecord[]> {
    return [...this.assets.values()]
      .filter((asset) => asset.projectId === projectId)
      .map((asset) => structuredClone(asset));
  }
  async getDocumentAtRevision(projectId: string, revision: number): Promise<DocumentRecord> {
    const current = await this.getDocument(projectId);
    if (current.revision === revision) return current;
    const version = await this.getVersion(projectId, revision);
    return {
      projectId,
      revision: version.revision,
      schemaVersion: version.schemaVersion,
      document: version.document,
      updatedAt: version.createdAt,
    };
  }
  async requestIntegrityReport(
    projectId: string,
    revision: number,
    options: ActorOptions = {},
  ): Promise<IntegrityReportRecord> {
    await this.getDocumentAtRevision(projectId, revision);
    const record: IntegrityReportRecord = {
      id: randomUUID(),
      projectId,
      revision,
      status: "pending",
      ...(options.actorUserId ? { requestedBy: options.actorUserId } : {}),
      createdAt: timestamp(),
    };
    this.integrityReports.push(record);
    this.recordAudit(
      projectId,
      "INTEGRITY_REPORT_REQUESTED",
      { reportId: record.id, revision },
      options.actorUserId,
    );
    this.enqueue("integrity_report", { reportId: record.id });
    return structuredClone(record);
  }
  async getIntegrityReport(id: string): Promise<IntegrityReportRecord> {
    const record = this.integrityReports.find((candidate) => candidate.id === id);
    if (!record) throw new NotFoundError();
    return structuredClone(record);
  }
  async listIntegrityReports(projectId: string, limit: number): Promise<IntegrityReportRecord[]> {
    return this.integrityReports
      .filter((record) => record.projectId === projectId)
      .reverse()
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
  async completeIntegrityReport(
    id: string,
    outcome: { report: unknown } | { error: string },
  ): Promise<IntegrityReportRecord> {
    const record = this.integrityReports.find((candidate) => candidate.id === id);
    if (!record) throw new NotFoundError();
    Object.assign(
      record,
      "report" in outcome
        ? { status: "ready", report: structuredClone(outcome.report) }
        : { status: "failed", error: outcome.error },
      { completedAt: timestamp() },
    );
    return structuredClone(record);
  }
  async deleteProjectData(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) throw new NotFoundError();
    if (project.status === "deleted") return;
    for (const asset of await this.listProjectAssets(projectId)) this.assets.delete(asset.id);
    for (const [id, upload] of this.uploads)
      if (upload.projectId === projectId) this.uploads.delete(id);
    this.documents.delete(projectId);
    for (let index = this.versions.length - 1; index >= 0; index -= 1)
      if (this.versions[index]?.projectId === projectId) this.versions.splice(index, 1);
    for (const [id, comment] of this.comments)
      if (comment.projectId === projectId) this.comments.delete(id);
    this.projects.set(projectId, { ...project, status: "deleted", updatedAt: timestamp() });
    this.recordAudit(projectId, "PROJECT_DELETED", { name: project.name });
  }
  // Workspaces and members
  async getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined> {
    return this.members.find(
      (member) => member.workspaceId === workspaceId && member.userId === userId,
    )?.role;
  }
  async getWorkspace(
    workspaceId: string,
  ): Promise<{ id: string; name: string; kind: WorkspaceKind }> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new NotFoundError();
    return { id: workspace.id, name: workspace.name, kind: workspace.kind };
  }
  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    return this.members
      .filter((member) => member.userId === userId)
      .map((member) => this.workspaceSummary(member.workspaceId, member.role))
      .sort(byWorkspaceOrder);
  }
  private workspaceSummary(workspaceId: string, role: WorkspaceRole): WorkspaceSummary {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new NotFoundError();
    return {
      ...workspace,
      role,
      memberCount: this.members.filter((member) => member.workspaceId === workspaceId).length,
    };
  }
  async createLabWorkspace(userId: string, name: string): Promise<WorkspaceSummary> {
    const id = randomUUID();
    const createdAt = timestamp();
    this.workspaces.set(id, { id, name, kind: "lab", createdAt });
    this.members.push({ workspaceId: id, userId, role: "owner", createdAt });
    return this.workspaceSummary(id, "owner");
  }
  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new NotFoundError();
    workspace.name = name;
  }
  async deleteLabWorkspace(workspaceId: string): Promise<void> {
    if (this.workspaces.get(workspaceId)?.kind !== "lab") throw new NotFoundError();
    if (
      [...this.projects.values()].some(
        (project) => project.workspaceId === workspaceId && project.status !== "deleted",
      )
    )
      throw new ConflictError("Delete or move the lab's projects first");
    for (let index = this.members.length - 1; index >= 0; index -= 1)
      if (this.members[index]?.workspaceId === workspaceId) this.members.splice(index, 1);
    for (let index = this.invites.length - 1; index >= 0; index -= 1)
      if (this.invites[index]?.workspaceId === workspaceId) this.invites.splice(index, 1);
    for (const [id, folder] of this.folders)
      if (folder.workspaceId === workspaceId) this.folders.delete(id);
    for (const [id, template] of this.templates)
      if (template.workspaceId === workspaceId) this.templates.delete(id);
    for (const [id, project] of this.projects)
      if (project.workspaceId === workspaceId && project.folderId) {
        const { folderId: _gone, ...rest } = project;
        this.projects.set(id, rest);
      }
    this.workspaces.delete(workspaceId);
  }
  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.members
      .filter((member) => member.workspaceId === workspaceId)
      .map((member) => this.memberRecord(member));
  }
  private memberRecord(member: (typeof this.members)[number]): WorkspaceMember {
    return {
      userId: member.userId,
      email: this.users.get(member.userId)?.email ?? "",
      role: member.role,
      joinedAt: member.createdAt,
    };
  }
  async setMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember> {
    const member = this.members.find(
      (entry) => entry.workspaceId === workspaceId && entry.userId === userId,
    );
    if (!member) throw new NotFoundError();
    if (member.role === "owner" && role !== "owner") this.assertAnotherOwner(workspaceId, userId);
    member.role = role;
    return this.memberRecord(member);
  }
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const index = this.members.findIndex(
      (entry) => entry.workspaceId === workspaceId && entry.userId === userId,
    );
    const member = this.members[index];
    if (!member) throw new NotFoundError();
    if (member.role === "owner") this.assertAnotherOwner(workspaceId, userId);
    this.members.splice(index, 1);
  }
  private assertAnotherOwner(workspaceId: string, userId: string): void {
    if (
      !this.members.some(
        (entry) =>
          entry.workspaceId === workspaceId && entry.userId !== userId && entry.role === "owner",
      )
    )
      throw new ConflictError("A workspace needs at least one owner");
  }
  async createInvite(input: {
    workspaceId: string;
    role: InviteRole;
    email?: string;
    createdBy: string;
    tokenSha256: string;
    expiresAt: string;
  }): Promise<InviteRecord> {
    const invite = { id: randomUUID(), createdAt: timestamp(), ...input };
    this.invites.push(invite);
    return this.inviteRecord(invite);
  }
  private inviteStatus(invite: (typeof this.invites)[number]): InviteStatus {
    if (invite.acceptedBy) return "accepted";
    if (invite.revokedAt) return "revoked";
    return Date.parse(invite.expiresAt) <= Date.now() ? "expired" : "pending";
  }
  private userRef(id: string): { id: string; email: string } {
    return { id, email: this.users.get(id)?.email ?? "" };
  }
  private inviteRecord(invite: (typeof this.invites)[number]): InviteRecord {
    return {
      id: invite.id,
      workspaceId: invite.workspaceId,
      role: invite.role,
      ...(invite.email ? { email: invite.email } : {}),
      createdBy: this.userRef(invite.createdBy),
      ...(invite.acceptedBy ? { acceptedBy: this.userRef(invite.acceptedBy) } : {}),
      status: this.inviteStatus(invite),
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    };
  }
  async listInvites(workspaceId: string): Promise<InviteRecord[]> {
    return this.invites
      .filter((invite) => invite.workspaceId === workspaceId)
      .reverse()
      .map((invite) => this.inviteRecord(invite));
  }
  async revokeInvite(workspaceId: string, inviteId: string): Promise<InviteRecord> {
    const invite = this.invites.find(
      (entry) => entry.id === inviteId && entry.workspaceId === workspaceId,
    );
    if (!invite) throw new NotFoundError();
    if (!invite.acceptedBy && !invite.revokedAt) invite.revokedAt = timestamp();
    return this.inviteRecord(invite);
  }
  async previewInvite(tokenSha256: string): Promise<InvitePreview> {
    const invite = this.invites.find((entry) => entry.tokenSha256 === tokenSha256);
    if (!invite) throw new NotFoundError();
    const workspace = await this.getWorkspace(invite.workspaceId);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      role: invite.role,
      ...(invite.email ? { email: invite.email } : {}),
      status: this.inviteStatus(invite),
      expiresAt: invite.expiresAt,
    };
  }
  async acceptInvite(
    tokenSha256: string,
    user: { id: string; email: string },
  ): Promise<WorkspaceSummary> {
    const invite = this.invites.find((entry) => entry.tokenSha256 === tokenSha256);
    if (!invite) throw new NotFoundError();
    const existing = await this.getWorkspaceRole(invite.workspaceId, user.id);
    if (existing) return this.workspaceSummary(invite.workspaceId, existing);
    assertInviteUsable(this.inviteStatus(invite), invite.email, user.email);
    invite.acceptedBy = user.id;
    this.members.push({
      workspaceId: invite.workspaceId,
      userId: user.id,
      role: invite.role,
      createdAt: timestamp(),
    });
    return this.workspaceSummary(invite.workspaceId, invite.role);
  }

  // Folders and search
  async listFolders(workspaceId: string): Promise<FolderRecord[]> {
    return [...this.folders.values()]
      .filter((folder) => folder.workspaceId === workspaceId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((folder) => ({ ...folder }));
  }
  async getFolder(folderId: string): Promise<FolderRecord> {
    const folder = this.folders.get(folderId);
    if (!folder) throw new NotFoundError();
    return { ...folder };
  }
  async createFolder(workspaceId: string, name: string, parentId?: string): Promise<FolderRecord> {
    if (parentId) await this.folderIn(workspaceId, parentId);
    const now = timestamp();
    const folder: FolderRecord = {
      id: randomUUID(),
      workspaceId,
      ...(parentId ? { parentId } : {}),
      name,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.folders.set(folder.id, folder);
    return { ...folder };
  }
  async updateFolder(
    folderId: string,
    patch: { name?: string; parentId?: string | null; archived?: boolean },
  ): Promise<FolderRecord> {
    const folder = await this.getFolder(folderId);
    if (patch.parentId) {
      await this.folderIn(folder.workspaceId, patch.parentId);
      for (let cursor: string | undefined = patch.parentId; cursor; ) {
        if (cursor === folderId) throw new ConflictError("A folder cannot move into itself");
        cursor = this.folders.get(cursor)?.parentId;
      }
    }
    const { parentId: previousParent, ...rest } = folder;
    const parentId = patch.parentId === undefined ? previousParent : (patch.parentId ?? undefined);
    const updated: FolderRecord = {
      ...rest,
      ...(parentId ? { parentId } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      updatedAt: timestamp(),
    };
    this.folders.set(folderId, updated);
    return { ...updated };
  }
  async searchProjects(userId: string, query: string, limit: number): Promise<ProjectSearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: ProjectSearchHit[] = [];
    for (const membership of this.members.filter((member) => member.userId === userId)) {
      const workspace = this.workspaces.get(membership.workspaceId);
      if (!workspace) continue;
      for (const project of this.projects.values()) {
        if (project.workspaceId !== workspace.id || project.status !== "active") continue;
        const matchedFilenames = [...this.assets.values()]
          .filter(
            (asset) =>
              asset.projectId === project.id && asset.filename.toLowerCase().includes(needle),
          )
          .map((asset) => asset.filename);
        if (!project.name.toLowerCase().includes(needle) && matchedFilenames.length === 0) continue;
        hits.push({
          projectId: project.id,
          projectName: project.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          ...(project.folderId ? { folderId: project.folderId } : {}),
          matchedFilenames,
          updatedAt: project.updatedAt,
        });
      }
    }
    return hits
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  // Templates
  async createTemplate(input: {
    workspaceId: string;
    name: string;
    document: unknown;
    createdBy: string;
  }): Promise<TemplateSummary> {
    const template = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      schemaVersion: schemaVersionOf(input.document),
      document: structuredClone(input.document),
      createdById: input.createdBy,
      createdAt: timestamp(),
    };
    this.templates.set(template.id, template);
    return this.templateSummary(template);
  }
  private templateSummary(
    template: Omit<TemplateRecord, "createdBy"> & { createdById?: string },
  ): TemplateSummary {
    return {
      id: template.id,
      workspaceId: template.workspaceId,
      name: template.name,
      ...(template.createdById ? { createdBy: this.userRef(template.createdById) } : {}),
      createdAt: template.createdAt,
    };
  }
  async listTemplates(workspaceId: string): Promise<TemplateSummary[]> {
    return [...this.templates.values()]
      .filter((template) => template.workspaceId === workspaceId)
      .reverse()
      .map((template) => this.templateSummary(template));
  }
  async getTemplate(templateId: string): Promise<TemplateRecord> {
    const template = this.templates.get(templateId);
    if (!template) throw new NotFoundError();
    return {
      ...this.templateSummary(template),
      schemaVersion: template.schemaVersion,
      document: structuredClone(template.document),
    };
  }
  async deleteTemplate(templateId: string): Promise<void> {
    if (!this.templates.delete(templateId)) throw new NotFoundError();
  }

  // Comments
  async createComment(input: {
    projectId: string;
    authorUserId: string;
    body: string;
    parentId?: string;
    anchor?: CommentAnchor;
  }): Promise<CommentRecord> {
    if (input.parentId) {
      const parent = await this.getComment(input.parentId);
      if (parent.projectId !== input.projectId || parent.parentId) throw new NotFoundError();
    }
    const now = timestamp();
    const comment = {
      id: randomUUID(),
      projectId: input.projectId,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      authorId: input.authorUserId,
      ...(input.anchor ? { anchor: { ...input.anchor } } : {}),
      body: input.body,
      createdAt: now,
      updatedAt: now,
    };
    this.comments.set(comment.id, comment);
    this.recordAudit(
      input.projectId,
      "COMMENT_ADDED",
      { commentId: comment.id, ...(input.parentId ? { parentId: input.parentId } : {}) },
      input.authorUserId,
    );
    return this.commentRecord(comment);
  }
  private commentRecord(comment: CommentRow): CommentRecord {
    const { authorId, resolvedById, ...rest } = structuredClone(comment);
    return {
      ...rest,
      author: this.userRef(authorId),
      ...(resolvedById ? { resolvedBy: this.userRef(resolvedById) } : {}),
    };
  }
  async listComments(projectId: string): Promise<CommentRecord[]> {
    return [...this.comments.values()]
      .filter((comment) => comment.projectId === projectId)
      .map((comment) => this.commentRecord(comment));
  }
  async getComment(commentId: string): Promise<CommentRecord> {
    const comment = this.comments.get(commentId);
    if (!comment) throw new NotFoundError();
    return this.commentRecord(comment);
  }
  async updateComment(
    commentId: string,
    patch: { body?: string; resolvedBy?: string | null },
    actorUserId: string,
  ): Promise<CommentRecord> {
    const comment = this.comments.get(commentId);
    if (!comment) throw new NotFoundError();
    const now = timestamp();
    if (patch.body !== undefined) comment.body = patch.body;
    if (patch.resolvedBy !== undefined) {
      const wasResolved = comment.resolvedAt !== undefined;
      if (patch.resolvedBy) {
        comment.resolvedAt = now;
        comment.resolvedById = patch.resolvedBy;
      } else {
        delete comment.resolvedAt;
        delete comment.resolvedById;
      }
      if (wasResolved !== Boolean(patch.resolvedBy))
        this.recordAudit(
          comment.projectId,
          patch.resolvedBy ? "COMMENT_RESOLVED" : "COMMENT_REOPENED",
          { commentId },
          actorUserId,
        );
    }
    comment.updatedAt = now;
    return this.commentRecord(comment);
  }
  async deleteComment(commentId: string, actorUserId: string): Promise<void> {
    const comment = this.comments.get(commentId);
    if (!comment) throw new NotFoundError();
    for (const [id, reply] of this.comments)
      if (reply.parentId === commentId) this.comments.delete(id);
    this.comments.delete(commentId);
    this.recordAudit(comment.projectId, "COMMENT_DELETED", { commentId }, actorUserId);
  }

  // Admin
  async adminOverview(): Promise<AdminOverview> {
    const workspaces = [...this.workspaces.values()];
    const projects = [...this.projects.values()].filter((project) => project.status === "active");
    const assets = [...this.assets.values()].filter((asset) => asset.status === "ready");
    return {
      users: this.users.size,
      personalWorkspaces: workspaces.filter((workspace) => workspace.kind === "personal").length,
      labWorkspaces: workspaces.filter((workspace) => workspace.kind === "lab").length,
      projects: projects.length,
      assets: assets.length,
      storageBytes: assets.reduce((sum, asset) => sum + this.assetBytes(asset), 0),
      pendingIntegrityReports: this.integrityReports.filter((report) => report.status === "pending")
        .length,
      failedJobs: 0,
    };
  }
  private assetBytes(asset: AssetRecord): number {
    return this.uploads.get(asset.uploadId)?.contentLength ?? 0;
  }
  async adminUsers(limit: number): Promise<AdminUser[]> {
    return [...this.users.values()].slice(0, limit).map((user) => {
      const workspaceIds = this.members
        .filter((member) => member.userId === user.id)
        .map((member) => member.workspaceId);
      return {
        ...user,
        workspaces: workspaceIds.length,
        projects: [...this.projects.values()].filter(
          (project) => project.status === "active" && project.createdBy === user.id,
        ).length,
      };
    });
  }
  async adminWorkspaces(limit: number): Promise<AdminWorkspace[]> {
    return [...this.workspaces.values()].slice(0, limit).map((workspace) => {
      const projectIds = new Set(
        [...this.projects.values()]
          .filter((project) => project.workspaceId === workspace.id && project.status === "active")
          .map((project) => project.id),
      );
      const assets = [...this.assets.values()].filter(
        (asset) => projectIds.has(asset.projectId) && asset.status === "ready",
      );
      return {
        ...workspace,
        members: this.members.filter((member) => member.workspaceId === workspace.id).length,
        projects: projectIds.size,
        assets: assets.length,
        storageBytes: assets.reduce((sum, asset) => sum + this.assetBytes(asset), 0),
      };
    });
  }
  async adminFailedJobs(_limit: number): Promise<AdminJob[]> {
    return [];
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
    actorUserId?: string,
  ): void {
    this.auditEvents.push({
      id: randomUUID(),
      projectId,
      action,
      details,
      sequence: this.nextSequence++,
      createdAt: timestamp(),
      ...(actorUserId ? { actorUserId } : {}),
    });
  }
  private withActor(event: (typeof this.auditEvents)[number]): AuditEvent {
    const { actorUserId, ...rest } = structuredClone(event);
    const actor = actorUserId ? this.users.get(actorUserId) : undefined;
    return actor ? { ...rest, actor: { id: actor.id, email: actor.email } } : rest;
  }
}

type CommentRow = Omit<CommentRecord, "author" | "resolvedBy"> & {
  authorId: string;
  resolvedById?: string;
};

/** Personal workspace first, then labs by name. */
export function byWorkspaceOrder(left: WorkspaceSummary, right: WorkspaceSummary): number {
  if (left.kind !== right.kind) return left.kind === "personal" ? -1 : 1;
  return left.name.localeCompare(right.name) || left.createdAt.localeCompare(right.createdAt);
}

/** Throws unless a pending invite may be used by a user with this email. */
export function assertInviteUsable(
  status: InviteStatus,
  inviteEmail: string | undefined,
  userEmail: string,
): void {
  if (status === "expired")
    throw new InviteUnavailableError("expired", "This invite link has expired; ask for a new one");
  if (status === "revoked")
    throw new InviteUnavailableError("revoked", "This invite link was revoked");
  if (status === "accepted")
    throw new InviteUnavailableError("accepted", "This invite link has already been used");
  if (inviteEmail && inviteEmail.toLowerCase() !== userEmail.toLowerCase())
    throw new InviteUnavailableError(
      "email-mismatch",
      `This invite is for ${inviteEmail}; sign in with that account to accept it`,
    );
}

export function schemaVersionOf(document: unknown): number {
  const version = (document as { schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof version === "number" ? version : 1;
}

export function deriveDocumentDiff(before: unknown, after: unknown): Record<string, unknown> {
  const oldDocument = before as { objects?: unknown[]; artboards?: unknown[] };
  const newDocument = after as { objects?: unknown[]; artboards?: unknown[] };
  return {
    objectCountBefore: oldDocument.objects?.length ?? 0,
    objectCountAfter: newDocument.objects?.length ?? 0,
    artboardCountBefore: oldDocument.artboards?.length ?? 0,
    artboardCountAfter: newDocument.artboards?.length ?? 0,
  };
}

export function exportAuditDetails(record: ExportRecord): Record<string, unknown> {
  return {
    exportId: record.id,
    revision: record.revision,
    format: record.format,
    widthPx: record.widthPx,
    heightPx: record.heightPx,
    checksumSha256: record.checksumSha256,
    ...(record.artboardId === undefined ? {} : { artboardId: record.artboardId }),
    ...(record.dpi === undefined ? {} : { dpi: record.dpi }),
  };
}

type AuditableObject = {
  id: string;
  type?: string;
  transform: unknown;
  view?: { viewport: unknown; display: unknown };
} & Record<string, unknown>;
type AuditEventDraft = { action: AuditAction; details: Record<string, unknown> };

/**
 * Derives audit events from two stored documents, so the trail reflects what was saved rather
 * than what a client claims it did. Image views report crop, display, and transform changes
 * separately; other objects report creation, content/style changes, and transforms.
 */
export function deriveDocumentAuditEvents(before: unknown, after: unknown): AuditEventDraft[] {
  const prior = documentObjects(before);
  const next = documentObjects(after);
  const events: AuditEventDraft[] = [];

  for (const [objectId, object] of next) {
    const old = prior.get(objectId);
    const isView = object.view !== undefined;
    if (!old) {
      events.push(
        isView
          ? {
              action: "CROP_CREATED",
              details: { objectId, viewport: structuredClone(object.view?.viewport) },
            }
          : {
              action: "OBJECT_CREATED",
              details: { objectId, type: object.type, object: structuredClone(object) },
            },
      );
      continue;
    }
    if (isView && old.view) {
      if (!sameValue(old.view.viewport, object.view?.viewport))
        events.push({
          action: "CROP_CHANGED",
          details: {
            objectId,
            before: structuredClone(old.view.viewport),
            after: structuredClone(object.view?.viewport),
          },
        });
      if (!sameValue(old.view.display, object.view?.display))
        events.push({
          action: "DISPLAY_CHANGED",
          details: {
            objectId,
            before: structuredClone(old.view.display),
            after: structuredClone(object.view?.display),
          },
        });
    }
    const oldRest = withoutKeys(old, ["transform", "view"]);
    const newRest = withoutKeys(object, ["transform", "view"]);
    if (!sameValue(oldRest, newRest))
      events.push({
        action: "OBJECT_CHANGED",
        details: { objectId, ...changedFields(oldRest, newRest) },
      });
    if (!sameValue(old.transform, object.transform))
      events.push({
        action: "OBJECT_TRANSFORMED",
        details: {
          objectId,
          before: structuredClone(old.transform),
          after: structuredClone(object.transform),
        },
      });
  }
  for (const objectId of prior.keys())
    if (!next.has(objectId)) events.push({ action: "OBJECT_REMOVED", details: { objectId } });

  const priorBoards = documentArtboards(before);
  const nextBoards = documentArtboards(after);
  for (const [artboardId, artboard] of nextBoards) {
    const old = priorBoards.get(artboardId);
    if (!old)
      events.push({
        action: "ARTBOARD_CREATED",
        details: { artboardId, artboard: structuredClone(artboard) },
      });
    else if (!sameValue(old, artboard))
      events.push({
        action: "ARTBOARD_CHANGED",
        details: { artboardId, ...changedFields(old, artboard) },
      });
  }
  for (const artboardId of priorBoards.keys())
    if (!nextBoards.has(artboardId))
      events.push({ action: "ARTBOARD_REMOVED", details: { artboardId } });

  const priorGroups = arrayField(before, "groups");
  const nextGroups = arrayField(after, "groups");
  if (!sameValue(priorGroups, nextGroups))
    events.push({
      action: "GROUPS_CHANGED",
      details: { before: structuredClone(priorGroups), after: structuredClone(nextGroups) },
    });

  return events;
}

function documentObjects(document: unknown): Map<string, AuditableObject> {
  return new Map(
    arrayField(document, "objects")
      .filter(
        (object): object is AuditableObject =>
          typeof object === "object" &&
          object !== null &&
          "id" in object &&
          typeof object.id === "string" &&
          "transform" in object,
      )
      .map((object) => [object.id, object]),
  );
}

function documentArtboards(document: unknown): Map<string, Record<string, unknown>> {
  return new Map(
    arrayField(document, "artboards")
      .filter(
        (artboard): artboard is Record<string, unknown> & { id: string } =>
          typeof artboard === "object" &&
          artboard !== null &&
          "id" in artboard &&
          typeof artboard.id === "string",
      )
      .map((artboard) => [artboard.id, artboard]),
  );
}

function arrayField(document: unknown, key: string): unknown[] {
  if (typeof document !== "object" || document === null || !(key in document)) return [];
  const value = (document as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function withoutKeys(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** Before/after values of only the top-level fields that differ. */
function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => !sameValue(before[key], after[key]),
  );
  return {
    before: structuredClone(Object.fromEntries(keys.map((key) => [key, before[key]]))),
    after: structuredClone(Object.fromEntries(keys.map((key) => [key, after[key]]))),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export {
  createPgPool,
  createPostgresRepository,
  type PgPoolOptions,
  PostgresFigLabRepository,
} from "./postgres.js";
