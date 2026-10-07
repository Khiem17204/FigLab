import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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

export interface Authorizer {
  requireWorkspace(principal: Principal, workspaceId: string): Promise<void>;
  requireProject(principal: Principal, project: ProjectRecord): Promise<void>;
}

export interface FigLabRepository {
  bootstrapSingleUser(email?: string): Promise<Principal>;
  /** Records an externally authenticated user and provisions their personal workspace once. */
  ensureAuthUser(identity: AuthUserIdentity): Promise<Principal>;
  createProject(workspaceId: string, name: string, options?: ActorOptions): Promise<ProjectRecord>;
  listProjects(workspaceId: string): Promise<ProjectRecord[]>;
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
  private readonly auditEvents: (Omit<AuditEvent, "actor"> & { actorUserId?: string })[] = [];
  private readonly versions: VersionRecord[] = [];
  private readonly exports: ExportRecord[] = [];
  private readonly integrityReports: IntegrityReportRecord[] = [];
  private nextSequence = 1;
  private readonly queuedJobs: { name: string; payload: Record<string, unknown> }[] = [];
  private principal?: Principal;
  private readonly authUsers = new Map<string, Principal>();

  async bootstrapSingleUser(email = "local-admin@figlab.invalid"): Promise<Principal> {
    if (!this.principal)
      this.principal = {
        id: "00000000-0000-4000-8000-000000000001",
        email,
        workspaceId: "00000000-0000-4000-8000-000000000002",
      };
    return { ...this.principal };
  }
  async ensureAuthUser(identity: AuthUserIdentity): Promise<Principal> {
    assertResourceId(identity.id);
    const existing = this.authUsers.get(identity.id);
    const principal = {
      id: identity.id,
      email: identity.email,
      workspaceId: existing?.workspaceId ?? randomUUID(),
    };
    this.authUsers.set(identity.id, principal);
    return { ...principal };
  }
  async createProject(
    workspaceId: string,
    name: string,
    options: ActorOptions = {},
  ): Promise<ProjectRecord> {
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
      schemaVersion: 3,
      document: defaultDocument(randomUUID()),
      updatedAt: now,
    });
    this.recordAudit(project.id, "PROJECT_CREATED", { name }, options.actorUserId);
    return { ...project };
  }
  async listProjects(workspaceId: string): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .filter((project) => project.workspaceId === workspaceId && project.status === "active")
      .map((project) => ({ ...project }));
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
    this.projects.set(projectId, { ...project, status: "deleted", updatedAt: timestamp() });
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
    const actor = [this.principal, ...this.authUsers.values()].find(
      (user) => user !== undefined && user.id === actorUserId,
    );
    return actor ? { ...rest, actor: { id: actor.id, email: actor.email } } : rest;
  }
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
