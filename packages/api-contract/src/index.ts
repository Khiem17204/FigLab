import {
  FigureDocumentSchema,
  FigureDocumentV1Schema,
  FigureDocumentV2Schema,
} from "@figlab/figure-schema";
import { Kind, type Static, Type, TypeRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const MAX_UPLOAD_BYTES = 104_857_600;
export const MAX_EXPORT_EDGE_PX = 16_384;
export const MAX_EXPORT_PIXELS = 100_000_000;

export const apiRoutes = {
  health: "/health",
  me: "/v1/me",
  projects: "/v1/projects",
  project: "/v1/projects/:projectId",
  projectDocument: "/v1/projects/:projectId/document",
  projectUploads: "/v1/projects/:projectId/uploads",
  uploadComplete: "/v1/uploads/:uploadId/complete",
  asset: "/v1/assets/:assetId",
  assetDownloadUrl: "/v1/assets/:assetId/download-url",
  assetPreviewDownloadUrl: "/v1/assets/:assetId/previews/:maxEdge/download-url",
  projectExports: "/v1/projects/:projectId/exports",
  projectAuditEvents: "/v1/projects/:projectId/audit-events",
  projectVersions: "/v1/projects/:projectId/versions",
  projectVersion: "/v1/projects/:projectId/versions/:revision",
  projectIntegrityReports: "/v1/projects/:projectId/integrity-reports",
  projectIntegrityReport: "/v1/projects/:projectId/integrity-reports/:reportId",
  projectFolder: "/v1/projects/:projectId/folder",
  projectComments: "/v1/projects/:projectId/comments",
  projectComment: "/v1/projects/:projectId/comments/:commentId",
  workspaces: "/v1/workspaces",
  workspace: "/v1/workspaces/:workspaceId",
  workspaceProjects: "/v1/workspaces/:workspaceId/projects",
  workspaceMembers: "/v1/workspaces/:workspaceId/members",
  workspaceMember: "/v1/workspaces/:workspaceId/members/:userId",
  workspaceInvites: "/v1/workspaces/:workspaceId/invites",
  workspaceInvite: "/v1/workspaces/:workspaceId/invites/:inviteId",
  workspaceFolders: "/v1/workspaces/:workspaceId/folders",
  workspaceFolder: "/v1/workspaces/:workspaceId/folders/:folderId",
  workspaceTemplates: "/v1/workspaces/:workspaceId/templates",
  workspaceTemplate: "/v1/workspaces/:workspaceId/templates/:templateId",
  invite: "/v1/invites/:token",
  inviteAccept: "/v1/invites/:token/accept",
  search: "/v1/search",
  adminOverview: "/v1/admin/overview",
  adminUsers: "/v1/admin/users",
  adminWorkspaces: "/v1/admin/workspaces",
  adminJobs: "/v1/admin/jobs",
} as const;

export const MAX_EXPORT_DPI = 2400;
export const MAX_PAGE_SIZE = 200;

export const ErrorCodeSchema = Type.Union([
  Type.Literal("BAD_REQUEST"),
  Type.Literal("UNAUTHORIZED"),
  Type.Literal("FORBIDDEN"),
  Type.Literal("NOT_FOUND"),
  Type.Literal("CONFLICT"),
  Type.Literal("INVITE_UNAVAILABLE"),
  Type.Literal("REVISION_CONFLICT"),
  Type.Literal("UPLOAD_EXPIRED"),
  Type.Literal("UPLOAD_INVALID"),
  Type.Literal("ASSET_NOT_READY"),
  Type.Literal("UNSUPPORTED_IMAGE"),
  Type.Literal("INTERNAL_ERROR"),
]);

export const ErrorEnvelopeSchema = Type.Object(
  {
    code: ErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const RevisionConflictSchema = Type.Object(
  {
    code: Type.Literal("REVISION_CONFLICT"),
    message: Type.String({ minLength: 1 }),
    currentRevision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const CurrentUserResponseSchema = Type.Object(
  {
    email: Type.String({ minLength: 1 }),
    role: Type.Union([Type.Literal("admin"), Type.Literal("member")]),
    userId: Type.Optional(Type.String({ minLength: 1 })),
    personalWorkspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type CurrentUserResponse = Static<typeof CurrentUserResponseSchema>;

export const ProjectStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("deleting")]);

export const ProjectSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    workspaceId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    status: ProjectStatusSchema,
    folderId: Type.Optional(Type.String({ minLength: 1 })),
    createdBy: Type.Optional(Type.String({ minLength: 1 })),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const CreateProjectRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    folderId: Type.Optional(Type.String({ format: "uuid" })),
    /** A template of the same workspace to start from. */
    templateId: Type.Optional(Type.String({ format: "uuid" })),
  },
  { additionalProperties: false },
);

export const UpdateProjectRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);

export const ProjectListResponseSchema = Type.Object(
  { projects: Type.Array(ProjectSchema) },
  { additionalProperties: false },
);

export const ProjectDocumentResponseSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 0 }),
    document: FigureDocumentSchema,
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const SaveDocumentRequestSchema = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    /** Any supported version; the server migrates it and always stores the current version. */
    document: Type.Union([FigureDocumentSchema, FigureDocumentV2Schema, FigureDocumentV1Schema]),
  },
  { additionalProperties: false },
);

