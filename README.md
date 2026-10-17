# Offshoot

Describe a tool in one sentence. Offshoot asks the few questions that matter, then an orchestrator sends parallel reviewers over the brief, merges what survives, and scores it until it hits the target. You get one prompt that Claude Code can build from without asking anything.

**Describe → Intake → Construction → Ready**

## Stack

- **Cloudflare Workers.** One Worker serves the React app (static assets) and the Hono API under `/api`.
- **Durable Objects.** Each run is a `RunObject` that drives the orchestrator loop on alarms and streams state to the browser over a hibernating WebSocket. A run keeps going if you close the tab.
- **D1** stores users, projects, questions, runs and every prompt version. **R2** stores attachments.
- **Gemini** (`gemini-3.6-flash`) through its REST API. Structured output drives questions, critic branches and judge scores. Function calling drives the orchestrator. Streaming gives the live progress bars.
- **Clerk** handles sign-in, user management and session tokens. A webhook keeps D1 in sync and deletes a user's data when their account is deleted.
- **React 19, Tailwind v4, Motion** for the UI.

## How a run works

1. **Drafter** writes draft v1 from the brief: the idea, an attachment digest and the answers.
2. **Judge** scores it out of 100 against a rubric and lists the gaps.
3. Each round:
   - The **orchestrator** calls `spawn_reviewer` 2–4 times, choosing lenses that close the judge's gaps (edge cases, security, interface and others).
   - **Critics** review in parallel, each on its own branch.
   - The **refiner** merges what survives into the next draft, and the judge scores it again.
4. The run stops when the score reaches the target (95, or higher for "Improve again"), the round limit is hit, or the token budget runs out.

While a run is going you can pause, resume, add or remove rounds, and steer it. Steering notes override the reviewers.

## Setup

You need Node 22+, a Cloudflare account, a [Clerk](https://clerk.com) application and a [Google AI Studio](https://aistudio.google.com) API key.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
cp .env.example .env
```

Fill in the values:

| File | Key | Where it comes from |
|---|---|---|
| `.dev.vars` | `GEMINI_API_KEY` | Google AI Studio |
| `.dev.vars` | `CLERK_SECRET_KEY` | Clerk dashboard → API keys |
| `.dev.vars` | `CLERK_WEBHOOK_SIGNING_SECRET` | Clerk dashboard → Webhooks (only needed to test webhooks) |
| `.env` | `VITE_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API keys |

Create the local database and start the app:

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

The app runs at http://localhost:5173. The Worker, Durable Objects, D1 and R2 all run locally through the Cloudflare Vite plugin.

## Deploy

Create the resources:

```bash
npx wrangler d1 create offshoot
```

```bash
npx wrangler r2 bucket create offshoot-uploads
```

Put the `database_id` from the D1 output into `wrangler.jsonc`. Then set `AUTHORIZED_PARTIES` in `wrangler.jsonc` to your production origin, for example `https://offshoot.example.com`. It's comma-separated, so you can keep localhost too.

Add the secrets and migrate:

```bash
npx wrangler secret put GEMINI_API_KEY
```

```bash
npx wrangler secret put CLERK_SECRET_KEY
```

```bash
npx wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET
```

```bash
npm run db:migrate:remote
```

Vite bakes the publishable key in at build time, and `vite build` reads `.env.production` over `.env`. Copy the example and fill in your Clerk **production** key (`pk_live_...`):

```bash
cp .env.production.example .env.production
```

Use the production instance's `CLERK_SECRET_KEY` (`sk_live_...`) and its own webhook signing secret for the `wrangler secret put` commands above, then deploy:

```bash
npm run deploy
```

In Clerk, add a webhook endpoint at `https://<your-domain>/api/webhooks/clerk` for `user.created`, `user.updated` and `user.deleted`.

### Optional: AI Gateway

To get logs, caching and rate limits for Gemini calls, create an AI Gateway. Then set `GEMINI_BASE_URL` in `wrangler.jsonc` to `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/google-ai-studio`.

## Configuration

These vars live in `wrangler.jsonc`:

| Var | Default | Meaning |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` | Model used by every agent |
| `GEMINI_BASE_URL` | Google API | Swap in an AI Gateway URL |
| `AUTHORIZED_PARTIES` | `http://localhost:5173` | Origins allowed to present Clerk session tokens |
| `DAILY_RUN_LIMIT` | `20` | Runs per user per rolling 24 hours |
| `RUN_TOKEN_BUDGET` | `400000` | Hard token cap per run |

## Keyboard

| Screen | Keys |
|---|---|
| Describe | `↵` start, `⇧↵` new line, paste or drop files and folders |
| Intake | `↑` `↓` move, `space` select, `1`–`4` pick, type to answer in your own words, `↵` continue, `←` back |
| Construction | `↵` steer, `esc` pause or resume, `+` `−` rounds, `1` full log, `D` draft |
| Ready | `⌘↵` / `C` copy, `I` improve again, `N` new tool |

## Layout

```
worker/          Hono API, Clerk auth, Gemini client, intake planner
worker/run.ts    RunObject Durable Object (orchestrator, critics, refiner, judge)
worker/agents/   System prompts, lenses and JSON schemas
shared/          Types shared by the Worker and the browser
src/screens/     Describe, Intake, Construction, Ready, History
migrations/      D1 schema
```
