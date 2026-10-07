import type { Project } from "@figlab/api-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { FigLabClient } from "./api/client";
import type { SignedInAccount } from "./auth/auth-gate";
import { Dashboard } from "./dashboard/dashboard";
import { EditorLoader } from "./editor-ui/editor-loader";
import "./styles.css";

export { FigLabEditor } from "./editor-ui/figlab-editor";

const defaultClient = new FigLabClient();

export function FigLabApp({
  client = defaultClient,
  account,
}: {
  client?: FigLabClient;
  account?: SignedInAccount;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [project, setProject] = useState<Project>();
  return (
    <QueryClientProvider client={queryClient}>
      {project ? (
        <EditorLoader client={client} onBack={() => setProject(undefined)} project={project} />
      ) : (
        <Dashboard account={account} client={client} onOpen={setProject} />
      )}
    </QueryClientProvider>
  );
}
