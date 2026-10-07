import { randomUUID } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  ActorOptions,
  AdminJob,
  AdminOverview,
  AdminUser,
  AdminWorkspace,
  AssetRecord,
  AuditEvent,
  AuditEventPage,
  AuthUserIdentity,
  CommentAnchor,
  CommentRecord,
  CreateProjectOptions,
  DocumentRecord,
  ExportRecord,
  FigLabRepository,
  FolderRecord,
  IntegrityReportRecord,
  InvitePreview,
  InviteRecord,
  InviteRole,
  InviteStatus,
  Principal,
  ProjectFilter,
  ProjectRecord,
  ProjectSearchHit,
  TemplateRecord,
  TemplateSummary,
  UploadRecord,
  VersionRecord,
  VersionSummary,
  WorkspaceKind,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSummary,
} from "./index.js";
import {
  assertInviteUsable,
  assertResourceId,
  byWorkspaceOrder,
  ConflictError,
  deriveDocumentAuditEvents,
  deriveDocumentDiff,
  exportAuditDetails,
  NotFoundError,
  schemaVersionOf,
  UploadExpiredError,
} from "./index.js";
import * as schema from "./schema.js";

const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const LOCAL_MEMBERSHIP_ID = "00000000-0000-4000-8000-000000000003";
const defaultDocument = () => ({
  schemaVersion: 3,
  sources: [],
  artboards: [
    { id: randomUUID(), name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" },
  ],
  objects: [],
  groups: [],
  constraints: [],
  styles: [],
});

export class PostgresFigLabRepository implements FigLabRepository {
  readonly db: NodePgDatabase<typeof schema>;
  constructor(private readonly pool: Pool) {
    this.db = drizzle(pool, { schema });
  }

  async bootstrapSingleUser(email = "local-admin@figlab.invalid"): Promise<Principal> {
    return this.transaction(async (client) => {
      const now = new Date();
      await client.query(
        "INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(email) DO UPDATE SET updated_at=users.updated_at",
        [LOCAL_USER_ID, email, now],
      );
      await client.query(
        "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(id) DO NOTHING",
        [LOCAL_WORKSPACE_ID, "Default workspace", now],
      );
      await client.query(
        "INSERT INTO workspace_members(id,workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,'owner',$4,$4) ON CONFLICT(workspace_id,user_id) DO NOTHING",
        [LOCAL_MEMBERSHIP_ID, LOCAL_WORKSPACE_ID, LOCAL_USER_ID, now],
      );
      return {
        id: LOCAL_USER_ID,
        email,
        workspaceId: LOCAL_WORKSPACE_ID,
      };
    });
  }
  async ensureAuthUser(identity: AuthUserIdentity): Promise<Principal> {
    assertResourceId(identity.id);
    return this.transaction(async (client) => {
      // Serialize first sign-in per user so concurrent requests cannot create two workspaces.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [identity.id]);
      const now = new Date();
      await client.query(
        "INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email, updated_at=CASE WHEN users.email=EXCLUDED.email THEN users.updated_at ELSE EXCLUDED.updated_at END",
        [identity.id, identity.email, now],
      );
      const membership = await client.query<{ workspace_id: string }>(
        "SELECT m.workspace_id FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 AND m.role='owner' AND w.kind='personal' ORDER BY m.created_at LIMIT 1",
        [identity.id],
      );
      const existing = membership.rows[0]?.workspace_id;
      if (existing) return { id: identity.id, email: identity.email, workspaceId: existing };
      const workspaceId = randomUUID();
      await client.query(
        "INSERT INTO workspaces(id,name,kind,created_by,created_at,updated_at) VALUES($1,$2,'personal',$3,$4,$4)",
        [workspaceId, "Personal workspace", identity.id, now],
      );
      await client.query(
        "INSERT INTO workspace_members(id,workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,'owner',$4,$4)",
        [randomUUID(), workspaceId, identity.id, now],
      );
      return { id: identity.id, email: identity.email, workspaceId };
    });
  }
  async createProject(
    workspaceId: string,
    name: string,
    options: CreateProjectOptions = {},
  ): Promise<ProjectRecord> {
    assertResourceId(workspaceId);
    return this.transaction(async (client) => {
      if (options.folderId) await this.folderIn(client, workspaceId, options.folderId);
      const id = randomUUID();
      const now = new Date();
      const document = options.document ?? defaultDocument();
      const result = await client.query(
        "INSERT INTO projects(id,workspace_id,name,status,folder_id,created_by,created_at,updated_at) VALUES($1,$2,$3,'active',$4,$5,$6,$6) RETURNING *",
        [id, workspaceId, name, options.folderId ?? null, options.actorUserId ?? null, now],
      );
      await client.query(
        "INSERT INTO project_documents(project_id,revision,schema_version,document,created_at,updated_at) VALUES($1,0,$2,$3,$4,$4)",
        [id, schemaVersionOf(document), document, now],
      );
      await this.insertAudit(client, id, "PROJECT_CREATED", { name }, options.actorUserId);
      return projectRow(first(result.rows));
    });
  }
  async listProjects(workspaceId: string, filter: ProjectFilter = {}): Promise<ProjectRecord[]> {
    assertResourceId(workspaceId);
    const conditions = ["workspace_id=$1", "status='active'"];
    const values: unknown[] = [workspaceId];
    const query = filter.query?.trim().toLowerCase();
    if (query) {
      values.push(query);
      conditions.push(`strpos(lower(name),$${values.length})>0`);
    }
    if (filter.folderId === null) conditions.push("folder_id IS NULL");
    else if (filter.folderId !== undefined) {
      assertResourceId(filter.folderId);
      values.push(filter.folderId);
      conditions.push(`folder_id=$${values.length}`);
    }
    if (filter.createdBy) {
      assertResourceId(filter.createdBy);
      values.push(filter.createdBy);
      conditions.push(`created_by=$${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM projects WHERE ${conditions.join(" AND ")} ORDER BY created_at, id`,
      values,
    );
    return result.rows.map(projectRow);
  }
  async getProject(projectId: string): Promise<ProjectRecord> {
    assertResourceId(projectId);
    const result = await this.pool.query("SELECT * FROM projects WHERE id=$1", [projectId]);
    const row = first(result.rows);
    if (row.status === "deleted") throw new NotFoundError();
    return projectRow(row);
  }
  async moveProject(
    projectId: string,
    folderId: string | null,
    options: ActorOptions = {},
  ): Promise<ProjectRecord> {
    assertResourceId(projectId);
    return this.transaction(async (client) => {
      const project = projectRow(
        first(
          (
            await client.query(
              "SELECT * FROM projects WHERE id=$1 AND status<>'deleted' FOR UPDATE",
              [projectId],
            )
          ).rows,
        ),
      );
      if (folderId) await this.folderIn(client, project.workspaceId, folderId);
      const result = await client.query(
        "UPDATE projects SET folder_id=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [projectId, folderId],
      );
      await this.insertAudit(client, projectId, "PROJECT_MOVED", { folderId }, options.actorUserId);
      return projectRow(first(result.rows));
    });
  }
  private async folderIn(
    client: PoolClient | Pool,
    workspaceId: string,
    folderId: string,
  ): Promise<FolderRecord> {
    assertResourceId(folderId);
    const folder = folderRow(
      first((await client.query("SELECT * FROM folders WHERE id=$1", [folderId])).rows),
    );
    if (folder.workspaceId !== workspaceId) throw new NotFoundError();
    return folder;
  }

  // Workspaces and members
  async getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | undefined> {
    assertResourceId(workspaceId);
    assertResourceId(userId);
    const result = await this.pool.query<{ role: WorkspaceRole }>(
      "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
      [workspaceId, userId],
    );
    return result.rows[0]?.role;
  }
  async getWorkspace(
    workspaceId: string,
  ): Promise<{ id: string; name: string; kind: WorkspaceKind }> {
    assertResourceId(workspaceId);
    const row = first(
      (
        await this.pool.query(
          "SELECT id,name,kind FROM workspaces WHERE id=$1 AND deleted_at IS NULL",
          [workspaceId],
        )
      ).rows,
    );
    return { id: row.id, name: row.name, kind: row.kind };
  }
  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    assertResourceId(userId);
    const result = await this.pool.query(`${WORKSPACE_SELECT} WHERE m.user_id=$1`, [userId]);
    return result.rows.map(workspaceRow).sort(byWorkspaceOrder);
  }
  private async workspaceSummary(
    client: PoolClient | Pool,
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceSummary> {
    return workspaceRow(
      first(
        (
          await client.query(`${WORKSPACE_SELECT} WHERE m.workspace_id=$1 AND m.user_id=$2`, [
            workspaceId,
            userId,
          ])
        ).rows,
      ),
    );
  }
  async createLabWorkspace(userId: string, name: string): Promise<WorkspaceSummary> {
    assertResourceId(userId);
    return this.transaction(async (client) => {
      const id = randomUUID();
      await client.query(
        "INSERT INTO workspaces(id,name,kind,created_by,created_at,updated_at) VALUES($1,$2,'lab',$3,now(),now())",
        [id, name, userId],
      );
      await client.query(
        "INSERT INTO workspace_members(id,workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,'owner',now(),now())",
        [randomUUID(), id, userId],
      );
      return this.workspaceSummary(client, id, userId);
    });
  }
  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    assertResourceId(workspaceId);
    first(
      (
        await this.pool.query(
          "UPDATE workspaces SET name=$2,updated_at=now() WHERE id=$1 RETURNING id",
          [workspaceId, name],
        )
      ).rows,
    );
  }
  async deleteLabWorkspace(workspaceId: string): Promise<void> {
    assertResourceId(workspaceId);
    await this.transaction(async (client) => {
      const workspace = first(
        (
          await client.query(
            "SELECT kind FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
            [workspaceId],
          )
        ).rows,
      );
      if (workspace.kind !== "lab") throw new NotFoundError();
      const live = await client.query(
        "SELECT 1 FROM projects WHERE workspace_id=$1 AND status<>'deleted' LIMIT 1",
        [workspaceId],
      );
      if ((live.rowCount ?? 0) > 0)
        throw new ConflictError("Delete or move the lab's projects first");
      await client.query("UPDATE projects SET folder_id=NULL WHERE workspace_id=$1", [workspaceId]);
      await client.query("DELETE FROM workspace_invites WHERE workspace_id=$1", [workspaceId]);
      await client.query("DELETE FROM project_templates WHERE workspace_id=$1", [workspaceId]);
      await client.query("UPDATE folders SET parent_id=NULL WHERE workspace_id=$1", [workspaceId]);
      await client.query("DELETE FROM folders WHERE workspace_id=$1", [workspaceId]);
      await client.query("DELETE FROM workspace_members WHERE workspace_id=$1", [workspaceId]);
      await client.query("UPDATE workspaces SET deleted_at=now(),updated_at=now() WHERE id=$1", [
        workspaceId,
      ]);
    });
  }
  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    assertResourceId(workspaceId);
    const result = await this.pool.query(
      `${MEMBER_SELECT} WHERE m.workspace_id=$1 ORDER BY m.created_at, u.email`,
      [workspaceId],
    );
    return result.rows.map(memberRow);
  }
  async setMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember> {
    assertResourceId(workspaceId);
    assertResourceId(userId);
    return this.transaction(async (client) => {
      const current = await this.lockedMember(client, workspaceId, userId);
      if (current.role === "owner" && role !== "owner")
        await this.assertAnotherOwner(client, workspaceId, userId);
      await client.query(
        "UPDATE workspace_members SET role=$3,updated_at=now() WHERE workspace_id=$1 AND user_id=$2",
        [workspaceId, userId, role],
      );
      return memberRow(
        first(
          (
            await client.query(`${MEMBER_SELECT} WHERE m.workspace_id=$1 AND m.user_id=$2`, [
              workspaceId,
              userId,
            ])
          ).rows,
        ),
      );
    });
  }
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    assertResourceId(workspaceId);
    assertResourceId(userId);
    await this.transaction(async (client) => {
      const current = await this.lockedMember(client, workspaceId, userId);
      if (current.role === "owner") await this.assertAnotherOwner(client, workspaceId, userId);
      await client.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [
        workspaceId,
        userId,
      ]);
    });
  }
  /** Locks every membership row of the workspace, so owner checks cannot race. */
  private async lockedMember(
    client: PoolClient,
    workspaceId: string,
    userId: string,
  ): Promise<{ role: WorkspaceRole }> {
    const rows = (
      await client.query<{ user_id: string; role: WorkspaceRole }>(
        "SELECT user_id,role FROM workspace_members WHERE workspace_id=$1 ORDER BY id FOR UPDATE",
        [workspaceId],
      )
    ).rows;
    const member = rows.find((row) => row.user_id === userId);
    if (!member) throw new NotFoundError();
    return member;
  }
  private async assertAnotherOwner(
    client: PoolClient,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const others = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id<>$2 AND role='owner'",
      [workspaceId, userId],
    );
    if (others.rowCount === 0) throw new ConflictError("A workspace needs at least one owner");
  }
  async createInvite(input: {
    workspaceId: string;
    role: InviteRole;
    email?: string;
    createdBy: string;
    tokenSha256: string;
    expiresAt: string;
  }): Promise<InviteRecord> {
    assertResourceId(input.workspaceId);
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO workspace_invites(id,workspace_id,token_sha256,role,email,created_by,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())",
      [
        id,
        input.workspaceId,
        input.tokenSha256,
        input.role,
        input.email ?? null,
        input.createdBy,
        input.expiresAt,
      ],
    );
    return inviteRow(first((await this.pool.query(`${INVITE_SELECT} WHERE i.id=$1`, [id])).rows));
  }
  async listInvites(workspaceId: string): Promise<InviteRecord[]> {
    assertResourceId(workspaceId);
    const result = await this.pool.query(
      `${INVITE_SELECT} WHERE i.workspace_id=$1 ORDER BY i.created_at DESC, i.id`,
      [workspaceId],
    );
    return result.rows.map(inviteRow);
  }
  async revokeInvite(workspaceId: string, inviteId: string): Promise<InviteRecord> {
    assertResourceId(workspaceId);
    assertResourceId(inviteId);
    await this.pool.query(
      "UPDATE workspace_invites SET revoked_at=now() WHERE id=$2 AND workspace_id=$1 AND accepted_by IS NULL AND revoked_at IS NULL",
      [workspaceId, inviteId],
    );
    return inviteRow(
      first(
        (
          await this.pool.query(`${INVITE_SELECT} WHERE i.id=$1 AND i.workspace_id=$2`, [
            inviteId,
            workspaceId,
          ])
        ).rows,
      ),
    );
  }
  async previewInvite(tokenSha256: string): Promise<InvitePreview> {
    const row = first(
      (
        await this.pool.query(
          `${INVITE_SELECT.replace("FROM workspace_invites i", "FROM workspace_invites i JOIN workspaces w ON w.id=i.workspace_id").replace("SELECT i.*", "SELECT i.*, w.name AS workspace_name")} WHERE i.token_sha256=$1`,
          [tokenSha256],
        )
      ).rows,
    );
    const invite = inviteRow(row);
    return {
      workspaceId: invite.workspaceId,
      workspaceName: row.workspace_name,
      role: invite.role,
      ...(invite.email ? { email: invite.email } : {}),
      status: invite.status,
      expiresAt: invite.expiresAt,
    };
  }
  async acceptInvite(
    tokenSha256: string,
    user: { id: string; email: string },
  ): Promise<WorkspaceSummary> {
    assertResourceId(user.id);
    return this.transaction(async (client) => {
      const locked = first(
        (
          await client.query("SELECT id FROM workspace_invites WHERE token_sha256=$1 FOR UPDATE", [
            tokenSha256,
          ])
        ).rows,
      );
      const invite = inviteRow(
        first((await client.query(`${INVITE_SELECT} WHERE i.id=$1`, [locked.id])).rows),
      );
      const existing = await client.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
        [invite.workspaceId, user.id],
      );
      if (existing.rowCount === 0) {
        assertInviteUsable(invite.status, invite.email, user.email);
        await client.query(
          "INSERT INTO workspace_members(id,workspace_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,$4,now(),now())",
          [randomUUID(), invite.workspaceId, user.id, invite.role],
        );
        await client.query(
          "UPDATE workspace_invites SET accepted_by=$2,accepted_at=now() WHERE id=$1",
          [invite.id, user.id],
        );
      }
      return this.workspaceSummary(client, invite.workspaceId, user.id);
    });
  }

  // Folders and search
  async listFolders(workspaceId: string): Promise<FolderRecord[]> {
    assertResourceId(workspaceId);
    const result = await this.pool.query(
      "SELECT * FROM folders WHERE workspace_id=$1 ORDER BY lower(name), created_at",
      [workspaceId],
    );
    return result.rows.map(folderRow);
  }
  async getFolder(folderId: string): Promise<FolderRecord> {
    assertResourceId(folderId);
    return folderRow(
      first((await this.pool.query("SELECT * FROM folders WHERE id=$1", [folderId])).rows),
    );
  }
  async createFolder(workspaceId: string, name: string, parentId?: string): Promise<FolderRecord> {
    assertResourceId(workspaceId);
    if (parentId) await this.folderIn(this.pool, workspaceId, parentId);
    const result = await this.pool.query(
      "INSERT INTO folders(id,workspace_id,parent_id,name,created_at,updated_at) VALUES($1,$2,$3,$4,now(),now()) RETURNING *",
      [randomUUID(), workspaceId, parentId ?? null, name],
    );
    return folderRow(first(result.rows));
  }
  async updateFolder(
    folderId: string,
    patch: { name?: string; parentId?: string | null; archived?: boolean },
  ): Promise<FolderRecord> {
    assertResourceId(folderId);
    return this.transaction(async (client) => {
      const folder = folderRow(
        first(
          (await client.query("SELECT * FROM folders WHERE id=$1 FOR UPDATE", [folderId])).rows,
        ),
      );
      if (patch.parentId) {
        await this.folderIn(client, folder.workspaceId, patch.parentId);
        const cycle = await client.query(
          "WITH RECURSIVE up(id,parent_id) AS (SELECT id,parent_id FROM folders WHERE id=$1 UNION ALL SELECT f.id,f.parent_id FROM folders f JOIN up ON f.id=up.parent_id) SELECT 1 FROM up WHERE id=$2",
          [patch.parentId, folderId],
        );
        if ((cycle.rowCount ?? 0) > 0) throw new ConflictError("A folder cannot move into itself");
      }
      const result = await client.query(
        `UPDATE folders SET
           name=COALESCE($2,name),
           parent_id=CASE WHEN $3::boolean THEN $4::uuid ELSE parent_id END,
           archived_at=CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at,now()) ELSE NULL END,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [
          folderId,
          patch.name ?? null,
          patch.parentId !== undefined,
          patch.parentId ?? null,
          patch.archived ?? null,
        ],
      );
      return folderRow(first(result.rows));
    });
  }
  async searchProjects(userId: string, query: string, limit: number): Promise<ProjectSearchHit[]> {
    assertResourceId(userId);
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const result = await this.pool.query(
      `SELECT p.id, p.name, p.workspace_id, w.name AS workspace_name, p.folder_id, p.updated_at,
         COALESCE(array_agg(a.filename ORDER BY a.filename) FILTER (WHERE a.id IS NOT NULL), '{}') AS filenames
       FROM workspace_members m
       JOIN workspaces w ON w.id=m.workspace_id
       JOIN projects p ON p.workspace_id=w.id AND p.status='active'
       LEFT JOIN assets a ON a.project_id=p.id AND strpos(lower(a.filename),$2)>0
       WHERE m.user_id=$1
       GROUP BY p.id, w.name
       HAVING strpos(lower(p.name),$2)>0 OR count(a.id)>0
       ORDER BY p.updated_at DESC, p.id
       LIMIT $3`,
      [userId, needle, limit],
    );
    return result.rows.map((row) => ({
      projectId: row.id,
      projectName: row.name,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      ...(row.folder_id ? { folderId: row.folder_id } : {}),
      matchedFilenames: row.filenames,
      updatedAt: date(row.updated_at),
    }));
  }

  // Templates
  async createTemplate(input: {
    workspaceId: string;
    name: string;
    document: unknown;
    createdBy: string;
  }): Promise<TemplateSummary> {
    assertResourceId(input.workspaceId);
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO project_templates(id,workspace_id,name,schema_version,document,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,now(),now())",
      [
        id,
        input.workspaceId,
        input.name,
        schemaVersionOf(input.document),
        input.document,
        input.createdBy,
      ],
    );
    return templateRow(
      first((await this.pool.query(`${TEMPLATE_SELECT} WHERE t.id=$1`, [id])).rows),
    );
  }
  async listTemplates(workspaceId: string): Promise<TemplateSummary[]> {
    assertResourceId(workspaceId);
    const result = await this.pool.query(
      `${TEMPLATE_SELECT} WHERE t.workspace_id=$1 ORDER BY t.created_at DESC, t.id`,
      [workspaceId],
    );
    return result.rows.map(templateRow);
  }
  async getTemplate(templateId: string): Promise<TemplateRecord> {
    assertResourceId(templateId);
    const row = first(
      (
        await this.pool.query(
          `${TEMPLATE_SELECT.replace("SELECT t.id,", "SELECT t.document, t.schema_version, t.id,")} WHERE t.id=$1`,
          [templateId],
        )
      ).rows,
    );
    return { ...templateRow(row), schemaVersion: row.schema_version, document: row.document };
  }
  async deleteTemplate(templateId: string): Promise<void> {
    assertResourceId(templateId);
    const result = await this.pool.query("DELETE FROM project_templates WHERE id=$1", [templateId]);
    if (result.rowCount === 0) throw new NotFoundError();
  }

  // Comments
  async createComment(input: {
    projectId: string;
    authorUserId: string;
    body: string;
    parentId?: string;
    anchor?: CommentAnchor;
  }): Promise<CommentRecord> {
    assertResourceId(input.projectId);
    return this.transaction(async (client) => {
      if (input.parentId) {
        assertResourceId(input.parentId);
        const parent = first(
          (
            await client.query("SELECT project_id,parent_id FROM comments WHERE id=$1", [
              input.parentId,
            ])
          ).rows,
        );
        if (parent.project_id !== input.projectId || parent.parent_id) throw new NotFoundError();
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO comments(id,project_id,parent_id,author_user_id,artboard_id,object_id,x_pt,y_pt,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())",
        [
          id,
          input.projectId,
          input.parentId ?? null,
          input.authorUserId,
          input.anchor?.artboardId ?? null,
          input.anchor?.objectId ?? null,
          input.anchor?.xPt ?? null,
          input.anchor?.yPt ?? null,
          input.body,
        ],
      );
      await this.insertAudit(
        client,
        input.projectId,
        "COMMENT_ADDED",
        { commentId: id, ...(input.parentId ? { parentId: input.parentId } : {}) },
        input.authorUserId,
      );
      return commentRow(first((await client.query(`${COMMENT_SELECT} WHERE c.id=$1`, [id])).rows));
    });
  }
  async listComments(projectId: string): Promise<CommentRecord[]> {
    assertResourceId(projectId);
    const result = await this.pool.query(
      `${COMMENT_SELECT} WHERE c.project_id=$1 ORDER BY c.created_at, c.id`,
      [projectId],
    );
    return result.rows.map(commentRow);
  }
  async getComment(commentId: string): Promise<CommentRecord> {
    assertResourceId(commentId);
    return commentRow(
      first((await this.pool.query(`${COMMENT_SELECT} WHERE c.id=$1`, [commentId])).rows),
    );
  }
  async updateComment(
    commentId: string,
    patch: { body?: string; resolvedBy?: string | null },
    actorUserId: string,
  ): Promise<CommentRecord> {
    assertResourceId(commentId);
    return this.transaction(async (client) => {
      const before = first(
        (
          await client.query("SELECT project_id,resolved_at FROM comments WHERE id=$1 FOR UPDATE", [
            commentId,
          ])
        ).rows,
      );
      const resolving = patch.resolvedBy !== undefined;
      await client.query(
        `UPDATE comments SET
           body=COALESCE($2,body),
           resolved_at=CASE WHEN NOT $3::boolean THEN resolved_at WHEN $4::uuid IS NULL THEN NULL ELSE COALESCE(resolved_at,now()) END,
           resolved_by=CASE WHEN NOT $3::boolean THEN resolved_by ELSE $4::uuid END,
           updated_at=now()
         WHERE id=$1`,
        [commentId, patch.body ?? null, resolving, patch.resolvedBy ?? null],
      );
      if (resolving && Boolean(before.resolved_at) !== Boolean(patch.resolvedBy))
        await this.insertAudit(
          client,
          before.project_id,
          patch.resolvedBy ? "COMMENT_RESOLVED" : "COMMENT_REOPENED",
          { commentId },
          actorUserId,
        );
      return commentRow(
        first((await client.query(`${COMMENT_SELECT} WHERE c.id=$1`, [commentId])).rows),
      );
    });
  }
  async deleteComment(commentId: string, actorUserId: string): Promise<void> {
    assertResourceId(commentId);
    await this.transaction(async (client) => {
      const comment = first(
        (await client.query("SELECT project_id FROM comments WHERE id=$1 FOR UPDATE", [commentId]))
          .rows,
      );
      await client.query("DELETE FROM comments WHERE parent_id=$1", [commentId]);
      await client.query("DELETE FROM comments WHERE id=$1", [commentId]);
      await this.insertAudit(
        client,
        comment.project_id,
        "COMMENT_DELETED",
        { commentId },
        actorUserId,
      );
    });
  }

  // Admin
  async adminOverview(): Promise<AdminOverview> {
    const row = first(
      (
        await this.pool.query(
          `SELECT
             (SELECT count(*) FROM users)::int AS users,
             (SELECT count(*) FROM workspaces WHERE kind='personal' AND deleted_at IS NULL)::int AS personal,
             (SELECT count(*) FROM workspaces WHERE kind='lab' AND deleted_at IS NULL)::int AS labs,
             (SELECT count(*) FROM projects WHERE status='active')::int AS projects,
             (SELECT count(*) FROM assets a JOIN projects p ON p.id=a.project_id
                WHERE a.status='ready' AND p.status='active')::int AS assets,
             (SELECT COALESCE(sum(u.content_length),0) FROM assets a
                JOIN upload_sessions u ON u.id=a.upload_id
                JOIN projects p ON p.id=a.project_id
                WHERE a.status='ready' AND p.status='active')::bigint AS storage,
             (SELECT count(*) FROM integrity_reports WHERE status='pending')::int AS pending`,
        )
      ).rows,
    );
    const failed = (await this.jobsAvailable())
      ? Number(
          first(
            (
              await this.pool.query(
                "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE last_error IS NOT NULL",
              )
            ).rows,
          ).count,
        )
      : 0;
    return {
      users: row.users,
      personalWorkspaces: row.personal,
      labWorkspaces: row.labs,
      projects: row.projects,
      assets: row.assets,
      storageBytes: Number(row.storage),
      pendingIntegrityReports: row.pending,
      failedJobs: failed,
    };
  }
  /** The worker creates its schema on first start; until then there are no jobs to report. */
  private async jobsAvailable(): Promise<boolean> {
    const result = await this.pool.query<{ present: boolean }>(
      "SELECT to_regclass('graphile_worker.jobs') IS NOT NULL AS present",
    );
    return result.rows[0]?.present === true;
  }
  async adminUsers(limit: number): Promise<AdminUser[]> {
    const result = await this.pool.query(
      `SELECT u.id, u.email, u.created_at,
         (SELECT count(*) FROM workspace_members m WHERE m.user_id=u.id)::int AS workspaces,
         (SELECT count(*) FROM projects p WHERE p.created_by=u.id AND p.status='active')::int AS projects
       FROM users u ORDER BY u.created_at, u.id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      workspaces: row.workspaces,
      projects: row.projects,
      createdAt: date(row.created_at),
    }));
  }
  async adminWorkspaces(limit: number): Promise<AdminWorkspace[]> {
    const result = await this.pool.query(
      `SELECT w.id, w.name, w.kind, w.created_at,
         (SELECT count(*) FROM workspace_members m WHERE m.workspace_id=w.id)::int AS members,
         (SELECT count(*) FROM projects p WHERE p.workspace_id=w.id AND p.status='active')::int AS projects,
         (SELECT count(*) FROM assets a JOIN projects p ON p.id=a.project_id
            WHERE p.workspace_id=w.id AND p.status='active' AND a.status='ready')::int AS assets,
         (SELECT COALESCE(sum(u.content_length),0) FROM assets a
            JOIN projects p ON p.id=a.project_id JOIN upload_sessions u ON u.id=a.upload_id
            WHERE p.workspace_id=w.id AND p.status='active' AND a.status='ready')::bigint AS storage
       FROM workspaces w WHERE w.deleted_at IS NULL ORDER BY w.created_at, w.id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      members: row.members,
      projects: row.projects,
      assets: row.assets,
      storageBytes: Number(row.storage),
      createdAt: date(row.created_at),
    }));
  }
  async adminFailedJobs(limit: number): Promise<AdminJob[]> {
    if (!(await this.jobsAvailable())) return [];
    const result = await this.pool.query(
      `SELECT id::text AS id, task_identifier, attempts, max_attempts, last_error, run_at
       FROM graphile_worker.jobs WHERE last_error IS NOT NULL ORDER BY run_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      task: row.task_identifier,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      ...(row.last_error ? { lastError: String(row.last_error).slice(0, 2000) } : {}),
      runAt: date(row.run_at),
    }));
  }
  async renameProject(
    projectId: string,
    name: string,
    options: ActorOptions = {},
  ): Promise<ProjectRecord> {
    assertResourceId(projectId);
    return this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE projects SET name=$2,updated_at=now() WHERE id=$1 AND status<>'deleted' RETURNING *",
        [projectId, name],
      );
      const project = projectRow(first(result.rows));
      await this.insertAudit(client, projectId, "PROJECT_RENAMED", { name }, options.actorUserId);
      return project;
    });
  }
  async markProjectDeleting(projectId: string, options: ActorOptions = {}): Promise<ProjectRecord> {
    assertResourceId(projectId);
    return this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE projects SET status='deleting',updated_at=now() WHERE id=$1 AND status<>'deleted' RETURNING *",
        [projectId],
      );
      const project = projectRow(first(result.rows));
      await this.insertAudit(
        client,
        projectId,
        "PROJECT_DELETION_REQUESTED",
        {},
        options.actorUserId,
      );
      await addJob(client, "delete_project", { projectId }, `delete_project:${projectId}`);
      return project;
    });
  }
  async getDocument(projectId: string): Promise<DocumentRecord> {
    assertResourceId(projectId);
    const result = await this.pool.query("SELECT * FROM project_documents WHERE project_id=$1", [
      projectId,
    ]);
    return documentRow(first(result.rows));
  }
  async saveDocument(
    projectId: string,
    baseRevision: number,
    document: unknown,
    options: ActorOptions = {},
  ): Promise<
    { kind: "saved"; document: DocumentRecord } | { kind: "conflict"; currentRevision: number }
  > {
    assertResourceId(projectId);
    return this.transaction(async (client) => {
      const prior = await client.query(
        "SELECT document FROM project_documents WHERE project_id=$1",
        [projectId],
      );
      if (prior.rowCount === 0) throw new NotFoundError();
      const updated = await client.query(
        "UPDATE project_documents SET revision=revision+1,schema_version=$4,document=$3,updated_at=now() WHERE project_id=$1 AND revision=$2 RETURNING *",
        [projectId, baseRevision, document, schemaVersionOf(document)],
      );
      if (updated.rowCount === 0) {
        const current = await client.query(
          "SELECT revision FROM project_documents WHERE project_id=$1",
          [projectId],
        );
        return { kind: "conflict", currentRevision: Number(first(current.rows).revision) };
      }
      const record = documentRow(first(updated.rows));
      await client.query(
        "INSERT INTO project_versions(id,project_id,revision,schema_version,document,created_at) VALUES($1,$2,$3,$4,$5,now())",
        [randomUUID(), projectId, record.revision, schemaVersionOf(document), document],
      );
      const actor = options.actorUserId;
      await this.insertAudit(
        client,
        projectId,
        "DOCUMENT_UPDATED",
        deriveDocumentDiff(first(prior.rows).document, document),
        actor,
      );
      for (const event of deriveDocumentAuditEvents(first(prior.rows).document, document))
        await this.insertAudit(client, projectId, event.action, event.details, actor);
      return { kind: "saved", document: record };
    });
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
    assertResourceId(input.projectId);
    if (input.assetId !== undefined) assertResourceId(input.assetId);
    return this.transaction(async (client) => {
      const id = randomUUID();
      const assetId = input.assetId ?? randomUUID();
      const now = new Date();
      const expiresAt = new Date(input.expiresAt ?? Date.now() + 600_000);
      await client.query(
        "INSERT INTO upload_sessions(id,project_id,status,content_length,checksum_sha256,expires_at,created_at) VALUES($1,$2,'reserved',$3,$4,$5,$6)",
        [id, input.projectId, input.contentLength, input.checksumSha256, expiresAt, now],
      );
      await client.query(
        "INSERT INTO assets(id,upload_id,project_id,storage_key,filename,mime_type,checksum_sha256,status,width_px,height_px,bit_depth,channel_count,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending-verification',1,1,8,3,'{}'::jsonb,$8)",
        [
          assetId,
          id,
          input.projectId,
          input.storageKey,
          input.filename,
          input.mimeType,
          input.checksumSha256,
          now,
        ],
      );
      return {
        id,
        projectId: input.projectId,
        assetId,
        contentLength: input.contentLength,
        checksumSha256: input.checksumSha256,
        status: "reserved",
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString(),
      };
    });
  }
  async getUpload(id: string): Promise<UploadRecord> {
    assertResourceId(id);
    const result = await this.pool.query(
      "SELECT u.*,a.id asset_id FROM upload_sessions u JOIN assets a ON a.upload_id=u.id WHERE u.id=$1",
      [id],
    );
    return uploadRow(first(result.rows));
  }
  async getAsset(id: string): Promise<AssetRecord> {
    assertResourceId(id);
    const result = await this.pool.query("SELECT * FROM assets WHERE id=$1", [id]);
    return assetRow(first(result.rows));
  }
  async completeUpload(id: string): Promise<AssetRecord> {
    assertResourceId(id);
    const result = await this.transaction(async (client) => {
      const uploadResult = await client.query(
        "SELECT status,expires_at FROM upload_sessions WHERE id=$1 FOR UPDATE",
        [id],
      );
      const upload = first(uploadResult.rows) as { status: string; expires_at: Date };
      if (upload.status === "expired") return { kind: "expired" as const };
      if (upload.status === "reserved" && upload.expires_at.getTime() <= Date.now()) {
        await client.query("UPDATE upload_sessions SET status='expired' WHERE id=$1", [id]);
        return { kind: "expired" as const };
      }
      const updated =
        upload.status === "reserved"
          ? await client.query(
              "UPDATE upload_sessions SET status='verifying' WHERE id=$1 AND status='reserved' RETURNING id",
              [id],
            )
          : undefined;
      const assetResult = await client.query("SELECT * FROM assets WHERE upload_id=$1", [id]);
      const asset = assetRow(first(assetResult.rows));
      if ((updated?.rowCount ?? 0) > 0)
        await addJob(client, "verify_asset", { assetId: asset.id }, `verify_asset:${asset.id}`);
      return { kind: "complete" as const, asset };
    });
    if (result.kind === "expired") throw new UploadExpiredError();
    return result.asset;
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
    assertResourceId(id);
    return this.transaction(async (client) => {
      const currentResult = await client.query("SELECT * FROM assets WHERE id=$1", [id]);
      const current = assetRow(first(currentResult.rows));
      const next = { ...current, ...update };
      const result = await client.query(
        "UPDATE assets SET status=$2,width_px=$3,height_px=$4,bit_depth=$5,channel_count=$6,metadata=$7,rejection_reason=$8 WHERE id=$1 RETURNING *",
        [
          id,
          next.status,
          next.widthPx,
          next.heightPx,
          next.bitDepth,
          next.channelCount,
          next.metadata,
          next.rejectionReason ?? null,
        ],
      );
      await client.query("UPDATE upload_sessions SET status=$2 WHERE id=$1", [
        current.uploadId,
        next.status === "ready"
          ? "completed"
          : next.status === "rejected"
            ? "rejected"
            : "verifying",
      ]);
      if (next.status === "ready" && current.status !== "ready")
        await this.insertAudit(client, current.projectId, "ASSET_UPLOADED", { assetId: id });
      return assetRow(first(result.rows));
    });
  }
  async assertReadyAssets(projectId: string, ids: Iterable<string>): Promise<void> {
    assertResourceId(projectId);
    const values = [...new Set(ids)];
    for (const id of values) assertResourceId(id);
    if (values.length === 0) return;
    const result = await this.pool.query(
      "SELECT count(*)::int count FROM assets WHERE project_id=$1 AND status='ready' AND id=ANY($2::uuid[])",
      [projectId, values],
    );
    if (Number(first(result.rows).count) !== values.length) throw new NotFoundError();
  }
  async recordExport(
    input: Omit<ExportRecord, "id" | "createdAt">,
    options: ActorOptions = {},
  ): Promise<ExportRecord> {
    assertResourceId(input.projectId);
    return this.transaction(async (client) => {
      const revision = await client.query(
        "SELECT 1 FROM project_documents WHERE project_id=$1 AND revision=$2",
        [input.projectId, input.revision],
      );
      if (revision.rowCount === 0) throw new NotFoundError();
      const id = randomUUID();
      const result = await client.query(
        "INSERT INTO export_records(id,project_id,revision,format,width_px,height_px,checksum_sha256,metadata,artboard_id,dpi,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8,$9,now()) RETURNING *",
        [
          id,
          input.projectId,
          input.revision,
          input.format,
          input.widthPx,
          input.heightPx,
          input.checksumSha256,
          input.artboardId ?? null,
          input.dpi ?? null,
        ],
      );
      const record = exportRow(first(result.rows));
      await this.insertAudit(
        client,
        input.projectId,
        "EXPORT_CREATED",
        exportAuditDetails(record),
        options.actorUserId,
      );
      return record;
    });
  }
  async listExports(projectId: string): Promise<ExportRecord[]> {
    assertResourceId(projectId);
    const result = await this.pool.query(
      "SELECT * FROM export_records WHERE project_id=$1 ORDER BY created_at DESC, id",
      [projectId],
    );
    return result.rows.map(exportRow);
  }
  async listAuditEvents(projectId: string): Promise<AuditEvent[]> {
    assertResourceId(projectId);
    const result = await this.pool.query(`${AUDIT_SELECT} WHERE e.project_id=$1 ORDER BY e.seq`, [
      projectId,
    ]);
    return result.rows.map(auditRow);
  }
  async pageAuditEvents(
    projectId: string,
    page: { limit: number; beforeSequence?: number },
  ): Promise<AuditEventPage> {
    assertResourceId(projectId);
    const result = await this.pool.query(
      `${AUDIT_SELECT} WHERE e.project_id=$1 AND ($2::bigint IS NULL OR e.seq < $2) ORDER BY e.seq DESC LIMIT $3`,
      [projectId, page.beforeSequence ?? null, page.limit + 1],
    );
    const events = result.rows.slice(0, page.limit).map(auditRow);
    const last = events.at(-1);
    return result.rows.length > page.limit && last
      ? { events, nextBeforeSequence: last.sequence }
      : { events };
  }
  async listVersions(
    projectId: string,
    page: { limit: number; beforeRevision?: number },
  ): Promise<VersionSummary[]> {
    assertResourceId(projectId);
    const result = await this.pool.query(
      "SELECT revision,schema_version,created_at FROM project_versions WHERE project_id=$1 AND ($2::integer IS NULL OR revision < $2) ORDER BY revision DESC LIMIT $3",
      [projectId, page.beforeRevision ?? null, page.limit],
    );
    return result.rows.map((row) => ({
      revision: Number(row.revision),
      schemaVersion: Number(row.schema_version),
      createdAt: date(row.created_at),
    }));
  }
  async getVersion(projectId: string, revision: number): Promise<VersionRecord> {
    assertResourceId(projectId);
    const result = await this.pool.query(
      "SELECT * FROM project_versions WHERE project_id=$1 AND revision=$2",
      [projectId, revision],
    );
    const row = first(result.rows);
    return {
      projectId: row.project_id,
      revision: Number(row.revision),
      schemaVersion: Number(row.schema_version),
      document: row.document,
      createdAt: date(row.created_at),
    };
  }
  async listProjectAssets(projectId: string): Promise<AssetRecord[]> {
    assertResourceId(projectId);
    const result = await this.pool.query("SELECT * FROM assets WHERE project_id=$1", [projectId]);
    return result.rows.map(assetRow);
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
    assertResourceId(projectId);
    await this.getDocumentAtRevision(projectId, revision);
    return this.transaction(async (client) => {
      const id = randomUUID();
      const result = await client.query(
        "INSERT INTO integrity_reports(id,project_id,revision,status,requested_by,created_at) VALUES($1,$2,$3,'pending',$4,now()) RETURNING *",
        [id, projectId, revision, options.actorUserId ?? null],
      );
      await this.insertAudit(
        client,
        projectId,
        "INTEGRITY_REPORT_REQUESTED",
        { reportId: id, revision },
        options.actorUserId,
      );
      await addJob(client, "integrity_report", { reportId: id }, `integrity_report:${id}`);
      return integrityRow(first(result.rows));
    });
  }
  async getIntegrityReport(id: string): Promise<IntegrityReportRecord> {
    assertResourceId(id);
    const result = await this.pool.query("SELECT * FROM integrity_reports WHERE id=$1", [id]);
    return integrityRow(first(result.rows));
  }
  async listIntegrityReports(projectId: string, limit: number): Promise<IntegrityReportRecord[]> {
    assertResourceId(projectId);
    const result = await this.pool.query(
      "SELECT * FROM integrity_reports WHERE project_id=$1 ORDER BY created_at DESC, id LIMIT $2",
      [projectId, limit],
    );
    return result.rows.map(integrityRow);
  }
  async completeIntegrityReport(
    id: string,
    outcome: { report: unknown } | { error: string },
  ): Promise<IntegrityReportRecord> {
    assertResourceId(id);
    const result = await this.pool.query(
      "UPDATE integrity_reports SET status=$2,report=$3,error=$4,completed_at=now() WHERE id=$1 RETURNING *",
      "report" in outcome
        ? [id, "ready", JSON.stringify(outcome.report), null]
        : [id, "failed", null, outcome.error],
    );
    return integrityRow(first(result.rows));
  }
  async deleteProjectData(projectId: string): Promise<void> {
    assertResourceId(projectId);
    await this.transaction(async (client) => {
      const project = await client.query(
        "SELECT name,status FROM projects WHERE id=$1 FOR UPDATE",
        [projectId],
      );
      const row = first(project.rows);
      if (row.status === "deleted") return;
      await client.query("DELETE FROM assets WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM upload_sessions WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM project_versions WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM project_documents WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM comments WHERE project_id=$1 AND parent_id IS NOT NULL", [
        projectId,
      ]);
      await client.query("DELETE FROM comments WHERE project_id=$1", [projectId]);
      await client.query(
        "UPDATE projects SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1",
        [projectId],
      );
      await this.insertAudit(client, projectId, "PROJECT_DELETED", { name: row.name });
    });
  }
  private async insertAudit(
    client: PoolClient,
    projectId: string,
    action: string,
    details: Record<string, unknown>,
    actorUserId?: string,
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_events(id,project_id,action,details,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,now())",
      [randomUUID(), projectId, action, details, actorUserId ?? null],
    );
  }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface PgPoolOptions {
  maxConnections?: number;
  /** PEM CA that must have signed the server certificate (for example Supabase's root CA). */
  caCert?: string;
}

