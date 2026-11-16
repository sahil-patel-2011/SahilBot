---
name: handbook-code
description: Build and maintain software with repository conventions, small changes, isolated workers, secure API access and verified results.
source: you
uses: 0
category: Coding
triggers: code handbook, code foundations, code reference guide, code working methods, code knowledge guide, code best practice guide, code workflow overview, code learning guide
---

## Orient before acting
Read repository instructions, scripts, dependency manifests and nearby implementation. Determine the actual stack instead of introducing a preferred framework by default. Inspect working-tree changes and preserve the user's work. Reproduce a reported failure or identify the behavior that will change. Keep an explicit acceptance criterion and distinguish source observations from assumptions.

## Choose a focused skill
Use codebase-orientation and match-code-style to enter an existing project, coding-fix-failing-tests for failures, test-first-development for behavioral changes, security-review for trust boundaries, api-design and api-integration for services, and observability for production diagnosis. Use the language/framework pack that fits the repository. coding-cursor-orchestration and cursor-task-brief are for intentionally delegated Cursor work; installed command-line software does not imply a connected account.

## Implement with the existing design
Find the ownership boundary of a bug; prefer a minimal complete fix over duplicated special cases. Validate external input, encode output appropriately and keep authorization on the trusted server/backend. Handle cancellation, deadlines and resource limits. Preserve provider/tool histories as valid request/result sequences. Use schema-checked structured tool output for data processing and workflow for bounded call/select/filter/map/join pipelines instead of sending every raw row through a language model.

## APIs and credentials
Read the provider's official current REST/SDK documentation. Keep keys in the encrypted Vault/provider settings, referenced by name; use api_request for an approved REST call. Do not put tokens into prompts, source files, command arguments, logs or skills. Bound response sizes, pagination and timeouts. Retry transient reads conservatively. An uncertain write requires a receipt or documented idempotency mechanism before any retry. Distinguish authentication failures, rate limits, invalid inputs and provider outages.

## Verify and review
Run checks appropriate to the change: behavior tests, type checks and build, plus a desktop/browser flow for UI changes. Inspect the resulting diff for scope, state leaks, keyboard access, error handling and accidental secrets. Keep failed evidence visible until repaired; a final sentence cannot replace passing checks. Use task_graph for independent agents with explicit dependencies and separate worktrees for code changes. Review each worker's actual diff and tests before integration.

## Learn what worked
Record a reusable procedure only when verification supports it. Include exact environment/version, inputs, commands, checks and limitations. Do not promote an attractive answer or an unverified command sequence into a trusted skill. Retain test fixtures and prior outcomes for agent_evaluate replay; recorded-tool replay is simulation, not proof about today's external state.
