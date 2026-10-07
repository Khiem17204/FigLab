import { Button } from "@figlab/ui";
import { useQuery } from "@tanstack/react-query";

import type { FigLabClient } from "../api/client";
import type { SignedInAccount } from "../auth/auth-gate";

export function AccountMenu({
  account,
  client,
}: {
  account: SignedInAccount;
  client: FigLabClient;
}) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => client.me() });
  return (
    <div className="account-menu">
      <span className="account-email">{account.email}</span>
      {me.data?.role === "admin" && <span className="role-badge">Admin</span>}
      <Button onClick={() => void account.signOut()}>Sign out</Button>
    </div>
  );
}
