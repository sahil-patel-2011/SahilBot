# Agent system and everyday chat

SahilBot starts as one automatic Agent. A request can use tools, other bots or specialists with different available models. Users can choose a model and thinking level independently in the menu below the composer, including in bot/group chats, and return either choice to Auto. Changes apply at the next model step; an in-flight provider response is allowed to finish. Models inherit the same stored chat, plan, notes and tool observations, with a handoff note when the answering model changes. Only users can rename bots.

“Plan first” in a user's request opens the plan flow and blocks mutations until approval. “Use an agent swarm” asks for teamwork; the orchestrator chooses the appropriate team, divergent swarm, review or judged attempts. The old Council and Max execution paths remain readable for existing chats, under the Agent swarm presentation. Routine homework uses the school-work routing signal so a chemistry mole is not mistaken for a medical symptom. Provider/model availability, user overrides, context capacity and budgets still apply.

Normal chat shows messages, useful outputs, consequential action receipts and needed approvals. Developer mode in Settings → Advanced shows tool activity, model selection, reasoning and usage diagnostics. The running timer starts at the current prompt, rather than each tool call. Model reasoning is never required for cross-provider continuity.

Image requests load the image tool automatically. Generation uses an enabled OpenAI key, or Grok Imagine with an enabled xAI key when OpenAI is unavailable; a model override can select Grok explicitly. Grok generation saves JPEGs. Editing, transparent backgrounds and PNG/WebP output use OpenAI. Both routes check the spending cap before sending a paid request. xAI request parameters and prices were checked against its [image documentation](https://docs.x.ai/developers/model-capabilities/images/generation) and [model pricing](https://docs.x.ai/developers/models/grok-imagine-image-2.0).

## Harness capabilities

1. **Durable execution:** SQLite records a run and each tool action before execution. Completed same-call results can replay after interruption. Interrupted mutations remain uncertain until reconciled using an actual read receipt; reads can be retried. Missing top-level tool results are repaired without inserting orphan nested-tool messages.
2. **Acceptance checks:** `agent_control` configures checks, phases and stricter limits. Tests, document review and explicit receipt comparisons create evidence. Failed, missing or stale required checks block a verified completion claim. The UI distinguishes checked work from unresolved verification.
3. **Structured workflows:** `workflow` runs bounded dependency graphs of calls, select/filter/map/join operations and JSON Pointer references. Every nested call goes through normal validation, permissions, taint checks and the action ledger. Completed nodes are checkpointed for resume.
4. **Isolated specialist work:** `task_graph` assigns dependent tasks and optional model choices. Read workers have read-only tools. Coding workers use separate Git worktrees from committed HEAD; parent uncommitted/untracked edits are not copied. Worker output remains evidence to review before merging through ordinary tools.
5. **Evaluation workbench:** `agent_evaluate` compares up to three available models against recorded observations and optional expected text/tools. It never runs live tools during replay, respects local-only boundaries and inherits resource caps. Exploratory replay is not a passing test or proof of current external state.

## Memory capabilities

1. **Unified recall:** memories, exact passages from scoped chats, attached files and knowledge notes are fused using keyword/BM25 ranking and, when available, local embeddings. Other bots' private transcripts stay outside recall. Stored vectors do not replace their permission-filtered source.
2. **Conditional preferences:** `preference` stores the user's own words with task, audience, application and output conditions. Explicit current instructions win, then project/bot/global preferences. A preference cannot grant permission to act.
3. **Versioned facts:** newer evidence cannot be overwritten by an older source indexed later. `memory_history` and context-engine temporal records retain superseded facts as historical evidence. Forgetting sources or facts also removes the relevant history/vector records.
4. **Project state:** `project_memory` records requirements, decisions, questions, artifact references and next actions under stable keys. Dependencies cannot form cycles. Changed requirements invalidate dependent entries; history explains prior decisions.
5. **Verified experience:** successful procedures are recorded with environment information only when evidence supports them. Unverified answer text does not become a recommended procedure. Failed attempts and exact model versions inform later evaluation.

## Auto capabilities

1. Task phases can reroute Auto for research, execution, writing and verification without resetting the chat. Manual model/thinking choices remain authoritative.
2. Deadline, dollar, tool-call and concurrency limits cover the parent, helpers and paid tool APIs. Reservations prevent concurrent calls from overspending a task cap, and part of the budget is kept for verification.
3. Routing outcome profiles retain exact-model success, verified results, latency and cost. Enough measured outcomes are required before changing the cold-start routing baseline; unverified successes do not improve reliability scores.
4. Recovery distinguishes expired connections, transient failures, stale references and alternate interfaces. Automatic retries are bounded and apply to reads; uncertain writes require reconciliation.
5. Research claims retain real retrieved quotations, sources, contradictory evidence and freshness. Consequential unsupported, disputed or stale claims block verified completion. Two source domains are only a proxy for independence.

## Connections and service keys

`find_tools` can surface an inline connector tile; `connect_app` explicitly asks to connect an app with a task-specific reason. The user signs in or signs up on the provider's page, and the chat continues once its tools are ready. Skipping a tile is respected. Expired/revoked authentication offers reconnect rather than asking for passwords in chat. Some providers still require their own API key or OAuth app setup.

Cursor Cloud Agents require the user's Cursor key. Finding an installed Cursor app or CLI does not connect it. Local CLI agents are separately opt-in. Turning an AI provider off stops using its models while keeping its encrypted key, so it can be turned back on later.

Settings → Privacy & Security → Vault → API Keys stores service credentials encrypted with the existing Vault. They have an exact HTTPS origin and a documented authentication header/format. `api_request` references a key by name, requires approval, injects it only in main, blocks redirects, bounds bodies/responses, masks echoed keys and audits use. API keys cannot be offered or typed as browser-login passwords. API documentation and methods can be learned as skills; credentials never belong in knowledge notes or skills.

## Context and storage limits

Original messages and tool observations remain in SQLite until the user deletes the chat. Compaction uses a bounded working summary plus preserved constraints/identifiers and notes. Summaries are lossy; no finite model context can contain every old token indefinitely. `chat_history` retrieves exact stored passages from the same chat when a detail is needed after compaction/model changes. This makes earlier evidence recoverable without claiming that every model always sees the full archive.

## Updates and secondary copies

Packaged macOS builds check GitHub Releases and verify the downloaded archive's checksum, signature and build number. “Update SahilBot” makes a consistent profile backup, stages a verified app on the installed volume, quits, swaps only the app bundle and reopens it. Data directories, onboarding state, bot positions and connectors are preserved. A failed snapshot stops installation. A legacy install without a version marker is also copied before migrations; a failed pre-migration backup stops startup.

Secondary copies live in `~/Library/Application Support/SahilBot Backups`, separate from the live profile. Packaged apps maintain a daily copy and retain five recent backups; caches and downloadable models are excluded. The previous app bundle is retained beside the installed one for recovery; successful launch-request submission alone does not delete it. A failed replacement/launch restores the prior bundle. Backups retain the existing encryption and depend on the same Mac's Keychain or the Vault's recovery protection.

## Built-in topic knowledge

Five entry handbooks—`handbook-code`, `handbook-engineering`, `handbook-medical`, `handbook-business`, `handbook-everyday`—map requests to the existing specialist packs and add working methods, source checks and verification practices. Skills load progressively; their entire contents are not inserted into every prompt. Clinical guidance, API versions, regulations and vendor specifications must be checked against current authoritative sources when used.

## Verification — 2026-11-16

TypeScript checking, desktop and server builds, and diff whitespace checks passed. The final unit run passed 2,779 tests across 161 files. The complete desktop acceptance run passed 96 tests across 38 files with idle sleep prevented; measured voice first-audio latency was 1.024, 1.022 and 1.029 seconds. Server acceptance passed five tests across three files. An independent UI/security review identified issues that were fixed, including local-only routing, escaped credential echoes, browser API-key isolation and updater recovery.

Ten opt-in live-provider tests were skipped because their required credentials and flags were unavailable. Local mock-provider tests verify protocol behavior, state and UI flows; they do not establish model quality or real-account compatibility. A signed release installation and real-provider/account validation remain release checks. No release was published or installed by this change.
