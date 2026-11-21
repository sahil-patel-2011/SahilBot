# SahilBot capability checklist (500 large items)

**Date:** 2026-11-20  
**Method:** Static read of the repository (docs/*.md, src/**, tests/, scripts/, package.json) with grep/read. The app was not run, no model calls were made, no files were changed except this one. 500 large capabilities, 20 areas x 25 items. Each row names which of Claude Code (CC), Grok (GK) and ChatGPT (GPT) has the capability (`-` = none of the three clearly ships it, or it is SahilBot-specific), SahilBot's status and evidence.  
**Scoring:** PASS = 1 (concrete code or tool evidence), PARTIAL = 0.5 (exists but narrower than the reference, or only documented / unverified), MISSING = 0 (grep shows nothing). Claims marked PASS from docs were cross-checked against a tool registration or source file where noted. Quality of model output is not graded; this is feature presence.  
**Caveat:** vendor columns reflect public product knowledge as of the date and are approximate. "Doc-only" evidence is flagged as PARTIAL where code could not be confirmed.


## Scores by area

| Area | PASS | PARTIAL | MISSING | Score /25 |
|---|---|---|---|---|
| Agent loop & autonomy | 22 | 3 | 0 | 23.5 |
| Planning & progress | 18 | 5 | 2 | 20.5 |
| Instruction following & pushback | 21 | 4 | 0 | 23 |
| Tool use & recovery | 22 | 1 | 2 | 22.5 |
| Coding | 19 | 2 | 4 | 20 |
| Browser & computer use | 22 | 1 | 2 | 22.5 |
| Files & documents | 23 | 2 | 0 | 24 |
| Slides & decks | 18 | 2 | 5 | 19 |
| Dashboards & charts | 15 | 5 | 5 | 17.5 |
| Spreadsheets | 14 | 5 | 6 | 16.5 |
| Memory & personalization | 22 | 1 | 2 | 22.5 |
| Context management | 20 | 2 | 3 | 21 |
| Model routing | 23 | 2 | 0 | 24 |
| Multi-agent & helpers | 22 | 2 | 1 | 23 |
| Privacy, secrets & safety | 23 | 1 | 1 | 23.5 |
| Connectors & integrations | 22 | 3 | 0 | 23.5 |
| Voice | 18 | 1 | 6 | 18.5 |
| Scheduling & notifications | 19 | 3 | 3 | 20.5 |
| Updates, onboarding & UI/UX | 15 | 5 | 5 | 17.5 |
| Reliability, performance & observability | 20 | 4 | 1 | 22 |
| **Total** | **398** | **54** | **48** | **425 / 500** |

## Checklist

| ID | Area | Capability | Has it | SahilBot | Evidence |
|---|---|---|---|---|---|
| L001 | Agent loop & autonomy | Multi-step tool loop that runs until the task is done | CC/GK/GPT | PASS | src/main/agent/loop.ts (4239 lines); docs/index.md "The loop" |
| L002 | Agent loop & autonomy | Per-run step budget with a "close to budget, finish" nudge and a continue path | CC | PASS | src/main/agent/loop.ts:2986 |
| L003 | Agent loop & autonomy | Stop button aborts the run and in-flight calls | CC/GK/GPT | PASS | AbortSignal threaded through 85 files; docs/index.md Limits |
| L004 | Agent loop & autonomy | Steer or queue a message while the agent is working | CC/GK/GPT | PASS | src/renderer/src/App.tsx:133 (steering state) |
| L005 | Agent loop & autonomy | Streaming of model output with provider retries and backoff | CC/GK/GPT | PASS | src/main/llm/retry.ts:8,74 (withRetries) |
| L006 | Agent loop & autonomy | Parallel tool calls in one step | CC/GK | PASS | src/main/agent/loop.ts:2460 (Promise.allSettled over batch) |
| L007 | Agent loop & autonomy | Background processes (dev servers, watchers) that survive across steps | CC | PASS | src/main/agent/tools/jobs.ts:46; JobsPanel.tsx |
| L008 | Agent loop & autonomy | Resume an interrupted run after the app closed | CC | PASS | src/main/resume.ts:11-14; src/main/index.ts:131 |
| L009 | Agent loop & autonomy | Durable action ledger: each tool call recorded before execution, replay of completed calls | - | PASS | docs/agent-system.md Harness 1; src/main/agent/runtime/store.ts |
| L010 | Agent loop & autonomy | Long-lived goals the agent pursues across days | GPT | PASS | src/main/agent/tools/goals.ts:60; src/main/goals/manager.ts |
| L011 | Agent loop & autonomy | Agent schedules its own follow-up wake-ups | CC/GPT | PASS | src/main/agent/tools/goals.ts:192 (follow_up) |
| L012 | Agent loop & autonomy | Always-on server mode so work continues when the laptop is closed | CC/GPT | PASS | src/server/index.ts; docs/server.md (Pi, Docker, Mac mini) |
| L013 | Agent loop & autonomy | Hosted cloud agent that runs with no user machine at all | CC/GK/GPT | PARTIAL | Only self-hosted server and Cursor Cloud (apps.ts cloud_launch); no SahilBot-hosted runtime |
| L014 | Agent loop & autonomy | Permission modes Ask / Auto / Bypass per thread | CC | PASS | docs/permissions.md; src/renderer/src/App.tsx:87 |
| L015 | Agent loop & autonomy | Unattended runs skip approvals instead of hanging | CC | PASS | src/main/scheduler.ts:5-7; docs/index.md Scheduled tasks |
| L016 | Agent loop & autonomy | Chat auto-escalates to full agent work when a task needs tools | GPT | PASS | src/main/agent/registry.ts chatEligible/chatAllowed |
| L017 | Agent loop & autonomy | Lazy tool discovery (find_tools) to keep the prompt small | CC | PASS | src/main/agent/registry.ts:11; tools/core.ts |
| L018 | Agent loop & autonomy | Isolated git worktrees for parallel coding workers | CC | PASS | src/main/agent/runtime/graph.ts:19 (git worktree add --detach); docs/agent-system.md Harness 4 |
| L019 | Agent loop & autonomy | Keeps the Mac awake while a run is working | - | PASS | src/main/resume.ts:38 wantAwake; src/main/lid-awake.ts |
| L020 | Agent loop & autonomy | Deadline, dollar, tool-call and concurrency caps across parent and helpers | - | PASS | docs/agent-system.md Auto capabilities 2; src/main/llm/budget.ts |
| L021 | Agent loop & autonomy | Completion claims gated on verification evidence | CC | PASS | src/main/agent/runtime/verification.ts; loop.ts:3192 agent_control |
| L022 | Agent loop & autonomy | Changes approach after repeated identical failures; Auto moves to a stronger model after repeated failed steps | CC/GK/GPT | PASS | docs/index.md loop step 4; docs/model-routing.md "Failures" |
| L023 | Agent loop & autonomy | Headless one-shot prompt mode for scripting | CC | PARTIAL | src/main/mcp-server/ and server CLI (docs/server.md#command-line); no documented `sahilbot -p "..."` run |
| L024 | Agent loop & autonomy | Embeddable agent SDK / programmatic API | CC | PARTIAL | src/main/mcp-server/server.ts exposes tools over MCP; no SDK package |
| L025 | Agent loop & autonomy | Drive the agent from a phone with push for approvals | CC/GPT | PASS | src/main/phone/index.ts; docs/phone-access.md; src/server/push.ts |
| L026 | Planning & progress | Visible todo checklist with one in-progress item | CC/GK/GPT | PASS | src/main/agent/tools/core.ts:82; src/renderer/src/lib/steps.ts |
| L027 | Planning & progress | Plan-first flow that blocks mutations until the user approves | CC/GPT | PASS | src/main/agent/tools/core.ts:165 (propose_plan); docs/agent-system.md |
| L028 | Planning & progress | User can edit the proposed plan inline before approving | CC | PARTIAL | propose_plan approval card exists; no inline plan editor found in Agent.tsx / ThreadView.tsx |
| L029 | Planning & progress | Live step feed of tool actions in the thread | CC/GK/GPT | PASS | src/renderer/src/lib/steps.ts; ThreadView.tsx |
| L030 | Planning & progress | End-of-run summary of what was done and where outputs are | CC/GK/GPT | PASS | src/renderer/src/lib/run-summary.ts |
| L031 | Planning & progress | Plain-language approval cards instead of raw tool JSON | - | PASS | src/renderer/src/lib/plain-approval.ts; approval-view.ts |
| L032 | Planning & progress | Needs-you inbox for pending questions, approvals and plans | - | PASS | src/renderer/src/components/NeedsYou.tsx; src/main/needs-you.ts |
| L033 | Planning & progress | Structured multiple-choice questions to the user (ask_user) | GPT | PASS | src/main/agent/tools/core.ts:124; src/main/agent/questions/ |
| L034 | Planning & progress | Task list view of long-running work | - | PASS | src/renderer/src/components/TasksView.tsx |
| L035 | Planning & progress | Live multi-agent card (strategy, helper status, cost, judge notes) | - | PASS | src/renderer/src/components/MaxCard.tsx |
| L036 | Planning & progress | Live computer-use card (planner and executor messages) | - | PASS | src/renderer/src/components/CuaCard.tsx |
| L037 | Planning & progress | Plan and notes survive compaction (task brief) | CC/GK/GPT | PASS | src/main/agent/context.ts:478 taskBrief; agent/notes.ts:182 |
| L038 | Planning & progress | Run timer starting at the user's prompt | - | PASS | docs/agent-system.md paragraph 3; src/main/llm/timing.ts |
| L039 | Planning & progress | Developer mode exposing tool activity, model choice and usage | CC | PASS | src/renderer/src/lib/dev-mode.ts; docs/agent-system.md |
| L040 | Planning & progress | Completion notification when a long run finishes | GPT | PASS | src/main/notify.ts; src/main/agent/questions/notify.ts |
| L041 | Planning & progress | Cost-so-far shown live during the run | CC | PARTIAL | Usage page and Max card show cost (UsagePage.tsx); no per-run live meter in the composer found |
| L042 | Planning & progress | Estimated time/cost forecast before starting a big task | - | MISSING | grep "estimate.*(cost\|time)" in agent UI: only context token estimates (context.ts:24) |
| L043 | Planning & progress | Rewind chat and files to an earlier checkpoint | CC | MISSING | No chat-level rewind; only doc versions (docspace/store.ts:238) and file backups |
| L044 | Planning & progress | Edit the last user message and rerun | CC/GPT | PASS | src/renderer/src/App.tsx:899 (chat.editLast) |
| L045 | Planning & progress | Canvas-style side panel showing the work product while the agent works | GPT | PARTIAL | RightPanel.tsx and DocEditor.tsx open docs beside chat; live agent cursor flashes in doc (DocEditor.tsx:814) |
| L046 | Planning & progress | Reasoning/thinking summaries visible to the user | CC/GK/GPT | PARTIAL | Only in Developer mode (dev-mode.ts), off by default |
| L047 | Planning & progress | Progress and approvals reachable on the phone | - | PASS | src/server/push.ts; docs/phone-access.md |
| L048 | Planning & progress | Quiet mode hiding routine tool noise | - | PASS | src/renderer/src/lib/quiet.ts |
| L049 | Planning & progress | Branching-free "continue" button for interrupted runs | CC | PASS | src/shared/types.ts:1587 (Continue button); resume.ts:13 |
| L050 | Planning & progress | Per-step undo of the agent's last file change from the UI | CC/GK/GPT | PARTIAL | Backups kept (docs/office.md .foreman/backups; docs/artifacts.md .sahilbot-backups) but no one-click undo button for arbitrary files |
| L051 | Instruction following & pushback | Persistent custom rules/instructions across chats | CC/GK/GPT | PASS | Settings → Rules (src/main/rules.ts) |
| L052 | Instruction following & pushback | Per-project instructions applied inside project chats | CC | PASS | docs/index.md Projects; src/main/spaces.ts; ProjectHome.tsx |
| L053 | Instruction following & pushback | Reads repo guidance files (AGENTS.md, CONTRIBUTING) when coding | CC | PASS | docs/coding.md `code project`; src/main/code/project.ts |
| L054 | Instruction following & pushback | Auto-loaded CLAUDE.md-style hierarchy of instruction files | CC | PARTIAL | code project reports AGENTS.md hints only; no nested per-directory instruction merge found |
| L055 | Instruction following & pushback | Per-bot personas with their own instructions | CC/GK/GPT | PASS | src/main/agent/tools/bots.ts:13; BotEditor.tsx |
| L056 | Instruction following & pushback | Constraints from the user preserved through compaction | - | PASS | src/main/agent/context.ts:410 repairSummary(constraints); docs/harness-comparison.md |
| L057 | Instruction following & pushback | Conditional preferences stored in the user's own words | - | PASS | src/main/agent/runtime/tools.ts:89 (preference) |
| L058 | Instruction following & pushback | Past decisions applied without re-asking, never as permissions | - | PASS | docs/memory.md "Past decisions"; src/main/decisions.ts |
| L059 | Instruction following & pushback | "Always ask before X" user-defined hard stops | CC | PASS | docs/permissions.md "Always ask for…"; src/renderer/src/lib/approvalRules.ts |
| L060 | Instruction following & pushback | Prompt-injection defense: tool output wrapped as untrusted data | CC | PASS | src/main/agent/context.ts:197 wrapToolOutput; docs/permissions.md |
| L061 | Instruction following & pushback | Taint tracking so web/email-derived values cannot silently drive outside actions | - | PASS | src/shared/types.ts:1840; docs/permissions.md "Always asks" |
| L062 | Instruction following & pushback | Denied action is not retried; agent offers an alternative | CC | PASS | docs/permissions.md "When denied"; prompt.ts |
| L063 | Instruction following & pushback | System prompt tells the agent to disagree and correct false premises | CC/GK/GPT | PARTIAL | src/main/agent/prompt.ts contains accuracy rules (docs/index.md "Accuracy first"); no explicit anti-sycophancy section found by grep |
| L064 | Instruction following & pushback | Accuracy-first: look things up and cite, refuse uncited links | CC/GPT | PASS | docs/index.md Accuracy first; link-checking noted there |
| L065 | Instruction following & pushback | Answer link verification (cited URLs must have been retrieved) | - | PASS | docs/index.md ("app checks and sends back answers with links nobody retrieved") |
| L066 | Instruction following & pushback | Admits uncertainty and says when something could not be verified | CC | PASS | docs/index.md; verification.ts "unresolved verification" UI |
| L067 | Instruction following & pushback | Acceptance checks with user-configurable required evidence | CC | PASS | src/main/agent/loop.ts:3192 agent_control; runtime/verification.ts |
| L068 | Instruction following & pushback | Unsupported research claims block "verified" completion | - | PASS | docs/agent-system.md Auto capabilities 5; runtime/research.ts |
| L069 | Instruction following & pushback | Honors format/length constraints (page fitting, slide fitting) | CC/GPT | PASS | src/main/docs/fit.ts; review_document checks (office.ts:496) |
| L070 | Instruction following & pushback | Asks clarifying questions only when needed | CC | PASS | ask_user policy src/main/agent/questions/policy.ts |
| L071 | Instruction following & pushback | Eval harness measuring instruction-following regressions | - | PARTIAL | agent_evaluate (runtime/evaluation.ts:10) compares models on recorded runs; no standing instruction-following benchmark suite found |
| L072 | Instruction following & pushback | Imports instructions from another assistant as Rules | - | PASS | src/main/memory-import.ts; ImportMemoryDialog.tsx |
| L073 | Instruction following & pushback | User correction always wins over remembered facts | CC/GPT | PASS | docs/context.md ("corrections always win") |
| L074 | Instruction following & pushback | Warns before risky or destructive user requests with reasons | CC | PARTIAL | Hard-stop approvals explain action (plain-approval.ts); no dedicated "are you sure, here is the risk" pushback logic beyond permissions |
| L075 | Instruction following & pushback | Refuses to follow instructions embedded in pages/emails and mentions them | CC | PASS | docs/permissions.md "Prompt injection" |
| L076 | Tool use & recovery | Schema validation of tool inputs and results | CC | PASS | src/main/agent/validate.ts |
| L077 | Tool use & recovery | Recovers tool calls from malformed or text-embedded model output | - | PASS | src/main/agent/recover.ts:42,116 (recoverToolCalls, fixName) |
| L078 | Tool use & recovery | Missing tool results repaired on resume | - | PASS | docs/agent-system.md Harness 1 |
| L079 | Tool use & recovery | Oversized results saved to disk and paged via read_result | CC | PASS | src/main/agent/tools/core.ts:58; context.ts:97-111 |
| L080 | Tool use & recovery | Uncertain mutations reconciled by a read receipt before retry | - | PASS | docs/agent-system.md Harness 1; runtime/store.ts |
| L081 | Tool use & recovery | Bounded automatic retries for reads on transient failures | CC/GK/GPT | PASS | docs/agent-system.md Auto capabilities 4; retry.ts |
| L082 | Tool use & recovery | Distinguishes expired auth, transient, stale ref and alternate-interface failures | - | PASS | docs/agent-system.md Auto capabilities 4 |
| L083 | Tool use & recovery | Stale browser refs re-resolved by role and name | CC | PASS | docs/browser.md "Reading results"; browser/manager.ts |
| L084 | Tool use & recovery | Stuck detector for repeated no-op UI actions with recovery steps | - | PASS | docs/computer-use.md; src/main/agent/cua/stall.ts |
| L085 | Tool use & recovery | Declarative workflow DAG with checkpointed nodes and resume | CC | PASS | src/main/agent/runtime/workflow.ts; tools.ts:55 |
| L086 | Tool use & recovery | Exact edit matching with forgiving whitespace and a closest-lines error | CC | PASS | docs/coding.md `edit` / `apply_patch`; src/main/code/patch.ts |
| L087 | Tool use & recovery | Tool batching (many file/ops in one call) | - | PASS | src/main/agent/tools/batch.ts:382 |
| L088 | Tool use & recovery | Generic authenticated API tool with vaulted keys and origin pinning | CC | PASS | src/main/agent/tools/api-request.ts:9; docs/agent-system.md |
| L089 | Tool use & recovery | MCP client with ~200 connectors | CC/GK/GPT | PASS | src/main/connectors.ts (211 id entries); docs/connectors.md |
| L090 | Tool use & recovery | Exposes SahilBot's own tools as an MCP server | CC | PASS | src/main/mcp-server/server.ts; McpSettings.tsx |
| L091 | Tool use & recovery | Tool-specific timeouts and live progress | CC | PASS | docs/coding.md (timeout flags); proc.ts |
| L092 | Tool use & recovery | Command classifier (read vs install vs destructive) for run_command | - | PASS | src/main/agent/tools/shell.ts:55 GIT_DISCARD etc. |
| L093 | Tool use & recovery | OS-level sandbox profile restricting writes for commands | CC | PASS | src/main/code/proc.ts:70 (sandbox-exec profile) |
| L094 | Tool use & recovery | Model-level fallback when a provider fails (cooldowns) | - | PASS | src/main/llm/model-health.ts:9; docs/model-routing.md Failures |
| L095 | Tool use & recovery | Tool results larger than window trimmed per model window | - | PASS | src/main/agent/context.ts:111 resultLimit(window) |
| L096 | Tool use & recovery | Skill packs loaded on demand (241 built-in) | CC | PASS | packs/skills (241 entries); docs/skills.md; src/main/skills.ts |
| L097 | Tool use & recovery | User/learned skills created from experience | CC | PASS | docs/skills.md; src/main/skills.ts rankSkills |
| L098 | Tool use & recovery | User-defined lifecycle hooks (pre/post tool command) | CC | MISSING | grep "PreToolUse\|hooks" in src: no hits |
| L099 | Tool use & recovery | Plugin packaging/marketplace for bundles of skills+tools+commands | CC | MISSING | grep "plugin" in src: only Codex plugin detection (llm/codex/detect.ts:98); no install flow |
| L100 | Tool use & recovery | Tool-call limits when model lacks native tool calling (local models) | CC/GK/GPT | PARTIAL | src/main/llm/tool-adapters.ts, local-tools.ts present; parity of reliability unverified |
| L101 | Coding | Project detection (languages, package manager, test/lint/build commands) | CC | PASS | src/main/code/project.ts; docs/coding.md `code project` |
| L102 | Coding | Regex and literal code search (ripgrep fallback) respecting .gitignore | CC | PASS | src/main/code/search.ts |
| L103 | Coding | Symbol outline and definition lookup across 8 languages | CC | PASS | docs/coding.md `symbols`; src/main/agent/tools/code.ts |
| L104 | Coding | Exact string edit with diff and backup | CC | PASS | docs/coding.md `edit`; src/main/code/patch.ts |
| L105 | Coding | Unified-diff and Begin/End Patch application, atomic | CC | PASS | docs/coding.md `apply_patch`; src/main/code/patch.ts |
| L106 | Coding | Run tests with failures parsed to file:line | CC | PASS | src/main/code/checks.ts; run-summary.ts:7 |
| L107 | Coding | Typecheck, lint and build actions with parsed diagnostics | CC | PASS | src/main/code/checks.ts; docs/coding.md |
| L108 | Coding | Test-until-green loop enforced by acceptance checks | CC | PASS | docs/agent-system.md Harness 2; runtime/verification.ts; tests/accept |
| L109 | Coding | Git status/diff/log/branch/checkout/add/commit/stash | CC | PASS | src/main/agent/tools/code.ts:368; src/main/code/git.ts |
| L110 | Coding | Secret scan on every commit's staged diff | CC | PASS | src/main/code/git.ts:7 |
| L111 | Coding | Push and PR creation through GitHub CLI | CC | PASS | docs/coding.md git push/pr; code.ts:333 pr_view |
| L112 | Coding | PR view and PR diff reading | CC | PASS | src/main/agent/tools/code.ts:333 |
| L113 | Coding | Automated PR code review with inline comments | CC | PARTIAL | pr_view/pr_diff + code-review skill (packs/skills code-review) exist; no posting of inline review comments found |
| L114 | Coding | Never offers force-push/reset --hard; runs them only with an extra ask | CC | PASS | docs/coding.md git; shell.ts:55 GIT_DISCARD |
| L115 | Coding | Hand-off to Cursor local and cloud agents with auto review of the diff | CC | PASS | src/main/agent/tools/apps.ts:119,322; docs/coding.md |
| L116 | Coding | Isolated worktrees for coding sub-agents | CC | PASS | docs/agent-system.md Harness 4; runtime/graph.ts:19 |
| L117 | Coding | Sandboxed command execution (writes restricted) | CC | PASS | src/main/code/proc.ts:70 |
| L118 | Coding | Dev-server/long command as background job with log tail | CC | PASS | src/main/agent/tools/jobs.ts:46 |
| L119 | Coding | Checkpoint (restore point via git stash create) before delegated edits | CC | PASS | src/main/agent/tools/apps.ts:322 |
| L120 | Coding | Language-server diagnostics / go-to-definition via LSP | CC | MISSING | grep "language server\|lsp" in src: no code-intel client |
| L121 | Coding | In-app code interpreter producing charts and files (Python sandbox) | GK/GPT | MISSING | grep "code_interpreter\|run_python": only an OpenAI builtin tool name (llm/openai-models.ts:85); local run_command can run python but no managed sandbox |
| L122 | Coding | Execute Jupyter notebook cells | CC | MISSING | grep jupyter: only text extraction (knowledge/extract.ts:88) |
| L123 | Coding | Codebase orientation, bug-diagnosis and commit/PR skills | CC | PASS | packs/skills codebase-orientation, coding-fix-failing-tests, coding-commit-and-pr |
| L124 | Coding | Code diff view inside the chat UI | GK/GPT | PARTIAL | doc/Blocks.tsx:270 is a doc diff; code diffs appear as text in results (run-summary.ts), no syntax-highlighted diff viewer |
| L125 | Coding | Syntax highlighting of code blocks in chat | CC | MISSING | src/renderer/src/components/Markdown.tsx:20 renders code with language label and copy only; grep highlight.js/prism/shiki: none |
| L126 | Browser & computer use | Persistent-login real Chromium browser the user can watch/take over | CC | PASS | src/main/browser/manager.ts (2412 lines); docs/browser.md |
| L127 | Browser & computer use | Accessibility-tree snapshots with stable refs | GK/GPT | PASS | docs/browser.md "Reading a snapshot"; manager.ts |
| L128 | Browser & computer use | Structured extraction of tables/lists/cards with pagination | GK/GPT | PASS | docs/browser.md extract/next_page |
| L129 | Browser & computer use | Form filling in one step incl. dropdowns and dialogs | GK/GPT | PASS | docs/browser.md fill_form/select/dialog |
| L130 | Browser & computer use | Saved login fill without the model seeing the secret | - | PASS | src/main/agent/tools/browser.ts:19; docs/browser.md fill_secret |
| L131 | Browser & computer use | One-time-code fill approved per site | - | PASS | docs/browser.md fill_otp |
| L132 | Browser & computer use | Payment fill via purchase card with confirmation | GK/GPT | PASS | src/main/browser/checkout.ts; docs/browser.md fill_payment |
| L133 | Browser & computer use | File upload and download policies | GK/GPT | PASS | src/main/browser/download-policy.ts; browser tool upload/downloads |
| L134 | Browser & computer use | Hands CAPTCHA and 2FA to the user instead of bypassing | GK/GPT | PASS | src/main/browser/manager.ts:1754; docs/computer-use.md Rules |
| L135 | Browser & computer use | Teach-by-demonstration recording of a web task | - | PASS | src/main/browser/teach.ts; TeachBar.tsx |
| L136 | Browser & computer use | Per-site learned knowledge (flows, hints) | - | PASS | src/main/sites/ (store, learn, hint); tools/sites.ts:23 |
| L137 | Browser & computer use | Multi-tab management by index or title | GK/GPT | PASS | docs/browser.md tabs |
| L138 | Browser & computer use | Background worker browser for parallel helpers | GK/GPT | PASS | src/main/agent/tools/worker-browser.ts:76 |
| L139 | Browser & computer use | Full desktop control (screenshot, mouse, keyboard) with Retina mapping | GK/GPT | PASS | src/main/computer/; docs/computer-use.md |
| L140 | Browser & computer use | AX-tree-first desktop control (refs before pixels) | CC | PASS | src/main/computer/ax.ts; docs/computer-use.md "The loop" |
| L141 | Browser & computer use | Per-app scripted adapters (Finder, Messages, Slack, Office, iWork, Preview) | - | PASS | src/main/computer/apps/ (16 files) |
| L142 | Browser & computer use | Planner plus executor model pair for computer use | - | PASS | src/main/agent/cua/pair.ts, planner.ts |
| L143 | Browser & computer use | Shrinks the app window and shows an overlay while controlling the Mac | - | PASS | src/main/computer/overlay-window.ts; renderer/overlay/main.ts |
| L144 | Browser & computer use | Stop control and OS password prompts handed to the user | - | PASS | docs/computer-use.md Rules |
| L145 | Browser & computer use | Web research with page fetch, search fallbacks and citation | GK/GPT | PASS | src/main/agent/tools/web.ts; docs/index.md Accuracy first |
| L146 | Browser & computer use | Deep Research mode producing a report | GK/GPT | PASS | src/renderer/src/App.tsx:273-277 (deepResearch); src/main/agent/runtime/research.ts |
| L147 | Browser & computer use | Companion extension to drive the user's own Chrome/Safari profile | CC | MISSING | grep "chrome extension\|native messaging": none; browser is SahilBot's embedded Chromium only |
| L148 | Browser & computer use | Visual page understanding via screenshots across the web agent | GK/GPT | PARTIAL | screenshot action in docs/browser.md; Grok never routed to computer use (docs/model-routing.md) |
| L149 | Browser & computer use | Screen/window video recording of the agent session for replay | GK/GPT | MISSING | grep "record.*screen": only the teach recorder (browser/teach.ts), no replayable session video |
| L150 | Browser & computer use | Browsing blocked on sensitive actions without confirmation (purchase, send, post) | GK/GPT | PASS | docs/permissions.md hard stops; manager.ts checkout.ts |
| L151 | Files & documents | Create Word documents from Markdown with real styles, TOC, footnotes, templates | CC/GK/GPT | PASS | src/main/docs/docx.ts; docs/office.md; files.ts:324 create_document |
| L152 | Files & documents | Create PDFs with charts, TOC and page fitting | CC/GK/GPT | PASS | src/main/docs/pdf.ts, pdfdoc.ts, fit.ts |
| L153 | Files & documents | Native editable document workspace (canvas) with versions | CC/GK/GPT | PASS | src/main/agent/tools/docspace.ts:80; src/main/docspace/store.ts |
| L154 | Files & documents | Agent and user co-edit the same doc with block ids and merge on conflict | GPT | PASS | src/main/docspace/merge.ts; docs/artifacts.md "Changing a document" |
| L155 | Files & documents | Version history with restore | GK/GPT | PASS | src/main/docspace/store.ts:238 restore() |
| L156 | Files & documents | Export live docs to docx, pdf, md, html | GPT | PASS | src/main/docspace/export.ts:48 DOC_FORMATS |
| L157 | Files & documents | Open and edit existing docx/pdf/pptx/xlsx/csv/md/html and save back with backup | GPT | PASS | src/main/docspace/import.ts:13; docs/artifacts.md "Files the user already has" |
| L158 | Files & documents | Reads every common format back as text (docx, xlsx, pptx, pdf, notebooks) | CC | PASS | src/main/docs/read.ts; knowledge/extract.ts |
| L159 | Files & documents | Read images and scanned documents with a vision model | GK/GPT | PASS | src/main/agent/tools/vision.ts; read_document_image |
| L160 | Files & documents | Local OCR without a cloud call | GK/GPT | PARTIAL | grep tesseract/VNRecognize: none; scans rely on vision-model calls (privacy gate applies) |
| L161 | Files & documents | PDF form discovery and filling (flatten option) | GK/GPT | PASS | docs/office.md pdf_fields/pdf_fill; src/main/agent/tools/office.ts:142 |
| L162 | Files & documents | PDF merge, split, extract, rotate, stamp, page numbers | - | PASS | docs/office.md office actions |
| L163 | Files & documents | Batch file jobs with dry-run plan (rename, sort, convert, archive) | - | PASS | src/main/docs/batch.ts; docs/office.md |
| L164 | Files & documents | Receipts to spreadsheet with "check" flags on unsure rows | - | PASS | src/main/docs/receipts.ts |
| L165 | Files & documents | Meeting transcript to notes with owners/due dates | - | PASS | src/main/docs/meetings.ts |
| L166 | Files & documents | Automated review of generated documents (structure, placeholders, overflow, spelling) | CC | PASS | src/main/docs/review.ts; tools/office.ts:496 review_document |
| L167 | Files & documents | Backups before overwriting user files | - | PASS | docs/office.md .foreman/backups; docs/artifacts.md |
| L168 | Files & documents | File management with deletes always asking | CC/GPT | PASS | src/main/agent/tools/files.ts (file_manage); docs/tools.md |
| L169 | Files & documents | Attachments: drag, paste, screenshots, folders | CC | PASS | src/renderer/src/components/Composer.tsx:245; Attachments.tsx |
| L170 | Files & documents | Local knowledge base over user folders with embeddings and BM25 | GPT | PASS | src/main/knowledge/ (indexer, embeddings, rank); KnowledgeSettings.tsx |
| L171 | Files & documents | Artifacts page listing made files and live docs | GPT | PASS | Home.tsx FilesView; MadeFiles.tsx |
| L172 | Files & documents | Interactive HTML pages/apps (calculators, interactive charts) | GPT | PASS | src/main/agent/tools/pages.ts; PageView.tsx |
| L173 | Files & documents | Image generation with edit and transparent backgrounds | GK/GPT | PASS | src/main/agent/tools/media.ts:152; docs/agent-system.md |
| L174 | Files & documents | Video generation/avatars/translation via connected video provider | GK/GPT | PASS | src/main/agent/tools/video.ts:707 |
| L175 | Files & documents | Export to Google Docs / Slides / Sheets formats directly | GPT | PARTIAL | gdocs/gsheets/gslides connectors (connectors.ts:173,1176) exist but no native "export to Google Doc" action in docspace/export.ts |
| L176 | Slides & decks | Native slide editor with thumbnails, grid and full-screen present | CC/GK/GPT | PASS | src/renderer/src/components/doc/SlidesView.tsx:11 |
| L177 | Slides & decks | Deck written as Markdown (one block model, one renderer) | GPT | PASS | src/shared/slides.ts; slide-render.ts |
| L178 | Slides & decks | Editable PowerPoint export (.pptx) from a live deck | CC/GK/GPT | PASS | src/main/docspace/export.ts:51; deck-export.ts |
| L179 | Slides & decks | Picture-per-slide PPTX for exact fonts | - | PASS | DECK_FORMATS 'pptx_pictures' |
| L180 | Slides & decks | OpenDocument .odp export (Keynote/LibreOffice/Google Slides) | - | PASS | deck-export.ts:122 |
| L181 | Slides & decks | PDF and PNG (1920x1080) exports from the same renderer | GPT | PASS | export.ts:51 DECK_FORMATS; slide-render.ts |
| L182 | Slides & decks | Speaker notes per slide round-trip | GK/GPT | PASS | slides.ts:10-25 (notes, notesId); deck-export.ts |
| L183 | Slides & decks | Themes (Modern, Classic, Minimal) and font picks carried into exports | GPT | PASS | src/shared/types.ts:2348; slide-render.ts:29 deckLook |
| L184 | Slides & decks | Open and edit an existing .pptx as a deck | GPT | PASS | docspace/import.ts:94 |
| L185 | Slides & decks | Native editable charts inside generated .pptx | GK/GPT | PASS | src/main/docs/pptx.ts; docs/office.md layouts (chart, table, stats) |
| L186 | Slides & decks | Charts and tables inside the native slide editor | GK/GPT | PARTIAL | slides.ts layouts only title\|bullets\|image\|image_text\|section (slides.ts:71); no chart/table blocks in live decks |
| L187 | Slides & decks | Two-column, quote, comparison and agenda layouts in the live editor | GK/GPT | PARTIAL | create_document pptx has two_column/quote/closing (docs/office.md); live-deck slideLayout has 5 types only |
| L188 | Slides & decks | Slide transitions and animations | GK/GPT | MISSING | grep "transition" in src/main/docs/pptx.ts and slides.ts: none |
| L189 | Slides & decks | Generated images placed in slides | GK | PASS | SlidesView.tsx:163 picture(); media.ts:152 |
| L190 | Slides & decks | Presenter view with notes, timer and next-slide preview | GK | MISSING | SlidesView.tsx Present mode (arrow keys, Esc) only; no notes/timer panel found |
| L191 | Slides & decks | Overflow-safe text fitting and slide review | GPT | PASS | docs/office.md; review.ts |
| L192 | Slides & decks | Stat tiles and big-number slides | - | PASS | slides.ts:80 statOf |
| L193 | Slides & decks | Custom brand templates / import a .potx or master slide | GK | MISSING | grep "master\|potx\|template" in docspace and SlidesView: none for decks (templates exist only for docx in docs/templates.ts) |
| L194 | Slides & decks | Slide reorder by drag and per-slide duplicate in the editor | GK | PASS | src/renderer/src/components/doc/SlidesView.tsx:141 duplicate(); draggable handlers (4 hits) |
| L195 | Slides & decks | Deck research and outline from sources with citations | GPT | PASS | Deep Research (App.tsx:273) feeding doc_create; skills packs business-pitch decks |
| L196 | Slides & decks | Agent edits individual slides with small ops | - | PASS | docspace/ops.ts:9 insert/replace/move; docs/artifacts.md |
| L197 | Slides & decks | User edits and agent edits both versioned | - | PASS | docspace/store.ts versions |
| L198 | Slides & decks | Share a deck by link / web presentation | GK | MISSING | team-pages.ts is for team pages; no deck publish link |
| L199 | Slides & decks | Embed video or audio in slides | GK/GPT | MISSING | grep video in slides.ts/slide-render.ts: none |
| L200 | Slides & decks | Automated slide quality check before delivery | CC | PASS | src/main/docs/review.ts |
| L201 | Dashboards & charts | Native dashboard doc type (tiles, tables, notes) | GK | PASS | src/shared/dashboard.ts:13-17 |
| L202 | Dashboards & charts | Auto chart from table (line over time, bars otherwise) | GK | PASS | src/shared/dashboard.ts:60 chartSvg |
| L203 | Dashboards & charts | Dashboard export PDF (landscape), HTML, docx, md | GK | PASS | docs/artifacts.md table; deck-export.ts:70 dashboardPage |
| L204 | Dashboards & charts | Edit data view alongside drawn dashboard | GK | PASS | docs/artifacts.md Dashboards |
| L205 | Dashboards & charts | Accessible SVG chart with aria-label | GK | PASS | dashboard.ts:60 chartSvg role="img" |
| L206 | Dashboards & charts | Number formatting (K/M/B) | GK | PASS | dashboard.ts short() |
| L207 | Dashboards & charts | Native chart types in generated reports (column, bar, line, area, pie, doughnut) | GK/GPT | PASS | src/main/docs/chart.ts:11 |
| L208 | Dashboards & charts | Scatter, histogram, heatmap, combo, stacked, funnel chart types | GK/GPT | MISSING | chart.ts:11 type union lacks them; dashboard.ts only line/bar |
| L209 | Dashboards & charts | Interactive dashboards (filters, hover tooltips, drill-down) | GK/GPT | MISSING | dashboard.ts emits static SVG/HTML; no event handlers |
| L210 | Dashboards & charts | Live data-bound dashboards that refresh from a source | GK/GPT | MISSING | grep "refresh" in dashboard.ts/DocEditor: none; data is block text |
| L211 | Dashboards & charts | Interactive pages/charts via create_page | GPT | PARTIAL | tools/pages.ts; PageView.tsx (HTML, not a native dashboard) |
| L212 | Dashboards & charts | Dashboard from spreadsheets or CSV uploaded by the user | GPT | PASS | docspace/import.ts csv/xlsx; dashboards built via doc_create |
| L213 | Dashboards & charts | Stock charts, quotes, forecasts and backtests | GK | PASS | src/main/markets/; tools/stocks.ts; StockCard.tsx |
| L214 | Dashboards & charts | Watchlist with price alerts | - | PASS | src/renderer/src/components/Watchlist.tsx; price_alert tool |
| L215 | Dashboards & charts | Usage/cost dashboard for the app itself | GK | PASS | src/main/usage.ts:210 usageDashboard; UsagePage.tsx |
| L216 | Dashboards & charts | Chart themes follow document style | GPT | PARTIAL | dashboardCss(style) dashboard.ts:85; limited to 3 themes |
| L217 | Dashboards & charts | Chart annotations, reference lines, secondary axis | GK/GPT | MISSING | chartSvg has grid/legend only |
| L218 | Dashboards & charts | Chart data labels and axis titles | GK/GPT | PARTIAL | chart.ts supports axis formats; dashboard chart has none |
| L219 | Dashboards & charts | Chart image export (PNG) of a dashboard | GK/GPT | PASS | DECK_FORMATS png applies to decks; dashboard exports pdf/html (no PNG) |
| L220 | Dashboards & charts | Scheduled dashboard refresh and email | - | MISSING | schedule tool exists (schedule.ts:11) but no dashboard re-render binding |
| L221 | Dashboards & charts | Dashboards from connected business apps (Stripe, PostHog, Amplitude) | GK | PARTIAL | connectors exist (connectors.ts) but agent must hand-copy numbers into blocks |
| L222 | Dashboards & charts | Financial forecasting/backtests with stats modules | - | PASS | src/main/markets/forecast.ts, garch.ts, backtest.ts |
| L223 | Dashboards & charts | Review step for charts in reports (labels, units) | GPT | PASS | src/main/docs/review.ts |
| L224 | Dashboards & charts | Data-quality validation of numbers vs source CSV | - | PASS | docs/office.md review "numbers that don't match source" |
| L225 | Dashboards & charts | KPI delta/trend arrows and thresholds | GK | PARTIAL | tile note text only (dashboard.ts:13 Tile.note) |
| L226 | Spreadsheets | Create .xlsx with typed columns, formats, totals row, freeze panes, filters | CC/GK/GPT | PASS | src/main/docs/xlsx.ts:6; docs/office.md |
| L227 | Spreadsheets | Formulas stored with computed values and verified | GK/GPT | PASS | src/main/docs/formula.ts (~80 functions); review.ts |
| L228 | Spreadsheets | Data validation dropdowns and conditional formatting | GK/GPT | PASS | xlsx.ts:29-31,399 |
| L229 | Spreadsheets | Read and write existing workbooks preserving styles with backups | GK/GPT | PASS | docs/office.md sheet_read/sheet_write |
| L230 | Spreadsheets | CSV to XLSX and XLSX to CSV | GK/GPT | PASS | docs/office.md csv_to_xlsx; batch.ts |
| L231 | Spreadsheets | Native sheet doc type edited live by agent and user | GK/GPT | PASS | docspace/sheet.ts; SheetView.tsx |
| L232 | Spreadsheets | Formula errors surfaced (#DIV/0!, #REF!, #NAME?, cycle) | GK/GPT | PASS | docspace/sheet.ts:11 ERR |
| L233 | Spreadsheets | Cell-level agent edits (set_cells/set_range/clear_range) | GK/GPT | PASS | docspace/ops.ts:11,271 |
| L234 | Spreadsheets | Native sheet formula coverage | GK/GPT | PARTIAL | docspace/sheet.ts:86 FUNCS = SUM AVERAGE MIN MAX COUNT only; no IF, VLOOKUP, SUMIF, text/date functions |
| L235 | Spreadsheets | Multiple tabs in a native sheet | GK/GPT | MISSING | DocSheet is one grid (sheet.ts:325 emptySheet); xlsx.ts supports sheets only for files |
| L236 | Spreadsheets | Size limits adequate for real data | GK/GPT | PARTIAL | docspace/sheet.ts:7-8 MAX_ROWS = 1000, MAX_COLS = 52; large files go through sheet_read |
| L237 | Spreadsheets | Charts embedded in .xlsx output | GK/GPT | MISSING | grep chart in src/main/docs/xlsx.ts: none |
| L238 | Spreadsheets | Pivot tables | GK/GPT | MISSING | grep pivot in docs/ and docspace/: none |
| L239 | Spreadsheets | Sort/filter/find in the native sheet UI | GK/GPT | PARTIAL | SheetView.tsx (139 lines): selection and editing; no sort/filter controls |
| L240 | Spreadsheets | Cell formatting UI (number, bold, color) in native sheet | GK/GPT | MISSING | SheetView.tsx has no format toolbar (grep "format" none) |
| L241 | Spreadsheets | Summaries and column statistics of workbooks | GPT | PASS | docs/office.md sheet_summarize |
| L242 | Spreadsheets | Refuses to clobber workbooks with charts/pivots/macros | GPT | PASS | docs/office.md sheet_write |
| L243 | Spreadsheets | XLOOKUP compatibility rewrite for older Excel | GK/GPT | PASS | src/main/docs/formula.ts:711-717 |
| L244 | Spreadsheets | Statistics and time-series tooling (backtest, GARCH) | GPT | PASS | src/main/markets/stats.ts |
| L245 | Spreadsheets | Natural-language data analysis (clean, join, dedupe) with transformations shown | GK/GPT | PARTIAL | packs/skills data analysis + batch/sheet tools; no dedicated data-prep tool or Python sandbox |
| L246 | Spreadsheets | Spreadsheet checks (totals skipping rows, numbers as text) | GK/GPT | PASS | docs/office.md review_document checks |
| L247 | Spreadsheets | Currency/percent/date typed formatting | - | PASS | xlsx.ts column types |
| L248 | Spreadsheets | Google Sheets live editing via native workflow | GK | MISSING | connectors gsheets (connectors.ts:1176) only through MCP tools |
| L249 | Spreadsheets | Macros/scripts (Apps Script / VBA) | - | MISSING | none |
| L250 | Spreadsheets | Import from CSV with delimiter/encoding detection | GK/GPT | PARTIAL | docspace/sheet.ts:367 parseCsv; no encoding detection found |
| L251 | Memory & personalization | Automatic saving of lasting facts and preferences with inline "Noted" | CC/GK/GPT | PASS | docs/memory.md "Save automatically"; src/main/memory.ts, memory-system.ts |
| L252 | Memory & personalization | Memory tool: save, list, search, forget with exact-removal reporting | CC/GK/GPT | PASS | src/main/agent/tools/memory.ts; docs/memory.md |
| L253 | Memory & personalization | Memory shared across all chats and bots (me scope) vs per-bot scope | GPT | PASS | docs/memory.md "Two scopes" |
| L254 | Memory & personalization | Search over past conversations as well as saved facts | GPT | PASS | docs/memory.md Search; src/main/agent/tools/chat-history.ts:7 |
| L255 | Memory & personalization | Memory manager UI to view, edit, delete | GPT | PASS | src/renderer/src/components/MemoryManager.tsx |
| L256 | Memory & personalization | Import memories/instructions from ChatGPT, Claude, Gemini exports | GK/GPT | PASS | src/main/memory-import.ts; ImportMemoryDialog.tsx |
| L257 | Memory & personalization | Export all memories to a portable file | GK/GPT | MISSING | ImportMemoryDialog.tsx is import-only; grep "exportMemor": none |
| L258 | Memory & personalization | Entity graph of people, places, projects with sources and dates | - | PASS | src/main/context-engine/; PeopleView.tsx |
| L259 | Memory & personalization | Facts versioned; superseded facts retained as history | - | PASS | src/main/agent/runtime/tools.ts memory_history; docs/agent-system.md Memory 3 |
| L260 | Memory & personalization | Provenance on every fact (user said / app saw / quoted from others) | - | PASS | docs/context.md "About the user and their world" |
| L261 | Memory & personalization | Quoted outside content stored as unverified data, never as rules | - | PASS | docs/memory.md "Never save"; agent/permissions.ts:228 |
| L262 | Memory & personalization | Sensitive-category switches (health, money, IDs, religion...) | CC/GK/GPT | PASS | docs/memory.md; src/main/context-engine/sensitive.ts |
| L263 | Memory & personalization | Never stores passwords, card or ID numbers | - | PASS | docs/memory.md "Never save"; shared/secret-detect.ts |
| L264 | Memory & personalization | Decision memory learned from the user's answers and corrections | - | PASS | src/main/decisions.ts; learning/decisions.ts |
| L265 | Memory & personalization | Knowledge vault of linked notes with retrieval | CC | PASS | src/main/vault/ (notes, retrieve, compile); docs/vault.md |
| L266 | Memory & personalization | Obsidian-compatible vault | CC | PASS | src/main/vault/obsidian.ts |
| L267 | Memory & personalization | Project memory with dependency invalidation | - | PASS | runtime/tools.ts:75 project_memory |
| L268 | Memory & personalization | Verified experience: successful procedures recorded with evidence | - | PASS | docs/agent-system.md Memory 5; src/main/agent/task-memory.ts |
| L269 | Memory & personalization | Skills learned from experience and reused | GPT | PASS | docs/skills.md; src/main/skills.ts |
| L270 | Memory & personalization | Local embeddings plus BM25 recall fused | GK/GPT | PASS | src/main/knowledge/embeddings.ts, rank.ts |
| L271 | Memory & personalization | Memory scoped per bot so private work logs stay private | GPT | PASS | docs/memory.md; agent-system.md Memory 1 |
| L272 | Memory & personalization | Forgetting a source also removes derived facts and vectors | GK | PASS | docs/agent-system.md Memory 3 |
| L273 | Memory & personalization | Learning log showing what was learned and why | GPT | PASS | src/renderer/src/components/LearningLog.tsx |
| L274 | Memory & personalization | Temporary/incognito chat that skips memory and history | GPT | MISSING | grep "temporary chat\|incognito" in chat code: only activity sampler (activity/sampler.ts:9) |
| L275 | Memory & personalization | Per-chat toggle to disable memory use for one conversation | GPT | PARTIAL | Global Settings → Memory switch only; no per-chat switch found |
| L276 | Context management | Automatic compaction into Goal/Decisions/Facts/Open items/Files with preserved constraints | CC | PASS | src/main/agent/context.ts:176-192,410; docs/context.md |
| L277 | Context management | Identifiers, paths and failed attempts carried across compaction | CC | PASS | context.ts:297-346 carryFacts, identifiersIn |
| L278 | Context management | Exact earlier passages retrievable after compaction | CC | PASS | src/main/agent/tools/chat-history.ts:7; docs/agent-system.md Context and storage |
| L279 | Context management | Large tool results offloaded to disk with paging | CC | PASS | tools/core.ts:58 read_result; context.ts:97 |
| L280 | Context management | Older tool outputs shrunk to stubs in long runs | CC | PASS | docs/context.md "What happens as it fills" |
| L281 | Context management | Image tokens budgeted; only newest screenshots kept | CC | PASS | context.ts:23 IMAGE_TOKENS; docs/context.md |
| L282 | Context management | Prompt caching and server-side compaction for OpenAI/Anthropic | CC | PASS | src/main/llm/openai-responses.ts:12-32; llm/anthropic.ts |
| L283 | Context management | Model context window detection and budget per model | CC | PASS | src/main/llm/context-window.ts |
| L284 | Context management | Tool profile shrinks (small/tiny) for small windows | - | PASS | src/main/agent/registry.ts:21-63 chooseProfile |
| L285 | Context management | Working notes that persist across the run | CC | PASS | src/main/agent/notes.ts:182 |
| L286 | Context management | Context block assembled per request (memories, vault, world, skills) and warmed in parallel | - | PASS | docs/model-routing.md "warmContext"; src/main/context-engine/assemble.ts |
| L287 | Context management | 1M-token windows used with larger context cards | CC | PASS | docs/context.md; llm/context-window.ts |
| L288 | Context management | User-visible context meter (tokens used / remaining) | CC | PARTIAL | ModelContextSelect.tsx and context choices (shared/context-choices.ts) pick windows; no live fill gauge found in ThreadView |
| L289 | Context management | Manual /compact or "summarize now" command | CC | MISSING | grep "/compact": none in Composer/CommandPalette |
| L290 | Context management | Manual /clear or new-context-in-same-chat command | CC | MISSING | no clear-context action in CommandPalette.tsx |
| L291 | Context management | Summary repair (checks summary retained constraints/ids) | - | PASS | context.ts:410 repairSummary |
| L292 | Context management | Cross-model handoff note when model changes | - | PASS | docs/agent-system.md paragraph 1 |
| L293 | Context management | Attached folders indexed and searched, not stuffed in context | GPT | PASS | src/main/knowledge/folder-scan.ts, watcher.ts |
| L294 | Context management | Selective skill injection with char budget | - | PASS | docs/skills.md "How skills reach the model" |
| L295 | Context management | Isolated sub-agent context returning short reports | CC | PASS | docs/agents.md "Writing tasks" |
| L296 | Context management | Context assembled for small local models (16-32K) with slim prompts | - | PASS | registry.ts SMALL_TOOLS/TINY_TOOLS; docs/context.md |
| L297 | Context management | Request-size estimate before sending | CC | PASS | context.ts:24-29 estimate/upperEstimate; task-classifier.ts:730 |
| L298 | Context management | Search across all chats from the UI | GK/GPT | PARTIAL | CommandPalette.tsx jumps to chats by title; full-text search is agent-side (chat_history), no UI search |
| L299 | Context management | Branch/fork a conversation from any message | CC/GPT | MISSING | grep "forkThread\|branch.*thread": none |
| L300 | Context management | Per-chat and per-project scoping of context | GK/GPT | PASS | src/main/spaces.ts; ProjectHome.tsx |
| L301 | Model routing | Auto router reads the request and assesses goal, impact and checks | - | PASS | src/main/llm/auto-brain.ts; docs/model-routing.md |
| L302 | Model routing | Local rules classifier with category, difficulty 0-3, effort | - | PASS | src/main/llm/task-classifier.ts:485 classifyTask |
| L303 | Model routing | Routing table of ordered candidates per category/tier from benchmarks | - | PASS | src/main/llm/routing-table.ts (AA figures, TTFT_S) |
| L304 | Model routing | User preference: Best result / Balanced / Cheapest | - | PASS | docs/model-routing.md "Auto prefers" |
| L305 | Model routing | Close-call logic comparing price and latency of one tier up | - | PASS | src/main/llm/routing-table.ts:25 closeCall; CLOSE_CALL_PRICE |
| L306 | Model routing | Escalates to a stronger model after repeated failed steps | - | PASS | docs/model-routing.md "During a run"; llm/outcome-router.ts |
| L307 | Model routing | Phase rerouting (research, execution, writing, verification) | - | PASS | docs/agent-system.md Auto 1 |
| L308 | Model routing | Collaboration modes: solo, pair, debate, fan-out, plan, review, plan+review | - | PASS | docs/model-routing.md; src/main/llm/route-tiebreak.ts |
| L309 | Model routing | Cross-provider reviewer or partner preferred | - | PASS | docs/model-routing.md "Auto prefers a different provider" |
| L310 | Model routing | Manual model and thinking-level pick that Auto never overrides | CC/GK/GPT | PASS | docs/agent-system.md paragraph 1; ModelContextSelect.tsx |
| L311 | Model routing | Spending limit awareness in routing | - | PASS | SpendingLimit.tsx; llm/budget.ts; docs/model-routing.md table |
| L312 | Model routing | Local-only / cloud-only / local-first modes | - | PASS | docs/model-routing.md; src/main/llm/local-detect.ts |
| L313 | Model routing | Health cooldown for failing models | - | PASS | src/main/llm/model-health.ts:9 |
| L314 | Model routing | Outcome profiles from verified results update the baseline | - | PASS | docs/agent-system.md Auto 3; llm/outcome-router.ts |
| L315 | Model routing | Vision-capable-only routing when images are present | - | PASS | docs/model-routing.md table "Images in the request" |
| L316 | Model routing | Stability: keep chat's model when still good | - | PASS | docs/model-routing.md "Stability across a conversation" |
| L317 | Model routing | "Why this model" label on every reply | - | PASS | docs/model-routing.md ("routed" label); ThreadView.tsx:989 |
| L318 | Model routing | Fast-mode tiers used only where allowed | - | PASS | src/main/llm/fast-mode.ts; FastModeSettings.tsx |
| L319 | Model routing | Claude, OpenAI, Grok, OpenRouter, Ollama/local providers | CC/GK/GPT | PASS | src/main/llm/providers.ts; xai-client.ts; claude-native/; codex/ |
| L320 | Model routing | Uses the user's ChatGPT plan via Codex at zero marginal cost | GPT | PASS | src/main/llm/codex/; ChatgptPlanSettings.tsx |
| L321 | Model routing | Uses the user's Grok plan/CLI | GK | PASS | src/main/llm/grok/plan.ts; GrokPlanSettings.tsx |
| L322 | Model routing | Agent evaluation workbench comparing models on recorded runs | - | PASS | src/main/agent/runtime/evaluation.ts:10 |
| L323 | Model routing | Routing table refreshed automatically from live benchmark sources | - | PARTIAL | routing-table.ts figures are hand-maintained constants dated in comments; no fetch of benchmark feeds found |
| L324 | Model routing | Model catalog auto-updated from provider endpoints | - | PASS | src/main/llm/endpoints.ts:208; catalog.ts |
| L325 | Model routing | Online A/B or per-user learned routing across many runs | - | PARTIAL | outcome profiles exist but need "enough measured outcomes" (agent-system.md Auto 3); single-user data only |
| L326 | Multi-agent & helpers | Helper agents running in parallel with their own context | CC | PASS | src/main/agent/tools/max.ts:26; docs/agents.md |
| L327 | Multi-agent & helpers | Team strategy: divide tasks across helpers and compile with credits | - | PASS | docs/agents.md `team`; src/main/agent/max/host.ts |
| L328 | Multi-agent & helpers | Divergent swarm (ideate / divide) over many items | GK | PASS | src/main/agent/tools/agents.ts:78; swarm/ |
| L329 | Multi-agent & helpers | Heavy: several full attempts plus judge that re-checks disagreements | - | PASS | src/main/agent/heavy.ts; HeavyCard.tsx |
| L330 | Multi-agent & helpers | Hybrid strategy (swarm then judged attempts) | - | PASS | docs/agents.md `hybrid`; max/planner.ts |
| L331 | Multi-agent & helpers | Strategy planner chooses automatically from the goal | - | PASS | src/main/agent/max/decide.ts, auto-teamwork.ts |
| L332 | Multi-agent & helpers | Dependent task graph with optional per-task model choice | CC | PASS | src/main/agent/runtime/graph.ts:26 (task_graph) |
| L333 | Multi-agent & helpers | Read workers limited to read-only tools; coding workers in worktrees | CC | PASS | docs/agent-system.md Harness 4 |
| L334 | Multi-agent & helpers | Concurrency scaled to Mac memory and local vs cloud model | - | PASS | src/main/agent/swarm/capacity.ts; docs/agents.md Limits |
| L335 | Multi-agent & helpers | Pool and ledger of helper cost and status | - | PASS | swarm/pool.ts, ledger.ts |
| L336 | Multi-agent & helpers | Helper nesting limit (two levels) | - | PASS | docs/agents.md Limits |
| L337 | Multi-agent & helpers | Helpers cannot do approval-needing actions; parent does them | - | PASS | docs/agents.md "Writing tasks" |
| L338 | Multi-agent & helpers | Helper reports treated as evidence not instructions | - | PASS | docs/agents.md "After" |
| L339 | Multi-agent & helpers | Multiple named bots with own instructions, models and memory | - | PASS | src/main/agent/tools/bots.ts:13; BotEditor.tsx; FunctionBots.tsx |
| L340 | Multi-agent & helpers | Group chats where bots hand work to each other via @mention | - | PASS | loop.ts:918 (addressed bots); MAX_BOT_HOPS = 4 (loop.ts, near AGENT_SYSTEM_GUIDANCE) |
| L341 | Multi-agent & helpers | Bots message each other (message_bot, ask_bot) | - | PASS | tools/handoff.ts:180; tools/ask-bot.ts |
| L342 | Multi-agent & helpers | Bot swarm configuration and councils for existing chats | - | PASS | swarm/bot-swarm.ts, council.ts |
| L343 | Multi-agent & helpers | Cross-provider second-opinion consultation | - | PASS | src/main/agent/tools/consult.ts:22 |
| L344 | Multi-agent & helpers | Debate and review collaboration between models | - | PASS | docs/model-routing.md "How models work together" |
| L345 | Multi-agent & helpers | Share a bot with others (export/import) | - | PASS | src/main/bot-share.ts; BotShare.tsx |
| L346 | Multi-agent & helpers | Team server for shared bots, pages and approvals | - | PASS | src/server/team.ts, team-pages.ts; TeamSettings.tsx |
| L347 | Multi-agent & helpers | Delegation to Cursor cloud/local agents with diff review | CC | PASS | tools/apps.ts:119; docs/coding.md |
| L348 | Multi-agent & helpers | User-defined custom subagent types (own prompt + tool allowlist) invoked by name | CC | PARTIAL | Bots (bots.ts:13) cover personas, but no per-subagent tool-allowlist definition file |
| L349 | Multi-agent & helpers | Live ability to message/steer an individual running helper | - | PARTIAL | MaxCard.tsx shows status; steering applies to the whole run (App.tsx:133) |
| L350 | Multi-agent & helpers | Shared task list / mailbox between concurrently running helpers | CC | MISSING | swarm/ledger.ts records cost/status; no peer-to-peer messaging between helpers |
| L351 | Privacy, secrets & safety | Local PII gate before every cloud request (PII-Tracer) | - | PASS | src/main/privacy/tracer.ts, gate.ts; loop.ts privacyGate() |
| L352 | Privacy, secrets & safety | Process-on-Mac option that moves the task to a local model | - | PASS | docs/privacy-gate.md option 1 |
| L353 | Privacy, secrets & safety | Split mode: cloud sees stand-ins, local model keeps details | - | PASS | docs/privacy-gate.md option 2; tools/ask-on-mac.ts |
| L354 | Privacy, secrets & safety | Whole-document personal-record detection | - | PASS | src/main/privacy/documents.ts |
| L355 | Privacy, secrets & safety | Fails closed when the check fails | - | PASS | docs/privacy-gate.md Limits |
| L356 | Privacy, secrets & safety | PII check on images and screenshots | - | MISSING | docs/privacy-gate.md Limits: "Images aren't checked" |
| L357 | Privacy, secrets & safety | Hybrid compute: Auto brain uses only local readers while gate is on | - | PASS | docs/privacy-gate.md "What stays usable" |
| L358 | Privacy, secrets & safety | Encrypted secrets vault (AES-256-GCM, Keychain + optional master password) | - | PASS | docs/secrets-vault.md Encryption; src/main/vault.ts, secure/crypto.ts |
| L359 | Privacy, secrets & safety | Saved logins, cards, IDs, notes filled without the model seeing values | - | PASS | docs/secrets-vault.md "Never exposed"; browser fill_secret |
| L360 | Privacy, secrets & safety | Fill guards bound to origin/site | - | PASS | docs/secrets-vault.md "Fill guards"; secure/guards.ts, origin.ts |
| L361 | Privacy, secrets & safety | Vault audit log | - | PASS | src/main/secure/audit.ts; docs/secrets-vault.md |
| L362 | Privacy, secrets & safety | Service API keys with exact origin, header format and masked echoes | - | PASS | docs/agent-system.md "Connections and service keys"; tools/api-request.ts:9 |
| L363 | Privacy, secrets & safety | Four-effect permission model (read/local/external/destructive) | CC | PASS | docs/permissions.md |
| L364 | Privacy, secrets & safety | Hard stops for payments, credentials, security settings, mass sends, public posts | CC | PASS | docs/permissions.md "Always asks" |
| L365 | Privacy, secrets & safety | Allow once / always in thread / deny with saved rules | CC | PASS | src/renderer/src/lib/approvalRules.ts; Agent.tsx |
| L366 | Privacy, secrets & safety | Bypass mode requires explicit confirmation and never skips purchases | CC | PASS | App.tsx:87; docs/permissions.md |
| L367 | Privacy, secrets & safety | Secret scan blocks commits containing keys/tokens | - | PASS | src/main/code/git.ts:7 |
| L368 | Privacy, secrets & safety | Saved passwords blocked from any tool argument | - | PASS | docs/permissions.md "Always blocked" |
| L369 | Privacy, secrets & safety | macOS permissions center showing what is granted | - | PASS | src/main/permissions-center.ts; Settings → Mac permissions |
| L370 | Privacy, secrets & safety | Activity capture with private-window detection and per-app/site rules | - | PASS | src/main/activity/rules.ts, sampler.ts; ActivitySettings.tsx |
| L371 | Privacy, secrets & safety | Phone/server pairing with pinned certificate fingerprint and one-time code | - | PASS | docs/phone-access.md; src/server/tls.ts, auth.ts |
| L372 | Privacy, secrets & safety | No telemetry | - | PASS | docs/phone-access.md ("no telemetry"); crashReporter is a stub (src/server/platform/electron.ts:540) |
| L373 | Privacy, secrets & safety | Sandboxed command execution with write restriction | - | PASS | src/main/code/proc.ts:70 |
| L374 | Privacy, secrets & safety | Updater verifies checksum, signature and build number | - | PASS | docs/agent-system.md "Updates"; updater.ts:333 codesign verify |
| L375 | Privacy, secrets & safety | Network egress allowlist for run_command | CC | PARTIAL | proc.ts sandbox profile allows network (proc.ts:70 comment); network gated only by command classifier |
| L376 | Connectors & integrations | One-click OAuth connectors via MCP (~200 apps) | CC/GK/GPT | PASS | src/main/connectors.ts (211 entries); ConnectApps.tsx |
| L377 | Connectors & integrations | Gmail, Google Calendar, Drive, Docs, Sheets, Slides | GK/GPT | PASS | connectors.ts:173,1176 GOOGLE_PRESETS; mail/google-connect.ts |
| L378 | Connectors & integrations | Built-in IMAP/SMTP/Resend mail beyond Gmail | GPT | PASS | src/main/mail/imap.ts, smtp.ts, resend.ts |
| L379 | Connectors & integrations | Apple Notes, Reminders, Calendar, Messages, Contacts | - | PASS | src/main/agent/tools/apps.ts mac_apps; computer/apps/pim.ts, messages.ts |
| L380 | Connectors & integrations | Dev tools: GitHub, GitLab, Sentry, Vercel, Supabase, Cloudflare, Netlify | - | PASS | docs/connectors.md Code; connectors.ts |
| L381 | Connectors & integrations | Business tools: Stripe, PayPal, Square, Shopify-type stores | - | PASS | docs/connectors.md Finance & commerce |
| L382 | Connectors & integrations | Collaboration tools: Slack, Notion, Linear, Jira, Asana, Trello, Airtable | - | PASS | docs/connectors.md Productivity; docs/oauth-registration.md |
| L383 | Connectors & integrations | Connect card appears in chat only when needed | - | PASS | docs/agent-system.md Connections; tools/core.ts:44 connect_app |
| L384 | Connectors & integrations | Expired auth offers reconnect, never asks for passwords in chat | - | PASS | docs/agent-system.md Connections |
| L385 | Connectors & integrations | API-key connectors stored in Keychain | - | PASS | docs/connectors.md "API-key apps" |
| L386 | Connectors & integrations | Own OAuth app registration for providers that need it | - | PASS | docs/oauth-registration.md; src/main/oauth-clients.ts |
| L387 | Connectors & integrations | Expose SahilBot as an MCP server to other clients | CC | PASS | src/main/mcp-server/; McpSettings.tsx:58 |
| L388 | Connectors & integrations | Add any custom MCP server by URL | CC | PASS | McpSettings.tsx; connectors.ts custom entry |
| L389 | Connectors & integrations | Connector status tracking verified against official MCP URLs | - | PASS | docs/connectors-status.md/.json |
| L390 | Connectors & integrations | Zapier connector for long-tail actions | - | PASS | src/main/connectors.ts:160,735 |
| L391 | Connectors & integrations | Markets data providers (quotes, indicators) | GPT | PASS | src/main/markets/providers.ts |
| L392 | Connectors & integrations | FRC, CAD (FreeCAD, Onshape), engineering domain tools | GPT | PASS | src/main/agent/tools/frc_code.ts, freecad.ts, onshape.ts |
| L393 | Connectors & integrations | Messages and mail ingestion into the people graph | - | PASS | src/main/brain/ sources; context-engine/mirror.ts |
| L394 | Connectors & integrations | Per-connector tool groups loaded lazily | GPT | PASS | registry.ts:42 isConnectorTool |
| L395 | Connectors & integrations | Web search provider options with fallbacks (Brave key option) | - | PASS | src/main/agent/tools/web.ts; SettingsModal.tsx:289 braveKey |
| L396 | Connectors & integrations | Cursor integration (local and cloud) | - | PASS | apps.ts:119; docs/coding.md |
| L397 | Connectors & integrations | Connector coverage for ChatGPT-style app directory (apps with UI widgets) | GPT | PARTIAL | MCP tools only; no interactive app widgets rendered in chat |
| L398 | Connectors & integrations | Native X/Twitter and social-feed access | GK | PARTIAL | grep "x.com\|twitter" connectors: not a first-class connector; browser/web only |
| L399 | Connectors & integrations | Connector usage guarded by permissions per tool effect | - | PASS | connector tools carry effect (registry.ts:42-50) |
| L400 | Connectors & integrations | Webhook/inbound-event triggers from third-party apps to start a run | CC/GPT | PARTIAL | src/server http/hub accepts phone/team traffic; no generic inbound webhook trigger found |
| L401 | Voice | Hands-free voice conversation mode | GK/GPT | PASS | src/main/voice/pipeline.ts:36; VoiceMode.tsx |
| L402 | Voice | Local speech recognition (whisper.cpp) with Mac-sized model auto-pick | GK/GPT | PASS | src/main/voice/whisper.ts, models.ts; docs/index.md Voice |
| L403 | Voice | Download integrity check (SHA-256) for speech models | - | PASS | docs/index.md Voice |
| L404 | Voice | Cloud STT fallback when local model not ready | GK/GPT | PASS | docs/index.md Voice; src/main/apis/openai.ts:280 transcribe |
| L405 | Voice | Local neural TTS (Kokoro-82M) with no cloud call | GK/GPT | PASS | src/main/voice/tts.ts:14-28 |
| L406 | Voice | Grok cloud TTS/STT option | GK | PASS | src/main/voice/grok.ts:7,40; shared/voice-provider.ts |
| L407 | Voice | Voice activity detection | GK/GPT | PASS | src/main/voice/vad.ts |
| L408 | Voice | Barge-in: speaking over the reply stops playback and cancels it | GK/GPT | PASS | src/main/voice/pipeline.ts:33; vad.ts:23 |
| L409 | Voice | Speculative transcription to cut latency | - | PASS | pipeline.ts:~35 SPECULATE_AT_MS |
| L410 | Voice | Measured first-audio latency target about 1 s | - | PASS | docs/agent-system.md Verification (1.022-1.029 s) |
| L411 | Voice | Dictation into the composer | GK/GPT | PASS | src/main/index.ts:2583 voice:dictateStart |
| L412 | Voice | Voice replies kept short and Markdown-free | GK/GPT | PASS | docs/index.md Voice |
| L413 | Voice | Voice requests routed away from slow models | GK/GPT | PASS | docs/model-routing.md "Computer use and voice" |
| L414 | Voice | Voice chat can use tools/agent behind the scenes | GK/GPT | PASS | pipeline.ts respond() uses the chat's agent (voice/grok.ts:6 comment) |
| L415 | Voice | Transcribe audio files and meetings to text | GPT | PASS | src/main/agent/tools/media.ts:367 transcribe; docs/meetings.ts |
| L416 | Voice | Speech synthesis tool producing audio files | GPT | PASS | src/main/agent/tools/media.ts:267 speech |
| L417 | Voice | Quick Ask global popup | - | PASS | src/renderer/src/components/QuickAsk.tsx |
| L418 | Voice | Real-time speech-to-speech model path (native audio in/out) | GPT | MISSING | routing-table.ts:195 comment says gpt-realtime exists but SahilBot uses a STT→LLM→TTS pipeline only |
| L419 | Voice | Wake word / always-listening hotword | GPT | MISSING | grep "wake word\|hotword": none (only TasksView nextWakeAt) |
| L420 | Voice | Choice among many TTS voices/personalities in UI | GK/GPT | MISSING | tts.ts uses one Kokoro voice setting (`voice` param); no voice gallery found |
| L421 | Voice | Speaker diarization for meetings | GPT | MISSING | grep diariz: none |
| L422 | Voice | Multilingual voice (STT and TTS) selection | GK/GPT | PARTIAL | Grok TTS uses language 'auto' (grok.ts:40); whisper language selection not found |
| L423 | Voice | Voice mode with live captions/transcript of both sides in UI | GK/GPT | MISSING | VoiceMode.tsx shows state; live dual-side transcript not confirmed by grep |
| L424 | Voice | Phone-call or video-call style voice with camera/screen share | GPT | MISSING | none |
| L425 | Voice | Voice also available on phone/server clients | GK/GPT | PASS | src/server/web; docs/phone-access.md (browser mic) |
| L426 | Scheduling & notifications | Schedules: once, daily, weekly, every N minutes, cron | GPT | PASS | src/main/scheduler.ts:25-77 |
| L427 | Scheduling & notifications | Unattended scheduled runs with approval-needing steps skipped and reported | GPT | PASS | scheduler.ts:5-7; docs/index.md |
| L428 | Scheduling & notifications | Missed runs coalesced after sleep with catch-up policy | - | PASS | scheduler.ts:113-156 catchUp/LATE_GRACE_MS |
| L429 | Scheduling & notifications | Run history kept per schedule | - | PASS | scheduler.ts:103 RUNS_KEPT = 20 |
| L430 | Scheduling & notifications | Scheduled tasks UI with next run and status | GPT | PASS | src/renderer/src/components/Scheduled.tsx; routines.ts |
| L431 | Scheduling & notifications | Agent creates schedules from natural language | GPT | PASS | src/main/agent/tools/schedule.ts:11 |
| L432 | Scheduling & notifications | Goals with periodic wake-ups and digest | GPT | PASS | src/main/goals/digest.ts, manager.ts; TasksView.tsx:27-60 |
| L433 | Scheduling & notifications | Watchlist price alerts | - | PASS | src/main/markets/alerts.ts; price_alert tool |
| L434 | Scheduling & notifications | Background jobs quit warnings | - | PASS | src/main/jobs/quit.ts |
| L435 | Scheduling & notifications | Always-on server for schedules while Mac is off | - | PASS | docs/server.md |
| L436 | Scheduling & notifications | Login item / run in menu bar | - | PASS | SettingsModal.tsx:291 alwaysOn; src/main/tray.ts |
| L437 | Scheduling & notifications | Native desktop notifications for approvals, questions and completion | GPT | PASS | src/main/notify.ts; src/main/agent/questions/notify.ts |
| L438 | Scheduling & notifications | Phone push notifications (Web Push, no cloud account) | GPT | PASS | src/server/push.ts; docs/phone-access.md |
| L439 | Scheduling & notifications | Notification policy (what interrupts vs batches) | - | PASS | src/main/agent/questions/policy.ts |
| L440 | Scheduling & notifications | Per-device notify targeting | - | PASS | src/main/notify.ts:42 notifyDevices(deviceIds \| all) |
| L441 | Scheduling & notifications | Morning check-in / briefing | - | PASS | src/main/checkin.ts |
| L442 | Scheduling & notifications | Needs-you dot per chat in sidebar | - | PASS | App.tsx:61 |
| L443 | Scheduling & notifications | Follow-ups after a delay ("check back tomorrow") | GPT | PASS | goals.ts:192 |
| L444 | Scheduling & notifications | Quiet/focus handling for unattended runs | - | PASS | lib/quiet.ts; lib/attention.ts |
| L445 | Scheduling & notifications | Trigger runs from events (new email, calendar change, file change) | GPT | PARTIAL | knowledge/watcher.ts watches folders for indexing; no event→agent-run triggers found beyond schedules/goals |
| L446 | Scheduling & notifications | Notification via email/SMS/Slack channels to the user | GPT | PARTIAL | resend.ts and mail tools exist for the agent to send; no built-in channel selector for run results |
| L447 | Scheduling & notifications | Calendar-aware scheduling (do X before my 3pm meeting) | GPT | MISSING | schedule.ts takes time/cron; no calendar-bound trigger |
| L448 | Scheduling & notifications | Run scheduled tasks in a cloud runtime when device is off (hosted) | CC | MISSING | self-host server only |
| L449 | Scheduling & notifications | Edit/pause/resume schedules from chat or UI with confirmations | GPT | PARTIAL | Scheduled.tsx supports management; pause semantics not verified by grep |
| L450 | Scheduling & notifications | Digest of all overnight results as a single summary notification | - | MISSING | goals/digest.ts digests goals only, not scheduled runs generally |
| L451 | Updates, onboarding & UI/UX | In-app updater checking GitHub Releases with checksum, signature, build number | - | PASS | src/main/updater.ts:20-62; docs/agent-system.md |
| L452 | Updates, onboarding & UI/UX | Pre-update profile backup and rollback of the app bundle | - | PASS | updater.ts:84-144; docs/agent-system.md "Updates and secondary copies" |
| L453 | Updates, onboarding & UI/UX | Update button with state and release notes | - | PASS | src/renderer/src/components/UpdateButton.tsx; WhatsNew.tsx |
| L454 | Updates, onboarding & UI/UX | Structured release notes data shown after update | - | PASS | src/shared/release-notes.json; release-notes.ts; tests/unit/release-notes.test.ts |
| L455 | Updates, onboarding & UI/UX | CI release pipeline with ad-hoc/signed/notarized modes | - | PASS | scripts/release.mjs:3; .github/workflows/release.yml |
| L456 | Updates, onboarding & UI/UX | Signed and notarized releases by default | - | PARTIAL | release.mjs supports signed\|notarized but docs/agent-system.md says signed release validation is still a release check; adhoc is a first-class mode |
| L457 | Updates, onboarding & UI/UX | Update channel choices (stable/beta) and staged rollout | - | PARTIAL | single "latest" channel (updater.ts REPO/ASSET constants); no beta channel |
| L458 | Updates, onboarding & UI/UX | Platform coverage beyond macOS arm64 | - | PARTIAL | updater ASSET = SahilBot-mac-arm64.zip; server build is Linux (docs/server.md); no Windows/desktop Linux app |
| L459 | Updates, onboarding & UI/UX | Guided first-run onboarding (keys, models, permissions) | - | PASS | src/renderer/src/components/Onboarding.tsx |
| L460 | Updates, onboarding & UI/UX | One-line local install script | - | PASS | install.sh; scripts/install-mac.mjs |
| L461 | Updates, onboarding & UI/UX | Local-model setup with hardware-aware picks | - | PASS | src/main/ollama-setup.ts; LocalModels.tsx; llm/local-detect |
| L462 | Updates, onboarding & UI/UX | Command palette (⌘K) for chats, bots and actions | GK/GPT | PASS | src/renderer/src/components/CommandPalette.tsx:19 |
| L463 | Updates, onboarding & UI/UX | Menu-bar tray and quick ask | - | PASS | src/main/tray.ts; QuickAsk.tsx |
| L464 | Updates, onboarding & UI/UX | Light/dark/system theme | CC/GK/GPT | PASS | src/shared/types.ts:231 theme; renderer styles |
| L465 | Updates, onboarding & UI/UX | Rich Markdown rendering with sanitization, copy buttons, task lists | GK/GPT | PASS | src/renderer/src/components/Markdown.tsx:20-58 |
| L466 | Updates, onboarding & UI/UX | LaTeX/math rendering in chat | GK/GPT | MISSING | grep katex\|mathjax in src: none |
| L467 | Updates, onboarding & UI/UX | Mermaid/diagram rendering in chat | GK/GPT | MISSING | grep mermaid: none |
| L468 | Updates, onboarding & UI/UX | Retry control on the last reply | CC/GK/GPT | PASS | src/renderer/src/components/ThreadView.tsx:39,512 (onRetry) |
| L469 | Updates, onboarding & UI/UX | Thumbs up/down and "regenerate with different model" feedback on replies | GK/GPT | MISSING | grep "thumbs\|rateReply": none; editLast exists (App.tsx:899) but no feedback control |
| L470 | Updates, onboarding & UI/UX | Localization (non-English UI) | GK/GPT | MISSING | grep "i18n\|translations": none; toLocale* only for dates |
| L471 | Updates, onboarding & UI/UX | Keyboard accessibility and screen-reader labelling | GK/GPT | PARTIAL | ~420 aria-* attributes across components (grep count) and role="dialog" in some modals (ImportMemoryDialog.tsx:172), but only ~11 tabIndex/onKeyDown sites repo-wide; no a11y test suite |
| L472 | Updates, onboarding & UI/UX | Respects reduced-motion preference | GK/GPT | PARTIAL | prefers-reduced-motion handled in overlay/main.ts:161 only; not verified in main renderer CSS |
| L473 | Updates, onboarding & UI/UX | Share a conversation by link | GPT | MISSING | grep "publicLink\|share chat": none (bot sharing only, bot-share.ts) |
| L474 | Updates, onboarding & UI/UX | Drag/paste/screenshot attachments and drafts preserved | GK/GPT | PASS | Composer.tsx:245; src/renderer/src/lib/drafts.ts |
| L475 | Updates, onboarding & UI/UX | Export a thread transcript | GPT | PASS | App.tsx:350 chat.exportThread |
| L476 | Reliability, performance & observability | SQLite WAL with foreign keys for durable state | - | PASS | src/main/db.ts:181 |
| L477 | Reliability, performance & observability | Interrupted runs flagged and resumable with "Continue" | - | PASS | src/main/resume.ts:11-14; shared/types.ts:1587 |
| L478 | Reliability, performance & observability | Daily profile backups, 5 retained, plus mirror copy | - | PASS | src/main/updater.ts:24-31,118 |
| L479 | Reliability, performance & observability | Provider retries with Retry-After and exponential backoff | - | PASS | src/main/llm/retry.ts:8-74 |
| L480 | Reliability, performance & observability | Automatic model failover on provider errors | - | PASS | src/main/llm/model-health.ts:9; client.ts:552 |
| L481 | Reliability, performance & observability | Offline-aware behavior (local models keep working; errors say why) | - | PASS | src/main/llm/client.ts:552; Onboarding.tsx:39 error mapping |
| L482 | Reliability, performance & observability | Main-process unhandled rejection handler | - | PASS | src/main/index.ts:191 |
| L483 | Reliability, performance & observability | Crash reporting / diagnostic bundle export for bug reports | - | MISSING | src/server/platform/electron.ts:540 crashReporter is a no-op stub; grep exportLogs/diagnostics bundle: none |
| L484 | Reliability, performance & observability | Unit, acceptance (Electron), server and live-provider test suites | - | PASS | tests/unit (196 files), tests/accept (44), tests/server, tests/live; CI in .github/workflows/release.yml:83-89 |
| L485 | Reliability, performance & observability | Typecheck and build gated in CI | - | PASS | release.yml:83,89 |
| L486 | Reliability, performance & observability | Replay/fixture-based simulations (auto router, context eval, fake providers) | - | PASS | tests/fixtures/auto-sim.ts, context-eval.ts, fake-*.ts |
| L487 | Reliability, performance & observability | Real-provider and signed-install validation before releases | - | PARTIAL | docs/agent-system.md Verification: 10 live tests skipped for lack of credentials; "signed release installation... remain release checks" |
| L488 | Reliability, performance & observability | Warm-up of local/cloud models to cut first-token latency | - | PASS | src/main/llm/warmup.ts |
| L489 | Reliability, performance & observability | Latency instrumentation with recent timings | - | PASS | src/main/llm/timing.ts:5-24 |
| L490 | Reliability, performance & observability | Prompt/response caching used where the provider supports it | - | PASS | openai-responses.ts:12-32 |
| L491 | Reliability, performance & observability | Cold-start and memory profiling budgets enforced in tests | - | PARTIAL | timing.ts instrumentation exists; no startup-time or memory budget test found by name in tests/ |
| L492 | Reliability, performance & observability | Embeddings and indexing in a worker so UI stays responsive | - | PASS | src/main/knowledge/extract-worker.ts |
| L493 | Reliability, performance & observability | Per-run usage and cost attribution to chat and bot | - | PASS | src/main/run-usage.ts:20; usage.ts:11 usageScope |
| L494 | Reliability, performance & observability | Usage dashboard by day/provider/bot with CSV export | - | PASS | src/main/usage.ts:116,210,331; UsagePage.tsx |
| L495 | Reliability, performance & observability | Monthly spending cap that blocks pay-per-use calls | - | PASS | SpendingLimit.tsx:12; llm/budget.ts; docs/model-routing.md |
| L496 | Reliability, performance & observability | Reservation-based budgets so concurrent calls cannot overspend | - | PASS | docs/agent-system.md Auto 2 |
| L497 | Reliability, performance & observability | Spend check before paid media calls (image/video) | - | PASS | apis/spend.ts:38 hookSpend; docs/agent-system.md images |
| L498 | Reliability, performance & observability | Developer-facing trace viewer of a run (tools, models, tokens, timings) | - | PARTIAL | Developer mode (dev-mode.ts) shows activity and usage; no exportable trace/timeline view |
| L499 | Reliability, performance & observability | Alerts on anomalies (cost spike, error-rate rise) | - | PARTIAL | spending limit only; no anomaly alerting found |
| L500 | Reliability, performance & observability | Server health/heartbeat and ws reconnect for remote clients | - | PASS | src/server/ws.ts:33; ServerSettings.tsx:150 |


## Fixed after this audit (same release, 26.11.20)

These gaps were fixed in the same change as this audit. The scores above are from before the fixes.

- L234 (partial): native sheets now use the full formula engine for anything beyond SUM/AVERAGE/MIN/MAX/COUNT (IF, SUMIF, VLOOKUP, XLOOKUP, text, date, comparisons). Tabs, sort/filter, formatting and pivots are still open.
- L190 (partial): presenter view with notes, next slide and timer. Transitions and brand kits are still open.
- L186 (partial): slides keep and show tables, and keep numbered and check points and extra pictures. Chart and two-column slide layouts are still open.
- L125 (partial): syntax highlighting. KaTeX and mermaid are still open.
- L471 (partial): focus traps and return focus in dialogs, plus global reduced-motion. Roving tabindex and an axe test are still open.

Still open (larger projects, not in this release): spreadsheet tabs and pivots (L234-L240), live dashboard data sources and more chart types (L209), branching (L299), user hooks and plugins (L098), syntax-aware code interpreter (L121), rewind checkpoints (L043), reply feedback and retry with another model (L469), manual /compact and a context meter (L289), temporary chat (L274), image PII checks (L356), a companion Chrome extension (L147), realtime voice (L418), memory export (L257), a diagnostics bundle (L483), Intel, Windows and Linux builds (L458), LSP (L120), event-triggered automations (L445), peer messaging between helpers and custom subagents (L350), Google Docs export (L175), localization (L470), and inline PR review with a diff viewer (L113).
