# Plan: agentic MCP for skill creation (Clerk as OAuth server)

## Revisions after subagent review (what was actually built)
- Auth: no `@clerk/hono`. `worker/mcp-auth.ts` uses `@clerk/backend` `authenticateRequest({acceptsToken:'oauth_token'})` plus `@clerk/mcp-tools/server` helpers, with a 30s positive cache. No `authorizedParties` on this path.
- Token confusion: `/api` now rejects `oat_` and `at+jwt` tokens explicitly; `/mcp` only accepts OAuth tokens. Every 401 carries `WWW-Authenticate` with the resource metadata URL.
- Transport: `WebStandardStreamableHTTPServerTransport`, stateless, JSON responses, `GET /mcp` is 405. Body capped at 256KB. User id is read from each request's `authInfo` only.
- CORS: `/mcp` allows claude.ai and the web app origins, not `*`; `.well-known` documents are public.
- Refactor shrunk to `startRun` and `answerQuestion` in `worker/service.ts` (moved verbatim); `createProject` untouched, MCP gets its own text-only create.
- Tools consolidated from 9 to 7 (`get_skill` plans on demand, `review_summary` covers revise and confirm, `get_build` returns the prompt). Resource template dropped.
- Limits: new `mcp_calls` table (migration 0005) with an atomic guarded insert, 200 model-backed calls/day; 30 new skills/day counted across all sources. `source` column dropped.
- `context` is stored as `""` so the attachment digest code never runs on agent input; extra detail is folded into `idea`.
- Not done: audience (`aud`) binding, because it depends on what Clerk puts in OAuth access tokens; verify in the Clerk Dashboard.

## Goal
Let an agent (Claude Code, Codex, Cursor, claude.ai) connect to Offshoot over MCP, sign in as the user through Clerk's OAuth flow, and drive the whole skill-creation pipeline that the web UI drives today: describe idea -> confirm summary -> answer questions -> run the multi-agent build -> fetch the finished build prompt (and improve it).

## Interpretation
"Clerk Agents auth" = Clerk acting as the OAuth 2.1 authorization server for MCP clients (CIMD/DCR + PKCE, consent screen). The Worker is the MCP resource server and only verifies Clerk OAuth access tokens. No custom token issuance.

## Architecture
- Endpoint `POST /mcp` (Streamable HTTP, stateless: new McpServer + transport per request) on the existing Hono worker. Not under `/api`, so the wrangler `run_worker_first` list gets `/mcp` and `/.well-known/*`.
- Discovery: `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-authorization-server` via `@clerk/mcp-tools/hono` (needs `CLERK_PUBLISHABLE_KEY` var). 401s carry `WWW-Authenticate: Bearer resource_metadata=...`.
- Auth: `@clerk/mcp-tools/hono` `mcpAuthClerk` depends on `@clerk/hono` middleware; instead write our own `mcpAuth(verify)` using `@clerk/backend` `authenticateRequest`/`verifyToken` with `acceptsToken: 'oauth_token'` so we don't add `@clerk/hono` unless it is simpler. userId comes from the verified token's `sub`; it is the only identity tools use. Tools never accept a userId argument.
- Session tokens (existing `requireUser`) and OAuth tokens (MCP) are separate paths; `/mcp` rejects session tokens and `/api` rejects OAuth tokens.
- Scopes: `profile email` only (Clerk-supported); authorization is "token valid => this user's own projects". Every query is already user-scoped.

## Refactor (avoid duplicating route logic)
Extract the business logic out of `worker/index.ts` route handlers into `worker/service.ts` functions taking `(env, ctx, userId, ...)`: `createProject`, `getProjectDetail`, `listProjects`, `planIntake`, `rewriteSummary`, `confirmSummary`, `answerQuestion`, `startRun`. Routes become thin wrappers; MCP tools call the same functions. Daily run limit, claim logic and ownership checks therefore apply identically. Behavior of existing routes must not change.

