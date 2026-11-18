# How Auto picks a model

**Auto's brain** (`src/main/llm/auto-brain.ts`). Before each request, the fastest cheap model you have (GPT-6 Luna, then GPT-6.1 Terra, then Claude Haiku 5.5) reads the whole request, the conversation so far, the attachments, the bot's role, your Auto preference and how each model did on this Mac lately. It answers in strict JSON: the kind of task, its difficulty, how hard to think, the model that should do it, and whether models should work together:
It also names what the request **needs** (reasoning, coding, seeing images, making images, ideas, writing, research, computer use, apps, quick) and matches the model to the needs and the difficulty: GPT-6.2 Sol for routine reasoning, math and research, GPT-6.2 Astra only at difficulty 3 (Fable 5.2 only for the very hardest), Sonnet for routine coding and Opus for hard multi-file or agentic coding, Opus or Sonnet for computer use, apps, ideas and creative writing, Opus or GPT-6.2 Sol for images, Luna, Haiku or Terra for quick things. Each model's one-line strength in the brain's menu (`STRENGTH` in auto-brain.ts) comes from the evidence below and from this app's live runs of 2026-11-17 (quick requests on Luna / Haiku; Astra had been overused for routine research; Sonnet handled routine coding well; Opus for hard agentic coding and computer use; Sol for routine research and reasoning). Seeing images is a hard rule (only models that see them); making images or using the screen makes it agent work.

How models work together:
- **solo**: one model does it well;
- **pair**: two models at the request's own level (GPT-6 Luna with Claude Haiku 5.5 for light work, Claude Opus 5.5 with GPT-6.2 Astra for hard work, from different providers when both are on): the partner gives its own take first, and the main model builds on the best of both;
- **debate**: for reasoning-heavy problems (a decision with trade-offs, a strategy, a proof, a tricky root cause), a Council: several models reason in parallel and challenge each other;
- **fan-out**: a big job that splits (a game's systems, an app's screens) goes to 2-8 parallel helpers on a fast model while the main model builds the shared parts and integrates;
- **plan**: for the hardest multi-step work, a stronger model (Fable 5.2, Opus 5.5, GPT-6.2 Astra) writes the plan first, and the run's model carries it out with the whole conversation and the plan;
- **review**: a second model, from another provider when there is one, reviews the draft before you see it, and the run's model fixes what holds up;
- **plan+review**: both, for the hardest high-stakes work.

