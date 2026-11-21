# Controlling coding agents

You can write code yourself or hand it to another coding agent and supervise the result. Either way you
own the outcome: nothing is "done" until a diff has been read and the checks have passed.

## Do it yourself, or hand it off?
- **Yourself** (code, git, run_command, jobs; docs/coding.md): small or medium changes, debugging where you
  need to look around, anything in a folder the user attached to this chat, and anything where the user is
  watching and wants to steer.
- **Cursor, on this Mac** (cursor agent): a well-scoped change in a local project that Cursor's agent is
  good at, while you keep supervising. Needs Cursor's `cursor-agent` installed and "Also run Cursor's agent
  through its CLI on this Mac" switched on (Settings → Connected apps → Cursor).
- **Cursor cloud agents** (cursor cloud_launch): work on a GitHub repo that should end as a branch and pull
  request, or several independent tasks at once. Needs the user's Cursor API key (Settings → Connected
  apps → Cursor). Launching, follow-ups and stopping always ask the user.
- **Several parts at once inside SahilBot**: max(strategy="team") with one self-contained task per helper,
  or max(strategy="heavy") for one hard problem (independent attempts plus a judge).
- **Other coding CLIs on the Mac** (for example `codex exec` or `claude -p`): run_command can run them like
  any command (background: true plus jobs for long runs). Treat their output exactly like Cursor's: read the
  diff, run the tests. (Running SahilBot itself on the user's ChatGPT plan through Codex is a model choice,
  not a hand-off: docs/chatgpt-plan.md.)

## Write the brief
The other agent sees none of this chat. Read the skill cursor-task-brief first. A good brief has:
- one goal, stated as the result ("the export button saves a CSV with these columns"), not the steps;
- repo facts: language, framework, the test/typecheck/build commands (get them from code project);
- the files and functions involved (from code search / symbols), and current error output, verbatim;
- constraints: minimal diff, no new dependencies, a don't-change list, never commit or push (local runs);
- acceptance criteria as a checklist, and the exact commands that prove them;
- definition of done.
cursor prompt(goal, context, files, errors, constraints, dont_change, acceptance, tests) drafts it and lists
what's missing (vague goal, several tasks in one, no acceptance criteria, no verify commands). agent and
cloud_launch take the same fields and build the brief themselves.

## Run and supervise
- cursor agent(folder, goal…) takes a restore point first (git stash create), shows live progress, and
  returns Cursor's summary, the exact diff, new files, commands it ran, a secret scan and the
  type-check/test results. resume: true continues its last chat in that folder for fixes.
- Cloud: cloud_launch(repo, goal…, ref?) → cloud_wait(id) (bounded; check later with cloud_status or a
  schedule) → cloud_review(id): the result, the PR, its checks and its diff (needs the GitHub CLI, gh).
  cloud_followup(id, …) sends corrections; cloud_stop(id) stops it.
- Every finished run ends with an automatic review against the brief: scope, protected paths, removed or
  skipped tests, suppressed checks, debug output, TODOs, dependency changes, size, check results and the
  acceptance checklist, with a ready follow-up. Work through it before you report.

## Review like a senior engineer
1. Read the whole diff (git diff, or the diff the run returned). Does it do the goal and nothing else?
2. Run the checks yourself: code typecheck, code run_tests (narrow first, then the suite), code lint.
3. Look for the usual shortcuts: tests deleted or skipped, assertions loosened, errors swallowed, ts-ignore /
   eslint-disable added, hard-coded values that only pass the test, new dependencies.
4. Anything wrong: send a precise follow-up (resume: true, or cloud_followup) with the failing output and
   the exact change wanted. Two failed rounds: do it yourself or ask the user.
5. Report: what changed (files), the commands you ran and their results, and anything unverified. Commit
   and push only when the user asked (git commit; git push and git pr ask in Auto).

## Your own coding loop (the same standard)
code project → search, symbols, read → reproduce (a failing test) → todo plan → minimal edits (code edit /
apply_patch) → typecheck and run_tests → git diff → commit when asked. The runtime runs the project's tests
before accepting "done" after a code change and sends failures back to you. Skills: coding-agent-loop,
plan-a-code-change, debug-systematically, coding-fix-failing-tests, code-review, coding-commit-and-pr,
coding-cursor-orchestration, cursor-coding-handoff, long-task-working-notes.

## Undo
- code edit and file_write keep a backup of what they changed. git checkout or git stash put files back.
- A local Cursor run's result names its restore point and the git command that goes back to it. Running it
  asks the user; don't apply it over newer work without saying so.
- Never offered: force-push, reset --hard, rebase, amend. If the user explicitly asks, run_command runs it and
  asks first.
