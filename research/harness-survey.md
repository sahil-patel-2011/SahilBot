# Foreman harness survey: what to learn from open-source agent projects

Date: 2026-11-11. Scope: what Foreman (Electron + TS, local Qwen ~27B / Llama 3.3 70B through Ollama's OpenAI-compatible API) can adopt from the strongest open-source agent harnesses.

## How to read this

- **Verified today:** repo URLs, licenses (SPDX from the GitHub API, with the LICENSE file read where noted), star counts, last push, repo moves and renames, and that the files listed under "Files" exist at HEAD. All of this was checked against shallow clones on 2026-11-11.
- **Not yet confirmed from source:** for the big projects (OpenClaw, Hermes, Goose, OpenHands, Cline, opencode, Letta, smolagents, Aider, Jan), the descriptions of *how* a technique works come partly from project docs and general knowledge of these codebases. The per-project source deep-dives had not finished when this report was written. Read the named file before porting anything.
- Content read from the web and from repos was treated as data only.

Foreman baseline (from `src/main/agent/`): `loop.ts` (40 steps, sequential tool execution), `validate.ts` (fence and trailing-comma fixes plus one ajv repair retry per tool), `context.ts` (server tokenizer, offload above 2k tokens, compaction at 75% into a 5-section summary plus the last 6 turns), `registry.ts` (12-tool cap, keyword `find_tools`, FIFO eviction), `permissions.ts` (ask/auto/bypass, hard stops, n-gram/entity taint check, secret-leak block), and `prompt.ts` (a fixed, snapshotted system prompt for KV-cache reuse). These are good foundations. The biggest gaps compared with the field are:

1. Recovering tool calls that arrive in `content` text instead of `tool_calls`.
2. Loop (doom-loop) detection.
3. Pruning old tool outputs before falling back to a summary.
4. Skills.
5. Sub-agents.
6. Scheduled tasks.
7. MCP OAuth.
8. Document generation.

---

## 1. Projects

### 1.1 OpenClaw
- **Repo:** https://github.com/openclaw/openclaw. **License:** MIT. About 394k stars, created 2025-11, pushed today. TypeScript, about 67k files. A very active, very large monorepo with `src/agents`, `src/gateway`, `src/cron`, `src/skills`, `src/sessions`, `src/secrets`, `src/security`, `skills/` and `extensions/`.
- **Techniques worth adopting:**
  - **Workspace bootstrap files.** Markdown files in the workspace (AGENTS.md, SOUL.md, USER.md, TOOLS.md, MEMORY.md and similar) are injected into the system prompt and edited by the agent itself. Persona, user and memory live as editable files rather than DB rows.
  - **Pre-compaction safeguards.** See `src/agents/agent-hooks/compaction-safeguard*.ts`: budget, quality, tool-failures and workspace-context checks. Compaction is guarded so that failed tool calls and workspace context survive it, and `compaction-instructions.ts` holds the prompt.
  - **Before-tool-call policy pipeline.** A whole family of files: `src/agents/agent-tools.before-tool-call.{policy,decision,approval,state,wrapper}.ts`. Every tool call goes through a policy, then a decision, then an approval step, wrapped once. This is the same shape as Foreman's `decide()`, but pluggable.
  - **Sub-agents with completion "announce".** See `src/agents/subagents/announce/*` (delivery, retry, handoff, descendant-wake). Spawned sessions report their result back into the parent session as a message, with retry and wake-up of waiting ancestors. This is the pattern for "multiple bots that talk to each other".
  - **Cron and heartbeat.** `src/cron/` (about 660 files) runs scheduled agent turns into a session.
  - **Skills.** `src/skills/` plus a top-level `skills/` folder of SKILL.md bundles, with gating on required binaries or env.
- **Files to port:** `compaction-safeguard-tool-failures.ts` and `compaction-instructions.ts` (prompt and guard logic), the before-tool-call pipeline shape, and the subagent announce/delivery flow (as design, not code; it is gateway-coupled).
- **License for copying:** MIT allows copying into closed or MIT code. Keep the copyright notice and license text, for example in a `THIRD_PARTY_NOTICES` file.

### 1.2 Hermes Agent (Nous Research)
- **Repo:** https://github.com/NousResearch/hermes-agent. **License:** MIT. About 263k stars, created 2025-07, pushed today. Python core plus a TS desktop app (`apps/desktop`), about 25k files.
- **Techniques worth adopting:**
  - **Staged context compressor.** Split across `agent/context_compressor_{prune,summary,tail,window,prellm,retry,prompt_rules,telemetry}.py`. It prunes tool outputs first, summarizes the middle, protects the head and tail, and retries if the summary fails. This order (prune, then summarize, then protect the tail) is the main upgrade available for Foreman's single summary step.
  - **Tool-call recovery helpers.** `agent/chat_completion_helpers_tool_calls.py` and `agent/tool_call_batches.py` normalize tool calls from open models (Hermes-style `<tool_call>{json}</tool_call>` in content) and batch them.
  - **Pluggable memory.** `agent/memory_manager.py`, `memory_provider.py`, `memory_context.py` and `memory_manager_tools.py` define a provider interface (built-in file memory or external) plus agent-facing tools.
  - **Self-improving skills.** `agent/skill_bundles.py`, `skill_preprocessing.py` and `skills_index_delta.py`, with `skills/` and `optional-skills/`. The agent can write or curate skills after a task, and a skills index is diffed into context.
  - **Delegation with guards.** `tools/delegate_tool*.py`: child run, dispatch, config, and a "prefix gate" that limits what a child may do.
  - **Cron with a prompt-injection scan.** `tools/cronjob_tools.py`, `cronjob_job_args.py` and `cronjob_prompt_scan.py` scan scheduled prompts before they run unattended. That scan is directly relevant to Foreman's taint model.
  - **Batch approvals.** `agent/terminal_approval_batch.py` and `gateway/approval_actor.py` allow several pending approvals to be approved at once.
  - **Browser.** `tools/browser_cdp_tool.py`, `browser_session_*`, and `browser_real_profile_logins.py` (reusing a real profile's logins).
- **Files to port (to TS):** the compressor stage split, the tool-call normalization helpers, `cronjob_prompt_scan.py`, and the delegate prefix gate.
- **License:** MIT, same terms as OpenClaw (keep the notice).

### 1.3 "jev.dev": what it actually is
- **https://jev.dev** redirects (308) to the personal site of Jev Forsberg, an engineering manager at Grafana Labs. It is not an agent project.
- **"Jev" in the agent world** is **TypeSafe AI's hosted "System One" decision model** (closed weights). You give it state plus a *typed question* and it returns a *typed decision* (choice, yes/no, or score) with a confidence. It is not a chat model. The likely meaning of "jev.dev" is this ecosystem. Jan.ai (below) is the other plausible reading, and it is covered too. The open-source pieces that matter:
  - **browser-use/jev-ultrafast** (MIT, about 24k stars). A browser agent that acts on a numbered element table with a fixed op set (`CLICK, TYPE_TEXT, SELECT, SCROLL_UP, SCROLL_DOWN, WAIT, DONE, BLOCKED`). A decision model picks the op and target, and a small LLM writes text only for `TYPE_TEXT`. It is now folded into browser-use as `mode='ultrafast'`.
  - **nokia-applied-research/AnyJev** (Apache-2.0, about 1.6k stars, arXiv 2610.00831). "Jev-style" typed decisions from *any* LLM's logprobs, with no training. It reads a K-option choice over cyclic rotations of the option order and divides out the label prior ("L0"). It reports Qwen3-8B order-flip dropping from 0.23 to 0.07 with higher accuracy. An adaptive mode sends only low-margin decisions (top-2 log-prob gap below tau) to chain-of-thought, with a cap on that share.
  - **tamaratran/fast-jev-compaction** (MIT, TS, about 7.9k stars). Verbatim compaction: no summary. For each old tool call it asks two yes/no questions ("keep the call?", "keep the result verbatim?") and then keeps, truncates or drops. User and assistant text is never rewritten. `src/compact.ts` (309 lines) and `src/state.ts` (304 lines, staged fitting of the state into a token budget) are cleanly separated from the Jev client by a `JevAsker` interface (`asker.ask(state, questions)`), so a local-model asker can be swapped in.
- **Relevance to a local 27B model:** large. Many harness decisions (is the task done, is this tool result still needed, which tool group to load, is this action risky) can be posed as typed questions to the *same local model* and read from logprobs. That is cheaper and more reliable than free-text JSON. Ollama added `logprobs`/`top_logprobs` to its native and OpenAI-compatible APIs in v0.12.11. Support is per model, so verify with Qwen in your build.
- **License:** fast-jev-compaction is MIT, so `compact.ts` and `state.ts` can be copied with the notice. AnyJev is Apache-2.0 Python; port the algorithm (rotation plus prior division) rather than the code, or keep NOTICE and attribution if you translate it closely.

### 1.4 Goose
- **Repo:** https://github.com/aaif-goose/goose (moved from block/goose). **License:** Apache-2.0. About 56k stars, pushed today. Rust, about 2.6k files.
- **Techniques worth adopting:**
  - **Toolshim.** For models with weak native tool calling, a second small "interpreter" model turns the main model's text into tool calls. This is documented Goose behavior; I did not find the file by name grep, so look under `crates/goose/src/providers`.
  - **Context management.** `crates/goose/src/context_mgmt/mod.rs` handles auto-summarize and truncation.
  - **Recipes and sub-recipes.** `crates/goose-cli/src/recipes/*` and `crates/goose/src/acp/server/recipe/*` define parameterized, shareable task definitions (instructions, extensions, params, sub-recipes). They work like skills plus a template.
  - **Sub-agents.** `crates/goose/src/agents/subagent_handler.rs`, `subagent_task_config.rs` and `subagent_execution_tool/*` run tasks in parallel or sequence and emit notification events.
  - **Scheduler.** `crates/goose/src/agents/schedule_tool.rs`, `platform_extensions/scheduler.rs` and `goose-cli/src/commands/schedule.rs`. The agent can schedule its own recipes on cron.
  - **Permissions.** `crates/goose/src/config/permission.rs` sets per-tool always/ask/never, plus a "smart approve" mode that uses the LLM to classify read-only versus write calls.
  - **MCP extensions with an OAuth flow.** See `crates/goose/examples/databricks_oauth.rs` for the provider side.
- **License:** Apache-2.0 allows copying into closed source. You must include the license text, keep any NOTICE file contents, and mark modified files as changed. Porting from Rust to TS is effectively a reimplementation; still credit it.

### 1.5 OpenHands
- **Repo:** https://github.com/OpenHands/OpenHands (moved from All-Hands-AI). **License:** MIT at the top level. Check for an `enterprise/` directory under a different license before copying. About 93k stars, pushed today. The agent core has largely moved to the separate OpenHands software-agent SDK; this repo is now mostly the app (TS front end, `src/routes/condenser-settings.tsx`).
- **Techniques worth adopting** (from the SDK and docs; confirm in the SDK repo):
  - **fn_call_converter.** Converts native function calling to a text format and back, for models without function calling, with in-context examples of the format.
  - **Condensers.** LLM-summarizing, observation-masking ("replace old observations with `<MASKED>`"), and amortized forgetting.
  - **Stuck detector.** Detects repeated identical action/observation pairs, repeated errors, and monologues.
  - **Security analyzer plus confirmation mode.** The LLM rates the risk of each action.
  - **Microagents.** Keyword-triggered markdown snippets.
  - **Task tracker tool.**
- **License:** MIT. Keep the notice.

### 1.6 Cline
- **Repo:** https://github.com/cline/cline. **License:** Apache-2.0. About 72k stars, pushed today. TypeScript monorepo (`apps/vscode`, `apps/cli`, `sdk/packages/core`).
- **Techniques worth adopting:**
  - **XML-in-text tool use.** Tools are written as `<tool_name><param>…</param></tool_name>` inside the assistant text and parsed while streaming, which tolerates partial blocks. This is historically why Cline works with models that have poor native tool calling.
  - **Plan/Act modes.**
  - **Focus chain (todo) re-injected periodically.**
  - **Auto-condense.** `sdk/packages/core/src/extensions/context/summarize-conversation.ts`.
  - **Auto-approve UX.** `apps/vscode/webview-ui/src/components/chat/auto-approve-menu/*`: per-category toggles (read, edit, commands, browser, MCP) in a bar above the composer, plus `apps/cli/src/acp/auto-approve.ts`.
  - **MCP hub and marketplace.** `apps/vscode/src/services/mcp/McpHub.ts`.
  - **Rules, workflows and checkpoints.** `.clinerules` and workflows (markdown procedures invoked by `/name`), plus checkpoints.
- **Files to port:** the auto-approve category model and UI, `summarize-conversation.ts` (prompt), and the McpHub connection lifecycle (reconnect, status, tool listing).
- **License:** Apache-2.0. Include the license, preserve NOTICE, and mark changes. Direct TS ports are feasible.

### 1.7 opencode
- **Repo:** https://github.com/anomalyco/opencode (moved from sst/opencode). **License:** MIT. About 226k stars, pushed today. TypeScript, about 11.6k files, with the core in `packages/core`.
- **Techniques worth adopting:**
  - **Compaction with pruning.** `packages/core/src/session/compaction.ts` prunes old tool outputs (keeping recent ones), and summarizes only when pruning is not enough.
  - **Per-model system prompts.** `packages/core/src/session/system-prompt.ts` and `session/runner/prompt/system.txt` select a prompt variant per model family.
  - **Permissions.** `packages/core/src/permission/saved.ts` and `permission/sql.ts` store allow/ask/deny rules per tool with wildcard patterns, persisted in SQL. Front end: `packages/app/src/session/requests/permission-machine.ts` and `session-permission-dock.tsx`.
  - **Todo tool.** `packages/core/src/tool/todowrite.txt` and `tool/plugin/todo.ts` (the tool description is a long, example-rich prompt), with a UI pill (`packages/app/src/session/composer/todo-pill.tsx`).
  - **MCP OAuth.** `packages/core/src/mcp/oauth.ts`: dynamic client registration, PKCE, a local callback, and token storage.
  - **Agents and the task tool.** Agents are markdown definitions with their own tool and permission sets. A sub-agent is invoked through a `task` tool.
  - **Tool-call repair.** Lower-cases or fuzzy-matches unknown tool names and routes irreparable calls to an "invalid" tool that returns guidance.
  - **Doom-loop detection.** The same tool with the same args three times triggers a permission ask.
- **Files to port:** `compaction.ts` (prune logic), `mcp/oauth.ts`, `permission/saved.ts`, and `todowrite.txt`. The same stack (TS plus SQL) makes these the easiest direct ports in this survey.
- **License:** MIT. Keep the notice.

### 1.8 browser-use and browser-harness
- **browser-use:** https://github.com/browser-use/browser-use. **License:** MIT. About 121k stars, pushed today. Python, recently rewritten and now small (about 141 files).
  - Files: `browser_use/agent/loop.py`, `agent/prompt.py`, `ax.py` (accessibility-tree serializer), `tools.py`, `repl/network_idle.py`, `repl/captcha.py`, `repl/highlight.py`, `repl/page_info.py`, `skills/browser-use/SKILL.md`, `domains.py` (domain allow-listing).
- **browser-harness:** https://github.com/browser-use/browser-harness. **License:** MIT. About 19k stars. Handles the CDP connection to a real Chrome.
- **Techniques worth adopting:**
  - **Numbered element table.** Interactive elements only, as `[i] role name · value`, regenerated every step, with a small, typed op set. This is the "ultrafast" design from jev-ultrafast.
  - **Decide op and target first, write text second.** The model chooses the operation and target, and free text is generated only for typing.
  - **Network-idle waiting** before snapshotting.
  - **Domain allow-lists.**
  - **Explicit `BLOCKED` and `DONE` ops**, so the model can say it is stuck instead of looping.
- Foreman already has AX refs. Compare the element filter in `ax.py` and the `network_idle.py` heuristics against your manager.
- **License:** MIT. Keep the notice.

### 1.9 Open Interpreter
- **Repo:** https://github.com/openinterpreter/openinterpreter. **License:** Apache-2.0. About 69k stars, pushed 2026-11-11. It has been **rewritten in Rust** (about 8.7k files) and is no longer the Python `interpreter` package.
- **Ideas:** code execution as the universal tool, local-model profiles, and computer use. For Foreman, the transferable ideas are "run a script to make the document" (see section 2.10) and the per-model profile concept.
- **License:** Apache-2.0, with obligations as in 1.4.

### 1.10 Letta (MemGPT)
- **Repos:** https://github.com/letta-ai/letta is now a stub (Apache-2.0; the V1 server lives on the `archive` branch). Current source: https://github.com/letta-ai/letta-code. **License:** Apache-2.0, TS, about 3.8k stars, pushed today.
- **Ideas:**
  - **Core memory blocks.** Labelled, size-limited blocks such as `persona` and `human`, always in context, that the agent edits with `memory_replace`/`memory_insert`/`memory_rethink`.
  - **Archival memory.** Searchable.
  - **Sleep-time agents.** A background agent consolidates memory between conversations.
- Foreman's flat "one sentence per memory" store would benefit from (a) a small always-in-context block with a character budget and (b) a background consolidation pass.
- **License:** Apache-2.0.

### 1.11 smolagents
- **Repo:** https://github.com/huggingface/smolagents. **License:** Apache-2.0. About 30k stars, pushed 2026-11-10.
- **Ideas:**
  - **Planning interval.** Every N steps the agent writes or updates a plan with "facts known / facts to look up / plan" sections. Templates are in `src/smolagents/prompts/*.yaml`.
  - **ToolCallingAgent text parsing** for models without function calling.
  - **`final_answer` checks.** Validators run before the agent is allowed to finish.
  - **Managed agents.** An agent exposed as a tool with a name and description.
  - **CodeAgent.** Code as the action.

### 1.12 Aider
- **Repo:** https://github.com/Aider-AI/aider. **License:** Apache-2.0. About 50k stars, last push 2026-05-22 (slowing).
- **Ideas:**
  - **Per-model settings table.** `aider/resources/model-settings.yml` records quirks per model: whether to send examples as a system message, where to put the reminder, the edit format, temperature, and extra params. Foreman's `llm/catalog.ts` is the natural place for an equivalent.
  - **Fuzzy search/replace.** `aider/coders/search_replace.py` matches edits tolerantly, which weak models need when editing files.
  - **Chat-history summarization.** `aider/history.py`.
  - **Repo map.** `aider/repomap.py` (tree-sitter plus PageRank).
  - **Architect/editor two-model mode.**
  - **Reflection.** Lint and test errors are fed back to the model automatically.

### 1.13 Jan
- **Repo:** https://github.com/janhq/jan. GitHub reports NOASSERTION, but the LICENSE text is **Apache-2.0** ("Copyright 2025 Menlo Research") with an added *request* for attribution in user-facing docs. About 46k stars, pushed today. Tauri/Rust plus TS.
- **Ideas:** the closest product analogue to Foreman: a local-first desktop app with llama.cpp engine management, an MCP client with per-tool permission prompts, assistants, and context-size auto-fitting. Use it for UX comparison more than harness code.
- **License:** Apache-2.0. Honor the attribution request in an About/credits screen.

### 1.14 Anthropic public guidance (what to encode)
- **"Effective context engineering" (2025-09-29).** Clear tool results first ("one of the safest lightest touch forms of compaction"), then compact. Keep structured notes (NOTES.md or todo) outside the context. Use just-in-time retrieval by reference. Have sub-agents return 1-2k-token digests. Write the prompt at the right "altitude".
- **"Writing effective tools for agents" (2025-09-11).** Namespace tools (`gmail_search`). Offer a `response_format` of concise or detailed. Paginate and truncate with guidance on how to narrow. Write actionable error messages with an example of valid input. Consolidate workflow-level tools. Evaluate with realistic multi-call tasks.
- **"Multi-agent research system" (2025-06-13).** Orchestrator and workers. Each sub-task carries objective, output format, tools and boundaries. Effort-scaling rules in the prompt: about 1 agent for simple tasks, 2-4 for comparisons. Store the plan in memory. Multi-agent runs use about 15x the tokens of chat.
- **"Agent Skills" (2025-10-16).** SKILL.md with `name` and `description` frontmatter. Progressive disclosure: metadata goes in the system prompt, the body is read on demand, and linked files are read when needed. Skills can bundle scripts. Spec at agentskills.io.
- **"Code execution with MCP" (2025-11-04).** Expose MCP tools as code or files and discover them progressively. Filter data in code. Tokenize PII before it reaches the model.
- **"Effective harnesses for long-running agents" (2025-11-26).** An initializer session, then incremental sessions. Progress files. A JSON feature list (models overwrite it less than Markdown). One feature per session. A startup routine.
- **"Harness design for long-running application development" (2026-03-24).** Planner, generator and evaluator. A separate, skeptically tuned evaluator, because models grade their own work too generously. Context resets with file handoffs versus compaction. Remove harness parts one at a time to find what is load-bearing.
- **"Managed agents" (2026-04-08).** Treat the session as an append-only event log outside the context window, which allows crash resume. Keep credentials out of the sandbox and inject them through a proxy, as Foreman's vault already does.

---

## 2. Cross-cutting techniques for a local 27B model

### 2.1 Tool-call parsing and repair
Foreman only repairs *arguments*. Local models through Ollama sometimes put the call in `content` (`<tool_call>{…}</tool_call>`, a fenced JSON block, `<function=name>{…}</function>`, Llama `<|python_tag|>`) when Ollama's template parser misses it. Add a content-side recovery step: if `tool_calls` is empty and the content matches a known tool-call shape whose name is a registered tool, convert it into a call (see Hermes, Cline and OpenHands).

Also add these, mostly from opencode:
- Fuzzy name repair (case, `-`/`_`, a near-miss Levenshtein of 2 or less against loaded tools).
- Coercion of stringified JSON args (`"{\"a\":1}"`) and of numbers or booleans sent as strings.
- A "did you mean" hint listing the closest tool's schema.

### 2.2 Prompt structure
Keep Foreman's snapshotted prompt; it is right for KV-cache reuse. Add two things:
- A per-model variant table (Aider's model-settings, opencode's system-prompt), for example a shorter prompt and reminder placement for Qwen.
- A short "reminder" appended near the *end* of the context when the todo list exists. Weak models follow recent text better.

### 2.3 Planning and todo
Re-inject the current todo state every N steps or after compaction (Cline's focus chain, smolagents' planning interval). Use the long, example-rich todo tool description (opencode `todowrite.txt`). Require that every item is closed before final answer.

### 2.4 Context and memory
The order, from Anthropic, Hermes, opencode and fast-jev-compaction:
1. Mask or prune old tool outputs, keeping the call line ("t12 fetch_page url=… → ok 4.2k chars, id=r-…").
2. Drop calls judged irrelevant (typed yes/no).
3. Summarize only if still over budget.

Foreman's `read_result` ids make pruning lossless, because the model can re-read. For memory, add a Letta-style always-in-context block with a character budget and a periodic consolidation pass.

### 2.5 Sub-agents and multi-bot
Add a `delegate` (task) tool:
- The child gets a fresh context, a restricted tool and permission set (the agent definition is markdown), and a required output format.
- It returns a digest of 2k tokens or less, plus `read_result` ids for full outputs.
- Bots talk through the parent or files (OpenClaw announce, Anthropic file handoffs).

Locally, run children **sequentially**, since one GPU and parallel runs thrash the KV cache. Use a separate evaluator pass ("verify the deliverable against the request") for multi-step tasks.

### 2.6 Skills
Implement the agentskills.io SKILL.md format: frontmatter `name` and `description`, a list of descriptions in the system prompt (or via `find_tools`), the body read on demand, and bundled scripts.

The highest-leverage version for a 27B model is *procedures written by a stronger model, or by the user, and executed by the local one*. Add Hermes-style "save this as a skill" after a successful task, with user approval.

### 2.7 Browser
Foreman's AX snapshot with refs is already the right family. Additions:
- An explicit typed op set with `DONE` and `BLOCKED`.
- "Op and target first, text second."
- Network-idle waits.
- A per-step diff marker for new elements.
- Domain allow-lists for auto mode.

### 2.8 Permission and approval UX
Add:
- Wildcard rules per tool and argument pattern, persisted in SQLite (opencode).
- Per-category auto-approve toggles in a bar (Cline).
- Batch approve of several pending calls (Hermes).
- An LLM or typed-decision "smart approve" for classifying read versus write on MCP tools without annotations (Goose).
- Doom-loop detection: the same call three times triggers an ask, or tells the model to change approach.

### 2.9 Scheduled tasks
Add a `schedules` table (cron expression, prompt, space, permission mode, last run). Electron's main process runs due jobs into a dedicated thread. Rules for unattended runs:
- They default to **auto mode with no external writes**, unless the user pre-approved specific tools when creating the schedule.
- Scan the stored prompt for injection when it is saved (Hermes `cronjob_prompt_scan.py`).
- Catch up on missed runs after the Mac wakes.

### 2.10 MCP connectors and OAuth
Foreman already depends on `@modelcontextprotocol/sdk`. That SDK ships an OAuth client (discovery, dynamic client registration, PKCE) as part of its streamable-HTTP client auth support.

Pattern from opencode `mcp/oauth.ts`:
1. Open the system browser with `shell.openExternal`.
2. Receive the callback on a loopback server at `127.0.0.1:<port>`, or through a custom protocol handler (`foreman://oauth/callback`, registered with `app.setAsDefaultProtocolClient`).
3. Store tokens in the vault or Keychain, never in the model context.

Also show per-connector status and a reconnect button (Cline McpHub). Namespace MCP tools (`gmail_search`) per Anthropic's guidance.

### 2.11 Document generation
Anthropic's `anthropics/skills` document skills are now **Apache-2.0** (verified in `skills/{docx,pptx,xlsx,pdf}/LICENSE.txt`). They are the best reference:
- **docx:** create with the `docx` npm package, edit by unzipping and changing the XML.
- **pptx:** create with `pptxgenjs`.
- **xlsx:** openpyxl, with LibreOffice for recalculation.
- **pdf:** pypdf and reportlab.

They are Python- and CLI-heavy (LibreOffice, pandoc, Poppler). For Foreman, prefer **Node-native libraries the local model can drive through a structured tool** rather than having the model write scripts:
- `docx` (MIT) for Word.
- `pptxgenjs` (MIT) for PowerPoint.
- `exceljs` (MIT) for Excel.
- PDF: `pdf-lib` (MIT), or render HTML/Markdown to PDF with Electron's `webContents.printToPDF` (no dependency).

Give the model a JSON document spec (headings, paragraphs, tables, bullet lists, images) and render it deterministically. That is far more reliable for a 27B model than free-form library code. Port the *gotchas* text from the skills (US Letter versus A4, pptxgenjs mutating option objects, `_xlfn.` prefixes) into the renderer itself. Keep Apache NOTICE and attribution if you copy text.

---

## 3. Prioritized changes for Foreman

Effort scale: S is under a day, M is 1-3 days, L is about a week.

1. **Recover tool calls from content text and fix names and args (S-M).** Sources: Hermes `agent/chat_completion_helpers_tool_calls.py`, Cline's text tool parser, OpenHands fn_call_converter, opencode repair.
   - Why it helps a 27B model: this is the single largest failure mode with Qwen and Llama on Ollama. Calls land in `content`, and names or args come out slightly wrong. Today these silently end the run.
   - Where: `llm/client.ts` and `validate.ts`. No new dependency.
2. **Doom-loop and stuck detection (S).** Sources: opencode, OpenHands stuck detector, browser-use `BLOCKED`.
   - Hash (tool, args). If the same call repeats three times, or the same error repeats, inject "you are repeating; change approach or ask the user", then force `ask_user`.
   - Why: small models loop and burn the 40 steps.
3. **Prune before summarizing; verbatim compaction (M).** Sources: opencode `session/compaction.ts`, Hermes `context_compressor_prune.py`, fast-jev-compaction `src/compact.ts`/`state.ts` (MIT), and Anthropic's "tool result clearing".
   - Replace old tool outputs with one-line stubs plus `read_result` ids, and only then run the 5-section summary.
   - Why: summaries lose paths and numbers, and 27B summaries are lossy.
   - No dependency.
4. **Typed-decision helper on the local model (M).** Sources: the Jev/AnyJev idea (algorithm; Apache-2.0 for any code).
   - `decide(state, question, options)` reads Ollama `logprobs` over one-token labels. Use two rotations to cancel position bias. If logprobs are unsupported, fall back to `response_format` JSON-schema.
   - Use it for: keep or drop in compaction, "is the task done?", smart-approve, `find_tools` routing.
   - Why: a 27B model is much more reliable on a constrained single-token choice than on free-form JSON.
   - Requires Ollama 0.12.11 or later; verify per model.
5. **Skills (SKILL.md) with progressive disclosure (M).** Sources: Anthropic Agent Skills spec, OpenClaw `skills/`, Hermes skills, Goose recipes, Cline workflows.
   - Load skills from `~/Foreman/skills/*/SKILL.md`, list their descriptions, and read the body on demand. Add an opt-in "save as skill" step after a successful task.
   - Why: weak models do well with written procedures.
   - Frontmatter parsing needs a YAML parser. Use `yaml` (ISC) as a **new dependency**, or hand-parse the simple `key: value` case.
6. **Todo re-injection plus a completion gate (S).** Sources: Cline focus chain, smolagents planning interval, opencode `todowrite.txt`.
   - Append the current todo list as a trailing reminder every 5 steps and after compaction. Refuse a final answer while items are open (or ask once).
7. **Sub-agent `delegate` tool and evaluator pass (M-L).** Sources: OpenClaw subagents/announce, Hermes `tools/delegate_tool*.py`, Goose `subagent_handler.rs`, Anthropic orchestrator-worker and evaluator.
   - Fresh context, restricted tools, a required digest of 2k tokens or less, results via `read_result` ids. Run children sequentially.
   - Add an optional "verifier" child that checks deliverables against the request.
   - Why: it keeps the main 27B context small and catches over-claimed completion.
8. **Permission rules with wildcards, category auto-approve and batch approve (M).** Sources: opencode `permission/saved.ts`/`sql.ts`, Cline auto-approve menu, Hermes `terminal_approval_batch.py`.
   - Persist rules such as `browser:navigate *.google.com → allow` and `gmail_send * → ask`.
   - Why: fewer prompts without widening bypass. No dependency.
9. **Scheduled tasks (M).** Sources: OpenClaw `src/cron/`, Hermes `tools/cronjob_tools.py` and `cronjob_prompt_scan.py`, Goose `schedule_tool.rs`.
   - A SQLite `schedules` table, a main-process ticker, and a restricted default permission profile for unattended runs.
   - Cron parsing: `croner` (MIT, zero dependencies) as a **new dependency**, or support only a fixed set of intervals without one.
10. **MCP OAuth sign-in (M).** Sources: opencode `packages/core/src/mcp/oauth.ts`, Cline `McpHub.ts`.
    - Use the OAuth provider support in `@modelcontextprotocol/sdk`, already a dependency. Add a loopback or custom-protocol callback, keep tokens in the vault, and show connector status and reconnect.
11. **Document generation tool from a JSON spec (M).** Source: Anthropic `skills/docx|pptx|xlsx|pdf` (Apache-2.0) for gotchas and structure.
    - One `make_document(format, spec)` tool, rendered deterministically.
    - **New dependencies:** `docx`, `pptxgenjs` and `exceljs` (all MIT). For PDF, use Electron `printToPDF` (no dependency) or `pdf-lib` (MIT).
12. **Per-model settings table (S).** Source: Aider `aider/resources/model-settings.yml`, opencode per-model prompts.
    - Extend `llm/catalog.ts` with per-model prompt variant, reminder placement, tool-call recovery format, logprob support, and temperature or other sampling for tool steps.

Smaller wins, if time allows: a Letta-style memory block with a size budget plus consolidation; browser `DONE`/`BLOCKED` ops and network-idle waits (browser-use `repl/network_idle.py`); namespaced connector tools and a `response_format` of concise or detailed (Anthropic).

---

## 4. License summary

| Project | SPDX | Copy into closed or MIT app? | Obligations |
|---|---|---|---|
| OpenClaw | MIT | Yes | Keep copyright and license text |
| Hermes Agent | MIT | Yes | Same |
| opencode (anomalyco) | MIT | Yes | Same |
| OpenHands | MIT (check `enterprise/` and other subdirectories) | Yes, for MIT parts | Same |
| browser-use, browser-harness, jev-ultrafast | MIT | Yes | Same |
| fast-jev-compaction | MIT | Yes | Same |
| Goose, Cline, Letta(-code), smolagents, Aider, Open Interpreter, AnyJev | Apache-2.0 | Yes | Include the license; keep NOTICE contents; state changes in modified files; no trademark use |
| Jan | Apache-2.0 text (GitHub shows NOASSERTION) | Yes | As above, plus a *requested* attribution in user-facing docs |
| anthropics/skills document skills (docx/pptx/xlsx/pdf, skill-creator) | Apache-2.0 (per-skill LICENSE.txt) | Yes | As Apache-2.0 |
| anthropics/claude-code | No OSS license | No | Read as reference only |
| TypeSafe Jev model | Proprietary hosted service | Not applicable | Conflicts with local-first; replicate the pattern locally |

Practical step: add `THIRD_PARTY_NOTICES.md` to the app bundle (and to `extraResources`) and list every project you port from. Reimplementing an *idea* creates no obligation. Translating code closely, for example Python to TS, should be treated as a derivative work.

## 5. Possible new npm dependencies

- `docx`, `pptxgenjs`, `exceljs` (all MIT): document generation.
- Optional `pdf-lib` (MIT); Electron's `printToPDF` covers most PDF needs.
- `croner` (MIT): cron expressions.
- `yaml` (ISC): SKILL.md frontmatter (optional).
- None are needed for items 1-4, 6-8, 10 and 12.
