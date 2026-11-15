# Grok (xAI) in SahilBot

SahilBot can use xAI's Grok models with your own xAI API key. Facts on this page were read from xAI's docs and independent leaderboards on **2026-11-15**. Each number links to its source in [Sources](#sources).
- **VR** means vendor-reported: xAI's own docs or announcement.
- **IND** means independent.

## Setting it up

1. Open **Settings → Models → xAI (Grok)**, or **API Keys & Servers**.
2. Paste a key from the xAI Console. It is saved in the macOS Keychain, like the other keys.
3. Use **Test** to check the key. It lists your models (`GET /v1/models`) and costs nothing.

After that:
- Every model whose name starts with `grok-` goes to xAI.
- Only `grok-4.7` starts switched on. Older Grok models are listed but start off.
- Image, video and voice models are hidden.
- Spending counts toward your monthly limit.

## Models and prices [X1][X2]

All prices are per 1M tokens. They are shown as below 200K prompt tokens / at or above 200K. Once the prompt reaches 200K tokens, xAI bills every token of that request at the higher rate.

| Model id | Context | Input | Cached input | Output | Reasoning effort |
|---|---|---|---|---|---|
| `grok-4.7` (the default Grok) | 500K | $2 / $4 | $0.50 / $1 | $6 / $12 | low, medium, high, xhigh (default high) |
| `grok-4.6` | 500K | $2 / $4 | $0.50 / $1 | $6 / $12 | low … xhigh (default high) |
| `grok-4.5` (aliases `grok-4.5-latest`, `grok-build-latest`) | 500K | $2 / $4 | $0.30 / $0.60 | $6 / $12 | low, medium, high [X3] |
| `grok-4.3` (alias `grok-4.3-latest`) | 1M | $1.25 / $2.50 | $0.20 / $0.40 | $2.50 / $5 | none … xhigh (default low) |
| `grok-build-0.1` (aliases `grok-code-fast-1`, `grok-code-fast`) | 256K | $1 / $2 | $0.20 / $0.40 | $2 / $4 | not documented |
| `grok-4.20-0309-reasoning` / `-non-reasoning` | 1M | $1.25 / $2.50 | $0.20 / $0.40 | $2.50 / $5 | not documented |
| `grok-4.20-multi-agent-0309` | 1M | $1.25 / $2.50 | $0.20 / $0.40 | $2.50 / $5 | effort sets the number of agents (4 or 16), not depth |

Notes on the table:
- **Max output.** No model page gives a cap. xAI documents `max_output_tokens` as "Defaults to 128,000 when unset", and it counts visible output only [X4]. SahilBot uses 128K.
- **Grok 4.7.** Every Grok model above takes text and image input and supports function calling and structured outputs [X1]. Grok 4.7 was released on Sep 21, 2026 [X6].
- **Rate limits at Tier 0** [X5]: Grok 4.7 / 4.6 / 4.5 allow 150 requests/s and 50M tokens/min. Grok 4.3, 4.20 and Build 0.1 allow 37 requests/s and 10M tokens/min. The multi-agent model allows 9 requests/s and 2.5M tokens/min. Tiers rise with spend ($50, $250, $1,000 and $5,000).
- **Other fees** [X2]:
  - Web Search costs $5 per 1,000 calls. SahilBot doesn't turn on xAI's server tools.
  - The Batch API is 20% off. SahilBot doesn't use it.
  - The US regional endpoint costs 1.1x.

### Thinking levels
SahilBot's thinking level is sent as `reasoning.effort`: the level itself when the model accepts it, otherwise the nearest accepted level below. SahilBot never sends `none`.

| SahilBot | Grok 4.7 / 4.6 | Grok 4.5 | Grok 4.3 |
|---|---|---|---|
| Low | low | low | low |
| Medium | medium | medium | medium |
| High | high | high | high |
| Extra | xhigh | high | xhigh |
| Max | xhigh | high | xhigh |

- **Grok 4.7 always reasons.** "Reasoning cannot be disabled", and the default is high [X3].
- **Grok 4.5 and xhigh.** The reasoning guide says "xhigh is not available on grok-4.5", while its model page lists xhigh. SahilBot follows the guide, because a rejected effort fails the whole request.
- **Rejected parameters.** Reasoning models reject `presencePenalty`, `frequencyPenalty` and `stop` [X3]. SahilBot sends none of them, and no temperature either.

## How requests are sent [X4][X7]
- **API.** SahilBot uses `POST https://api.x.ai/v1/responses` with `Authorization: Bearer <key>`, in `src/main/llm/xai-client.ts`. xAI calls Responses "the primary interface for text generation, reasoning, and tool use". It calls Chat Completions the "OpenAI-compatible predecessor", says new integrations should use Responses, and marks it deprecated on its best-practices page.
- **Same shape as OpenAI's.** The input items, `function` tools and streamed events (`response.output_text.delta`, reasoning deltas, `response.completed`, `data: [DONE]`) match OpenAI's. SahilBot reuses its Responses input builder.
- **Stateless.** Every request sets `store: false` and resends the whole history. Tool calls round-trip as `function_call` and `function_call_output` items.
  - Grok's encrypted reasoning isn't carried from turn to turn.
  - That would need append-only Grok runs in the agent loop, which is a possible follow-up.
- **Usage.** SahilBot reads:
  - `input_tokens` and `input_tokens_details.cached_tokens`;
  - `output_tokens`, `output_tokens_details.reasoning_tokens` and `total_tokens`. Reasoning is billed as output; when the total shows reasoning on top of output, it's added.
  - `cost_in_usd_ticks` (10^10 per dollar), which is xAI's own figure. If it is higher than SahilBot's computed cost, the difference is charged.
- **Errors** [X8]:
  - 401 means a bad key.
  - 403 means a team permission problem.
  - 400 or 422 means a bad field. An optional field the error names (`service_tier`, `reasoning`, `prompt_cache_key`, `parallel_tool_calls`) is dropped and the request is sent again.
  - 429 means a rate limit. SahilBot retries with backoff, as it does for 5xx errors.

## Fast mode (Priority) [X2][X9]
- **Opting in.** Fast mode sends `service_tier: "priority"`. xAI also accepts `"fast"` as the same tier.
- **Effect.** Priority requests are scheduled ahead of standard traffic when priority capacity is free.
- **Price.** Priority is "billed at a 2x premium over standard rates", and "only … when the response confirms `service_tier: priority`". Cache discounts apply before the multiplier.
- **When it isn't granted.** The response then says `default`, and SahilBot records the request at the standard price.
- **Grok 4.7 Fast is a separate product.** It costs 2x, or 1.5x for long context, and is available only in Cursor and Grok Build, "not available on the public xAI API". SahilBot doesn't offer it.

## How Auto uses Grok (evidence)

The user expected Grok to be weaker for agentic work. The data below supports that for most categories, with one exception: knowledge and office work. Auto routes Grok category by category from this evidence, as it does every other model (`src/main/llm/routing-table.ts`, docs/model-routing.md).

| Area | Grok 4.7 | Where Claude / GPT stand | Auto |
|---|---|---|---|
| Coding / agentic | Terminal-Bench 4.0 **37.6%** (#16) [I3]; arena WebDev #24 (1641) [I2]; Vals SWE-bench Multimodal 42.9% (#15/22) [I6] | Opus 5.5 64.8%, Sonnet 61.8%, Astra / Sol 58.2%, Terra 51.8%, Haiku 40.0% | Last fallback |
| Composite | AA Intelligence Index **35** at xhigh (#45 of 80) [I1]; Vals Index 58.6% (#19/37) [I6]; Epoch ECI 156 (#39) [I4] | AA: Opus 59, Astra 57, Sol 55, Haiku 36. Vals: Sonnet 70.9%, Haiku 58.7% | — |
| Office / knowledge work | GDPval-AA **1695** on AA's launch chart, where Astra had 1542 and Fable 5.1 1735 [I1b]; Snorkel Underwrite 2.0 **#1**, Finance 2.0 #3 [I3]; Vals Legal Index #10/38, but Finance Agent #26/40 [I6] | Opus 5.5 #1 on GDPval-AA v2.1 | After Opus / Sonnet, **ahead of GPT** |
| Math / reasoning | ARC-AGI-2 61.4%, ARC-AGI-3 1.8% [I7]; FrontierMath Tier 4 17% [I4]; Vals ProofBench 26% [I6] | ARC-AGI-2: Astra 95.0, Sol 94.2, Haiku 61.3 | Last fallback |
| Writing | arena Creative Writing #85 (1421) [I2] | Opus #2, Sonnet #29, Luna #98 | Last fallback |
| Vision | arena Vision #55 (1249) [I2] | Opus #6, Sonnet #43, Luna #68 | Last fallback |
| Chat | arena Text #92 (1443) [I2] | Opus #4, Sol #30, Luna #99 (1441), Haiku #133 | Last fallback (slow first token) |
| Research / search | Not on arena Search (Grok 4.5 is #13); SimpleQA Verified 56% [I4]; AA-Omniscience hallucination 29% [I1b] | Astra 1231, Sol 1230, Opus 1213 on arena Search | Last fallback |
| Long documents | 500K window; AA-LCR down 3.7 points from Grok 4.6, with no absolute figure published [I1b] | Others have 1M | Last fallback |
| Computer use | No result on any board | — | **Not routed** |
| Tool use (tau-bench, MCP Atlas) | No result | — | Late fallback (tiers 2-3) |
| Speed | 66 tok/s output; first answer token 9.9 s at low effort, 43 s at high [I1] | Sonnet 143 tok/s, Sol 49; first token Luna 1.57 s, Haiku 6.26 s | **Not routed for voice** |
| Cost | $2 / $6 per M, the lowest list price, but about 81K output tokens per AA task: **$7.77 per AA Index task** [I1][I1b] | Sol $1.27, Terra $0.96, Haiku $0.41, Astra $6.24 | Cheapest keeps it behind the $2 / $10 models |

- **Vendor claims** [X6]: xAI compares Grok 4.7 only with the previous generation, at xhigh against rivals at max. Its figures: CursorBench 4.0 46.3%, DeepSWE v1.1 71.0%, Terminal-Bench 4.0 37.6, and Harvey LAB 19.6 (18.3 independently on Vals).
- **Reviewer role.** Its lower hallucination rate (29%) makes it a plausible independent second opinion from another vendor, for example in a Council. There is no code-review or critic benchmark, so Auto doesn't depend on that.

## What's uncertain
- **AA Index 46 vs 35.** AA reported 46 at launch, under an earlier index version. Its leaderboard now shows 35 under v5. This page uses 35, next to the other models' current values.
- **Terminal-Bench 4.0 varies by harness.** Snorkel has 37.6, AA 33 and Vals 28.8.
- **Two speed figures.** AA's model page shows 66 tok/s; its launch article says "about 188 tok/s on long prompts".
- **GDPval-AA board versions.** Grok's 1695 is from AA's launch chart, which predates the v2.1 board the other models' numbers in docs/model-routing.md come from. It is compared only with models on the same chart (Astra 1542, Fable 5.1 1735).
- **No data** exists for OSWorld, tau-bench, Scale Labs or `grok-build-0.1`.
- **Grok 4.5 xhigh** is listed on its model page but ruled out by the reasoning guide.
- **Reasoning in usage.** The docs don't say whether `output_tokens` includes reasoning, so SahilBot uses `total_tokens - input_tokens` when it is larger.

## Sources
**xAI (VR):**
- X1: [Models](https://docs.x.ai/docs/models) and the model pages ([grok-4.7](https://docs.x.ai/docs/models/grok-4.7), [grok-4.6](https://docs.x.ai/docs/models/grok-4.6), [grok-4.5](https://docs.x.ai/docs/models/grok-4.5), [grok-4.3](https://docs.x.ai/docs/models/grok-4.3), [grok-build-0.1](https://docs.x.ai/docs/models/grok-build-0.1))
- X2: [Pricing](https://docs.x.ai/docs/pricing)
- X3: [Reasoning guide](https://docs.x.ai/docs/guides/reasoning)
- X4: [REST API reference](https://docs.x.ai/docs/api-reference) and [Chat Completions reference](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions)
- X5: [Consumption and rate limits](https://docs.x.ai/docs/key-information/consumption-and-rate-limits)
- X6: [Grok 4.7 announcement](https://x.ai/news/grok-4-7) (Sep 21, 2026)
- X7: [Best practices](https://docs.x.ai/developers/model-capabilities/text/best-practices)
- X8: [Debugging errors](https://docs.x.ai/developers/debugging)
- X9: [Priority processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing)

**Independent (IND):**
- I1: [Artificial Analysis, Grok 4.7](https://artificialanalysis.ai/models/grok-4-7) and [leaderboard](https://artificialanalysis.ai/leaderboards/models) (index v5.0.1)
- I1b: [Artificial Analysis, "Benchmarking Grok 4.7"](https://artificialanalysis.ai/articles/benchmarking-grok-4-7) (Sep 21, 2026)
- I2: arena.ai boards: [Text](https://arena.ai/leaderboard/text), [WebDev](https://arena.ai/leaderboard/webdev), [Vision](https://arena.ai/leaderboard/vision), [Search](https://arena.ai/leaderboard/search) and [Creative Writing](https://arena.ai/leaderboard/text/creative-writing) (Nov 8–11, 2026)
- I3: [Snorkel Terminal-Bench 4.0](https://snorkel.ai/leaderboard/terminal-bench-4-0/) (entries up to Nov 4, 2026), with the SnorkelUnderwrite and SnorkelFinance cards
- I4: [Epoch AI, Grok 4.7](https://epoch.ai/models/grok-4-7) (benchmarks hub updated Nov 15, 2026)
- I6: [Vals Index v2.2](https://www.vals.ai/benchmarks/vals_index) (Nov 11, 2026) and the [Grok 4.7 page](https://www.vals.ai/models/grok_grok-4.7)
- I7: [ARC Prize leaderboard](https://arcprize.org/leaderboard) (newest entry Nov 10, 2026)
- Review: [computingforgeeks, "Grok 4.7 tested"](https://computingforgeeks.com/grok-4-7-tested/) (Sep 25, 2026). In infrastructure tasks it passed 6 of 9 checks at both high and low effort. At high effort it used 23K output tokens against Sol's 8K.
