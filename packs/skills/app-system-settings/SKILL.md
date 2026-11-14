---
name: app-system-settings
description: System Settings: open the right pane, read it, change ordinary settings with care; security and privacy changes always go to the user.
source: you
uses: 0
category: Mac Apps
---

1. `app {app: "System Settings", action: "open_pane", args: {pane: "displays"}}` (list_panes lists names; "privacy: screen recording", "wi-fi", "keyboard", "notifications"…).
2. `read_pane` to see the controls and current values (or `computer ui {app: "System Settings"}` for refs).
3. Ordinary settings (dark mode, display, sound, notifications for an app, keyboard): change with computer use, `click_ref` / `set_value` on the ref, then read_pane to verify the new value. Tell the user what you changed.

Hard rules:
- Security and privacy panes (Privacy & Security and every permission list, Passwords, Users & Groups, Lock Screen, Touch ID, FileVault, Firewall, Sharing, Login Items, profiles): every click or value change there is a hard stop the user approves, and the user should flip the switch themselves when it grants an app access.
- Never grant SahilBot (or another app) a permission, never turn off FileVault/Firewall/Gatekeeper, never add users or remove passwords. Open the pane and explain what to change.
- Admin password or Touch ID prompts: the user answers.

Permission help for SahilBot itself: Accessibility (computer use), Screen Recording (screenshots), Automation (scripting other apps: allow per app), Full Disk Access (some folders). Open the pane with open_pane and tell the user which switch to turn on.
