import type { FigLabRepository, Principal, PrincipalRole } from "@figlab/database";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export class UnauthorizedError extends Error {
  constructor(message = "Sign in to continue") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Resolves the caller of one request from its `Authorization` header. */
export type PrincipalResolver = (authorization: string | undefined) => Promise<Principal>;

export function singleUserResolver(principal: Principal): PrincipalResolver {
  return async () => principal;
}

export interface SupabaseResolverOptions {
  supabaseUrl: string;
  repository: FigLabRepository;
  /** Overrides the JWKS lookup; tests pass a local key set. */
  keys?: JWTVerifyGetKey;
  /** How long a verified user's workspace lookup is reused in a warm process. */
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Verifies Supabase Auth access tokens against the project's published signing keys and maps
 * each user onto their personal FigLab workspace, provisioning it on first sight.
 */
export function supabaseResolver(options: SupabaseResolverOptions): PrincipalResolver {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const workspaces = new Map<string, { principal: Principal; expiresAt: number }>();

  return async (authorization) => {
    const token = bearerToken(authorization);
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer, audience: "authenticated" }));
    } catch {
      throw new UnauthorizedError("Session is invalid or has expired");
    }
    const id = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!id || !email || payload.is_anonymous === true)
      throw new UnauthorizedError("Session is not tied to a verified account");
    const role = roleFrom(payload.app_metadata);

    const cached = workspaces.get(id);
    if (cached && cached.expiresAt > now() && cached.principal.email === email)
      return { ...cached.principal, role };
    const principal = await options.repository.ensureAuthUser({ id, email });
    workspaces.set(id, { principal, expiresAt: now() + cacheTtlMs });
    return { ...principal, role };
  };
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match?.[1]) throw new UnauthorizedError();
  return match[1];
}

function roleFrom(appMetadata: unknown): PrincipalRole {
  return typeof appMetadata === "object" &&
    appMetadata !== null &&
    (appMetadata as Record<string, unknown>).role === "admin"
    ? "admin"
    : "member";
}
