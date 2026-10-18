# reSkill

Turns an idea into a finished build prompt for a Claude Code / Codex skill.

## Connect an agent (MCP)

Agents can drive the whole flow over MCP. Clerk is the OAuth server, so the agent signs the user in through a normal consent screen and acts only on that user's skills.

```sh
claude mcp add --transport http reskill https://<your-host>/mcp
```

Tools: `list_skills`, `create_skill`, `get_skill`, `review_summary`, `answer_question`, `start_build`, `get_build`. The flow is create, confirm the summary, answer the questions, start the build, then poll `get_build` for the prompt.

To save round trips, `get_skill` takes `batch` (up to 5) to return several open questions, and `answer_question` takes `answers` to record them in one call (one model call for the batch).

**Dangerous mode:** `create_skill` with `dangerous: true` is for hands-off runs. The agent answers the intake questions itself and keeps calling `start_build` with `improve=true` (up to 3 times) until the score target is met, never asking the user. Only use it when the user explicitly asks; the answers are the agent's guesses, not the user's decisions.

### One-time Clerk setup

1. Clerk Dashboard, OAuth applications, Settings: turn on **Publish CIMD support**, and **Publish DCR support** for clients that lack CIMD.
2. Set default scopes for dynamic clients to `profile email`.
3. Set `CLERK_PUBLISHABLE_KEY` on the Worker (`wrangler secret put CLERK_PUBLISHABLE_KEY`, or `.dev.vars` locally). It is the same `pk_` key as `VITE_CLERK_PUBLISHABLE_KEY`.
4. Apply the new migrations (including `0006_autonomous.sql`): `npm run db:migrate:remote`.

Limits per user: 10 new skills per 24 hours, and per 7 days 100 planning steps (model-backed calls), 20 builds (`WEEKLY_RUN_LIMIT` in `wrangler.jsonc`) and 50,000 model tokens (`WEEKLY_TOKEN_LIMIT`, counted in `token_usage`). Every limit message tells the user to email hi@partavocado.cc for an increase.
