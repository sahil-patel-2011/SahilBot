#!/usr/bin/env bash
# SahilBot Server installer: Raspberry Pi OS 64-bit, Debian, Ubuntu (arm64 or x64), and macOS (launchd).
#
# From an unpacked release tarball (SahilBot-server-linux-arm64.tar.gz → sahilbot-server/):
#   ./install.sh                 install to ~/sahilbot-server, start it now and at every boot
#   ./install.sh --port 8787 --prefix ~/sahilbot-server --no-service
#
# What it does (no sudo needed, except the optional `loginctl enable-linger` for running without a login):
#   1. checks the machine: 64-bit OS, memory (4 GB minimum, 8 GB recommended), disk
#   2. Node.js 22.13+: uses yours, or downloads the official Node 24 LTS for this CPU into the install folder
#      (checksum verified against nodejs.org's SHASUMS256.txt)
#   3. copies SahilBot Server to the prefix (your data lives elsewhere: ~/.local/share/sahilbot-server)
#   4. a systemd user service (Linux) or a launchd agent (macOS): starts at boot, restarts on failure
#   5. prints a pairing code and how to reach it from your phone (Tailscale)
set -euo pipefail

PREFIX="${HOME}/sahilbot-server"
PORT=8787
SERVICE=1
NODE_MAJOR=24
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;38;5;208m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ 1. the machine
OS="$(uname -s)"
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  armv7l|armv6l) die "This is a 32-bit OS. SahilBot Server needs a 64-bit OS: Raspberry Pi OS (64-bit) on a Pi 4 or 5." ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac
case "$OS" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *) die "Unsupported OS: $OS (Linux or macOS)" ;;
esac
if [ "$PLATFORM" = linux ]; then
  MEM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
  MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"
else
  MEM_MB=$(( $(sysctl -n hw.memsize) / 1048576 ))
  MODEL="$(sysctl -n hw.model 2>/dev/null || true)"
fi
say "Machine: ${MODEL:-$OS} ($ARCH), $(( (MEM_MB + 512) / 1024 )) GB RAM"
if [ "$MEM_MB" -lt 3500 ]; then
  warn "Less than 4 GB of RAM. SahilBot Server needs 4 GB at least; a Raspberry Pi 5 with 8 GB is recommended."
elif [ "$MEM_MB" -lt 7000 ]; then
  say "4 GB works (fewer runs at once, smaller swarms). 8 GB is recommended for many busy bots."
fi
case "$MODEL" in
  *"Raspberry Pi"*)
    say "Raspberry Pi tips: use the 64-bit OS, boot from an SSD (or a good A2 SD card), and fit the active cooler." ;;
esac
FREE_MB=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE_MB:-0}" -lt 1024 ] && warn "Less than 1 GB free disk in $HOME."
# Heap for the Node process: about a third of RAM, 1–3 GB.
HEAP_MB=$(( MEM_MB / 3 )); [ "$HEAP_MB" -lt 1024 ] && HEAP_MB=1024; [ "$HEAP_MB" -gt 3072 ] && HEAP_MB=3072

# ------------------------------------------------------------------ 2. Node.js
node_ok() {
  local v; v="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
  local major="${v%%.*}" rest="${v#*.}"; local minor="${rest%%.*}"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}
NODE=""
if [ -x "$PREFIX/node/bin/node" ] && node_ok "$PREFIX/node/bin/node"; then NODE="$PREFIX/node/bin/node"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  say "Installing Node.js $NODE_MAJOR LTS for $PLATFORM-$ARCH into $PREFIX/node (official build, checksum verified)…"
  command -v curl >/dev/null || die "curl is needed (sudo apt install curl)."
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -Eo "node-v[0-9.]+-${PLATFORM}-${ARCH}\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || die "No Node.js $NODE_MAJOR build for $PLATFORM-$ARCH on nodejs.org."
  curl -fSL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"
  WANT="$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  if command -v sha256sum >/dev/null; then GOT="$(sha256sum "$TMP/$FILE" | awk '{print $1}')"; else GOT="$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}')"; fi
  [ "$WANT" = "$GOT" ] || die "Checksum mismatch for $FILE; not installing it."
  mkdir -p "$PREFIX/node"
  tar -xzf "$TMP/$FILE" -C "$PREFIX/node" --strip-components=1
  NODE="$PREFIX/node/bin/node"
fi
say "Node.js $("$NODE" -v) ($NODE)"

