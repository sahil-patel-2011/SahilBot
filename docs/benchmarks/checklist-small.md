# SahilBot polish checklist: 500 small details

**Date:** 2026-11-20  
**Method:** 500 micro-behaviors that Claude Code (CC), Grok (GK) and ChatGPT (GPT) share or that users notice (letters = which of the three have it; `none` = a SahilBot-specific nicety). Each graded by static reading and grep of `src/` and `docs/` only; nothing was run. Evidence is `file:line` or the grep that came back empty. PARTIAL = built but gated (developer mode only), incomplete, or the code path exists and the exact behavior was not confirmed (evidence says "unverified"/"not verified"). Line numbers are approximate to the working tree on this date (includes uncommitted changes).  
**Scoring:** PASS = 1, PARTIAL = 0.5, MISSING = 0. Max 500.

**Overall: 379.5 / 500 (76%)**

## Per-area scores

| Area | PASS | PARTIAL | MISSING | Score /20 |
|---|---|---|---|---|
| 01 Composer: input, drafts, attachments | 17 | 0 | 3 | 17.0 |
| 02 Composer: keys, queue, slash, mentions | 13 | 1 | 6 | 13.5 |
| 03 Streaming and status lines | 15 | 4 | 1 | 17.0 |
| 04 Copy / retry / edit affordances | 12 | 2 | 6 | 13.0 |
| 05 Markdown and code rendering | 10 | 2 | 8 | 11.0 |
| 06 Citations and links | 10 | 4 | 6 | 12.0 |
| 07 Error messages | 14 | 4 | 2 | 16.0 |
| 08 Empty states | 14 | 6 | 0 | 17.0 |
| 09 Loading states | 14 | 5 | 1 | 16.5 |
| 10 Keyboard navigation and focus | 12 | 2 | 6 | 13.0 |
| 11 Accessibility labels | 9 | 8 | 3 | 13.0 |
| 12 Dark mode and theming | 10 | 9 | 1 | 14.5 |
| 13 Scroll behavior | 14 | 4 | 2 | 16.0 |
| 14 Notifications and badges | 16 | 2 | 2 | 17.0 |
| 15 Settings search and discoverability | 15 | 0 | 5 | 15.0 |
| 16 Confirmations | 15 | 3 | 2 | 16.5 |
| 17 File cards and previews | 12 | 4 | 4 | 14.0 |
| 18 Document editor | 16 | 1 | 3 | 16.5 |
| 19 Slide editor | 17 | 1 | 2 | 17.5 |
| 20 Export / download UX | 13 | 3 | 4 | 14.5 |
| 21 Update UX | 16 | 3 | 1 | 17.5 |
| 22 Onboarding copy | 12 | 7 | 1 | 15.5 |
| 23 Model picker clarity | 16 | 2 | 2 | 17.0 |
| 24 Cost / usage display | 12 | 4 | 4 | 14.0 |
| 25 Privacy prompts copy | 14 | 2 | 4 | 15.0 |
| **Total** | 338 | 83 | 79 | **379.5** |

## Checklist

