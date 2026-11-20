# ChatGPT plan in SahilBot

Users asked for what Hermes offers: click Connect, sign in with ChatGPT, and run SahilBot (bots, routines, Team, Heavy) on the ChatGPT subscription's limits instead of paying per token.

This page records what OpenAI officially allows, the design SahilBot uses, and what works through that route versus what degrades. The research was done on 2026-11-15. OpenAI's developer docs now redirect from `developers.openai.com/codex/*` to `learn.chatgpt.com/docs/*`.

## The rule we hold to

SahilBot uses only official, documented, terms-compliant routes. It does not:

- reuse Codex's OAuth client ID,
- call private ChatGPT backend endpoints (`chatgpt.com/backend-api/...`),
- read, copy or import Codex's credentials (`~/.codex/auth.json` or the Keychain item).

Codex's auth docs say to treat `auth.json` like a password. Some open-source agents import it; we don't.

## Findings

### 1. OpenAI has an official "Sign in with ChatGPT" for apps, but it is gated for commercial apps

Sources: `developers.openai.com/siwc`, `/siwc/token-sharing-open-source`, `/siwc/token-sharing-open-source/sign-in`, `/siwc/request-client-id`, `/siwc/token-sharing-open-source/preview-limitations`, `/siwc/token-sharing-open-source/codex-app-server`.

- **What it is.** "Sign in with ChatGPT" lets an app offer ChatGPT login. Plan usage is an optional add-on: the app may use the user's ChatGPT plan for eligible Responses API requests. It grants no access to the user's ChatGPT conversations.
- **Who can self-serve.** The plan-usage docs cover "open-source and locally hosted apps". These use dynamic client registration:
  - `client_id=dynamic_agent_client` on first sign-in, with a persisted `ext_agent_host_id`;
  - scopes include `chatgpt.tokens.use.direct`;
  - PKCE, a `127.0.0.1` loopback redirect, and `https://auth.openai.com/api/accounts/authorize`.
- **Paid or remotely hosted apps.** These must "complete the interest form". The client-ID page says Sign in with ChatGPT "is currently offered to a select group of commercial partners" via a waitlist.
- **Preview limits.** These apply both directly and through Codex app-server:
  - no image generation, file search, Code Interpreter, hosted MCP or connectors, or `tool_search`;
  - requests need `store: false` and `stream: true`;
  - many request fields are rejected (`temperature`, `top_p`, `metadata`, `user`, …).
- **Launch partners.** The OpenAI help center ("Using your ChatGPT plan in other apps and sites") and press coverage describe launch partners and per-app weekly caps. Eligible plans are Go, Plus, Pro and Business. Users set caps in ChatGPT settings.

**Decision.** SahilBot is a private, commercial desktop app, so it falls under "paid app → interest form", not the open-source self-serve flow. We do **not** ship a direct Sign in with ChatGPT integration. That waits until OpenAI approves SahilBot as a partner. See "Next step" below.

### 2. Codex is officially meant to be embedded, and it signs in with ChatGPT itself

Sources: `/codex/auth`, `/codex/noninteractive`, `/codex/cli/reference`, `/codex/app-server`, `/codex/codex-sdk`, `/codex/mcp`, `/codex/config-reference`.

**Sign-in.**

- `codex login` opens OpenAI's browser sign-in (Sign in with ChatGPT = "subscription access").
- `codex login status` "prints the active auth mode and exits 0 when logged in".
- An API-key login bills at API rates, not the plan.

**Embedding.**

