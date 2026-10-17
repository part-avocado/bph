import { verifyToken } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./index";

/** Verifies a Clerk session token and returns the user id, or null. */
export async function verifyClerkToken(env: Env, token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const { data, errors } = await verifyToken(token, {
    secretKey: env.CLERK_SECRET_KEY,
    authorizedParties: env.AUTHORIZED_PARTIES.split(",").map((s) => s.trim()).filter(Boolean),
  });
  const sub = (data as { sub?: string } | undefined)?.sub;
  return errors || !sub ? null : sub;
}

/**
 * Requires a Clerk session. Browsers send it as a bearer token; WebSocket
 * upgrades can't set headers, so they pass it as ?token= instead.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
  const userId = await verifyClerkToken(c.env, token);
  if (!userId) return c.json({ error: "Sign in to continue." }, 401);
  c.set("userId", userId);
  await next();
});