export const SaveDocumentResponseSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    document: FigureDocumentSchema,
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PrepareUploadRequestSchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: Type.String({ minLength: 1, maxLength: 255 }),
    contentLength: Type.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }),
    checksumSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

export const AssetStatusSchema = Type.Union([
  Type.Literal("pending-verification"),
  Type.Literal("ready"),
  Type.Literal("rejected"),
]);

export const UploadStatusSchema = Type.Union([
  Type.Literal("reserved"),
  Type.Literal("uploaded"),
  Type.Literal("verifying"),
  Type.Literal("completed"),
  Type.Literal("rejected"),
  Type.Literal("expired"),
]);

export const UploadInstructionSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    method: Type.Literal("PUT"),
    headers: Type.Record(Type.String(), Type.String()),
    expiresAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PrepareUploadResponseSchema = Type.Object(
  {
    uploadId: Type.String({ minLength: 1 }),
    assetId: Type.String({ minLength: 1 }),
    upload: UploadInstructionSchema,
  },
  { additionalProperties: false },
);

export const CompleteUploadResponseSchema = Type.Object(
  {
    assetId: Type.String({ minLength: 1 }),
    status: AssetStatusSchema,
  },
  { additionalProperties: false },
);

export const AssetDescriptorSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    projectId: Type.String({ minLength: 1 }),
    filename: Type.String({ minLength: 1 }),
    mimeType: Type.String({ minLength: 1 }),
    checksumSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    widthPx: Type.Integer({ minimum: 1 }),
    heightPx: Type.Integer({ minimum: 1 }),
    bitDepth: Type.Union([Type.Literal(8), Type.Literal(16)]),
    channelCount: Type.Union([Type.Literal(1), Type.Literal(3), Type.Literal(4)]),
    status: AssetStatusSchema,
    metadata: Type.Record(Type.String(), Type.Unknown()),
    rejectionReason: Type.Optional(Type.String({ minLength: 1 })),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const DownloadUrlResponseSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    expiresAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ExportFormatSchema = Type.Union([
  Type.Literal("png"),
  Type.Literal("tiff"),
  Type.Literal("pdf"),
  Type.Literal("svg"),
]);

const RecordExportRequestStructuralSchema = Type.Object(
  {
    format: ExportFormatSchema,
    artboardId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    dpi: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EXPORT_DPI })),
    revision: Type.Integer({ minimum: 0 }),
    widthPx: Type.Integer({ minimum: 1, maximum: MAX_EXPORT_EDGE_PX }),
    heightPx: Type.Integer({ minimum: 1, maximum: MAX_EXPORT_EDGE_PX }),
    checksumSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

const RecordExportRequestKind = "FigLabRecordExportRequest";

TypeRegistry.Set(RecordExportRequestKind, (_schema, value) => {
  if (!Value.Check(RecordExportRequestStructuralSchema, value)) return false;

  return value.widthPx * value.heightPx <= MAX_EXPORT_PIXELS;
});

export const RecordExportRequestSchema = Type.Unsafe<
  Static<typeof RecordExportRequestStructuralSchema>
>({
  ...RecordExportRequestStructuralSchema,
  [Kind]: RecordExportRequestKind,
});

