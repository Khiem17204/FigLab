/** Lab workspaces, invite links, folders, templates, comments, and the admin overview. */

export type WorkspaceKind = "personal" | "lab";
export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";
export type InviteRole = Exclude<WorkspaceRole, "owner">;
/** What a request needs: reading (viewers up), writing (editors up), or managing (admins up). */
export type WorkspaceAccess = "read" | "write" | "manage";

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
const NEEDED: Record<WorkspaceAccess, number> = { read: 1, write: 2, manage: 3 };

export function roleAllows(role: WorkspaceRole, access: WorkspaceAccess): boolean {
  return RANK[role] >= NEEDED[access];
}
/** Admins manage editors and viewers; only owners grant, change, or remove owners and admins. */
export function canAssignRole(
  actor: WorkspaceRole,
  from: WorkspaceRole | undefined,
  to: WorkspaceRole | undefined,
): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin") return false;
  const touchesAdmins = [from, to].some((role) => role === "owner" || role === "admin");
  return !touchesAdmins;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: WorkspaceKind;
  /** The caller's role. */
  role: WorkspaceRole;
  memberCount: number;
  createdAt: string;
}
export interface WorkspaceMember {
  userId: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";
export interface InviteRecord {
  id: string;
  workspaceId: string;
  role: InviteRole;
  /** When set, only a signed-in user with this email can accept. */
  email?: string;
  createdBy: { id: string; email: string };
  acceptedBy?: { id: string; email: string };
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
}
export interface InvitePreview {
  workspaceId: string;
  workspaceName: string;
  role: InviteRole;
  email?: string;
  status: InviteStatus;
  expiresAt: string;
}
export interface FolderRecord {
  id: string;
  workspaceId: string;
  parentId?: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface TemplateSummary {
  id: string;
  workspaceId: string;
  name: string;
  createdBy?: { id: string; email: string };
  createdAt: string;
}
export interface TemplateRecord extends TemplateSummary {
  schemaVersion: number;
  document: unknown;
}
export interface CommentAnchor {
  artboardId: string;
  objectId?: string;
  xPt?: number;
  yPt?: number;
}
export interface CommentRecord {
  id: string;
  projectId: string;
  parentId?: string;
  author: { id: string; email: string };
  anchor?: CommentAnchor;
  body: string;
  resolvedAt?: string;
  resolvedBy?: { id: string; email: string };
  createdAt: string;
  updatedAt: string;
}
export interface ProjectFilter {
  /** Case-insensitive substring of the project name. */
  query?: string;
  /** A folder id, or `null` for projects at the workspace root; omitted lists every folder. */
  folderId?: string | null;
  createdBy?: string;
}
export interface ProjectSearchHit {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  folderId?: string;
  /** Asset filenames in the project that match the query. */
  matchedFilenames: string[];
  updatedAt: string;
}
export interface AdminOverview {
  users: number;
  personalWorkspaces: number;
  labWorkspaces: number;
  projects: number;
  assets: number;
  storageBytes: number;
  pendingIntegrityReports: number;
  failedJobs: number;
}
export interface AdminUser {
  id: string;
  email: string;
  workspaces: number;
  projects: number;
  createdAt: string;
}
export interface AdminWorkspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  members: number;
  projects: number;
  assets: number;
  storageBytes: number;
  createdAt: string;
}
export interface AdminJob {
  id: string;
  task: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  runAt: string;
}

export class ForbiddenError extends Error {
  constructor(message = "Your role in this workspace does not allow this") {
    super(message);
    this.name = "ForbiddenError";
  }
}
/** An invite link that cannot be used, with a reason the user can act on. */
export class InviteUnavailableError extends Error {
  constructor(
    readonly reason: "expired" | "revoked" | "accepted" | "email-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "InviteUnavailableError";
  }
}

export interface CollaborationRepository {
  /** The user's role in the workspace, or undefined for non-members. */
  getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined>;
  getWorkspace(workspaceId: string): Promise<{ id: string; name: string; kind: WorkspaceKind }>;
  /** The caller's workspaces, personal first, then labs by name. */
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  createLabWorkspace(userId: string, name: string): Promise<WorkspaceSummary>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  /** Throws `ConflictError` when the change would leave the workspace without an owner. */
  setMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember>;
  /** Throws `ConflictError` when it would remove the last owner. */
  removeMember(workspaceId: string, userId: string): Promise<void>;
  createInvite(input: {
    workspaceId: string;
    role: InviteRole;
    email?: string;
    createdBy: string;
    tokenSha256: string;
    expiresAt: string;
  }): Promise<InviteRecord>;
  /** Newest first. */
  listInvites(workspaceId: string): Promise<InviteRecord[]>;
  revokeInvite(workspaceId: string, inviteId: string): Promise<InviteRecord>;
  previewInvite(tokenSha256: string): Promise<InvitePreview>;
  /**
   * Adds the user with the invite's role and uses the invite up. Existing members keep their
   * role and the invite stays unused. Throws `InviteUnavailableError`.
   */
  acceptInvite(tokenSha256: string, user: { id: string; email: string }): Promise<WorkspaceSummary>;

  listFolders(workspaceId: string): Promise<FolderRecord[]>;
  getFolder(folderId: string): Promise<FolderRecord>;
  /** Throws `NotFoundError` when the parent is not a folder of the same workspace. */
  createFolder(workspaceId: string, name: string, parentId?: string): Promise<FolderRecord>;
  /** Throws `ConflictError` when moving a folder into itself or a descendant. */
  updateFolder(
    folderId: string,
    patch: { name?: string; parentId?: string | null; archived?: boolean },
  ): Promise<FolderRecord>;
  searchProjects(userId: string, query: string, limit: number): Promise<ProjectSearchHit[]>;

  createTemplate(input: {
    workspaceId: string;
    name: string;
    document: unknown;
    createdBy: string;
  }): Promise<TemplateSummary>;
  listTemplates(workspaceId: string): Promise<TemplateSummary[]>;
  getTemplate(templateId: string): Promise<TemplateRecord>;
  deleteTemplate(templateId: string): Promise<void>;

  createComment(input: {
    projectId: string;
    authorUserId: string;
    body: string;
    parentId?: string;
    anchor?: CommentAnchor;
  }): Promise<CommentRecord>;
  /** Oldest first. */
  listComments(projectId: string): Promise<CommentRecord[]>;
  getComment(commentId: string): Promise<CommentRecord>;
  updateComment(
    commentId: string,
    patch: { body?: string; resolvedBy?: string | null },
    actorUserId: string,
  ): Promise<CommentRecord>;
  /** Deletes the comment and its replies. */
  deleteComment(commentId: string, actorUserId: string): Promise<void>;

  adminOverview(): Promise<AdminOverview>;
  adminUsers(limit: number): Promise<AdminUser[]>;
  adminWorkspaces(limit: number): Promise<AdminWorkspace[]>;
  adminFailedJobs(limit: number): Promise<AdminJob[]>;
}
