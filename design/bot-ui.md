# SahilBot bot-centric UI (design spec)

The app works around **bots**: each bot is a teammate with a name, a shape/color avatar, a job,
its own ongoing conversation, its routines and its memory. This spec is the shared reference for the
sidebar, the chat, Connect Apps and the bot details panel. It is SahilBot's own design: no other
product's name, logo, mascot or artwork.

## Tokens
Use the existing tokens in `styles.css` (`--bg`, `--sidebar`, `--panel`, `--text`, `--text-2`, `--text-3`,
`--line`, `--hover`, `--selected`, `--bubble-ai`, `--accent`, `--danger`, `--ok`, `--shadow`, `--font`).
Every new rule must work in light and dark mode (tokens only, no hard-coded greys). Per-bot color is
passed as the CSS variable `--bot` on the chat root (`style={{ '--bot': space.color }}`); default to
`var(--accent)` when there is no bot.

Radii: cards 16px, bubbles 22px, pills 999px. Shadows: `var(--shadow)` for floating things only.
Type: 15px body, 13px secondary, 12px labels. Motion: 120–160ms ease-out, nothing bouncy.

## Sidebar (bots)
- Top bar (draggable region, leaves room for the traffic lights): right-aligned round icon buttons
  **Search** (⌘K) and **New bot** (+). 36px circles, `--panel` background, `--shadow`.
- **Pinned bots as widgets**: pinned bots render as large avatars (64px) with the name under them,
  centered, in a wrapping row (1–4 per row). The primary bot (`isMain`) is pinned by default and shows
  a small star badge. Drag a bot here to pin it; drag out to unpin; drag to reorder. Empty pinned area
  shows nothing (no placeholder text) unless dragging, when it shows a dashed drop zone.
- **Bot list**: one row per bot (and group), 64px tall: 40px avatar, name (15px, 600), last-message
  preview (13px, `--text-2`, one line, ellipsis). Status on the right: spinner when working, accent dot
  when it needs you (pending approval/question), small dot when unread. Active row: `--selected`
  background, 14px radius.
- Below the bots: collapsible **Projects** and **Chats** (the main bot's separate chats), collapsed
  state remembered. Hidden bots: a "Hidden bots (n)" row at the very bottom that expands.
- Bottom bar: round initials button (opens Settings) and a wide **Connect apps** pill showing a small
  stack of the connected apps' icons (up to 3).
- Projects, Files and Scheduled stay reachable: ⌘K palette and the Connect apps / profile menus.

## Chat
- Floating **header pill** centered at the top: bot avatar (22px) + name, `--panel`, `--shadow`, pill
  radius. Click → opens the bot details panel. The thread title/menu goes inside its popover.
- Messages are **bubbles**: assistant `--bubble-ai` bubble (max 80% width, 22px radius, 14px 18px
  padding), user bubble in `--bot` with `--bot-text` (black or white, whichever reads better on that color: `readableOn()` in brand.tsx), right-aligned. Tool activity, plan cards, approval
  cards and team cards stay as cards between bubbles (not inside bubbles).
- Consecutive assistant bubbles stack with 6px gaps (like short progress messages, e.g.
  "Checking your classes now. I'll be back in a few minutes.").
- **System lines**: small centered `--text-3` 12px lines for events in the conversation, e.g.
  "Created routine · Weekday school reminder", "Paused routine · …", "Deleted routine · …".
- Composer: placeholder "Message {bot name}". Left: + (attach). Right: mic (dictation) and, only when
  the composer is empty, a round **voice chat** button filled with `--bot`. When there's text, the send
  arrow replaces it. Plan first / Deep Research / Team chips stay available.

## Bot details panel (right panel)
Opened from the header pill. Header: big avatar, name (editable), label (one line, "Add a label").
Tabs: **Details** and **Library**.
- Details: **Routines** list: each row shows the name, the schedule in words or "Paused", a toggle,
  and a menu (Test, Edit, Delete). Empty state: "Ask in chat to set a routine." Below: notifications
  switch ("Notify me when this bot finishes or needs me"), model, and Customize… (opens BotEditor).
- Routine detail: Instruction, When to run, Next run, Run history (Running / Succeeded / Failed with
  time and reason; "No runs yet"), buttons Pause/Resume, Test ("Running…" while it runs; result posts
  in the bot's chat), Edit (prefills the composer with "Edit routine "{name}": "), Delete (confirm).
- Library: files, links and pages from this bot's chats, grouped Today / This week / Older, 5 per
  group with "Show more"; filters All / Files / Links.

## Connect Apps
Modal, 880px wide, 16px radius.
- Header: "Connect Apps", a connected count with a stack of connected icons ("N connected ›", opens
  the manage view), close ×.
- Row: search "Search apps and skills" + a **Bot templates** button.
- Category chips: All, Password Managers, Productivity, Communication, Design, Code, More ▾ (the
  rest). Chips filter the list.
- Sections: "Recommended for you" (6, two columns), then one section per category (6 + "View all").
  Each item: 44px rounded app icon (real favicon, fallback letter tile), name, one-line description,
  and a button: **Add** (not connected), **Connect** (needs sign-in), **Connected ✓**.
- Manage view: Installed apps with status (Connected / Needs sign-in / Disconnected → Reconnect), a
  tools list per app with on/off switches, Remove.
- **Bot templates**: a gallery of ready-made bots (avatar, name, "by SahilBot", one line, **Add**).
  Adding creates the bot with its instructions, starter skills and suggested routines (routines are
  created paused until the user confirms in chat), then opens its chat with an intro message.
