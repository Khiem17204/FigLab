import type { Project } from "@figlab/api-contract";
import { ArrowLeftIcon, Button, Mascot } from "@figlab/ui";
import { useQuery } from "@tanstack/react-query";

import type { FigLabClient } from "../api/client";
import type { SignedInAccount } from "../auth/auth-gate";
import { FigLabEditor } from "./figlab-editor";

export function EditorLoader({
  account,
  client,
  project,
  onBack,
}: {
  account?: SignedInAccount | undefined;
  client: FigLabClient;
  project: Project;
  onBack: () => void;
}) {
  const loaded = useQuery({
    queryKey: ["document", project.id],
    queryFn: () => client.getDocument(project.id),
  });
  const me = useQuery({ queryKey: ["me"], queryFn: () => client.me() });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.listWorkspaces() });
  const role = workspaces.data?.find((workspace) => workspace.id === project.workspaceId)?.role;
  if (loaded.isLoading)
    return (
      <main className="loading-page">
        <Mascot mood="working" size={56} />
        <p role="status">Loading {project.name}…</p>
      </main>
    );
  if (loaded.isError || !loaded.data)
    return (
      <main className="loading-page">
        <Mascot mood="oops" size={56} />
        <p role="alert">Could not load this project.</p>
        <Button icon={<ArrowLeftIcon size={16} />} onClick={onBack}>
          Projects
        </Button>
      </main>
    );
  return (
    <FigLabEditor
      access={{
        // Until the role is known, behave as before; the server enforces roles regardless.
        readOnly: role === "viewer",
        canModerate: role === "owner" || role === "admin" || role === undefined,
        ...(me.data?.userId ? { currentUserId: me.data.userId } : {}),
      }}
      account={account}
      client={client}
      initial={loaded.data}
      onBack={onBack}
      project={project}
      reload={() => loaded.refetch()}
    />
  );
}
