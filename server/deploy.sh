#!/usr/bin/env bash
#
# Tvara — deploy the entitlement issuer, in one command.
#
#   ./server/deploy.sh <chrome-extension-id> [--test]
#
# Everything the old checklist asked you to do by hand, in order, idempotent:
# creates the KV namespace if it does not exist, writes its id into
# wrangler.toml, pins ALLOWED_ORIGINS to your extension, fills in the three
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

# ---------- 1b. D1 database ----------
if grep -q "REPLACE_WITH_D1_DATABASE_ID" wrangler.toml; then
  echo "→ creating D1 database tvara…"
  OUT="$(wrangler d1 create tvara 2>&1 || true)"
  UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  D1_ID="$(printf '%s' "$OUT" | grep -oE "$UUID" | head -1 || true)"
  # Already created on an earlier run that failed later: ask for the id rather
  # than making the operator go and dig it out of the dashboard.
  if [[ -z "$D1_ID" ]]; then
    D1_ID="$(wrangler d1 info tvara --json 2>/dev/null | grep -oE "$UUID" | head -1 || true)"
  fi
  if [[ -z "$D1_ID" ]]; then
    echo "✋ could not read the database id from wrangler's output:"
    echo "$OUT"
    echo "   Put it into wrangler.toml by hand and re-run."
    exit 1
  fi
  sed "s/REPLACE_WITH_D1_DATABASE_ID/${D1_ID}/" wrangler.toml > wrangler.toml.tmp
  mv wrangler.toml.tmp wrangler.toml
  echo "  ✓ D1 database ${D1_ID}"
else
  echo "  ✓ D1 database already configured"
fi

# Every deploy, not just the first. schema.sql is CREATE TABLE IF NOT EXISTS
# throughout, so re-applying is free — and a table added in a later version must
# not depend on anyone remembering a step.
echo "→ applying schema.sql…"
wrangler d1 execute tvara --remote --file schema.sql >/dev/null 2>&1 \
  || { echo "✋ schema apply failed — seats, nonces and the kill list would all degrade open"; exit 1; }
echo "  ✓ schema applied"

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
# Firefox has no stable origin to pin, so it is a flag rather than a list entry.
# Print it: silence here is how every Firefox user became a 403 last time.
FF="$(grep -E '^ALLOW_FIREFOX' wrangler.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')"
if [[ "$FF" == "1" ]]; then
  echo "  ✓ ALLOW_FIREFOX = 1  (any moz-extension:// origin may call)"
else
  echo "  ✓ ALLOW_FIREFOX = ${FF:-0}  (the Firefox build cannot reach this worker)"
fi

# ---------- 3. secrets ----------
EXISTING="$(wrangler secret list 2>/dev/null || echo '[]')"
# MAIL_API_KEY is deliberately absent: verification is Google-only and no code
# is mailed. Set it by hand alongside OTP_ENABLED=1 if the email route is ever
# switched back on.
for NAME in DODO_API_KEY SIGNING_KEY ARCHIVE_SECRET DODO_WEBHOOK_SECRET; do
  if printf '%s' "$EXISTING" | grep -q "\"$NAME\""; then
    echo "  ✓ secret $NAME already set"
    continue
  fi
  case "$NAME" in
    SIGNING_KEY)
      echo "→ SIGNING_KEY is the private half of the key in lib/entitlement.js."
      echo "  Get it with:  node tools/genkey.mjs worker-key"
      wrangler secret put "$NAME"
      ;;
    DODO_API_KEY)
      echo "→ DODO_API_KEY is the server-side API key from the Dodo dashboard."
      wrangler secret put "$NAME"
      ;;
    DODO_WEBHOOK_SECRET)
      # Without it /webhook/dodo answers 503 and every refund stays manual.
      echo "→ DODO_WEBHOOK_SECRET signs Dodo's webhooks (Developer → Webhooks)."
      echo "  It looks like whsec_… — paste it whole."
      wrangler secret put "$NAME"
      ;;
    ARCHIVE_SECRET)
      # Nobody needs to see this one, so nobody is asked to invent it. It is the
      # HMAC root for the per-licence archive stamp, and its ONLY requirement is
      # that it is random and never changes.
      #
      # Generated here rather than prompted because the alternative is worse in
      # both directions: unset, archiveSecret() silently falls back to
      # SIGNING_KEY — which works right up until the day you rotate the signing
      # key and every backup ever sealed stops verifying — and prompted, it gets
      # a memorable passphrase typed into it.
      #
      # Set it BEFORE the first sale. Changing it later invalidates the stamp on
      # every backup already written.
      echo "→ ARCHIVE_SECRET: generating 32 random bytes (never printed, never reused)."
      openssl rand -base64 32 | tr -d '\n' | wrangler secret put "$NAME"
      ;;
  esac
