import type { Project } from "@figlab/api-contract";
import { Button, Panel } from "@figlab/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { FigLabClient } from "../api/client";
import type { SignedInAccount } from "../auth/auth-gate";
import { AccountMenu } from "../shell/account-menu";

export function Dashboard({
  account,
  client,
  onOpen,
}: {
  account: SignedInAccount | undefined;
  client: FigLabClient;
  onOpen: (project: Project) => void;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => client.listProjects() });
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (projectName: string) => client.createProject(projectName),
    onSuccess: (created) => onOpen(created),
  });
  const rename = useMutation({
    mutationFn: ({ projectId, projectName }: { projectId: string; projectName: string }) =>
      client.renameProject(projectId, projectName),
    onSuccess: () => projects.refetch(),
  });
  const remove = useMutation({
    mutationFn: (projectId: string) => client.deleteProject(projectId),
    onSuccess: () => projects.refetch(),
  });
  return (
    <main className="app-shell">
      <header className="app-header">
        <strong>FigLab</strong>
        <span>Scientific figure workspace</span>
        {account && <AccountMenu account={account} client={client} />}
      </header>
      <div className="dashboard-layout">
        <nav aria-label="Project navigation" className="side-nav">
          <strong>Projects</strong>
        </nav>
        <section aria-labelledby="projects-heading" className="dashboard-content">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Workspace</p>
              <h1 id="projects-heading">Projects</h1>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) create.mutate(name.trim());
              }}
            >
              <input
                aria-label="New project name"
                onChange={(event) => setName(event.target.value)}
                placeholder="New project name"
                value={name}
              />
              <Button disabled={create.isPending} type="submit">
                Create project
              </Button>
            </form>
          </div>
          {projects.isLoading && <p role="status">Loading projects…</p>}
          {projects.isError && (
            <p role="alert">Could not load projects. Retry when the server is available.</p>
          )}
          {projects.data?.length === 0 && (
            <p className="empty-state">No projects yet. Create one to begin a figure.</p>
          )}
          <div className="project-grid">
            {projects.data?.map((item) => (
              <Panel key={item.id}>
                <h2>{item.name}</h2>
                <p>Updated {new Date(item.updatedAt).toLocaleDateString()}</p>
                <Button aria-label={`Open ${item.name}`} onClick={() => onOpen(item)}>
                  Open
                </Button>
                <Button
                  aria-label={`Rename ${item.name}`}
                  onClick={() => {
                    const value = window.prompt("Rename project", item.name)?.trim();
                    if (value) rename.mutate({ projectId: item.id, projectName: value });
                  }}
                >
                  Rename
                </Button>
                <Button
                  aria-label={`Delete ${item.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete ${item.name}?`)) remove.mutate(item.id);
                  }}
                >
                  Delete
                </Button>
              </Panel>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
