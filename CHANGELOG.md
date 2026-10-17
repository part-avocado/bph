# Changelog


## [Unreleased] - 2026-10-17

> [!WARNING] Breaking Changes
> These apply to anyone who connected to or built against the pre-rename ("offshoot") deployment.
> - **MCP server renamed `offshoot` → `reskill`** — the server now reports `name: "reskill"` and the OAuth protected-resource name is `reSkill`. Migration: remove the old entry and re-add it with `claude mcp add --transport http reskill <url>/mcp`, then re-authenticate via `/mcp`. (`7c83773`)
> - **WebSocket auth token moved out of the URL** — `GET /runs/:id/ws` no longer accepts `?token=`. Migration: send the token in the `Sec-WebSocket-Protocol` header as the subprotocols `bearer, <token>`. (`7c83773`)
> - **`get_build` no longer returns `pollAfterSeconds`** — it now long-polls (~25s) while a build runs. Migration: stop sleeping between calls; call `get_build` again immediately until `status` is `done`, or pass `wait: false` for the old immediate-return behavior. (`7c83773`)
> - **Package renamed `offshoot` → `reskill`** in `package.json`. Update any scripts or tooling that reference the old name. (`7c83773`)

### Features
- **MCP server at `/mcp`** exposing seven tools: `list_skills`, `create_skill`, `get_skill`, `review_summary`, `answer_question`, `start_build`, `get_build`, with bearer-token auth (`worker/mcp.ts`, `worker/mcp-auth.ts`). (`c610604`, `1726d48`, `374f0ae`)
- **`get_build` accepts `wait`** (boolean, default `true`) to hold the call open until build progress changes. (`7c83773`)
- **Idea summary + confirmation step** before intake questions: new `POST /projects/:id/summary` and `POST /projects/:id/summary/confirm`, backed by `summary` / `summary_confirmed` columns (migration `0004`). Existing projects with questions are marked confirmed. (`1cea866`)
- **Usage caps** per user per 24 hours: 200 model-backed calls and 30 new skills. Over the limit, REST routes return `429` and MCP tools return `LIMIT_REACHED`. Tracked in the new `mcp_calls` table (migration `0005`). (`7c83773`, `374f0ae`)
- **Core app surface:** project routes (`GET/POST /projects`, `GET/DELETE /projects/:id`, `POST /projects/:id/plan`, `/answers`, `/runs`), `GET /health`, Clerk webhook at `POST /webhooks/clerk`, and a streaming build log over `GET /runs/:id/ws`. (`05f5ccf`, `fb11282`)
- **New config:** secrets `GEMINI_API_KEY`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `VITE_CLERK_PUBLISHABLE_KEY` (see `.dev.vars.example`, `.env.example`); bindings `DB` (D1), `UPLOADS` (R2), `RUN` (Durable Object `RunObject`). (`7c20118`, `224807f`)

### Fixes
- **Deleting a project or account now cancels in-flight builds** and wipes their Durable Object state, so a running build stops spending tokens. (`7c83773`)
- **Clerk authentication failures resolved** in the worker auth path. (`dc72e94`, `ea007ca`)
- **Rate-limit check is checked before confirming a summary or saving an answer**, so hitting the cap leaves state unchanged and the call retryable. (`7c83773`)
- **Production fixes** to the model client and deployment config (`worker/gemini.ts`, `wrangler.jsonc`) and UI components. (`85d40c3`, `80360f4`, `fafa6d3`, `f320ad1`, `df5a68d`)

### Internal
- Renamed the product to reSkill across the README, `index.html`, docs, and UI strings. (`7c83773`)
- Added a `code-reviewer` skill and `code-review-report.md`. (`7c83773`)
- Added `docs/mcp-plan.md`; "tool → skills" terminology change. (`70028e2`, `374f0ae`)
- Added D1 migrations `0001`–`0005` (initial schema, run starts, runs-by-project index, idea summary, MCP call log). (`05f5ccf`, `c610604`, `1cea866`)
- Cleared README, added a production branch/env example, and various iteration commits (`t2`, `v23`, `t2t`). (`d5f4840`, `224807f`, `0511764`, `fb11282`, `827154f`)