/**
 * Creates a pool for the given URL. With `caCert`, TLS is required and the server certificate
 * and host name are verified against that CA; `sslmode`/`sslrootcert` URL parameters are ignored.
 */
export function createPgPool(connectionString: string, options: PgPoolOptions = {}): Pool {
  let url = connectionString;
  if (options.caCert) {
    const parsed = new URL(connectionString);
    for (const parameter of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"])
      parsed.searchParams.delete(parameter);
    url = parsed.toString();
  }
  const pool = new Pool({
    connectionString: url,
    ...(options.maxConnections ? { max: options.maxConnections } : {}),
    ...(options.caCert ? { ssl: { ca: options.caCert, rejectUnauthorized: true } } : {}),
  });
  // An idle client can be dropped by a pooler; log it instead of crashing the process.
  pool.on("error", (error) => console.error("PostgreSQL pool error", error));
  return pool;
}

export function createPostgresRepository(
  connectionString: string,
  options: PgPoolOptions = {},
): {
  repository: PostgresFigLabRepository;
  close: () => Promise<void>;
} {
  const pool = createPgPool(connectionString, options);
  return { repository: new PostgresFigLabRepository(pool), close: () => pool.end() };
}

async function addJob(
  client: PoolClient,
  name: string,
  payload: Record<string, unknown>,
  jobKey: string,
): Promise<void> {
  await client.query(
    "SELECT graphile_worker.add_job($1,$2::json,job_key := $3,max_attempts := 10)",
    [name, JSON.stringify(payload), jobKey],
  );
}
function first<T extends QueryResultRow>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}
function date(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function projectRow(row: QueryResultRow): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    ...(row.folder_id ? { folderId: row.folder_id } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
function documentRow(row: QueryResultRow): DocumentRecord {
  return {
    projectId: row.project_id,
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    document: row.document,
    updatedAt: date(row.updated_at),
  };
}
function uploadRow(row: QueryResultRow): UploadRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    contentLength: Number(row.content_length),
    checksumSha256: row.checksum_sha256,
    status: row.status,
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
  };
}
function assetRow(row: QueryResultRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    uploadId: row.upload_id,
    filename: row.filename,
    mimeType: row.mime_type,
    checksumSha256: row.checksum_sha256,
    storageKey: row.storage_key,
    status: row.status,
    widthPx: Number(row.width_px),
    heightPx: Number(row.height_px),
    bitDepth: Number(row.bit_depth) as 8 | 16,
    channelCount: Number(row.channel_count) as 1 | 3 | 4,
    metadata: row.metadata ?? {},
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
    createdAt: date(row.created_at),
  };
}
function exportRow(row: QueryResultRow): ExportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: Number(row.revision),
    format: row.format,
    ...(row.artboard_id === null || row.artboard_id === undefined
      ? {}
      : { artboardId: row.artboard_id }),
    ...(row.dpi === null || row.dpi === undefined ? {} : { dpi: Number(row.dpi) }),
    widthPx: Number(row.width_px),
    heightPx: Number(row.height_px),
    checksumSha256: row.checksum_sha256,
    createdAt: date(row.created_at),
  };
}
function integrityRow(row: QueryResultRow): IntegrityReportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: Number(row.revision),
    status: row.status,
    ...(row.report === null || row.report === undefined ? {} : { report: row.report }),
    ...(row.error ? { error: row.error } : {}),
    ...(row.requested_by ? { requestedBy: row.requested_by } : {}),
    createdAt: date(row.created_at),
    ...(row.completed_at ? { completedAt: date(row.completed_at) } : {}),
  };
}
const AUDIT_SELECT =
  "SELECT e.*, u.email AS actor_email FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id";
