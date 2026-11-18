# OpenAI models

With an OpenAI key saved (Settings → Models), GPT models run on OpenAI's **Responses API**
(`POST /v1/responses`). Other OpenAI-compatible servers (Ollama, LM Studio, OpenRouter, a custom server)
keep using Chat Completions. Code: `src/main/llm/openai-models.ts` (model table) and
`src/main/llm/openai-responses.ts` (client).

## Lineup and Auto

| Model | Auto uses it for | Context / max input / max output | $ per 1M (input / cached / output) |
|---|---|---|---|
| GPT-6.2 Astra | the hardest work (difficulty 3; tier 3) | 1.05M / 922K / 128K | 8 / 0.40 / 40 |
| GPT-6.2 Sol | tasks, routine research and reasoning (tier 2) | 1.05M / 922K / 128K | 2 / 0.10 / 10 |
| GPT-6.1 Terra | quick questions (tier 1) | 1.05M / 922K / 128K | 1 / 0.05 / 5 |
| GPT-6 Luna | small talk (tier 0) | 1.05M / 922K / 128K | 0.10 / 0.01 / 0.50 |

Only these four models are on by default. GPT-6.2 Astra and Sol (Nov 17, 2026) supersede GPT-6 Astra
($10 / $1 / $50) and GPT-6.1 Sol. Older models (GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-5.6, GPT-5.5, GPT-5.4 and
earlier) and pro models are listed on the Models page but start off; picked by name they work as before. Speed
tiers (Fast, and Ultrafast on GPT-6.2 Astra / Sol, GPT-6 Astra and GPT-6.1 Sol) are in
[model-routing.md "Fast mode"](model-routing.md#fast-mode). Auto never picks a pro model on its own. If
Claude models are on too, Claude keeps its tiers (Haiku, Sonnet, Opus). A saved OpenAI key makes Auto try
cloud models first, as a Claude key does, unless Settings → Models says Local first.

A GPT id the table doesn't know yet (say `gpt-6.3-sol`) is treated like the newest model of its role. It
is priced at that role's highest known rates and its price is marked as an estimate.

## Long chats

The chat uses the same **context strategy** setting as Claude (`cloud.contextStrategy`):

- **Balanced** (default): 256K. That keeps prompts under 272K, above which OpenAI bills the whole request
  at 2x input and 1.5x output.
- **Max**: the model's full input limit (922K on GPT-6.x).
- **Economy**: 128K.

Near 80% of the window, OpenAI compacts the conversation on its own servers (`context_management`
compaction). SahilBot's own summarizer only steps in if a prompt would no longer fit at all.

## How requests are built

- **Stateless** (`store: false`). SahilBot keeps the history. Each request replays it in full, including
  OpenAI's encrypted reasoning items, so the model keeps its reasoning across tool calls and nothing is
  stored at OpenAI.
- **Append-only.** Earlier turns are never rewritten mid-run, because OpenAI drops reasoning that follows
  an edited prefix. Every screenshot stays in view.
- **Prompt caching.** The system prompt is sent first as a developer message, with the tools in a fixed
  order. The chat id is sent as `prompt_cache_key`. On GPT-5.6 and later the cache lasts 30 minutes, and
  the system prompt also gets a 12-hour cache breakpoint on long runs.
- **Thinking level.** SahilBot's levels (Low to Max) map to the nearest `reasoning.effort` the model
  accepts, never `none`. Reasoning summaries show up as the step's thinking.
- **Tools.** SahilBot's own tools are sent as function tools. Every call runs through SahilBot, so
  approvals, hard stops and the taint check apply. When web search is on, OpenAI's built-in `web_search`
  takes the place of SahilBot's. Its sources show as pills, and what it read counts as outside content.
  OpenAI's computer use, shell, code interpreter, apply_patch and MCP tools are never turned on.

## Costs

Each request is priced before it is sent, using the worst case at the real prompt size. After it
finishes, SahilBot records:

- cached input at the cached rate;
- cache writes at 1.25x the input rate (30 minutes) or 2.5x (12 hours) on GPT-5.6 and later;
- reasoning tokens as output;
- web searches at $10 per 1,000;
- the long-context tier when the real prompt is over 272K, even if most of it was read from the cache.

## Errors

- Rate limits: retried, honoring `Retry-After`.
- Overloads and dropped streams: retried with backoff.
- Out of credit or a spend limit: not retried. The message says to check billing.
- A bad key, a prompt too long for the model, or a content-policy refusal: shown as a plain message.
- A request field this account or model rejects (for example reasoning summaries on an unverified
  organization): the field is dropped and the request is sent again once.
