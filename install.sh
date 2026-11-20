#!/bin/bash
# Installs (or updates) SahilBot on this Mac, ready to open with no "can't be opened" warning:
#
#   curl -fsSL https://raw.githubusercontent.com/sahil-patel-2011/SahilBot/main/install.sh | bash
#
# It downloads the newest build from GitHub Releases, puts SahilBot in /Applications (or ~/Applications
# without admin rights), clears macOS's downloaded-from-the-internet flag on it, and opens it.
# No password needed. SAHILBOT_INSTALL_DIR picks another folder; SAHILBOT_NO_OPEN=1 skips opening it.
set -euo pipefail

URL="https://github.com/sahil-patel-2011/SahilBot/releases/latest/download/SahilBot-mac-arm64.zip"
fail() { printf '\n\033[31mSahilBot wasn'"'"'t installed:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "SahilBot is a Mac app."
[ "$(uname -m)" = "arm64" ] || fail "SahilBot needs a Mac with Apple Silicon (M1 or newer)."
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || fail "SahilBot needs macOS 13 Ventura or later (this Mac has $(sw_vers -productVersion))."

DEST="${SAHILBOT_INSTALL_DIR:-}"
if [ -z "$DEST" ]; then
  # Update the copy that's already installed; otherwise /Applications, or ~/Applications without admin rights.
  if [ -d "/Applications/SahilBot.app" ] && [ -w "/Applications/SahilBot.app" ]; then DEST="/Applications"
  elif [ -d "$HOME/Applications/SahilBot.app" ]; then DEST="$HOME/Applications"
  elif [ -w "/Applications" ]; then DEST="/Applications"
  else DEST="$HOME/Applications"
  fi
fi
mkdir -p "$DEST" || fail "couldn't create $DEST."
[ -w "$DEST" ] || fail "can't write to $DEST."

if pgrep -xq SahilBot; then fail "SahilBot is running. Quit it (SahilBot menu → Quit SahilBot), then paste the command again."; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading the newest SahilBot…"
curl -fL --progress-bar -o "$TMP/SahilBot.zip" "$URL" || fail "the download didn't finish. Check your internet connection and try again."
ditto -x -k "$TMP/SahilBot.zip" "$TMP/unpacked" || fail "the download was damaged. Try again."
[ -d "$TMP/unpacked/SahilBot.app" ] || fail "the download didn't contain SahilBot.app."

echo "Installing into $DEST…"
rm -rf "$DEST/SahilBot.app"
ditto "$TMP/unpacked/SahilBot.app" "$DEST/SahilBot.app"
# The builds aren't notarized yet: without this flag macOS opens the app like any other.
xattr -dr com.apple.quarantine "$DEST/SahilBot.app" 2>/dev/null || true

VERSION="$(defaults read "$DEST/SahilBot.app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '')"
printf '\n\033[32mSahilBot %sis installed in %s.\033[0m\n' "${VERSION:+$VERSION }" "$DEST"
if [ "${SAHILBOT_NO_OPEN:-}" != "1" ]; then
  open "$DEST/SahilBot.app"
  echo "Opening it now. Next time, open it from Launchpad, Spotlight or $DEST. Paste the same command again to update."
fi
