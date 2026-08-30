-- Tvara entitlement issuer — D1 schema.
--
-- Applied by ./deploy.sh. Everything here was in KV before, and moved for one
-- reason: KV `get` is edge-cached and `put` is eventually consistent, so two
-- edges can disagree for as long as a minute. That is fine for a rate-limit
-- brake and wrong for a ledger that decides who is Pro, how many seats a
-- licence has spent, and whether a nonce has already been used.
--
-- The rate-limit buckets stay in KV on purpose. They were never a bound.

-- The seat ledger. One row per (licence, proven device).
-- PRIMARY KEY is what makes a double-claim a no-op instead of a sixth seat.
CREATE TABLE IF NOT EXISTS seats (
  key_fp    TEXT    NOT NULL,
  dev_fp    TEXT    NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (key_fp, dev_fp)
);
CREATE INDEX IF NOT EXISTS seats_by_key ON seats (key_fp);

-- Single-use nonces. INSERT ... ON CONFLICT DO NOTHING is atomic here, so
-- "did I already see this?" and "claim it" are one statement rather than the
-- get-then-put race KV forced.
CREATE TABLE IF NOT EXISTS nonces (
  id         TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nonces_by_expiry ON nonces (expires_at);

-- One trial per proven device, remembered server-side. Still WRITTEN, not just
-- read: identity closes "uninstall and reinstall", and this closes the cheaper
-- one next to it — verifying a second address on the same install. See
-- stampDeviceTrial() in entitlement-worker.js.
CREATE TABLE IF NOT EXISTS trials (
  dev_fp     TEXT    PRIMARY KEY,
  started_at INTEGER NOT NULL
);

-- The kill list. A row here refuses a licence at the next /entitlement call
-- instead of waiting out the token, which is the only reason the token TTL can
-- stay long enough to survive an outage.
--
-- Rows are written BY HAND, deliberately — an upstream hiccup must never be
-- able to revoke a purchase on its own:
--
--   wrangler d1 execute tvara --remote --command \
--     "INSERT INTO revocations (key_fp, reason, at) VALUES ('<keyFp>', 'refunded', unixepoch()*1000)"
--
-- keyFp is the first 32 hex chars of SHA-256(licence key) — the same value the
-- token carries as `sub`, so it can be read off a support ticket without ever
-- asking the customer for the key itself.
CREATE TABLE IF NOT EXISTS revocations (
  key_fp TEXT PRIMARY KEY,
  reason TEXT,
  at     INTEGER NOT NULL
);

-- Webhook deliveries already applied. Standard Webhooks retries, and a retried
-- refund must not re-run the seat sweep. The row is claimed before the work and
-- deleted again if the work fails, so a failed delivery is still retryable.
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT    PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_events_by_at ON webhook_events (at);

-- Orders. The extension asks the worker to open a checkout; the worker owns the
-- session and this row is what ties the payment back to the install that
-- started it. Without it the only link between "someone paid" and "this browser
-- may have Pro" is a licence key pasted from an email, or worse, handed back in
-- a redirect URL where history, sync and every other extension can read it.
--
-- state moves created -> paid -> fulfilled, and never backwards. `refunded` is
-- terminal and set by the same webhook that writes the kill list.
--
-- lic_key holds the key only between fulfilment and the first claim by the
-- device that opened the order; the claim nulls it. A bearer secret at rest is
-- a liability with a shelf life, so it is given one.
CREATE TABLE IF NOT EXISTS orders (
  ref        TEXT    PRIMARY KEY,
  dev_fp     TEXT    NOT NULL,
  state      TEXT    NOT NULL,
  session_id TEXT,
  payment_id TEXT,
  customer   TEXT,
  lic_key    TEXT,
  key_fp     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_by_dev ON orders (dev_fp, created_at);
CREATE INDEX IF NOT EXISTS orders_by_payment ON orders (payment_id);

-- A licence key whose payment.succeeded has not arrived yet.
--
-- Dodo delivers license_key.created and payment.succeeded in either order.
-- Discarding a key that matched no order lost it permanently: the webhook was
-- answered 200, so it was never redelivered, and the buyer's claim never found
-- a key. Parked here, orderPaid() adopts it the moment its order appears.
-- Stored in the same encrypted form as orders.lic_key.
CREATE TABLE IF NOT EXISTS pending_keys (
  payment_id TEXT    PRIMARY KEY,
  lic_key    TEXT    NOT NULL,
  key_fp     TEXT    NOT NULL,
  at         INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
--  Identity. The anchor that survives an uninstall.
--
--  Everything above keys on dev_fp — a fingerprint of a keypair held in the
--  extension's own IndexedDB. Uninstalling destroys it, so the trial ledger it
--  keyed was resettable by removing the extension and adding it back, and a
--  paying customer's seat could not be re-claimed after a reinstall either.
--  Both are the same defect: no identity outlived the install.
--
--  The anchor is a VERIFIED email, held only as sha256(canonical email). The
--  raw address is never written here — the OTP path sends to it and forgets
--  it, the Google path reads it out of a signed id_token and forgets it.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per verified email, ever.
CREATE TABLE IF NOT EXISTS identities (
  email_fp   TEXT    PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  via        TEXT    NOT NULL          -- 'otp' | 'google', first route used
);

-- The verified address itself, ENCRYPTED (AES-GCM under a key derived from
-- SIGNING_KEY), kept apart from `identities` on purpose: that table is scanned
-- by the retention sweep and joined against, this one is only ever read by
-- email_fp. Separate table rather than a column so schema.sql stays CREATE
-- TABLE IF NOT EXISTS throughout — an ALTER would fail on the second deploy.
--
-- Nothing serves this back to a client. It exists so support can answer "which
-- address owns this licence" and so a person can be told what is held about
-- them; a dump of it is ciphertext.
CREATE TABLE IF NOT EXISTS identity_emails (
  email_fp   TEXT    PRIMARY KEY,
  email_enc  TEXT    NOT NULL,         -- base64url(iv . ciphertext)
  updated_at INTEGER NOT NULL
);

-- Codes in flight. `tries` is what stops a 6-digit code from being guessed:
-- the row is destroyed at OTP_MAX_TRIES, so the attacker gets a handful of
-- attempts per SEND, not per code.
CREATE TABLE IF NOT EXISTS otp_codes (
  email_fp   TEXT    PRIMARY KEY,
  code_hash  TEXT    NOT NULL,         -- sha256(code + email_fp + SIGNING_KEY)
  expires_at INTEGER NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otp_by_expiry ON otp_codes (expires_at);

-- The trial ledger, re-keyed onto identity.
--
-- `trials` (dev_fp) is NOT dropped, and is not a legacy table either. It is the
-- record of every week an INSTALL has spent, and claimIdentityTrial() reads it
-- on the way in and re-stamps it on the way out. Two things depend on that: an
-- install that predates identity does not get a second free week when its owner
-- first signs in, and a second address verified on that same install inherits
-- the week rather than minting one. Dropping it reopens both.
CREATE TABLE IF NOT EXISTS trials_id (
  email_fp   TEXT    PRIMARY KEY,
  started_at INTEGER NOT NULL
);

-- Who owns a licence. This is what makes Pro come back after a reinstall
-- without the buyer pasting a key out of an email.
--
-- lic_key is stored ENCRYPTED (AES-GCM under a key derived from SIGNING_KEY),
-- because /entitlement re-validates against the payment provider and that call
-- needs the key itself. A dump of this table is not a pile of working licences.
CREATE TABLE IF NOT EXISTS owners (
  key_fp   TEXT    NOT NULL,
  email_fp TEXT    NOT NULL,
  lic_enc  TEXT,                       -- base64url(iv . ciphertext), may be null
  bound_at INTEGER NOT NULL,
  PRIMARY KEY (key_fp, email_fp)
);
CREATE INDEX IF NOT EXISTS owners_by_email ON owners (email_fp);

-- ─────────────────────────────────────────────────────────────────────────────
--   Retention. sweepLedgers() in entitlement-worker.js runs these columns on a
--   daily cron; without an index each pass is a full scan of a table that only
--   ever grows. `revocations` and `owners` are deliberately absent from that
--   sweep — a refund is permanent, and an owner row is what makes a purchase
--   restorable after a reinstall.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS seats_by_seen      ON seats (last_seen);
CREATE INDEX IF NOT EXISTS trials_by_start    ON trials (started_at);
CREATE INDEX IF NOT EXISTS trials_id_by_start ON trials_id (started_at);
CREATE INDEX IF NOT EXISTS identities_by_seen ON identities (first_seen);
CREATE INDEX IF NOT EXISTS orders_by_created  ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_by_updated  ON orders (updated_at);
CREATE INDEX IF NOT EXISTS identity_emails_by_seen ON identity_emails (updated_at);
