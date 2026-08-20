#!/usr/bin/env bash
#
# Back up the signing key. Run this before you need it.
#
#   ./tools/backup-keys.sh
#
# WHY THIS IS THE MOST IMPORTANT SCRIPT IN THE REPOSITORY
# ~/.lct-keys/private.pem is 241 bytes and exists in one place on one laptop.
# Every licence ever sold verifies against the public half of it, which is
# compiled into every copy of the extension in the world.
#
# Lose it and you cannot issue another key. Recovery means generating a new
# keypair, publishing a new version with a new public key, and every customer
# who already paid loses Pro on that day, permanently, with no way to fix it
# for them. There is no support ticket for this.
#
# So: one encrypted file, a passphrase you choose, and you put the result
# somewhere that is not this laptop. It is smaller than a photograph.
set -euo pipefail

KEYS="$HOME/.lct-keys"
OUT="$HOME/Downloads/tvara-signing-key-backup.enc"

[[ -f "$KEYS/private.pem" ]] || { echo "✋ No key at $KEYS/private.pem"; exit 1; }

echo
echo "This encrypts your signing key into one file you can store anywhere."
echo "The passphrase is the only way back. Nobody can reset it, including you."
echo

# AES-256 with a key stretched from the passphrase. Same reasoning as the
# extension's own backup format: the file is assumed to be readable by whoever
# finds it, so the passphrase is the whole defence.
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$KEYS/private.pem" -out "$OUT"

# Prove it round-trips NOW, rather than discovering it does not on the day the
# laptop is gone. An unverified backup is not a backup.
echo
echo "→ verifying the backup decrypts back to the original…"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$OUT" -out "$TMP" 2>/dev/null \
   && cmp -s "$TMP" "$KEYS/private.pem"; then
  echo "  ✓ verified: it decrypts to a byte-identical copy"
else
  echo "  ✋ THE BACKUP DID NOT VERIFY. Do not rely on it. Run this again."
  rm -f "$OUT"
  exit 1
fi

cat <<EOF

  Written: $OUT

  Now put it somewhere that is NOT this laptop. Any two of:
    · a password manager, as an attachment
    · a private cloud drive
    · a USB stick in a drawer
    · emailed to yourself

  It is encrypted, so the storage does not have to be trustworthy. The
  passphrase does. Store that separately, in the password manager.

  To restore:
    mkdir -p ~/.lct-keys
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \\
      -in tvara-signing-key-backup.enc -out ~/.lct-keys/private.pem

  Then check it still matches the key the shipped extension trusts:
    node tools/verify-keys.mjs

EOF
