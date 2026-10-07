import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const storageKey = "figlab-theme";

export function readThemePreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Sets `<html data-theme>`; "system" removes it so `prefers-color-scheme` decides. */
export function applyThemePreference(preference: ThemePreference): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
}

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  useEffect(() => applyThemePreference(preference), [preference]);
  const update = useCallback((next: ThemePreference) => {
    setPreference(next);
    try {
      if (next === "system") globalThis.localStorage?.removeItem(storageKey);
      else globalThis.localStorage?.setItem(storageKey, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
  }, []);
  return [preference, update];
}
