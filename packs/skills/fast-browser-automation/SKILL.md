---
name: fast-browser-automation
description: Get things done in websites quickly and reliably with the browser tool.
source: you
uses: 0
category: Research
---

1. navigate returns a snapshot already: don't take another one right after.
2. Act by ref from the latest snapshot. After a click or type, read the reported outcome (what changed); snapshot again only if you need new refs.
3. Use batch actions for forms: fill several fields in one call, then submit.
4. For dropdowns use the select action; for page dialogs use the dialog action (dismiss by default).
5. Use get_text for reading long pages instead of repeated snapshots; scroll only when content loads lazily.
6. Logins: fill_secret with the saved login's name. If you hit a CAPTCHA or a 2-factor prompt, stop and ask the user to take over in the browser panel, then continue.
7. Before submitting anything that sends, buys or posts, make sure the user asked for exactly that.
