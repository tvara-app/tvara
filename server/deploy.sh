#!/usr/bin/env bash
#
# Long Chat Toolkit — deploy the entitlement issuer, in one command.
#
#   ./server/deploy.sh <chrome-extension-id> [--test]
#
# Everything the old checklist asked you to do by hand, in order, idempotent:
# creates the KV namespace if it does not exist, writes its id into
# wrangler.toml, pins ALLOWED_ORIGINS to your extension, prompts for the two
# secrets only if they are not already set, deploys, and then PROVES the
# deployment works by calling it the way the extension does.
#
# The smoke test at the end is the point. A worker that deploys but answers 403
# to its own extension is the failure that looks like success, and it is only
# discovered by a customer who paid.

set -euo pipefail
cd "$(dirname "$0")"

EXT_ID="${1:-}"
MODE="live"
[[ "${2:-}" == "--test" ]] && MODE="test"

if [[ -z "$EXT_ID" ]]; then
  cat <<'EOF'
Usage: ./server/deploy.sh <chrome-extension-id> [--test]

The extension id is the 32-letter string on chrome://extensions with
Developer mode on — the same one that appears in your chrome-extension:// URLs.
Use the id of the PUBLISHED item once you have it; the unpacked id is different
and a worker pinned to it will refuse the published copy.
EOF
  exit 1
fi

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "✋ '$EXT_ID' does not look like a Chrome extension id (32 letters a-p)."
  exit 1
fi

command -v wrangler >/dev/null || { echo "✋ wrangler not found:  npm i -g wrangler"; exit 1; }
wrangler whoami >/dev/null 2>&1 || { echo "✋ not logged in:  wrangler login"; exit 1; }

ORIGIN="chrome-extension://${EXT_ID}"

# ---------- 1. KV namespace ----------
if grep -q "REPLACE_WITH_KV_NAMESPACE_ID" wrangler.toml; then
  echo "→ creating KV namespace RL…"
  OUT="$(wrangler kv namespace create RL 2>&1 || true)"
  # wrangler has printed this id in three different shapes across versions;
  # take the first 32-hex-char run and stop caring which.
  KV_ID="$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  if [[ -z "$KV_ID" ]]; then
    echo "✋ could not read the namespace id from wrangler's output:"
    echo "$OUT"
    echo "   Put it into wrangler.toml by hand and re-run."
    exit 1
  fi
  # BSD sed (macOS) and GNU sed disagree about -i; write through a temp file.
  sed "s/REPLACE_WITH_KV_NAMESPACE_ID/${KV_ID}/" wrangler.toml > wrangler.toml.tmp
  mv wrangler.toml.tmp wrangler.toml
  echo "  ✓ KV namespace ${KV_ID}"
else
  echo "  ✓ KV namespace already configured"
fi

# ---------- 2. origin pin ----------
python3 - "$ORIGIN" "$MODE" <<'PY'
import re, sys
origin, mode = sys.argv[1], sys.argv[2]
src = open("wrangler.toml").read()
src = re.sub(r'ALLOWED_ORIGINS = "[^"]*"', f'ALLOWED_ORIGINS = "{origin}"', src)
src = re.sub(r'DODO_MODE = "[^"]*"', f'DODO_MODE = "{mode}"', src)
open("wrangler.toml", "w").write(src)
PY
echo "  ✓ ALLOWED_ORIGINS = ${ORIGIN}  (DODO_MODE = ${MODE})"

# ---------- 3. secrets ----------
EXISTING="$(wrangler secret list 2>/dev/null || echo '[]')"
for NAME in DODO_API_KEY SIGNING_KEY; do
  if printf '%s' "$EXISTING" | grep -q "\"$NAME\""; then
    echo "  ✓ secret $NAME already set"
  else
    if [[ "$NAME" == "SIGNING_KEY" ]]; then
      echo "→ SIGNING_KEY is the private half of the key in lib/entitlement.js."
      echo "  Get it with:  node tools/genkey.mjs worker-key"
    else
      echo "→ DODO_API_KEY is the server-side API key from the Dodo dashboard."
    fi
    wrangler secret put "$NAME"
  fi
done

# ---------- 4. deploy ----------
echo "→ deploying…"
wrangler deploy

URL="$(wrangler deployments list 2>/dev/null | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)"
[[ -z "$URL" ]] && URL="https://entitlement.long-chat-toolkit.workers.dev"

# ---------- 5. prove it ----------
# Three calls, each isolating one link in the chain. A junk licence key SHOULD
# come back 404 — that answer can only be produced by a worker that accepted our
# origin, parsed the body, and got a real verdict out of Dodo.
echo
echo "→ smoke test against ${URL}"
code() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}/entitlement" \
    -H "Content-Type: application/json" -H "Origin: $1" \
    -d "{\"license_key\":\"SMOKE-TEST-KEY\",\"device\":\"$(printf 'a%.0s' {1..32})\",\"ts\":$(date +%s000)}" \
    --max-time 20 || echo 000
}
OURS="$(code "$ORIGIN")"
STRANGER="$(code "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")"

echo "   our origin      → HTTP ${OURS}"
echo "   another origin  → HTTP ${STRANGER}"
echo

FAILED=0
case "$OURS" in
  404) echo "   ✓ reachable, origin accepted, Dodo answered (junk key correctly unknown)";;
  403) echo "   ✗ our own origin was REFUSED — the id above is not the one the worker trusts"; FAILED=1;;
  503) echo "   ✗ Dodo did not answer — check DODO_API_KEY and DODO_MODE"; FAILED=1;;
  000) echo "   ✗ nothing answered at ${URL} — the deploy did not take"; FAILED=1;;
  *)   echo "   ? unexpected ${OURS} — inspect with: wrangler tail"; FAILED=1;;
esac
[[ "$STRANGER" == "403" ]] \
  && echo "   ✓ a stranger's extension is refused" \
  || { echo "   ✗ another extension was NOT refused (got ${STRANGER}) — ALLOWED_ORIGINS is not in force"; FAILED=1; }

echo
if [[ "$FAILED" == "0" ]]; then
  echo "✅ issuer live at ${URL}"
  echo "   lib/entitlement.js must point at exactly this host (ISSUER)."
else
  echo "❌ deployed, but NOT safe to sell against yet — fix the ✗ above first."
  exit 1
fi