export const validateRecordExportRequest = (request: unknown): request is RecordExportRequest => {
  return Value.Check(RecordExportRequestSchema, request);
};

export const ExportRecordSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    projectId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 0 }),
    format: ExportFormatSchema,
    artboardId: Type.Optional(Type.String({ minLength: 1 })),
    dpi: Type.Optional(Type.Integer({ minimum: 1 })),
    widthPx: Type.Integer({ minimum: 1 }),
    heightPx: Type.Integer({ minimum: 1 }),
    checksumSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ExportListResponseSchema = Type.Object(
  { exports: Type.Array(ExportRecordSchema) },
  { additionalProperties: false },
);

const pageLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE }));

export const AuditEventsQuerySchema = Type.Object(
  { limit: pageLimit, beforeSequence: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false },
);

export const AuditEventSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    action: Type.String({ minLength: 1 }),
    details: Type.Record(Type.String(), Type.Unknown()),
    actor: Type.Optional(
      Type.Object(
        { id: Type.String({ minLength: 1 }), email: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
    sequence: Type.Integer({ minimum: 1 }),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const AuditEventPageSchema = Type.Object(
  {
    events: Type.Array(AuditEventSchema),
    nextBeforeSequence: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const VersionsQuerySchema = Type.Object(
  { limit: pageLimit, beforeRevision: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false },
);

export const VersionSummarySchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const VersionListResponseSchema = Type.Object(
  { versions: Type.Array(VersionSummarySchema) },
  { additionalProperties: false },
);

export const VersionResponseSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    /** The version the revision was saved with; `document` is always migrated to current. */
    schemaVersion: Type.Integer({ minimum: 1 }),
    document: FigureDocumentSchema,
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const RequestIntegrityReportSchema = Type.Object(
  { revision: Type.Optional(Type.Integer({ minimum: 0 })) },
  { additionalProperties: false },
);

const integrityReportFields = {
  id: Type.String({ minLength: 1 }),
  projectId: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 0 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed")]),
  error: Type.Optional(Type.String()),
  requestedBy: Type.Optional(Type.String()),
  createdAt: Type.String({ minLength: 1 }),
  completedAt: Type.Optional(Type.String()),
};

/** A report's status without its body, for lists. */
export const IntegrityReportSummarySchema = Type.Object(integrityReportFields, {
  additionalProperties: false,
});

/** A report with its body once ready (the `figlab-integrity-report/1` JSON). */
export const IntegrityReportRecordSchema = Type.Object(
  { ...integrityReportFields, report: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);

export const IntegrityReportListSchema = Type.Object(
  { reports: Type.Array(IntegrityReportSummarySchema) },
  { additionalProperties: false },
);

export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;
export type RevisionConflict = Static<typeof RevisionConflictSchema>;
export type Project = Static<typeof ProjectSchema>;
export type ProjectDocumentResponse = Static<typeof ProjectDocumentResponseSchema>;
export type SaveDocumentRequest = Static<typeof SaveDocumentRequestSchema>;
export type SaveDocumentResponse = Static<typeof SaveDocumentResponseSchema>;
export type PrepareUploadRequest = Static<typeof PrepareUploadRequestSchema>;
export type PrepareUploadResponse = Static<typeof PrepareUploadResponseSchema>;
export type AssetDescriptor = Static<typeof AssetDescriptorSchema>;
export type AssetStatus = Static<typeof AssetStatusSchema>;
export type UploadStatus = Static<typeof UploadStatusSchema>;
export type RecordExportRequest = Static<typeof RecordExportRequestSchema>;
export type ExportFormat = Static<typeof ExportFormatSchema>;
export type ExportRecord = Static<typeof ExportRecordSchema>;
export type AuditEventDto = Static<typeof AuditEventSchema>;
export type AuditEventPage = Static<typeof AuditEventPageSchema>;
export type VersionSummary = Static<typeof VersionSummarySchema>;
export type VersionResponse = Static<typeof VersionResponseSchema>;
export type IntegrityReportSummary = Static<typeof IntegrityReportSummarySchema>;
export type IntegrityReportRecord = Static<typeof IntegrityReportRecordSchema>;

export * from "./collaboration.js";
