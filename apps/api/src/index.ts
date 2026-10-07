import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import swagger from "@fastify/swagger";
import {
  AssetDescriptorSchema,
  AuditEventPageSchema,
  AuditEventsQuerySchema,
  apiRoutes,
  CreateProjectRequestSchema,
  CurrentUserResponseSchema,
  DownloadUrlResponseSchema,
  ErrorEnvelopeSchema,
  type ExportFormat,
  ExportListResponseSchema,
  ExportRecordSchema,
  IntegrityReportListSchema,
  IntegrityReportRecordSchema,
  MAX_UPLOAD_BYTES,
  PrepareUploadRequestSchema,
  ProjectDocumentResponseSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  RecordExportRequestSchema,
  RequestIntegrityReportSchema,
  SaveDocumentRequestSchema,
  SaveDocumentResponseSchema,
  UpdateProjectRequestSchema,
  VersionListResponseSchema,
  VersionResponseSchema,
  VersionsQuerySchema,
  validateRecordExportRequest,
} from "@figlab/api-contract";
import {
  type AssetRecord,
  type Authorizer,
  assertResourceId,
  ConflictError,
  createPostgresRepository,
  type FigLabRepository,
  ForbiddenError,
  InviteUnavailableError,
  MembershipAuthorizer,
  NotFoundError,
  type Principal,
  roleAllows,
  UploadExpiredError,
  type WorkspaceAccess,
} from "@figlab/database";
import {
  type FigureDocument,
  FigureDocumentDecodeError,
  migrateFigureDocument,
  panelAssetIds,
} from "@figlab/figure-schema";
import { createObjectStoreFromEnv, derivedPreviewKey, type ObjectStore } from "@figlab/storage";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import {
  type PrincipalResolver,
  singleUserResolver,
  supabaseResolver,
  UnauthorizedError,
} from "./auth.js";
import { createWorkspaceProject, registerCollaborationRoutes } from "./collaboration.js";
import { validatorCompiler } from "./validation.js";

