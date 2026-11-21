# Changelog

Every SahilBot update, newest first. The same notes show in the app (Settings → Updates → What's new) and on each GitHub release. Versions are dates (YY.MM.DD).

## 26.11.21 · Medical research you can trust, a cleaner look, and keys that stay put

_2026-11-21_

- **API keys no longer disappear when macOS Keychain is slow or still locked, and a backup copy of the key brings them back if it's deleted**
- **Medical answers come from PubMed, guidelines and FDA labels, and every cited paper is checked before you see the answer**
- **Everything SahilBot remembers, including your decisions, is now organized in your vault like Obsidian**
- **A copy of everything (data, memories, vault notes and your keys, encrypted) goes to a separate backup folder every day**
- **A cleaner sidebar, home screen and Settings, with fewer buttons**
- **Auto now recognizes medical, travel, business, engineering and coding-agent requests and sends each to the right model and tools**
- **Maps and travel: places, directions, travel times and things to do, with Google Maps links (a Google Maps key is optional)**
- **SahilBot reads its own manual when it isn't sure how to do something, with new pages on business, engineering and coding agents**
- **Talk to a bot and it goes off to do the work while you keep talking, then tells you out loud when it's done**
- **Voices are ChatGPT's or Grok's: pick one, its speed and your language right in the voice bar**
- **Click or hold ⌘D to dictate**
- **Decks and documents keep tables, web pictures and charts in every export**
- **The agent catches more false "done" claims and gives up less**
- **The Privacy Gate is out of beta, and your server can use your Mac safely**

### Your keys stay put

- The real cause of keys vanishing is fixed: when macOS Keychain didn't answer in time (still locked after login, a slow prompt), SahilBot made a new encryption key and saved keys became unreadable. Now it only makes a new key when the Keychain truly has none, and never overwrites one
- A second Keychain item keeps a backup copy of the encryption key, so a deleted key is restored instead of replaced
- If the Keychain is locked, Settings → Models & Keys says your keys are locked, not lost, with a Retry button. Don't re-enter them
- A key you type while the Keychain is locked is no longer stored the old way that broke on the next update: you're asked to unlock and try again

### Medical research

- PubMed searches can filter by evidence (guidelines, systematic reviews, meta-analyses, randomized trials) and date, and every result shows its evidence level
- Retracted papers and expressions of concern are flagged
- New sources: MeSH headings, Europe PMC (preprints marked as not peer reviewed, citation counts), open-access full text, FDA adverse event reports and MedlinePlus
- Before a medical answer reaches you, SahilBot checks it: every cited PMID, DOI and trial ID must come from what it actually read, must exist in PubMed and must not be retracted. A clinical answer with no research behind it is sent back to check the evidence first
- PubMed & medical sources is listed under Connect apps → Built in. No sign-in. An optional free NCBI key (Settings → Keys for tools) makes big research jobs faster

### Your vault, organized like Obsidian

- Every memory is mirrored into the vault as linked notes: Shared/Memory has one note per category (About you, Preferences, People, Places, Projects…) with links to people and project notes
- Your decisions get their own Decision log (Shared/Decisions), newest first and grouped by month, with what you chose over what
- A bot's own memories go to that bot's area only. Text you write around the mirrored part is kept, every change can be undone, and secrets are never written
- Vault is in the sidebar now (it was only in ⌘K)

### A copy of everything, in a separate place

- The daily backup now includes your knowledge vault notes and a readable export of your memories and decisions
- Set a recovery password (Settings → Privacy & Security → Backups) and each backup also holds your API keys, encrypted with it, so you can restore them on any Mac
- Back up now, see the last backup, open both backup folders, or add an extra folder such as an external drive

### Simpler to use

- The sidebar has one New chat button, then Needs you, Vault, Artifacts and Brain, then your bots, projects and recent chats as quiet single rows
- Home puts the message box first, with four suggestions and a small bot card below it
- The browser and side-panel buttons only show in a chat, where they do something
- Settings is one short list with no "More settings" fold. Phone & server pages only show once you've turned one on: SahilBot is a desktop app first
- The "no model yet" notice is a clear card with Add a key and Retry buttons

### Auto, sharper on your kind of work

- Clinical questions (doses, drug interactions, lab results, warning signs) go to the strongest model with the medical sources; a simple definition stays quick
- Literature questions (meta-analyses, trials, guidelines, PMIDs, FDA labels) run as deep research
- Handing work to Cursor, Codex or Claude Code runs as coding work and loads the Cursor, code and git tools; several agents at once or a repo-wide change gets the strongest model
- Directions and "near me" are quick live lookups; comparing several places runs as research with maps; booking a table, room or flight is treated as a booking
- Engineering calculations (deflection, stress, torque) are worked as math, not CAD
- Measured on 40 new requests across these areas: the right kind of work went from 67.5% to 100%, and no task runs as a plain chat any more

### Maps and travel

- Search places, get details, directions (driving, walking, cycling, transit), travel times between several places, and what's nearby (restaurants, sights, pharmacies, urgent care, EV charging and more)
- Every answer has Google Maps links you can click. Without a key SahilBot uses OpenStreetMap; with a Google Maps key (Settings → Keys for tools) it uses Google's places and routes, including transit
- Trip planning groups sights by area, checks travel times and gives one route link per day; new idea skills cover business, engineering, trips and local places
- Maps & travel is listed under Connect apps → Built in

### SahilBot's own manual

- When SahilBot isn't sure how a feature or tool works, it searches its manual before guessing or asking you
- New pages: business (models, decks, research, recurring work), engineering (CAD, calculations, electronics, FRC, software) and coding agents (when to hand off to Cursor, writing the brief, reviewing the result)
- The tools page now lists every tool SahilBot has

### Bots you can talk to

- In a voice chat, real work (research, a document, files, email, the browser) runs in the background in the bot's own chat, and the conversation keeps going
- When the work finishes, the bot says the result in the next pause, if voice is still open. Ask follow-up questions about it right away
- If the work needs your OK, the bot says so and the card shows on the voice screen. You tap to approve: a misheard "yes" never sends or buys anything
- Voice is a bar at the top of the chat you're in, opened from the voice button in the message box: settings, transcript, mute and hang up
- Pick a voice (hear each one first), the speaking speed and the language you speak
- When you hang up, the conversation folds into one line named after what you talked about, with its length. Open it to read the transcript. What you said is remembered like anything you type
- The voice bar lists what's running, what needs you and what's done
- A new bot sets itself up with you in its chat, typed or by voice: it asks what you want done, suggests a name, writes its own instructions, and saves them when you agree
- Spoken replies use cloud voices for speed and quality: ChatGPT's (OpenAI) or Grok's (xAI). Switch between them in the voice bar, even mid-conversation
- Dictate with the microphone button: click to start and stop, or hold ⌘D and let go when you're done
- First run ends with "Your first bot": how bots work in three short cards, then your first bot opens ready to set up

### Your iPhone, a server and your Mac

- Run your bots around the clock on a small cloud server (DigitalOcean's 4 GB Droplet is about $24 a month) and use them from your iPhone as a Home Screen app
- The server can use your Mac. At first it can only find and read your files. You can turn on Terminal, Messages, Mail, Notes, Calendar, the browser and the screen. Anything that changes something asks you first
- Only the Mac you linked can take work from the server. Your Mac limits how fast the server can act and logs what it did
- Your Mac connects out to the server, so nothing on your Mac is opened to the internet
- Keep this Mac awake: while it's plugged in, your phone can always reach it (the display still turns off)
- Setup steps are in the server guide (docs/server.md)
- Keys, login items, mail and SahilBot's own data on your Mac are never reachable from the server, however a path is written
- An action the server sends runs once, even if the connection hiccups; turning the link off stops it at once
- Only your Mac can turn the link on or off

### Agent loop

- When a tool fails and the agent starts to give up, it's sent to try another source or approach first, and it says plainly what blocked it if nothing works
- A reply that says something was saved, sent or published when no tool ran gets challenged: it does it, or says it wasn't done
- If a send times out, SahilBot won't repeat it (or ask you to approve a repeat) until the agent checks whether it already went through
- After a code edit, the project's tests run right away on fast suites, so a wrong fix is caught before it's announced
- A job that says it's still building gets a single wait instead of a tight polling loop
- Project instructions in AGENTS.md (or CLAUDE.md / GROK.md) from your folder up to the repo root go into the agent's context, like Codex
- If you set a limit ("under $200"), what the agent picks is checked against it, and it fixes a choice that's over
- It reads every page of a paged result before answering, instead of stopping at page 1
- A write that fails outright (bad input, no permission) no longer counts as "may have happened", so a corrected retry goes straight through
- When the agent sees a better way or the obvious next step, it offers it as an idea card with "Do it". It never starts the idea on its own
- It won't say "I can't access that" without trying the tools it has, and after a second failure it lists other ways and tries the best one
- It reads curly apostrophes (I’ve, couldn’t) like straight ones, so its checks for false "done" claims and giving up always work
- A reply the app sends back (it said it was done but wasn't, or gave up) is replaced by the next one instead of staying in the chat
- Fewer false alarms on budgets ("under $2 million"), totals and fees, and on results that have no more pages

### Slides, documents and dashboards

- Chart slides: a chart block on a slide draws in the deck's colors and exports to PowerPoint as a native chart you can edit
- Share tables (Channel / Share) draw as donut charts on slides and dashboards
- A deck check after the agent makes or exports a deck: too many points, long lines, missing or long titles get fixed before you see it
- Documents show their word count and reading time next to the save state
- Typing fast on a slide (Tab, Enter, then straight on) never drops a keystroke or undoes the step before
- Tables on slides export to PowerPoint as real, editable tables
- Pictures from the web are saved into your workspace, and WebP and iPhone (HEIC) pictures work in every export
- Charts written as CSV work in documents too, not only in decks
- If an export had to leave something out (a missing picture, text cut to fit), the bot tells you
- Image captions are kept, italics no longer catch maths like 5 * 3, and long tables get a warning

### Privacy Gate, out of beta

- Protect automatically (Settings → Hybrid compute): personal details get stand-ins for cloud models without pausing the chat, and a note says what was protected
- Anything you mark "not personal" is remembered for every chat (never passwords, keys or account numbers), and Forget clears the list
- See what the gate did today: requests checked, times it asked, details protected, and finds the model on your Mac cleared
- PII-Tracer tests itself after the download, and restarts on its own if it stops mid-check

### Simpler Settings

- Five main pages up front (General, Models, Connected apps, Privacy, Phone & server), with everything else under More settings. Search still finds every setting

### Fixes

- API keys and other secrets are now sealed with SahilBot's own Keychain key, which stays the same across updates, so an update never asks you to enter them again
- Keys saved before this update are moved over the first time they're read. If macOS asks whether "security" may use "SahilBot Safe Storage", enter your Mac password and choose Always Allow; your keys come back. If you choose Deny, they're kept, and you can allow it later

### Coming next

- Accounts with Google sign-in, so several people can share one server privately
- Your own checks that run before a bot says it's done (like Claude Code's hooks)
- Picking up a long task exactly where it stopped after a crash or restart
- Brand themes for decks and documents (your colors, font and logo), plus two-column and quote slides
- Approving the server's actions on your Mac itself, for the most sensitive tools

## 26.11.20 · Native decks, documents and dashboards, a smarter Auto, and Hybrid compute

_2026-11-20_

- **Make slides, documents, dashboards and sheets right in SahilBot, edit them with your agent, and export to PowerPoint, Keynote/ODP, PDF, Word or images**
- **Hybrid compute: personal details stay on your Mac while cloud models do the heavy lifting**
- **Auto picks models from benchmark results for each kind of task, and pulls in a second model when two are better than one**
- **Updates show their size, keep one copy of SahilBot installed, and back up your data in two places first**

### Slides, documents and dashboards

- New slide editor: click any text on a slide to type, add, duplicate and reorder slides, add big numbers, pictures and speaker notes, and present full screen
- Slides look the same everywhere: the editor, Present, PDF, PNG and PowerPoint (pictures) are drawn by one renderer
- Export a deck as editable PowerPoint, PowerPoint with exact fonts, OpenDocument (Keynote, LibreOffice, Google Slides), PDF or PNG images
- New native dashboards: stat tiles, charts drawn from your tables, sections and notes
- Artifacts page: start a Doc, Deck, Sheet or Dashboard in one click, and see the documents you're working on
- Your agent now makes editable documents first and exports a PDF, Word or PowerPoint file when you want one
- Open Word, PDF, PowerPoint, Excel and CSV files in the editor, change fonts and text, and save back to the original
- Presenter view: your notes, the next slide and a timer while you present (press P)
- Native sheets work out IF, SUMIF, VLOOKUP, XLOOKUP, text and date functions
- Tables, numbered lists and checklists on a slide are kept when you edit it, and slides show their tables

### A more capable agent

- Shows its plan as a live checklist and keeps it current as it works, so you can see where it is
- Does what it says it will do, keeps going until the task is finished, and runs your tests until they pass after code changes
- Says so plainly when it disagrees, and gives its reasons and the approach it would take
- Remembers what you've said in your other chats with the same bot (only your own words), so answers fit you better
- Plans and makes videos end to end: research, brief, shot list and the right platform at its best settings
- Waits for you to sign in or type a code in the browser, then carries on by itself
- Paste an API key or password into the chat and it goes straight into your vault

### Chat

- Type / in the message box for commands: /new, /doc, /deck, /dashboard, /sheet, /research, /max, /plan, /voice, /artifacts, /settings, /whatsnew
- Code in replies is syntax-colored; wide tables scroll and copy straight into Numbers or Excel
- Inline citations like [1] link to their sources, numbered the same as the source chips
- Press ↑ in an empty message box to edit your last message
- Errors are in plain words with the next step, with the details a click away
- If a message fails to send, your text comes back into the box

### Auto model routing

- Each kind of task has its own model order, taken from published benchmarks: Opus 5.5, Sonnet 5.5 and GPT-6.2 Sol for daily work, GPT-6.2 Astra and Fable 5.2 for the hardest problems, Haiku 5.5 and GPT-6.1 Terra for quick ones, and GPT-6 Luna for a quick hello
- Harder tasks get a stronger model, or two models working together when that's better
- Context carries over perfectly when the model changes mid-chat

### Privacy and Hybrid compute

- Hybrid compute on Macs with at least 32 GB of memory and 50 GB free (64 GB and 150 GB are best)
- A local Privacy Gate (PII-Tracer) checks each cloud request on your Mac and asks before personal details leave it
- Choose to process on your Mac, split the work (the cloud plans, your Mac keeps the details), share, or skip

### Everyday polish

- What you type and don't send stays in the box, even after you quit or update. Sending or clearing it forgets it
- Updates show how big they are, back up your data in two folders first, and remove the old version once the new one runs cleanly (it rolls back if the new one fails to start)
- Checks for updates every 5 minutes and when your Mac wakes
- More one-click connectors, including Cloudflare, Vimeo, Semrush, HeyGen and Higgsfield
- Mac notifications are on by default. Built-in skills are grouped as Medical, Office, Engineering and Health
- MIT License and a one-command Quick install in the README
- Keyboard focus stays inside dialogs and returns where you were, and animations respect Reduce motion

## 26.11.19 · Better Auto routing and teamwork between bots

_2026-11-19_

- **Auto routing picks better models and lets bots work together**
- **Bots work more quietly on their own**

### Auto and bots

- Auto routing chooses models more accurately for each request
- Bots can hand work to each other and collaborate on a task
- Work can run on the best place available (this Mac, a server or the cloud)
- Bots that run on their own interrupt you less
