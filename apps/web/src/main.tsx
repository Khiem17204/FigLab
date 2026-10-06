import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { FigLabClient } from "./api/client";
import { FigLabApp } from "./app";
import { AuthGate } from "./auth/auth-gate";
import { createAuthClient } from "./auth/supabase";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const auth = createAuthClient();
const client = auth
  ? new FigLabClient(undefined, undefined, {
      getAccessToken: async () => (await auth.auth.getSession()).data.session?.access_token,
      onUnauthorized: () => void auth.auth.signOut(),
    })
  : undefined;

createRoot(root).render(
  <StrictMode>
    {auth && client ? (
      <AuthGate auth={auth}>
        {(account) => <FigLabApp account={account} client={client} key={account.email} />}
      </AuthGate>
    ) : (
      <FigLabApp />
    )}
  </StrictMode>,
);
