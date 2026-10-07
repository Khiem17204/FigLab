import type { Project } from "@figlab/api-contract";
import { Button } from "@figlab/ui";
import { useQuery } from "@tanstack/react-query";

import type { FigLabClient } from "../api/client";
import type { SignedInAccount } from "../auth/auth-gate";
import { FigLabEditor } from "./figlab-editor";

export function EditorLoader({
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
  if (loaded.isLoading)
    return (
      <main className="loading-page">
        <p role="status">Loading {project.name}…</p>
      </main>
    );
  if (loaded.isError || !loaded.data)
    return (
      <main className="loading-page">
        <p role="alert">Could not load this project.</p>
        <Button onClick={onBack}>Projects</Button>
      </main>
    );
  return (
    <FigLabEditor
      client={client}
      initial={loaded.data}
      onBack={onBack}
      project={project}
      reload={() => loaded.refetch()}
    />
  );
}