function auditRow(row: QueryResultRow): AuditEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    action: row.action,
    details: row.details,
    ...(row.actor_user_id ? { actor: { id: row.actor_user_id, email: row.actor_email } } : {}),
    sequence: Number(row.seq),
    createdAt: date(row.created_at),
  };
}

const WORKSPACE_SELECT = `SELECT w.id, w.name, w.kind, w.created_at, m.role,
  (SELECT count(*) FROM workspace_members x WHERE x.workspace_id=w.id)::int AS member_count
  FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id`;
function workspaceRow(row: QueryResultRow): WorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    memberCount: row.member_count,
    createdAt: date(row.created_at),
  };
}
const MEMBER_SELECT =
  "SELECT m.user_id, u.email, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id=m.user_id";
function memberRow(row: QueryResultRow): WorkspaceMember {
  return { userId: row.user_id, email: row.email, role: row.role, joinedAt: date(row.created_at) };
}
const INVITE_SELECT = `SELECT i.*, c.email AS created_by_email, a.email AS accepted_by_email
  FROM workspace_invites i JOIN users c ON c.id=i.created_by LEFT JOIN users a ON a.id=i.accepted_by`;
function inviteRow(row: QueryResultRow): InviteRecord {
  const expiresAt = date(row.expires_at);
  const status: InviteStatus = row.accepted_by
    ? "accepted"
    : row.revoked_at
      ? "revoked"
      : Date.parse(expiresAt) <= Date.now()
        ? "expired"
        : "pending";
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    role: row.role,
    ...(row.email ? { email: row.email } : {}),
    createdBy: { id: row.created_by, email: row.created_by_email },
    ...(row.accepted_by
      ? { acceptedBy: { id: row.accepted_by, email: row.accepted_by_email } }
      : {}),
    status,
    expiresAt,
    createdAt: date(row.created_at),
  };
}
function folderRow(row: QueryResultRow): FolderRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    name: row.name,
    archived: row.archived_at !== null,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
