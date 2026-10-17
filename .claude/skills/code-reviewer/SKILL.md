---
name: code-reviewer
description: Performs a targeted code review on git diffs, branches, or files for medium and high severity bugs, security issues, and edge cases, writing a markdown report to the repo root. Use when asked to review code, check diffs, or audit changes.
---

# Code Reviewer

Review code changes or specified files for correctness bugs, security risks, unhandled edge cases, readability flaws, and maintainability issues. Report only **High** and **Medium** severity findings. Write the report to `code-review-report.md` at the repository root. Never modify the reviewed code.

## 1. Choose the scope

If the user's request names files or a diff target, use that. Otherwise ask exactly:

> Select review scope: (1) Staged changes [git diff --cached], (2) Branch diff [git diff main...HEAD], (3) Specific files

Never guess a default scope.

- Scopes 1 and 2 need a git repository. If not in one, print `Git repository required for diff review.` and stop.
- Scope 3: if a path does not exist, print `Target path does not exist: <path>` and ask for another path.

## 2. Retrieve the code

- Staged: `git diff --cached`
- Branch: `git diff main...HEAD`
- Files: read the given paths directly (UTF-8; ignore invalid byte sequences, and review whatever parses).

Skip these, never analyze them:
- Binary files (list their paths in the report's Summary section)
- Deleted files
- Lockfiles and generated lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, etc.)
- Minified files (`*.min.js`, `*.min.css`, or files with extremely long lines)

If nothing remains in scope, print `No changes found in specified scope.` and stop. Do **not** create or overwrite `code-review-report.md`.

## 3. Handle large scopes

If the diff exceeds 500 lines or 10 files, split it into per-file units and analyze them one at a time. If a single file exceeds 1000 diff lines, analyze only its first 1000 lines and add a truncation note under the report title (e.g. `> Note: <file> truncated to first 1000 diff lines.`).

## 4. Analyze

Look for correctness bugs, security vulnerabilities, unhandled edge cases (null/empty input, bounds, errors, concurrency), and readability or maintainability problems that carry real risk.

**Exclude** low severity findings, cosmetic nitpicks, styling opinions, and linter-type suggestions. Keep only High and Medium. Each finding needs a file path and line number or range.

## 5. Write the report

Write `code-review-report.md` at the repo root, completely overwriting any existing file (never append).

With findings:

```markdown
# Code Review Report

## Summary
| Severity | Count |
| High | <high_count> |
| Medium | <medium_count> |
| Total | <total_count> |

## Detailed Findings
### [<Severity>] <Short Issue Title>
- File: <file_path>:<line_number_or_range>
- Category: <Correctness|Security|Edge Case|Readability|Maintainability>
- Description: <Issue description>
- Suggested Fix: <Short fix text>
```

Order findings High first. Suggested fixes are short text descriptions, not code patches. If binary files were skipped, list their paths in the Summary section.

With no High or Medium findings:

```markdown
# Code Review Report

No actionable High or Medium severity issues were detected.
```

## 6. Print the summary

Print exactly one line:

`Code review complete. Found <high_count> High severity and <medium_count> Medium severity findings. Report saved to code-review-report.md.`

## Out of scope

- Applying fixes or editing reviewed files
- Reporting low severity issues or style nits
- Posting to GitHub/GitLab (PR or MR comments)
