# Harness reference review — 2026-11-16

This review used public primary sources and repository code. It informs SahilBot's architecture; it does not claim access to proprietary implementations or feature parity.

## References examined

- [Anthropic: how Claude Code works](https://code.claude.com/docs/en/how-claude-code-works): the context/action/verification cycle, user steering, tool observations, model switching and extensions. SahilBot already had a tool loop; durable action records, evidence checks, retained notes and exact archived retrieval strengthen the surrounding harness.
- [Anthropic: effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents): selective context, compaction, structured notes and delegated work. SahilBot uses bounded skill discovery, retrieval, preserved constraints and isolated worker reports. A compact summary is not advertised as lossless memory.
- [Claude Code public repository](https://github.com/anthropics/claude-code/tree/eba1240d09fd468b984a2a317c77cb48e1e51d2f): the public tree contains plugins, examples and documentation. It is not a complete public implementation of the proprietary core loop; no claim is made to have copied that core.
- [Codex session implementation](https://github.com/openai/codex/blob/e5839cbc591df02408d5009e287887c7d57a9167/codex-rs/core/src/session/session.rs) and [compaction implementation](https://github.com/openai/codex/blob/e5839cbc591df02408d5009e287887c7d57a9167/codex-rs/core/src/compact.rs): explicit session settings, cancellation, checkpoint metadata and retained client items. The practical comparison is durable shared chat state and safely bounded context, rather than treating the model as persistent storage.
- [Grok Build public repository](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8), including its [runtime boundary](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_runtime.rs): the published structure separates the TUI, runtime, tools and workspace/checkpoints. Grok Build is a coding harness; it is not the private Grok Bot implementation. The user's Grok Bot screenshots were used as a visual reference for quiet messages, short progress and visible useful outcomes.

## What this changes in SahilBot

The model continues choosing tools and delegating useful parts; the harness preserves state, enforces permissions, validates tool inputs/results, meters resources and checks completion evidence. UI detail is separate from execution detail: ordinary chat shows the result and decisions requiring the user, while Developer mode exposes diagnostics. A user can intervene or choose a model/thinking level without creating a fresh conversation.

The comparison is behavioral and architectural. Local unit, replay, desktop and server tests exercise SahilBot's implementation. They do not establish equal reasoning quality across models or production reliability for thousands of users; real provider credentials, signed releases and deployed account flows require their own release validation.
