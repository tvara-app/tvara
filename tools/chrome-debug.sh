#!/usr/bin/env bash
#
# Start a Chrome that Claude can read, without touching your everyday one.
#
#   ./tools/chrome-debug.sh
#
# It uses its own profile directory (~/.lct-chrome-test), which is required:
# since Chrome 136 the debugging port is refused on the default profile on
# purpose, so that a web page cannot reach a browser holding your real logins.
#
# THIS DIRECTORY IS NOT THE CLONE. tools/chrome-clone.sh copies a real profile
# — real cookies, real sessions — into ~/.lct-chrome. Both scripts used to open
# the SAME directory while this one promised "only what you sign into for
# testing", so once you had cloned even once, this line was false and running
# it re-exposed every live login on the debugging port. They are separate
# directories now, and this one really does start empty.
#
# First run: chrome://extensions → Developer mode → Load unpacked →
# ~/tvara, then sign in to your test accounts. It remembers both.
set -euo pipefail

PORT="${LCT_CDP_PORT:-9222}"
DIR="$HOME/.lct-chrome-test"      # NOT ~/.lct-chrome — see the note above
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
