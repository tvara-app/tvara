#!/usr/bin/env bash
#
# Start a Chrome that Claude can read, without touching your everyday one.
#
#   ./tools/chrome-debug.sh
#
# It uses its own profile directory (~/.lct-chrome), which is required: since
# Chrome 136 the debugging port is refused on the default profile on purpose,
# so that a web page cannot reach a browser holding your real logins. The side
# effect is the right one — this window only ever holds what you sign into for
# testing.
#
# First run: chrome://extensions → Developer mode → Load unpacked →
# ~/long-chat-toolkit, then sign in to your test accounts. It remembers both.
set -euo pipefail

PORT="${LCT_CDP_PORT:-9222}"
DIR="$HOME/.lct-chrome"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME" ]] || CHROME="/Applications/Chromium.app/Contents/MacOS/Chromium"
[[ -x "$CHROME" ]] || { echo "✋ Chrome not found in /Applications."; exit 1; }

if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "✓ already listening on 127.0.0.1:${PORT} — nothing to do."
  exit 0
fi

mkdir -p "$DIR"
echo "→ starting Chrome with a debugging port on 127.0.0.1:${PORT}"
echo "  profile: $DIR   (delete it to forget everything)"
"$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$DIR" \
          --no-first-run --no-default-browser-check >/dev/null 2>&1 &

for _ in $(seq 1 40); do
  if curl -s -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "✓ ready. Load the extension and open a long chat, then: npm run attach"
    exit 0
  fi
  sleep 0.5
done
echo "✋ Chrome started but the port never opened. Is another Chrome already running?"
exit 1
