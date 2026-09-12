#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  echo "Usage: ./server/deploy.sh <ext-id> <ext-id> [<ext-id> <ext-id>] [--config FILE] [--test] [--skip-metrics]"
  echo "Live deployments need at least two origins; up to four are accepted."
}

CONFIG="wrangler.toml"
MODE="live"
SKIP_METRICS=0
IDS=()
while (($#)); do
  case "$1" in
    --config)
      CONFIG="${2:-}"
      shift 2
      ;;
    --test)
      MODE="test"
      shift
      ;;
    --skip-metrics)
      SKIP_METRICS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      IDS+=("$1")
      shift
      ;;
  esac
done

if [[ ! -f "$CONFIG" ]] || (( ${#IDS[@]} < 1 || ${#IDS[@]} > 4 )); then
  usage
  exit 1
fi
# At least two, because one is how a live deploy quietly strands a whole
# browser. Up to four, because the list is a COST gate and not the
# authorisation — the device signature is verified before any spend, which is
# also why ALLOW_FIREFOX admits an entire scheme. A ceiling of exactly two was
# the real constraint: Chrome store, Edge store and the unpacked build used for
# testing against live are three legitimate callers, so the cap forced one of
# them out on the day Edge shipped.
if [[ "$MODE" == "live" && ${#IDS[@]} -lt 2 ]]; then
  echo "Live deployment needs at least two extension IDs (published stores, and the build you test with)."
  exit 1
fi
for id in "${IDS[@]}"; do
  [[ "$id" =~ ^[a-p]{32}$ ]] || { echo "Invalid extension ID: $id"; exit 1; }
done

command -v wrangler >/dev/null || { echo "wrangler is required"; exit 1; }
command wrangler whoami >/dev/null 2>&1 || { echo "Run: wrangler login"; exit 1; }
wr() { command wrangler --config "$CONFIG" "$@"; }

ORIGINS=""
for id in "${IDS[@]}"; do
  origin="chrome-extension://${id}"
  # An id passed twice is a typo, not two callers; a duplicated origin makes
  # the deployed list lie about how many browsers are allowed.
  [[ ",${ORIGINS}," == *",${origin},"* ]] && continue
  ORIGINS="${ORIGINS:+${ORIGINS},}${origin}"
done

grep -q '^ALLOWED_ORIGINS = ' "$CONFIG" || { echo "ALLOWED_ORIGINS is missing from config"; exit 1; }
grep -q '^DODO_MODE = ' "$CONFIG" || { echo "DODO_MODE is missing from config"; exit 1; }
SOURCE_CONFIG="$CONFIG"
# Must still END in .toml: wrangler 4 picks its config parser from the
# extension, so a wrangler.toml.XXXXXX temp file parses as nothing — the Worker
# name comes back empty and the run dies on "Required Worker name missing",
# which reads like a broken wrangler.toml rather than a broken temp filename.
TMP_BASE="$(mktemp "${CONFIG%.toml}.XXXXXX")"
TMP_CONFIG="${TMP_BASE}.toml"
mv "$TMP_BASE" "$TMP_CONFIG"
cleanup() { rm -f "$TMP_BASE" "$TMP_CONFIG"; }
trap cleanup EXIT
sed -E \
  -e "s|^ALLOWED_ORIGINS = \".*\"$|ALLOWED_ORIGINS = \"${ORIGINS}\"|" \
  -e "s|^DODO_MODE = \".*\"$|DODO_MODE = \"${MODE}\"|" \
  "$SOURCE_CONFIG" > "$TMP_CONFIG"
# Analytics Engine is an account-level opt-in and the API refuses the upload
# outright when it is off — a dataset nobody enabled blocks a deploy that has
# nothing to do with metrics. The one call site is env.ISSUER_METRICS?.write…,
# written optional precisely so the worker runs without it, so this drops the
# binding from the TEMP config and leaves wrangler.toml intact: enable the
# product, deploy again without the flag, and metrics come back.
if (( SKIP_METRICS )); then
  awk '
    /^\[\[analytics_engine_datasets\]\]/ { skip = 1; next }
    /^\[/ { skip = 0 }
    !skip { print }
  ' "$TMP_CONFIG" > "${TMP_CONFIG}.trim" && mv "${TMP_CONFIG}.trim" "$TMP_CONFIG"
  echo "⚠ deploying WITHOUT Analytics Engine: issuer metrics will not be written."
fi
CONFIG="$TMP_CONFIG"

D1_NAME="$(awk -F'"' '/^database_name = / { print $2; exit }' "$CONFIG")"
[[ -n "$D1_NAME" ]] || { echo "No D1 database_name in $CONFIG"; exit 1; }

for secret in DODO_API_KEY SIGNING_KEY ARCHIVE_SECRET DODO_WEBHOOK_SECRET; do
  if ! wr secret list | grep -q "\"${secret}\""; then
    echo "Missing required secret: ${secret}"
    exit 1
  fi
done

wr d1 execute "$D1_NAME" --remote --file schema.sql
for column in "label_enc TEXT" "plat TEXT" "geo TEXT"; do
  out="$(wr d1 execute "$D1_NAME" --remote --command "ALTER TABLE sessions ADD COLUMN ${column};" 2>&1)" || {
    [[ "$out" == *"duplicate column"* || "$out" == *"already exists"* ]] || { echo "$out"; exit 1; }
  }
done

DEPLOY_OUT="$(wr deploy 2>&1 | tee /dev/stderr)"
URL="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)"
[[ -n "$URL" ]] || { echo "Could not read deployed Worker URL"; exit 1; }

for origin in ${ORIGINS//,/ }; do
  node ./smoke.mjs "$URL" "$origin"
  node ./session-smoke.mjs "$URL" "$origin"
done

echo "Issuer deployed: $URL"
