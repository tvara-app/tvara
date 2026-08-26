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

-- One trial per proven device, remembered server-side.
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