The brain's read replaces the rules' within their hard floors (agent work never becomes a chat, coding and computer use are never light, attached folders and modes keep their tier). Its model is used only when it passes every hard rule below (keys, budget, images, window, Grok, cooldowns), is never a premium model without the Fable setting, is never GPT Astra below difficulty 3 unless the table picked Astra itself (live, 2026-11-17: a 120-word newsletter blurb ran 33 Astra requests, $5.72), never costs over 4x the table's pick for a light request, and on Cheapest never costs more than it. Teams only form for agent work at difficulty 2 or more (planning at 3), never on a tight budget. The read runs without thinking (it's a short JSON answer; Haiku 5.5 with adaptive thinking took about 6 s to start), and each brain gets a wait that fits its speed: Luna 4 s, Terra 4.5 s, Haiku 6 s. A read that misses the wait still finishes and is stored with the message when it lands: a retry of the same request and a "yes, do it" after it use it (the run already under way keeps the rules' pick). A timeout, an error or an answer outside the schema leaves the rules' decision (below). The brain judges difficulty by what the work takes (separate asks, steps and tools, what must be exactly right, how much there is to read, what a mistake costs), never by the words used, and it isn't shown the rules' guess. Small talk and voice skip it, and so does a short follow-up ("yes, do it", "continue"), which keeps the read of the request it carries on. An "Approved: …" or an answer from Needs you also continues its request: same read, same model.

**The read hides behind the run's own preparation** (2026-11-18). While the brain reads, the run prepares the request's context (memories, the vault's notes, the world section, skill hints, verified experience) for the model the rules would pick (`warmContext` in agent/loop.ts); when the brain's model sizes that context the same (index.ts `notesVaultWindow`), the first step uses it as is, otherwise it is prepared again for that model. A message now waits for the longer of the two instead of both (tests/unit/auto-latency.test.ts: brain 600 ms + prep 500 ms took 1,162 ms before, 611 ms after). **Skipped reads**: small talk the rules read with confidence at any length ("thanks so much, that was really helpful!"), and obviously quick asks (task-classifier.ts `quickAsk`: a sum or percentage, a unit conversion, a translation of one short sentence, a typo fix of a short text) when the rules already route them to a quick model (on Balanced and Cheapest they go to the instant row: Luna, Haiku, Terra). **Learning from you**: switching the chat to a model by name right after an Auto answer, regenerating it, a thumbs-down, or "that's wrong" right after it count against that model on that kind of task (a thumbs-up or "thanks, perfect" for it), in `llm/outcome-router.ts`: one verdict per answer, the latest 10 per model and task, the last 30 days; the brain's "How models did on this Mac lately" lines say how many answers you turned down. **Why this model**: each Auto answer carries a one-line reason (the read or the rule, the team, and the cost class quick / standard / premium) on the model chip's hover. **One request is bounded** (llm/request-guard.ts): Claude's paused search turns go on only within 24 searches / 30 page reads for the whole turn (was up to 40 across five requests), any Claude or OpenAI Responses request stops after 6 minutes with nothing streamed or 15 minutes in all, and OpenAI stops past 24 built-in searches when max_tool_calls can't be sent; a stopped request says why and is never retried or handed to another model.

During a run the brain's model holds through planning, doing and checking (rule-routed runs may still change model between phases). If the work keeps failing on it (four failed calls, two steps in a row where every call failed), Auto moves once to the next stronger model of the same kind (cloud stays cloud, Fable only with its setting), with the whole conversation; a model you picked is never changed.

When the brain doesn't decide, Auto picks a model in two steps for each message, and neither step calls a model. The rules also read the request's shape (`requestShape` in task-classifier.ts): several asks, constraints ("under $6000", "no more than 2 hours"), specifics and a lot of code make it harder than its words suggest, and a later step done with tools ("…, then email it to my dad", "… and book the hotels") makes it agent work. Text pasted after "…:" counts as material, not as more asks.

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
| **Best result** | Routes one tier above the request's difficulty, so each kind of task gets the strongest model. Chat stops at tier 2 and voice at tier 1, so both stay quick. Research and math stop at tier 2 below difficulty 3: routine research and reasoning get GPT-6.2 Sol (it nearly matches Astra at a quarter of the price), and GPT-6.2 Astra leads only difficulty-3 work. |
| **Balanced** (default) | Routes at the request's own difficulty: the cheapest model that is strong enough. Where GPT-6.2 Astra would lead the hardest row, its near-equal GPT-6.2 Sol leads instead, at a quarter of the price. On a [close call](#balanced-close-calls) it takes Best result's pick when that costs at most 2x and isn't much slower. |
| **Cheapest** | Routes one tier lower. Within a row, the cheapest model comes first. A free local model is used first whenever one is strong enough. |

These settings and conditions still apply on top of the preference:

| Setting or condition | Effect |
|---|---|
| Auto (local) | Uses local models only. |
| Auto (cloud) | Uses cloud models only. |
| Local or cloud first | Local first keeps a free local model for quick chats and light work when it is strong enough. Agent work (difficulty 2 or more: coding, research, tasks) still goes to the strongest suitable cloud model whenever one is on. |
| Use Fable for the hardest tasks | Fable leads the hardest row, but only where the evidence puts it ahead of Opus, so not for writing or office work. |
| Monthly spending limit (a specific amount) | A model the limit can't pay for is skipped. With less than 10% of it left, Auto routes as if Cheapest were chosen, but only while a pay-per-use model could still be picked: when only the ChatGPT plan and local models are left (they cost nothing per token), the preference stands. |
| Monthly spending limit: Unlimited | No cap. Spend is still recorded and shown on the Usage page. |
| Monthly spending limit: None | No pay-per-use API model is used. Auto routes only to your ChatGPT plan (via Codex) and local models, at the chosen preference (never as Cheapest: nothing is being spent), and says why when neither is available. A model picked by name is refused before anything is sent. |
| Fast mode | Auto never turns Fast or Ultrafast on by itself: it uses a provider's fast tier only where Settings → Models → Fast mode allows it for that model (Ultrafast only where it was chosen for that model). By default that is only for speed-sensitive requests: voice, small talk and quick code questions. See [Fast mode](#fast-mode). |
| Images in the request | Only models that can see images are considered. |
| Context window | The model's window must fit the prompt. If none fits, Auto uses the model with the biggest window. |
| Computer use and voice | Never Grok (no computer-use result on any board; about 10 s to its first token). With only Grok on, Auto says so and suggests a fix; Grok picked by name still works. |
| Computer use on the ChatGPT plan | Codex passes the screenshots tools return back to the model as text only ([chatgpt-plan.md](chatgpt-plan.md)), so the plan's models are used for computer use only when no other model can see the screen, and the label says they work from page text. The planner + executor pair never uses them. |
| Premium models | Fable only with "Use Fable for the hardest tasks"; GPT Pro models never (picked by name only). |
| A follow-up in the same chat | Keeps the chat's previous model when it is still as good a choice ([Stability](#stability-across-a-conversation)); a light turn never stays on a model costing over 2x the fresh pick. |
| School work (homework, studying, a quiz or test, a school subject such as chemistry or algebra) | On Balanced and Cheapest: the cheapest strong-enough model (Haiku 5.5, GPT-6 Luna or Terra), and for the biggest assignments (a long paper) a mid-tier one (Sonnet 5.5, GPT-6.2 Sol), never Opus, Astra or Fable. A "Best result" chosen in Settings is kept. "Mole" in school work is chemistry, not a medical stake. Code, computer use and CAD are never school work. |
| A request for a picture ("draw…", "make a logo…", "an image of…") | Runs as agent work with the image tool (GPT image models, on an OpenAI key) loaded, and the picture shows in the chat. |
| A model that failed recently | Skipped until its cooldown ends ([Failures](#failures-and-fallbacks)). |

**Fallbacks:**
- If the first choice is off or missing, the next candidate in the row is used, then the rows above, then the rows below.
- Models the table doesn't name, such as OpenRouter models added by name, fall back to the older tier-based pick.
- Within a slot, the same model on the ChatGPT plan comes before the pay-per-use API (no per-token charge).
- A connected ChatGPT plan makes Auto cloud-first by default, like a saved OpenAI or xAI key (Settings can still say Local first).

### Balanced close calls

A request is a **close call** when the classifier isn't sure of it (confidence below `CONFIDENT`, so it may well be a tier harder) or it has stakes (legal, medical, money, production) at difficulty 1 or more. On Balanced, a close call compares Balanced's pick with Best result's pick (one tier up). It takes Best result's pick only when both hold:

- **Price:** at most 2x Balanced's pick, blended at 3 input : 1 output tokens per 1M at the rates the request's prompt size pays (past 272K GPT bills 2x input and 1.5x output, Haiku 5.5 its long-context rate past 100K; Opus and Sonnet stay flat), with the ChatGPT plan and local models at $0.
- **Latency:** its first answer token at most 1 s later for speed-sensitive requests (chat, quick code questions, voice), or 3 s later for everything else, by the AA time-to-first-token figures at low effort (Luna 1.57 s, Terra 1.96 s, GPT-6.2 Sol 2.03 s, Sonnet 2.50 s, GPT-6.2 Astra 2.82 s, Opus 5.32 s, Haiku 6.26 s, Grok 9.9 s; Fable has no figure and counts as Opus).

So Sonnet → Opus (2.0x, +2.8 s) passes for an unsure coding or computer-use request, and Sol → Astra (4x) never does. A 600K-token document stays on Opus: GPT-6.2 Astra is exactly 2x Opus at short-context rates, but past 272K it costs $16 / $60 against Opus's flat $4 / $20. Code: `routing-table.ts` `closeCall`, `CLOSE_CALL_PRICE`, `TTFT_S`.

### Stability across a conversation

Prompt caches are per model, so switching models mid-conversation re-sends the whole history uncached; switching providers also drops the provider-specific parts of the history (Claude's thinking blocks and compaction, OpenAI's reasoning items). Auto therefore keeps the chat's previous Auto model (`ThreadState.lastAutoModel`) when the new request continues the same work and that model is still as good a choice (`routing-table.ts` `keepPrevious`):

- **Same work:** a follow-up ("yes, do it"), the same category, a related one (coding and code questions, office and writing, research and long documents), or a light chat turn (chat at difficulty 0-1, "thanks!").
- **As good:** for light chat, at least the fresh pick's tier. Otherwise at least as strong for the category: no later than the fresh pick in the category's hardest row on Best result (which orders the models by measured quality), or tied with it within the benchmarks' noise (`ties` on each row, for example Opus 1295 and Sol 1293 on arena Vision, Astra and Sol on TB4 58.2 each).
- **Otherwise the same provider:** when the previous model isn't as good, a model of its provider from the routed row that is as good comes before switching provider.
- **Never** past a hard rule (keys, budget, vision, window, Fable, Grok, plan), never a dearer model on Cheapest, and never a paid model keeping a light chat turn from a free local one on Local first. A harder request still moves up (a Haiku chat gets Opus for hard coding).

The label's tooltip says "same model as the last reply" or "same provider as the last reply".

## Failures and fallbacks

Transient failures are retried first with backoff (`retry.ts`: 429 honoring Retry-After, 5xx, dropped connections; never 402). When a call still fails, `model-health.ts` names the failure and remembers it, and `auto-route.ts` `planFallback` picks who carries on. The chat gets one note per switch ("GPT-6.1 Sol is unavailable (out of API credit); used Claude Sonnet 5.5 for the rest of this task."), a run switches at most twice and never to a model it already tried, and later requests skip the failed model until its cooldown ends.

| Failure | Retried | Blocks | Cooldown | Carries on with |
|---|---|---|---|---|
| Rate limit (429) | yes | the model | its Retry-After (5 s-15 min), else 1 min | next-best candidate |
| Overloaded (529 / 503) | yes | the model | 2 min | next-best candidate |
| Out of credit (402, `insufficient_quota`, also the stream error `{type:'error', error:{code:'insufficient_quota'}}`, Anthropic's "credit balance is too low", xAI out of credits) | never | Anthropic, xAI: the provider. OpenAI: the model (on a new account the cheap models still answered while the larger ones returned `insufficient_quota`) | 30 min | next-best candidate of another provider (OpenAI: another model) |
| Model not found / deprecated (404) | never | the model | 24 h | next-best candidate |
| Context too long | never | nothing | - | a model with a bigger window |
| Content-policy refusal | never | nothing | - | another provider (which applies its own policies) |
| Network drop | yes | the provider | 30 s | another provider |
| ChatGPT plan limit | never | the plan | until its reset time, else 1 h | next-best candidate |
| Monthly spending limit (SahilBot's own) | never | nothing | - | the ChatGPT plan or a local model |

"Next-best candidate" is the routing table's pick for the same request among what is left. Mid-run, a failure of one model goes to the same provider first when it has a candidate, so the run keeps its provider-specific history. When every model is cooling down, the soft cooldowns (rate limit, overload, server error, network) are ignored, since the limit may have passed; the hard ones never are. A model picked by name is still tried first on every request (what you pick is what happens), and each fallback from it is said in the chat.

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

**Superseded by Auto's brain** (top of this page), which reads every request rather than only unsure ones, with a 4–6 s budget. The notes below are kept as the original measurements.

**Decision then: built, not wired in.**
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

What the app does with each manual choice in a regular chat (SahilBot's own chats and projects; tests in `tests/unit/manual-choices.test.ts`; the rules are in `src/main/agent/choices.ts`). Bots are the exception: they always choose by themselves (last row).

| Choice | What the app does |
|---|---|
| Model (chat, default) | Used for every step. If it's gone (deleted, key removed), the chat says so and that chat or the default moves to Auto. If it errors after retries, Auto's fallback for the request answers ([Failures](#failures-and-fallbacks)) and the chat says which and why: "Claude Opus 5.5 is unavailable (rate limited); used Claude Sonnet 5.5 for the rest of this task." It is still tried first on the next request. A picked model is never swapped for making invalid tool calls; only Auto's own picks are. |
| Effort (chat, default) | Sent exactly on every step: no floors, no adaptive shift, no escalation. Each provider maps it to the nearest level the model accepts. |
| Context window (per model) | Used exactly, clamped only to the provider's maximum. |
| Plan first, Max, Deep Research | Sent as chosen. Each makes the run full agent work, and each sets a difficulty floor. Deep Research turns on its team. Max is one mode for many agents: its strategy planner (`src/main/agent/max/planner.ts`, local rules plus the task classifier, no model call) picks a research team, an idea swarm, competing attempts with a judge, or a hybrid (explore first, then judged attempts on the deliverable), and one live card shows the choice and why. It replaces the older Team of Experts, Swarm and Heavy toggles. |
| Council | Exclusive in the composer: turning it on turns Max off (and the other way round), and the main process enforces the same if a message arrives with both. |
| Permission mode | The chat's mode is left as chosen. It is only ever made stricter, for a handoff from a stricter bot or untrusted relayed content (security). |
| Fast mode | A per-model Standard / Fast / Ultrafast choice is honored exactly ("Use the provider setting" follows the provider's switch, which never means Ultrafast). Auto's "only where speed matters" rule applies only to models Auto picked. |
| Bots: model and effort | A bot chooses by itself (Auto model, Auto thinking) until you pick a model or a thinking level in its chat; then that pick is used exactly, and you can go back to Auto any time. Stored `Space.model` / `Space.effort` from older installs are ignored. The app default's Auto variant still applies to a bot chat with nothing picked (Auto (local) stays local, Auto (cloud) stays cloud); a concrete default model doesn't. Helpers keep the model their orchestrator assigned. |
| Thinking with Auto | Thinking is picked independently of the model: a level picked while the model is Auto is sent exactly with whatever model Auto routes to. |
| A model switch (Auto, a pick, a fallback) | The new model gets the whole conversation, every reply, tool call and result, and a hidden note that it is taking over from the previous model, once per switch (`loop.ts` `modelSwitchNote`). |

## Simulated guarantees

`tests/unit/auto-matrix.test.ts` (with `tests/fixtures/auto-sim.ts`) runs Auto's real decision (`auto-route.ts` `autoRoute`, the function `loop.ts` `chooseModel` calls) over every realistic setup and every request of the routing eval set, with no network and no model calls, in about 4 seconds:

- **Setups (900):** 10 key setups (Claude only, OpenAI only, Grok only, Claude+OpenAI, Claude+Grok, OpenAI+Grok, all three, ChatGPT plan only, plan+Claude, plan+all) × local models on/off × Best / Balanced / Cheapest × monthly limit (plenty left, under 10% left, exhausted, Unlimited, None) × Fable on/off × (for the 5 setups with an OpenAI API key) an account with no credit, where every OpenAI model but Luna and Terra answers with the live `insufficient_quota` stream error. Each pick is also checked under 3 fast-mode settings (off, on for Anthropic only, on everywhere with Auto's speed rule).
- **Checked:** 900 setups × 554 items = **498,600 picks** (1,495,800 with the fast-mode settings).

Invariants, each failure printed with its setup and item:

| Never | Always |
|---|---|
| a model that isn't usable, or one cooling down after a failure | coding gets the strongest coding model the table offers (Best result and Balanced, budget not tight), never a local one while a cloud one is on |
| a local model with local models off | Auto's effort is at least the rubric's (voice excepted: replies start fast) |
| a pay-per-use model with the limit at None or exhausted | a model picked by name is used exactly, cooling down or not |
| fast mode where Settings don't allow it, or outside Auto's speed rule; ever on the ChatGPT plan or a local model | the routed label names the model and the kind of task, and its tooltip says why (and when the model was kept, or a fallback answered) |
| Fable without its setting (outside the hardest tier of a row it leads), GPT Pro ever | the same inputs give the same pick (determinism, checked on 99,720 picks twice) |
| a window too small for the prompt when one fits | Best result at the hardest tier never answers with a light model while one the category's hardest row names is on |
| a model that can't see images when the request has some and one can | Balanced takes Best result's pick on a close call exactly when it is within 2x the price and the latency allowance |
| Grok for computer use or voice | an out-of-credit model is never retried, and never picked again until its cooldown ends |
| the ChatGPT plan for computer use while another model can see the screen | |

Also simulated:

- **Stability:** 165 conversations built from the eval set (request, follow-up, request…, with the history growing each turn) × the 120 setups with budget to spare = 99,000 turns. Provider switches between turns that continue the same work: **3.64% before this change (3.10% with today's table but no stability rule) → 0.66%**; model switches **18.6% → 5.3%**. What is left is the request getting harder (Luna to Sonnet), Cheapest picking a cheaper model, or a prompt outgrowing a window.
- **Failures:** 8 kinds (rate limit, overloaded, out of credit, not found, context too long, content policy, network drop, ChatGPT plan limit) × 20 key setups × 7 requests, mid-run and not: 1,582 fallbacks checked for the target (scope, bigger window, another provider), the table's order, one note naming both models and the reason, the cooldown and its end, and no loops (each model at most once, at most 3 per run). The live stream error is checked end to end through `streamResponses` and `withRetries` (sent once, status 402).
- **Effort:** every model in the Claude, OpenAI and xAI tables (45) and 5 Codex effort lists × 5 levels: the built request body carries only a level the model accepts, the nearest below (185 bodies). 3,375 simulated long runs with failures, growing plans and a mid-run model switch: at most one bump, only on Auto, up to Extra, always a level the model takes.
- **Swarm, council, pair:** for every key setup with budget, None and exhausted: 6,420 helper assignments (bots mix providers, agent chats stay on the lead's), council members (the best Claude and best GPT by the hardest agent-tools row; one provider: its two strongest, said so; fewer than two: no council, said why) and the computer-use pair (never Grok, never the ChatGPT plan, the executor sees screenshots), all within the spending limit and local opt-in.

Found by the simulation and fixed (48,090 invariant violations before, 0 after):

| Violations | What it was |
|---|---|
| 20,878 | Best result's hardest tier got a light model: an exhausted limit (or None) still routed the free ChatGPT plan and local models as Cheapest. |
| 19,766 | An OpenAI model that returned `insufficient_quota` was tried again on every later request; and the stream error's 402 status was overwritten (`openai-responses.ts`), so the note read "failed: …". |
| 2,700 + 2,700 | Coding not on the strongest model / on a local one: the same budget rule, on plan-only setups. |
| 756 + 276 | Grok for computer use and voice: with only Grok on, the tier fallback picked it. |
| 636 | Balanced had no close-call rule. |
| 378 | The ChatGPT plan for computer use while a model that can see the screen was on. |
| (pair, council) | The planner + executor pair could use the ChatGPT plan (blind to screenshots); an OpenAI-only council could seat GPT-5.5 Pro ($30 / $180). |
| (fallbacks) | Fallbacks went by tier and rank (`nextStronger`), not the table's order for the task; Anthropic's credit-balance error was a plain 400; the voice shortcut's small local model ignored images and the window; a model a user can't pay for could be picked when `usable()` came back empty. |

**Found in the audit and left to the owners:** Council and swarm merge / final steps (`loop.ts` swarm and council `final` callbacks) send effort `'high'` regardless of the chat's picked level.

Evidence below was read on **2026-11-15** (GPT-6.2 Astra and Sol, and the fast-mode pages, on **2026-11-18**). VR means vendor-reported, from the Anthropic or OpenAI announcement or docs. IND means independent. Each number links to its source in [Sources](#sources).

## The models

| | Claude Fable 5.2 | Claude Opus 5.5 | Claude Sonnet 5.5 | Claude Haiku 5.5 | GPT-6.2 Astra | GPT-6.2 Sol | GPT-6.1 Terra | GPT-6 Luna |
|---|---|---|---|---|---|---|---|---|
| Released | Nov 9 | Sep 22 | Sep 28 | Oct 7 | Nov 17 | Nov 17 | Oct 26 | Sep 22 |
| $ per 1M tokens, in / out [A1][O1][O6] | 8 / 40 | 4 / 20 | 2 / 10 | 0.10 / 0.50 (≤100K tokens), then 0.50 / 2.50 | 8 / 40 (cached 0.40) | 2 / 10 (cached 0.10) | 1 / 5 | 0.10 / 0.50 |
| Over 272K input [O1] | standard rates | standard rates | standard rates | as above | 2x input, 1.5x output | same as Astra | same as Astra | same as Astra |
| Context / max output | 1M / 128K | 1M / 128K | 1M / 128K | 1M / 128K | 1.05M (922K input) / 128K | same as Astra | same as Astra | same as Astra |
| AA Intelligence Index, max effort (IND) [I1][I10] | **65** | 59 | 55 | 36 | 62 | 57 | 51 | 28 |
| Output tokens/s (IND) [I1][I10] | 102 | 114 | 143 | **255** | 53 | 85 | 71 | 103 |
| Time to first answer token at low effort (IND) [I1][I10] | n/a | 5.32 s | 2.50 s | 6.26 s | 2.82 s | 2.03 s | 1.96 s (no reasoning) | **1.57 s** (no reasoning) |
| AA cost per Index task (IND) [I1][I10] | $26.54 | $10.04 | $10.02 | $0.41 | $4.00 | $1.01 | $0.96 | $0.15 |

Notes on the table:
- **GPT-6.2 Astra and Sol supersede GPT-6 Astra ($10 / $50; AA 57, 40 tok/s, 3.82 s, $6.24 per task) and GPT-6.1 Sol ($2 / $10; AA 55, 49 tok/s, 3.22 s, $1.27 per task).** The older two stay listed, start switched off, and work when picked by name or switched on. The per-category numbers under [Routing by task](#routing-by-task) were measured on GPT-6 Astra and GPT-6.1 Sol; the astra and sol slots now resolve to 6.2. OpenAI's own guidance: "Use GPT-6.2 Astra for the most demanding tasks, or GPT-6.2 Sol for complex work at lower cost" [O6]; its launch post: Sol "nearly matches Astra on merge-ready changes to real codebases at about one-fifth the cost" (FrontierCode 2.0, VR) [O7]. AA at max effort (IND) [I10]: Astra 62 (#3 of 92), Sol 57; per Index task $4.00 vs $1.01.
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

"Astra" and "Sol" in the tables below are the astra and sol slots: GPT-6.2 Astra and GPT-6.2 Sol now. The deciding numbers were measured on GPT-6 Astra and GPT-6.1 Sol before 6.2 came out (Nov 17, 2026); no independent per-category board has 6.2 yet.

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
| GPT-6.2 Astra at difficulty 3 (Best result); GPT-6.2 Sol for everything else, and on Balanced | Claude Opus 5.5 | Claude Sonnet 5.5, GPT-6.1 Terra |

- **arena Search, IND [I2]:** Astra 1231, 6.1 Sol 1230, Opus 5.5 1213.
- **BrowseComp, VR [O2]:** Astra 91.5. No Claude 5.5 figure was published, and no independent BrowseComp exists.
- **Humanity's Last Exam:**
  - Fable 5.2 leads: 74.3 on AA [I1], 72.4 on Scale [I5].
  - On Scale, Astra 60.6 is ahead of Opus 5.5 55.0 [I5].
  - With tools (VR): Opus 5.5 67.7 [A3].
- **GDPval-AA, IND [I1]:** Opus 5.5 is #1. That board measures synthesis-heavy knowledge work.
- **Factual errors, VR [O2]:** Sol's error rate is 7.7%.
- This category is close. Astra edges ahead on search. Opus edges ahead on synthesis.
- **Routine research is Sol's, on every preference.** Best result lifts research only to tier 2 below difficulty 3 (`maxTier: 2`), so Astra leads only difficulty-3 research. Live, 2026-11-17: a 120-word newsletter blurb from two bots ran 33 GPT-6 Astra requests ($5.72); 6.2 Sol is within a few points of Astra (AA 57 vs 62) at a quarter of the price.

- **Grok 4.7:** it is not on arena Search; Grok 4.5 is #13 at 1216 [I2]. It scores 56% on SimpleQA Verified [I4] and has a 29% AA-Omniscience hallucination rate [G2]. It is the last fallback.

### Long documents (500K+ tokens)

| First | Runner-up | Cheap / fast |
|---|---|---|
| GPT-6.2 Astra; on Balanced Claude Sonnet 5.5, or Claude Opus 5.5 for the hardest | Claude Opus 5.5 / GPT-6.2 Sol | Claude Sonnet 5.5, Claude Haiku 5.5 |

- **MRCR v2 8-needle at 512K to 1M, VR [O2]:** Astra 96.3.
- **No Claude 5.5 long-context figure was published.** The independent AA-LCR board shows neither family [I1].
- **Price at 600K tokens in:**
  - Claude bills its whole 1M window at standard rates: Sonnet $2 per M, Opus $4 per M, Haiku $0.50 per M past 100K.
  - OpenAI doubles the input rate past 272K: GPT-6.2 Sol $4 per M, GPT-6.2 Astra $16 per M (output 1.5x: $15 and $60).
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
| GPT-6.2 Astra at difficulty 3 (Best result); GPT-6.2 Sol for routine math and reasoning, and on Balanced | Claude Opus 5.5 | GPT-6.1 Terra |

- **ARC-AGI-2, IND [I7]:** Astra 95.0, Sol 94.2, Fable 5.2 93.8, Opus 5.5 93.3.
- **ARC-AGI-3, IND [I7]:** Fable 5.2 81.2, Astra 62.7.
- **GPQA Diamond:** Astra 96.3 (IND) [O4].
- **FrontierMath Tier 4, VR [O2]:** Astra 97.6.
- **FrontierMath Erdős, IND [I4]:** 6.1 Sol is first, at 4%.
- **Vals, IND [I6]:** Opus 5.5 scores 100% on ProofBench and 95% on IOI.
- With the Fable setting on, Fable leads the hardest row. It is ahead on ARC-AGI-3 and Humanity's Last Exam.
- AIME is not reported by either vendor for these models.
- **Routine math is Sol's, on every preference** (Best result lifts math only to tier 2 below difficulty 3): ARC-AGI-2 put 6.1 Sol within a point of Astra, and 6.2 Sol is "for complex work at lower cost" [O6].

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

Fast mode is in **Settings → Models → Advanced → Fast mode**. Each provider has a switch, off by default, and each model has its own speed choice: **Use the provider setting** (the default), **Standard**, **Fast** and, where OpenAI offers it for that model, **Ultrafast**. A provider's switch only ever means Fast; Ultrafast runs only on a model it was chosen for. Next to each choice the app shows its penalty: the speed, the price multiplier and what it means in dollars per million tokens for that model, and the other trade-offs the provider documents (`fast-mode.ts` `speedOptions`). On GPT-6.2 Astra today (Nov 18, 2026) they read:

| Choice | Penalty text |
|---|---|
| Standard | Standard · normal speed · 1x price ($8 / $40 per M) |
| Fast | Fast · up to 2.5x faster · 2x price ($16 / $80 per M) · Counts against the same rate limits as Standard · OpenAI may downgrade it to standard speed, billed at the standard price |
| Ultrafast | Ultrafast · up to 4.5x faster · 3x price ($24 / $120 per M) until Feb 28, 2027, then 6x ($48 / $240) · Separate rate limits from Standard and Fast · Responses API only · US data residency only |

GPT-6.2 Sol: $2 / $10, Fast $4 / $20, Ultrafast $6 / $30 until Feb 28, 2027, then $12 / $60. GPT-6 Astra and GPT-6.1 Sol: Ultrafast 6x ("OpenAI's fastest tier": OpenAI gives no API speed figure for them). Claude Opus 5.5: Fast · up to 2.5x faster output · 2x price ($8 / $40 per M) · its own rate limit (over it, SahilBot resends at standard speed and price, a prompt-cache miss) · not with the Batch API.

A fast request is priced at its real multiplier, including the date it runs on (GPT-6.2 Ultrafast is 3x through Feb 28, 2027 Pacific time and 6x from Mar 1, 2027): in the monthly limit's worst-case check, in what is recorded, and in each step's cost chip. The usage ledger records the tier that actually ran, from the response (OpenAI `service_tier`, Anthropic `usage.speed`, xAI `service_tier`), and prices that: a request OpenAI downgraded (`service_tier: "default"`) is recorded and billed at standard. `service_tier: "ultrafast"` is only ever sent on the Responses API; over Chat Completions an Ultrafast choice runs at Fast.

### Verified facts (official pages, read 2026-11-18)

| Fact | Official statement | Source |
|---|---|---|
| Model ids | `gpt-6.2-astra`, `gpt-6.2-sol` (no dated snapshots listed); released Nov 17, 2026 | [O6], changelog [O1] |
| Windows | 1,050,000 context, 922,000 max input, 128,000 max output (both) | [O6] |
| Knowledge cutoff | Astra May 18, 2026; Sol Jun 1, 2026 | [O6] |
| Reasoning effort | "The API rejects requests that set reasoning effort to `none`" (both). No full list and no default is documented; the launch post cites Astra at `xhigh`. SahilBot sends low…max, never none, and no `reasoning.context` (all_turns isn't documented for 6.2). | [O6], reasoning guide |
| API | Chat Completions and Responses, but "tool calling requires Responses" | [O6] Using GPT-6.2, changelog |
| Standard prices | Astra $8 in / $0.40 cached / $40 out (cache writes $10 for 30 min, $20 for 12 h); Sol $2 / $0.10 / $10 ($2.50 / $5) | [O6], [F4] |
| Long prompts | Confirmed: above 272K input tokens "input and cache rates double and output costs 1.5 times the short-context rate for the full request" (Astra $16 / $0.80 / $60, Sol $4 / $0.20 / $15) | [O6], [F4] |
| Fast mode | `service_tier: "fast"` (or `"priority"`), "up to 2.5x faster speeds", "2x Standard for the same context length" on both 6.2 models; same rate limits as Standard; "the system may downgrade some Fast mode requests to standard speeds and charge standard rates" (the response says `service_tier: "default"`); Responses and Chat Completions | [F2], [O6] |
| Ultrafast availability | GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, GPT-6.1 Sol | [F3], [F4] |
| Ultrafast price | GPT-6.2: "Ultrafast costs 3 times the Standard rate through February 28, 2027, and 6 times the Standard rate starting March 1, 2027 (Pacific time)" (Astra $24 / $1.20 / $120 promotion, $48 / $2.40 / $240 list; Sol $6 / $0.30 / $30, $12 / $0.60 / $60). GPT-6 Astra and GPT-6.1 Sol: 6x. The 3x-now / 6x-from-March statement is on both the model pages and the pricing page, so reports of "6x now" don't match OpenAI's own API pricing (a search summary attributed 6x to legacy billing; the pages read here don't mention that). | [F4], [O6] |
| Ultrafast speed | "Ultrafast generates tokens at up to 4.5 times the speed of Standard" on GPT-6.2 Astra and Sol (OpenAI's Codex speed page). The API Ultrafast guide itself gives no figure. | [F5], [F3] |
| Ultrafast API and limits | `service_tier: "ultrafast"`; every example and changelog entry is the Responses API (WebSockets "strongly recommended"); "Ultrafast has separate rate limits from Standard and Fast modes"; GPT-6.2 Ultrafast is US data residency only. Downgrades and the response's `service_tier` aren't documented for Ultrafast. | [F3], changelog |
| Anthropic | Fast mode (`speed: "fast"`, "up to 2.5x higher output tokens per second") on Fable 5.2, Mythos 5.2 and Opus 5.5 (Opus 5 preview, Opus 4.8 deprecated, removal Nov 30, 2026), 2x: Opus 5.5 $8 / $40, Fable / Mythos 5.2 $16 / $80; a dedicated rate limit; not with the Batch API; `usage.speed` reports the speed that ran. **No "ultra" or sixfold tier exists** on the fast-mode or pricing pages: the news item claiming one is rejected. | [F1], [A1] |

Not verifiable from official pages: Fast mode's speed on GPT-6.2 specifically (the API guide's "up to 2.5x" is general; OpenAI's Codex page says Fast runs "about 1.5 times the speed of Standard" on GPT-6.2 Astra in Codex), Ultrafast downgrade behavior, GPT-6.2 Ultrafast's default rate limits ("check your organization's limits"), and any official benchmark table for 6.2 (openai.com returned 403; the numbers above are from OpenAI's developer-forum announcement and Artificial Analysis).

Notes on fast mode:
- **Anthropic over its fast rate limit (429 / 529).** SahilBot follows Anthropic's documented fallback: it sends the same request once more at standard speed, which also misses the prompt cache.
- **OpenAI downgrades.** OpenAI may downgrade a fast request ("charge standard rates"); the response then says `default`, and the ledger records it at standard.
- **When Auto may use fast mode.** Never by itself: only where fast mode is allowed for the model (its own choice, else its provider's switch). There are three choices for Auto's picks: *Only where speed matters* (the default: voice, small talk, quick code questions), *Whenever allowed*, and *Never*.

## What's uncertain
- **Mostly vendor-reported numbers.** Both vendors moved to newer benchmarks (Terminal-Bench 4.0, OSWorld 2.x, FrontierCode, GDPval-AA, AutomationBench). Independent coverage exists for coding (Terminal-Bench 4.0, arena), knowledge work (GDPval-AA), arena boards, ARC and composite indexes. It is thin for computer use, long context and tool use.
- **Vendor numbers vary by page.** The same model's score can differ between vendor pages; for example Opus 5.5 on OSWorld 2.1 is 81.8 on its own page and 87.2 on the Fable 5.2 page.
- **Some secondary sources had misaligned columns.** OpenAI's HLE row as relayed by the-decoder is one example. Those rows were not used.
- **Fable 5.2 is new.** It came out on Nov 9, and many boards list only Fable 5.1. SahilBot's price table now has Fable 5.2 at $8 / $40.
- **GPT-6.2 is a day old.** Its per-category numbers (arena, Terminal-Bench, OSWorld, MMMU) aren't out; Auto routes it by OpenAI's positioning, the AA Index and the 6 Astra / 6.1 Sol numbers it supersedes, and this Mac's measured outcomes (the outcome router, per model id) take over as they accumulate.
- **First-token times include reasoning.** They come from Artificial Analysis at low effort. SahilBot sends low effort in voice, but the real first-token time depends on prompt size and network.

## Sources

**Grok and fast mode (read 2026-11-15; more in [docs/grok.md](grok.md)):**
- X2: [xAI pricing](https://docs.x.ai/docs/pricing); X9: [xAI priority processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing)
- G1 (IND): [Artificial Analysis, Grok 4.7](https://artificialanalysis.ai/models/grok-4-7)
- G2 (IND): [Artificial Analysis, "Benchmarking Grok 4.7"](https://artificialanalysis.ai/articles/benchmarking-grok-4-7) (Sep 21, 2026)
- G3 (IND): [Vals, Grok 4.7](https://www.vals.ai/models/grok_grok-4.7)
- F1: [Anthropic fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- F2: [OpenAI fast mode](https://developers.openai.com/api/docs/guides/fast-mode); F3: [OpenAI Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode); F4: [OpenAI pricing](https://developers.openai.com/api/docs/pricing) (Fast and Ultrafast tables); F5: [OpenAI Codex: Fast and Ultrafast modes](https://learn.chatgpt.com/docs/agent-configuration/speed) (redirected from developers.openai.com/codex/speed). All read again 2026-11-18.

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
- O6 (VR, read 2026-11-18): [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra), [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol), [Using GPT-6.2](https://developers.openai.com/api/docs/guides/latest-model), [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- O7 (VR, read 2026-11-18): ["GPT-6.2 Astra and Sol are now available"](https://community.openai.com/t/gpt-6-2-astra-and-sol-are-now-available/1417531), OpenAI Developer Community announcement (Nov 17, 2026); openai.com/index/introducing-gpt-6-2-astra-sol returned 403 to the fetcher

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
- I10: Artificial Analysis, [GPT-6.2 Astra](https://artificialanalysis.ai/models/gpt-6-2-astra) and [GPT-6.2 Sol](https://artificialanalysis.ai/models/gpt-6-2-sol) (read 2026-11-18)
