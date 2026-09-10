#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  echo "Usage: ./server/deploy.sh <chrome-id> <edge-id> [--config FILE] [--test]"
  echo "Live deployments require the published Chrome and Edge extension IDs."
}

CONFIG="wrangler.toml"
MODE="live"
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

if [[ ! -f "$CONFIG" ]] || (( ${#IDS[@]} < 1 || ${#IDS[@]} > 2 )); then
  usage
  exit 1
fi
if [[ "$MODE" == "live" && ${#IDS[@]} -ne 2 ]]; then
  echo "Live deployment requires both published extension IDs."
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
  ORIGINS="${ORIGINS:+${ORIGINS},}${origin}"
done

grep -q '^ALLOWED_ORIGINS = ' "$CONFIG" || { echo "ALLOWED_ORIGINS is missing from config"; exit 1; }
grep -q '^DODO_MODE = ' "$CONFIG" || { echo "DODO_MODE is missing from config"; exit 1; }
SOURCE_CONFIG="$CONFIG"
TMP_CONFIG="$(mktemp "${CONFIG}.XXXXXX")"
cleanup() { rm -f "$TMP_CONFIG"; }
trap cleanup EXIT
sed -E \
  -e "s|^ALLOWED_ORIGINS = \".*\"$|ALLOWED_ORIGINS = \"${ORIGINS}\"|" \
  -e "s|^DODO_MODE = \".*\"$|DODO_MODE = \"${MODE}\"|" \
  "$SOURCE_CONFIG" > "$TMP_CONFIG"
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
