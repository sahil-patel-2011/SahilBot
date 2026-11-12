# browser-use (MIT), browser-harness (MIT), Open Interpreter (Apache-2.0, Codex fork), Letta Code / smolagents / Aider / Jan (Apache-2.0)

Adopted now: Ollama native /api/chat with options.num_ctx (Letta/Aider finding: /v1 can't set context per request and
truncates silently from the front).

Next candidates:
- browser-use ax.py: page-order AX lines, `*` marks new elements, visible-text filter (checkVisibility), outcome line per action
  ("navigated | page changed | no change") via MutationObserver probe, event-based settle(), occluder-aware clicks, select/date typing.
- browser-use: frame-aware type_secret (resolve the focused frame's origin before typing a vault secret); never auto-accept JS dialogs.
- browser-use compaction CHECKPOINT: summary is fallible reference; original user requests copied verbatim by code.
- Jan: code-built continuation state (task + user messages verbatim, files touched, todos, errors); reminders folded into the last
  user message; neutralize <SYSTEM> in user/file text; keyword router for many MCP servers; tool list sorted for cache reuse;
  approval scopes (thread / server / tool).
- Letta: post-turn reflection subagent (mistakes > preferences > facts > procedures), memory projection, Ollama /api/ps served context.
- smolagents: planning step every N steps with "Now proceed and carry out this plan."; retry message after errors.
- Aider: fuzzy edit chain + failure message ("Did you mean…"), per-model settings (reminder placement, examples as system).
- Open Interpreter: per-model harness profiles; little-coder invariants; BM25/RRF selection for find_tools.
Jan asks for credit in user-facing docs: "This product includes software developed by Menlo Research".