done

# ---------- 4. deploy ----------
echo "→ deploying…"
# The URL comes out of THIS deploy, not out of `deployments list` — which
# prints version and author metadata and no URL at all, so the grep below it
# always failed and the hardcoded fallback was the normal path. That meant the
# smoke test could pass against a worker this script had not deployed.
DEPLOY_OUT="$(wrangler deploy 2>&1 | tee /dev/stderr)"
URL="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)"

# And it must be the host the extension actually asks. A worker deployed under
# a different name is a worker nobody will ever reach.
EXPECTED="$(grep -oE 'https://[a-z0-9.-]+workers\.dev' ../lib/entitlement.js 2>/dev/null | head -1 || true)"
[[ -z "$EXPECTED" ]] && EXPECTED="$(grep -oE 'https://[a-z0-9.-]+workers\.dev' "$(dirname "$0")/../lib/entitlement.js" 2>/dev/null | head -1 || true)"
if [[ -z "$URL" ]]; then
  echo "✋ could not read the deployed URL out of wrangler's output."
  echo "   Not falling back to a guess — a smoke test against the wrong host proves nothing."
  exit 1
fi
if [[ -n "$EXPECTED" && "$URL" != "$EXPECTED" ]]; then
  echo "✋ deployed to ${URL}"
  echo "   but lib/entitlement.js asks ${EXPECTED}"
  echo "   Change one of them; a purchase cannot unlock Pro while they disagree."
  exit 1
fi

# ---------- 5. prove it ----------
# Delegated to server/smoke.mjs, because every route is now behind an ECDSA
# device signature and curl cannot make one. The curl probes that used to live
# here spoke protocol 2, so a healthy deploy answered 426 to all of them and
# this script printed ❌ — a check that cries wolf is a check you stop reading.
#
# It exits non-zero if any link in the chain is broken, and names which one.
# Plain ./smoke.mjs, not $(dirname "$0")/ — line 18 already cd'd into this
# script's directory, so a path rebuilt from $0 would be resolved a second time
# and miss whenever this is invoked as ./server/deploy.sh from the repo root.
command -v node >/dev/null || { echo "✋ node not found — needed for the smoke test"; exit 1; }
if ! node ./smoke.mjs "$URL" "$ORIGIN"; then
  echo "❌ deployed, but NOT safe to sell against yet — fix the ✗ above first."
  exit 1
fi

# smoke.mjs covers /trial, /entitlement and /checkout. The session routes are
# the ones where a mistake is SILENT — a /sessions that lost its identity gate
# answers 200 to anybody and no happy path notices — so they get their own
# adversarial pass, using the same $URL and $ORIGIN this script already refused
# to guess. Every check asserts a refusal, so it needs no licence and no
# identity and is safe to run against production.
if ! node ./session-smoke.mjs "$URL" "$ORIGIN"; then
  echo "❌ deployed, but the session monitoring routes are not answering safely."
  exit 1
fi

echo "✅ issuer live at ${URL}"
echo "   lib/entitlement.js must point at exactly this host (ISSUER)."
