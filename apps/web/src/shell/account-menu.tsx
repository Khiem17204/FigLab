import {
  AccountMenu as AccountMenuButton,
  Badge,
  IconButton,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  type ThemePreference,
  useThemePreference,
} from "@figlab/ui";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { FigLabClient } from "../api/client";
import type { SignedInAccount } from "../auth/auth-gate";

/** Hosted mode shows the signed-in account; local single-user mode shows a theme switch. */
export function AccountArea({
  account,
  client,
  compact = false,
  children,
}: {
  account: SignedInAccount | undefined;
  client: FigLabClient;
  compact?: boolean;
  children?: ReactNode;
}) {
  const [theme, setTheme] = useThemePreference();
  if (!account)
    return (
      <>
        {!compact && <Badge>Local workspace</Badge>}
        <ThemeCycleButton onChange={setTheme} theme={theme} />
      </>
    );
  return (
    <SignedInMenu
      account={account}
      client={client}
      compact={compact}
      setTheme={setTheme}
      theme={theme}
    >
      {children}
    </SignedInMenu>
  );
}

function SignedInMenu({
  account,
  client,
  compact,
  theme,
  setTheme,
  children,
}: {
  account: SignedInAccount;
  client: FigLabClient;
  compact: boolean;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  children?: ReactNode;
}) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => client.me() });
  return (
    <AccountMenuButton
      badge={me.data?.role === "admin" ? <Badge tone="primary">Admin</Badge> : undefined}
      email={account.email}
      onSignOut={() => void account.signOut()}
      onThemeChange={setTheme}
      showEmail={!compact}
      theme={theme}
    >
      {children}
    </AccountMenuButton>
  );
}

const nextTheme: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const themeLabels: Record<ThemePreference, string> = {
  system: "Theme: match system",
  light: "Theme: light",
  dark: "Theme: dark",
};

function ThemeCycleButton({
  theme,
  onChange,
}: {
  theme: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  const icon = theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <MonitorIcon />;
  return (
    <IconButton
      icon={icon}
      label={themeLabels[theme]}
      onClick={() => onChange(nextTheme[theme])}
      tooltipAlign="end"
    />
  );
}
