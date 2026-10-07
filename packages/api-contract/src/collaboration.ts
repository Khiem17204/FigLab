import { type Static, Type } from "@sinclair/typebox";

const Id = Type.String({ minLength: 1 });
const Uuid = Type.String({ format: "uuid" });
const Timestamp = Type.String({ minLength: 1 });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const UserRef = Type.Object({ id: Id, email: Type.String() }, { additionalProperties: false });

export const WorkspaceKindSchema = Type.Union([Type.Literal("personal"), Type.Literal("lab")]);
export const WorkspaceRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("editor"),
  Type.Literal("viewer"),
]);
export const InviteRoleSchema = Type.Union([
  Type.Literal("admin"),
  Type.Literal("editor"),
  Type.Literal("viewer"),
]);
export type WorkspaceRoleDto = Static<typeof WorkspaceRoleSchema>;

export const WorkspaceSchema = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    kind: WorkspaceKindSchema,
    role: WorkspaceRoleSchema,
    memberCount: Type.Integer({ minimum: 0 }),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);
export type Workspace = Static<typeof WorkspaceSchema>;
export const WorkspaceListResponseSchema = Type.Object(
  { workspaces: Type.Array(WorkspaceSchema) },
  { additionalProperties: false },
);
export const CreateWorkspaceRequestSchema = Type.Object(
  { name: Name },
  { additionalProperties: false },
);
export const WorkspaceParamsSchema = Type.Object(
  { workspaceId: Uuid },
  { additionalProperties: false },
);

export const WorkspaceMemberSchema = Type.Object(
  { userId: Id, email: Type.String(), role: WorkspaceRoleSchema, joinedAt: Timestamp },
  { additionalProperties: false },
);
export type WorkspaceMemberDto = Static<typeof WorkspaceMemberSchema>;
export const WorkspaceMemberListSchema = Type.Object(
  { members: Type.Array(WorkspaceMemberSchema) },
  { additionalProperties: false },
);
export const MemberParamsSchema = Type.Object(
  { workspaceId: Uuid, userId: Uuid },
  { additionalProperties: false },
);
export const UpdateMemberRequestSchema = Type.Object(
  { role: WorkspaceRoleSchema },
  { additionalProperties: false },
);

export const InviteStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
]);
export const InviteSchema = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    role: InviteRoleSchema,
    email: Type.Optional(Type.String()),
    createdBy: UserRef,
    acceptedBy: Type.Optional(UserRef),
    status: InviteStatusSchema,
    expiresAt: Timestamp,
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);
export type InviteDto = Static<typeof InviteSchema>;
export const InviteListSchema = Type.Object(
  { invites: Type.Array(InviteSchema) },
  { additionalProperties: false },
);
export const CreateInviteRequestSchema = Type.Object(
  {
    role: InviteRoleSchema,
    /** Restricts the link to one account's email. */
    email: Type.Optional(Type.String({ format: "email", maxLength: 254 })),
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  },
  { additionalProperties: false },
);
export const CreateInviteResponseSchema = Type.Object(
  {
    invite: InviteSchema,
    /** Shown once: the server keeps only its SHA-256. */
    token: Type.String({ minLength: 43 }),
  },
  { additionalProperties: false },
);
export const InviteParamsSchema = Type.Object(
  { workspaceId: Uuid, inviteId: Uuid },
  { additionalProperties: false },
);
export const InviteTokenParamsSchema = Type.Object(
  { token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }) },
  { additionalProperties: false },
);
export const InvitePreviewSchema = Type.Object(
  {
    workspaceId: Id,
    workspaceName: Type.String(),
    role: InviteRoleSchema,
    email: Type.Optional(Type.String()),
    status: InviteStatusSchema,
    expiresAt: Timestamp,
  },
  { additionalProperties: false },
);
export type InvitePreviewDto = Static<typeof InvitePreviewSchema>;

export const FolderSchema = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    parentId: Type.Optional(Id),
    name: Type.String({ minLength: 1 }),
    archived: Type.Boolean(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type Folder = Static<typeof FolderSchema>;
export const FolderListSchema = Type.Object(
  { folders: Type.Array(FolderSchema) },
  { additionalProperties: false },
);
export const CreateFolderRequestSchema = Type.Object(
  { name: Name, parentId: Type.Optional(Uuid) },
  { additionalProperties: false },
);
export const UpdateFolderRequestSchema = Type.Object(
  {
    name: Type.Optional(Name),
    parentId: Type.Optional(Type.Union([Uuid, Type.Null()])),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const FolderParamsSchema = Type.Object(
  { workspaceId: Uuid, folderId: Uuid },
  { additionalProperties: false },
);
export const MoveProjectRequestSchema = Type.Object(
  { folderId: Type.Union([Uuid, Type.Null()]) },
  { additionalProperties: false },
);
export const WorkspaceProjectsQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 120 })),
    /** A folder id, or `root` for projects outside any folder. */
    folderId: Type.Optional(Type.Union([Uuid, Type.Literal("root")])),
    createdBy: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);

