import { verifyToken } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./index";

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
  if (!token) return null;
  const hit = verified.get(token);
  if (hit) {
    if (hit.exp > Date.now()) return hit.sub;
    verified.delete(token);
  }
  const { data, errors } = await verifyToken(token, {
    secretKey: env.CLERK_SECRET_KEY,
    authorizedParties: authorizedParties(env),
  });
  const claims = data as { sub?: string; exp?: number } | undefined;
  const sub = claims?.sub;
  if (errors || !sub) {
    if (errors) console.error("Clerk token rejected:", JSON.stringify(errors));
    return null;
  }
  if (claims.exp) {
    if (verified.size >= VERIFIED_MAX) verified.delete(verified.keys().next().value!);
    verified.set(token, { sub, exp: claims.exp * 1000 });
  }
  return sub;
}

/**
 * Requires a Clerk session. Browsers send it as a bearer token; WebSocket
 * upgrades can't set headers, so they pass it as ?token= instead.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  // Only accept the query-string token on WebSocket upgrades so it never ends up in ordinary request URLs.
  const isUpgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
  const token = header?.startsWith("Bearer ") ? header.slice(7) : isUpgrade ? c.req.query("token") : undefined;
  const userId = await verifyClerkToken(c.env, token);
  if (!userId) return c.json({ error: "Sign in to continue." }, 401);
  c.set("userId", userId);
  await next();
});
