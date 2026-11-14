---
name: office-batch-files
description: Rename, sort, convert or archive many files in a folder safely: preview plan first, apply with approval, never delete.
source: you
uses: 0
category: Office
---

Use the office tool's batch action (find_tools("office")). The folder must be in the workspace or attached by the user.

1. Look first: file_read the folder listing so you know what's there.
2. Dry run: office batch(dir, op, match?, recursive?, …). It returns a numbered plan and changes nothing.
   - rename: pattern "{date} {name}{ext}" (tokens {name} {ext} {n} {date} {created} {year} {month} {parent}), or find + replace (regex), or case: lower|upper|title|kebab|snake. start / order: "date" control {n}.
   - sort: by type (PDFs, Images, Documents, Spreadsheets, Presentations, Audio, Video, Archives, Code, Other) | extension | year | month | first_letter | size.
   - convert: to pdf|docx|xlsx|csv|md|txt (md/txt→docx/pdf, csv→xlsx, xlsx→csv, docx→md/txt/pdf, pptx→md/txt, pdf→txt, png/jpg→pdf); archive_originals: true moves the originals to Archive afterwards.
   - archive: moves matching files (older_than_days?) into <dir>/Archive. This is how you "clean up": nothing is ever deleted.
3. Show the user the plan (counts and a few examples) and ask before applying, unless they already said to go ahead with exactly this.
4. Apply: office batch(plan_id). It refuses files changed since the plan, never overwrites (clashes get " (2)") and writes a log in .foreman/batches to undo by hand.
5. Report what changed and anything skipped or failed.

Never use run_command with rm/mv loops for this; deleting files is only ever file_manage delete (to the Trash, with the user's OK).
