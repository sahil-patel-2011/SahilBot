---
name: git-workflow
description: Work cleanly in git - small focused commits, clear messages, branches, conflict resolution, rebase vs merge rules, PR hygiene and the secret scan.
source: you
uses: 0
category: Engineering
triggers: commit message, git branch, merge conflict, rebase or merge, cherry-pick, squash commits, force push, git stash, undo last commit, gitignore, branch naming, split into commits, detached head, interactive rebase
---

## When
Branching, committing, resolving conflicts, cleaning history, preparing a PR. For the exact tool sequence to commit and open a PR read coding-commit-and-pr; this skill is the judgment around it.

## Branches
- No real work on main/master: git(action="branch", name="fix/short-topic"), using the repo's prefixes (feat/, fix/, chore/).
- One concern per branch, short-lived, synced with main often so conflicts stay small.
- Uncommitted work before switching: git(action="stash", op="push", message, include_untracked=true), or commit WIP on the branch.

## Commits
1. git(action="status") and git(action="diff"): know every change, including untracked files.
2. One logical change per commit that builds and passes: refactors apart from behavior, formatting apart from logic, dependency bumps apart.
3. Stage explicit paths: git(action="add", paths=[...]). Never stage build output, .env, secrets, large binaries or editor files; gitignore them.
4. Message: imperative subject, 72 chars or fewer, no period ("Fix crash when settings file is empty"); blank line; body says why, alternatives and side effects; reference issues ("Fixes #123"). Follow the repo's convention, e.g. Conventional Commits `feat(sync): ...` (check git(action="log")).
5. The git tool scans each staged diff for keys, tokens, private keys and .env files and refuses on a hit. Remove the secret (env var, ignored config) and rotate it if it was ever pushed. Use allow_flagged only after the user confirms it is not a secret.

## Rebase vs merge
- Rebase only local or private, unpushed branches (to update onto main or tidy commits). Use merge, or the PR's squash, for anything others have pulled.
- Never force-push main or a shared branch. If the user explicitly wants a rewrite of their own branch, `git push --force-with-lease` via run_command (it asks). The git tool deliberately offers no force-push, reset --hard, rebase or amend.
- Undo: unpushed -> `git reset --soft HEAD~1` keeps the changes (run_command, asks); pushed -> `git revert <sha>`.
- Cherry-pick a single fix onto a release branch with `git cherry-pick -x <sha>` so the origin is recorded.

## Conflicts
1. Understand both sides: the conflict markers with surrounding code, `git log --merge -p <file>`.
2. Resolve by intent, not by picking a side: keep both behaviors when both are needed; re-apply your change on top of their refactor.
3. Lockfiles and generated files: take one side, then regenerate.
4. Confirm no markers remain: code(action="search", pattern="^(<<<<<<<|=======|>>>>>>>)"), then typecheck and tests before committing.

## Pull requests
- Small (ideally under 400 changed lines), one concern, current with main, CI green.
- Description: what changed, why, how it was tested (commands and results), risks and rollback, screenshots for UI. Draft PRs for early feedback.
- Push and PR reach GitHub, so they ask; do them only when the user wants.

## Pitfalls
- `git add .` sweeping in junk.
- "wip" and "fix stuff" messages in shared history.
- Resolving conflicts without rerunning tests.
- Deleting a committed secret in a later commit; it stays in history, so rotate it.
