import {
  type AdminJobListDto,
  type AdminOverviewDto,
  type AdminUserListDto,
  type AdminWorkspaceListDto,
  type AssetDescriptor,
  type AssetStatus,
  type AuditEventPage,
  apiRoutes,
  type CommentDto,
  type CreateCommentRequest,
  type CurrentUserResponse,
  type ExportRecord,
  type Folder,
  type IntegrityReportRecord,
  type IntegrityReportSummary,
  type InviteDto,
  type InvitePreviewDto,
  type PrepareUploadResponse,
  type Project,
  type ProjectDocumentResponse,
  type RecordExportRequest,
  type SaveDocumentResponse,
  type SearchHit,
  type Template,
  type VersionResponse,
  type VersionSummary,
  type Workspace,
  type WorkspaceMemberDto,
  type WorkspaceRoleDto,
} from "@figlab/api-contract";
import type { FigureDocument } from "@figlab/figure-schema";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(
      typeof body === "object" && body && "message" in body
        ? String(body.message)
        : `HTTP ${status}`,
    );
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type Fetcher = typeof fetch;
export type UploadStage = "reserved" | "uploaded" | "verifying" | "completed" | "rejected";
export type UploadCompletion = { assetId: string; status: AssetStatus };

const path = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`:${key}`, encodeURIComponent(value)),
    template,
  );

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface FigLabClientAuth {
  /** Returns the current access token for API calls; signed storage URLs never receive it. */
  getAccessToken: () => Promise<string | undefined>;
  /** Called when the API rejects the session, so the app can return to sign-in. */
  onUnauthorized?: () => void;
}

export class FigLabClient {
  constructor(
    private readonly fetcher: Fetcher = (...arguments_) => fetch(...arguments_),
    private readonly pollIntervalMs = 500,
    private readonly auth?: FigLabClientAuth,
  ) {}

  me(): Promise<CurrentUserResponse> {
    return this.json(apiRoutes.me);
  }

  async listProjects(): Promise<Project[]> {
    return (await this.json<{ projects: Project[] }>(apiRoutes.projects)).projects;
  }

  createProject(name: string): Promise<Project> {
    return this.json(apiRoutes.projects, { method: "POST", body: { name } });
  }

  renameProject(projectId: string, name: string): Promise<Project> {
    return this.json(path(apiRoutes.project, { projectId }), { method: "PUT", body: { name } });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.json(path(apiRoutes.project, { projectId }), { method: "DELETE" });
  }

  getDocument(projectId: string): Promise<ProjectDocumentResponse> {
    return this.json(path(apiRoutes.projectDocument, { projectId }));
  }

  saveDocument(
    projectId: string,
    baseRevision: number,
    document: FigureDocument,
  ): Promise<SaveDocumentResponse> {
    return this.json(path(apiRoutes.projectDocument, { projectId }), {
      method: "PUT",
      body: { baseRevision, document },
    });
  }

  getAsset(assetId: string): Promise<AssetDescriptor> {
    return this.json(path(apiRoutes.asset, { assetId }));
  }

