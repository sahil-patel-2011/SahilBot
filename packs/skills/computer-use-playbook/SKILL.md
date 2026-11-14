---
name: computer-use-playbook
description: How to operate any Mac app reliably: observe, act, verify; dialogs and permission prompts; wrong windows; text entry; what to hand to the user.
source: you
uses: 0
category: Mac Apps
---

Pick the control path, best first:
1. The app's adapter: `app_help {app}` then `app {app, action, args}` (Finder, Safari/Chrome, Numbers/Pages/Keynote, Excel/Word/PowerPoint, Preview, Messages, Slack, Music/Spotify, VS Code/Cursor/Xcode, System Settings, Notes/Reminders/Calendar). Exact and screen-independent.
2. A connector or dedicated tool (mail, cursor, browser for websites, find_tools for Slack/Gmail/Notion).
3. Computer use with Accessibility refs: `computer ui {app}` → `click_ref` / `type_ref` / `set_value` / `press`.
4. Menus: `computer menu {path: "File > Export…"}` (a path ending at a menu lists its items). Keyboard shortcuts with `key`.
5. Coordinates from a `screenshot` (last resort; zoom with `screenshot {region}` for small text).

The loop, every step:
1. Observe: `ui {app}` (refs, values, focus, dialogs) or a screenshot when the app draws its own UI.
2. Act once.
3. Verify: read the result text ("Changed: …" or "No change detected"). If nothing changed, look again before retrying; never repeat a click blindly. Read values back after writing (adapter read, or `ui {query}`).

Text entry:
- `type_ref {ref, text}` for a field you can see in ui; `type {text}` types into whatever has focus (check focus first in ui).
- Short plain text is typed; long, multi-line or non-ASCII text (emoji, accents, CJK, smart quotes) is pasted automatically and the user's clipboard is put back. `paste_text` forces a paste; `method: "type"` forces typing (fields that block paste, autocomplete that needs keystrokes).
- The result says whether the field shows the text. "doesn't expose the field's text" means look with a screenshot.
- Replace a field's text: `type_ref {ref, text, clear: true}`; or `select_all {ref}` then type.
- Copy text out of an app: select it (select_all, triple_click a line, or drag), then `copy` returns it (`restore: true` puts the user's clipboard back). `copy {ref}` copies a whole field.
- Multi-line text into a single-line chat box: paste (Return would send early).

Windows and focus:
- Keystrokes go to the app in front. Before typing, make sure the right app and window are in front (`activate_app`, `focus_window`, or `windows` then `focus_window {window: "w3"}`).
- Landed in the wrong window or app: stop, `windows`, focus the right one, re-read with ui. Don't type into whatever happens to be in front.
- Several displays: `screenshot {display: 2}`; coordinates are always pixels of the latest screenshot.

Dialogs, sheets and prompts:
- After an action, "a dialog/sheet opened" means read it (ui) before anything else: Save sheets, "Replace?" alerts, "Don't Save".
- Save dialogs: type the name in the Save As field, then Return; navigate folders with cmd+shift+g and paste the folder path.
- "SahilBot wants to control X" / Automation prompts, Accessibility, Screen Recording, Full Disk Access: these are the user's. Tell them what to allow and where (System Settings → Privacy & Security → …), and wait. Never click Allow on a permission prompt for SahilBot yourself.
- Office "Grant access" for a folder, macOS "Are you sure you want to open it?" for downloads: ask the user.

Always the user's (hand off, don't work around):
- Passwords, passkeys, Touch ID, admin password prompts, keychain prompts: SahilBot never types or answers them.
- CAPTCHAs and 2-factor / one-time codes (unless the browser tool's own code card handles it).
- Payments, purchases, subscriptions, App Store Get/Buy.
- Sending messages or email, posting, deleting, the Trash: these always ask first.
- Security and privacy settings: every change asks.

Recovering:
- "No element e12": re-read with ui; refs change when the window changes.
- A ref "keeps changing": the list is animating or reloading; wait 1s and re-read.
- App draws its own UI (games, some Electron apps, canvases): screenshot + coordinates, then verify with another screenshot.
- Something unexpected (a login page, an error): stop and tell the user what you see rather than improvising.