const params = Type.Object({ projectId: Type.String({ minLength: 1 }) });
const uploadParams = Type.Object({ uploadId: Type.String({ minLength: 1 }) });
const assetParams = Type.Object({ assetId: Type.String({ minLength: 1 }) });
const completionSchema = Type.Object({
  assetId: Type.String(),
  status: Type.Union([
    Type.Literal("pending-verification"),
    Type.Literal("ready"),
    Type.Literal("rejected"),
  ]),
});
const uploadSchema = Type.Object({
  uploadId: Type.String(),
  assetId: Type.String(),
  upload: Type.Object({
    url: Type.String(),
    method: Type.Literal("PUT"),
    headers: Type.Record(Type.String(), Type.String()),
    expiresAt: Type.String(),
  }),
});
const versionParams = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
});
const DEFAULT_PAGE_SIZE = 50;
const reportParams = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  reportId: Type.String({ minLength: 1 }),
});
const DEFAULT_SINGLE_USER_EMAIL = "local-admin@figlab.invalid";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface AppDependencies {
  repository: FigLabRepository;
  store: ObjectStore;
  /** Fixed single-user principal for the local loopback deployment. */
  principal?: Principal;
  /** Per-request authentication; when set, the loopback-only single-user guard does not apply. */
  resolvePrincipal?: PrincipalResolver;
  /** Called after durable work is enqueued, so a serverless host can start draining it. */
  onJobsEnqueued?: () => void;
  authorizer?: Authorizer;
  uploadTtlSeconds?: number;
  maxUploadBytes?: number;
  publicAppUrl?: string;
  allowInsecureSingleUserRemote?: boolean;
}
export function assertSingleUserConfiguration(
  publicAppUrl: string,
  allowInsecureRemote = false,
): void {
  const host = new URL(publicAppUrl).hostname;
  const local =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "127.0.0.1" ||
    host.startsWith("127.");
  if (!local && !allowInsecureRemote)
    throw new Error("Single-user mode requires a localhost or loopback PUBLIC_APP_URL");
}
export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  let resolvePrincipal = dependencies.resolvePrincipal;
  if (!resolvePrincipal) {
    if (!dependencies.principal)
      throw new Error("buildApp requires either a single-user principal or resolvePrincipal");
    assertSingleUserConfiguration(
      dependencies.publicAppUrl ?? "http://localhost",
      dependencies.allowInsecureSingleUserRemote ?? false,
    );
    resolvePrincipal = singleUserResolver(dependencies.principal);
  }
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  const authorizer = dependencies.authorizer ?? new MembershipAuthorizer(dependencies.repository);
  const jobsEnqueued = () => {
    try {
      dependencies.onJobsEnqueued?.();
    } catch {
      // Draining is best-effort; the scheduled sweep picks up anything a trigger misses.
    }
  };
  app.decorateRequest("principal", null as unknown as Principal);
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1/")) return;
    request.principal = await resolvePrincipal(request.headers.authorization);
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "FigLab API",
        version: "0.1.0",
        license: { name: "AGPL-3.0-only" },
      },
    },
  });
  const projectAccess = async (
    principal: Principal,
    projectId: string,
    access: WorkspaceAccess,
  ) => {
    assertResourceId(projectId);
    const project = await dependencies.repository.getProject(projectId);
    const role = await authorizer.requireProject(principal, project, access);
    return { project, role };
  };
  const projectFor = async (principal: Principal, projectId: string, access: WorkspaceAccess) =>
    (await projectAccess(principal, projectId, access)).project;
  const collaboration = {
    repository: dependencies.repository,
    authorizer,
    projectFor: projectAccess,
  };
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UnauthorizedError)
      return reply.status(401).send({ code: "UNAUTHORIZED", message: error.message });
    if (error instanceof NotFoundError)
      return reply.status(404).send({ code: "NOT_FOUND", message: "Resource not found" });
    if (error instanceof ForbiddenError)
      return reply.status(403).send({ code: "FORBIDDEN", message: error.message });
    if (error instanceof InviteUnavailableError)
      return reply
        .status(409)
        .send({ code: "INVITE_UNAVAILABLE", message: error.message, details: [error.reason] });
    if (error instanceof ConflictError)
      return reply.status(409).send({ code: "CONFLICT", message: error.message });
    if (error instanceof UploadExpiredError)
      return reply.status(400).send({ code: "UPLOAD_EXPIRED", message: error.message });
    if (error instanceof FigureDocumentDecodeError)
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: error.message,
        ...(error.details.length > 0 ? { details: error.details } : {}),
      });
    if (typeof error === "object" && error !== null && "validation" in error)
      return reply.status(400).send({
        code: request.url.includes("/uploads") ? "UPLOAD_INVALID" : "BAD_REQUEST",
        message: "Invalid request",
      });
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Internal server error" });
  });
  app.get(
    apiRoutes.health,
    { schema: { response: { 200: Type.Object({ ok: Type.Literal(true) }) } } },
    async () => ({ ok: true }),
  );
  app.get(
    apiRoutes.me,
    { schema: { response: { 200: CurrentUserResponseSchema } } },
    async (request) => ({
      email: request.principal.email,
      role: request.principal.role ?? "admin",
      userId: request.principal.id,
      personalWorkspaceId: request.principal.workspaceId,
    }),
  );
  app.get(
    apiRoutes.projects,
    { schema: { response: { 200: ProjectListResponseSchema } } },
    async (request) => ({
      projects: await dependencies.repository.listProjects(request.principal.workspaceId),
    }),
  );
  app.post(
    apiRoutes.projects,
    { schema: { body: CreateProjectRequestSchema, response: { 201: ProjectSchema } } },
    async (request, reply) => {
      const project = await createWorkspaceProject(
        collaboration,
        request.principal,
        request.principal.workspaceId,
        request.body as { name: string; folderId?: string; templateId?: string },
      );
      return reply.status(201).send(project);
    },
  );
  app.get(
    apiRoutes.project,
    { schema: { params, response: { 200: ProjectSchema } } },
    async (request) =>
      projectFor(request.principal, (request.params as { projectId: string }).projectId, "read"),
  );
  app.put(
    apiRoutes.project,
    { schema: { params, body: UpdateProjectRequestSchema, response: { 200: ProjectSchema } } },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "write");
      return dependencies.repository.renameProject(
        id,
        (request.body as { name: string }).name,
        actor(request.principal),
      );
    },
  );
  app.delete(
    apiRoutes.project,
    { schema: { params, response: { 202: ProjectSchema } } },
    async (request, reply) => {
      const id = (request.params as { projectId: string }).projectId;
      const { project, role } = await projectAccess(request.principal, id, "write");
      if (!roleAllows(role, "manage") && project.createdBy !== request.principal.id)
        throw new ForbiddenError("Only the project's creator or a workspace admin can delete it");
      const deleting = await dependencies.repository.markProjectDeleting(
        id,
        actor(request.principal),
      );
      jobsEnqueued();
      return reply.status(202).send(deleting);
    },
  );
  app.get(
    apiRoutes.projectDocument,
    { schema: { params, response: { 200: ProjectDocumentResponseSchema } } },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "read");
      return currentDocument(await dependencies.repository.getDocument(id));
    },
  );
  app.put(
    apiRoutes.projectDocument,
    {
      schema: {
        params,
        body: SaveDocumentRequestSchema,
        response: {
          200: SaveDocumentResponseSchema,
          400: ErrorEnvelopeSchema,
          409: Type.Object({
            code: Type.Literal("REVISION_CONFLICT"),
            message: Type.String(),
            currentRevision: Type.Integer(),
          }),
        },
      },
    },
    async (request, reply) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "write");
      const body = request.body as { baseRevision: number; document: unknown };
      const document = migrateFigureDocument(body.document);
      await dependencies.repository.assertReadyAssets(id, sourceAssetIds(document));
      const mismatch = await sourceRegistryMismatch(dependencies.repository, id, document);
      if (mismatch) return reply.status(400).send({ code: "BAD_REQUEST", message: mismatch });
      const saved = await dependencies.repository.saveDocument(
        id,
        body.baseRevision,
        document,
        actor(request.principal),
      );
      if (saved.kind === "conflict")
        return reply.status(409).send({
          code: "REVISION_CONFLICT",
          message: "Document revision conflict",
          currentRevision: saved.currentRevision,
        });
      return currentDocument(saved.document);
    },
  );
  app.post(
    apiRoutes.projectUploads,
    {
      schema: {
        params,
        body: PrepareUploadRequestSchema,
        response: {
          201: uploadSchema,
          400: Type.Object({ code: Type.Literal("UPLOAD_INVALID"), message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const id = (request.params as { projectId: string }).projectId;
      const body = request.body as {
        filename: string;
        contentType: string;
        contentLength: number;
        checksumSha256: string;
      };
      const project = await projectFor(request.principal, id, "write");
      if (!isValidUpload(body, dependencies.maxUploadBytes ?? MAX_UPLOAD_BYTES))
        return reply
          .status(400)
          .send({ code: "UPLOAD_INVALID", message: "Unsupported upload claim" });
      const assetId = randomUUID();
      const uploadTtlSeconds = Math.min(600, Math.max(1, dependencies.uploadTtlSeconds ?? 600));
      const key = `workspaces/${project.workspaceId}/projects/${id}/assets/${assetId}/original`;
      const upload = await dependencies.repository.createUpload({
        projectId: id,
        ...body,
        mimeType: body.contentType,
        assetId,
        storageKey: key,
        expiresAt: new Date(Date.now() + uploadTtlSeconds * 1000).toISOString(),
      });
      const signed = await dependencies.store.presignPut({
        key,
        contentType: body.contentType,
        contentLength: body.contentLength,
        expiresInSeconds: uploadTtlSeconds,
      });
      return reply
        .status(201)
        .send({ uploadId: upload.id, assetId: upload.assetId, upload: signed });
    },
  );
  app.post(
    apiRoutes.uploadComplete,
    {
      schema: {
        params: uploadParams,
        response: {
          202: completionSchema,
          400: Type.Object({
            code: Type.Union([Type.Literal("UPLOAD_INVALID"), Type.Literal("UPLOAD_EXPIRED")]),
            message: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const upload = await dependencies.repository.getUpload(
        resourceId((request.params as { uploadId: string }).uploadId),
      );
      await projectFor(request.principal, upload.projectId, "write");
      if (
        upload.status === "expired" ||
        (upload.status === "reserved" && new Date(upload.expiresAt).getTime() <= Date.now())
      )
        await dependencies.repository.completeUpload(upload.id);
      const asset = await dependencies.repository.getAsset(upload.assetId);
      const stat = await dependencies.store.stat(asset.storageKey);
      if (!stat || stat.contentLength !== upload.contentLength)
        return reply.status(400).send({
          code: "UPLOAD_INVALID",
          message: "Uploaded object is missing or has an unexpected length",
        });
      await dependencies.repository.completeUpload(upload.id);
      jobsEnqueued();
      return reply.status(202).send({ assetId: asset.id, status: asset.status });
    },
  );
  app.get(
    apiRoutes.asset,
    { schema: { params: assetParams, response: { 200: AssetDescriptorSchema } } },
    async (request) =>
      assetFor(
        dependencies,
        authorizer,
        request.principal,
        (request.params as { assetId: string }).assetId,
      ),
  );
  app.post(
    apiRoutes.assetPreviewDownloadUrl,
    {
      schema: {
        params: Type.Object({
          assetId: Type.String({ minLength: 1 }),
          maxEdge: Type.Integer({ minimum: 1 }),
        }),
        response: { 201: DownloadUrlResponseSchema },
      },
    },
    async (request, reply) => {
      const { assetId, maxEdge } = request.params as { assetId: string; maxEdge: number };
      const asset = await assetFor(dependencies, authorizer, request.principal, assetId);
      const previews = Array.isArray(asset.metadata.previews)
        ? (asset.metadata.previews as { maxEdge?: unknown }[])
        : [];
      if (asset.status !== "ready" || !previews.some((preview) => preview.maxEdge === maxEdge))
        throw new NotFoundError();
      const signed = await dependencies.store.presignDownload(
        derivedPreviewKey(asset.storageKey, maxEdge),
      );
      return reply.status(201).send({ url: signed.url, expiresAt: signed.expiresAt });
    },
  );
  app.post(
    apiRoutes.assetDownloadUrl,
    {
      schema: {
        params: assetParams,
        response: {
          201: DownloadUrlResponseSchema,
          409: Type.Object({ code: Type.Literal("ASSET_NOT_READY"), message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const asset = await assetFor(
        dependencies,
        authorizer,
        request.principal,
        (request.params as { assetId: string }).assetId,
      );
      if (asset.status !== "ready")
        return reply.status(409).send({ code: "ASSET_NOT_READY", message: "Asset is not ready" });
      const signed = await dependencies.store.presignDownload(asset.storageKey);
      return reply.status(201).send({ url: signed.url, expiresAt: signed.expiresAt });
    },
  );
  app.post(
    apiRoutes.projectExports,
    {
      schema: {
        params,
        body: RecordExportRequestSchema,
        response: {
          201: ExportRecordSchema,
          400: Type.Object({ code: Type.Literal("BAD_REQUEST"), message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "read");
      const body = request.body as {
        format: ExportFormat;
        artboardId?: string;
        dpi?: number;
        revision: number;
        widthPx: number;
        heightPx: number;
        checksumSha256: string;
      };
      if (!validateRecordExportRequest(body))
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Invalid export metadata" });
      if (body.artboardId !== undefined) {
        const current = await dependencies.repository.getDocument(id);
        const document = migrateFigureDocument(current.document);
        if (!document.artboards.some((artboard) => artboard.id === body.artboardId))
          return reply
            .status(400)
            .send({ code: "BAD_REQUEST", message: "Export names an unknown figure" });
      }
      return reply
        .status(201)
        .send(
          await dependencies.repository.recordExport(
            { projectId: id, ...body },
            actor(request.principal),
          ),
        );
    },
  );
  app.get(
    apiRoutes.projectExports,
    { schema: { params, response: { 200: ExportListResponseSchema } } },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "read");
      return { exports: await dependencies.repository.listExports(id) };
    },
  );
  app.get(
    apiRoutes.projectAuditEvents,
    {
      schema: {
        params,
        querystring: AuditEventsQuerySchema,
        response: { 200: AuditEventPageSchema },
      },
    },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "read");
      const query = request.query as { limit?: number; beforeSequence?: number };
      return dependencies.repository.pageAuditEvents(id, {
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
        ...(query.beforeSequence === undefined ? {} : { beforeSequence: query.beforeSequence }),
      });
    },
  );
  app.get(
    apiRoutes.projectVersions,
    {
      schema: {
        params,
        querystring: VersionsQuerySchema,
        response: { 200: VersionListResponseSchema },
      },
    },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "read");
      const query = request.query as { limit?: number; beforeRevision?: number };
      return {
        versions: await dependencies.repository.listVersions(id, {
          limit: query.limit ?? DEFAULT_PAGE_SIZE,
          ...(query.beforeRevision === undefined ? {} : { beforeRevision: query.beforeRevision }),
        }),
      };
    },
  );
  app.get(
    apiRoutes.projectVersion,
    { schema: { params: versionParams, response: { 200: VersionResponseSchema } } },
    async (request) => {
      const { projectId, revision } = request.params as { projectId: string; revision: number };
      await projectFor(request.principal, projectId, "read");
      return currentDocument(await dependencies.repository.getVersion(projectId, revision));
    },
  );
  app.post(
    apiRoutes.projectIntegrityReports,
    {
      schema: {
        params,
        body: RequestIntegrityReportSchema,
        response: { 202: IntegrityReportRecordSchema },
      },
    },
    async (request, reply) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "read");
      const body = (request.body ?? {}) as { revision?: number };
      const revision = body.revision ?? (await dependencies.repository.getDocument(id)).revision;
      const record = await dependencies.repository.requestIntegrityReport(
        id,
        revision,
        actor(request.principal),
      );
      jobsEnqueued();
      return reply.status(202).send(record);
    },
  );
  app.get(
    apiRoutes.projectIntegrityReports,
    { schema: { params, response: { 200: IntegrityReportListSchema } } },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id, "read");
      const records = await dependencies.repository.listIntegrityReports(id, 20);
      return { reports: records.map(({ report: _body, ...summary }) => summary) };
    },
  );
  app.get(
    apiRoutes.projectIntegrityReport,
    { schema: { params: reportParams, response: { 200: IntegrityReportRecordSchema } } },
    async (request) => {
      const { projectId, reportId } = request.params as { projectId: string; reportId: string };
      await projectFor(request.principal, projectId, "read");
      assertResourceId(reportId);
      const record = await dependencies.repository.getIntegrityReport(reportId);
      if (record.projectId !== projectId) throw new NotFoundError();
      return record;
    },
  );
  registerCollaborationRoutes(app, collaboration);
  return app;
}

/** Builds the API from environment variables without binding a port. */
export async function createAppFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    maxConnections?: number;
    idleTimeoutMillis?: number;
    onJobsEnqueued?: () => void;
  } = {},
): Promise<FastifyInstance> {
  const publicAppUrl = required(environment, "PUBLIC_APP_URL");
  const authMode = environment.AUTH_MODE ?? "single-user";
  if (authMode !== "single-user" && authMode !== "supabase")
    throw new Error(`Unsupported AUTH_MODE: ${authMode}`);
  const allowInsecureSingleUserRemote = environment.ALLOW_INSECURE_SINGLE_USER_REMOTE === "true";
  if (authMode === "single-user")
    assertSingleUserConfiguration(publicAppUrl, allowInsecureSingleUserRemote);
  const { repository, close } = createPostgresRepository(required(environment, "DATABASE_URL"), {
    ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}),
    ...(options.idleTimeoutMillis ? { idleTimeoutMillis: options.idleTimeoutMillis } : {}),
    ...(environment.DATABASE_CA_CERT ? { caCert: environment.DATABASE_CA_CERT } : {}),
  });
  const identity =
    authMode === "supabase"
      ? {
          resolvePrincipal: supabaseResolver({
            supabaseUrl: required(environment, "SUPABASE_URL"),
            repository,
          }),
        }
      : { principal: await bootstrapSingleUserFromEnv(repository, environment) };
  const app = await buildApp({
    repository,
    store: createObjectStoreFromEnv(environment),
    ...identity,
    ...(options.onJobsEnqueued ? { onJobsEnqueued: options.onJobsEnqueued } : {}),
    publicAppUrl,
    allowInsecureSingleUserRemote,
    uploadTtlSeconds: Number(environment.UPLOAD_URL_TTL_SECONDS ?? 600),
    maxUploadBytes: configuredPositiveInteger(
      environment.MAX_UPLOAD_BYTES,
      MAX_UPLOAD_BYTES,
      "MAX_UPLOAD_BYTES",
    ),
  });
  app.addHook("onClose", close);
  return app;
}

