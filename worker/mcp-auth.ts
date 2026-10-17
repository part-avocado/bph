import { createClerkClient } from "@clerk/backend";
import { verifyClerkToken as toAuthInfo } from "@clerk/mcp-tools/server";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

let clerk: ReturnType<typeof createClerkClient> | undefined;
// Opaque OAuth tokens are checked with a Clerk API call, so remember good ones briefly.
const CACHE_MS = 30_000;
const CACHE_MAX = 500;
const cache = new Map<string, { info: AuthInfo; until: number }>();

/** Session tokens (for the web app) and OAuth tokens (for MCP clients) must never be accepted in each other's place. */
export const isOAuthAccessToken = (token: string) => {
  if (token.startsWith("oat_")) return true;
  try {
    const header = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    return header?.typ === "at+jwt";
  } catch {
    return false;
  }
};

/** Verifies the bearer OAuth access token Clerk issued to an MCP client. Returns null when it isn't valid. */
export async function verifyMcpRequest(env: Env, req: Request): Promise<AuthInfo | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return null;
  const hit = cache.get(token);
  if (hit) {
    if (hit.until > Date.now()) return hit.info;
    cache.delete(token);
  }
  clerk ??= createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  let info: AuthInfo | undefined;
  try {
    // No authorizedParties here: OAuth access tokens carry no session `azp`.
    const state = await clerk.authenticateRequest(req, { acceptsToken: "oauth_token" });
    const auth = state.toAuth();
    if (auth && auth.isAuthenticated && auth.tokenType === "oauth_token") info = toAuthInfo(auth, token);
  } catch (err) {
    console.error("MCP token rejected:", err instanceof Error ? err.message : err);
  }
  if (!info) return null;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(token, { info, until: Date.now() + CACHE_MS });
  return info;
}