export const SearchQuerySchema = Type.Object(
  {
    q: Type.String({ minLength: 1, maxLength: 120 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
export const SearchHitSchema = Type.Object(
  {
    projectId: Id,
    projectName: Type.String(),
    workspaceId: Id,
    workspaceName: Type.String(),
    folderId: Type.Optional(Id),
    matchedFilenames: Type.Array(Type.String()),
    updatedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type SearchHit = Static<typeof SearchHitSchema>;
export const SearchResponseSchema = Type.Object(
  { results: Type.Array(SearchHitSchema) },
  { additionalProperties: false },
);

export const TemplateSchema = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    name: Type.String({ minLength: 1 }),
    createdBy: Type.Optional(UserRef),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);
export type Template = Static<typeof TemplateSchema>;
export const TemplateListSchema = Type.Object(
  { templates: Type.Array(TemplateSchema) },
  { additionalProperties: false },
);
export const CreateTemplateRequestSchema = Type.Object(
  {
    name: Name,
    /** The project whose current figure becomes the template (images are stripped). */
    projectId: Uuid,
  },
  { additionalProperties: false },
);
export const TemplateParamsSchema = Type.Object(
  { workspaceId: Uuid, templateId: Uuid },
  { additionalProperties: false },
);

export const CommentAnchorSchema = Type.Object(
  {
    artboardId: Type.String({ minLength: 1, maxLength: 128 }),
    objectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    xPt: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
    yPt: Type.Optional(Type.Number({ minimum: -100_000, maximum: 100_000 })),
  },
  { additionalProperties: false },
);
export const CommentSchema = Type.Object(
  {
    id: Id,
    projectId: Id,
    parentId: Type.Optional(Id),
    author: UserRef,
    anchor: Type.Optional(CommentAnchorSchema),
    body: Type.String({ minLength: 1 }),
    resolvedAt: Type.Optional(Timestamp),
    resolvedBy: Type.Optional(UserRef),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type CommentDto = Static<typeof CommentSchema>;
export const CommentListSchema = Type.Object(
  { comments: Type.Array(CommentSchema) },
  { additionalProperties: false },
);
export const CreateCommentRequestSchema = Type.Object(
  {
    body: Type.String({ minLength: 1, maxLength: 4000 }),
    parentId: Type.Optional(Uuid),
    anchor: Type.Optional(CommentAnchorSchema),
  },
  { additionalProperties: false },
);
export type CreateCommentRequest = Static<typeof CreateCommentRequestSchema>;
export const UpdateCommentRequestSchema = Type.Object(
  {
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    resolved: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const CommentParamsSchema = Type.Object(
  { projectId: Uuid, commentId: Uuid },
  { additionalProperties: false },
);

export const AdminLimitQuerySchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) },
  { additionalProperties: false },
);
export const AdminOverviewSchema = Type.Object(
  {
    users: Type.Integer(),
    personalWorkspaces: Type.Integer(),
    labWorkspaces: Type.Integer(),
    projects: Type.Integer(),
    assets: Type.Integer(),
    storageBytes: Type.Integer(),
    pendingIntegrityReports: Type.Integer(),
    failedJobs: Type.Integer(),
  },
  { additionalProperties: false },
);
export type AdminOverviewDto = Static<typeof AdminOverviewSchema>;
export const AdminUserListSchema = Type.Object(
  {
    users: Type.Array(
      Type.Object(
        {
          id: Id,
          email: Type.String(),
          workspaces: Type.Integer(),
          projects: Type.Integer(),
          createdAt: Timestamp,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AdminUserListDto = Static<typeof AdminUserListSchema>;
export const AdminWorkspaceListSchema = Type.Object(
  {
    workspaces: Type.Array(
      Type.Object(
        {
          id: Id,
          name: Type.String(),
          kind: WorkspaceKindSchema,
          members: Type.Integer(),
          projects: Type.Integer(),
          assets: Type.Integer(),
          storageBytes: Type.Integer(),
          createdAt: Timestamp,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AdminWorkspaceListDto = Static<typeof AdminWorkspaceListSchema>;
export const AdminJobListSchema = Type.Object(
  {
    jobs: Type.Array(
      Type.Object(
        {
          id: Id,
          task: Type.String(),
          attempts: Type.Integer(),
          maxAttempts: Type.Integer(),
          lastError: Type.Optional(Type.String()),
          runAt: Timestamp,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AdminJobListDto = Static<typeof AdminJobListSchema>;
