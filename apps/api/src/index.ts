import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import swagger from "@fastify/swagger";
import {
  AssetDescriptorSchema,
  apiRoutes,
  CreateProjectRequestSchema,
  CurrentUserResponseSchema,
  DownloadUrlResponseSchema,
  ErrorEnvelopeSchema,
  MAX_UPLOAD_BYTES,
  PrepareUploadRequestSchema,
  ProjectDocumentResponseSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  RecordExportRequestSchema,
  SaveDocumentRequestSchema,
  SaveDocumentResponseSchema,
  UpdateProjectRequestSchema,
  validateRecordExportRequest,
} from "@figlab/api-contract";
import {
  type AssetRecord,
  type Authorizer,
  assertResourceId,
  createPostgresRepository,
  type FigLabRepository,
  NotFoundError,
  type Principal,
  SingleUserAuthorizer,
  UploadExpiredError,
} from "@figlab/database";
import { decodeFigureDocument, FigureDocumentDecodeError } from "@figlab/figure-schema";
import { createObjectStoreFromEnv, type ObjectStore } from "@figlab/storage";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import {
  type PrincipalResolver,
  singleUserResolver,
  supabaseResolver,
  UnauthorizedError,
} from "./auth.js";

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
const exportSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  revision: Type.Integer(),
  format: Type.Literal("png"),
  widthPx: Type.Integer(),
  heightPx: Type.Integer(),
  checksumSha256: Type.String(),
  createdAt: Type.String(),
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
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  const authorizer = dependencies.authorizer ?? new SingleUserAuthorizer();
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
  const projectFor = async (principal: Principal, projectId: string) => {
    assertResourceId(projectId);
    const project = await dependencies.repository.getProject(projectId);
    await authorizer.requireProject(principal, project);
    return project;
  };
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UnauthorizedError)
      return reply.status(401).send({ code: "UNAUTHORIZED", message: error.message });
    if (error instanceof NotFoundError)
      return reply.status(404).send({ code: "NOT_FOUND", message: "Resource not found" });
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
      const body = request.body as { name: string };
      const project = await dependencies.repository.createProject(
        request.principal.workspaceId,
        body.name,
      );
      return reply.status(201).send(project);
    },
  );
  app.get(
    apiRoutes.project,
    { schema: { params, response: { 200: ProjectSchema } } },
    async (request) =>
      projectFor(request.principal, (request.params as { projectId: string }).projectId),
  );
  app.put(
    apiRoutes.project,
    { schema: { params, body: UpdateProjectRequestSchema, response: { 200: ProjectSchema } } },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id);
      return dependencies.repository.renameProject(id, (request.body as { name: string }).name);
    },
  );
  app.delete(
    apiRoutes.project,
    { schema: { params, response: { 202: ProjectSchema } } },
    async (request, reply) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id);
      const deleting = await dependencies.repository.markProjectDeleting(id);
      jobsEnqueued();
      return reply.status(202).send(deleting);
    },
  );
  app.get(
    apiRoutes.projectDocument,
    { schema: { params, response: { 200: ProjectDocumentResponseSchema } } },
    async (request) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id);
      return dependencies.repository.getDocument(id);
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
      await projectFor(request.principal, id);
      const body = request.body as { baseRevision: number; document: unknown };
      const document = decodeFigureDocument(body.document);
      await dependencies.repository.assertReadyAssets(id, sourceAssetIds(document));
      const saved = await dependencies.repository.saveDocument(id, body.baseRevision, document);
      if (saved.kind === "conflict")
        return reply.status(409).send({
          code: "REVISION_CONFLICT",
          message: "Document revision conflict",
          currentRevision: saved.currentRevision,
        });
      return saved.document;
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
      await projectFor(request.principal, id);
      if (!isValidUpload(body, dependencies.maxUploadBytes ?? MAX_UPLOAD_BYTES))
        return reply
          .status(400)
          .send({ code: "UPLOAD_INVALID", message: "Unsupported upload claim" });
      const assetId = randomUUID();
      const uploadTtlSeconds = Math.min(600, Math.max(1, dependencies.uploadTtlSeconds ?? 600));
      const key = `workspaces/${request.principal.workspaceId}/projects/${id}/assets/${assetId}/original`;
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
      await projectFor(request.principal, upload.projectId);
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
          201: exportSchema,
          400: Type.Object({ code: Type.Literal("BAD_REQUEST"), message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const id = (request.params as { projectId: string }).projectId;
      await projectFor(request.principal, id);
      const body = request.body as {
        format: "png";
        revision: number;
        widthPx: number;
        heightPx: number;
        checksumSha256: string;
      };
      if (!validateRecordExportRequest(body))
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Invalid export metadata" });
      return reply
        .status(201)
        .send(await dependencies.repository.recordExport({ projectId: id, ...body }));
    },
  );
  return app;
}

/** Builds the API from environment variables without binding a port. */
export async function createAppFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  options: { maxConnections?: number; onJobsEnqueued?: () => void } = {},
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
  );
  return asset;
}
function resourceId(value: string): string {
  assertResourceId(value);
  return value;
}
function sourceAssetIds(document: {
  objects: { type: string; view?: { sourceAssetId: string } }[];
}): string[] {
  return document.objects
    .filter((object) => object.type === "image-view" && object.view)
    .map((object) => object.view?.sourceAssetId ?? "");
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
