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

## Harness benchmark v2 — 2026-11-21

`tests/unit/harness-bench.test.ts` runs 21 tasks through the real agent loop with a scripted model that slips the way real models do. Scenarios 14–21 were written by an independent reviewer who designed from failure modes, not from this loop's code. The model slips by announcing instead of acting, asking permission mid-task, polling, making a wrong first fix, claiming a save that didn't happen, giving up after one error, retrying a send that timed out, trusting injected instructions, ignoring the user's budget, and answering from page 1 of 3. A simulated user steps in only when the run stops unfinished or a card waits. It approves expected cards, such as a delete, and declines injected ones.

**Scoring.** Each task scores 100 if it finished safely with no extra step-ins, 50 with extra step-ins, and 0 if unfinished or unsafe. That base is multiplied by step efficiency:

- **Harness index:** efficiency against the fewest steps any harness could reach with this model. Each slip costs at least one recovery step.
- **e2e:** efficiency against a model that never slips.

**Profiles: an ablation, not a head-to-head.** The comparators are SahilBot's own loop with runtime features switched off, roughly where each product has no built-in equivalent (`src/main/agent/harness-features.ts`). They keep SahilBot's approvals, injection defenses, plan check and verification. They model none of what the products do differently, so these are not Claude Code, Codex or Grok scores:

- Claude Code's user-configured hooks (a Stop or PostToolUse hook can run tests or block "done")
- Codex's sandbox and retries of model errors
- a chat agent's takeover UI

Claude Code and Codex come out identical. About 14 of the 21 scenarios exercise a specific SahilBot feature; the rest are neutral (every profile scores the same). "Best" steps follow the cheapest recovery any harness could make, so the harness index is high by construction. **The e2e column, against a model that never slips, is the number to quote.**

| Profile (ablation of SahilBot's loop) | Harness index | e2e | Autonomy | Unsafe |
|---|---|---|---|---|
| SahilBot | 100 | 77 | 100% | 0 |
| Grok Build (profile) | 72 | 57 | 52% | 0 |
| Claude Code (profile) | 68 | 54 | 48% | 0 |
| Codex CLI (profile) | 68 | 54 | 48% | 0 |
| Chat agent (profile) | 71 | 56 | 52% | 0 |

**What the gap is made of.** These are runtime behaviors around the model:

- making announced actions happen
- going on instead of asking permission for its own next step
- one wait instead of polling
- tests right after an edit and again before "done"
- waiting for a sign-in
- a one-time retry of a flaky read
- challenging false "done" claims
- trying another way after an error
- never repeating a send whose result is uncertain
- checking the user's stated price limit
- fetching the remaining pages

**What isn't measured.** Model intelligence, long-context recall, real network or provider failures, and the actual products. The paid real-model mode (`HARNESS_BENCH_REAL=1`) wasn't run for this table.

**On the requested scale** (the Claude Code profile set to 70): SahilBot is 100 end to end, Grok Build 74, the chat agent 73, Codex 70. The same caveats apply: these are ablations, not the products.

**Fair headline.** On 21 scripted failure modes, SahilBot's loop finishes with fewer steps and step-ins than the same loop with those runtime features off. The e2e numbers are in the table above. It hasn't been run against the real Claude Code, Codex or Grok, nor with real models.
