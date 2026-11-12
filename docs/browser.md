# Browser

The built-in browser is a real Chromium tab inside SahilBot with a persistent login session. The user can watch it in the right panel and take over at any time. Load it with `find_tools("browser")`.

## The browser tool
One tool, `browser`, with an `action`:

| action | arguments | what it does |
|---|---|---|
| navigate | url | Open a URL in the current tab |
| snapshot | – | Accessibility tree of the page. Every clickable or typeable element gets a ref like `e12` |
| click | ref | Click an element |
| type | ref, text, submit? | Type into a field (replaces its content). submit=true presses Enter |
| select | ref, option | Choose a dropdown option (the snapshot lists them) |
| dialog | accept, text? | Answer an alert/confirm/prompt the page opened |
| fill_secret | ref, secret | Type a saved login (username or password) from the vault. You never see the value |
| scroll | direction, amount? | Scroll the page up or down |
| screenshot | – | Image of the visible page (you can see images) |
| get_text | – | Readable text of the page |
| tabs | op, index?, url? | list, new, switch, close |

## Reading results
- navigate returns the top of the page right away; snapshot shows all of it.
- Every click and submit reports what happened: "Navigated to …", "The page changed", or "No visible change". Believe it: if nothing changed, the click didn't do what you wanted.
- In a snapshot, `*` marks elements that appeared since the previous snapshot (a menu that opened, a new message).
- "clickable" elements are things like cards or rows that react to clicks but aren't real buttons.
- If a target is covered (cookie banner, modal), the click is refused and the cover is named: deal with it first.

## How to drive a page
1. `navigate`, then `snapshot` to get refs. Refs change after the page changes: snapshot again after every click or navigation.
2. Prefer refs from the snapshot over guessing. Use `screenshot` when layout matters or the snapshot is unclear.
3. After a click or submit, confirm it worked: snapshot or get_text and look for the expected change.
4. Forms: type each field, then click the submit button (or type with submit=true in the last field).

## Logging in
- Never ask the user to tell you a password in chat, and never type one with `type`.
- Use `fill_secret` with the name of the saved login (e.g. `secret: "github"`) on the username and password fields. If no login is saved, ask the user to add one under Settings > Passwords, or to log in themselves in the browser panel.
- If you see a CAPTCHA or 2FA prompt, stop and ask the user to complete it in the browser panel.

## Things that always need the user's OK
Payments, checkout, typing credentials, account or security settings, and permanent deletes ask the user even in Bypass mode.
