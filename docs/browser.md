# Browser

The built-in browser is a real Chromium tab inside SahilBot with a persistent login session. The user can watch it in the right panel and take over at any time. The `browser` tool is always loaded; `sites` (what SahilBot learned about each website) loads with `find_tools("sites")`.

## The browser tool
One tool, `browser`, with an `action`:

| action | arguments | what it does |
|---|---|---|
| navigate | url | Open a URL in the current tab. Returns the top of the page, and for a known site a short "What I know about …" note |
| snapshot | full? | Accessibility tree of the page. Every clickable or typeable element gets a ref like `e12` (see "Reading a snapshot") |
| find | query | Elements matching a plain description ("the search box", "Export CSV button"), best first, with refs, anywhere on the page |
| extract | kind? (auto, table, list, cards), ref?, max? | Structured data as JSON: tables as rows by column, lists, product/result cards (title, price, link, rating), and where the next page is |
| expand | ref (g3), start? | The rest of a collapsed list or table |
| next_page | – | The next-page or "Load more" control as a ref, with "Page 2 of 7" when the page says so |
| click | ref | Click an element |
| type | ref, text, submit? | Type into a field (replaces its content). submit=true presses Enter |
| select | ref, option | Choose a dropdown option (the snapshot lists them) |
| fill_form | fields, submit_ref? | Fill several fields in one step, optionally click submit |
| dialog | accept, text? | Answer an alert/confirm/prompt the page opened |
| fill_secret | ref, secret, field | Type a saved login (username or password), or a saved ID's document number (field `id_number`), from the vault. You never see the value. If the vault is locked, the user is asked to unlock it |
| fill_otp | source, secret? | Type a one-time sign-in code (authenticator, email or SMS). You never see it; the user approves codes per site |
| wallet / fill_payment / fill_address | card / address | Saved cards and addresses by nickname; card fills go through a Purchase card |
| upload | ref, paths | Attach workspace files to a file field (asks first) |
| downloads | op (list, save), index? | Files pages offered; nothing is saved until the user approves |
| wait | text?, url?, timeout? | Wait for text, an address change, or the page to settle |
| scroll | direction, amount? or ref | Scroll the page, or an element into view |
| screenshot | – | Image of the visible page |
| get_text | – | Readable text of the page |
| tabs | op (list, new, switch, close), index?, text?, url? | Tabs with titles; switch or close by number or by part of the title or address (`text`) |
| recording | op (start, stop, status) | "Teach a task": record what the user does once |

## Reading a snapshot
- The header names the page, any open dialog, and card fields. Long pages add an **Outline** (landmarks: banner, navigation, main…) and **Headings** with ↑/↓ for those above or below the visible area.
- **Viewport first**: on a long page the lines around the visible area are shown; what's above and below is one line each, with counts ("… 210 more lines below (53 links, 52 buttons)"). Use `find`, scroll, or `snapshot {full: true}` for the rest. Refs exist for the whole page either way.
- **Collapsed lists**: a list, table or menu with more than 12 items shows its first 5 and `- … 35 more items in list "Orders" [expand=g2]`. `expand {ref: "g2"}` shows the rest; `extract {ref: "g2"}` reads them as data.
- **Forms**: forms with 5 or more fields (or any required or invalid one) get a summary line: fields by label, `*` required, `!` invalid, card / password / dropdown, how many are filled, and the submit button's ref. Values are never shown.
- **Frames**: embedded frames are listed by host (payment providers marked); their content isn't in the snapshot.
- `*` marks elements that appeared since the previous snapshot (a menu that opened). "clickable" elements react to clicks without being real buttons.

## Reading results
- Every click and submit reports what happened: "Navigated to … (title)", "The page changed", "No visible change", a new tab (in the background while SahilBot acts), a dialog it answered Cancel, or a download the page offered. Believe it: if nothing changed, the click didn't do what you wanted.
- Clicks scroll the element into view. If something covers it (a sticky bar, a toast), it waits a moment, centers the element and tries once more; if it's still covered the click is refused and the cover is named.
- A ref that went stale (the page re-rendered) is found again by role and name with a fresh snapshot; the result says so. If several elements match, it says that instead of guessing.

## How to drive a page
1. `navigate` (it already returns the top of the page). Act by ref; snapshot again after the page changes.
2. Looking for one thing on a big page? `find {query}` instead of scrolling and snapshotting.
3. Reading data (results, orders, prices, tables)? `extract` instead of get_text or many snapshots. Multi-page lists: `extract`, click the next-page ref it gives, `extract` again.
4. Forms: `fill_form` with all fields and the submit ref in one step.
5. After a submit, confirm it worked (the outcome line, or get_text).

## Site playbooks: learning websites over time
SahilBot keeps a playbook per website (per registrable domain, by the Public Suffix List): what it's for, how sign-in works (which saved login, single sign-on, the second step), named pages and how to reach them, element locators by role and accessible name (never CSS), flows that worked with dates and success counts, pitfalls (cookie banners, popups, covered buttons, human checks, rate limits, "use the export button instead of reading the page"), and when it last worked.
- **Learning is automatic and needs no model**: when a run finishes, the browser calls it made on each site are folded into that site's playbook. The sign-in part and the task part become separate flows; a flow counts a success only when the run finished and its last step worked; a failed attempt counts a failure. Pitfalls are learned from failures too. A Teach recording becomes a flow "shown by the user".
- **What's never stored**: typed values (only "Type the text into textbox "Message""), passwords, codes, card numbers, emails, phone numbers, long numbers, query strings, and any label that reads like an instruction ("ignore previous instructions…"). Saved passwords, cards and recent codes are checked against everything stored. Page text never becomes a step: steps come only from the agent's own actions.
- **When it's used**: the first time a run opens a known site, the navigate result carries a compact "What I know about <site>" note inside the page's untrusted block. They're hints from past runs: check them against the live page.
- **The sites tool**: `list`, `get {domain}`, `edit {domain, purpose, notes, add_pitfall, remove_pitfall, add_flow, remove_flow, login}`, `forget {domain}`. After a run has read web pages, an edit that writes text asks the user first, so a page can't plant steps.
- Playbooks live as JSON files in the data folder's `sites` folder.

## The user's own Safari or Chrome
- Prefer SahilBot's browser for websites: it has saved logins, forms in one step, purchase cards and playbooks.
- Use the user's real browser when they ask for it or need a session only it has: read with `app {app: "Safari", action: "read_page"}`, act with `computer ui {app: "Safari", query}` refs (`click_ref`, `type_ref`). Passwords, codes and cards are always the user's there.
- When SahilBot's browser already knows the site (or is signed in there), read_page says so: offer to do it in SahilBot's browser panel instead.

## Logging in
- Never ask the user to tell you a password in chat, and never type one with `type`.
- Use `fill_secret` with the name of the saved login (e.g. `secret: "github"`) on the username and password fields. If no login is saved, ask the user to add one under Settings > Vault, or to log in themselves in the browser panel. It is only typed on the login's own site, over HTTPS, into a real visible field, after the user approves; if the vault is locked SahilBot asks the user to unlock it (Touch ID or master password). If they don't, stop and tell them.
- Two-step codes: `fill_otp`. CAPTCHAs and "are you human" checks are always the user's: the browser hands them over.

## Things that always need the user's OK
Payments, checkout, typing credentials, one-time codes, account or security settings, and permanent deletes ask the user even in Bypass mode. A purchase goes through the Purchase card however its button was found (snapshot, find or a playbook).
