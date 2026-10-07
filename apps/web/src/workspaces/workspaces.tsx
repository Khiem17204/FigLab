import type {
  Folder,
  InviteDto,
  Project,
  Template,
  Workspace,
  WorkspaceMemberDto,
  WorkspaceRoleDto,
} from "@figlab/api-contract";
import { Button } from "@figlab/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ApiError, type FigLabClient } from "../api/client";
import "./workspaces.css";

const ROLE_ORDER: WorkspaceRoleDto[] = ["owner", "admin", "editor", "viewer"];
const canManage = (role: WorkspaceRoleDto | undefined) => role === "owner" || role === "admin";
export const canWrite = (role: WorkspaceRoleDto | undefined) =>
  role !== undefined && role !== "viewer";
const errorText = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.";

const SELECTED_WORKSPACE_KEY = "figlab.workspace";
const PENDING_INVITE_KEY = "figlab.pendingInvite";

function stored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function store(key: string, value: string | undefined): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Remembering the selection is a convenience only.
  }
}

/** `all` lists every project; `root` lists projects outside folders. */
export type FolderFilter = "all" | "root" | string;

/** The workspace and folder the dashboard shows, remembered per browser. */
export function useWorkspaceSelection(client: FigLabClient) {
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.listWorkspaces() });
  const [selectedId, setSelectedId] = useState(() => stored(SELECTED_WORKSPACE_KEY));
  const [folder, setFolder] = useState<FolderFilter>("all");
  const list = workspaces.data ?? [];
  const current = list.find((workspace) => workspace.id === selectedId) ?? list[0];
  return {
    workspaces: list,
    loading: workspaces.isLoading,
    current,
    folder,
    setFolder,
    select: (id: string) => {
      setSelectedId(id);
      setFolder("all");
      store(SELECTED_WORKSPACE_KEY, id);
    },
    refetch: () => workspaces.refetch(),
  };
}
export type WorkspaceSelection = ReturnType<typeof useWorkspaceSelection>;

export function useFolders(client: FigLabClient, workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["folders", workspaceId],
    queryFn: () => client.listFolders(workspaceId as string),
    enabled: Boolean(workspaceId),
  });
}
export function useTemplates(client: FigLabClient, workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["templates", workspaceId],
    queryFn: () => client.listTemplates(workspaceId as string),
    enabled: Boolean(workspaceId),
  });
}

