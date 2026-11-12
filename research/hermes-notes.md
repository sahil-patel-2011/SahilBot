# Hermes Agent notes (NousResearch/hermes-agent @ bba2061, MIT; plugins/security-guidance is Apache-2.0)

Ported/adapted into Foreman:
- chat_completion_helpers_tool_calls.py: Ollama reuses index 0 for parallel calls -> new id at a seen index opens a new slot; names assigned, not appended, when resent.
- turn_tool_validation.py: refuse truncated arguments (not ending in } or ]); unique call ids; mixed batches run valid calls.
- arg_coercion.py: schema-driven coercion ("42"->int, "true"->bool, JSON strings->objects/arrays, scalar->[scalar]) before validation.
- context_compressor SUMMARY_PREFIX idea: reference-only, latest user message wins, tools remain active.
- todo re-injection after compaction.

Later candidates: tool_guardrails.py (A,B,A,B cycles, failure thresholds), repetition_guard.py, empty_response_guard.py,
fuzzy_match.py (edit tool), memory operations[] batch + threat_patterns.py scan, background_review.py (skills/memory review prompts),
session_search_tool.py (FTS5), delegate_tool.py (sub-agents, flat depth), cron invariants (cron/AGENTS.md), mcp_oauth.py (PKCE, DCR/CIMD).
