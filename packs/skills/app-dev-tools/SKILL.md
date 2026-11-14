---
name: app-dev-tools
description: VS Code, Cursor and Xcode: open a file at a line, build/test/run with errors back, command palette.
source: you
uses: 0
category: Mac Apps
---

Editing code is the code tool's job (read, edit, run_tests); use the editors to show the user something, or to run what only the IDE can.

VS Code / Cursor (`app {app: "Visual Studio Code" | "Cursor"}`):
- `open {path, line?, column?}` jumps to the spot (command-line tool). For Cursor's agents use the cursor tool.
- `build` runs the default build task (⌘⇧B); `command {name: "Tasks: Run Task"}` runs a palette command (destructive ones like "Discard All Changes" always ask).
- Read output: `computer ui {app: "Code", query: "error"}` or a screenshot of the terminal panel (ctrl+` toggles it). Better: run the same command with run_command and read its output directly.

Xcode (`app {app: "Xcode"}`):
1. `open {path: "App.xcodeproj" or file, line?}`.
2. `schemes`, then `build {scheme?}` → status, errors with file:line, warnings count. `test` → failures. `run` launches; `stop`; `clean`.
3. Fix errors with the code tool, build again; stop when the build succeeds or report what's left.
- Headless alternative (no UI, often more reliable): run_command `xcodebuild -scheme X -destination 'platform=iOS Simulator,name=iPhone 16' build`.
- Signing/provisioning errors, "Trust this developer", keychain prompts: the user's.

Shortcuts (computer key): Xcode cmd+b build, cmd+r run, cmd+u test, cmd+. stop, cmd+shift+o open quickly, cmd+shift+k clean. VS Code cmd+p quick open, cmd+shift+p palette, ctrl+g go to line, cmd+shift+f search.
