import { createHash, randomBytes } from "node:crypto";
import {
  AdminJobListSchema,
  AdminLimitQuerySchema,
  AdminOverviewSchema,
  AdminUserListSchema,
  AdminWorkspaceListSchema,
  apiRoutes,
  CommentListSchema,
  CommentParamsSchema,
  CommentSchema,
  CreateCommentRequestSchema,
  CreateFolderRequestSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  CreateProjectRequestSchema,
  CreateTemplateRequestSchema,
  CreateWorkspaceRequestSchema,
  FolderListSchema,
  FolderParamsSchema,
  FolderSchema,
  InviteListSchema,
  InviteParamsSchema,
  InvitePreviewSchema,
  InviteSchema,
  InviteTokenParamsSchema,
  MemberParamsSchema,
  MoveProjectRequestSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  SearchQuerySchema,
  SearchResponseSchema,
  TemplateListSchema,
  TemplateParamsSchema,
  TemplateSchema,
  UpdateCommentRequestSchema,
  UpdateFolderRequestSchema,
  UpdateMemberRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceMemberListSchema,
  WorkspaceMemberSchema,
  WorkspaceParamsSchema,
  WorkspaceProjectsQuerySchema,
  WorkspaceSchema,
} from "@figlab/api-contract";
import {
  type Authorizer,
  type CommentAnchor,
  ConflictError,
  canAssignRole,
  type FigLabRepository,
  ForbiddenError,
  type InviteRole,
  NotFoundError,
  type Principal,
  type ProjectRecord,
  roleAllows,
  type WorkspaceAccess,
  type WorkspaceRole,
} from "@figlab/database";
import { templateDocument } from "@figlab/editor-core";
import { migrateFigureDocument } from "@figlab/figure-schema";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

const DEFAULT_INVITE_DAYS = 7;
const workspaceProjectParams = Type.Object({ projectId: Type.String({ format: "uuid" }) });

export interface CollaborationContext {
  repository: FigLabRepository;
  authorizer: Authorizer;
  projectFor: (
    principal: Principal,
    projectId: string,
    access: WorkspaceAccess,
  ) => Promise<{ project: ProjectRecord; role: WorkspaceRole }>;
}

/** SHA-256 of an invite token; only the hash is stored. */
export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new project in a workspace, optionally in a folder or from one of its templates. */
export async function createWorkspaceProject(
  context: CollaborationContext,
  principal: Principal,
  workspaceId: string,
  body: { name: string; folderId?: string; templateId?: string },
): Promise<ProjectRecord> {
  await context.authorizer.requireWorkspace(principal, workspaceId, "write");
  let document: unknown;
  if (body.templateId) {
    const template = await context.repository.getTemplate(body.templateId);
    if (template.workspaceId !== workspaceId) throw new NotFoundError();
    document = migrateFigureDocument(template.document);
  }
  return context.repository.createProject(workspaceId, body.name, {
    actorUserId: principal.id,
    ...(body.folderId ? { folderId: body.folderId } : {}),
    ...(document ? { document } : {}),
  });
}

