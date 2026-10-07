import type { Project } from "@figlab/api-contract";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  Input,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  useToast,
} from "@figlab/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";

import type { FigLabClient } from "../api/client";
import type { SignedInAccount } from "../auth/auth-gate";
import { AccountArea } from "../shell/account-menu";
import { Brand } from "../shell/brand";
import { ProjectThumbnail } from "../shell/project-thumbnail";
import { relativeTime } from "../shell/relative-time";
import {
  AdminPanel,
  canWrite,
  InviteBanner,
  LabMembers,
  ProjectFolderSelect,
  ProjectSearch,
  TemplatePicker,
  useFolders,
  useTemplates,
  useWorkspaceSelection,
  WorkspaceNav,
} from "../workspaces/workspaces";

/** Mirrors the API contract's project-name limit so the form can explain it up front. */
export const PROJECT_NAME_MAX = 120;

/** Returns an error message for an unusable project name, or undefined when it is fine. */
export function projectNameError(name: string, verb = "create"): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return `Give your project a name to ${verb} it.`;
  if (trimmed.length > PROJECT_NAME_MAX)
    return `Keep the name to ${PROJECT_NAME_MAX} characters or fewer.`;
  return undefined;
}

export function Dashboard({
  account,
  client,
  onOpen,
}: {
  account: SignedInAccount | undefined;
  client: FigLabClient;
  onOpen: (project: Project) => void;
}) {
  const toast = useToast();
  const me = useQuery({ queryKey: ["me"], queryFn: () => client.me() });
  const selection = useWorkspaceSelection(client);
  const workspace = selection.current;
  const folders = useFolders(client, workspace?.id);
  const templates = useTemplates(client, workspace?.id);
  // The personal workspace's full list is also served by /v1/projects.
  const simpleList = !workspace || (workspace.kind === "personal" && selection.folder === "all");
  const projects = useQuery({
    queryKey: ["projects", workspace?.id ?? "personal", selection.folder],
    queryFn: () =>
      simpleList || !workspace
        ? client.listProjects()
        : client.listWorkspaceProjects(
            workspace.id,
            selection.folder === "all" ? {} : { folderId: selection.folder },
          ),
  });
  const [templateId, setTemplateId] = useState("");
  const [panel, setPanel] = useState<"members" | "admin">();
  const folderId =
    selection.folder !== "all" && selection.folder !== "root" ? selection.folder : undefined;
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const nameInput = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<Project>();
  const [deleting, setDeleting] = useState<Project>();
  const create = useMutation({
    mutationFn: (projectName: string) =>
      workspace && (workspace.kind === "lab" || folderId || templateId)
        ? client.createWorkspaceProject(workspace.id, {
            name: projectName,
            ...(folderId ? { folderId } : {}),
            ...(templateId ? { templateId } : {}),
          })
        : client.createProject(projectName),
    onSuccess: (created) => onOpen(created),
    onError: (error) =>
      setNameError(
        error instanceof Error ? `Could not create the project: ${error.message}` : undefined,
      ),
  });
  const rename = useMutation({
    mutationFn: ({ projectId, projectName }: { projectId: string; projectName: string }) =>
      client.renameProject(projectId, projectName),
    onSuccess: (_result, variables) => {
      setRenaming(undefined);
      toast.show({ tone: "success", title: `Renamed to “${variables.projectName}”` });
      return projects.refetch();
    },
  });
  const remove = useMutation({
    mutationFn: (project: Project) => client.deleteProject(project.id),
    onSuccess: (_result, project) => {
      setDeleting(undefined);
      toast.show({
        tone: "success",
        title: `Deleted “${project.name}”`,
        description: "Its originals are being removed in the background.",
      });
      return projects.refetch();
    },
    onError: (error) =>
      toast.show({
        tone: "error",
        title: "Could not delete the project",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = projectNameError(name);
    setNameError(problem);
    if (problem) {
      nameInput.current?.focus();
      return;
    }
    create.mutate(name.trim());
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <Brand />
        <span className="app-header-spacer" />
        <AccountArea account={account} client={client} />
      </header>
      <div className="dashboard-layout" data-sidebar={workspace ? "" : undefined}>
        {workspace && (
          <nav aria-label="Project navigation" className="side-nav">
            <WorkspaceNav client={client} selection={selection} />
          </nav>
        )}
        <section aria-labelledby="projects-heading" className="dashboard">
          <div className="dashboard-hero">
            <div className="dashboard-title">
              <p className="eyebrow">
                {workspace?.kind === "lab" ? `Lab · ${workspace.name}` : "Workspace"}
              </p>
              <h1 id="projects-heading">
                <span className="fl-highlight">Projects</span>
              </h1>
              <p className="dashboard-lede">
                Crop originals, arrange panels and export. Every panel stays linked to its source
                pixels.
              </p>
            </div>
            <form className="create-form" noValidate onSubmit={submit}>
              <Field error={nameError} label="New project name">
                <Input
                  maxLength={PROJECT_NAME_MAX + 1}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (nameError) setNameError(undefined);
                  }}
                  placeholder="e.g. Fig. 2 · siRNA knockdown"
                  ref={nameInput}
                  value={name}
                />
              </Field>
              <TemplatePicker
                onChange={setTemplateId}
                templates={templates.data ?? []}
                value={templateId}
              />
              <Button
                icon={<PlusIcon size={16} />}
                loading={create.isPending}
                type="submit"
                variant="primary"
              >
                Create project
              </Button>
            </form>
          </div>
          <InviteBanner
            client={client}
            onJoined={async (joined) => {
              await selection.refetch();
              selection.select(joined.id);
            }}
          />
          {(workspace?.kind === "lab" || me.data?.role === "admin" || workspace) && (
            <div className="dashboard-tools">
              {workspace && <ProjectSearch client={client} onOpen={onOpen} />}
              <div className="folder-actions">
                {workspace?.kind === "lab" && (
                  <Button
                    aria-pressed={panel === "members"}
                    onClick={() => setPanel(panel === "members" ? undefined : "members")}
                    size="sm"
                  >
                    Lab members
                  </Button>
                )}
                {me.data?.role === "admin" && (
                  <Button
                    aria-pressed={panel === "admin"}
                    onClick={() => setPanel(panel === "admin" ? undefined : "admin")}
                    size="sm"
                  >
                    Administration
                  </Button>
                )}
              </div>
            </div>
          )}
          {panel === "members" && workspace?.kind === "lab" && (
            <LabMembers
              client={client}
              currentUserId={me.data?.userId}
              onLeft={async () => {
                setPanel(undefined);
                const remaining = await selection.refetch();
                const personal = remaining.data?.find((entry) => entry.kind === "personal");
                if (personal) selection.select(personal.id);
              }}
              workspace={workspace}
            />
          )}
          {panel === "admin" && <AdminPanel client={client} />}

          {projects.isLoading && (
            <div className="project-grid">
              <p className="fl-visually-hidden" role="status">
                Loading projects…
              </p>
              {[0, 1, 2].map((index) => (
                <div aria-hidden="true" className="project-card skeleton" key={index} />
              ))}
            </div>
          )}
          {projects.isError && (
            <div role="alert">
              <EmptyState
                actions={<Button onClick={() => void projects.refetch()}>Try again</Button>}
                mood="oops"
                title="Could not load projects"
              >
                Retry when the server is available. Nothing in your workspace has changed.
              </EmptyState>
            </div>
          )}
          {projects.data?.length === 0 && (
            <EmptyState
              actions={
                <Button
                  icon={<PlusIcon size={16} />}
                  onClick={() => nameInput.current?.focus()}
                  variant="primary"
                >
                  Name your first figure
                </Button>
              }
              className="dashboard-empty"
              title="No projects yet"
            >
              Create one to begin a figure. Drop in your blots and micrographs, and every crop keeps
              a link back to its original.
            </EmptyState>
          )}
          {!!projects.data?.length && (
            <ul className="project-grid">
              {projects.data.map((item) => (
                <li className="project-card" key={item.id}>
                  <button
                    aria-label={`Open ${item.name}`}
                    className="project-open"
                    onClick={() => onOpen(item)}
                    type="button"
                  />
                  <ProjectThumbnail seed={item.id} />
                  <div className="project-meta">
                    <h2>{item.name}</h2>
                    <p>
                      Edited{" "}
                      <time
                        dateTime={item.updatedAt}
                        title={new Date(item.updatedAt).toLocaleString()}
                      >
                        {relativeTime(item.updatedAt)}
                      </time>
                    </p>
                  </div>
                  {workspace && canWrite(workspace.role) && (folders.data?.length ?? 0) > 0 && (
                    <div className="project-folder">
                      <ProjectFolderSelect
                        client={client}
                        folders={folders.data ?? []}
                        onMoved={() => void projects.refetch()}
                        project={item}
                      />
                    </div>
                  )}
                  <div className="project-actions">
                    <IconButton
                      icon={<PencilIcon size={16} />}
                      label={`Rename ${item.name}`}
                      onClick={() => setRenaming(item)}
                      size="sm"
                      tooltip={false}
                    />
                    <IconButton
                      icon={<TrashIcon size={16} />}
                      label={`Delete ${item.name}`}
                      onClick={() => setDeleting(item)}
                      size="sm"
                      tooltip={false}
                      variant="danger"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <RenameDialog
        error={rename.error instanceof Error ? rename.error.message : undefined}
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(undefined);
            rename.reset();
          }
        }}
        onRename={(projectName) => {
          if (renaming) rename.mutate({ projectId: renaming.id, projectName });
        }}
        pending={rename.isPending}
        project={renaming}
      />
      <ConfirmDialog
        busy={remove.isPending}
        confirmLabel="Delete project"
        description="This removes the project and its uploaded originals for good. Exported PNGs you downloaded are not affected."
        destructive
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        open={!!deleting}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete project?"}
      />
    </main>
  );
}

function RenameDialog({
  project,
  pending,
  error,
  onRename,
  onOpenChange,
}: {
  project: Project | undefined;
  pending: boolean;
  error: string | undefined;
  onRename: (name: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={!!project}>
      {project && (
        <RenameForm
          error={error}
          initialName={project.name}
          key={project.id}
          onRename={onRename}
          pending={pending}
        />
      )}
    </Dialog>
  );
}

function RenameForm({
  initialName,
  pending,
  error,
  onRename,
}: {
  initialName: string;
  pending: boolean;
  error: string | undefined;
  onRename: (name: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  const [problem, setProblem] = useState<string>();
  const formId = "rename-project-form";
  return (
    <DialogContent
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button form={formId} loading={pending} type="submit" variant="primary">
            Save name
          </Button>
        </>
      }
      title="Rename project"
    >
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const next = projectNameError(value, "save");
          setProblem(next);
          if (!next) onRename(value.trim());
        }}
      >
        <Field
          error={problem ?? (error ? `Could not rename: ${error}` : undefined)}
          label="Project name"
        >
          <Input
            autoFocus
            maxLength={PROJECT_NAME_MAX + 1}
            onChange={(event) => {
              setValue(event.target.value);
              setProblem(undefined);
            }}
            onFocus={(event) => event.currentTarget.select()}
            value={value}
          />
        </Field>
      </form>
    </DialogContent>
  );
}