/** Folders in tree order with their depth, for indented lists and selects. */
export function folderTree(folders: ReadonlyArray<Folder>): { folder: Folder; depth: number }[] {
  const children = new Map<string | undefined, Folder[]>();
  for (const folder of folders) {
    const parent = folders.some((other) => other.id === folder.parentId)
      ? folder.parentId
      : undefined;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const ordered: { folder: Folder; depth: number }[] = [];
  const visit = (parent: string | undefined, depth: number) => {
    for (const folder of children.get(parent) ?? []) {
      ordered.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return ordered;
}

/** Workspace switcher, lab creation, folder tree, and templates for the dashboard sidebar. */
export function WorkspaceNav({
  client,
  selection,
}: {
  client: FigLabClient;
  selection: WorkspaceSelection;
}) {
  const queryClient = useQueryClient();
  const { current } = selection;
  const folders = useFolders(client, current?.id);
  const templates = useTemplates(client, current?.id);
  const [labName, setLabName] = useState("");
  const [folderName, setFolderName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState("");
  const refreshFolders = () =>
    queryClient.invalidateQueries({ queryKey: ["folders", current?.id] });
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const visible = folderTree(folders.data ?? []).filter(
    ({ folder }) => showArchived || !folder.archived,
  );
  const selectedFolder = folders.data?.find((folder) => folder.id === selection.folder);
  const writable = canWrite(current?.role);

  return (
    <div className="workspace-nav">
      <label>
        Workspace
        <select
          onChange={(event) => selection.select(event.target.value)}
          value={current?.id ?? ""}
        >
          {selection.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.kind === "personal" ? "Personal" : workspace.name}
              {workspace.kind === "lab" ? ` (${workspace.role})` : ""}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const name = labName.trim();
          if (!name) return;
          void run(async () => {
            const lab = await client.createLab(name);
            setLabName("");
            await selection.refetch();
            selection.select(lab.id);
          });
        }}
      >
        <input
          aria-label="New lab name"
          maxLength={120}
          onChange={(event) => setLabName(event.target.value)}
          placeholder="New lab name"
          value={labName}
        />
        <Button type="submit">Create lab</Button>
      </form>

      <strong>Folders</strong>
      <ul aria-label="Folders" className="folder-list">
        {(
          [
            ["all", "All projects"],
            ["root", "Not in a folder"],
          ] as const
        ).map(([value, label]) => (
          <li key={value}>
            <button
              aria-pressed={selection.folder === value}
              onClick={() => selection.setFolder(value)}
              type="button"
            >
              {label}
            </button>
          </li>
        ))}
        {visible.map(({ folder, depth }) => (
          <li key={folder.id} style={{ paddingLeft: `${depth}em` }}>
            <button
              aria-pressed={selection.folder === folder.id}
              onClick={() => selection.setFolder(folder.id)}
              type="button"
            >
              {folder.name}
              {folder.archived ? " (archived)" : ""}
            </button>
          </li>
        ))}
      </ul>
      <label className="inline">
        <input
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
          type="checkbox"
        />
        Show archived folders
      </label>
      {writable && current && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = folderName.trim();
            if (!name) return;
            void run(async () => {
              const parent = selectedFolder?.id;
              const created = await client.createFolder(current.id, name, parent);
              setFolderName("");
              await refreshFolders();
              selection.setFolder(created.id);
            });
          }}
        >
          <input
            aria-label="New folder name"
            maxLength={120}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder={selectedFolder ? `New folder in ${selectedFolder.name}` : "New folder"}
            value={folderName}
          />
          <Button type="submit">Add folder</Button>
        </form>
      )}
      {writable && current && selectedFolder && (
        <div className="folder-actions">
          <Button
            onClick={() => {
              const name = window.prompt("Rename folder", selectedFolder.name)?.trim();
              if (name)
                void run(async () => {
                  await client.updateFolder(current.id, selectedFolder.id, { name });
                  await refreshFolders();
                });
            }}
          >
            Rename folder
          </Button>
          <Button
            onClick={() =>
              void run(async () => {
                await client.updateFolder(current.id, selectedFolder.id, {
                  archived: !selectedFolder.archived,
                });
                await refreshFolders();
              })
            }
          >
            {selectedFolder.archived ? "Restore folder" : "Archive folder"}
          </Button>
          <label>
            Move folder into
            <select
              onChange={(event) =>
                void run(async () => {
                  await client.updateFolder(current.id, selectedFolder.id, {
                    parentId: event.target.value || null,
                  });
                  await refreshFolders();
                })
              }
              value={selectedFolder.parentId ?? ""}
            >
              <option value="">Top level</option>
              {folderTree(folders.data ?? [])
                .filter(({ folder }) => folder.id !== selectedFolder.id)
                .map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {`${"  ".repeat(depth)}${folder.name}`}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}

      {(templates.data?.length ?? 0) > 0 && current && (
        <>
          <strong>Templates</strong>
          <ul aria-label="Templates" className="folder-list">
            {templates.data?.map((template) => (
              <li key={template.id}>
                {template.name}
                {(canManage(current.role) || writable) && (
                  <button
                    aria-label={`Delete template ${template.name}`}
                    onClick={() => {
                      if (!window.confirm(`Delete template ${template.name}?`)) return;
                      void run(async () => {
                        await client.deleteTemplate(current.id, template.id);
                        await queryClient.invalidateQueries({
                          queryKey: ["templates", current.id],
                        });
                      });
                    }}
                    type="button"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** Chooses the template a new project starts from. */
export function TemplatePicker({
  templates,
  value,
  onChange,
}: {
  templates: ReadonlyArray<Template>;
  value: string;
  onChange: (templateId: string) => void;
}) {
  if (templates.length === 0) return null;
  return (
    <label>
      Start from
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Blank figure</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ProjectFolderSelect({
  client,
  project,
  folders,
  onMoved,
}: {
  client: FigLabClient;
  project: Project;
  folders: ReadonlyArray<Folder>;
  onMoved: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <label>
      {`Folder for ${project.name}`}
      <select
        onChange={async (event) => {
          setError("");
          try {
            await client.moveProject(project.id, event.target.value || null);
            onMoved();
          } catch (failure) {
            setError(errorText(failure));
          }
        }}
        value={project.folderId ?? ""}
      >
        <option value="">No folder</option>
        {folderTree(folders)
          .filter(({ folder }) => !folder.archived || folder.id === project.folderId)
          .map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>
              {`${"  ".repeat(depth)}${folder.name}`}
            </option>
          ))}
      </select>
      {error && <span role="alert">{error}</span>}
    </label>
  );
}

/** Searches project names and original filenames across the user's workspaces. */
export function ProjectSearch({
  client,
  onOpen,
}: {
  client: FigLabClient;
  onOpen: (project: Project) => void;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({
    queryKey: ["search", submitted],
    queryFn: () => client.search(submitted),
    enabled: submitted.length > 0,
  });
  return (
    <section aria-label="Search" className="project-search">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <input
          aria-label="Search projects and files"
          maxLength={120}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search projects and files"
          type="search"
          value={query}
        />
        <Button type="submit">Search</Button>
      </form>
      {submitted && results.data && (
        <ul aria-label="Search results" className="search-results">
          {results.data.length === 0 && <li>No projects or files match “{submitted}”.</li>}
          {results.data.map((hit) => (
            <li key={hit.projectId}>
              <button
                onClick={async () => onOpen(await client.getProject(hit.projectId))}
                type="button"
              >
                {hit.projectName}
              </button>{" "}
              <span>
                {hit.workspaceName}
                {hit.matchedFilenames.length > 0 ? ` · ${hit.matchedFilenames.join(", ")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function inviteLink(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

/** Members, roles, and copyable invite links for a lab workspace. */
export function LabMembers({
  client,
  workspace,
  currentUserId,
  onLeft,
}: {
  client: FigLabClient;
  workspace: Workspace;
  currentUserId: string | undefined;
  onLeft: () => void;
}) {
  const queryClient = useQueryClient();
  const manage = canManage(workspace.role);
  const members = useQuery({
    queryKey: ["members", workspace.id],
    queryFn: () => client.listMembers(workspace.id),
  });
  const invites = useQuery({
    queryKey: ["invites", workspace.id],
    queryFn: () => client.listInvites(workspace.id),
    enabled: manage,
  });
  const [role, setRole] = useState<Exclude<WorkspaceRoleDto, "owner">>("editor");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [status, setStatus] = useState("");
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["members", workspace.id] }),
      queryClient.invalidateQueries({ queryKey: ["invites", workspace.id] }),
      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
    ]);
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setStatus("");
    try {
      await action();
      if (done) setStatus(done);
    } catch (failure) {
      setStatus(errorText(failure));
    }
  };
  const assignable = (member: WorkspaceMemberDto): WorkspaceRoleDto[] =>
    workspace.role === "owner"
      ? ROLE_ORDER
      : member.role === "owner" || member.role === "admin"
        ? [member.role]
        : ["editor", "viewer"];

  return (
    <section aria-label="Lab members" className="lab-members">
      <h2>{workspace.name}</h2>
      {manage && (
        <Button
          onClick={() => {
            const name = window.prompt("Rename lab", workspace.name)?.trim();
            if (name)
              void run(async () => {
                await client.renameWorkspace(workspace.id, name);
                await refresh();
              });
          }}
        >
          Rename lab
        </Button>
      )}
      {workspace.role === "owner" && (
        <Button
          onClick={() => {
            if (!window.confirm(`Delete ${workspace.name}? Its projects must be deleted first.`))
              return;
            void run(async () => {
              await client.deleteLab(workspace.id);
              onLeft();
            });
          }}
        >
          Delete lab
        </Button>
      )}
      <table aria-label="Members">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.data?.map((member) => (
            <tr key={member.userId}>
              <td>{member.email}</td>
              <td>
                {manage && member.userId !== currentUserId ? (
                  <select
                    aria-label={`Role for ${member.email}`}
                    onChange={(event) =>
                      void run(async () => {
                        await client.setMemberRole(
                          workspace.id,
                          member.userId,
                          event.target.value as WorkspaceRoleDto,
                        );
                        await refresh();
                      })
                    }
                    value={member.role}
                  >
                    {assignable(member).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  member.role
                )}
              </td>
              <td>
                {member.userId === currentUserId ? (
                  <Button
                    onClick={() => {
                      if (!window.confirm(`Leave ${workspace.name}?`)) return;
                      void run(async () => {
                        await client.removeMember(workspace.id, member.userId);
                        onLeft();
                      });
                    }}
                  >
                    Leave lab
                  </Button>
                ) : (
                  manage &&
                  assignable(member).length > 1 && (
                    <Button
                      aria-label={`Remove ${member.email}`}
                      onClick={() => {
                        if (!window.confirm(`Remove ${member.email} from ${workspace.name}?`))
                          return;
                        void run(async () => {
                          await client.removeMember(workspace.id, member.userId);
                          await refresh();
                        });
                      }}
                    >
                      Remove
                    </Button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {manage && (
        <>
          <h3>Invite by link</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const created = await client.createInvite(workspace.id, {
                  role,
                  ...(email.trim() ? { email: email.trim() } : {}),
                });
                setLink(inviteLink(created.token));
                setEmail("");
                await refresh();
              }, "Invite link created. Copy it now; it is shown only once.");
            }}
          >
            <label>
              Invite role
              <select
                onChange={(event) =>
                  setRole(event.target.value as Exclude<WorkspaceRoleDto, "owner">)
                }
                value={role}
              >
                {(workspace.role === "owner"
                  ? (["admin", "editor", "viewer"] as const)
                  : (["editor", "viewer"] as const)
                ).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Only for email (optional)
              <input
                maxLength={254}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                value={email}
              />
            </label>
            <Button type="submit">Create invite link</Button>
          </form>
          {link && (
            <div className="invite-link">
              <input aria-label="Invite link" readOnly value={link} />
              <Button
                onClick={() =>
                  void run(() => navigator.clipboard.writeText(link), "Invite link copied.")
                }
              >
                Copy link
              </Button>
            </div>
          )}
          <InviteList
            invites={invites.data ?? []}
            onRevoke={(invite) =>
              void run(async () => {
                await client.revokeInvite(workspace.id, invite.id);
                await refresh();
              })
            }
          />
        </>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function InviteList({
  invites,
  onRevoke,
}: {
  invites: ReadonlyArray<InviteDto>;
  onRevoke: (invite: InviteDto) => void;
}) {
  if (invites.length === 0) return null;
  return (
    <ul aria-label="Invites" className="history-list">
      {invites.map((invite) => (
        <li key={invite.id}>
          {invite.role}
          {invite.email ? ` for ${invite.email}` : " (anyone with the link)"} · {invite.status}
          {invite.acceptedBy ? ` by ${invite.acceptedBy.email}` : ""} · expires{" "}
          {new Date(invite.expiresAt).toLocaleDateString()}
          {invite.status === "pending" && (
            <Button aria-label={`Revoke ${invite.role} invite`} onClick={() => onRevoke(invite)}>
              Revoke
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Records an `?invite=` token from the address bar so it survives sign-in. */
export function capturePendingInvite(): void {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("invite");
    if (!token) return;
    window.sessionStorage.setItem(PENDING_INVITE_KEY, token);
    url.searchParams.delete("invite");
    window.history.replaceState(null, "", url.toString());
  } catch {
    // Without storage the link can simply be opened again after signing in.
  }
}
function pendingInvite(): string | undefined {
  try {
    return window.sessionStorage.getItem(PENDING_INVITE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function clearPendingInvite(): void {
  try {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Offers to join the lab an invite link names. */
export function InviteBanner({
  client,
  onJoined,
}: {
  client: FigLabClient;
  onJoined: (workspace: Workspace) => void;
}) {
  const [token, setToken] = useState<string>();
  useEffect(() => {
    capturePendingInvite();
    setToken(pendingInvite());
  }, []);
  const preview = useQuery({
    queryKey: ["invite", token],
    queryFn: () => client.previewInvite(token as string),
    enabled: Boolean(token),
  });
  const accept = useMutation({
    mutationFn: () => client.acceptInvite(token as string),
    onSuccess: (workspace) => {
      clearPendingInvite();
      setToken(undefined);
      onJoined(workspace);
    },
  });
  if (!token) return null;
  const dismiss = () => {
    clearPendingInvite();
    setToken(undefined);
  };
  const invite = preview.data;
  return (
    <section aria-label="Lab invite" className="invite-banner">
      {preview.isError && <p role="alert">This invite link is not valid.</p>}
      {invite && invite.status !== "pending" && (
        <p role="alert">This invite link is {invite.status}. Ask the lab for a new one.</p>
      )}
      {invite && invite.status === "pending" && (
        <p>
          {`You are invited to join ${invite.workspaceName} as ${invite.role}.`}
          {invite.email ? ` The invite is for ${invite.email}.` : ""}
        </p>
      )}
      {accept.isError && <p role="alert">{errorText(accept.error)}</p>}
      {invite?.status === "pending" && (
        <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
          {`Join ${invite.workspaceName}`}
        </Button>
      )}
      <Button onClick={dismiss}>Dismiss</Button>
    </section>
  );
}

const bytes = (value: number) =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(2)} GB`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)} MB`
      : `${Math.round(value / 1e3)} kB`;

/** Read-only usage overview for FigLab administrators. */
export function AdminPanel({ client }: { client: FigLabClient }) {
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => client.adminOverview(),
  });
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => client.adminUsers() });
  const workspaces = useQuery({
    queryKey: ["admin", "workspaces"],
    queryFn: () => client.adminWorkspaces(),
  });
  const jobs = useQuery({ queryKey: ["admin", "jobs"], queryFn: () => client.adminJobs() });
  const stats = overview.data;
  return (
    <section aria-label="Administration" className="admin-panel">
      <h2>Administration</h2>
      {overview.isError && <p role="alert">{errorText(overview.error)}</p>}
      {stats && (
        <dl className="admin-stats">
          <dt>Users</dt>
          <dd>{stats.users}</dd>
          <dt>Labs</dt>
          <dd>{stats.labWorkspaces}</dd>
          <dt>Projects</dt>
          <dd>{stats.projects}</dd>
          <dt>Originals</dt>
          <dd>{stats.assets}</dd>
          <dt>Storage</dt>
          <dd>{bytes(stats.storageBytes)}</dd>
          <dt>Pending reports</dt>
          <dd>{stats.pendingIntegrityReports}</dd>
          <dt>Failed jobs</dt>
          <dd>{stats.failedJobs}</dd>
        </dl>
      )}
      <h3>Workspaces</h3>
      <table aria-label="All workspaces">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Members</th>
            <th>Projects</th>
            <th>Storage</th>
          </tr>
        </thead>
        <tbody>
          {workspaces.data?.workspaces.map((workspace) => (
            <tr key={workspace.id}>
              <td>{workspace.name}</td>
              <td>{workspace.kind}</td>
              <td>{workspace.members}</td>
              <td>{workspace.projects}</td>
              <td>{bytes(workspace.storageBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Users</h3>
      <table aria-label="All users">
        <thead>
          <tr>
            <th>Email</th>
            <th>Workspaces</th>
            <th>Projects created</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.data?.users.map((user) => (
            <tr key={user.id}>
              <td>{user.email}</td>
              <td>{user.workspaces}</td>
              <td>{user.projects}</td>
              <td>{new Date(user.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Failed jobs</h3>
      {jobs.data?.jobs.length === 0 && <p>No failed jobs.</p>}
      <ul aria-label="Failed jobs" className="history-list">
        {jobs.data?.jobs.map((job) => (
          <li key={job.id}>
            {job.task} · attempt {job.attempts}/{job.maxAttempts} ·{" "}
            {new Date(job.runAt).toLocaleString()}
            {job.lastError ? ` · ${job.lastError}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