  async downloadAsset(assetId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
    const instruction = await this.json<{ url: string; expiresAt: string }>(
      path(apiRoutes.assetDownloadUrl, { assetId }),
      { method: "POST" },
    );
    const response = await this.fetcher(instruction.url);
    if (!response.ok) throw new ApiError(response.status, await readBody(response));
    return {
      bytes: await response.arrayBuffer(),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async prepareAndUpload(
    projectId: string,
    original: Blob,
    filename: string,
    onStage?: (stage: UploadStage) => void,
  ): Promise<AssetDescriptor> {
    const checksumSha256 = await sha256(original);
    const prepared = await this.json<PrepareUploadResponse>(
      path(apiRoutes.projectUploads, { projectId }),
      {
        method: "POST",
        body: {
          filename,
          contentType: original.type || "application/octet-stream",
          contentLength: original.size,
          checksumSha256,
        },
      },
    );
    onStage?.("reserved");
    const put = await this.fetcher(prepared.upload.url, {
      method: prepared.upload.method,
      headers: prepared.upload.headers,
      body: await original.arrayBuffer(),
    });
    if (!put.ok) throw new ApiError(put.status, await readBody(put));
    onStage?.("uploaded");
    const completed = await this.json<UploadCompletion>(
      path(apiRoutes.uploadComplete, { uploadId: prepared.uploadId }),
      {
        method: "POST",
      },
    );
    if (completed.status === "rejected") {
      onStage?.("rejected");
      return this.getAsset(prepared.assetId);
    }
    onStage?.("verifying");
    const asset = await this.pollAsset(prepared.assetId);
    onStage?.(asset.status === "rejected" ? "rejected" : "completed");
    return asset;
  }

  listAuditEvents(
    projectId: string,
    page: { limit?: number; beforeSequence?: number } = {},
  ): Promise<AuditEventPage> {
    return this.json(withQuery(path(apiRoutes.projectAuditEvents, { projectId }), page));
  }

  async listVersions(
    projectId: string,
    page: { limit?: number; beforeRevision?: number } = {},
  ): Promise<VersionSummary[]> {
    const url = withQuery(path(apiRoutes.projectVersions, { projectId }), page);
    return (await this.json<{ versions: VersionSummary[] }>(url)).versions;
  }

  getVersion(projectId: string, revision: number): Promise<VersionResponse> {
    return this.json(path(apiRoutes.projectVersion, { projectId, revision: String(revision) }));
  }

  async listExports(projectId: string): Promise<ExportRecord[]> {
    const url = path(apiRoutes.projectExports, { projectId });
    return (await this.json<{ exports: ExportRecord[] }>(url)).exports;
  }

  requestIntegrityReport(projectId: string, revision?: number): Promise<IntegrityReportRecord> {
    return this.json(path(apiRoutes.projectIntegrityReports, { projectId }), {
      method: "POST",
      body: revision === undefined ? {} : { revision },
    });
  }

  async listIntegrityReports(projectId: string): Promise<IntegrityReportSummary[]> {
    const url = path(apiRoutes.projectIntegrityReports, { projectId });
    return (await this.json<{ reports: IntegrityReportSummary[] }>(url)).reports;
  }

  getIntegrityReport(projectId: string, reportId: string): Promise<IntegrityReportRecord> {
    return this.json(path(apiRoutes.projectIntegrityReport, { projectId, reportId }));
  }

  recordExport(projectId: string, metadata: RecordExportRequest): Promise<void> {
    return this.json(path(apiRoutes.projectExports, { projectId }), {
      method: "POST",
      body: metadata,
    });
  }

  getProject(projectId: string): Promise<Project> {
    return this.json(path(apiRoutes.project, { projectId }));
  }

  // Workspaces and labs
  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.json<{ workspaces: Workspace[] }>(apiRoutes.workspaces)).workspaces;
  }
  createLab(name: string): Promise<Workspace> {
    return this.json(apiRoutes.workspaces, { method: "POST", body: { name } });
  }
  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    await this.json(path(apiRoutes.workspace, { workspaceId }), {
      method: "PATCH",
      body: { name },
    });
  }
  async listWorkspaceProjects(
    workspaceId: string,
    filter: { q?: string; folderId?: string } = {},
  ): Promise<Project[]> {
    return (
      await this.json<{ projects: Project[] }>(
        withQuery(path(apiRoutes.workspaceProjects, { workspaceId }), filter),
      )
    ).projects;
  }
  createWorkspaceProject(
    workspaceId: string,
    body: { name: string; folderId?: string; templateId?: string },
  ): Promise<Project> {
    return this.json(path(apiRoutes.workspaceProjects, { workspaceId }), {
      method: "POST",
      body,
    });
  }
  moveProject(projectId: string, folderId: string | null): Promise<Project> {
    return this.json(path(apiRoutes.projectFolder, { projectId }), {
      method: "PUT",
      body: { folderId },
    });
  }
  async listMembers(workspaceId: string): Promise<WorkspaceMemberDto[]> {
    return (
      await this.json<{ members: WorkspaceMemberDto[] }>(
        path(apiRoutes.workspaceMembers, { workspaceId }),
      )
    ).members;
  }
  setMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRoleDto,
  ): Promise<WorkspaceMemberDto> {
    return this.json(path(apiRoutes.workspaceMember, { workspaceId, userId }), {
      method: "PUT",
      body: { role },
    });
  }
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.json(path(apiRoutes.workspaceMember, { workspaceId, userId }), {
      method: "DELETE",
    });
  }
  async listInvites(workspaceId: string): Promise<InviteDto[]> {
    return (
      await this.json<{ invites: InviteDto[] }>(path(apiRoutes.workspaceInvites, { workspaceId }))
    ).invites;
  }
  createInvite(
    workspaceId: string,
    body: { role: Exclude<WorkspaceRoleDto, "owner">; email?: string; expiresInDays?: number },
  ): Promise<{ invite: InviteDto; token: string }> {
    return this.json(path(apiRoutes.workspaceInvites, { workspaceId }), {
      method: "POST",
      body,
    });
  }
  revokeInvite(workspaceId: string, inviteId: string): Promise<InviteDto> {
    return this.json(path(apiRoutes.workspaceInvite, { workspaceId, inviteId }), {
      method: "DELETE",
    });
  }
  previewInvite(token: string): Promise<InvitePreviewDto> {
    return this.json(path(apiRoutes.invite, { token }));
  }
  acceptInvite(token: string): Promise<Workspace> {
    return this.json(path(apiRoutes.inviteAccept, { token }), { method: "POST" });
  }

  // Folders, search, templates
  async listFolders(workspaceId: string): Promise<Folder[]> {
    return (
      await this.json<{ folders: Folder[] }>(path(apiRoutes.workspaceFolders, { workspaceId }))
    ).folders;
  }
  createFolder(workspaceId: string, name: string, parentId?: string): Promise<Folder> {
    return this.json(path(apiRoutes.workspaceFolders, { workspaceId }), {
      method: "POST",
      body: { name, ...(parentId ? { parentId } : {}) },
    });
  }
  updateFolder(
    workspaceId: string,
    folderId: string,
    patch: { name?: string; parentId?: string | null; archived?: boolean },
  ): Promise<Folder> {
    return this.json(path(apiRoutes.workspaceFolder, { workspaceId, folderId }), {
      method: "PATCH",
      body: patch,
    });
  }
  async search(q: string): Promise<SearchHit[]> {
    return (await this.json<{ results: SearchHit[] }>(withQuery(apiRoutes.search, { q }))).results;
  }
  async listTemplates(workspaceId: string): Promise<Template[]> {
    return (
      await this.json<{ templates: Template[] }>(
        path(apiRoutes.workspaceTemplates, { workspaceId }),
      )
    ).templates;
  }
  createTemplate(workspaceId: string, name: string, projectId: string): Promise<Template> {
    return this.json(path(apiRoutes.workspaceTemplates, { workspaceId }), {
      method: "POST",
      body: { name, projectId },
    });
  }
  async deleteTemplate(workspaceId: string, templateId: string): Promise<void> {
    await this.json(path(apiRoutes.workspaceTemplate, { workspaceId, templateId }), {
      method: "DELETE",
    });
  }

  // Comments
  async listComments(projectId: string): Promise<CommentDto[]> {
    return (
      await this.json<{ comments: CommentDto[] }>(path(apiRoutes.projectComments, { projectId }))
    ).comments;
  }
  createComment(projectId: string, body: CreateCommentRequest): Promise<CommentDto> {
    return this.json(path(apiRoutes.projectComments, { projectId }), { method: "POST", body });
  }
  updateComment(
    projectId: string,
    commentId: string,
    patch: { body?: string; resolved?: boolean },
  ): Promise<CommentDto> {
    return this.json(path(apiRoutes.projectComment, { projectId, commentId }), {
      method: "PATCH",
      body: patch,
    });
  }
  async deleteComment(projectId: string, commentId: string): Promise<void> {
    await this.json(path(apiRoutes.projectComment, { projectId, commentId }), {
      method: "DELETE",
    });
  }

  // Admin
  adminOverview(): Promise<AdminOverviewDto> {
    return this.json(apiRoutes.adminOverview);
  }
  adminUsers(): Promise<AdminUserListDto> {
    return this.json(apiRoutes.adminUsers);
  }
  adminWorkspaces(): Promise<AdminWorkspaceListDto> {
    return this.json(apiRoutes.adminWorkspaces);
  }
  adminJobs(): Promise<AdminJobListDto> {
    return this.json(apiRoutes.adminJobs);
  }

  private async json<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.auth?.getAccessToken();
    const headers: Record<string, string> = {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const response = await this.fetcher(url, {
      ...(init.method ? { method: init.method } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status === 401) this.auth?.onUnauthorized?.();
    if (!response.ok) throw new ApiError(response.status, await readBody(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async pollAsset(assetId: string): Promise<AssetDescriptor> {
    for (;;) {
      const asset = await this.getAsset(assetId);
      if (asset.status !== "pending-verification") return asset;
      if (this.pollIntervalMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }
}

function withQuery(url: string, query: Record<string, number | string | undefined>): string {
  const entries = Object.entries(query).filter(
    (entry): entry is [string, number | string] => entry[1] !== undefined && entry[1] !== "",
  );
  return entries.length === 0
    ? url
    : `${url}?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)]))}`;
}

async function readBody(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}
