---
name: app-finder
description: Finder recipes: open, reveal, selection, new folder, move/rename/copy safely, copy paths, Trash.
source: you
uses: 0
category: Mac Apps
---

Prefer the file tools (file_read, file_write, file_manage) for file contents and workspace changes. Use `app {app: "Finder"}` when the user is working in Finder or wants things shown there.

Actions (app_help {app: "Finder"}):
- What the user means by "this file" / "these": `selection` (paths of the selected items) or `front_folder` (the open window's folder).
- `open {path, with?}`: default app or a named one ("Preview"). Opening apps, scripts or installers always asks.
- `reveal {paths}`: show items selected in a Finder window (good after creating or exporting a file).
- `new_folder {in, name}`; `move {paths, to}`; `copy {paths, to}`; `rename {path, name}` (keep the extension unless asked).
- `copy_paths {paths?}`: put paths on the clipboard (selection by default).
- `trash {paths}`: always asks; tell the user it can be restored from the Trash. Never empty the Trash.

Safety:
- Inside the workspace or the chat's attached folders, moves/renames/copies that replace nothing are routine. Anything outside, or that would replace an item, asks first. Move and copy refuse to replace same-named items: rename first or ask.
- Before bulk moves, list the plan (what goes where) and get a yes.
- After a change, verify: `selection` / `front_folder`, or file tools to list the folder.

Computer use fallbacks (Finder UI): cmd+shift+g Go to Folder (paste a path, Return); cmd+n new window; cmd+1/2/3/4 views; space Quick Look; cmd+i Get Info; cmd+delete moves to Trash (asks).
