# Coding

## Tools
- `run_command` runs zsh in the workspace, the project folder or an attached folder. Read-only commands run freely; changes run in Auto; installs, pushes and network commands ask; deleting always asks; `sudo` and system commands are refused.
- `file_read` / `file_write` for files; `cursor` to open files in Cursor or hand a repo task to Cursor's agent.

## Working well
1. Look first: `git status`, the README, package.json / pyproject, and the code near what you'll change.
2. Make small changes; run the type checker and tests after each (`npx tsc --noEmit`, `npm test`, `pytest`).
3. Read errors fully; fix the cause. Never claim it works without running it.
4. Follow the project's style. Never commit secrets. Work on a branch; never force-push.
5. Long-running servers: start in the background with a log file (`npm run dev > dev.log 2>&1 &`) and check the log.

## Skills to read
code-review, debug-systematically, git-workflow, new-web-app, python-script, refactor-safely, playwright-testing, api-integration (memory(action="read_skill", name)).
