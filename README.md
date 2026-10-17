# reSkill

Turns an idea into a finished build prompt for a Claude Code / Codex skill.

## Connect an agent (MCP)

Agents can drive the whole flow over MCP. Clerk is the OAuth server, so the agent signs the user in through a normal consent screen and acts only on that user's skills.

```sh
claude mcp add --transport http reskill https://<your-host>/mcp
```

Tools: `list_skills`, `create_skill`, `get_skill`, `review_summary`, `answer_question`, `start_build`, `get_build`. The flow is create, confirm the summary, answer the questions, start the build, then poll `get_build` for the prompt.

### One-time Clerk setup

1. Clerk Dashboard, OAuth applications, Settings: turn on **Publish CIMD support**, and **Publish DCR support** for clients that lack CIMD.
2. Set default scopes for dynamic clients to `profile email`.
3. Set `CLERK_PUBLISHABLE_KEY` on the Worker (`wrangler secret put CLERK_PUBLISHABLE_KEY`, or `.dev.vars` locally). It is the same `pk_` key as `VITE_CLERK_PUBLISHABLE_KEY`.
4. Apply the new migration: `npm run db:migrate:remote`.

Limits per user per 24 hours: 200 model-backed MCP calls, 30 new skills, plus the existing daily run limit.