- **App-server.** `codex app-server` is OpenAI's documented protocol for "deep integration inside your own product". It is JSON-RPC 2.0 over stdio, one message per line, with the `jsonrpc` field left out. Methods include:
  - `initialize`, then `initialized`;
  - `account/read` (account type, email, `planType`);
  - `account/login/start` (type `chatgpt` returns an `authUrl` to open in a browser) and `account/login/completed`;
  - `account/rateLimits/read` and `account/rateLimits/updated` (primary and secondary windows: `usedPercent`, `windowDurationMins`, `resetsAt`);
  - `model/list`, `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`;
  - item notifications and deltas;
  - approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`: decline or accept);
  - `turn/completed` with `turn.error.codexErrorInfo` (`usageLimitExceeded`, `unauthorized`, `contextWindowExceeded`, …).
- **Codex SDK.** Its stated use cases include "Integrate Codex within your own application". The app-server docs ask integrations "intended for enterprise use" to contact OpenAI about a known-clients list.

**Config (all documented keys).**

| Key | What it controls |
| --- | --- |
| `features.shell_tool` | Turns Codex's command tools off. |
| `tools.web_search` | Codex's built-in web search. |
| `sandbox_mode = "read-only"` | Codex can't write to the Mac. |
| `approval_policy` | When Codex asks before acting. |
| `model_instructions_file` | Replaces Codex's built-in instructions. |
| `developer_instructions` | Extra instructions for the session. |
| `project_doc_max_bytes` | How much of `AGENTS.md` Codex reads. |
| `history.persistence = "none"` | Codex keeps no transcript file. |
| `[mcp_servers.<id>]` | `url`, `bearer_token_env_var`, `enabled`, `required`, `enabled_tools`, `tool_timeout_sec` (default 60 s), `startup_timeout_sec`, `default_tools_approval_mode`. |

**Removed.** `codex mcp-server` was removed in favor of app-server.

### 3. What users expect: Hermes

Source: `hermes-agent.nousresearch.com/docs/integrations/providers`.

Hermes Agent's "OpenAI Codex" provider has three parts:

- **Its own sign-in.** It runs a ChatGPT OAuth login, by device code or by browser plus PKCE on a fixed port 1455.
- **Its own credential file.** It stores credentials in `~/.hermes/auth.json`.
- **Optional import.** It can import `~/.codex/auth.json`.

Community write-ups also describe an opt-in "Codex App-Server Runtime" that hands turns to `codex app-server`. Users expect Connect → browser sign-in → "it just uses my weekly limits", with the agent's tools still working. We match that experience without the token import or a borrowed client.

### 4. Claude subscription (Claude Code / Agent SDK): not implemented

Source: `code.claude.com/docs/en/agent-sdk/overview`.

- **Anthropic's rule.** The Agent SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods… instead."
- **What SahilBot does.** It keeps Claude on API keys and does not offer a "Claude plan" provider. That changes only if Anthropic approves SahilBot.
- **What users can still do.** They can run Claude Code themselves and connect it to SahilBot as an MCP client. That is the existing Connected apps feature. Driving the user's Claude Code login from SahilBot as a model provider would be offering claude.ai rate limits in a third-party product.

## Design: "ChatGPT plan (via Codex)"

SahilBot drives the user's **own, locally installed, official Codex**:

- the user signs in inside OpenAI's sign-in,
- Codex holds the credentials,
- requests go from Codex to OpenAI exactly as when the user runs Codex.

SahilBot only talks to Codex through its documented CLI commands and app-server protocol.

### Setup (Settings → Models → "ChatGPT plan (via Codex)")

1. **Find Codex.** SahilBot looks in the usual install locations: Homebrew, npm, `~/.local/bin`, `Codex.app`, then the login shell's `command -v codex`. If Codex is missing, it shows **Install guide**, which links to `developers.openai.com/codex/cli`.
2. **Check sign-in.** SahilBot runs `codex login status` and reads its words, never a credential. If signed in with ChatGPT, it also reads `account/read` (email, plan type), `account/rateLimits/read` and `model/list` from a short-lived app-server.
3. **Connect.**
   - If Codex isn't signed in, Connect starts Codex's own sign-in (`account/login/start`, type `chatgpt`). SahilBot opens the returned `https://` page in the browser. Codex receives the result and stores it its own way. SahilBot waits for `account/login/completed` and checks status again.
   - Fallback: **Open Terminal** runs `codex login` from a `.command` file, so no Automation permission is needed.
   - An API-key login is reported as "bills per token, not your plan" and is not treated as the plan.
4. **Use my ChatGPT plan first** (toggle). While the plan has room, Auto leaves the pay-per-token OpenAI API out of its pool, so GPT work goes to the plan.
5. **Usage.** The 5-hour and weekly windows show "% used" and "resets at". Codex updates them during runs (`account/rateLimits/updated`).

### Running a step

The code lives in `src/main/llm/codex/session.ts`. **Codex is the model; SahilBot's agent loop stays the agent.**

