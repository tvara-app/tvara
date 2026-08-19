#!/usr/bin/env bash
#
# Clone the Chrome profile you actually use, and open it with a debugging port.
#
#   ./tools/chrome-clone.sh --list          # which profiles exist, by name
#   ./tools/chrome-clone.sh "Profile 3"     # clone that one and launch it
#   ./tools/chrome-clone.sh                 # clone the default profile
#
# WHY A CLONE AND NOT YOUR REAL PROFILE
# Since Chrome 136 the debugging port is refused on your normal profile
# directory, on purpose: without that rule, any web page you visited could talk
# to a browser holding every login you have. The supported way is a separate
# --user-data-dir, so this copies the profile you name into one.
#
# What that gets you: the same cookies, the same signed-in accounts, the same
# extensions — your setup, not a blank browser. Nothing you do in the clone
# touches the original, and nothing in the original changes the clone.
#
# READ THIS BEFORE YOU PICK A PROFILE
# The clone can do anything that profile can: it carries its live sessions. So
# clone the profile you TEST with. If your everyday accounts live in the same
# profile, they come too — that is the honest cost of "use it the way I do",
# and the fix is to pick a different profile, not to pretend otherwise.
#
# macOS ONLY, AND IT WILL LOOK LIKE A DISASTER IF NOBODY WARNS YOU
# Chrome does not keep cookie encryption keys in the profile on macOS — they
# live in your login Keychain, under "Chrome Safe Storage". A Chrome running
# from a different --user-data-dir has to ask for that key, and if the prompt
# is dismissed (or never seen, because it opened behind the window) the cookies
# copy across fine and then decrypt to nothing. Every site in the clone shows
# you signed OUT.
#
# Your real profile is untouched when that happens. It is never opened by this
# script, never written to, and quitting the clone and starting Chrome normally
# puts everything back exactly as it was.
#
# To keep the logins in the clone: answer "Always Allow" when macOS asks
# whether Chrome may use "Chrome Safe Storage". It asks once.
#
# To undo all of it:  rm -rf ~/.lct-chrome
set -euo pipefail

PORT="${LCT_CDP_PORT:-9222}"
SRC_ROOT="$HOME/Library/Application Support/Google/Chrome"
DEST="$HOME/.lct-chrome"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[[ -x "$CHROME" ]] || { echo "✋ Google Chrome not found in /Applications."; exit 1; }
[[ -d "$SRC_ROOT" ]] || { echo "✋ No Chrome profiles at: $SRC_ROOT"; exit 1; }

# ---------- which profiles exist ----------
list_profiles() {
  python3 - "$SRC_ROOT" <<'PY'
import json, os, sys
root = sys.argv[1]
try:
    state = json.load(open(os.path.join(root, "Local State")))
    info = state.get("profile", {}).get("info_cache", {})
except Exception:
    info = {}
rows = []
for d in sorted(os.listdir(root)):
    if d != "Default" and not d.startswith("Profile "):
        continue
    if not os.path.isdir(os.path.join(root, d)):
        continue
    meta = info.get(d, {})
    name = meta.get("name") or meta.get("shortcut_name") or "(unnamed)"
    email = meta.get("user_name") or ""
    rows.append((d, name, email))
if not rows:
    print("  (none found)")
for d, name, email in rows:
    print(f"  {d:<12} {name}{('  · ' + email) if email else ''}")
PY
}

if [[ "${1:-}" == "--list" ]]; then
  echo
  echo "Chrome profiles on this machine:"
  echo
  list_profiles
  echo
  echo "Then:  ./tools/chrome-clone.sh \"Profile 3\"     (use the left-hand name)"
  echo
  exit 0
fi

PROFILE="${1:-Default}"
SRC="$SRC_ROOT/$PROFILE"
[[ -d "$SRC" ]] || {
  echo "✋ No such profile: $PROFILE"
  echo
  list_profiles
  exit 1
}

# ---------- Chrome must be closed to copy a consistent profile ----------
# Its databases are open and write-locked while it runs; copying underneath a
# live Chrome is how you get a clone with a corrupt history or no cookies.
if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "✋ Chrome is running. Quit it (⌘Q) and run this again."
  echo "   Copying its databases while they are open produces a broken clone."
  exit 1
fi

echo
echo "→ cloning \"$PROFILE\" into $DEST"

mkdir -p "$DEST/Default"
# Local State carries the profile registry and the key wrapping used for
# cookies; without it the clone starts as a stranger and every session is gone.
cp -f "$SRC_ROOT/Local State" "$DEST/Local State" 2>/dev/null || true

# Caches are the bulk of a profile and none of its meaning.
rsync -a --delete \
  --exclude "Cache/" --exclude "Code Cache/" --exclude "GPUCache/" \
  --exclude "Service Worker/CacheStorage/" --exclude "Service Worker/ScriptCache/" \
  --exclude "Application Cache/" --exclude "File System/" \
  --exclude "Media Cache/" --exclude "DawnCache/" --exclude "GrShaderCache/" \
  "$SRC/" "$DEST/Default/"

SIZE="$(du -sh "$DEST" 2>/dev/null | cut -f1 || echo "?")"
echo "  ✓ copied ($SIZE) — the original is untouched"

# ---------- launch ----------
if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "  ✓ something is already listening on ${PORT}; leaving it alone."
  exit 0
fi

echo "→ opening it with a debugging port on 127.0.0.1:${PORT}"
"$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$DEST" \
          --no-first-run --no-default-browser-check >/dev/null 2>&1 &

for _ in $(seq 1 40); do
  if curl -s -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    cat <<EOF

  ✓ ready — that window is a copy of your profile.

    1. macOS may ask whether Chrome can use "Chrome Safe Storage".
       Say ALWAYS ALLOW. That prompt is the cookie key: without it the copied
       cookies cannot be decrypted and every site will look signed out.
       (Signed out anyway? Quit this window, run it again, and watch for the
       prompt — it sometimes opens behind the browser.)
    2. chrome://extensions → check Tvara is on
       (Developer mode → Load unpacked → ~/tvara if it is not)
    3. open a long chat
    4. say "ready" — the checks can run from here without you clicking anything

  YOUR REAL PROFILE IS NOT AFFECTED BY ANY OF THIS. It was copied, not moved,
  and never opened. Quit this window and start Chrome normally to get your
  usual browser back exactly as it was. rm -rf ~/.lct-chrome forgets the copy.

EOF
    exit 0
  fi
  sleep 0.5
done

echo "✋ Chrome started but the port never opened. Another Chrome may still be running."
exit 1
