import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Hosted builds set `VITE_AUTH_MODE=supabase`; the local single-user build leaves it unset and
 * runs without sign-in. Only the publishable key reaches the browser.
 */
export function createAuthClient(
  env: Record<string, string | boolean | undefined> = import.meta.env,
): SupabaseClient | undefined {
  if (env.VITE_AUTH_MODE !== "supabase") return undefined;
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof url !== "string" || !url || typeof key !== "string" || !key)
    throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required");
  return createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}