# ------------------------------------------------------------------ 3. the app
[ -f "$SRC/out/server/index.js" ] || die "Run this from an unpacked SahilBot Server release (sahilbot-server/install.sh)."
if [ "$SRC" != "$(cd "$PREFIX" 2>/dev/null && pwd -P || echo none)" ]; then
  say "Copying SahilBot Server $(cat "$SRC/VERSION" 2>/dev/null || echo) to $PREFIX…"
  mkdir -p "$PREFIX"
  # A fresh copy of the app (the node folder installed above and your data are left alone).
  for d in out packs docs resources node_modules bin; do rm -rf "${PREFIX:?}/$d"; done
  (cd "$SRC" && tar -cf - --exclude ./node . ) | (cd "$PREFIX" && tar -xf -)
fi
if [ ! -d "$PREFIX/node_modules" ]; then
  say "Installing dependencies…"
  (cd "$PREFIX" && PATH="$(dirname "$NODE"):$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
fi
chmod +x "$PREFIX/bin/sahilbot-server"
# The launcher (and the service, whose PATH is minimal) uses $PREFIX/node/bin/node: point it at this Node.
if [ "$NODE" != "$PREFIX/node/bin/node" ]; then mkdir -p "$PREFIX/node/bin"; ln -sf "$NODE" "$PREFIX/node/bin/node"; fi
mkdir -p "$HOME/.local/bin"
ln -sf "$PREFIX/bin/sahilbot-server" "$HOME/.local/bin/sahilbot-server"
"$PREFIX/bin/sahilbot-server" --version >/dev/null || die "SahilBot Server didn't start with $NODE."

# ------------------------------------------------------------------ 4. the service
if [ "$SERVICE" = 1 ] && [ "$PLATFORM" = linux ]; then
  command -v systemctl >/dev/null || die "No systemd here. Run it yourself: $PREFIX/bin/sahilbot-server --port $PORT (or use --no-service)."
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@PORT@|$PORT|g" -e "s|@HEAP@|$HEAP_MB|g" "$SRC/sahilbot.service" > "$UNIT_DIR/sahilbot.service"
  systemctl --user daemon-reload
  systemctl --user enable --now sahilbot.service
  systemctl --user restart sahilbot.service
  # Keep it running after you log out, and start it at boot without a login.
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes; then
    loginctl enable-linger "$USER" 2>/dev/null || warn "To run at boot without logging in, run once: sudo loginctl enable-linger $USER"
  fi
  LOGS="journalctl --user -u sahilbot -f"
elif [ "$SERVICE" = 1 ] && [ "$PLATFORM" = darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/app.sahilbot.server.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@PORT@|$PORT|g" -e "s|@HOME@|$HOME|g" "$SRC/app.sahilbot.server.plist" > "$PLIST"
  launchctl bootout "gui/$(id -u)/app.sahilbot.server" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  LOGS="tail -f \"$HOME/Library/Logs/SahilBot Server.log\""
  say "On a Mac mini: System Settings → Energy → turn on 'Prevent automatic sleeping' and 'Start up automatically after a power failure'."
else
  LOGS="(no service: run $PREFIX/bin/sahilbot-server --port $PORT)"
fi

# ------------------------------------------------------------------ 5. pair and reach it
if [ "$SERVICE" = 1 ]; then
  for _ in $(seq 1 60); do
    if "$NODE" -e "fetch('http://127.0.0.1:$PORT/healthz').then(r=>r.json()).then(j=>process.exit(j.ready?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then READY=1; break; fi
    sleep 1
  done
  [ "${READY:-0}" = 1 ] || warn "It hasn't answered on port $PORT yet. Logs: $LOGS"
fi
echo
say "SahilBot Server is installed."
echo "   On this machine:  http://127.0.0.1:$PORT"
"$PREFIX/bin/sahilbot-server" pair | sed 's/^/   /'
echo
if command -v tailscale >/dev/null 2>&1; then
  NAME="$(tailscale status --json 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch{}})" || true)"
  say "From your phone or laptop (Tailscale is installed): run once"
  echo "     sudo tailscale serve --bg $PORT"
  [ -n "$NAME" ] && echo "   then open https://$NAME on any device in your tailnet."
else
  say "To use it from your phone or laptop, anywhere: install Tailscale here (https://tailscale.com/download),"
  echo "   sign in with the same account as your phone, then run: sudo tailscale serve --bg $PORT"
fi
echo "   Logs: $LOGS     New pairing code: sahilbot-server pair     Docs: $PREFIX/docs/server.md"
