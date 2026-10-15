#!/bin/bash
# Installs (or reinstalls) the LaunchAgent that runs the MuseThings server at login.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
case "$("$NODE" -v)" in
  v2[4-9]*|v[3-9][0-9]*) ;;
  *) echo "MuseThings needs Node 24 or newer; found $("$NODE" -v) at $NODE" >&2; exit 1 ;;
esac
PLIST="$HOME/Library/LaunchAgents/app.musethings.plist"
mkdir -p "$HOME/.musethings" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/.musethings"
sed -e "s|__NODE__|$NODE|g" -e "s|__DIR__|$DIR|g" -e "s|__HOME__|$HOME|g" \
  "$DIR/launchd/app.musethings.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/app.musethings" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST (node: $NODE). Logs: ~/.musethings/server.log"
