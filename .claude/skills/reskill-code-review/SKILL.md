---
name: reskill-code-review
description: Perform targeted code reviews on reSkill diffs or files, verifying D1 tenant scoping, auth isolation, atomic limits, shared worker services, UI mobile compatibility, and TypeScript types. Use when reviewing code, checking diffs, or validating project rules before pull requests.
---

# reSkill code review

Reviews reSkill changes for correctness, security and project conventions, and reports findings grouped by severity with `file:line` references. The rules to check are in `references/project-rules.md`; read it before reviewing.

## Steps

1. **Pick the target.** Use the files, branch or commit range the user gave. With no argument, review `git diff origin/main...HEAD`. If `origin/main` is missing or HEAD is detached, fall back to `git diff main...HEAD`, then `git diff HEAD~1`.
2. **Typecheck.** Run both and record every error as a Critical finding with its file and line:
   - `npx tsc -p tsconfig.app.json --noEmit`
   - `npx tsc -p tsconfig.worker.json --noEmit`
3. **Inspect the changes** against every rule in `references/project-rules.md`. Read the touched files around each hunk, not just the diff. If the diff is too large for context, review file by file in this order: `worker/` endpoints, `worker/db.ts`, `migrations/`, then `src/`.
4. **Group findings** by severity:
   - **Critical:** security, data leakage, broken builds (tsc errors).
   - **High:** logic bugs, unvalidated model output, duplicated worker logic.
   - **Medium:** missing atomic limits, non-additive migrations.
   - **Low:** UI touch hints, comment density, naming and style.
5. **Report.** For each finding give the file path and line, a short description, and for Critical, High and Medium a proposed code fix. Low findings need no fix. Do not edit files or commit.

## Output format

```
## Critical
- worker/foo.ts:42 — <what is wrong and why it matters>
  Fix: <code or change>

## High
...
## Medium
...
## Low
- src/screens/Bar.tsx:10 — <issue>
```

Omit empty severities. If there are no findings, say the typechecks passed and no rule violations were found.

## Out of scope

Auto-committing fixes, end-to-end browser tests, and Cloudflare deployment configuration.