/** Lab workspaces, invite links, folders, search, templates, comments, and the admin views. */
export function registerCollaborationRoutes(
  app: FastifyInstance,
  context: CollaborationContext,
): void {
  const { repository, authorizer } = context;
  const requireLab = async (workspaceId: string) => {
    const workspace = await repository.getWorkspace(workspaceId);
    if (workspace.kind !== "lab")
      throw new ConflictError("Personal workspaces are private; create a lab to share work");
    return workspace;
  };
  const requireAdmin = (principal: Principal) => {
    if ((principal.role ?? "admin") !== "admin")
      throw new ForbiddenError("Only FigLab administrators can view this");
  };

  // Workspaces
  app.get(
    apiRoutes.workspaces,
    { schema: { response: { 200: WorkspaceListResponseSchema } } },
    async (request) => ({ workspaces: await repository.listWorkspaces(request.principal.id) }),
  );
  app.post(
    apiRoutes.workspaces,
    { schema: { body: CreateWorkspaceRequestSchema, response: { 201: WorkspaceSchema } } },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await repository.createLabWorkspace(
            request.principal.id,
            (request.body as { name: string }).name,
          ),
        ),
  );
  app.patch(
    apiRoutes.workspace,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateWorkspaceRequestSchema,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "manage");
      await requireLab(workspaceId);
      await repository.renameWorkspace(workspaceId, (request.body as { name: string }).name);
      return reply.status(204).send();
    },
  );
  app.delete(
    apiRoutes.workspace,
    { schema: { params: WorkspaceParamsSchema, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const role = await authorizer.requireWorkspace(request.principal, workspaceId, "manage");
      if (role !== "owner") throw new ForbiddenError("Only owners can delete a lab");
      await requireLab(workspaceId);
      await repository.deleteLabWorkspace(workspaceId);
      return reply.status(204).send();
    },
  );
  app.get(
    apiRoutes.workspaceProjects,
    {
      schema: {
        params: WorkspaceParamsSchema,
        querystring: WorkspaceProjectsQuerySchema,
        response: { 200: ProjectListResponseSchema },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "read");
      const query = request.query as { q?: string; folderId?: string; createdBy?: string };
      return {
        projects: await repository.listProjects(workspaceId, {
          ...(query.q ? { query: query.q } : {}),
          ...(query.folderId
            ? { folderId: query.folderId === "root" ? null : query.folderId }
            : {}),
          ...(query.createdBy ? { createdBy: query.createdBy } : {}),
        }),
      };
    },
  );
  app.post(
    apiRoutes.workspaceProjects,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateProjectRequestSchema,
        response: { 201: ProjectSchema },
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      return reply
        .status(201)
        .send(
          await createWorkspaceProject(
            context,
            request.principal,
            workspaceId,
            request.body as { name: string; folderId?: string; templateId?: string },
          ),
        );
    },
  );
  app.put(
    apiRoutes.projectFolder,
    {
      schema: {
        params: workspaceProjectParams,
        body: MoveProjectRequestSchema,
        response: { 200: ProjectSchema },
      },
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      await context.projectFor(request.principal, projectId, "write");
      return repository.moveProject(
        projectId,
        (request.body as { folderId: string | null }).folderId,
        { actorUserId: request.principal.id },
      );
    },
  );

  // Members
  app.get(
    apiRoutes.workspaceMembers,
    { schema: { params: WorkspaceParamsSchema, response: { 200: WorkspaceMemberListSchema } } },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "read");
      return { members: await repository.listMembers(workspaceId) };
    },
  );
  app.put(
    apiRoutes.workspaceMember,
    {
      schema: {
        params: MemberParamsSchema,
        body: UpdateMemberRequestSchema,
        response: { 200: WorkspaceMemberSchema },
      },
    },
    async (request) => {
      const { workspaceId, userId } = request.params as { workspaceId: string; userId: string };
      const { role } = request.body as { role: WorkspaceRole };
      const actorRole = await authorizer.requireWorkspace(request.principal, workspaceId, "manage");
      await requireLab(workspaceId);
      const current = await repository.getWorkspaceRole(workspaceId, userId);
      if (!current) throw new NotFoundError();
      if (!canAssignRole(actorRole, current, role))
        throw new ForbiddenError("Only owners can grant, change, or remove owners and admins");
      return repository.setMemberRole(workspaceId, userId, role);
    },
  );
  app.delete(
    apiRoutes.workspaceMember,
    { schema: { params: MemberParamsSchema, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { workspaceId, userId } = request.params as { workspaceId: string; userId: string };
      const leaving = userId === request.principal.id;
      const actorRole = await authorizer.requireWorkspace(
        request.principal,
        workspaceId,
        leaving ? "read" : "manage",
      );
      await requireLab(workspaceId);
      const current = await repository.getWorkspaceRole(workspaceId, userId);
      if (!current) throw new NotFoundError();
      if (!leaving && !canAssignRole(actorRole, current, undefined))
        throw new ForbiddenError("Only owners can remove owners and admins");
      await repository.removeMember(workspaceId, userId);
      return reply.status(204).send();
    },
  );

  // Invite links
  app.get(
    apiRoutes.workspaceInvites,
    { schema: { params: WorkspaceParamsSchema, response: { 200: InviteListSchema } } },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "manage");
      return { invites: await repository.listInvites(workspaceId) };
    },
  );
  app.post(
    apiRoutes.workspaceInvites,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateInviteRequestSchema,
        response: { 201: CreateInviteResponseSchema },
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as { role: InviteRole; email?: string; expiresInDays?: number };
      const actorRole = await authorizer.requireWorkspace(request.principal, workspaceId, "manage");
      await requireLab(workspaceId);
      if (!canAssignRole(actorRole, undefined, body.role))
        throw new ForbiddenError("Only owners can invite admins");
      const token = randomBytes(32).toString("base64url");
      const invite = await repository.createInvite({
        workspaceId,
        role: body.role,
        ...(body.email ? { email: body.email.trim() } : {}),
        createdBy: request.principal.id,
        tokenSha256: inviteTokenHash(token),
        expiresAt: new Date(
          Date.now() + (body.expiresInDays ?? DEFAULT_INVITE_DAYS) * 86_400_000,
        ).toISOString(),
      });
      return reply.status(201).send({ invite, token });
    },
  );
  app.delete(
    apiRoutes.workspaceInvite,
    { schema: { params: InviteParamsSchema, response: { 200: InviteSchema } } },
    async (request) => {
      const { workspaceId, inviteId } = request.params as {
        workspaceId: string;
        inviteId: string;
      };
      await authorizer.requireWorkspace(request.principal, workspaceId, "manage");
      return repository.revokeInvite(workspaceId, inviteId);
    },
  );
  app.get(
    apiRoutes.invite,
    { schema: { params: InviteTokenParamsSchema, response: { 200: InvitePreviewSchema } } },
    async (request) =>
      repository.previewInvite(inviteTokenHash((request.params as { token: string }).token)),
  );
  app.post(
    apiRoutes.inviteAccept,
    { schema: { params: InviteTokenParamsSchema, response: { 200: WorkspaceSchema } } },
    async (request) =>
      repository.acceptInvite(inviteTokenHash((request.params as { token: string }).token), {
        id: request.principal.id,
        email: request.principal.email,
      }),
  );

  // Folders and search
  app.get(
    apiRoutes.workspaceFolders,
    { schema: { params: WorkspaceParamsSchema, response: { 200: FolderListSchema } } },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "read");
      return { folders: await repository.listFolders(workspaceId) };
    },
  );
  app.post(
    apiRoutes.workspaceFolders,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateFolderRequestSchema,
        response: { 201: FolderSchema },
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as { name: string; parentId?: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "write");
      return reply
        .status(201)
        .send(await repository.createFolder(workspaceId, body.name, body.parentId));
    },
  );
  app.patch(
    apiRoutes.workspaceFolder,
    {
      schema: {
        params: FolderParamsSchema,
        body: UpdateFolderRequestSchema,
        response: { 200: FolderSchema },
      },
    },
    async (request) => {
      const { workspaceId, folderId } = request.params as {
        workspaceId: string;
        folderId: string;
      };
      await authorizer.requireWorkspace(request.principal, workspaceId, "write");
      const folder = await repository.getFolder(folderId);
      if (folder.workspaceId !== workspaceId) throw new NotFoundError();
      return repository.updateFolder(
        folderId,
        request.body as { name?: string; parentId?: string | null; archived?: boolean },
      );
    },
  );
  app.get(
    apiRoutes.search,
    { schema: { querystring: SearchQuerySchema, response: { 200: SearchResponseSchema } } },
    async (request) => {
      const query = request.query as { q: string; limit?: number };
      return {
        results: await repository.searchProjects(request.principal.id, query.q, query.limit ?? 20),
      };
    },
  );

  // Templates
  app.get(
    apiRoutes.workspaceTemplates,
    { schema: { params: WorkspaceParamsSchema, response: { 200: TemplateListSchema } } },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "read");
      return { templates: await repository.listTemplates(workspaceId) };
    },
  );
  app.post(
    apiRoutes.workspaceTemplates,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateTemplateRequestSchema,
        response: { 201: TemplateSchema },
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as { name: string; projectId: string };
      await authorizer.requireWorkspace(request.principal, workspaceId, "write");
      await context.projectFor(request.principal, body.projectId, "read");
      const current = await repository.getDocument(body.projectId);
      const template = await repository.createTemplate({
        workspaceId,
        name: body.name,
        document: templateDocument(migrateFigureDocument(current.document)),
        createdBy: request.principal.id,
      });
      return reply.status(201).send(template);
    },
  );
  app.delete(
    apiRoutes.workspaceTemplate,
    { schema: { params: TemplateParamsSchema, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { workspaceId, templateId } = request.params as {
        workspaceId: string;
        templateId: string;
      };
      const role = await authorizer.requireWorkspace(request.principal, workspaceId, "write");
      const template = await repository.getTemplate(templateId);
      if (template.workspaceId !== workspaceId) throw new NotFoundError();
      if (!roleAllows(role, "manage") && template.createdBy?.id !== request.principal.id)
        throw new ForbiddenError("Only the template's author or a workspace admin can delete it");
      await repository.deleteTemplate(templateId);
      return reply.status(204).send();
    },
  );

  // Comments
  app.get(
    apiRoutes.projectComments,
    { schema: { params: workspaceProjectParams, response: { 200: CommentListSchema } } },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      await context.projectFor(request.principal, projectId, "read");
      return { comments: await repository.listComments(projectId) };
    },
  );
  app.post(
    apiRoutes.projectComments,
    {
      schema: {
        params: workspaceProjectParams,
        body: CreateCommentRequestSchema,
        response: { 201: CommentSchema },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      // Viewers may comment: reviewing is what read access is for.
      await context.projectFor(request.principal, projectId, "read");
      const body = request.body as { body: string; parentId?: string; anchor?: CommentAnchor };
      const comment = await repository.createComment({
        projectId,
        authorUserId: request.principal.id,
        body: body.body.trim() || body.body,
        ...(body.parentId ? { parentId: body.parentId } : {}),
        ...(body.anchor ? { anchor: body.anchor } : {}),
      });
      return reply.status(201).send(comment);
    },
  );
  const commentFor = async (principal: Principal, projectId: string, commentId: string) => {
    const access = await context.projectFor(principal, projectId, "read");
    const comment = await repository.getComment(commentId);
    if (comment.projectId !== projectId) throw new NotFoundError();
    return { ...access, comment, mine: comment.author.id === principal.id };
  };
  app.patch(
    apiRoutes.projectComment,
    {
      schema: {
        params: CommentParamsSchema,
        body: UpdateCommentRequestSchema,
        response: { 200: CommentSchema },
      },
    },
    async (request) => {
      const { projectId, commentId } = request.params as { projectId: string; commentId: string };
      const body = request.body as { body?: string; resolved?: boolean };
      const { role, mine } = await commentFor(request.principal, projectId, commentId);
      if (body.body !== undefined && !mine)
        throw new ForbiddenError("Only the author can edit a comment");
      if (body.resolved !== undefined && !mine && !roleAllows(role, "write"))
        throw new ForbiddenError("Only editors or the author can resolve a comment");
      return repository.updateComment(
        commentId,
        {
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.resolved !== undefined
            ? { resolvedBy: body.resolved ? request.principal.id : null }
            : {}),
        },
        request.principal.id,
      );
    },
  );
  app.delete(
    apiRoutes.projectComment,
    { schema: { params: CommentParamsSchema, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { projectId, commentId } = request.params as { projectId: string; commentId: string };
      const { role, mine } = await commentFor(request.principal, projectId, commentId);
      if (!mine && !roleAllows(role, "manage"))
        throw new ForbiddenError("Only the author or a workspace admin can delete a comment");
      await repository.deleteComment(commentId, request.principal.id);
      return reply.status(204).send();
    },
  );

  // Admin (read-only)
  const limitOf = (request: { query: unknown }) =>
    (request.query as { limit?: number }).limit ?? 100;
  app.get(
    apiRoutes.adminOverview,
    { schema: { response: { 200: AdminOverviewSchema } } },
    async (request) => {
      requireAdmin(request.principal);
      return repository.adminOverview();
    },
  );
  app.get(
    apiRoutes.adminUsers,
    { schema: { querystring: AdminLimitQuerySchema, response: { 200: AdminUserListSchema } } },
    async (request) => {
      requireAdmin(request.principal);
      return { users: await repository.adminUsers(limitOf(request)) };
    },
  );
  app.get(
    apiRoutes.adminWorkspaces,
    {
      schema: { querystring: AdminLimitQuerySchema, response: { 200: AdminWorkspaceListSchema } },
    },
    async (request) => {
      requireAdmin(request.principal);
      return { workspaces: await repository.adminWorkspaces(limitOf(request)) };
    },
  );
  app.get(
    apiRoutes.adminJobs,
    { schema: { querystring: AdminLimitQuerySchema, response: { 200: AdminJobListSchema } } },
    async (request) => {
      requireAdmin(request.principal);
      return { jobs: await repository.adminFailedJobs(limitOf(request)) };
    },
  );
}