1. **Routing.** `chatgpt-plan/<model>` ids route to the pseudo endpoint `codex://chatgpt-plan`. `llm/client.ts` `route()` sends those requests to `streamCodex()`.
2. **New Codex process.** A new conversation starts one `codex app-server` with these `-c` overrides:
   - `model_provider="openai"`, `features.shell_tool=false`, `tools.web_search=false`;
   - `sandbox_mode="read-only"`, `approval_policy="on-request"`;
   - `project_doc_max_bytes=0`, `history.persistence="none"`, `model_reasoning_summary="auto"`;
   - `model_instructions_file=<the chat's SahilBot system prompt>`, which carries the bot's instructions, memory, rules and context;
   - each of the user's own Codex MCP servers (from `codex mcp list --json`) set to `enabled=false`.

   The run's working folder is an empty private temporary folder.
3. **Tool registration.** SahilBot registers its tools as app-server functions at thread startup. The model gets instructions to use the workspace tools and check their results before reporting completion. `sb_sahilbot_call` is available for tools loaded later with `find_tools`. Older versions that reject function registration use the loopback MCP bridge. It rejects web-page origins and unexpected Host headers. Its per-run token lives in the child process environment and is revoked when the run ends.
4. **Tool calls.** When Codex calls a tool, SahilBot holds the request open and hands the call to its agent loop. The loop runs it exactly as for any model:
   - the chat's permission mode, approval cards, hard stops and taint checks;
   - the purchase, secret and vault guards and goal and swarm limits.

   The loop stores the result and asks for the next step. SahilBot returns the result to Codex, and its turn continues. Parallel calls within 40 ms become one step.
5. **Codex's own actions.** Any Codex command-execution or file-change approval request is declined, with a note in the reasoning. Approval requests for SahilBot's own bridge tools are accepted, because SahilBot asks the user itself.
6. **Streaming.** These events stream into the chat:
   - `item/agentMessage/delta` becomes the reply text;
   - `item/reasoning/summaryTextDelta` becomes the reasoning summary;
   - token usage from `thread/tokenUsage/updated`.

   SahilBot's own tool-call bubbles show the tools.
7. **Follow-ups.** Each SahilBot chat saves its Codex thread ID in the app profile. A follow-up resumes that thread after an idle timeout or an app restart. Matching histories send only new input. After compaction, SahilBot supplies the current summary and recent turns. Editing or retrying a previous message starts a separate history. Background routing checks run in ephemeral threads.
8. **Stop.** Stop calls `turn/interrupt`, refuses waiting calls, and ends the process.
9. **Cleanup.** Idle processes close after 10 minutes. The thread ID remains available for the next turn. A step waiting on an approval gives up after 30 minutes. At most 6 Codex processes run at once; Team and Heavy helpers beyond that queue.
10. **Limit reached.** On `usageLimitExceeded`:
    - the step fails with a clear message ("…limit is reached in Codex. It resets …");
    - plan models drop out of Auto until the reset;
    - the loop's usual "switch model on failure" moves the run to another model;
    - `unauthorized` asks the user to sign in again.

### Billing and the spending limit

- **Price.** `budget.priceFor('chatgpt-plan/…')` returns $0. Plan requests never go through the budget's pre-check (`spendHooks.before`).
- **Recording.** Plan requests are recorded through `spendHooks.after` with host `chatgpt-plan`, so they show in Usage at $0.
- **Hooks for routing and the spending limit (stable):**
  - `codexAvailable()` from `src/main/llm/codex`: true when the plan is switched on, installed, signed in with ChatGPT and not over its limit. It does no I/O.
  - `billingOf(modelOrUrl)` returns `'plan'` for plan models and the Codex endpoint.
  - `chatgptPlan.allows(model)` is the filter `Endpoints.usable()` applies.
  - Provider id `'chatgpt'`; models have `note: 'remote'` and `price: {input: 0, output: 0}`. `ModelList.providers` has an entry `{ id: 'chatgpt', ok }` while it's switched on.

## What works through Codex, and what degrades

