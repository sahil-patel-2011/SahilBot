#!/bin/sh
# Runs a command with an unlocked GNOME keyring, so the app's secret store works in a Linux test run
# (a container or CI). Needs gnome-keyring and dbus (apt-get install -y gnome-keyring dbus-x11).
# Example: DISPLAY=:99 scripts/linux-keyring.sh npx vitest run --config vitest.accept.config.mts
set -e
dir="${XDG_DATA_HOME:-$HOME/.local/share}/keyrings"
if [ ! -f "$dir/default" ]; then
  # A keyring without a password, so nothing prompts. Test machines only.
  mkdir -p "$dir"
  printf 'Default_keyring' > "$dir/default"
  printf '[keyring]\ndisplay-name=Default keyring\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' > "$dir/Default_keyring.keyring"
fi
exec dbus-run-session -- sh -c 'gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1; export XDG_CURRENT_DESKTOP=GNOME SAHILBOT_TEST_PASSWORD_STORE=gnome-libsecret; exec "$@"' sh "$@"
