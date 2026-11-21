# SahilBot

A private, local-first AI assistant for your Mac. SahilBot chats, researches medical questions from PubMed, guidelines and FDA labels (checking every paper it cites), keeps everything it learns in an Obsidian-style vault, works as an agent with tools (files, documents, the built-in browser, your Mac's apps, connectors), talks with you by voice, and runs on models on your own Mac through Ollama or LM Studio. You can also add Claude, ChatGPT or OpenRouter with your own API key.

## Quick install

Open **Terminal** on your Mac (⌘-Space, type *Terminal*, press Return), paste this, and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/sahil-patel-2011/SahilBot/main/install.sh | bash
```

That's it. It downloads the newest SahilBot, puts it in Applications, and opens it, with no "can't be opened" warning and no password. Paste the same command again any time to update. You can [read the script](install.sh) first.

**Already downloaded the DMG?** Drag SahilBot to Applications, then paste this in Terminal once, and it opens normally from then on:

```bash
xattr -dr com.apple.quarantine /Applications/SahilBot.app
```

(Put it in the Applications folder inside your home folder? Use `~/Applications/SahilBot.app` instead.)

## Download

<p>
  <a href="https://github.com/sahil-patel-2011/SahilBot/releases/latest/download/SahilBot-mac-arm64.dmg"><b>⬇ Download SahilBot for Mac (Apple Silicon)</b></a>
</p>

https://github.com/sahil-patel-2011/SahilBot/releases/latest/download/SahilBot-mac-arm64.dmg

This link always gets the newest build. Every push to `main` builds and publishes one ([Releases](https://github.com/sahil-patel-2011/SahilBot/releases) keeps every earlier build). A `.zip` of the app is there too: [SahilBot-mac-arm64.zip](https://github.com/sahil-patel-2011/SahilBot/releases/latest/download/SahilBot-mac-arm64.zip).

> **Anyone can download it.** The repository is public, so the link works without a GitHub account or sign-in. Share it with anyone who has an Apple Silicon Mac.

## Requirements

- A Mac with Apple Silicon (M1 or newer). Intel Macs aren't supported.
- macOS 13 Ventura or later.
- For local models: memory decides which models fit. 8–16 GB runs the small fast ones, 24 GB+ handles everyday agent work, and 48–64 GB runs the strongest local models (Qwen3.8 27B, Qwen3.6 35B-A3B) with a 64k context. Each model needs 2–25 GB of disk space.

## Install

1. Open `SahilBot-mac-arm64.dmg` and drag **SahilBot** to **Applications**.
   - No admin rights? Drag it to the **Applications** folder inside your home folder (`~/Applications`; create it if it isn't there). Spotlight and Launchpad find it there too.
2. Open SahilBot.

**First launch, when the build isn't notarized.** Builds made without an Apple Developer ID are signed ad hoc, so macOS blocks the first open of a DMG or zip downloaded in a browser. The release notes say which kind each build is. The [Quick install](#quick-install) command avoids this. Otherwise, to open it:

- macOS 13–14: right-click (or Control-click) SahilBot in Applications → **Open** → **Open**.
- macOS 15 or later: double-click it once, close the warning, then go to System Settings → Privacy & Security and click **Open Anyway** next to SahilBot.
- Or in Terminal: `xattr -dr com.apple.quarantine /Applications/SahilBot.app` (or `~/Applications/SahilBot.app`).

After that it opens normally. Notarized builds open with a plain double-click.

## Phone access (preview)

SahilBot is a desktop app first: phone access and the always-on server stay out of Settings until you turn on Developer mode (Settings → Advanced) or have already set one up.

Use SahilBot from your phone: check on bots, answer approvals and questions, and chat, with notifications. Turn
it on in **Settings → General → Phone access** and scan the QR code with your phone. The phone connects straight
to your Mac over your Wi-Fi, or over [Tailscale](https://tailscale.com/download) when you're away. There's no
account, no cloud relay and no port forwarding. Purchases, one-time codes and saved passwords stay on the Mac.
See [docs/phone-access.md](docs/phone-access.md).

## Always-on server (Raspberry Pi, VM, Mac mini)

SahilBot Server runs your bots 24/7: routines, goals and connectors keep working while your Mac is closed or you're traveling. You use it from your phone or any browser (the same app), or from the Mac app (Settings → Always-on server). On a **Raspberry Pi 5** (8 GB recommended, 4 GB minimum, 64-bit Raspberry Pi OS, an SSD and the active cooler), setup takes about five minutes:

```sh
curl -fsSLO https://github.com/sahil-patel-2011/SahilBot/releases/latest/download/SahilBot-server-linux-arm64.tar.gz
tar -xzf SahilBot-server-linux-arm64.tar.gz
./sahilbot-server/install.sh          # Node.js if needed, a service that starts at boot, a pairing code
sudo tailscale serve --bg 8787        # HTTPS on your tailnet: open https://<pi>.<tailnet>.ts.net on your phone
```

It listens only on `127.0.0.1` by default. Every device pairs once with a one-time code and remote approvals are logged. A worker can use cloud models, your ChatGPT plan through Codex, and a background text browser for public pages. The Mac app supports interactive browser sessions, computer use, Mac apps and voice.

**Settings → Always-on server → Worker machines** pairs multiple servers. Give each Pi or VM a bot slot count and use **Bot placement** to move bots between them or bring them back to the Mac. See [server setup and placement](docs/server.md#assign-bots-to-worker-machines).

## Local models (Ollama)

SahilBot runs models on your Mac through [Ollama](https://ollama.com) (or [LM Studio](https://lmstudio.ai)).

1. **Easiest:** on first launch SahilBot offers to set up Ollama for you. It downloads Ollama from its official GitHub release, checks the download's SHA-256, Apple's notarization and Ollama's signature, and runs it in the background. No Terminal, no admin password.
2. **Or install it yourself:** get Ollama from [ollama.com/download](https://ollama.com/download) (or `brew install ollama`) and open it once.
3. **Download models:** Settings → Models → *Recommended for this Mac* lists the best models that fit your Mac's memory, with sizes and a **Download** button (and **Delete** to free up disk space). The setup screen picks three for you: the strongest agent model, a fast one for quick chats and voice, and an alternative.
4. **Auto** (the default in the model picker) sends each message to the right model: a fast one for small talk, a stronger one for real tasks.

The model picker only lists models you can actually use: models downloaded in Ollama, models loaded in LM Studio or served by your own server, and cloud models whose API key you've saved. Models you haven't downloaded yet are in Settings → Models.

Already use LM Studio or another OpenAI-compatible server? Turn it on under Settings → API Keys & Servers. In LM Studio, MLX builds of a model are preferred over GGUF ones: they're faster on Apple Silicon.

**Cloud models (optional):** add an Anthropic, OpenAI or OpenRouter key under Settings → API Keys & Servers. Cloud spending is capped by a monthly budget (Settings → Cloud budget, $200 by default).

## Privacy

- With local models, your chats, files and voice never leave your Mac.
- Voice: speech recognition (Whisper) and speech (Kokoro) run on this Mac. Audio is never sent anywhere.
- Cloud models only get what you send them, and only when you've added a key and picked (or let Auto pick) a cloud model.
- API keys and saved logins are encrypted with your macOS Keychain and are never shown to the model.
- **Backups:** every day SahilBot copies everything (chats, settings, memories, your decisions, your knowledge vault notes and your API keys, encrypted) to two folders separate from where it runs, plus an extra folder you can pick, like an external drive. Set a recovery password in Settings → Privacy & Security → Backups and your keys can be restored on any Mac. See [docs/backups.md](docs/backups.md).
- No telemetry and no analytics. Everything is stored in `~/Library/Application Support/Foreman` (SQLite database, bot prompts, browser profile). Delete that folder to reset SahilBot.
- SahilBot asks before actions that send, buy, post or delete; you choose how much it may do on its own per chat (permission modes).
- **Hybrid compute** (opt-in, Settings → Privacy & Security; 32 GB memory and 50 GB free disk minimum, 64 GB and 150 GB for the top local models): cloud models plan and research while personal details stay on your Mac. The Privacy Gate checks every cloud request on your Mac with [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer). Names, contact details, account numbers and documents like bank statements or bills pause the chat until you choose: process on your Mac, let the cloud work with stand-ins, share, or skip. See [docs/privacy-gate.md](docs/privacy-gate.md).

## Develop

```bash
npm install
npm run dev          # development, hot reload
npm start            # run the built app
npm test             # tests (unit: npx vitest run tests/unit)
npm run voice:setup  # once: builds whisper.cpp (Metal) and fetches the voice models
npm run install:mac  # build and install into /Applications (or ~/Applications) on this Mac
npm run build && npm run build:server && node out/server/index.js --data /tmp/x   # SahilBot Server (docs/server.md)
npx vitest run --config vitest.server.config.mts   # server tests: in-process, load, web UI in headless Chromium
```

SahilBot expects Ollama at `http://localhost:11434/v1`; change servers in Settings (⌘,).

### Releases

`.github/workflows/release.yml` runs on every push to `main` (and by hand from the Actions tab) on GitHub's Apple Silicon runner: `npm ci`, builds `whisper-server` (cached, `scripts/ci-whisper.sh`), typecheck, unit tests, `electron-vite build`, then `electron-builder --mac dmg zip --arm64`. `scripts/release.mjs` publishes:

- `v<version>-<run number>`: a versioned release, marked **Latest**, with the versioned files and the stable names `SahilBot-mac-arm64.dmg` / `SahilBot-mac-arm64.zip` plus `SHA256SUMS.txt`. GitHub's `/releases/latest/download/<file>` always resolves to the newest non-prerelease release, so the download link above always gets the newest build.
- `latest`: a rolling prerelease with only the stable names, moved to the newest commit.
- SahilBot Server: a Linux job builds `SahilBot-server-linux-arm64.tar.gz` and `SahilBot-server-linux-x64.tar.gz` (`scripts/server/package.mjs`), smoke-tests the x64 one, and they're published next to the DMG with the same stable and versioned names.

Signing: add the repository secrets `CSC_LINK` (Developer ID Application certificate, `.p12` as base64) and `CSC_KEY_PASSWORD` to sign with your Developer ID, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to notarize too. Without them builds are signed ad hoc (see *First launch* above). The version is `package.json`'s; the run number is the build number (`CFBundleVersion`).

### Layout

| Path | What |
|---|---|
| `src/main/agent/` | Agent loop, context manager (compaction, result offload), permissions, schema repair, tools |
| `src/main/browser/` | Built-in browser: WebContentsView tabs driven over the DevTools Protocol |
| `src/main/llm/` | Model servers, streaming clients (OpenAI-compatible and Anthropic), model catalog, RAM fit, Auto routing |
| `src/main/vault.ts` | Saved logins (Keychain-encrypted, never shown to the model) |
| `src/renderer/` | React UI |
| `docs/` | The model's own manual, read with `file_read("docs/…")` |
| `tests/` | `unit/`, `accept/` (Playwright + Electron), `fixtures/` (mock model, test site) |

Research notes on other agents (OpenClaw, Hermes Agent, Goose, OpenHands, Cline, opencode, browser-use, Letta, smolagents, Aider, Jan) are in `research/`; credits are in `THIRD_PARTY_NOTICES.md`.

## License

SahilBot is released under the [MIT License](LICENSE): anyone may use, copy, change and share it. Third-party code it builds on is credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
