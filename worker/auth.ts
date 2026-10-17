import { verifyToken } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./index";
import { isOAuthAccessToken } from "./mcp-auth";

// Parsed once per isolate instead of on every request.
let partiesSource: string | null = null;
let parties: string[] = [];
function authorizedParties(env: Env) {
  if (partiesSource !== env.AUTHORIZED_PARTIES) {
    partiesSource = env.AUTHORIZED_PARTIES;
    parties = partiesSource.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return parties;
}

// Clerk session tokens are short-lived and the browser reuses one for many
// requests (and every WebSocket reconnect), so remember verified tokens until
// they expire rather than re-checking the signature each time.
const VERIFIED_MAX = 500;
const verified = new Map<string, { sub: string; exp: number }>();

/** Verifies a Clerk session token and returns the user id, or null. */
export async function verifyClerkToken(env: Env, token: string | null | undefined): Promise<string | null> {
  // OAuth access tokens belong to the MCP endpoint only.
  if (!token || isOAuthAccessToken(token)) return null;
  const hit = verified.get(token);
  if (hit) {
    if (hit.exp > Date.now()) return hit.sub;
    verified.delete(token);
  }
  // verifyToken returns the claims and throws when the token is invalid.
  let claims: { sub?: string; exp?: number };
  try {
    claims = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      authorizedParties: authorizedParties(env),
    });
  } catch (err) {
    console.error("Clerk token rejected:", err instanceof Error ? err.message : err);
    return null;
  }
  const sub = claims.sub;
  if (!sub) return null;
  if (claims.exp) {
    if (verified.size >= VERIFIED_MAX) verified.delete(verified.keys().next().value!);
    verified.set(token, { sub, exp: claims.exp * 1000 });
  }
  return sub;
}

/** The token a browser WebSocket sends as the subprotocols "bearer, <token>" (the only header it can set). */
function socketToken(protocols: string | undefined) {
  const list = protocols?.split(",").map((s) => s.trim()) ?? [];
  const i = list.indexOf("bearer");
  return i >= 0 ? list[i + 1] : undefined;
}

/**
 * Requires a Clerk session. Browsers send it as a bearer token; WebSocket
 * upgrades can't set an Authorization header, so they pass it in the
 * Sec-WebSocket-Protocol header. Not the URL: request URLs end up in logs.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const isUpgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
  const token = header?.startsWith("Bearer ") ? header.slice(7) : isUpgrade ? socketToken(c.req.header("Sec-WebSocket-Protocol")) : undefined;
  const userId = await verifyClerkToken(c.env, token);
  if (!userId) return c.json({ error: "Sign in to continue." }, 401);
  c.set("userId", userId);
  await next();
});
