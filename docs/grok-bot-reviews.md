# SahilBot vs. what reviewers say about Grok Bot

Grok Bot is xAI's always-on agent app (launched August 2026). This page takes what six published reviews praise and
complain about and puts SahilBot beside each point, so we fix what they'd fault us for and keep what they'd praise.
Reviews read 23 Nov 2026. Two are written by competitors (CellCog, Superapp) and one has affiliate links; treat
single-source claims with care.

Sources: [Layer3 Labs](https://www.layer3labs.io/guides/grok-bot-review) ·
[CellCog](https://cellcog.ai/blog/grok-bot-problems/) · [grok-bots.com](https://grok-bots.com/grok-bot-review) ·
[Ali Fakhri](https://aliakbarfakhri.com/grok-bot-review/) · [Superapp](https://superapp.dev/blog/grok-bot-review-vs-claude-codex) ·
[Deeper Insights](https://deeperinsights.com/ai-review/grok-bot-review/) · [Trustpilot](https://www.trustpilot.com/review/grok.com)

## Where reviewers fault Grok Bot

| Complaint (source) | Grok Bot | SahilBot |
|---|---|---|
| "Approvals don't reverse anything" (Ali Fakhri) | Approvals only gate the next step | **Undo**: a task's file changes go back (button on the answer, or "undo that"); files it made go to a holding folder; files you changed since are left alone |
| "There's no dry run. Test runs do real work" (Ali Fakhri) | Test = real run | **Dry run** on any routine: reads for real, lists what it would send, write or post |
| "Each Bot is one unbounded thread", no fresh session (CellCog) | One thread per bot, forever | One ongoing conversation per bot, plus **Start fresh** (memory kept) and **Past conversations** in its profile; long chats compact on their own |
| "The allowance is invisible" (Ali Fakhri); limits ran out fast (CellCog) | No published caps; meters disagree | A monthly limit you set ($200 default), spend in the profile menu, and **each bot's cost this month** in its profile |
| "Every turn re-reads the whole chat, so long threads get expensive" (grok-bots.com) | Full re-read | Compaction, one provider thread per chat on ChatGPT/Grok plans, memory sized to the model |
| "Bot failed to respond"; one stuck task stalls every bot (CellCog, grok-bots.com) | One shared cloud computer | Runs are per chat on your Mac; a **stall watchdog** says when a step takes over a minute; Stop and Esc end any run |
| No per-action audit trail (Ali Fakhri) | "Coming" | Show work: every step, its result and the files it touched; the runtime keeps an action record per run |
| Users want to "see, edit, or clear what a Bot has memorized" (grok-bots.com) | Not user-manageable | Settings → Memory: every saved fact listed, editable, forgettable with Undo; "forget that…" in chat |
| "Do not use separate Bots as a security boundary" (xAI docs, via Ali Fakhri) | Shared computer, shared logins | Runs on your Mac; passwords stay in the local vault and are never typed into chat |
| No model picker; the model behind a step isn't shown (grok-bots.com) | Hidden | Auto picks; Developer mode shows the model, thinking and cost of every reply |
| Connectors "fail, silently and repeatedly" (Ali Fakhri) | Silent | A failed sign-in asks you to reconnect in the chat |

## Where reviewers praise Grok Bot, and where SahilBot stands

| Praise | SahilBot |
|---|---|
| "It finishes… it hands me the thing" | Same goal: the verify pass, "never claim without proof", the arena and real-work evals; answers post once |
| Keeps working with the laptop closed (cloud computer) | Runs on your Mac: keeps it awake while bots work; with the lid closed only if you turn that on. **Gap**: no cloud computer |
| Teach a task once, replay it | Teach mode records a browser task and saves it as a skill |
| Schedules and triggers | Routines by asking in chat; Dry run; missed runs catch up. **Gap**: no Slack/GitHub/webhook triggers yet |
| Easy setup, "it just works" | Four short setup steps; voice and permissions asked when first needed |
| Bot-to-bot group chats | Handoffs between bots and group chats |
| Voice on desktop and phone | Grok Voice 3.0 live (talk over it any time; bots do the work); phone access in preview |
| Own email address per bot | **Gap** |
| Multi-account connectors on one bot | **Gap** (one account per connector) |

## Next gaps to close
- Triggers beyond time: a new email, a Slack message, a webhook.
- A way to keep working while the Mac sleeps (a helper on a server SahilBot already supports, made one click).
- Several accounts of one app on one bot.
