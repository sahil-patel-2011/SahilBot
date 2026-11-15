# How Auto picks a model

Auto picks a model in two steps for each message, and neither step calls a model:

1. **Classify.** Local rules in `src/main/llm/task-classifier.ts` read the request and decide, in one function, its category, a difficulty from 0 to 3, whether it runs as a chat or as the full agent, and the effort Auto thinks at (see [Rubrics](#rubrics) and [The classifier](#the-classifier)). The rules look at:
   - the text of the request;
   - attachments, including their size on disk;
   - whether the folder is a code project;
   - the mode: voice, Heavy, Team, Deep Research or Plan first.
2. **Route.** The table in `src/main/llm/routing-table.ts` gives an ordered list of candidate models for each category and tier. The list covers Claude, GPT and Grok together, each placed by its measured strengths in that category: quality first, then a balance of speed and cost. The first candidate that the user has switched on, can afford, can see images (when the request has them) and has a big enough context window wins.

The "routed" label on each reply names the model and the reason, for example "Claude Sonnet 5.5 · coding". The label's tooltip gives the full reason.

**Settings → Models → Auto prefers** has three options:

| Option | What it does |
|---|---|
| **Best result** (default) | Routes one tier above the request's difficulty, so each kind of task gets the strongest model. Chat stops at tier 2 and voice at tier 1, so both stay quick. |
| **Balanced** | Routes at the request's own difficulty: the cheapest model that is strong enough. This is how Auto worked before. Where GPT-6 Astra would lead the hardest row, its near-equal GPT-6.1 Sol leads instead, at a fifth of the price. |
| **Cheapest** | Routes one tier lower. Within a row, the cheapest model comes first. A free local model is used first whenever one is strong enough. |

These settings and conditions still apply on top of the preference:

| Setting or condition | Effect |
|---|---|
| Auto (local) | Uses local models only. |
| Auto (cloud) | Uses cloud models only. |
| Local or cloud first | Local first keeps a free local model for quick chats and light work when it is strong enough. Agent work (difficulty 2 or more: coding, research, tasks) still goes to the strongest suitable cloud model whenever one is on. |
| Use Fable for the hardest tasks | Fable leads the hardest row, but only where the evidence puts it ahead of Opus, so not for writing or office work. |
| Monthly spending limit (a specific amount) | A model the limit can't pay for is skipped. With less than 10% of it left, Auto routes as if Cheapest were chosen. |
| Monthly spending limit: Unlimited | No cap. Spend is still recorded and shown on the Usage page. |
| Monthly spending limit: None | No pay-per-use API model is used. Auto routes only to your ChatGPT plan (via Codex) and local models, and says why when neither is available. A model picked by name is refused before anything is sent. |
| Fast mode | Auto uses a provider's fast tier only where Settings → Models → Fast mode allows it. By default that is only for speed-sensitive requests: voice, small talk and quick code questions. See [Fast mode](#fast-mode). |
| Images in the request | Only models that can see images are considered. |
| Context window | The model's window must fit the prompt. If none fits, Auto uses the model with the biggest window. |

**Fallbacks:**
- If the first choice is off or missing, the next candidate in the row is used, then the rows above, then the rows below.
- Models the table doesn't name, such as OpenRouter models added by name, fall back to the older tier-based pick.

## Auto thinking

The thinking (effort) level comes out of the same decision as the category (`classifyTask` in `src/main/llm/task-classifier.ts`, levels in `src/main/llm/auto-effort.ts`). It follows the [effort rubric](#effort-rubric) and leans high: a little more thinking beats too little.

| Request | Level |
|---|---|
| Small talk, acknowledgments | Low |
| Quick questions, quick code questions, short writing, describing an image | Medium |
| Conversation that needs a lookup or advice (weather, a concept explained, a plan for a trip) | Medium |
| Standard work (difficulty 2): coding, research, computer use, office work, CAD, connector tasks, a cover letter, math with steps | High |
| The hardest (difficulty 3): refactors, proofs, multi-step work, long documents, high-stakes analysis | Extra |
| A hard conversation (a legal, medical or money decision) | High |
| Council | Extra at least |
| Heavy mode | Max |
| The request asks for it in words ("think as hard as you can") | that level at least |
| Voice | Low (Medium for the hardest) |

**Floors.** Besides category and difficulty, Auto reads stakes (legal, medical, money, production), whether a deliverable is expected (a file, a document, a code change), the length of the expected output, and the expected tool depth. Each sets a floor, never a ceiling: stakes, a deliverable or a long piece of output mean High at least; deep tool work (many steps) at difficulty 2+ means Extra.

**Follow-ups.** "Continue", "do it" or "make it shorter" keep the last request's category, difficulty, chat-or-agent and effort.

**Mid-run escalation.** Auto picks the level before the run knows how it will go. When a run hits 3 failed tool calls (errors or invalid calls), or its plan grows past 8 steps, it thinks one level harder for the rest of the run: once, up to Extra, and the chat says so ("Thinking raised to Extra for the rest of this task: 3 steps failed."). Nothing happens when the model can't take the higher level (Claude Sonnet 4.6 has no Extra, for example), so the note never claims a change that didn't happen.

Each provider maps the level onto what the model accepts: Claude's effort levels, OpenAI's `reasoning.effort` list per model, xAI's `reasoning.effort` (the level itself, else the nearest accepted level below).

A level picked by hand is used exactly, with no floors and no escalation. It can be picked in three places, and the most specific wins:
1. The chat (the composer's thinking picker).
2. The bot (Customize → Thinking).
3. The app default (Settings → Models → Thinking for new chats; Auto by default).

The model works the same way: the chat, then the bot, then the default. Auto applies in plain chats, agent runs and bots alike.

## Rubrics

The labels in `tests/fixtures/routing-eval.json` follow these rubrics, and `classifyTask` is built to them. When a request fits two rows, the first one listed wins.

### Category rubric

| Category | When |
|---|---|
| voice | A real-time voice conversation (whatever the words). |
| long-context | The new material (the message and its files) is 200K tokens or more. |
| (follow-up) | A short follow-up ("do it", "continue", "make it shorter", "looks good, ship it", "do the same for March") keeps the previous turn's category, unless it names a new deliverable ("now turn it into a slide deck" is office, "send it" is agent-tools). |
| research | The Deep Research toggle is on. |
| computer-use | Operating the screen, an app's UI or a website: click, type into, scroll, drag, log in to, fill out a form, add to cart, check out, book or return something on a site, open an app and do something in it. A question about clicking is not computer use. |
| cad | 3D parts and assemblies, CAD tools (Onshape, FreeCAD, Fusion, SolidWorks), STL / STEP, sketches, extrudes, fillets, tolerances and materials for a printed part. |
| coding | Changing, creating, running or debugging code: a repo, a build, tests, a script or program, an app or site to build, a pasted error to fix, a production incident. In a code project, "change X" is coding. |
| code-quick | A question about code or computer science answered in the reply, or a short self-contained snippet (a function, a regex, a query, a type). "Don't write any code, just explain" stays here. |
| math | Proofs, equations, probability, statistics, money math (a mortgage payment), quantitative puzzles. |
| agent-tools | The user's own data and connected apps: mail, calendar, reminders, messages, notes, files and folders on disk, Slack / Linear / HubSpot and the like, routines ("every morning…"), relays to other bots, recordings. |
| office | Making, editing or analysing a document, spreadsheet, deck, PDF, chart, dashboard or data file; reading an attached document. A document named up front ("Create a resume in Word from…") beats code words further on. |
| research | Investigation across sources: research, deep dives, literature reviews, studies, "with sources", competitor or market analysis, comparisons of several options, "find out which", "everything you can find". |
| vision | Understanding images when nothing above applies. |
| writing | Composing or editing prose returned in the reply: emails drafted (not sent), essays, posts, stories, poems, cover letters, speeches, rewrites, tone. |
| chat | Small talk, simple facts, advice, explanations, live quick facts (weather, scores, prices), connected-app questions asked as questions. |

### Chat-or-agent rubric

**Agent** when any of these hold (in this order):
- a mode toggle is on (Plan first, Team, Deep Research, Heavy, Council);
- non-image files or folders are attached;
- a plan is in progress and the message is short;
- it runs as a helper, a routine (unattended) or in a group chat;
- it's a follow-up to agent work;
- the category is coding, computer-use, long-context, agent-tools or office;
- it's CAD work that changes a model (not a question about one);
- it's research with depth (several sources, a report, citations, rankings);
- it's voice that uses apps (timers, reminders, calls, reading mail);
- it's writing that is saved or sent.

**Chat** otherwise: conversation, questions (code questions included), explanations, advice, short writing in the reply, translation, math worked in the reply, quick live facts (a chat can still search the web), describing images.

Scoring: running a chat as the agent is acceptable (it costs a little speed); running agent work as a chat is the error that matters.

### Difficulty rubric

| Tier | What |
|---|---|
| 0 | Small talk, thanks, acknowledgments, one-word or empty messages. |
| 1 | A quick fact or definition, a simple how-to, a short translation, a short generic creative piece (a haiku, a tagline, a caption), a short rewrite, a code question, simple arithmetic, describing an image, a question about a part. |
| 2 | One standard deliverable or routine tool use: send an email, add an event, fix a specific bug, write a cover letter or a story, make a spreadsheet, summarize a file, look up live facts, explain a concept in depth, math with steps, analyse an image, a CAD edit. Coding, computer use and long documents are never below 2. |
| 3 | The hardest: several steps or deliverables ("…and then…"; a login is not a step), refactors, migrations, performance work and new apps, proofs and olympiad problems, high stakes (contracts, leases, taxes, medical worries, investments, production incidents, purchases and bookings), long output ("3,000 words", a novel, a pitch deck, a financial model), quality words ("perfect", "production-ready", "thorough", "comprehensive"), 200K+ token inputs, attached folders, Heavy and Council. |

When unsure between two tiers, pick the higher one.

### Effort rubric

| | Difficulty 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| chat | Low | Medium | Medium | High |
| voice | Low | Low | Low | Medium |
| every other category | Low | Medium | High | Extra |

Then the floors: Heavy at the hardest tier is Max; Council is Extra at least; a request that asks for more in words gets at least that ("think as hard as you can" Max, "think carefully" High); stakes, a deliverable and long output are High at least. Follow-ups keep the previous level.

### Label review

The labels were written by hand to these rubrics. While writing the rubric, four labels were changed for consistency (multi-step coding to tier 3, purchases to tier 3, a business plan to tier 3, Council's Extra floor). A seeded sample of 60 items was then reviewed twice. The first pass flagged one borderline item ("Log into the Acme portal and send them a quote request", kept at tier 2, which added the rule "a login is not a step"). The second pass changed nothing.

## The classifier

`classifyTask(text, ctx)` in `src/main/llm/task-classifier.ts` is the one decision for each request. It returns the category, difficulty, chat or agent, effort and a calibrated confidence. `agent/intent.ts` `classifyTask` (chat or agent) is the same decision: `loop.ts` passes it the routed decision (`route`), and called alone it runs the same function. So "coding" never runs as a chat, and `consistent()` checks this on every eval item.

**Features:**
- **Normalizing.** Typos one edit away from a word the rules know are fixed ("schedul a meetign", "refactr", "reactt"); the first letter, plurals and a list of real words are never "corrected". Shorthand is expanded ("pls", "tmrw", "fx"). Keywords in Spanish, Portuguese, French, German, Chinese, Japanese and romanized Hindi are glossed into English.
- **Verbs and objects.** Action verbs paired with the things they act on: code objects (languages, frameworks, files by extension, errors, builds, CI), UI targets (apps, sites, forms, carts), CAD terms, documents and data, mail / calendar / files, research words.
- **Question or order.** Whether the request asks ("what…", "how do I…") or orders ("fix…", "can you make…"). "What can you do for me?" is still a question.
- **Length and structure.** Several steps ("and then", ", then email it"), long requests, pasted code and tracebacks.
- **Words about the work.** Quality words ("perfect", "production-ready", "thorough"), stakes words (legal, medical, money, production), deadlines and urgency ("RIGHT NOW", "the site is down"), quick words ("quick q", "one-liner"), explicit effort asks.
- **Context.** Attachments and their types (PDF / Office files are documents, STEP / STL are CAD, images are vision), the chat's code project, the bot's role (a weak prior for vague requests such as "fix it" for a coding bot or "any news?" for a news bot), voice, modes, routines, helpers, groups, and the previous turn's category, difficulty, kind and effort for follow-ups.

**Confidence** is per decision path (`RULE_CONFIDENCE`), calibrated on blind data. The rules were tuned on the eval items, so their precision there (about 100%) says little. On the second blind batch, measured before any fix, the specific paths were right on every item they fired on, and the generic fallbacks were not (chat 5/12, chat:question 5/9, the connector path 2/4). So the fallbacks sit below `CONFIDENT` (0.75) and the specific paths above it. On the whole set, confident decisions are right 475/475 times.

**The eval** (`tests/unit/routing-eval.test.ts`): 554 labelled requests across every category, kind, difficulty, effort level and modality: follow-ups with prior context, multilingual, typos, mixed tasks, attachments (code, PDF, images, spreadsheets, 200K-900K-token documents), voice, bots with roles, routines, groups, modes and adversarial cases. The test reports accuracy per field and a confusion matrix, and asserts:
- category at least 92%;
- chat-vs-agent at least 95%, where running a chat as the agent counts as acceptable (strict at least 88%);
- effort within one level at least 97%, and too low at most 2%.

| | Category | Chat-vs-agent (lenient) | Effort within one | Effort too low |
|---|---|---|---|---|
| Baseline: old classifiers, 343 dev items | 67.3% | 81.3% | 95.9% | 28.0% |
| Final, all 554 items | 100% | 100% | 100% | 0% |
| Blind batch 1 (110), before it was used | 77.3% | 87.3% | 94.5% | 20.9% |
| Blind batch 2 (58), before it was used | 74.1% | 81.0% | 98.3% | 25.9% |
| Blind batch 3 (43), before it was used | 62.8% | 81.4% | 93.0% | 20.9% |

The final row is on items the rules were tuned on. The blind rows are the honest estimate for new phrasing: rules generalize to roughly 65-77% category accuracy on wording they haven't seen. After each blind batch was measured, its misses were fixed with general rules (lexicon gaps, a regex that let "drag" match "dragon", "prime" matching "prime minister"), never with item-specific ones. In batch 3, 10 of the 16 category misses were flagged as unsure, which is where a tie-breaker would act.

## Tie-breaker

`src/main/llm/route-tiebreak.ts` is an optional tie-breaker for unsure decisions:
- one tiny call to the cheapest fast cloud model (Haiku 5.5 or GPT-6 Luna) with a strict JSON schema (`category`, `kind`, `difficulty`);
- a 1.5 s timeout, and one answer cached per message;
- off with no cloud key or model, when the spend limit is None, or when the month's budget is spent;
- folded in with the same upward bias: the higher difficulty, agent if either side says so;
- tested with fakes only.

**Decision: built, not wired in.**
- **The gain isn't clear.** On the eval set it would ask on 79 of 554 requests (14.3%). An oracle answerer gains nothing there, because the rules already get those right, and an 80%-accurate model costs 2.7 points (100% → 97.3%). On blind batch 2, the unsure decisions were wrong 11 times in 21, so a good model could help on new wording. That can't be measured without paid calls.
- **Latency doesn't fit.** The repo's own first-token data at low effort (Haiku 5.5 6.26 s, Luna 1.57 s) says neither model reliably answers within 1.5 s. Most asks would add up to 1.5 s and then time out.

Wire it into `loop.ts` `chooseModel` (after `classifyTask`, only when `!task.confident`) once real answers and latency have been measured.

## Per-model context window

Each model on **Settings → Models → Installed and available** has a **Context window** select. Its first option is "Default (follow strategy)", followed only by the sizes that model's provider offers (`src/shared/context-choices.ts`, from the model tables):

| Model | Choices |
|---|---|
| 1M-window models (Claude 5.x, Grok 4.3) | 128K, 256K, 512K, 1M (full window) |
| GPT-6.x / 5.6 (1.05M) | 128K, 256K, 512K, 1.05M (full window); above 272K marked "higher price tier" (OpenAI bills those prompts at 2x input, 1.5x output) |
| 400K models (GPT-5.4 mini, GPT-5.2) | 128K, 256K, 400K (full window) |
| 500K models (Grok 4.7 / 4.6 / 4.5) | 128K, 256K, 500K (full window) |
| 200K models (Claude Haiku 4.5) | 128K, 200K (full window) |
| Local models | 16K / 32K / 64K / 128K, up to the most that fits this Mac (the model's `maxFittingWindow`) |
| A cloud model with no known window | Default only |

**How the choice is applied** (`src/main/llm/context-window.ts`, used by `windowFor` in `loop.ts`):
- The choice is used exactly. The only clamp is the provider's maximum prompt: for Claude, the window minus room for the reply (a 1M pick is 936K); for OpenAI, the input limit (a 1.05M pick on GPT-6 is 922K, a 400K pick on GPT-5.4 mini is 272K); for a local model, what fits this Mac (never below 16K).
- It overrides the global context strategy and the local "Context window" setting for that model, voice included.
- Compaction follows the window: the server-side trigger is 80% of it (`compactionTrigger`, `openaiCompactAt`), and the client-side context manager budgets against it.
- Default keeps today's behavior: the context strategy for cloud models, and the global setting plus what fits for local ones.

## What you pick is what happens

What the app does with each manual choice (tests in `tests/unit/manual-choices.test.ts`; the rules are in `src/main/agent/choices.ts`):

| Choice | What the app does |
|---|---|
| Model (chat, bot, default) | Used for every step. If it's gone (deleted, key removed), the chat says so and that chat, bot or default moves to Auto. If it errors after retries, the next stronger model answers and the chat says which and why: "Claude Opus 5.5 is unavailable (rate limited); used Claude Sonnet 5.5 for the rest of this task." A picked model is never swapped for making invalid tool calls; only Auto's own picks are. |
| Effort (chat, bot, default) | Sent exactly on every step: no floors, no adaptive shift, no escalation. Each provider maps it to the nearest level the model accepts. |
| Context window (per model) | Used exactly, clamped only to the provider's maximum. |
| Plan first, Team, Deep Research | Sent as chosen. Each makes the run full agent work, and each sets a difficulty floor. Deep Research turns on its team. |
| Heavy, Council | Exclusive in the composer: turning one on hides the other modes, and the main process enforces the same if a message arrives with several. |
| Permission mode | The chat's mode is left as chosen. It is only ever made stricter, for a handoff from a stricter bot or untrusted relayed content (security). |
| Fast mode | A per-model "on" / "off" / "ultrafast" is honored exactly. Auto's "only where speed matters" rule applies only to models Auto picked. |
| Per-bot model and effort | Used for the bot's chats. The chat's own pick wins over the bot's. |

**Found in the audit and left to the owners:** Council and swarm merge / final steps (`loop.ts` swarm and council `final` callbacks) send effort `'high'` regardless of the chat's picked level.

Evidence below was read on **2026-11-15**. VR means vendor-reported, from the Anthropic or OpenAI announcement or docs. IND means independent. Each number links to its source in [Sources](#sources).

## The models

| | Claude Fable 5.2 | Claude Opus 5.5 | Claude Sonnet 5.5 | Claude Haiku 5.5 | GPT-6 Astra | GPT-6.1 Sol | GPT-6.1 Terra | GPT-6 Luna |
|---|---|---|---|---|---|---|---|---|
| Released | Nov 9 | Sep 22 | Sep 28 | Oct 7 | Sep 3 | Sep 29 | Oct 26 | Sep 22 |
| $ per 1M tokens, in / out [A1][O1] | 8 / 40 | 4 / 20 | 2 / 10 | 0.10 / 0.50 (≤100K tokens), then 0.50 / 2.50 | 10 / 50 | 2 / 10 | 1 / 5 | 0.10 / 0.50 |
| Over 272K input [O1] | standard rates | standard rates | standard rates | as above | 2x input, 1.5x output | same as Astra | same as Astra | same as Astra |
| Context / max output | 1M / 128K | 1M / 128K | 1M / 128K | 1M / 128K | 1.05M (922K input) / 128K | same as Astra | same as Astra | same as Astra |
| AA Intelligence Index, max effort (IND) [I1] | **65** | 59 | 55 | 36 | 57 | 55 | 51 | 28 |
| Output tokens/s (IND) [I1] | 102 | 114 | 143 | **255** | 40 | 49 | 71 | 103 |
| Time to first answer token at low effort (IND) [I1] | n/a | 5.32 s | 2.50 s | 6.26 s | 3.82 s | 3.22 s | 1.96 s (no reasoning) | **1.57 s** (no reasoning) |
| AA cost per Index task (IND) [I1] | $26.54 | $10.04 | $10.02 | $0.41 | $6.24 | $1.27 | $0.96 | $0.15 |

Notes on the table:
- Fable 5.1 (Sep 1, $10 / $50) is now Legacy. Each Fable model also has a restricted twin, Mythos, with the same specs [A1].
- Every model above takes images and supports computer use: Claude through `computer_toolset_20260801` [A2], GPT through the Responses `computer` tool [O3].
- Auto treats Fable as premium. It is used only with the Fable setting on, or when picked by name.

### Grok 4.7 (xAI)

Full figures and sources are in [docs/grok.md](grok.md). The columns match the table above.
- **Released:** Sep 21.
- **Price:** $2 / $6 per M; at 200K prompt tokens or more, $4 / $12 for the whole request [X2].
- **Context:** 500K, with 128K output by default.
- **AA Intelligence Index (IND):** 35 at xhigh [G1].
- **Output speed:** 66 tok/s [G1].
- **Time to first answer token at low effort:** 9.9 s, the slowest here [G1].
- **AA cost per Index task:** $7.77. It uses about 81K output tokens per task, so it costs more per task than Sol, Terra or Haiku despite the lowest list price [G1][G2].

Grok is routed like every other model, by category: it leads no row. In office work it comes right after Opus / Sonnet and ahead of GPT. Elsewhere it is a later fallback. It isn't used for computer use (no data) or voice (slow first token).

## Routing by task

Each table shows three choices:
- **First**: the first choice on Best result.
- **Runner-up**: used when the first choice isn't available.
- **Cheap / fast**: where Balanced or Cheapest go for lighter requests.

### Coding and debugging (agentic, multi-file)

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Opus 5.5; Claude Sonnet 5.5 on Balanced | GPT-6 Astra or GPT-6.1 Sol | Claude Haiku 5.5, GPT-6.1 Terra |

- **Terminal-Bench 4.0, IND [I3]:**
  - Opus 5.5 **64.8%** (#1)
  - Sonnet 5.5 61.8%
  - GPT-6 Astra 58.2%
  - GPT-6.1 Sol 58.2%
  - GPT-6.1 Terra 51.8%
  - Haiku 5.5 40.0%
  - GPT-6 Luna 16.4%
- **Terminal-Bench 4.0, VR [A3][A4]:** Sonnet 5.5 70.6%, Opus 5.5 66.4%.
- **arena WebDev, IND [I2]:** Fable 5.2 #1, Opus 5.5 #2, Sonnet 5.5 #3, Astra #5, Sol #6.
- **Scale SWE Atlas, IND [I5]:** Fable 5.2 80.5, Opus 5.5 77.4.
- **Vals, IND [I6]:** Opus 5.5 is #1 on SWE-bench Multimodal (70.2%).
- **DeepSWE v1.1, VR, OpenAI's own [O2]:** 6.1 Sol 75.2, Astra 74.8, Sonnet 5.5 71.0. This is why Sol is the GPT runner-up.
- **SWE-bench Verified and SWE-bench Pro:** neither vendor reports them for these models. Verified is saturated, and the top 3 on Scale's SWE-Bench Pro board has no 5.5 or GPT-6 model [I5]. Aider polyglot was last updated in 2025.

- **Grok 4.7 (IND):** Terminal-Bench 4.0 37.6% (#16, below Haiku's 40.0) [I3]; arena WebDev #24 (1641) [I2]; Vals SWE-bench Multimodal 42.9% (#15/22) [G3]. It is the last fallback in each coding row.

### Quick code questions

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Sonnet 5.5 | GPT-6.1 Sol | GPT-6.1 Terra, Claude Haiku 5.5 |

Speed matters most here. Sonnet 5.5 is the fastest flagship (143 tok/s, 2.50 s to first token) and is second on Terminal-Bench 4.0. Terra reaches 51.8% on Terminal-Bench 4.0 with a 1.96 s first token, at $1 / $5 [I1][I3].

Grok 4.7 has a 9.9 s first token at low effort [G1], so it is only a last fallback at tiers 2 and 3.

### Computer use and browser automation

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Opus 5.5; Claude Sonnet 5.5 on Balanced | GPT-6 Astra at the hardest tier, GPT-6.1 Sol below it | Claude Haiku 5.5, GPT-6.1 Terra |

Evidence re-checked on **2026-11-15** (details and every link in [docs/computer-use.md](computer-use.md#the-evidence)):
- **OSWorld 2.1, offline subset, VR:** Fable 5.2 89.3, Opus 5.5 87.2, Astra 79.5 [A5]; Sonnet 5.5 83.9, Haiku 5.5 72.4 [A6]. OpenAI's own chart: Astra 80.9, 6.1 Sol 78.0, 6.1 Terra 74.2 at max effort (66.7 at medium) [O2].
- **OSWorld 2.1, full set, VR:** Opus 5.5 81.8 [A3], Sonnet 5.5 80.1 [A4] (partial credit). Strict scores, as relayed from the system cards: Opus 48.7, Sonnet 43.5.
- **Grounding only (click accuracy), ScreenSpot-Pro, VR:** Astra 92.7. No figure for any Claude 5.5, Fable 5.2, Sol, Terra or Grok 4.7.
- **Vals CUA-bench, IND (2026-10-13):** Astra 19.17, Opus 5.5 14.00 [I6]. It's the only independent GUI-only eval with these models.
- **Epoch AI rates OSWorld 2.1 "Flawed":** 36 of 50 audited tasks had errors. Gaps of a few points are noise.
- **No official independent OSWorld result exists for these models.** The official board (OSWorld 2.0 tasks, v2.1 release, read 2026-11-14) tops out at Claude Opus 5 (max effort): 48.65% binary on the offline subset and 44.33% on the full set, with partial scores of 79.2 and 77.67 [I8]. The vendors' 5.5 / GPT-6 numbers above are partial-credit scores.
- **OpenAI calls Terra good at "precise computer use"** but gives no grounding number. On its own chart Sol beats Terra at every effort level.
- **No source tests a planner/executor split, or separates planning from clicking for any Claude model.**
- Within SahilBot, Claude also drives the screen through its native computer toolset.
- **Multi-step tasks run as Planner + executor** (Settings → Models → Computer use; [docs/computer-use.md](computer-use.md#planner-and-executor)):
  - Opus 5.5 plans and Sonnet 5.5 executes when both are on.
  - GPT-only: Astra plans and Sol executes on Balanced at the hardest tier.
  - The Executor model setting overrides the executor (for example GPT-6 Astra, for its grounding).

- **Grok:** no computer-use result exists on any board, so it isn't routed here.

### Deep research and synthesis with citations

| First | Runner-up | Cheap / fast |
|---|---|---|
| GPT-6 Astra; GPT-6.1 Sol on Balanced | Claude Opus 5.5 | Claude Sonnet 5.5, GPT-6.1 Terra |

- **arena Search, IND [I2]:** Astra 1231, 6.1 Sol 1230, Opus 5.5 1213.
- **BrowseComp, VR [O2]:** Astra 91.5. No Claude 5.5 figure was published, and no independent BrowseComp exists.
- **Humanity's Last Exam:**
  - Fable 5.2 leads: 74.3 on AA [I1], 72.4 on Scale [I5].
  - On Scale, Astra 60.6 is ahead of Opus 5.5 55.0 [I5].
  - With tools (VR): Opus 5.5 67.7 [A3].
- **GDPval-AA, IND [I1]:** Opus 5.5 is #1. That board measures synthesis-heavy knowledge work.
- **Factual errors, VR [O2]:** Sol's error rate is 7.7%.
- This category is close. Astra edges ahead on search. Opus edges ahead on synthesis.

- **Grok 4.7:** it is not on arena Search; Grok 4.5 is #13 at 1216 [I2]. It scores 56% on SimpleQA Verified [I4] and has a 29% AA-Omniscience hallucination rate [G2]. It is the last fallback.

### Long documents (500K+ tokens)

| First | Runner-up | Cheap / fast |
|---|---|---|
| GPT-6 Astra; on Balanced Claude Sonnet 5.5, or Claude Opus 5.5 for the hardest | Claude Opus 5.5 / GPT-6.1 Sol | Claude Sonnet 5.5, Claude Haiku 5.5 |

- **MRCR v2 8-needle at 512K to 1M, VR [O2]:** Astra 96.3.
- **No Claude 5.5 long-context figure was published.** The independent AA-LCR board shows neither family [I1].
- **Price at 600K tokens in:**
  - Claude bills its whole 1M window at standard rates: Sonnet $2 per M, Opus $4 per M, Haiku $0.50 per M past 100K.
  - OpenAI doubles the input rate past 272K: Sol $4 per M, Astra $20 per M.
  - So Balanced uses Sonnet for routine reads and Opus for the hardest ones.

- **Grok 4.7:** its window is 500K, half the others'. Its AA-LCR score fell 3.7 points from Grok 4.6, and no absolute figure was published [G2]. It is the last fallback at tiers 2 and 3. Requests above about 480K go elsewhere because of the window check.

### Writing and editing

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Opus 5.5 | Claude Sonnet 5.5, then GPT-6 Astra | Claude Haiku 5.5, GPT-6.1 Terra |

**arena Creative Writing, IND [I2]:**
- Opus 5.5 **#2** (1517), Fable 5 #4 (1501), Fable 5.1 #8 (1490)
- Sonnet 5.5 #29 (1464), Astra #40 (1451), 6.1 Sol #43 (1449), Luna #98

Opus ranks above every Fable on this board, so Fable is not used for writing even with the Fable setting on. OpenAI says only that Terra writes "clear, natural" text [O2], with no figures. No current EQ-Bench data could be read.

- **Grok 4.7:** arena Creative Writing #85 (1421), above only Luna [I2]. It is the last fallback.

### Office documents, spreadsheets and data analysis

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Opus 5.5; Claude Sonnet 5.5 on Balanced | GPT-6.1 Sol | Claude Haiku 5.5 |

- **GDPval-AA v2.1, IND [I1]:**
  - Opus 5.5 **#1** (1866), Sonnet 5.5 #4 (1838), Fable 5.2 #6 (1831)
  - Haiku 5.5 #32 (1629), 6.1 Sol #41 (1607), Astra #48 (1587)
- **Vals Finance Agent, IND [I6]:** Opus 5.5 is #2.
- **GDP.pdf, VR, OpenAI's own [O2]:** Astra 32.2, Sol 32.0, Opus 5.5 28.8.
- Opus is above Fable here too, so Fable is not used.

- **Grok 4.7 (its relative strength):**
  - GDPval-AA 1695 on AA's launch chart, where Astra had 1542 and Fable 5.1 1735 [G2]. That chart is older than v2.1 above, so it is compared only within its own chart.
  - SnorkelUnderwrite 2.0 #1 and SnorkelFinance 2.0 #3 [I3].
  - Vals Legal Index #10/38, but Finance Agent #26/40 [G3].
  - Auto puts Grok right after Opus / Sonnet and ahead of GPT-6.1 Sol and Astra.

### Math and reasoning

| First | Runner-up | Cheap / fast |
|---|---|---|
| GPT-6 Astra; GPT-6.1 Sol on Balanced | Claude Opus 5.5 | GPT-6.1 Terra |

- **ARC-AGI-2, IND [I7]:** Astra 95.0, Sol 94.2, Fable 5.2 93.8, Opus 5.5 93.3.
- **ARC-AGI-3, IND [I7]:** Fable 5.2 81.2, Astra 62.7.
- **GPQA Diamond:** Astra 96.3 (IND) [O4].
- **FrontierMath Tier 4, VR [O2]:** Astra 97.6.
- **FrontierMath Erdős, IND [I4]:** 6.1 Sol is first, at 4%.
- **Vals, IND [I6]:** Opus 5.5 scores 100% on ProofBench and 95% on IOI.
- With the Fable setting on, Fable leads the hardest row. It is ahead on ARC-AGI-3 and Humanity's Last Exam.
- AIME is not reported by either vendor for these models.

- **Grok 4.7:** ARC-AGI-2 61.4 (Haiku 61.3) and ARC-AGI-3 1.8 [I7]; FrontierMath Tier 4 17% [I4]; Vals ProofBench 26% [G3]. It is the last fallback.

### Images and screenshots

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Opus 5.5 at the top; GPT-6.1 Sol for everyday images | GPT-6 Astra | GPT-6.1 Terra |

- **arena Vision, IND [I2]:**
  - Fable 5 #1
  - Opus 5.5 #6 (1295), 6.1 Sol #12 (1293), Astra #21 (1283)
  - Sonnet 5.5 #43 (1263), Luna #68
- **MMMU-Pro, VR [O2]:** Astra 86.7, Sol 86.3, Terra 85.5. OpenAI positions Terra for visual reasoning.
- **Chartography without tools, VR [A5]:** Fable 5.2 73.4, Opus 64.4, Sonnet 61.6.

- **Grok 4.7:** arena Vision #55 (1249), above only Luna [I2]. It is the last fallback.

### Tool-heavy agent work with connectors

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Opus 5.5; Claude Sonnet 5.5 on Balanced | GPT-6.1 Sol | Claude Haiku 5.5, GPT-6.1 Terra |

- **arena Agent, IND [I2]:** Fable 5.2 30.5, Opus 5.5 19.5, Sonnet 5.5 16.1, Astra 14.6, 6.1 Sol 12.4, Terra 12.0.
- **AutomationBench, VR:** Fable 5.2 51.4 and Opus 40.0 [A5][A3]; 6.1 Sol 35.4 at medium effort [O2].
- **Agents' Last Exam, VR, OpenAI's own [O2]:** Terra 60.0, Astra 59.3.
- **MCP Atlas and tau2-bench, IND [I5][I9]:** no 5.5 or GPT-6 model is in the top 3 of either.

- **Grok:** no tau-bench, MCP Atlas or arena Agent result. It is only a last fallback at tiers 2 and 3.

### CAD and mechanical design

Parts, assemblies and 3D printing through the Onshape and FreeCAD tools: long, exact tool chains over a feature tree, plus spatial reasoning. No CAD benchmark covers these models, so the row follows the nearest evidence: agentic tool use (arena Agent, AutomationBench: Opus ahead of Sonnet ahead of Sol) and coding (Terminal-Bench 4.0: Opus 64.8, Sonnet 61.8, Sol 58.2). Questions about tolerances or materials are light (difficulty 1); edits are standard; designs from requirements, assemblies and interference checks are the hardest.

| Tier | Order |
|---|---|
| 0 | Haiku, Sonnet, Terra |
| 1 | Sonnet, Terra, Haiku, Sol |
| 2 | Sonnet, Opus, Sol, Astra |
| 3 | Opus, Sonnet, Sol, Astra (Fable first with "Use Fable for the hardest tasks") |

### Simple chat and small talk

| First | Runner-up | Cheap / fast |
|---|---|---|
| Claude Sonnet 5.5 | GPT-6.1 Terra | GPT-6 Luna, Claude Haiku 5.5 |

- **arena Text, IND [I2]:**
  - Opus 5.5 #4 (1507), 6.1 Sol #30 (1481), Sonnet 5.5 #47 (1473)
  - Luna #99 (1441), Haiku 5.5 #133 (1421)
- **Time to first token, IND [I1]:** Luna 1.57 s, Terra 1.96 s, Sonnet 2.50 s, Haiku 6.26 s.
- Small talk on Balanced goes to Luna: it costs the same as Haiku, starts faster and ranks higher on arena Text. Haiku is next.

- **Grok 4.7:** arena Text #92 (1443), level with Luna (1441) and above Haiku (1421) [I2]. Its 9.9 s first token and $2 / $6 price put it after every faster model of similar quality. It is the last fallback.

### Voice (low latency)

| First | Runner-up | Cheap / fast |
|---|---|---|
| GPT-6.1 Terra | Claude Sonnet 5.5 | GPT-6 Luna |

The first token decides how fast speech starts. At low effort [I1]:
- Luna 1.57 s and Terra 1.96 s (no reasoning)
- Sonnet 2.50 s, Sol 3.22 s, Haiku 6.26 s

Haiku is the fastest at writing tokens (255 tok/s), but it waits longest for the first one. OpenAI's speech-to-speech models (gpt-live-1: 0.80 s turn-taking, VR [O5]; gpt-realtime-2.1) are not chat models in SahilBot.

On Balanced or Cheapest, or with Local first, voice still uses a small local model (no network round trip), as before. Best result with cloud first uses the voice row above.

Grok isn't used for voice: its first token takes 9.9 s at low effort [G1].

## Fast mode

Fast mode is in **Settings → Models → Fast mode**. Each provider has a switch, off by default, and each model can be set to inherit, on, off, or (OpenAI Astra and 6.1 Sol only) Ultrafast. A fast request is priced at its real multiplier: in the monthly limit's worst-case check, in what is recorded, and in each step's cost chip. If the provider reports that a request ran at standard speed, it is recorded at the standard price. Read on 2026-11-15:

| Provider | Mechanism | Speed | Price | Models |
|---|---|---|---|---|
| Anthropic [F1] | `speed: "fast"` on the Messages request; `usage.speed` reports `fast` or `standard` | "up to 2.5x higher output tokens per second" (output speed, not time to first token) | 2x: Opus 5.5 $8 / $40, Fable / Mythos 5.2 $16 / $80, Opus 5 / 4.8 $10 / $50. Caching multipliers apply on top. | Fable 5.2, Mythos 5.2, Opus 5.5. Opus 5 is a research preview and Opus 4.8 is deprecated (removal Nov 30, 2026); both need the `fast-mode-2026-02-01` beta header. |
| OpenAI [F2][F3][F4] | `service_tier: "fast"` (Priority was renamed Fast mode on Jul 30, 2026; `"priority"` works the same); `service_tier: "ultrafast"` | Fast: "up to 2.5x faster". Ultrafast: "the fastest service tier in the OpenAI API". | Fast: 2x on the GPT-6 / 5.6 / 5.4 lineups (gpt-5.5 2.5x; older models 1.67x to 1.8x). Ultrafast: 6x (Astra $60 / $300, Sol $12 / $60). | Fast on most models; Ultrafast only on gpt-6-astra and gpt-6.1-sol (Responses API) |
| xAI [X2][X9] | `service_tier: "priority"` (`"fast"` is the same tier) | Scheduled ahead of standard traffic when priority capacity is free | 2x, billed only when the response confirms `priority` | Grok chat models (Grok 4.7 Fast is Cursor / Grok Build only) |

Notes on fast mode:
- **Anthropic over its fast rate limit (429 / 529).** SahilBot follows Anthropic's documented fallback: it sends the same request once more at standard speed, which also misses the prompt cache.
- **OpenAI downgrades.** OpenAI may downgrade a fast request ("charge standard rates"); the response then says `default`.
- **When Auto may use fast mode.** Only where fast mode is allowed for the model. There are three choices: *Only where speed matters* (the default: voice, small talk, quick code questions), *Whenever allowed*, and *Never*.

## What's uncertain## What's uncertain
- **Mostly vendor-reported numbers.** Both vendors moved to newer benchmarks (Terminal-Bench 4.0, OSWorld 2.x, FrontierCode, GDPval-AA, AutomationBench). Independent coverage exists for coding (Terminal-Bench 4.0, arena), knowledge work (GDPval-AA), arena boards, ARC and composite indexes. It is thin for computer use, long context and tool use.
- **Vendor numbers vary by page.** The same model's score can differ between vendor pages; for example Opus 5.5 on OSWorld 2.1 is 81.8 on its own page and 87.2 on the Fable 5.2 page.
- **Some secondary sources had misaligned columns.** OpenAI's HLE row as relayed by the-decoder is one example. Those rows were not used.
- **Fable 5.2 is new.** It came out on Nov 9, and many boards list only Fable 5.1. SahilBot's price table now has Fable 5.2 at $8 / $40.
- **First-token times include reasoning.** They come from Artificial Analysis at low effort. SahilBot sends low effort in voice, but the real first-token time depends on prompt size and network.

## Sources
**Grok and fast mode (read 2026-11-15; more in [docs/grok.md](grok.md)):**
- X2: [xAI pricing](https://docs.x.ai/docs/pricing); X9: [xAI priority processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing)
- G1 (IND): [Artificial Analysis, Grok 4.7](https://artificialanalysis.ai/models/grok-4-7)
- G2 (IND): [Artificial Analysis, "Benchmarking Grok 4.7"](https://artificialanalysis.ai/articles/benchmarking-grok-4-7) (Sep 21, 2026)
- G3 (IND): [Vals, Grok 4.7](https://www.vals.ai/models/grok_grok-4.7)
- F1: [Anthropic fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- F2: [OpenAI fast mode](https://developers.openai.com/api/docs/guides/fast-mode); F3: [OpenAI Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode); F4: [OpenAI pricing](https://developers.openai.com/api/docs/pricing) (Fast and Ultrafast tables)

**Anthropic (VR):**
- A1: [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) and [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- A2: [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- A3: [Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5) (Sep 22, 2026)
- A4: [Claude Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5) (Sep 28, 2026)
- A5: [Claude Fable and Mythos 5.2](https://www.anthropic.com/claude-fable-and-mythos-5-2) (Nov 9, 2026)
- A6: [Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5) (Oct 7, 2026)

**OpenAI:**
- O1 (VR): [Models](https://developers.openai.com/api/docs/models), [pricing](https://developers.openai.com/api/docs/pricing) and [changelog](https://developers.openai.com/api/docs/changelog)
- O2 (VR, relayed): OpenAI launch charts as relayed by [the-decoder](https://the-decoder.com/gpt-6-astra-is-the-first-model-making-openai-willing-to-declare-the-agi-era/), [Vellum on 6.1 Sol](https://www.vellum.ai/md/blog/gpt-6-1-sol-benchmarks-explained), [Vellum on 6 Sol and Luna](https://www.vellum.ai/md/blog/gpt-6-sol-and-luna-benchmarks-explained), [llm-stats on 6.1 Terra](https://llm-stats.com/blog/research/gpt-6-1-terra-launch) and [computingforgeeks](https://computingforgeeks.com/gpt-6-astra-released-features-benchmarks/). openai.com itself returned 403 to the fetcher.
- O3 (VR): [Computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
- O4 (IND): [The Batch, Sep 11, 2026](https://www.deeplearning.ai/the-batch/gpt-6-astra-is-a-star)
- O5 (VR): [gpt-live-1](https://developers.openai.com/api/docs/models/gpt-live-1.md)

**Independent:**
- I1: Artificial Analysis model pages: [Opus 5.5](https://artificialanalysis.ai/models/claude-opus-5-5), [Sonnet 5.5](https://artificialanalysis.ai/models/claude-sonnet-5-5), [Haiku 5.5](https://artificialanalysis.ai/models/claude-haiku-5-5), [Fable 5.2](https://artificialanalysis.ai/models/claude-fable-5-2), [Astra](https://artificialanalysis.ai/models/gpt-6-astra), [6.1 Sol](https://artificialanalysis.ai/models/gpt-6-1-sol), [6.1 Terra](https://artificialanalysis.ai/models/gpt-6-1-terra), [Luna](https://artificialanalysis.ai/models/gpt-6-luna)
- I1 (evaluations): [GDPval-AA](https://artificialanalysis.ai/evaluations/gdpval-aa), [HLE](https://artificialanalysis.ai/evaluations/humanitys-last-exam), [AA-LCR](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning)
- I2: arena.ai boards: [Text](https://arena.ai/leaderboard/text) and [Creative Writing](https://arena.ai/leaderboard/text/creative-writing) (Nov 11, 2026), [WebDev](https://arena.ai/leaderboard/webdev) (Nov 11), [Vision](https://arena.ai/leaderboard/vision) (Nov 8), [Search](https://arena.ai/leaderboard/search) (Nov 8), [Agent](https://arena.ai/leaderboard) (undated)
- I3: [Terminal-Bench 4.0 on Snorkel](https://snorkel.ai/leaderboard/terminal-bench-4-0/)
- I4: [Epoch AI](https://epoch.ai/benchmarks) and the [ECI CSV](https://epoch.ai/data/eci_scores.csv) (Nov 15, 2026)
- I5: [Scale Labs leaderboard](https://labs.scale.com/leaderboard)
- I6: [Vals Index](https://www.vals.ai/benchmarks/vals_index) (Nov 11, 2026) and the [Opus 5.5 page](https://www.vals.ai/models/anthropic_claude-opus-5-5)
- I7: [ARC Prize leaderboard](https://arcprize.org/leaderboard)
- I8: [OSWorld 2.0 official results](https://osworld-v2.xlang.ai/static/data/leaderboard/official-results.json) (Nov 14, 2026)
- I9: [tau-bench](https://taubench.com/)
