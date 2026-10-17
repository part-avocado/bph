---
name: release-notes-generator
description: Generate release notes from git commit history and diffs. Use when asked to update CHANGELOG.md, draft release notes, summarize changes between tags, or preview a release summary.
---

# Release Notes Generator

Produce developer-focused release notes (for developers and API consumers) from git history and the code that actually changed, then prepend them to `CHANGELOG.md`.

## 1. Resolve the range

1. If the user gave a range (`v1.2.0..HEAD`, two refs, a commit SHA), use it as-is.
2. Otherwise run `git describe --tags --abbrev=0` and use `<tag>..HEAD`.
3. If there are no tags, use all commits: base = `git rev-list --max-parents=0 HEAD`, range = `<base>..HEAD` (include the base commit itself in the log).
4. Detect preview mode: if the user said "preview", "dry run", or "just show me", do not write any files (see step 6).

## 2. Collect history

- `git log <range> --no-merges --format='%h %an %s%n%b'` for hashes, authors, messages. Skim merge commits separately (`git log --merges`) only to recover PR context.
- `git diff --stat <range>` for the overall shape of the change.

## 3. Read the code, not just the messages

Commit messages are hints, not truth. Inspect the diff of modified source files to determine real impact:

- Exported functions, classes, types, routes, CLI flags, config options, env vars, and MCP tools/endpoints: added, removed, renamed, or signature-changed.
- Behavior changes visible to callers (defaults, return shapes, error handling).
- Anything removed or made stricter is a breaking-change candidate.

If the diff is very large, rely on `git diff --stat` and run targeted `git diff -U3 <range> -- <public API files>` instead of reading everything.

## 4. Categorize

Sort every change into exactly one section:

| Section | Contents |
| --- | --- |
| Breaking Changes | Removed/renamed/changed public APIs, config, or behavior requiring caller action |
| Features | New capabilities or options |
| Fixes | Bug fixes |
| Internal | Refactors, tests, CI, deps, docs, formatting, merge-only commits |

If the range holds only merge commits or formatting changes, put everything under Internal. Omit empty sections.

## 5. Format the entry

Header: `## [<tag_or_version>] - YYYY-MM-DD` using today's UTC date. If untagged, use `## [Unreleased] - YYYY-MM-DD`. Do not bump versions or create tags.

Body, in this order (omit empty sections):

```markdown
> [!WARNING] Breaking Changes
> - **`oldName()` removed** — use `newName(options)` instead. Migration: replace calls and pass `{ ... }`. (abc1234)

### Features
- Short, impact-first description of the new API/option (`abc1234`)

### Fixes
- What was wrong and what callers now get (`abc1234`)

### Internal
- Refactors, tooling, tests (`abc1234`)
```

Rules: write for API consumers (say what changed for callers, name the symbols), deduce migration steps from the actual code diff, reference short hashes, and don't just echo commit subjects.

## 6. Write or preview

- **Preview/dry run:** print the entry to stdout only. Do not create or modify `CHANGELOG.md`, even if it doesn't exist.
- **Otherwise:** read `CHANGELOG.md` at the repo root.
  - Exists: insert the entry directly below the `# Changelog` title line and above the first existing `## ` release heading, with two blank lines separating it from the following release. Never overwrite or reorder existing entries.
  - Missing: create it as `# Changelog`, two blank lines, then the entry.

## Out of scope

Do not create GitHub/GitLab releases, bump versions, create tags, or run `git commit` / `git push`. After writing, tell the user which range was used and the file changed.
