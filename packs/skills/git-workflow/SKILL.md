---
name: git-workflow
description: Make clean commits, branches and pull requests with git and the GitHub CLI.
source: you
uses: 0
category: Engineering
---

1. `git status` and `git branch --show-current`. Never work directly on main for real changes: `git switch -c <short-topic-branch>`.
2. Stage only what belongs to the change (`git add -p` or explicit paths). Check `git diff --cached` for secrets, .env files, build output and large binaries.
3. Commit with a clear message: a short summary line (imperative mood), a blank line, then why.
4. Push: `git push -u origin <branch>` (this goes outside the Mac, so it needs approval).
5. PR: `gh pr create --fill` or with --title/--body; mention what changed, why, and how it was tested.
6. Never force-push shared branches, rewrite main, or delete branches without the user saying so.