## MCP tools (`worker/mcp.ts`)
1. `list_skills` - the user's projects (id, title, status, latest score).
2. `create_skill` {idea, name?} - creates a project (no file attachments over MCP v1; text `context` arg optional, capped 20k chars, stored in `projects.context`).
3. `get_skill` {id} - state: status, summary, questions+answers, latest version, run state hint.
4. `plan_intake` {id} - returns summary, or after confirmation the questions (wraps /plan).
5. `revise_summary` {id, guidance}; `confirm_summary` {id}.
6. `answer_question` {id, questionId, answer?} - empty/skip allowed; `replan` default true.
7. `start_build` {id, improve?} - starts the run (same limits); returns runId.
8. `get_build` {id} - run status/score/round from the Durable Object `getState()` plus latest prompt body when done. Agents poll (no websocket).
9. `get_skill_prompt` {id, version?} - the finished build prompt body, for the agent to hand to its own coding step. Also exposed as a resource `offshoot://skills/{id}/prompt`.
Annotations: read tools `readOnlyHint`, `delete` not exposed (v1 is non-destructive). Tool errors return `isError` with user-facing messages, never raw exceptions.

## Data/migration
`migrations/0005_mcp_origin.sql`: add `projects.source TEXT NOT NULL DEFAULT 'web'` ('web'|'mcp') so we can show/audit agent-created skills. No other schema change.

## Config & ops
- `wrangler.jsonc`: add `CLERK_PUBLISHABLE_KEY` var, add `/mcp`, `/.well-known/*` to `run_worker_first`, add `MCP_ORIGIN_ALLOWLIST` not needed (token auth, not cookies).
- Security: validate `Origin` header on `/mcp` when present (DNS-rebinding guidance in MCP spec) against `AUTHORIZED_PARTIES` plus requests with no Origin (non-browser clients). CORS only on `.well-known` and `/mcp` for browser-based clients (claude.ai). Body size cap 256KB. Per-user rate limit reuses `DAILY_RUN_LIMIT` for `start_build`; add a cheap per-user cap on `create_skill` (e.g. 30/day, counted from projects.created_at where source='mcp').
- Clerk Dashboard (manual, documented in README): enable OAuth applications, Publish CIMD (and DCR for clients lacking CIMD), default scopes `profile email`.

## UI touch (small)
README section "Connect an agent" with `claude mcp add --transport http offshoot https://<host>/mcp`. Optional: a "Connect an agent" snippet card in the History screen (copyable command). Keep out of v1 if it grows.

## Verification
- `npm run typecheck` and `npm run build` clean.
- Local `wrangler dev`/vite run: curl `/.well-known/*` returns metadata; unauthenticated `/mcp` -> 401 with WWW-Authenticate; session token on `/mcp` -> 401.
- Unit-ish script (`scripts/mcp-smoke.mjs`) using the MCP SDK client with a stub verifier is not possible without Clerk keys; instead test the tool layer by calling `buildServer(stubAuth)` through the SDK's in-memory transport against a local D1 (`wrangler d1 migrations apply --local`), with Gemini calls only exercised for plan/summary if `GEMINI_API_KEY` is present.
- Existing web routes regression-checked via typecheck + manual curl of `/api/health`.

## Out of scope (v1)
Attachments over MCP, deleting skills, websocket streaming of runs, steering/pausing runs, MCP *client* connections (Offshoot calling other MCP servers), per-tool OAuth scopes.

## Risks / open questions
- `@clerk/mcp-tools` `/hono` pulls `@clerk/hono` + `@modelcontextprotocol/sdk` (large; check Worker bundle size and nodejs_compat compatibility).
- Verifying OAuth access tokens needs `acceptsToken: 'oauth_token'` support in `@clerk/backend` v3 `authenticateRequest`; confirm the exact API.
- Stateless transport means no server->client notifications; fine for polling design.
