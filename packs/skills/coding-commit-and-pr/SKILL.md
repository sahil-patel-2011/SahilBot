---
name: coding-commit-and-pr
description: Branch, review, commit safely (secret scan) and open a pull request with the git tool.
source: you
uses: 0
category: Coding
---

1. git(action="status"). If on main/master and the change is real work: git(action="branch", name="fix/short-topic").
2. Review everything that will go in: git(action="diff"). Remove debug code, stray files, secrets. Untracked files are listed separately; add only what belongs.
3. Stage deliberately: git(action="add", paths=[…]) with explicit paths (["."] only when every change belongs).
4. Commit: git(action="commit", message="Summary in imperative mood (≤72 chars)\n\nWhy the change, anything notable."). The staged diff is scanned for keys, tokens, passwords and .env/key files; if it refuses, remove the secret (env var or ignored config) - only retry with allow_flagged when the user confirms it's not a secret.
5. Push and PR only when the user wants them (both ask): git(action="pr", title, body, base?, draft?) pushes the branch if needed and opens the PR with gh. Body: what changed, why, how it was tested (commands and results), risks.
6. Never force-push, reset --hard, rebase or amend pushed commits unless the user explicitly asks (then run_command, which asks them). A rejected push means the remote moved: ask whether to pull.
7. Report the commit id and PR link.