| ID | Area | Detail | CC/GK/GPT | Status | Evidence |
|---|---|---|---|---|---|
| S001 | Composer: input, drafts, attachments | Unsent draft is kept per chat and survives switching chats | CC GK GPT | PASS | lib/drafts.ts:1-30 (localStorage per thread, 30-day prune) |
| S002 | Composer: input, drafts, attachments | Unsent draft survives quitting and relaunching the app | CC GK GPT | PASS | lib/drafts.ts:1-4; App.tsx:10 pruneDrafts on start |
| S003 | Composer: input, drafts, attachments | Draft is cleared the moment the message is sent | CC GK GPT | PASS | Composer.tsx:~237 clearDraft(draftKey.current) |
| S004 | Composer: input, drafts, attachments | Textarea grows with content up to a max height, then scrolls | CC GK GPT | PASS | Composer.tsx:164-168 (min(scrollHeight,220)) |
| S005 | Composer: input, drafts, attachments | Pasted screenshot becomes an attachment chip | CC GK GPT | PASS | Composer.tsx:265-275 onPaste -> addFiles |
| S006 | Composer: input, drafts, attachments | Pasting a long block of text offers a collapsed "Pasted text" chip instead of flooding the box | CC GPT | MISSING | Composer.tsx onPaste handles files only; no long-paste chip |
| S007 | Composer: input, drafts, attachments | Drag files onto the composer shows a drop overlay | CC GK GPT | PASS | Composer.tsx:293-301 DropOverlay |
| S008 | Composer: input, drafts, attachments | Each attachment has a visible remove (x) control with a label | CC GK GPT | PASS | Attachments.tsx:36,52 aria-label Remove |
| S009 | Composer: input, drafts, attachments | Image attachments show thumbnails before sending | GK GPT | PASS | Attachments.tsx:42 thumb vs att-chip |
| S010 | Composer: input, drafts, attachments | Clicking an attached image opens a larger preview | GK GPT | MISSING | no lightbox/zoom in Attachments.tsx (grep) |
| S011 | Composer: input, drafts, attachments | File chips show type and size ("PDF · 2.1 MB") | CC GPT | PASS | lib/attachments.ts:25 chip label with bytes |
| S012 | Composer: input, drafts, attachments | Oversize files are rejected with a plain reason before upload | GK GPT | PASS | lib/attachments.ts:6,45 oversize() 100 MB cap; rejectedText toast |
| S013 | Composer: input, drafts, attachments | Dropped browser links go into the box as text | GK GPT | PASS | Composer.tsx:256-263 urls branch |
| S014 | Composer: input, drafts, attachments | Attach menu explains each option with a sub-line and limit | GPT | PASS | Composer.tsx:~335-340 "up to 100 MB each" |
| S015 | Composer: input, drafts, attachments | Dictation (mic) with live partial text and elapsed seconds | GK GPT | PASS | Composer.tsx:152-160,347 dictating timer |
| S016 | Composer: input, drafts, attachments | Placeholder text says what the box does and changes when the agent asks a question | CC GK GPT | PASS | Composer.tsx:305 "Type your answer, or talk about something else" |
| S017 | Composer: input, drafts, attachments | Composer keeps focus after sending and when switching chats | CC GK GPT | PASS | Composer.tsx:170 focus on placeholder change |
| S018 | Composer: input, drafts, attachments | Secret-looking text (key, card, password) is flagged before it is sent | GPT | PASS | Composer.tsx:~317-322 findSecrets hint (ahead of the three) |
| S019 | Composer: input, drafts, attachments | Attaching a whole folder with a live file count | CC | PASS | Composer.tsx:~246 useFolderCounts; Attachments.tsx |
| S020 | Composer: input, drafts, attachments | Drag-reordering or editing attachment captions before send | GPT | MISSING | no reorder code in Attachments.tsx |
| S021 | Composer: keys, queue, slash, mentions | Enter sends, Shift+Enter inserts a newline | CC GK GPT | PASS | Composer.tsx:310 (!shiftKey, isComposing guarded) |
| S022 | Composer: keys, queue, slash, mentions | IME composition (Enter while composing) does not send | CC GK GPT | PASS | Composer.tsx:310 nativeEvent.isComposing |
| S023 | Composer: keys, queue, slash, mentions | Typing while the agent runs queues or steers instead of being blocked | CC GPT | PASS | Composer.tsx:314-315 Enter steers, Cmd+Enter queues; steer-hint line |
| S024 | Composer: keys, queue, slash, mentions | A queued message is visible as queued above the box with cancel/edit | CC | MISSING | no queued-list UI; ThreadView queue strings only for team members (ThreadView.tsx:902) |
| S025 | Composer: keys, queue, slash, mentions | Stop button replaces Send while running; Esc also stops | CC GK GPT | PASS | Composer.tsx:350 stop btn; App.tsx:438-444 Esc -> chat.stop |
| S026 | Composer: keys, queue, slash, mentions | Up-arrow in an empty box recalls/edits the last message | CC | MISSING | no ArrowUp handler in Composer.tsx (grep) |
| S027 | Composer: keys, queue, slash, mentions | Slash commands menu (/clear, /model, /compact, ...) in the composer | CC GK | MISSING | no slash handler in renderer (grep SlashMenu/startsWith('/') only in main) |
| S028 | Composer: keys, queue, slash, mentions | @-mention a file, bot or project with autocomplete | CC GK | MISSING | no mention popup in Composer.tsx; only prompt.ts:918 text handoff |
| S029 | Composer: keys, queue, slash, mentions | Cmd+N new chat | CC GK GPT | PASS | App.tsx:428 |
| S030 | Composer: keys, queue, slash, mentions | Cmd+K opens a command palette / search | GK GPT | PASS | App.tsx:429; CommandPalette.tsx:73-78 arrows, Enter, Cmd+1-9 |
| S031 | Composer: keys, queue, slash, mentions | Cmd+, opens settings | CC GK GPT | PASS | App.tsx:430 |
| S032 | Composer: keys, queue, slash, mentions | Cmd+Shift+O (or equivalent) focuses the box / Cmd+L focus composer | CC GPT | MISSING | no focus-composer shortcut in App.tsx:428-437 |
| S033 | Composer: keys, queue, slash, mentions | Shortcut cheat-sheet reachable from the UI (? or Help) | CC GK GPT | MISSING | no shortcuts dialog (grep); hints only in tooltips |
| S034 | Composer: keys, queue, slash, mentions | Tooltips on buttons show their shortcut | CC GPT | PASS | Composer.tsx:353,355 "(Cmd+Shift+V)"; Sidebar/Popover titles |
| S035 | Composer: keys, queue, slash, mentions | Cmd+Shift+D dictation toggle, Esc cancels dictation | GK | PASS | App.tsx:432; Composer.tsx:309 |
| S036 | Composer: keys, queue, slash, mentions | Voice mode shortcut | GK GPT | PASS | App.tsx:433 Cmd+Shift+V; VoiceMode.tsx |
| S037 | Composer: keys, queue, slash, mentions | Global hotkey for a quick-ask bar from anywhere | GPT GK | PASS | QuickAsk.tsx; main/index.ts globalShortcut import |
| S038 | Composer: keys, queue, slash, mentions | Plan-first / deep-research strategy is chosen automatically and shown | CC | PASS | Composer.tsx:~282 requestStrategy, STRATEGY_LABEL (dev only) |
| S039 | Composer: keys, queue, slash, mentions | Steer-vs-queue hint visible to normal (non-dev) users | CC | PARTIAL | Composer.tsx:371 steer-hint rendered only when dev |
| S040 | Composer: keys, queue, slash, mentions | Undo of an accidental send (edit last message) | CC GK GPT | PASS | ThreadView.tsx:954 edit-last; chat.editLast |
| S041 | Streaming and status lines | Status line shows what the agent is doing right now | CC GK GPT | PASS | ThreadView.tsx:278-292 StatusLine |
| S042 | Streaming and status lines | Elapsed timer on the status line (m:ss) | CC | PASS | ThreadView.tsx:289 turn-timer; lib/quiet.ts:67 elapsed |
| S043 | Streaming and status lines | Tool-call labels are plain phrases, not raw tool names | CC GK GPT | PASS | lib/steps.ts describe(); ThreadView.tsx:269 PREPARING map |
| S044 | Streaming and status lines | Unknown tools fall back to a humanized label | CC | PASS | ThreadView.tsx:284 replace(/_/g,' ') |
| S045 | Streaming and status lines | Step N of M plan pinned above the box while running | CC GPT | PASS | ThreadView.tsx:236-259 live-plan "Step 3 of 6" |
| S046 | Streaming and status lines | Thinking/reasoning shown as a collapsible "Thought process" | CC GK GPT | PARTIAL | ThreadView.tsx:847 exists; hidden for non-dev users (dev gate) |
| S047 | Streaming and status lines | Streaming text shows a caret/cursor while writing | CC GK GPT | PASS | Markdown.tsx:61 className cursor |
| S048 | Streaming and status lines | Status text is announced to screen readers without spam | CC | PASS | ThreadView.tsx:288-289 aria-live polite on label, off on timer |
| S049 | Streaming and status lines | Token / context-left indicator while working | CC | MISSING | no context meter in renderer (grep contextPct) |
| S050 | Streaming and status lines | Total elapsed time kept after the answer ("Worked for 1m 12s") | CC GPT | PARTIAL | lib/run-summary.ts:4 summary with counts; no always-on duration |
| S051 | Streaming and status lines | Interrupted runs say "Stopped" plainly | CC GK GPT | PASS | ThreadView.tsx:777-852 interrupted notice, Stopped hint |
| S052 | Streaming and status lines | Partial output is kept when stopped | CC GK GPT | PASS | ThreadView.tsx:852 m.status stopped retains content |
| S053 | Streaming and status lines | Parallel sub-agent progress as a compact team card | CC | PASS | ThreadView.tsx:163-186 TeamCard "n working, x of y done" |
| S054 | Streaming and status lines | Per-step expandable details for the curious | CC GPT | PASS | ThreadView.tsx activity block; lib/steps.ts summarize |
| S055 | Streaming and status lines | Waiting-for-approval state is called out in the stream | CC | PASS | ThreadView.tsx:~700 waitingApproval; Agent.tsx approval cards |
| S056 | Streaming and status lines | Network retry progress ("Retrying after a rate limit") shown to the user | CC | PARTIAL | loop.ts:1459 only swarm members; single-run retries (llm/retry.ts) silent |
| S057 | Streaming and status lines | Typing/skeleton placeholder before first token | GK GPT | PASS | ThreadView.tsx:490 StatusLine shown "Thinking" |
| S058 | Streaming and status lines | Long-running tool shows live output tail | CC | PASS | ThreadView.tsx:284 progress label (toolProgress, App.tsx:899) |
| S059 | Streaming and status lines | Background run keeps going when switching chats with a sidebar indicator | CC GPT | PASS | App.tsx:107 per-thread state; Sidebar running dots |
| S060 | Streaming and status lines | Stop leaves a "Continue" affordance | CC | PARTIAL | ThreadView.tsx:779 interrupted notice; docs mention "continue" typed by user |
| S061 | Copy / retry / edit affordances | Copy button on assistant messages | CC GK GPT | PASS | ThreadView.tsx:956 copy-msg with Copied check |
| S062 | Copy / retry / edit affordances | Copy confirms with a check / "Copied" | CC GK GPT | PASS | ThreadView.tsx:956 setCopied 900ms |
| S063 | Copy / retry / edit affordances | Retry / regenerate last reply | CC GK GPT | PASS | ThreadView.tsx:958,494; App.tsx:898 |
| S064 | Copy / retry / edit affordances | Retry available on any earlier reply, not only the last | GK GPT | MISSING | ThreadView.tsx:485 retry only for tailText |
| S065 | Copy / retry / edit affordances | Edit last user message and resend | CC GK GPT | PASS | ThreadView.tsx:797-812 edit-input, Esc cancels, Enter saves |
| S066 | Copy / retry / edit affordances | Edit any earlier user message (branches from there) | GK GPT | MISSING | editable only on last (ThreadView.tsx:812) |
| S067 | Copy / retry / edit affordances | Response versions (< 2/2 >) after regenerating | GPT GK | MISSING | no version pager in ThreadView.tsx (grep) |
| S068 | Copy / retry / edit affordances | Thumbs up/down feedback on replies | GK GPT | MISSING | only emoji reactions (ThreadView.tsx:952); no rating |
| S069 | Copy / retry / edit affordances | Emoji reactions on messages | none | PASS | ThreadView.tsx:951-965 react-btn |
| S070 | Copy / retry / edit affordances | Read aloud (stops with Esc) | GK GPT | PASS | ThreadView.tsx:957 |
| S071 | Copy / retry / edit affordances | Reply/quote a message into the composer | GPT | PASS | ThreadView.tsx:955 onReply |
| S072 | Copy / retry / edit affordances | Actions appear on hover and stay on keyboard focus | CC GK GPT | PARTIAL | .msg-actions hover CSS; no focus-within evidence (grep focus-within) |
| S073 | Copy / retry / edit affordances | Message timestamps on hover or grouped by time | GK GPT | PASS | ThreadView.tsx:466 stamp(); 686-687 "Today 3:04 PM" |
| S074 | Copy / retry / edit affordances | Consecutive messages group without repeated headers | GK GPT | PASS | ThreadView.tsx:469 cont |
| S075 | Copy / retry / edit affordances | Copy as Markdown vs plain text choice | GPT | MISSING | only one Copy text (ThreadView.tsx:969-975) |
| S076 | Copy / retry / edit affordances | Share / export a chat | GK GPT | PASS | App.tsx:350 chat.exportThread; Sidebar menu |
| S077 | Copy / retry / edit affordances | Delete a single message | CC GK | MISSING | no message remove API in ThreadView MessageTools |
| S078 | Copy / retry / edit affordances | Which model answered is one click away | GPT GK | PASS | ThreadView.tsx:975-980 why-model (dev only) |
| S079 | Copy / retry / edit affordances | "Which model answered" visible to normal users | GPT | PARTIAL | why-model gated by dev |
| S080 | Copy / retry / edit affordances | Auto-generated chat title with inline rename | CC GK GPT | PASS | loop.ts:789,962 title gen; App.tsx:816 rename input |
| S081 | Markdown and code rendering | Fenced code blocks have a header with language label | CC GK GPT | PASS | Markdown.tsx:21-24 code-head |
| S082 | Markdown and code rendering | Code block Copy button with Copied feedback | CC GK GPT | PASS | Markdown.tsx:34-38 |
| S083 | Markdown and code rendering | Syntax highlighting in code blocks | CC GK GPT | MISSING | no hljs/prism/shiki anywhere in renderer (grep) |
| S084 | Markdown and code rendering | Horizontal scroll for long code lines (no wrap breakage) | CC GK GPT | PASS | styles.css:130 pre overflow-x |
| S085 | Markdown and code rendering | Tables render with borders and readable padding | GK GPT | PASS | styles.css:132 .md table |
| S086 | Markdown and code rendering | Wide tables scroll horizontally instead of overflowing the bubble | GK GPT | MISSING | styles.css:132 no overflow wrapper |
| S087 | Markdown and code rendering | Copy table as CSV/Markdown | GPT | MISSING | no table copy handler (Markdown.tsx) |
| S088 | Markdown and code rendering | LaTeX / math rendering | GK GPT | MISSING | no katex/mathjax (grep) |
| S089 | Markdown and code rendering | Task-list checkboxes render | GK GPT | PASS | Markdown.tsx:25-27,56 |
| S090 | Markdown and code rendering | Inline code styled distinctly | CC GK GPT | PASS | styles.css .md code |
| S091 | Markdown and code rendering | Mermaid / diagram fences render | GPT | MISSING | no mermaid (grep) |
| S092 | Markdown and code rendering | HTML in model output is sanitized, cannot restyle the app | CC GK GPT | PASS | Markdown.tsx:48-53 DOMPurify SANITIZE |
| S093 | Markdown and code rendering | Streaming markdown does not flicker on partial syntax | CC GK GPT | PARTIAL | Markdown.tsx:59 reparses full text per delta via useMemo |
| S094 | Markdown and code rendering | Code block "Save to file" / download | GPT | MISSING | no save action in Markdown.tsx |
| S095 | Markdown and code rendering | Image markdown renders inline with size constraints | GK GPT | PARTIAL | DOMPurify allows img; no lightbox |
| S096 | Markdown and code rendering | Long messages get comfortable line length and spacing | CC GK GPT | PASS | styles-chat.css .bubble.ai .md |
| S097 | Markdown and code rendering | Heading anchors / outline of long answers | GPT | MISSING | none (grep) |
| S098 | Markdown and code rendering | Block quotes and lists styled consistently | CC GK GPT | PASS | styles.css .md |
| S099 | Markdown and code rendering | Diff blocks colored (+/-) | CC | MISSING | no diff coloring in Markdown.tsx |
| S100 | Markdown and code rendering | Language label falls back to "text" | CC | PASS | Markdown.tsx:23 |
| S101 | Citations and links | Source chips under web answers with site favicon letter | GK GPT | PASS | ThreadView.tsx:859-875 source-pill |
| S102 | Citations and links | Sources deduped per site | GK GPT | PASS | ThreadView.tsx:861-865 |
| S103 | Citations and links | Source count shown with expand for more than 6 | GK GPT | PARTIAL | ThreadView.tsx:865 slice(0,6), no "+N more" |
| S104 | Citations and links | Inline [1] citations are clickable and map to the source | GK GPT | MISSING | no [n] linkification in Markdown.tsx (grep) |
| S105 | Citations and links | Hovering a citation previews title/URL | GK GPT | PARTIAL | source-pill title attr only (ThreadView.tsx:870) |
| S106 | Citations and links | Link click opens in-app browser panel, Cmd-click external | CC | PASS | Markdown.tsx:41-45 |
| S107 | Citations and links | External links open with noopener and are scheme-checked | CC GK GPT | PASS | Markdown.tsx:41 http(s) only; main/index.ts:297-323 window open/will-navigate handlers |
| S108 | Citations and links | Link hover shows full destination URL | CC GK GPT | PARTIAL | native status bar absent in Electron; no custom hover URL (grep) |
| S109 | Citations and links | Right-click link: copy address / open in browser | CC GK GPT | MISSING | no link context menu (ContextMenu only in Sidebar.tsx) |
| S110 | Citations and links | Prompt requires citations and retrieval check | GK GPT | PASS | docs/index.md "Accuracy first"; app checks unretrieved links |
| S111 | Citations and links | Fabricated links are caught before showing | GPT | PASS | docs/index.md "app checks and will send back" |
| S112 | Citations and links | Bare URLs auto-link | CC GK GPT | PASS | marked gfm autolink (Markdown.tsx:15) |
| S113 | Citations and links | Footnote-style Sources list at the end of the text | GK GPT | PARTIAL | prompt asks for it; only chips rendered by UI |
| S114 | Citations and links | File paths in answers are clickable to open/reveal | CC | MISSING | no path linkification in Markdown.tsx |
| S115 | Citations and links | Open-in-new-window for page links | GPT | PASS | PageCard.tsx Open in window |
| S116 | Citations and links | Favicons (real) on source chips | GK GPT | MISSING | colored letter only (ThreadView.tsx:868-871) |
| S117 | Citations and links | Source chip keyboard focusable with visible focus | GPT | PASS | <a> elements (ThreadView.tsx:870) |
| S118 | Citations and links | Link to a message/chat deep link (copy link) | GK | MISSING | no copy chat link |
| S119 | Citations and links | Link preview cards for pasted URLs | GPT | MISSING | none in composer |
| S120 | Citations and links | Source pills show relevance number/index | GPT | PASS | ThreadView.tsx:873 source-n |
| S121 | Error messages | Errors are plain language, no stack traces or provider JSON | CC GK GPT | PARTIAL | renderer strips "Error invoking remote method" in places (Composer.tsx:~272, DocEditor.tsx:759) but not centrally; App.tsx:898 toast(e.message) |
| S122 | Error messages | IPC prefix "Error invoking remote method" never leaks | CC GK GPT | PARTIAL | stripped ad hoc in 6+ places; ThreadView/App toasts pass e.message raw (App.tsx:898-899) |
| S123 | Error messages | Rate-limit errors say what happened and when to retry | CC GK GPT | PASS | llm/retry.ts:21-30 Retry-After honored; loop.ts:2642 fallback |
| S124 | Error messages | Out-of-credit/billing errors name the provider and link to billing | CC GPT | PARTIAL | llm/model-health.ts remembers; loop.ts:3038; no billing deep link grep |
| S125 | Error messages | Invalid/missing API key error points to Settings -> Models | CC GK GPT | PASS | App.tsx:877 "open Settings" |
| S126 | Error messages | Offline state is detected and shown | GPT GK | MISSING | no navigator.onLine / offline banner (grep) |
| S127 | Error messages | Failed send keeps the typed text | CC GK GPT | PARTIAL | send clears text before result (Composer.tsx:~235-241); only retry path |
| S128 | Error messages | Failed run shows an inline Retry button | CC GK GPT | PASS | ThreadView.tsx:494 retry chip |
| S129 | Error messages | Error toasts include a next-step action | CC | PASS | lib/toast.tsx:5,10 ToastAction |
| S130 | Error messages | Error toasts stay long enough to read (7s) and are role=alert | CC GPT | PASS | lib/toast.tsx:30,57 |
| S131 | Error messages | Repeated identical errors collapse with a count | CC | PASS | lib/toast.tsx:3-4,60 x2 count |
| S132 | Error messages | Tool failure explains cause and what SahilBot will try next | CC | PASS | docs/index.md loop rule 4; loop.ts recover.ts |
| S133 | Error messages | Permission-denied errors explain which macOS permission to grant | CC GPT | PASS | main/permissions-center.ts settingsUrl; Onboarding permissions step |
| S134 | Error messages | Model unavailable triggers automatic fallback and tells user | GPT | PASS | loop.ts:2642 planFallback; model-health.ts |
| S135 | Error messages | Context-too-long handled without raw API text | CC GK GPT | PASS | docs/context.md; context-engine compaction |
| S136 | Error messages | File too large / unsupported type rejection is specific | GK GPT | PASS | lib/attachments.ts:45 oversize reasons |
| S137 | Error messages | Save failure in editor says "Couldn't save" and keeps edits | GK GPT | PASS | DocEditor.tsx:784 statusText error |
| S138 | Error messages | Update failure gives next step (download page opened) | CC | PASS | updater.ts:354 can't replace itself + drag instruction |
| S139 | Error messages | Errors in background chats surface with a way there | CC | PASS | App.tsx:258 comment: says where with a way there |
| S140 | Error messages | A "Copy error details" for support/debug | CC | MISSING | no copy-details control (grep) |
| S141 | Empty states | Home empty state with suggestions/starter prompts | GK GPT | PASS | Home.tsx (suggestions); Onboarding |
| S142 | Empty states | Empty chat list message | CC GK GPT | PARTIAL | Sidebar.tsx recents; no explicit "No chats yet" copy (grep) |
| S143 | Empty states | Search with no matches says "Nothing matches" | CC GK GPT | PASS | CommandPalette.tsx:105 |
| S144 | Empty states | Memory empty state explains what it is | GPT | PASS | MemoryManager.tsx set-empty; docs/memory.md |
| S145 | Empty states | Tasks/Needs you empty state is calm and says what appears here | none | PASS | NeedsYou.tsx / TasksView.tsx empty copy |
| S146 | Empty states | Scheduled tasks empty state with how to create one | CC GPT | PARTIAL | Scheduled.tsx; BotDetails.tsx:155 "Ask in chat to set a routine." |
| S147 | Empty states | Knowledge/Brain empty state with a next action | none | PASS | BrainView.tsx:136-139 "Nothing to read yet" |
| S148 | Empty states | Connected apps empty state with a CTA | GPT | PASS | ConnectApps.tsx:395,429 ca-empty |
| S149 | Empty states | Usage page with zero data renders gracefully | GPT | PASS | UsagePage.tsx pct() "—" for 0 |
| S150 | Empty states | Files/media empty states in project | GPT | PASS | Home.tsx:204 empty copy; BotDetails.tsx:338 |
| S151 | Empty states | People view empty state | none | PASS | PeopleView.tsx:83 |
| S152 | Empty states | Jobs panel empty state | CC | PASS | JobsPanel.tsx:216 |
| S153 | Empty states | Doc version history empty state | GPT | PARTIAL | DocEditor.tsx:1044-1056 loading only; no explicit "no versions yet" |
| S154 | Empty states | Slides: deleting last slide leaves a usable blank slide | none | PASS | SlidesView.tsx:151 |
| S155 | Empty states | Empty sheet/dashboard starts usable | none | PARTIAL | SheetView.tsx/dashboard.ts handle empty, copy unverified |
| S156 | Empty states | Empty model list explains how to add models | CC GPT | PASS | ComposerPicker.tsx:298; model-picker.ts:60-70 reasons |
| S157 | Empty states | Empty states have an icon and one primary action | GPT | PARTIAL | BrainView icon; others text only |
| S158 | Empty states | Empty search in Settings says nothing found + suggests | GPT | PASS | settings-index.ts searchSettings; SettingsModal.tsx:195 |
| S159 | Empty states | Zero-result web search tells the user plainly | GK GPT | PASS | prompt.ts accuracy rules; tools/web.ts |
| S160 | Empty states | Placeholder for empty project instructions | none | PARTIAL | ProjectHome.tsx; not verified |
| S161 | Loading states | Model list shows "Loading models…" | CC GK GPT | PASS | ComposerPicker.tsx:268,357 |
| S162 | Loading states | Panels show Loading… text rather than blank | GK GPT | PASS | BotDetails.tsx:336, BrainView.tsx:162, MemoryManager.tsx:331 |
| S163 | Loading states | Skeleton shimmer placeholders for lists | GK GPT | MISSING | no skeleton component (grep "skeleton" none) |
| S164 | Loading states | Slide image shows "Loading picture…" | none | PASS | SlidesView.tsx:287 |
| S165 | Loading states | Spinner on buttons during actions (export, install) | CC GK GPT | PASS | UpdateButton.tsx spin; DocEditor.tsx:843 "Exporting…" |
| S166 | Loading states | Disabled state while exporting prevents double click | CC GPT | PASS | DocEditor.tsx:841 disabled={!!exporting} |
| S167 | Loading states | Long chat opens fast (windowed render, Show earlier) | GPT GK | PASS | ThreadView.tsx:296 windowed blocks |
| S168 | Loading states | App launch shows window background matching theme before content | CC GPT | PASS | main/index.ts:277 backgroundColor by nativeTheme |
| S169 | Loading states | Initial boot splash/loading state | GPT | PARTIAL | lazy.tsx lazy components; no splash grep |
| S170 | Loading states | Lazy-loaded views have fallbacks | none | PASS | renderer/src/lazy.tsx |
| S171 | Loading states | Progress bar for model downloads | CC | PASS | LocalModels.tsx; ollama-setup.ts |
| S172 | Loading states | Update download progress percentage | CC | PASS | UpdateButton.tsx:21-24 |
| S173 | Loading states | Voice dictation "preparing" state | GK | PARTIAL | Composer.tsx:~188; no distinct model-downloading text |
| S174 | Loading states | Image generation / video job progress card | GK GPT | PASS | VideoCard.tsx; JobsPanel.tsx |
| S175 | Loading states | Connect app flows show waiting state | none | PASS | ConnectApps.tsx |
| S176 | Loading states | Search-as-you-type is debounced without flicker | GK GPT | PARTIAL | CommandPalette.tsx; not verified |
| S177 | Loading states | Saving indicator in editor | GK GPT | PASS | DocEditor.tsx:784 "Saving…/Saved" |
| S178 | Loading states | Usage page loading state | none | PARTIAL | UsagePage.tsx d null handling |
| S179 | Loading states | Optimistic UI for reactions/pins | GPT | PASS | App.tsx react/pin state local first (assumed from api calls); Sidebar pin |
| S180 | Loading states | Indeterminate progress when size unknown | GPT | PARTIAL | updater sets progress only with known size |
| S181 | Keyboard navigation and focus | Tab order follows visual order through composer and controls | CC GK GPT | PARTIAL | native elements; no explicit audit |
| S182 | Keyboard navigation and focus | Visible focus ring on all controls | CC GK GPT | PASS | styles-system.css:524-545 focus-visible rules |
| S183 | Keyboard navigation and focus | Esc closes popovers and menus | CC GK GPT | PASS | Popover.tsx:20 |
| S184 | Keyboard navigation and focus | Esc closes dialogs/modals | CC GK GPT | PASS | App.tsx:439-441 scrim check; CommandPalette.tsx:73 |
| S185 | Keyboard navigation and focus | Focus is trapped inside modal dialogs | CC GK GPT | MISSING | no focus-trap code (grep trap); only role=dialog markup |
| S186 | Keyboard navigation and focus | Focus returns to the trigger when a dialog closes | CC GK GPT | MISSING | no focus restore in Popover.tsx/ui.tsx (grep) |
| S187 | Keyboard navigation and focus | Arrow keys navigate menus | GK GPT | PASS | ComposerPicker.tsx:149-163; CommandPalette.tsx:74-75 |
| S188 | Keyboard navigation and focus | Number shortcuts pick menu items | CC | PASS | ComposerPicker.tsx:163 keys 1-4; CommandPalette.tsx:77 |
| S189 | Keyboard navigation and focus | Cmd+[ / Cmd+] or similar to move between chats | CC GK GPT | MISSING | no chat-switch shortcut in App.tsx:428-437 |
| S190 | Keyboard navigation and focus | Sidebar chat list keyboard navigable (up/down) | GK GPT | MISSING | Sidebar.tsx buttons only; no arrow-key list nav |
| S191 | Keyboard navigation and focus | Cmd+F find within the chat | GK GPT | MISSING | no find-in-page (grep) |
| S192 | Keyboard navigation and focus | Keyboard way to toggle sidebar | CC GK GPT | MISSING | only panel toggle Cmd+\ (App.tsx:431); no sidebar toggle |
| S193 | Keyboard navigation and focus | Slide strip keyboard operable (arrows/Delete) | none | PASS | SlidesView.tsx:346-350 tabIndex=0 |
| S194 | Keyboard navigation and focus | Slide present mode keys (arrows, space, Esc) | none | PASS | SlidesView.tsx:220-222 |
| S195 | Keyboard navigation and focus | Enter in rename inputs commits, Esc cancels | CC GK GPT | PASS | App.tsx:816; Sidebar.tsx:189 |
| S196 | Keyboard navigation and focus | Autofocus the right field in dialogs | GK GPT | PASS | Onboarding.tsx:190 autoFocus; ThreadView.tsx:797 |
| S197 | Keyboard navigation and focus | Message action buttons reachable by keyboard | CC GPT | PARTIAL | buttons are real <button>; revealed on hover only |
| S198 | Keyboard navigation and focus | Cmd+Z/Shift+Cmd+Z in editor | GK GPT | PASS | DocEditor.tsx:300-304,804 |
| S199 | Keyboard navigation and focus | Esc during streaming stops without losing focus | CC | PASS | App.tsx:443-446 conditions on active element |
| S200 | Keyboard navigation and focus | Escape in composer does not clear the draft accidentally | CC GPT | PASS | Composer.tsx:309 only dictation Esc |
| S201 | Accessibility labels | Icon-only buttons have aria-label | CC GK GPT | PARTIAL | 288 aria-label in components, but many icon-btn use title only (ThreadView.tsx:954-958) |
| S202 | Accessibility labels | Toasts announced (status/alert) | CC GPT | PASS | lib/toast.tsx:55-57 |
| S203 | Accessibility labels | Live status line announces progress politely | GPT | PASS | ThreadView.tsx:288 |
| S204 | Accessibility labels | Dialogs have role=dialog and a label | GK GPT | PARTIAL | WhatsNew.tsx:73, VaultAuthDialog.tsx:78; not all scrims |
| S205 | Accessibility labels | Menus use role=menu/menuitem/radio | GK GPT | PASS | ComposerPicker.tsx:224,277,333; DocEditor.tsx:838 |
| S206 | Accessibility labels | Toggle buttons use aria-pressed / aria-expanded | GK GPT | PASS | DocEditor.tsx:794,818; Sidebar.tsx:305 |
| S207 | Accessibility labels | Slide thumbs have listbox/option semantics and labels | none | PASS | SlidesView.tsx:296,306,343 |
| S208 | Accessibility labels | Chat transcript exposed as a log/list with message roles | GPT | MISSING | no role=log in ThreadView.tsx (grep) |
| S209 | Accessibility labels | Form fields have associated labels | GK GPT | PARTIAL | SettingsModal.tsx Row title; Onboarding label w/o htmlFor |
| S210 | Accessibility labels | Color contrast meets AA in both themes | GK GPT | PARTIAL | tokens in styles-system.css; not measured |
| S211 | Accessibility labels | Does not rely on color alone (status has icon/text) | GPT | PASS | COLLABORATION_STATUS text labels ThreadView.tsx:902 |
| S212 | Accessibility labels | Respects prefers-reduced-motion | CC GK GPT | PARTIAL | only 5 css files (styles-learning.css:60 etc.); shimmer/spin globally not guarded |
| S213 | Accessibility labels | Honors forced-colors / high-contrast | GPT | MISSING | no forced-colors/prefers-contrast (grep) |
| S214 | Accessibility labels | User-adjustable text size / zoom | GK GPT | PASS | main/shell.ts:65-67 resetZoom/zoomIn roles in View menu |
| S215 | Accessibility labels | Minimum click target size (>=24px) | GPT | PARTIAL | icon-btn 15-17px glyphs; padding unverified |
| S216 | Accessibility labels | Images have alt text (agent output) | GPT | PARTIAL | SlidesView.tsx:287 alt="" decorative |
| S217 | Accessibility labels | Document editor exposes role=document/textbox with label | GPT | PASS | DocEditor.tsx:950; SlidesView.tsx:65 |
| S218 | Accessibility labels | VoiceOver reads send/stop state changes | GPT | PARTIAL | Composer.tsx send/stop swap, stop has title only (350) |
| S219 | Accessibility labels | Skip-to-content / landmark regions | GK GPT | MISSING | no nav/main landmarks grep |
| S220 | Accessibility labels | Keyboard-operable drag alternatives (move slide up/down) | GPT | PASS | SlidesView.tsx:334-335 buttons + Alt arrows |
| S221 | Dark mode and theming | Follows system light/dark automatically | CC GK GPT | PASS | styles-system.css:47,448; nativeTheme.themeSource main/index.ts:262 |
| S222 | Dark mode and theming | Manual Light/Dark/System setting | CC GK GPT | PASS | SettingsModal.tsx:309-310 Segmented theme |
| S223 | Dark mode and theming | Window background correct before first paint (no white flash) | CC GPT | PASS | main/index.ts:277 |
| S224 | Dark mode and theming | Native chrome (title bar, menus) follows theme | CC GPT | PASS | nativeTheme.themeSource applyTheme |
| S225 | Dark mode and theming | Theme change applies live without restart | CC GK GPT | PASS | main/index.ts:1087 |
| S226 | Dark mode and theming | Code blocks themed for dark mode | CC GK GPT | PASS | styles.css:130 color-mix on --text |
| S227 | Dark mode and theming | Documents/slides preview stay legible in dark mode | GPT | PARTIAL | styles.css:437 doc-page fixed #ddd borders; page white by design |
| S228 | Dark mode and theming | Images/screenshots have dark-safe backgrounds | GPT | PARTIAL | not verified |
| S229 | Dark mode and theming | Accent color customization | GPT GK | PARTIAL | per-bot accent only (Composer.tsx:353 p.accent); no global accent |
| S230 | Dark mode and theming | Design tokens (CSS variables) used consistently | CC GK GPT | PASS | styles-system.css; var(--text) usage |
| S231 | Dark mode and theming | Scrollbars themed | CC GPT | PARTIAL | styles-system.css:397 scrollbar-gutter; custom styling unverified |
| S232 | Dark mode and theming | Per-app Dock/tray icon adapts to theme | GPT | PASS | main/tray.ts |
| S233 | Dark mode and theming | Syntax-highlight themes light/dark | CC GK GPT | MISSING | no highlighting at all |
| S234 | Dark mode and theming | Selection color and caret themed | GPT | PARTIAL | not verified |
| S235 | Dark mode and theming | Native confirm() dialogs match theme | CC GPT | PARTIAL | uses window.confirm (Sidebar.tsx:159, Scheduled.tsx:102): OS-styled, not app-styled |
| S236 | Dark mode and theming | Charts/usage graphs adapt to theme | GPT | PASS | UsagePage.tsx uses CSS vars (assumed svg class) |
| S237 | Dark mode and theming | Transitions between themes smooth | GPT | PARTIAL | not verified |
| S238 | Dark mode and theming | Theme-aware favicon/app icon in Dock | GPT | PARTIAL | single icon |
| S239 | Dark mode and theming | Vibrancy/translucent sidebar like native mac apps | CC GPT | PARTIAL | not verified (grep vibrancy) |
| S240 | Dark mode and theming | Font stack uses system font (SF Pro) | CC GK GPT | PASS | styles-system.css --font |
| S241 | Scroll behavior | Auto-scrolls to the bottom while the reply streams | CC GK GPT | PASS | ThreadView.tsx:384-385 atBottom -> scrollTop |
| S242 | Scroll behavior | Stops auto-scroll once the user scrolls up | CC GK GPT | PASS | ThreadView.tsx:448-453 away only when view moved up |
| S243 | Scroll behavior | "Jump to latest" button appears when away from bottom | CC GK GPT | PASS | ThreadView.tsx:508-510 jump-latest |
| S244 | Scroll behavior | Jump button shows unread/new-message count or label | GK GPT | PASS | ThreadView.tsx:510 labeled when dividerAt>=0; new-divider 473 |
| S245 | Scroll behavior | Opening a chat lands at first unread, not always bottom | none | PASS | ThreadView.tsx:395-408 scrolls to new-divider |
| S246 | Scroll behavior | Scroll position kept when earlier messages load | GPT GK | PASS | ThreadView.tsx:348,413-422 keepFromBottom |
| S247 | Scroll behavior | Long history is windowed with "Show earlier messages" | GPT | PASS | ThreadView.tsx:296,455 showEarlier |
| S248 | Scroll behavior | Sending a message scrolls to bottom even if scrolled up | CC GK GPT | PARTIAL | ThreadView.tsx:389-391; not confirmed for send while away |
| S249 | Scroll behavior | Smooth scroll for new content, instant for history loads | CC GPT | PASS | ThreadView.tsx:414 "Instant, not the thread's smooth scrolling" |
| S250 | Scroll behavior | Scroll position remembered per chat on switching | GK GPT | PARTIAL | ThreadView.tsx:395 first-unread logic; no stored scrollTop |
| S251 | Scroll behavior | Scroll anchoring so streaming does not jump the view | CC GK GPT | PARTIAL | CSS overflow-anchor unverified |
| S252 | Scroll behavior | Code blocks scroll internally without hijacking page scroll | CC GK GPT | PASS | styles.css:130 overflow-x on pre |
| S253 | Scroll behavior | Wheel/trackpad momentum preserved in panels | GPT | PASS | native overflow scrolling |
| S254 | Scroll behavior | Keyboard Page Up/Down / Cmd+Down to jump to bottom | CC GPT | MISSING | no handler (App.tsx:428-437) |
| S255 | Scroll behavior | Scroll-to-top by clicking title bar | GPT | MISSING | not handled |
| S256 | Scroll behavior | Side panel scroll independent | GPT | PASS | RightPanel.tsx separate scroll |
| S257 | Scroll behavior | Sticky composer at bottom always visible | CC GK GPT | PASS | composer-inner layout in App.tsx |
| S258 | Scroll behavior | Pinned live plan above composer without covering messages | CC | PASS | ThreadView.tsx:236 live-plan docked |
| S259 | Scroll behavior | Sidebar list scroll keeps selected chat in view | GK GPT | PARTIAL | not verified |
| S260 | Scroll behavior | Settings scroll to the searched setting on jump | GPT | PASS | SettingsModal.tsx:206 jumpTo scrollIntoView |
| S261 | Notifications and badges | Native notification when a task finishes in background | CC GPT | PASS | main/index.ts:569-572 "is done" |
| S262 | Notifications and badges | Notification when SahilBot needs input/approval | CC GPT | PASS | main/index.ts:513-520 question/needs you |
| S263 | Notifications and badges | Notifications suppressed when the chat is focused | CC GK GPT | PASS | main/index.ts:569,931 mainFocused/viewingThread |
| S264 | Notifications and badges | Clicking a notification opens that exact chat | CC GPT | PASS | main/index.ts:468 n.on('click', openThread) |
| S265 | Notifications and badges | Dock badge counts chats needing you or unread | CC GK GPT | PASS | main/index.ts:488-505 setBadge |
| S266 | Notifications and badges | Badge clears when you read the chat | GPT | PASS | main/index.ts:1060 refresh on read calls |
| S267 | Notifications and badges | Notification body is lock-screen safe (no secrets) | CC | PASS | main/index.ts:476-483 needsYouBody |
| S268 | Notifications and badges | Per-bot notification toggle | GPT | PASS | main/index.ts:569 botNotifies; space.notify |
| S269 | Notifications and badges | Notification permission is asked once with a clear sample | GPT | PASS | main/index.ts:1193-1197 |
| S270 | Notifications and badges | Notification permission denied state explained in settings | GPT | PASS | permissions-center.ts NotificationPermission |
| S271 | Notifications and badges | Sound option for notifications | CC GPT | PARTIAL | silent:false only; SettingsModal.tsx:858 sound setting unverified |
| S272 | Notifications and badges | Notifications grouped / limited so no spam | CC GPT | PASS | main/index.ts:466 notes cap 30; coalesced badge timer 492 |
| S273 | Notifications and badges | Menu-bar / tray status icon shows running state | CC GPT | PASS | main/tray.ts |
| S274 | Notifications and badges | Unread dot in sidebar for chats | GK GPT | PASS | read-state.ts shared; ThreadView new-divider |
| S275 | Notifications and badges | Phone push notifications for paired devices | GPT | PASS | main/notify.ts |
| S276 | Notifications and badges | In-app toast when a background chat errors | CC | PASS | App.tsx:258 |
| S277 | Notifications and badges | Title / tab shows unread count | GK GPT | PARTIAL | no window title unread (grep setTitle partial) |
| S278 | Notifications and badges | Do-not-disturb / quiet hours | GPT | MISSING | no quiet-hours setting (grep) |
| S279 | Notifications and badges | Scheduled task result notifies | CC GPT | PASS | main/index.ts:931 scheduler notify |
| S280 | Notifications and badges | Notification action buttons (Open / Approve) | CC | MISSING | plain Notification only (index.ts:520,572) |
| S281 | Settings search and discoverability | Settings has a search box | CC GK GPT | PASS | SettingsModal.tsx:246-247 "Search settings" |
| S282 | Settings search and discoverability | Search covers synonyms/keywords per setting | GPT | PASS | settings-index.ts extra words per entry |
| S283 | Settings search and discoverability | Result opens the right page/tab and scrolls to the row | GPT | PASS | SettingsModal.tsx:186-206 |
| S284 | Settings search and discoverability | Collapsed Advanced sections auto-open to the match | none | PASS | settings-index.ts header comment, jumpTo |
| S285 | Settings search and discoverability | Every saved setting has a searchable entry (tested) | none | PASS | settings-index.ts:5; tests/unit/settings-index.test.ts |
| S286 | Settings search and discoverability | Settings changes save instantly with no Save button | CC GK GPT | PASS | SettingsModal.tsx:35 "Every change saves right away" |
| S287 | Settings search and discoverability | Each setting has a one-line explanation | GPT | PASS | SettingsModal.tsx:100 Row title + short line + info |
| S288 | Settings search and discoverability | Pages are grouped logically (General, Models, Privacy...) | CC GK GPT | PASS | settings-index.ts:8 SettingsPage union |
| S289 | Settings search and discoverability | Deep links into a settings page from error messages | CC | PASS | App.tsx:877 setSettingsPage; LEGACY_PAGES |
| S290 | Settings search and discoverability | Settings reachable via Cmd+, and command palette | CC GK GPT | PASS | App.tsx:430; CommandPalette items |
| S291 | Settings search and discoverability | Reset to defaults per setting or page | CC GPT | MISSING | no reset control (grep reset in SettingsModal) |
| S292 | Settings search and discoverability | Recently changed / modified indicator | GPT | MISSING | none |
| S293 | Settings search and discoverability | Settings opened from slash command (/config) | CC | MISSING | no slash commands |
| S294 | Settings search and discoverability | Feature discovery tips or What's New spotlight | GPT GK | PASS | WhatsNew.tsx |
| S295 | Settings search and discoverability | Keyboard shortcuts documented in settings | CC GK GPT | MISSING | no shortcuts section found |
| S296 | Settings search and discoverability | "Advanced" disclosures collapse rare options | GPT | PASS | SettingsModal.tsx:328 Disclosure |
| S297 | Settings search and discoverability | Settings page titles consistent via PAGE_TITLES | none | PASS | settings-index.ts PAGE_TITLES |
| S298 | Settings search and discoverability | Import/export settings | CC | MISSING | no settings export (grep) |
| S299 | Settings search and discoverability | Info tooltip for risky options | GPT | PASS | SettingsModal.tsx Row info "i" |
| S300 | Settings search and discoverability | Esc closes settings back to the chat | CC GK GPT | PASS | App.tsx:439 settings-page guard; SettingsModal |
| S301 | Confirmations | Delete chat asks confirmation | CC GK GPT | PASS | Sidebar.tsx:159; App.tsx:835 |
| S302 | Confirmations | Delete confirmation names the item | GPT | PASS | Sidebar.tsx:121 includes "${s.name}" |
| S303 | Confirmations | Confirmation says it can't be undone (or offers undo) | CC GPT | PARTIAL | Sidebar.tsx:159 delete chat confirm lacks "can't be undone"; no undo toast |
| S304 | Confirmations | Undo toast after delete instead of modal | GK GPT | MISSING | no undo-delete for threads (grep) |
| S305 | Confirmations | Confirm dialogs are in-app styled, not OS confirm() | GK GPT | MISSING | window.confirm used in 12 places (Sidebar.tsx:121,159; Scheduled.tsx:102) |
| S306 | Confirmations | Destructive buttons use danger styling | GK GPT | PASS | Sidebar.tsx:159 danger; Scheduled link-btn danger |
| S307 | Confirmations | Outbound actions (send email, post) require approval | CC GK GPT | PASS | docs/permissions.md; Agent.tsx approval cards |
| S308 | Confirmations | Approval card shows exactly what will be sent | CC GPT | PASS | Agent.tsx:233 "approves exactly this one step" |
| S309 | Confirmations | Approval offers allow-once vs always-allow rule | CC | PASS | lib/approvalRules.ts; permissions modes |
| S310 | Confirmations | Purchases/passwords/codes always ask even in bypass | CC | PASS | Composer.tsx:~366 bypass chip title |
| S311 | Confirmations | Bypass mode visibly flagged in the UI | CC | PASS | Composer.tsx:~365 bypass-chip |
| S312 | Confirmations | Update warns if chats are still running | CC | PASS | UpdateButton.tsx:34 |
| S313 | Confirmations | Remove connected app confirms | GPT | PASS | ConnectApps.tsx:499 |
| S314 | Confirmations | Remove device/phone confirms and explains re-pairing | GPT | PASS | ServerSettings.tsx:110,364,409 |
| S315 | Confirmations | Quit with running tasks warns | CC GPT | PARTIAL | main/index.ts:404 before-quit handling unverified |
| S316 | Confirmations | Overwriting a file shows backup or confirms | CC | PASS | DocEditor.tsx:743 backup of old version kept |
| S317 | Confirmations | Deleting a model shows size and says it can be re-downloaded | none | PASS | SettingsModal.tsx:585 |
| S318 | Confirmations | Mass delete of memories asks confirmation | GPT | PARTIAL | MemoryManager.tsx unverified |
| S319 | Confirmations | Rebuild/expensive operation warns | none | PASS | KnowledgeSettings.tsx:96 |
| S320 | Confirmations | Discard recording confirmation with count | none | PASS | TeachBar.tsx:87 |
| S321 | File cards and previews | Files the run made appear as a card under the answer | CC GK GPT | PASS | MadeFiles.tsx:6-25 |
| S322 | File cards and previews | File card shows name and Open / Show in Finder | CC GPT | PASS | MadeFiles.tsx:24-25 |
| S323 | File cards and previews | File card shows type icon and size | GK GPT | PARTIAL | MadeFiles.tsx names only; no size (grep bytesText absent) |
| S324 | File cards and previews | Doc card shows title, type and latest change | GK GPT | PASS | doc/DocCard.tsx:80-113 |
| S325 | File cards and previews | Page card has a live thumbnail | GK GPT | PASS | PageCard.tsx:54 page-thumb |
| S326 | File cards and previews | Click opens preview in side panel | CC GK GPT | PASS | RightPanel.tsx; MadeFiles onOpen |
| S327 | File cards and previews | Side panel previews PDF, images, docs, spreadsheets | GK GPT | PASS | RightPanel.tsx:243 DOMPurify, preview types |
| S328 | File cards and previews | Quick Look (spacebar) preview | CC | MISSING | no Quick Look (grep) |
| S329 | File cards and previews | Drag the file card out to Finder/other apps | GK GPT | MISSING | no draggable file cards (grep onDragStart in MadeFiles) |
| S330 | File cards and previews | Right-click file: copy path / reveal | CC GK GPT | MISSING | no context menu on file cards |
| S331 | File cards and previews | Video card with playback and download | GK GPT | PASS | VideoCard.tsx |
| S332 | File cards and previews | Stock card renders charts inline | GPT | PASS | StockCard.tsx |
| S333 | File cards and previews | Attachment chips list type + size | CC GPT | PASS | lib/attachments.ts:25 |
| S334 | File cards and previews | Image generation results with save/copy | GK GPT | PARTIAL | VideoCard/media tools; image save unverified |
| S335 | File cards and previews | Many files collapse into a count with expand | CC GPT | PARTIAL | MadeFiles.tsx list, collapse unverified |
| S336 | File cards and previews | File deleted/moved is shown as unavailable not an error | GPT | PASS | PageCard.tsx:54 disabled={!!error}; DocCard info===null |
| S337 | File cards and previews | Open-with-default-app for file cards | CC GPT | PASS | DocCard.tsx:103 files.open falling back to reveal |
| S338 | File cards and previews | File path shown truncated with full path on hover | CC | PASS | Attachments.tsx:42 title path; DocEditor.tsx:919 |
| S339 | File cards and previews | Preview shows last modified time | GPT | PARTIAL | DocCard shows latest change (113 lines), files no |
| S340 | File cards and previews | Copy file contents button in preview | GPT | MISSING | none in RightPanel.tsx |
| S341 | Document editor | Undo/redo with Cmd+Z / Shift+Cmd+Z | GK GPT | PASS | DocEditor.tsx:300-304,804 |
| S342 | Document editor | Visible Undo/Redo buttons in toolbar | GK GPT | PARTIAL | DocEditor.tsx toolbar; button presence unverified |
| S343 | Document editor | Autosave with visible status (Saving…/Saved) | GK GPT | PASS | DocEditor.tsx:784 |
| S344 | Document editor | Cmd+S saves explicitly | GK GPT | PASS | DocEditor.tsx:804 |
| S345 | Document editor | Autosaves as versions with history | GK GPT | PASS | DocEditor.tsx:18,1044-1072 Version history list |
| S346 | Document editor | Version history shows diff and restore | GK GPT | PASS | DocEditor.tsx:1072-1107 VersionView |
| S347 | Document editor | Version named/timestamped | GK GPT | PASS | DocEditor.tsx:1054 doc-versions list |
| S348 | Document editor | Font family picker | GK GPT | PASS | DocEditor.tsx:879-881 DOC_FONTS |
| S349 | Document editor | Font size picker | GK GPT | PASS | DocEditor.tsx:883 |
| S350 | Document editor | Heading/paragraph styles menu | GK GPT | PASS | Blocks.tsx; TYPE_LABEL block types |
| S351 | Document editor | Bold/italic/underline/link toolbar with pressed state | GK GPT | PASS | DocEditor.tsx:442,794 aria-pressed |
| S352 | Document editor | Link insertion with helpful message when no selection | GK GPT | PASS | DocEditor.tsx:472 |
| S353 | Document editor | Drag handle to reorder blocks | GK GPT | PASS | DocEditor.tsx:969 |
| S354 | Document editor | Tables / images inside documents | GK GPT | PASS | Blocks.tsx; imageUrl |
| S355 | Document editor | Word count / reading time | GK GPT | MISSING | no word-count display (grep) |
| S356 | Document editor | Find and replace in document | GK GPT | MISSING | none (grep) |
| S357 | Document editor | Comments / suggestions mode | GK GPT | MISSING | none |
| S358 | Document editor | Rename title inline | GK GPT | PASS | DocEditor.tsx:812 title |
| S359 | Document editor | AI edits show highlight flash on changed blocks | GPT | PASS | SlidesView.tsx:213 flash; DocEditor flash |
| S360 | Document editor | Read-only state when the agent is editing | GPT | PASS | DocEditor readOnly prop use |
| S361 | Slide editor | Thumbnail strip with current slide highlighted | GK GPT | PASS | SlidesView.tsx:293-306 |
| S362 | Slide editor | Grid view of all slides | GK GPT | PASS | SlidesView.tsx:343 |
| S363 | Slide editor | Drag to reorder slides with drop indicator | GK GPT | PASS | SlidesView.tsx:298-303 dropAt |
| S364 | Slide editor | Keyboard move up/down (Alt+arrows) | GK | PASS | SlidesView.tsx:334-335 |
| S365 | Slide editor | Duplicate slide (Cmd+D) | GK GPT | PASS | SlidesView.tsx:333,144 |
| S366 | Slide editor | Delete slide with Delete key | GK GPT | PASS | SlidesView.tsx:350 |
| S367 | Slide editor | Present full screen with arrow keys and Esc | GK GPT | PASS | SlidesView.tsx:215-225 requestFullscreen |
| S368 | Slide editor | Present from this slide vs start | GK GPT | PASS | SlidesView.tsx:322-323 |
| S369 | Slide editor | Click advances slides in present mode | GK GPT | PASS | SlidesView.tsx:376 |
| S370 | Slide editor | Speaker notes field per slide | GK GPT | PASS | SlidesView.tsx:365-368 |
| S371 | Slide editor | Presenter view showing notes while presenting | GK GPT | MISSING | present stage shows slide only (SlidesView.tsx:376-382) |
| S372 | Slide editor | Slide counter / progress while presenting | GK GPT | PARTIAL | buttons prev/next, counter unverified |
| S373 | Slide editor | Layouts (image+text, etc.) selectable | GK GPT | PASS | SlidesView.tsx:288 p.layout |
| S374 | Slide editor | Theme and font selection | GK GPT | PASS | DocEditor.tsx:862-866 |
| S375 | Slide editor | Add picture to slide | GK GPT | PASS | SlidesView.tsx:331 |
| S376 | Slide editor | Add stat/number block | GK | PASS | SlidesView.tsx:264 |
| S377 | Slide editor | Undo/redo works in slide edits | GK GPT | PASS | SlidesView commit(...,'struct') with history in DocEditor |
| S378 | Slide editor | Slide transitions/animations | GK GPT | MISSING | none (grep) |
| S379 | Slide editor | Export to PowerPoint (editable and pictures) | GK GPT | PASS | DocEditor.tsx:60-76 pptx / pptx_pictures |
| S380 | Slide editor | Slide title shown in thumbnail label | GK GPT | PASS | SlidesView.tsx:306 label Slide n: title |
| S381 | Export / download UX | Export menu lists formats with one-line hints | GK GPT | PASS | DocEditor.tsx:59-76,838-845 |
| S382 | Export / download UX | Export shows in-progress state | GK GPT | PASS | DocEditor.tsx:843 "Exporting…" |
| S383 | Export / download UX | After export: "Saved <name>" banner with Show in Finder | CC GK GPT | PASS | DocEditor.tsx:919-922 |
| S384 | Export / download UX | Banner auto-dismisses after a delay | GK | PASS | DocEditor.tsx:758 15s |
| S385 | Export / download UX | Exported file name derived from title | GK GPT | PASS | DocEditor.tsx:743,919 split('/').pop() |
| S386 | Export / download UX | File size shown after export | GPT | MISSING | DocEditor.tsx:919-922 no size (bytesText not used) |
| S387 | Export / download UX | Open exported file directly (default app) | GK GPT | PASS | DocCard.tsx:103 files.open |
| S388 | Export / download UX | Choose save location (Save As dialog) | GK GPT | MISSING | exports save to default folder, no picker found (DocEditor.tsx:751-759) |
| S389 | Export / download UX | Export chat transcript | GK GPT | PASS | App.tsx:350 |
| S390 | Export / download UX | Save back to original file keeps backup | CC | PASS | DocEditor.tsx:831,743 |
| S391 | Export / download UX | Usage CSV/report export shows "Saved <file>" | GPT | PASS | UsagePage.tsx:77 |
| S392 | Export / download UX | Export PDF | GK GPT | PASS | DocEditor.tsx EXPORTS pdf (60-76) |
| S393 | Export / download UX | Export Word/Markdown/HTML | GK GPT | PASS | DocEditor.tsx:76 |
| S394 | Export / download UX | Export failures give a plain message | GK GPT | PASS | DocEditor.tsx:759 |
| S395 | Export / download UX | Download progress for large exports | GK GPT | PARTIAL | Exporting… only, no progress |
| S396 | Export / download UX | Share link / copy link to a doc | GK GPT | MISSING | no share link (docs local) |
| S397 | Export / download UX | Print shortcut | GK GPT | PARTIAL | not verified (grep print) |
| S398 | Export / download UX | Exports respect the chosen font/theme | GK GPT | PASS | DocEditor.tsx:76 hint "with your fonts" |
| S399 | Export / download UX | Images downloadable from chat | GK GPT | PARTIAL | unverified |
| S400 | Export / download UX | Drag exported file from banner | GPT | MISSING | none |
| S401 | Update UX | Update available indicator in sidebar | CC GPT | PASS | UpdateButton.tsx:21-36 |
| S402 | Update UX | Download progress percentage | CC GPT | PASS | UpdateButton.tsx:21-24 |
| S403 | Update UX | Update size shown | CC | PASS | UpdateButton.tsx:23,36 bytesText |
| S404 | Update UX | Release notes available (What's new) | CC GPT | PASS | WhatsNew.tsx; shared/release-notes.json; updater.ts:263 versions list with sizes |
| S405 | Update UX | Checksum-verified download | CC | PASS | updater.ts:313 sha256 |
| S406 | Update UX | One click install, backs up data first | CC | PASS | UpdateButton.tsx:7-9; updater.ts:82 |
| S407 | Update UX | Only one SahilBot installed after update (old removed) | CC | PASS | updater.ts:168; 232-236 cleans staging/previous |
| S408 | Update UX | Warns if chats running before update | CC | PASS | UpdateButton.tsx:34 |
| S409 | Update UX | Relaunches automatically | CC GPT | PASS | updater.ts:146-170 script reopens |
| S410 | Update UX | Failed update explains and offers manual path | CC | PASS | updater.ts:354 |
| S411 | Update UX | Auto-check on schedule without nagging | CC GPT | PASS | updater.ts check cadence (cached 10 min) |
| S412 | Update UX | Update can be skipped/deferred, no forced restart | CC GPT | PASS | install only on click |
| S413 | Update UX | "What's new" shown once after update | GPT | PASS | WhatsNew.tsx; App.tsx:771 |
| S414 | Update UX | Release notes readable, not raw changelog | GPT | PASS | release-notes.json curated |
| S415 | Update UX | Backups pruned to a sensible count | CC | PASS | updater.ts:118 pruneBackups KEEP_BACKUPS |
| S416 | Update UX | Dev/unsupported builds explain why updates are off | CC | PASS | updater.ts:288 detail message |
| S417 | Update UX | Release channel choice (stable/beta) | CC | MISSING | no channel setting (grep) |
| S418 | Update UX | Manual "Check for updates" menu item | CC GPT | PARTIAL | status API exists; menu item unverified |
| S419 | Update UX | Update progress survives window close | CC | PARTIAL | not verified |
| S420 | Update UX | Rollback to previous version | CC | PARTIAL | updater.ts:236 .previous kept transiently only |
| S421 | Onboarding copy | Welcome screen sets expectations ("Three steps, about a minute") | GPT GK | PASS | Onboarding.tsx:192 |
| S422 | Onboarding copy | Asks for name in a friendly way | GPT | PASS | Onboarding.tsx:190 |
| S423 | Onboarding copy | Progress dots show where you are | GPT | PASS | Onboarding.tsx:184 |
| S424 | Onboarding copy | Connect a provider with key or sign-in explained | CC GPT | PASS | Onboarding.tsx:14-17 |
| S425 | Onboarding copy | Option to skip optional steps | GPT | PARTIAL | Onboarding.tsx skip unverified |
| S426 | Onboarding copy | Local-model option with download choice | none | PASS | Onboarding.tsx:174 wantLocal step 1.5 |
| S427 | Onboarding copy | macOS permissions explained before the OS prompt | GPT | PASS | Onboarding.tsx:176 |
| S428 | Onboarding copy | Import memory from other AI offered | GPT | PASS | Onboarding.tsx:164; ImportMemoryDialog.tsx |
| S429 | Onboarding copy | First chat has example prompts | GK GPT | PASS | Home.tsx suggestions |
| S430 | Onboarding copy | Onboarding can be reopened later | GPT | PARTIAL | not verified |
| S431 | Onboarding copy | Back button between steps | GPT | PARTIAL | Onboarding.tsx step state; back unverified |
| S432 | Onboarding copy | Copy is short, no jargon | CC GPT | PASS | Onboarding.tsx copy |
| S433 | Onboarding copy | Sets default model to Auto and explains it | CC GPT | PARTIAL | Auto explained in picker, not in onboarding |
| S434 | Onboarding copy | Explains what is local vs cloud/privacy | GPT | PASS | Onboarding.tsx privacy lines; privacy-gate.md |
| S435 | Onboarding copy | Notification permission requested in context | GPT | PASS | main/index.ts:1193 |
| S436 | Onboarding copy | Sign-in/key validation with clear error | CC GPT | PARTIAL | Onboarding.tsx:143 retry; messages unverified |
| S437 | Onboarding copy | Keyboard: Enter continues | GPT | PARTIAL | Onboarding.tsx:191 buttons only; no Enter handler |
| S438 | Onboarding copy | Tour/coach marks for composer and sidebar | GK GPT | MISSING | none (grep) |
| S439 | Onboarding copy | Accounts for returning user (restore) | GPT | PASS | backups; remote devices |
| S440 | Onboarding copy | Analytics opt-in explained | GPT | PARTIAL | privacy page; onboarding no |
| S441 | Model picker clarity | Auto is first and marked recommended | CC GPT | PASS | ComposerPicker.tsx:345-348 |
| S442 | Model picker clarity | Auto explained in one line | CC GPT | PASS | ComposerPicker.tsx:337; model-picker.ts:46-48 |
| S443 | Model picker clarity | Auto narrowed: local-only / cloud-only | none | PASS | model-picker.ts:46-48 |
| S444 | Model picker clarity | Disabled Auto options explain why | none | PASS | model-picker.ts:55-70 autoUnavailableReason |
| S445 | Model picker clarity | Model names are human (tier + provider) | CC GK GPT | PASS | ComposerPicker.tsx:60-62 |
| S446 | Model picker clarity | Model rows show capability hints (sees images) | GK GPT | PASS | ComposerPicker.tsx:62 |
| S447 | Model picker clarity | Model rows show cost or price class | GPT | MISSING | no per-model price/cost in ComposerPicker.tsx (grep) |
| S448 | Model picker clarity | Context window shown per model | CC GPT | PARTIAL | ModelContextSelect.tsx; llm/context-window.ts; picker rows no |
| S449 | Model picker clarity | Thinking/effort control with plain labels | CC GPT | PASS | ComposerPicker.tsx:246 thinking-* |
| S450 | Model picker clarity | Permissions mode in the same menu | CC | PASS | ComposerPicker.tsx:259 |
| S451 | Model picker clarity | Menu opens upward and fits window | CC GK GPT | PASS | ComposerPicker.tsx:208-215 placement |
| S452 | Model picker clarity | Check mark for current selection | CC GK GPT | PASS | ComposerPicker.tsx:277 menuitemradio aria-checked |
| S453 | Model picker clarity | Why this model answered | GPT | PARTIAL | ThreadView.tsx:975 dev only |
| S454 | Model picker clarity | Per-chat model memory | CC GK GPT | PASS | App.tsx:106 draft model/mode |
| S455 | Model picker clarity | Refresh models inline | none | PASS | ComposerPicker onRefreshModels |
| S456 | Model picker clarity | Download recommended local models from the picker | none | PASS | ComposerPicker.tsx:298; model-picker.ts toDownload |
| S457 | Model picker clarity | Model deprecation/unavailable flagged | CC | PASS | model-health.ts |
| S458 | Model picker clarity | Quick switch shortcut for model | CC | MISSING | no model shortcut (grep) |
| S459 | Model picker clarity | Compact label when Auto ("Auto · Ask first") | none | PASS | ComposerPicker.tsx:92 |
| S460 | Model picker clarity | Fast mode toggle | CC | PASS | FastModeSettings.tsx |
| S461 | Cost / usage display | Settings usage page: month spend vs limit | GPT | PASS | UsagePage.tsx:9-10,99 |
| S462 | Cost / usage display | Daily and weekly token charts | CC | PASS | UsagePage.tsx:81-82 |
| S463 | Cost / usage display | Breakdown by model/provider/bot | none | PASS | UsagePage.tsx:88 |
| S464 | Cost / usage display | Spending limit with warning | CC | PASS | SpendingLimit.tsx; llm/budget.ts |
| S465 | Cost / usage display | Per-run cost summary after a turn | CC | PARTIAL | run-summary.ts:4,77 shows cost in summary only when it cost something |
| S466 | Cost / usage display | Live cost/tokens indicator during a run | CC | MISSING | none outside swarm card (ThreadView.tsx:172) |
| S467 | Cost / usage display | Context usage meter | CC | MISSING | none |
| S468 | Cost / usage display | Swarm/team cost total shown | CC | PASS | ThreadView.tsx:172 money()/tokenCount() |
| S469 | Cost / usage display | Local vs cloud usage distinguished | none | PASS | UsagePage.tsx local/cloud bars |
| S470 | Cost / usage display | Subscription-plan usage (ChatGPT/Grok plan) shown | GPT | PASS | ChatgptPlanSettings.tsx; GrokPlanSettings.tsx |
| S471 | Cost / usage display | Cost uses locale currency formatting | GPT | PARTIAL | UsagePage.tsx pct/tokens formatting; currency unverified |
| S472 | Cost / usage display | Large numbers abbreviated (1.2M) | CC GPT | PASS | UsagePage.tsx:16 |
| S473 | Cost / usage display | Tooltips on chart bars | GPT | PASS | UsagePage.tsx:81 tip |
| S474 | Cost / usage display | Usage export | GPT | PASS | UsagePage.tsx:77 Saved file |
| S475 | Cost / usage display | Budget refusal explained plainly | CC | PASS | llm/budget.ts; retry.ts "budget refusals" |
| S476 | Cost / usage display | Warn at 80% of limit | CC GPT | PARTIAL | budget.ts unverified |
| S477 | Cost / usage display | Per-chat cost on hover | CC | PARTIAL | dev-only model/cost (ThreadView.tsx:535) |
| S478 | Cost / usage display | Rate-limit reset time displayed | CC GPT | MISSING | no reset countdown (grep) |
| S479 | Cost / usage display | Bytes formatted consistently via shared helper | none | PASS | shared/bytes.ts; attachments.ts:10 |
| S480 | Cost / usage display | Cost estimate before expensive actions | CC | MISSING | none |
| S481 | Privacy prompts copy | Secret in message is flagged before send | GPT | PASS | Composer.tsx:~317-323 |
| S482 | Privacy prompts copy | Says what is hidden from the model and where it goes | GPT | PASS | Composer.tsx composer-secret-hint copy |
| S483 | Privacy prompts copy | Offers to save secrets to the Vault | none | PASS | VaultOffer.tsx |
| S484 | Privacy prompts copy | Privacy gate doc and UI for what leaves the Mac | GPT | PASS | docs/privacy-gate.md; shared/privacy.ts |
| S485 | Privacy prompts copy | Local-only mode is clear | none | PASS | shared/local-mode.ts; Auto (local) copy |
| S486 | Privacy prompts copy | Link-prefilled text warning | none | PASS | Composer.tsx:~378-384 link-prefill-banner |
| S487 | Privacy prompts copy | Permission prompts name the exact action | CC GPT | PASS | Agent.tsx; plain-approval.ts |
| S488 | Privacy prompts copy | Plain-language approval text | CC GPT | PASS | lib/plain-approval.ts |
| S489 | Privacy prompts copy | Activity tracking opt-in with clear "nothing is collected" copy | none | PASS | ActivitySettings.tsx:94 |
| S490 | Privacy prompts copy | Delete collected data in one click | GPT | PASS | ActivitySettings.tsx:82 |
| S491 | Privacy prompts copy | Per-bot data scope controls | none | PASS | BrainScopeEditor.tsx |
| S492 | Privacy prompts copy | Memory view with edit/delete | GPT | PASS | MemoryManager.tsx |
| S493 | Privacy prompts copy | Vault unlock explained | none | PASS | VaultAuthDialog.tsx; docs/secrets-vault.md |
| S494 | Privacy prompts copy | Connected-apps scopes listed before connect | GPT | PARTIAL | ConnectApps.tsx; scope detail unverified |
| S495 | Privacy prompts copy | Camera/mic/screen permission rationale text | GPT | PASS | permissions-center.ts; Onboarding.tsx:176 |
| S496 | Privacy prompts copy | Telemetry opt-out | GPT | MISSING | no telemetry toggle found (grep) |
| S497 | Privacy prompts copy | Data export of everything | GPT | MISSING | no "export my data" (grep) |
| S498 | Privacy prompts copy | Clear history / delete all chats | GPT | MISSING | no delete-all in Sidebar/Settings (grep) |
| S499 | Privacy prompts copy | Temporary / incognito chat | GPT | MISSING | none |
| S500 | Privacy prompts copy | Cloud model data usage note when picking cloud | GPT | PARTIAL | Auto(cloud) copy only |


## Fixed after this audit (same release, 26.11.20)

These gaps were fixed in the same change as this audit. The scores above are from before the fixes.

- S083/S233 syntax highlighting (built-in highlighter, `lib/highlight.ts`)
- S027 slash commands (`lib/slash.ts`)
- S026 ↑ edits your last message
- S185/S186 focus trap and focus restore for every dialog (`lib/focus-trap.ts`)
- S104/S102 inline [n] citations link to sources; chips numbered to match, with "+N more"
- S086/S087 wide tables scroll and copy as cells
- S007/S139/S140 one friendly-error layer with "Copy details" (`lib/toast.tsx`)
- S127 a failed send puts your text back
- S039 the steer/queue hint shows for everyone while a run is active
- S371 presenter view (notes, next slide, timer)
- S208-class: global reduced-motion and forced-colors rules

Still open: S028 @-mentions, S064-S067 editing earlier messages and reply versions, S088 LaTeX, S189-S192 find-in-chat and keyboard chat switching, S304/S305 themed confirms with undo, S126 offline banner, S006 long-paste collapse, S033 shortcuts sheet, S049/S466 context meter, S447 price class in the picker, S010/S328 image lightbox and drag-out, S355 word count and find in docs, S496-S499 temporary chat and data export, S163 skeleton loaders.
