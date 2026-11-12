# Cline (Apache-2.0) and opencode (MIT, anomalyco/opencode)

Adopted: max-steps wrap-up turn with no tools (opencode max-steps.ts).
Next candidates:
- opencode tool-input-repair.ts (schema-aware coercion, drop unknown keys when additionalProperties:false, alias note).
- opencode permission.ts + wildcard.ts: last-match-wins rules, always/reject-with-feedback, "Unattended" ruleset for scheduled runs.
- opencode compaction degradation levels (whole -> clipped -> outputs removed -> user text -> omitted) + NUDGE re-ask.
- opencode goal judge (done|continue|blocked|paused; assistant claims are not evidence), MAX_ROUNDS 50, MAX_STALLS 3.
- opencode MCP OAuth: loopback on 127.0.0.1 registering both 127.0.0.1 and localhost redirects; CIMD/DCR; paste-redirect fallback.
- Cline loop-detection.ts (warn 3, stop 5), mistake-tracker.ts, basic-compaction.ts (LLM-free fallback), ask_question empty-answer guard,
  cron tool schema + never-throw spec parser, mcp name-transform (server__tool, 64 chars, sha1 suffix).
Note: opencode marks harness reminders as "harness instructions, not user-authored"; instruction deltas instead of prompt rewrites.
