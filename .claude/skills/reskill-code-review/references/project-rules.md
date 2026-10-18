# reSkill project rules

## Layout
- Frontend: React + Vite + Tailwind in `src/` (screens in `src/screens`, shared UI in `src/components/ui.tsx`).
- Backend: Cloudflare Worker in `worker/` using Hono, D1 (migrations in `migrations/`), a Durable Object for build runs (`worker/run.ts`), Gemini calls (`worker/gemini.ts`, prompts in `worker/agents/prompts.ts`).
- Auth: Clerk session tokens for `/api`; Clerk OAuth tokens for `/mcp` (`worker/mcp.ts`, `worker/mcp-auth.ts`).
- Shared types: `shared/types.ts`. Shared route and tool logic: `worker/service.ts`.

## Rules to check

1. **Tenant scoping.** Every D1 query touching projects, questions, versions or runs is scoped by `user_id` (directly or through a project the user owns). Flag any query keyed only by an id that came from the client.
2. **Auth isolation.** `/api` rejects OAuth tokens and `/mcp` accepts only OAuth tokens. The user id comes from the verified token only, and no tool or route takes a user id as an argument.
3. **Atomic limits.** `MODEL_CALL_LIMIT`, `PROJECT_LIMIT` and the daily run limit are enforced in the same statement that counts, so parallel calls cannot overshoot. Flag read-then-write checks.
4. **Migrations.** New files in `migrations/` are additive (new tables or columns with defaults, never destructive). Row interfaces in `worker/db.ts` and any hand-built rows (for example in `worker/index.ts`) match the schema.
5. **Shared logic.** Web handlers and MCP tools call `worker/service.ts` for domain logic instead of duplicating it, so limits and ownership checks behave the same on both surfaces.
6. **Model output.** Gemini JSON is parsed and shape-checked before use (types, lengths, dedupe, caps). Never trust structured output blindly. Prompt or schema changes stay consistent with each other.
7. **Touch compatibility.** Key hints are hidden on touch screens, so a `Button` that has a `kbd` hint also needs an `icon` prop.
8. **Style.** Match the surrounding code: comment density, naming and idiom. Comments explain why, not what.
