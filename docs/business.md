# Business work

How to do business work with SahilBot's tools: research, numbers, documents, email and calendar, CRM and
finance apps, recurring jobs and sensitive data. Find the matching skill with memory(action="read_skill",
name) before a big deliverable; handbook-business is the overview.

## Which tool for which ask
| The user asks | Use | Skills |
|---|---|---|
| Market or competitor research, a company profile | web_search + fetch_page; max(strategy="team") for many companies or sources | market-research, deep-web-research, business-go-to-market-sales |
| A financial model, budget, forecast, unit economics | doc_create type "sheet" (live, formulas) or create_document .xlsx (bigger models, charts); office sheet_read / sheet_write to change an existing workbook | financial-model, business-financial-modeling, business-unit-economics, spreadsheet-analysis |
| A pitch deck, board update, sales deck | doc_create type "slides", then doc_export pptx or pdf | pitch-deck, make-slide-deck, business-fundraising |
| A memo, plan, proposal, report, letter | doc_create type "doc", then doc_export docx or pdf | business-plan, business-plan-writing, office-reports, make-word-doc |
| A KPI page or scorecard | doc_create type "dashboard" | office-reports |
| An interactive calculator or chart to play with | create_page | — |
| Analyze a CSV, Excel file or export | office sheet_summarize / sheet_read; run_command with Python for heavy analysis | python-data-analysis, spreadsheet-analysis |
| Pricing, negotiation, a decision | the skill first, then research the facts; max(strategy="heavy") for a high-stakes choice | business-pricing-strategy, pricing-strategy, business-negotiation, business-decision-making |
| Email triage, drafts, follow-ups | mail (Apple Mail, every account) or the Gmail connector (find_tools("gmail")) | email-triage, email-drafting, email-followups, email-organize |
| Meetings, calendar | mac_apps (Calendar) or the Google Calendar connector | business-meeting-prep, meeting-notes, office-meetings |
| CRM, invoices, payments | find_tools("<app>"): Attio, Pipedrive, Close, Apollo; Stripe, PayPal, Square, Mercury, Brex… (docs/connectors.md) | business-invoice-collections, business-customer-success |
| Stock or market questions | find_tools("stock"): stock_quote, stock_analyze, stock_forecast, stock_compare, stock_backtest, price_alert | — |
| New business ideas, validating one | max(strategy="swarm", pattern="ideate") for many ideas, then research the best | ideas-new-business, ideas-validate-business, ideas-novelty-check, ideas-creative-methods |
| Marketing, SEO | web research; the Semrush or Ahrefs connector when connected | business-marketing, marketing-plan, seo-research, seo-reporting, seo-audit |
| Contracts, legal admin | read the document (file_read), summarize terms, flag risks; never present it as legal advice | business-contract-scope, business-legal-admin |
| Bookkeeping, taxes | office for the spreadsheets; read_document_image for receipts without a text layer | business-bookkeeping-taxes |
| 300 files to summarize, 1,000 rows to classify | batch (Anthropic Message Batches, half price, needs an Anthropic key) | media-and-batch |

## Recurring work
- A job that repeats (a Monday sales summary, a weekly competitor check): schedule. It runs in this bot's
  chat on its own. Say what it does and when; the user sees it under Scheduled.
- A multi-day objective ("find three suppliers under $X by Friday"): goal, with done_when and milestones;
  follow_up schedules the next wake-up.
- A standing job with its own focus (a "Finance" bot, a "Sales" bot): suggest the user makes a bot (New bot).
  message_bot hands a task to another bot whose focus fits better.

## Numbers you can trust
- Use formulas in sheets ("=SUM(B2:B9)"), not computed numbers, when the user may change inputs. Put
  assumptions in their own labeled cells and reference them.
- Show units and periods (monthly vs annual, USD, thousands). Round only in the presentation.
- Sanity-check: totals match their parts, growth rates are plausible, margins are within the industry's
  range. Say which numbers are assumptions and which are sourced (with links and dates).
- After create_document, review_document runs a check (formulas that compute, #REF!/#DIV/0!, totals that
  miss rows). Fix every FAIL.

## Sensitive data
- Customer, employee or patient details: phi_scan (action "scan") finds the 18 HIPAA identifiers; action
  "redact" replaces them before text goes to a cloud model, a connector or a file. Skills: hipaa-handling-phi,
  hipaa-phi-basics.
- With the Privacy Gate on (docs/privacy-gate.md), personal details may reach you as stand-ins like
  [PERSON_1]. ask_on_mac asks the Mac's local model about the real content.
- Never put passwords, card or account numbers in documents, memory or the vault.

## Sending and spending
- Sending email, posting, inviting, paying and buying always ask the user (docs/permissions.md). Draft first;
  let them approve.
- Paid tools (image, video, speech, transcribe, batch, read_document_image, cloud models) count against the
  monthly cloud budget (Settings → Cloud budget). Plan the calls; don't repeat them.

## Verify before you hand it over
Every figure traced to a source or a labeled assumption; documents opened and checked (doc_read, or the
review that create_document returns); the user's constraints (budget, length, deadline, audience) met.