const TEMPLATE_SELECT = `SELECT t.id, t.workspace_id, t.name, t.created_by, t.created_at, u.email AS created_by_email
  FROM project_templates t LEFT JOIN users u ON u.id=t.created_by`;
function templateRow(row: QueryResultRow): TemplateSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    ...(row.created_by ? { createdBy: { id: row.created_by, email: row.created_by_email } } : {}),
    createdAt: date(row.created_at),
  };
}
const COMMENT_SELECT = `SELECT c.*, a.email AS author_email, r.email AS resolved_by_email
  FROM comments c JOIN users a ON a.id=c.author_user_id LEFT JOIN users r ON r.id=c.resolved_by`;
function commentRow(row: QueryResultRow): CommentRecord {
  const anchor: CommentAnchor | undefined = row.artboard_id
    ? {
        artboardId: row.artboard_id,
        ...(row.object_id ? { objectId: row.object_id } : {}),
        ...(row.x_pt !== null ? { xPt: row.x_pt } : {}),
        ...(row.y_pt !== null ? { yPt: row.y_pt } : {}),
      }
    : undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    author: { id: row.author_user_id, email: row.author_email },
    ...(anchor ? { anchor } : {}),
    body: row.body,
    ...(row.resolved_at ? { resolvedAt: date(row.resolved_at) } : {}),
    ...(row.resolved_by
      ? { resolvedBy: { id: row.resolved_by, email: row.resolved_by_email } }
      : {}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