export async function startServerFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FastifyInstance> {
  const app = await createAppFromEnv(environment);
  await app.listen({
    host: environment.API_HOST ?? "0.0.0.0",
    port: Number(environment.API_PORT ?? 3000),
  });
  return app;
}

export function bootstrapSingleUserFromEnv(
  repository: FigLabRepository,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Principal> {
  return repository.bootstrapSingleUser(environment.SINGLE_USER_EMAIL || DEFAULT_SINGLE_USER_EMAIL);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServerFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
async function assetFor(
  dependencies: AppDependencies,
  authorizer: Authorizer,
  principal: Principal,
  id: string,
): Promise<AssetRecord> {
  assertResourceId(id);
  const asset = await dependencies.repository.getAsset(id);
  await authorizer.requireProject(
    principal,
    await dependencies.repository.getProject(asset.projectId),
    "read",
  );
  return asset;
}
function actor(principal: Principal): { actorUserId: string } {
  return { actorUserId: principal.id };
}
function resourceId(value: string): string {
  assertResourceId(value);
  return value;
}
function sourceAssetIds(document: FigureDocument): string[] {
  return [
    ...document.objects.flatMap(panelAssetIds),
    ...document.sources.map((source) => source.assetId),
  ];
}
/**
 * The document records each source's size and calibration so figures render deterministically;
 * those records must agree with what the verifier measured from the immutable original.
 */
async function sourceRegistryMismatch(
  repository: FigLabRepository,
  projectId: string,
  document: FigureDocument,
): Promise<string | undefined> {
  if (document.sources.length === 0) return undefined;
  const assets = new Map(
    (await repository.listProjectAssets(projectId)).map((asset) => [asset.id, asset]),
  );
  for (const source of document.sources) {
    const asset = assets.get(source.assetId);
    if (!asset) return `Source ${source.assetId} is not an asset of this project`;
    if (asset.widthPx !== source.widthPx || asset.heightPx !== source.heightPx)
      return `Source ${source.assetId} size does not match the verified original`;
    if (source.calibration?.origin === "metadata") {
      const measured = asset.metadata.calibration as
        | { umPerPxX?: unknown; umPerPxY?: unknown }
        | undefined;
      const same = (left: unknown, right: number) =>
        typeof left === "number" && Math.abs(left - right) <= Math.abs(right) * 1e-9;
      if (
        !measured ||
        !same(measured.umPerPxX, source.calibration.umPerPxX) ||
        !same(measured.umPerPxY, source.calibration.umPerPxY)
      )
        return `Source ${source.assetId} calibration is marked as file metadata but differs from it`;
    }
  }
  return undefined;
}
/** Stored documents may be older versions; responses always carry the current version. */
function currentDocument<T extends { document: unknown }>(
  record: T,
): T & { document: FigureDocument } {
  return { ...record, document: migrateFigureDocument(record.document) };
}
function isValidUpload(
  input: {
    contentType: string;
    contentLength: number;
    checksumSha256: string;
  },
  maxUploadBytes: number,
): boolean {
  return (
    ["image/png", "image/jpeg", "image/tiff"].includes(input.contentType) &&
    input.contentLength > 0 &&
    input.contentLength <= maxUploadBytes &&
    /^[a-f0-9]{64}$/.test(input.checksumSha256)
  );
}

function configuredPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}
