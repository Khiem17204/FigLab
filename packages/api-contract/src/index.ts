import { FigureDocumentV1Schema } from "@figlab/figure-schema";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const MAX_UPLOAD_BYTES = 104_857_600;
export const MAX_EXPORT_EDGE_PX = 16_384;
export const MAX_EXPORT_PIXELS = 100_000_000;

export const apiRoutes = {
  health: "/health",
  projects: "/v1/projects",
  project: "/v1/projects/:projectId",
  projectDocument: "/v1/projects/:projectId/document",
  projectUploads: "/v1/projects/:projectId/uploads",
  uploadComplete: "/v1/uploads/:uploadId/complete",
  asset: "/v1/assets/:assetId",
  assetDownloadUrl: "/v1/assets/:assetId/download-url",
  projectExports: "/v1/projects/:projectId/exports",
} as const;

export const ErrorCodeSchema = Type.Union([
  Type.Literal("BAD_REQUEST"),
  Type.Literal("NOT_FOUND"),
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

export const ProjectStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("deleting")]);

export const ProjectSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    workspaceId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    status: ProjectStatusSchema,
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const CreateProjectRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 120 }) },
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
    document: FigureDocumentV1Schema,
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const SaveDocumentRequestSchema = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    document: FigureDocumentV1Schema,
  },
  { additionalProperties: false },
);

export const SaveDocumentResponseSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    document: FigureDocumentV1Schema,
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

export const RecordExportRequestSchema = Type.Object(
  {
    format: Type.Literal("png"),
    revision: Type.Integer({ minimum: 0 }),
    widthPx: Type.Integer({ minimum: 1, maximum: MAX_EXPORT_EDGE_PX }),
    heightPx: Type.Integer({ minimum: 1, maximum: MAX_EXPORT_EDGE_PX }),
    checksumSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

export const validateRecordExportRequest = (request: unknown): request is RecordExportRequest => {
  if (!Value.Check(RecordExportRequestSchema, request)) return false;

  return request.widthPx * request.heightPx <= MAX_EXPORT_PIXELS;
};

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
