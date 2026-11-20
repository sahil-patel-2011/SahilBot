# SahilBot Server

SahilBot Server runs your bots around the clock on a Raspberry Pi, a small VM, or a Mac mini. Routines fire on
schedule, bots work through their goals, connected apps keep syncing, and approvals and questions reach your
phone. You use it from any browser, including your phone while you travel, or from the Mac app.

It's the same SahilBot. The server runs the Mac app's main process (agent loop, tools, bots and spaces,
routines, memory, the knowledge base and notes vault, connectors, budget, providers) under plain Node.js.
Its web UI is the Mac app's own interface, served to the browser.

- [5-minute Raspberry Pi setup](#5-minute-raspberry-pi-setup)
- [What runs on the server, and what needs the Mac](#what-runs-where)
- [Design](#design)
- [Security](#security)
- [Sizing and limits on a Raspberry Pi](#sizing-and-limits)
- [Other installs: Docker, VM, Mac mini](#other-installs)
- [Command line](#command-line) · [Troubleshooting](#troubleshooting)

## 5-minute Raspberry Pi setup

**Recommended hardware:** a Raspberry Pi 5 with **8 GB** (4 GB is the minimum), **Raspberry Pi OS (64-bit)**
(Bookworm or later), an **SSD** (USB 3 or an NVMe HAT) or at least a good A2 microSD card, and the **active
cooler**. Use cloud models (Claude, OpenAI, OpenRouter) or your ChatGPT plan through Codex. Local models
aren't realistic on a Pi (see [limits](#sizing-and-limits)).

On the Pi (over SSH or in a terminal):

```sh
curl -fsSLO https://github.com/sahil-patel-2011/SahilBot/releases/latest/download/SahilBot-server-linux-arm64.tar.gz
tar -xzf SahilBot-server-linux-arm64.tar.gz
./sahilbot-server/install.sh
```

The installer does the following:

1. Checks the Pi: a 64-bit OS, the amount of RAM, and free disk space.
2. Uses your Node.js if it's 22.13 or newer. Otherwise it downloads the official Node 24 LTS for arm64 into
   `~/sahilbot-server/node` and checks it against nodejs.org's `SHASUMS256.txt`.
3. Installs SahilBot Server to `~/sahilbot-server`. Your data goes to `~/.local/share/sahilbot-server`.
4. Creates a **systemd user service** that starts at boot and restarts on failure. It also turns on
   `loginctl enable-linger`, so the service runs without anyone logged in. If that step needs sudo, the
   installer prints the command.
5. Prints a **pairing code** and the Tailscale command for the next step.

**Reach it from your phone and laptop anywhere.** Install [Tailscale](https://tailscale.com/download) on the Pi
and on your phone and laptop, signed in to the same account. Then run this once on the Pi:

```sh
sudo tailscale serve --bg 8787
```

Open `https://<pi-name>.<your-tailnet>.ts.net` on your phone, enter the pairing code, and you're in. To get
an app icon, use Share → Add to Home Screen on iPhone, or Install app in Chrome on Android. To get
notifications, go to Settings → Server → This device → Turn on. On iPhone, open SahilBot from the Home
Screen first: iOS only allows web notifications for Home Screen apps.

**From the Mac app:** go to Settings → Always-on server, enter the server's address and a code from
`sahilbot-server pair`, then choose Link. "Open server UI" opens the server's web app in your browser,
already signed in.

**Finish setup in the web UI:** Settings → API Keys & Servers (a Claude or OpenAI key), or Settings → Models
→ ChatGPT plan. Then create bots and routines as usual.

## Assign bots to worker machines

1. Run SahilBot Server on each Pi, VM, or computer. For separate instances on one computer, use separate VMs or containers with their own data volumes and addresses. Start each instance with a fresh data directory.
2. In the Mac app, open **Settings → Always-on server → Worker machines**. Pair each machine with a code from `sahilbot-server pair`. Enter the SHA-256 fingerprint printed by the server if it uses a self-signed certificate.
3. Set **Bot slots** to the number of assigned bots each worker should accept. Use one slot for a dedicated worker, or set two, three, five, or another limit up to 50. The server's `--max-runs` still controls how many jobs can execute at once.
4. In **Bot placement**, choose a machine and select **Move**. **Open bot on worker** opens its chat in the worker's web app. Choose **This Mac** to bring execution back.

The previous host must acknowledge the move while the bot is idle. A pending move can be retried after the hosts reconnect. SahilBot copies the bot's scrubbed profile to a new worker. Chats, files, routines, goals, and connected accounts stay on their own machines. Configure the model and connectors on each worker, and set up routines there if you want them to run there. An inactive copy keeps its chat history, and its routines wait while it is inactive.

Bots in the same server instance share its service account and configured tools. Use separate VMs or separate machines for OS-level isolation.

## What runs where

| | Server (Pi / VM / Mac mini) | Mac app only |
|---|---|---|
| Chat, bots, groups, projects, swarms, Council, Heavy | ✓ | |
| Routines and goals, 24/7 (scheduler, catch-up after downtime) | ✓ | |
| Approvals and questions (cards, Needs-you inbox), on any paired device | ✓ | |
| Connectors (MCP), with API keys or tokens | ✓ | |
| Connectors that sign in through the browser (OAuth) | ✓ (sign in through an SSH tunnel; see Troubleshooting) | easier here |
| Memory, rules, skills, notes vault, knowledge base (server files) | ✓ | |
| Files, workspace, `run_command`, coding tools, git (Linux commands) | ✓ | |
| Word, Excel and PowerPoint documents, Docs, Markdown | ✓ | |
| Web search and background browser for public text pages | ✓ | |
| Password vault (unlocked with a master password; values never shown in the browser) | ✓ | Touch ID, reveal |
| Cloud models (Claude, OpenAI, OpenRouter) and the ChatGPT plan through Codex | ✓ | |
| Local models (Ollama, LM Studio) | another machine's server as a custom endpoint | ✓ |
| Interactive browser (signed-in sites, forms, purchases), Teach a task, Pages preview | ✗ | ✓ |
| Computer use, Mac apps (AppleScript), Apple Mail, Quick Ask, screenshots | ✗ | ✓ |
| Voice (dictation, voice mode), PDF printing, Quick Look previews | ✗ | ✓ |

On the server, the tools in the ✗ rows are **not registered** (src/main/runtime.ts), so the model never sees
them. If it searches for one, `find_tools` tells it which features are missing and what to use instead. The
web UI hides the matching controls.

The background browser on a worker can open public pages, read the current page, and follow links. It reads HTML and plain text over public IPv4. Use the Mac app for interactive or JavaScript-only sites, and connected apps for account data.

## Design

```
 phone / laptop browser                      Mac app (Settings → Always-on server)
   │  the Mac app's React UI                   │  HTTPS + bearer token (Keychain), status, "Open server UI"
   │  + bridge.js: window.foreman over WS      │
   ▼                                           ▼
 tailscale serve (HTTPS, tailnet only) ──► 127.0.0.1:8787  SahilBot Server (Node 22.13+, one process)
                                              ├─ HTTP front: Host/Origin checks, pairing, devices, CSRF, audit log
                                              ├─ WebSocket hub ──► RPC registry (src/main/rpc.ts) ◄── Electron IPC (Mac app)
                                              ├─ headless `electron` (src/server/platform/electron.ts)
                                              └─ the Mac app's main process (src/main/index.ts), unchanged:
                                                 agent loop, run scheduler, tools, bots, routines, memory, vault, connectors
```

**One transport-agnostic registry.** Every IPC channel is registered once with `registerHandler(channel, fn)`
in `src/main/rpc.ts`, and every event goes out once with `broadcast(event, ...args)`. Transports attach as
adapters:

- **Electron IPC** (`src/main/rpc-electron.ts`): `ipcMain.handle` per channel, with events sent to the main
  window. The Mac app works exactly as before.
- **WebSocket** (`src/server/hub.ts`): one session per open tab. Calls from a paired browser are invoked as if
  the main window made them, and events go to every session.

**The same main process, headless.** The server build (`scripts/build-server.mjs` → `out/server/index.js`)
bundles `src/main/index.ts` with `electron` aliased to `src/server/platform/electron.ts`, a headless
implementation of the part of Electron's API that SahilBot uses:

| Electron | On the server |
|---|---|
| `ipcMain.handle` / `.on` | the RPC registry / messages from the page |
| the main window, `webContents.send`, focus | every paired browser; focused when a tab is visible |
| `safeStorage` (Keychain) | AES-256-GCM under the server's master key (`src/server/secrets.ts`) |
| `Notification` | paired devices: in-page if open, Web Push if turned on, queued until they reconnect |
| `shell.openExternal` | asks the browser to open the link (never opens anything on the server) |
| `shell.trashItem` | moved into `<data>/trash` (recoverable) |
| `protocol.handle('foreman-file')` | served at `/foreman-file/…` with the same access rules |
| dialogs, Touch ID, accessibility, screen, global shortcuts, tray, menus | "not here" answers (cancelled dialogs, `false`) |

Anything else in Electron's API becomes a harmless no-op, so a rarely used Mac-only call can't crash the
server. The web UI is the renderer bundle (`out/renderer`). The server injects `bridge.js` into it: the Mac
app's preload (`src/preload/index.ts`) built against a WebSocket `ipcRenderer`
(`src/server/web/electron-web.ts`), so `window.foreman` is identical. The bridge also sets
`runtime = 'server'`, uses the browser's file chooser for attachments (files are sent as bytes), and handles
notifications and the phone layout (a drawer sidebar, full-screen panels and Settings).

**Many bots at once** (`src/main/agent/run-scheduler.ts`):

- **Run limit.** Every top-level run takes a slot. The default is about one per GB of RAM beyond the first:
  **7 on an 8 GB Pi 5**, 3 on 4 GB. Override it with `--max-runs`.
- **Fair queues.** Each bot has its own queue. A free slot goes to the waiting bot with the fewest runs going,
  then round-robin between bots, so one busy bot never starves the others. Within a bot, runs you're
  waiting on go before routines.
- **Backpressure.** When available memory is low (Linux MemAvailable under ~6%) or the process grows past 60%
  of RAM, new runs wait in the queue instead of starting. One run can always go, so the queue never stalls.
- **What doesn't take a slot.** Model calls are network-bound, so many can be in flight. Swarm helpers run
  inside their parent's slot: on 8 GB a bot gets its full Max helpers, and under 6 GB it gets at most 6. CPU
  work goes through a small pool of cores − 1 slots.
- **Queued runs.** A queued run shows as started, and the server also sends a `queued` chat event with its
  position.

**Storage.** One SQLite database in WAL mode (`node:sqlite`), the same schema as the Mac app's. Data lives in
`--data` (default `~/.local/share/sahilbot-server`); the server's own files are in `<data>/server`.

## Security

- **Loopback by default.** The server listens on `127.0.0.1` only. For remote access the recommended path is
  **Tailscale**: `tailscale serve` puts a real HTTPS certificate in front of it, and only your tailnet can
  connect. The alternative is `--listen 0.0.0.0` (or any non-loopback address), which **always uses TLS**:
  your `--cert/--key`, or a self-signed ECDSA certificate made on first run (it prints the SHA-256
  fingerprint). Plain HTTP is never offered off-machine.
- **Pairing.** A one-time code: 10 characters from a 31-symbol alphabet (about 50 bits), valid for 10
  minutes, single use, and stored only as a hash. It's printed at first start and by `sahilbot-server pair`,
  and Settings → Server → Pair another device makes one too. A browser trades the code for a 256-bit device
  token, sent back as an `HttpOnly; SameSite=Strict` cookie (also `Secure` over HTTPS). The Mac app gets a
  bearer token, which it keeps in the Keychain. The server stores only SHA-256 hashes of tokens.
- **Rate limits.** At most 5 failed codes per address and 20 overall per 15 minutes (`429` with
  `Retry-After`). Ten wrong guesses burn every live code.
- **Per-device revocation.** Settings → Server → Paired devices → Remove, or `sahilbot-server revoke <id>`.
  The device's open tabs are disconnected at once. Signing out revokes that device too.
- **Origin and Host checks.** Every request must name this server in `Host`: IP literals, `localhost`, the
  machine's name, `*.ts.net`, or `--allow-host`. That blocks DNS rebinding. The WebSocket and every
  cookie-authenticated POST must come from the same origin, and POSTs must also carry a per-device CSRF token.
  Cross-site WebSocket hijacking and login CSRF are refused.
- **Headers.** A strict CSP (same-origin scripts, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, COOP and
  CORP, and HSTS over HTTPS. There are no CORS headers, so no other site can read a response.
- **No secrets ever go to the UI.** API keys and tokens stay sealed on the server; Settings only shows that a
  key is saved. Revealing a saved password or an authenticator code, and exporting a vault backup, are
  refused over the web.
- **Approvals still apply.** The agent's permission modes, hard stops and approval rules are the same. Cards
  and the Needs-you inbox work in the browser. Approvals, answers and autonomy changes made remotely
  (`chat:respond`, `purchase:respond`, `vault:authRespond`, `needsYou:answer`, `botAutonomy:setLevel`) go to the
  audit log.
- **Audit log.** `<data>/server/audit.log` records starts and stops, pairing codes made, pairings, failed codes
  and rate limits, rejected Host and Origin headers, failed sign-ins, sessions opened and closed (with
  duration and call count), approvals, refused calls, and revocations. It's viewable in Settings → Server →
  Access log and with `sahilbot-server audit`. It never contains tokens, codes or answer text.
- **Secrets at rest.** One 256-bit master key seals everything with AES-256-GCM. The server takes it from the
  first source available, strongest first:
  1. systemd credentials: `LoadCredentialEncrypted=sahilbot-master-key:…`, sealed by the TPM or the host key
     (example in `sahilbot.service`).
  2. `SAHILBOT_MASTER_KEY` (64 hex characters; `sahilbot-server key` makes one), for example a Docker secret.
  3. A passphrase (`SAHILBOT_PASSPHRASE` or `--passphrase-file`), stretched with scrypt.
  4. Otherwise a random key file `<data>/server/master.key` (mode 0600), protected by file permissions only.

  The keyring remembers which source was used, so a server set up with a passphrase refuses to start without
  it. It never quietly makes a new key.
- **Service hardening.** The systemd unit sets `UMask=0077`, `NoNewPrivileges`, and a capped V8 heap. Files
  are created as 0600 in 0700 folders.

## Sizing and limits

Measured on an Apple M5 Pro as a stand-in (Node 26, the built `out/server/index.js`, a mock model streaming
60 words per reply):

| | RSS | CPU |
|---|---|---|
| idle, 30 s after start | **~130 MB** | 0% (0.3 s CPU to boot) |
| after one chat | ~155 MB | ~0.2 s for the chat |
| after 20 concurrent chats | ~180 MB | ~0.4 s in total |
| load test: 20 bots × 5 chats = 100 runs, limit 7 (`tests/server/load.test.ts`) | peak ~245 MB (in-process with the test runner) | 2.4 s total, about 13% of one core over 18 s; every bot started within 3.5 s |

**Raspberry Pi 5 estimate.** The Cortex-A76 is roughly 3–4× slower per core than an M5 Pro, and memory use is
about the same on arm64 Linux:

- **Idle:** about 130–170 MB of RAM and well under 1% CPU.
- **A chat:** under a second of CPU.
- **100 runs at once:** about 10 s of CPU spread over the run, about 300 MB RSS.

On **8 GB** the budget is roughly 300–600 MB for SahilBot with many bots busy, plus your swarms' context. That
leaves over 6 GB for the OS, the page cache and anything else, which is why 7 concurrent runs and full swarms
are the default. On **4 GB** it still fits comfortably at 3 runs and 6 helpers per swarm.

**What doesn't fit on a Pi:**

- **Local models.** A useful model (≥7B parameters, quantized) needs about 5 GB or more just for weights,
  and runs at a few tokens per second on the Pi's CPU. Use cloud models, or point SahilBot at an Ollama or LM
  Studio server on a stronger machine (Settings → API Keys & Servers → custom server).
- **Local knowledge-base embeddings.** Use OpenAI embeddings (Settings → Knowledge, opt-in) or an Ollama
  server elsewhere; without either, search is keyword-based. Indexing very large folders is slow on an SD
  card; use an SSD.
- **The built-in browser, computer use and voice.** See [what runs where](#what-runs-where).

## Other installs

**Any Debian or Ubuntu VM (x64 or arm64):** the same as the Pi. Use
`SahilBot-server-linux-x64.tar.gz` and `./sahilbot-server/install.sh`.

**Docker** (multi-arch image from the `Dockerfile`):

```sh
docker buildx build --platform linux/arm64,linux/amd64 -t sahilbot-server .
docker run -d --name sahilbot --restart unless-stopped --network host -v sahilbot-data:/data sahilbot-server
docker exec sahilbot sahilbot-server pair --data /data
```

`--network host` keeps it on the host's `127.0.0.1:8787`, ready for `tailscale serve`. With published ports
instead (for example Docker Desktop), add `-e SAHILBOT_LISTEN=0.0.0.0 -p 127.0.0.1:8787:8787`; it then uses
TLS with a self-signed certificate. For secrets at rest, pass `SAHILBOT_MASTER_KEY` as a secret.

**A Mac mini (launchd):** build the server (`npm run build && npm run build:server`) and pack it with
`node scripts/server/package.mjs --os darwin --arch arm64`. Then unpack it and run `./install.sh`, which
creates a launchd agent (`~/Library/LaunchAgents/app.sahilbot.server.plist`) that starts at login and
restarts on failure. Turn on automatic login, "Prevent automatic sleeping", and "Start up automatically after
a power failure". The Mac app and the server can run side by side; they use different data folders.

**From a checkout:**

```sh
npm ci
npm run build && npm run build:server
node out/server/index.js --data /tmp/x
```

## Command line

```
sahilbot-server [serve] [--data DIR] [--port 8787] [--listen 127.0.0.1] [--tls] [--cert F --key F]
                [--allow-host NAME]... [--passphrase-file F] [--max-runs N]
sahilbot-server pair              a new one-time pairing code (10 minutes)
sahilbot-server devices           paired devices (ids, last seen)
sahilbot-server revoke <id>       remove a device (its tabs are signed out within seconds)
sahilbot-server audit             recent remote-access events
sahilbot-server key               a new random master key
```

Environment variables: `SAHILBOT_DATA`, `SAHILBOT_PORT`, `SAHILBOT_LISTEN`, `SAHILBOT_ALLOW_HOSTS`,
`SAHILBOT_MASTER_KEY`, `SAHILBOT_PASSPHRASE`, `SAHILBOT_MAX_RUNS`. The service:
`systemctl --user status|restart sahilbot`. Logs: `journalctl --user -u sahilbot -f`.

**Updating:** download the new tarball, unpack it, and run `./sahilbot-server/install.sh` again. Your data and
paired devices are kept.

## Troubleshooting

- **"Pair this device first"**: the device was removed, or its cookie was cleared. Run `sahilbot-server pair`
  and enter the new code.
- **"This server does not answer to that name"**: you reached it under a name it doesn't know. Add it with
  `--allow-host name` (Tailscale names are allowed already).
- **No notifications on iPhone:** add it to the Home Screen, open it from there, then go to Settings → Server →
  Turn on. Notifications also need HTTPS, which Tailscale provides.
- **Connector sign-in (OAuth) opens a page that can't load:** the sign-in redirect goes to the server's own
  `localhost`. Sign in once with an SSH tunnel (`ssh -L <port>:127.0.0.1:<port> pi`), or use the connector's
  API key option.
- **It starts but nothing answers:** add a model provider (Settings → API Keys & Servers), or check
  `journalctl --user -u sahilbot`.