| Feature | Through the ChatGPT plan |
| --- | --- |
| Chats, bots (instructions, memory, rules, skills index, context sections) | Yes. SahilBot's system prompt replaces Codex's. |
| SahilBot tools, connectors (MCP), approvals, hard stops, taint, purchases, vault guards | Yes. They run in SahilBot's loop. |
| Tools loaded mid-run (`find_tools`) | Through `sahilbot_call` (Codex lists tools once per process). |
| Streaming text and reasoning summaries, Stop, steering | Yes. |
| Routines, goals and scheduled runs | Yes. Unattended asks follow SahilBot's usual rules. |
| Team of Experts and Heavy | Yes. Each helper is its own Codex thread, at most 6 at once; extra helpers queue. |
| Model choice | `model/list` entries, plus SahilBot's thinking level mapped to the model's efforts. |
| Usage display | Plan windows (% used, reset time). Per-step dollar cost is $0; tokens are shown as Codex reports them. |
| Per-step budget accounting, swarm and goal $ caps | Not applicable. The plan isn't billed per token; the plan's own limits apply. |
| Images in the user's message | The latest message's images go as `localImage` inputs. Images returned by tools reach Codex as text only. |
| Computer use | Because tool screenshots reach Codex as text only, Auto routes computer use to the plan only when no other model that can see the screen is on (the label then says it works from page text), and the planner + executor pair never uses it. A plan model picked by name is used as picked. |
| SahilBot's prompt cache, server compaction, Claude-native or OpenAI-native tools | Not used. Codex manages its own context. A conversation SahilBot compacts starts a new Codex thread. |
| Codex's own shell, file edits, web search | Off or declined by design. SahilBot's tools do this work, with approvals. |
| Exact sampling (temperature, top_p) | Not available (plan preview limits). |

## Not verified against a real Codex

There is no real Codex run and no network in tests. These details come from the docs and could differ by Codex version:

- the exact `codex login status` wording; parsing is tolerant;
- the shape of `thread/tokenUsage/updated` and `codex mcp list --json`; both are parsed defensively;
- whether `tools.web_search=false` fully disables web search;
- how Codex asks for approval of MCP tool calls. Anything ending in `requestApproval` that names `sahilbot` is accepted; other approvals are declined.

If an override is rejected by a future Codex, the step fails with Codex's own error text, and Auto moves on to another model.

## Next step: direct Sign in with ChatGPT

Submit OpenAI's Sign in with ChatGPT interest form for SahilBot (a paid, locally hosted desktop app). If OpenAI approves it with a client ID, SahilBot could call the Responses API with the user's plan token, and Codex would no longer be required. The current design keeps that easy:

- the provider id, model ids, the $0 billing hook and the Settings section stay the same;
- only the runner behind `codex://chatgpt-plan` changes.

## Files

**Main process:**

- `src/main/llm/codex/ids.ts`: model ids, the endpoint, the install link.
- `src/main/llm/codex/detect.ts`: finding Codex, `--version`, `login status`, `mcp list --json`.
- `src/main/llm/codex/rpc.ts`: the app-server JSON-RPC client.
- `src/main/llm/codex/bridge.ts`: the per-run loopback MCP tool bridge.
- `src/main/llm/codex/plan.ts`: status, preferences, sign-in, rate limits, models, the Auto filter.
- `src/main/llm/codex/session.ts`: the step runner (`streamCodex`).
- `src/main/llm/codex/index.ts`: exports, including `codexAvailable()` and `billingOf()`.

**Shared and renderer:**

- `src/shared/chatgpt-plan.ts`: status and API types.
- `src/renderer/src/components/ChatgptPlanSettings.tsx`: the Settings section.

**Hooks into existing files:**

- `llm/client.ts`: `route()` and `listModels`.
- `llm/providers.ts`: the `chatgpt` definition and `baseUrlOf`.
- `llm/endpoints.ts`: `for`, `list`, `usable`, `pickable`, `missingReason`, `affordable`.
- `llm/budget.ts`: `priceFor` returns $0 for plan models.
- `shared/types.ts`: `ProviderId`, `keys`, `SahilBotApi.chatgptPlan`.
- `src/main/index.ts`: the IPC handlers.
- `src/preload/index.ts`.
- `SettingsModal.tsx`: the Models page.

**Tests:**

- `tests/unit/chatgpt-plan.test.ts`.
- `tests/fixtures/fake-codex.mjs`: a fake `codex` speaking the documented commands and app-server protocol.


## Voice and context

In Settings → Voice, select OpenAI voice, Grok voice, or Auto to use a connected speech API key. The transcript goes to the current SahilBot chat, where the selected model can work with its tools and Cursor agents. API speech counts toward the spending limit. Choosing ChatGPT in browser or Grok in browser opens the provider's website for its own voice experience and conversation history.

Maximum cloud context uses the selected provider's advertised capacity up to one million tokens. The Codex CLI catalog can report a different limit from the OpenAI API for the same model. SahilBot keeps conversation records locally and uses summaries and recent messages when a prompt approaches its budget.
