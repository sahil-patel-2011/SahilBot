# Foreman

A macOS desktop AI assistant that runs on your own local models (Ollama or any OpenAI-compatible server). It can chat, work as an agent with tools, and drive a built-in browser.

## Run

```bash
npm install
npm run dev          # development, hot reload
npm start            # run the built app
npm test             # unit tests
npm run test:accept  # acceptance tests: drives the real app against a mock model
```

Foreman expects a model server at `http://localhost:11434/v1` (Ollama). Change it in Settings (⌘,).

## Release

```bash
npm run voice:setup   # once: builds whisper.cpp (Metal) and fetches voice models
npm run dist          # Foreman-<version>-arm64.dmg and .zip in dist/
```

The app ships with its own icon (`build/icon.icns`, source `build/icon.svg`), hardened runtime and entitlements (`build/entitlements.mac.plist`), and a microphone usage string. To distribute outside your own Mac, sign and notarize with an Apple Developer ID: set `CSC_LINK`/`CSC_KEY_PASSWORD` (or have the certificate in your keychain) and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, then run `npm run dist`. Without them the build is unsigned and macOS will warn on first open.

## Layout

| Path | What |
|---|---|
| `src/main/agent/` | Agent loop, context manager (compaction, result offload), permissions, schema repair, tools |
| `src/main/browser/` | Built-in browser: WebContentsView tabs driven over the DevTools Protocol |
| `src/main/llm/` | OpenAI-compatible streaming client, model catalog and RAM gating |
| `src/main/vault.ts` | Saved logins (Keychain-encrypted, never shown to the model) |
| `src/renderer/` | React UI |
| `docs/` | The model's own manual, read with `file_read("docs/…")` |
| `tests/` | `unit/`, `accept/` (Playwright + Electron), `fixtures/` (mock model, test site) |

## Research

`research/` holds notes on OpenClaw, Hermes Agent, Goose, OpenHands, Cline, opencode, browser-use, Letta, smolagents, Aider and Jan, and what Foreman borrowed. Credits are in `THIRD_PARTY_NOTICES.md`.

## Data

Everything lives in `~/Library/Application Support/Foreman` (SQLite DB, Space prompts at `spaces/<id>/system.md`, offloaded tool results, browser profile). Set `FOREMAN_DATA_DIR` to use another folder. No telemetry.

## Status

- [x] Phase 1: shell, streaming chat, model selector, SQLite persistence
- [x] Phase 2: agent loop, context management, permission modes, memory, model docs
- [x] Phase 3: browser pane, browser tools, password vault
- [x] Phase 4: MCP connectors (OAuth sign-in or local command) and web search (tested with a local MCP server; real Gmail/Semrush need your sign-in)
- [x] Extra: bots and group chats, reactions, grouped tool steps, Progress panel, file/folder attachments, PDF/DOCX/PPTX/XLSX create and preview, onboarding, provider presets (Ollama, LM Studio, Claude, OpenAI, OpenRouter)
- [x] Phase 5: voice (local Whisper + Silero + Kokoro; ~1.0 s end of speech → first audio on an M5 Pro with a fast model)
- [x] Phase 6: documents, scheduled tasks, Projects
- [x] Research-first answers with cited sources and a check for invented links; keyless web search
- [x] Connector library (55 verified MCP servers), browser outcome reporting, safe page dialogs
- [x] Cloud spending cap (Settings > Cloud budget, default $200/month)
- [x] Native Claude support via the Anthropic SDK (prompt caching, adaptive thinking, refusal fallbacks, append-only history)
- [x] One-click connecting from chat, no-setup browser apps, and first-run auto-detection of local models

Voice setup (once): `npm run voice:setup` builds whisper.cpp with Metal and downloads the models.
