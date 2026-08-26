/**
 * Tvara — entitlement issuer (Cloudflare Worker).
 *
 * The one place a client cannot patch. Holds three secrets:
 *   DODO_API_KEY   — server-side licence validation
 *   SIGNING_KEY    — ECDSA P-256 PKCS8, base64. Pair of lib/entitlement.js's public key.
 *   ARCHIVE_SECRET — HMAC root for the per-licence archive stamp. Separate from
 *                    SIGNING_KEY on purpose: archiveSecret() falls back to the
 *                    signing key when this is unset, which silently ties every
 *                    sealed backup to a key you may one day want to rotate.
 *
 * POST /entitlement {v,license_key,device_pub,nonce,ts,sig,instance_id?} -> {token}
 * POST /trial       {v,device_pub,nonce,ts,sig}                        -> {startedAt,already,ks}
 * POST /devices        {v,license_key,device_pub,nonce,ts,sig}          -> {seats:[...]}
 * POST /devices/revoke {v,license_key,target,device_pub,nonce,ts,sig}   -> {ok,seats}
 * Token: LCT2.<b64url(payload)>.<b64url(P1363 sig)>, bound to key + device, 30d.
 *
 * ---------------------------------------------------------------------------
 * THE AUTHENTICATION LADDER, and what each rung is actually worth.
 *
 * Being precise about this matters, because the extension ships unminified by
 * design — anyone can read it, and anyone can patch their own copy. Pretending
 * otherwise produces security theatre, so each step below is labelled with the
 * attacker it stops and the attacker it does not.
 *
 *   1. Origin pin        Stops OTHER EXTENSIONS in a real browser. Stops curl
 *                        not at all: an Origin header is a string a script
 *                        sets to whatever it likes. It is a cheap filter, and
 *                        it is listed first so nobody mistakes it for auth.
 *
 *   2. Freshness (ts)    Bounds a captured request to a 5-minute life.
 *
 *   3. Nonce (single     Kills replay INSIDE that window, which step 2 alone
 *      use, D1)          permits. Each request is usable exactly once, and in
 *                        D1 the check and the claim are one atomic statement
 *                        rather than the get-then-put race KV forced.
 *
 *   4. Device proof      THE REAL ONE. The client signs the request with an
 *      (ECDSA P-256)     ECDSA key generated at install as NON-EXTRACTABLE and
 *                        held in IndexedDB. WebCrypto will not export it — not
 *                        to the page, not to DevTools, not to the user who
 *                        owns the machine. So a caller cannot claim a device
 *                        identity it does not physically hold, and `device` is
 *                        derived from the proven key rather than declared in
 *                        the body. This is what makes the seat ledger below
 *                        mean something: sharing a licence key is no longer
 *                        enough, because the seat is bound to a key nobody can
 *                        copy off the machine that made it.
 *
 *   5. Licence validity  Dodo, called server-side with an API key the client
 *                        has never held. The authority on whether money was
 *                        actually paid.
 *
 *   6. Seat ledger       Five proven devices. Server-side, survives a storage
 *                        wipe, and now unforgeable thanks to step 4.
 *
 *   7. Kill list         A revoked licence is refused at the next check, not
 *                        when its token finally expires. This is what lets the
 *                        token stay long enough to survive an outage without
 *                        making revocation take a season.
 *
 *   8. Signed token      30 days, ECDSA, bound to licence + device.
 *
 * What none of this stops: someone editing their own copy of lib/entitlement.js
 * to skip the check entirely. That is unwinnable on any client, it is the price
 * of shipping readable code, and it was the right trade. This ladder defends
 * the SERVER and the seat economy, not the client binary.
 * ---------------------------------------------------------------------------
 *
 * Deploy — use ./deploy.sh, which does all of this and then proves it works:
 *   wrangler secret put DODO_API_KEY
 *   wrangler secret put SIGNING_KEY      # node tools/genkey.mjs worker-key
 *   wrangler secret put ARCHIVE_SECRET   # openssl rand -base64 32
 *   wrangler deploy
 *
 * Bindings expected:
 *   DB      — D1. Seats, nonces, trials, revocations. The ledgers that decide.
 *   RL      — KV. Rate-limit buckets and the sharing observer, plus the seat
 *             and trial records written before D1 existed, which are imported
 *             on first touch and then never read again.
 *   EDGE_RL — optional Cloudflare rate-limit binding, keyed on IP. The hard
 *             bound the KV counters never were.
 *
 * Every one of them degrades OPEN. A ledger that is unreachable must not be
 * able to unsell a licence somebody paid for.
 */

/* Was 90 days. Shortened because there is now a kill list: revocation no
   longer has to wait out the token, so the token no longer has to be short to
   make revocation possible. 30 days is still far longer than any outage the
   client's offline path is meant to survive — see lib/entitlement.js, where
   age alone never withdraws a purchase. */
const TTL_MS = 30 * 864e5;

/* Deliberately NOT TTL_MS. Seat eviction asks "has this device been gone long
   enough to be gone?", and that answer must not change because the token
   lifetime moved. Shortening TTL_MS used to silently make seats three times
   easier to evict out from under an occasional-use machine. */
const SEAT_IDLE_MS = 90 * 864e5;

const FEATURES = ["archive.search", "archive.backup", "archive.restore"];
const SEAT_LIMIT = 5;

/* Protocol version. Bumped from 2 when the device proof (step 4) became
   mandatory. A v2 client sends no signature, so accepting one would leave the
   whole ladder optional — the worker refuses it with a message that tells the
   user to update rather than a generic 400. */
const PROTOCOL = 3;

/* A nonce only has to outlive the freshness window: past it, step 2 rejects
   the request anyway and the record is dead weight. Twice the skew is the
   whole useful life of one. */
const NONCE_TTL_S = 600;

const RL_MAX = 20;              // requests per key per window
const RL_WINDOW_S = 3600;
const RL_TRIAL_IP_MAX = 10;     // /trial calls per IP per window

/* A trial record outlives the 7-day trial by a wide margin on purpose: its job
   is to still be there when someone reinstalls in month four and expects the
   week they already spent to have been spent. */
const TRIAL_TTL_S = 400 * 86400;

/* Distinct IPs on one licence in 30 days that start to look like a key being
   passed around. Deliberately NOT enforced — see observeSharing(). */
const SHARE_IP_SOFT = 12;
const DODO_TIMEOUT_MS = 8000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;  // reject requests older than 5 min

/* ---------- codec ---------- */

const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256Hex(value, bytes = 16) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(String(value)));
  return [...new Uint8Array(digest).slice(0, bytes)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- device proof (step 4) ---------- */

/**
 * A field is a string or it is nothing.
 *
 * String() coercion looks harmless and is not: a JSON body carrying
 * `"license_key": 12345678` becomes the perfectly regex-valid string
 * "12345678", so a client that is not ours — or a caller probing types — gets
 * its input silently reshaped into something acceptable instead of refused.
 * Found by test/fuzz-worker.mjs, which generates non-string values for fields
 * every real client only ever sends as strings.
 */
function str(v) {
  return typeof v === "string" ? v : "";
}

function b64urlToBytes(str) {
  const norm = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * The exact bytes the client signs. Order is fixed and every field is
 * separated by a character that cannot appear inside one, so two different
 * request bodies can never produce the same signing input — the ambiguity that
 * turns a signature into a rubber stamp.
 *
 * Route is part of the string: a signature captured from /trial must not be
 * replayable against /entitlement.
 */
function signingInput(route, fields) {
  return ["LCT3", route, ...fields].join("\u001f");
}

/**
 * Verify that the caller holds the private half of `device_pub`.
 *
 * Returns the SPKI bytes on success so the caller can fingerprint them, and
 * null on any failure — a malformed key, a bad signature and a wrong curve are
 * deliberately indistinguishable from outside.
 */
async function verifyDeviceProof(devicePubB64, sigB64, input) {
  try {
    const spki = b64urlToBytes(devicePubB64);
    // P-256 SPKI is 91 bytes. Anything else is not the key we asked for, and
    // importKey is the expensive call we would rather not make to find out.
    if (spki.length !== 91) return null;
    const sig = b64urlToBytes(sigB64);
    // P1363: r||s, 32 bytes each. DER-wrapped signatures are rejected rather
    // than parsed — one accepted encoding means one code path.
    if (sig.length !== 64) return null;

    const key = await crypto.subtle.importKey(
      "spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const okSig = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, sig, enc.encode(input));
    return okSig ? spki : null;
  } catch { return null; }
}

/* ---------- D1 ---------- */

/**
 * The ledgers that decide, on storage that agrees with itself.
 *
 * WHY NOT KV. KV `get` is served from an edge cache and `put` propagates
 * eventually, so two colos can hold different answers for as long as a minute.
 * For a rate-limit brake that is acceptable and documented. For "has this
 * nonce been spent", "how many seats has this licence spent" and "is this
 * licence revoked" it is not: the window is exactly long enough to spend a
 * nonce twice, claim a sixth seat, or use a licence somebody revoked.
 *
 * D1 is one SQLite primary. A read reflects every write that preceded it.
 *
 * WHAT IT COSTS. A missing or failing DB degrades open, the same way the KV
 * paths always did — see the ladder at the top of this file. That is a real
 * trade and it is the right one here: a $1 one-time licence must not stop
 * working because our database had a bad afternoon. deploy.sh's smoke test is
 * what catches a binding that never got created.
 */
const d1 = (env) => (env && env.DB) || null;

/* ---------- nonce ledger (step 3) ---------- */

/**
 * One use per nonce. Step 2 already bounds a captured request to five minutes;
 * this closes the replays that fit inside them.
 *
 * In D1 the check and the claim are ONE statement: INSERT ... ON CONFLICT DO
 * NOTHING reports zero rows changed when the id was already there. The KV
 * version below could not do that — get-then-put let two simultaneous replays
 * both read "unseen" — and it is kept only for a deployment that has KV but no
 * D1 yet, where a leaky nonce check still beats no nonce check.
 *
 * The expiry sweep rides along in the same batch, so the table cleans itself
 * without a cron and without a random-sampling trick that would make this
 * function's behaviour depend on a coin flip.
 *
 * With neither binding this can only pass, deliberately: steps 1, 2, 4 and 5
 * (origin, freshness, device proof, upstream validation) all hold without
 * storage, so the residual threat is an attacker who ALREADY holds the device
 * key and the licence, replaying inside a five-minute window.
 */
async function seenNonce(env, nonce, devFp) {
  const id = `n:${await sha256Hex(nonce + ":" + devFp, 16)}`;
  const db = d1(env);
  if (db) {
    try {
      const now = Date.now();
      const res = await db.batch([
        db.prepare("DELETE FROM nonces WHERE expires_at < ?1").bind(now),
        db.prepare("INSERT INTO nonces (id, expires_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
          .bind(id, now + NONCE_TTL_S * 1000)
      ]);
      const claim = res && res[1];
      return ((claim && claim.meta && claim.meta.changes) || 0) === 0;
    } catch { return false; }
  }
  if (!env.RL) return false;
  try {
    if (await env.RL.get(id)) return true;
    await env.RL.put(id, "1", { expirationTtl: NONCE_TTL_S });
    return false;
  } catch {
    // An outage is not a verdict: steps 2, 4 and 6 are all still in force.
    return false;
  }
}

/* ---------- kill list (step 7) ---------- */

/**
 * Revocation that does not have to wait out a token.
 *
 * Without this, the only way to stop honouring a licence was to let its token
 * expire — 90 days of nothing we could do about a key that leaked or a payment
 * that was charged back. The table is written by hand (see schema.sql): an
 * upstream 403 is an answer about one call, not grounds to permanently retire
 * somebody's purchase, and that judgement stays with a person.
 *
 * Returns the reason string so support can see WHY without a second lookup,
 * and false when there is no D1 — a database we cannot reach must not be able
 * to revoke everyone at once.
 */
async function revoked(env, keyFp) {
  const db = d1(env);
  if (!db) return false;
  try {
    const row = await db.prepare("SELECT reason FROM revocations WHERE key_fp = ?1").bind(keyFp).first();
    return row ? String(row.reason || "revoked") : false;
  } catch { return false; }
}

/* ---------- origin policy ---------- */

/**
 * Only our own extension may call this. ALLOWED_ORIGINS is a comma-separated
 * env var of chrome-extension://<id> / moz-extension://<uuid> values.
 *
 * An unset list used to mean "any extension may call" — convenient in dev, and
 * a standing invitation on a live worker that spends KV writes and an upstream
 * API call per request. It now fails CLOSED in live mode: a deploy that forgot
 * the variable refuses everyone, including us, which is a bug we find in the
 * first minute rather than one we find on a bill. Test mode keeps the open
 * default so a scratch deploy is still one command.
 *
 * ALLOW_FIREFOX = "1" admits any moz-extension:// origin. Off unless the
 * Firefox build ships.
 */
function originAllowed(origin, env) {
  if (!origin) return false;
  if (!/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return false;
  /* Firefox mints a fresh moz-extension:// UUID per INSTALL, so no allow-list
     can name our own Firefox build — every Firefox user was a 403 on purchase,
     trial and revoke. Gate the scheme instead. The origin was only ever a cost
     gate; the device signature authorises the call, and it is verified before
     any nonce or upstream spend. */
  if (String(env.ALLOW_FIREFOX || "") === "1" && /^moz-extension:/i.test(origin)) return true;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) return list.includes(origin);
  return env.DODO_MODE === "test";
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...corsHeaders(origin)
    }
  });

/* ---------- rate limit ---------- */

/** Per-key window counter. Degrades open if KV is unavailable. */
/* HONEST LIMITS OF THIS COUNTER.
   KV `get` is edge-cached and `put` is eventually consistent, so a burst can
   all read the same value: RL_MAX is a brake, not a bound. It also used to key
   on the licence key alone — which the caller supplies — so a script sending a
   fresh random key per request was never counted at all, while each request
   still cost one upstream Dodo call. The IP bucket below is what actually
   bounds an attacker; the key bucket bounds a leaked key being shared.
   For a hard bound, put Cloudflare's Rate Limiting binding on CF-Connecting-IP
   in front of this worker — that is enforced at the edge, not in KV. */
const RL_IP_MAX = 60;          // per IP per window, across all keys

async function rateLimited(env, keyFp, ip) {
  if (!env.RL) return false;
  const slot = Math.floor(Date.now() / (RL_WINDOW_S * 1000));
  const bucket = `rl:${keyFp}:${slot}`;
  const ipBucket = `rlip:${await sha256Hex(ip || "unknown", 16)}:${slot}`;
  try {
    const ipSeen = Number(await env.RL.get(ipBucket)) || 0;
    if (ipSeen >= RL_IP_MAX) return true;
    await env.RL.put(ipBucket, String(ipSeen + 1), { expirationTtl: RL_WINDOW_S * 2 });

    const seen = Number(await env.RL.get(bucket)) || 0;
    if (seen >= RL_MAX) return true;
    await env.RL.put(bucket, String(seen + 1), { expirationTtl: RL_WINDOW_S * 2 });
    // Track distinct IPs per key — sharing shows up here before seats do.
    await env.RL.put(`ip:${keyFp}:${await sha256Hex(ip, 8)}`, "1", { expirationTtl: 30 * 86400 });
    return false;
  } catch { return false; }
}

/* ---------- trial ledger ---------- */

/**
 * One trial per device fingerprint, remembered HERE rather than on the client.
 *
 * This endpoint was deleted once, on the reasoning that the client already
 * keeps the date in chrome.storage.sync and nothing called this. Both halves
 * were wrong. bg.js's startTrial() does call it, so its absence was a client
 * talking to a 404; and storage.sync is only durable while the browser is
 * SIGNED IN — a fresh profile, or a signed-out Chrome, silently falls back to
 * local storage and mints a brand-new week, every time, for free.
 *
 * The honest limit: devFp comes from the client, so anyone willing to forge a
 * new one still gets a new trial. This stops the version of trial farming that
 * costs nothing to perform (make a profile, reinstall), not the deliberate
 * one. That is the whole intent — the deliberate farmer was never a customer.
 *
 * Returns null when there is no ledger to remember with, and the caller falls
 * back to its own clock: a free week is not worth refusing to work over.
 */
async function claimTrial(env, devFp) {
  const db = d1(env);
  if (db) {
    try {
      const seen = await db.prepare("SELECT started_at FROM trials WHERE dev_fp = ?1").bind(devFp).first();
      if (seen) return { startedAt: Number(seen.started_at) || 0, already: true };

      /* The week they already spent, if they spent it before D1 existed.
         Skipping this would hand a second free trial to every device that ever
         started one — the exact farming the ledger is here to stop. */
      const carried = await trialFromKV(env, devFp);
      const startedAt = carried || Date.now();
      await db.prepare("INSERT INTO trials (dev_fp, started_at) VALUES (?1, ?2) ON CONFLICT(dev_fp) DO NOTHING")
        .bind(devFp, startedAt).run();
      const row = await db.prepare("SELECT started_at FROM trials WHERE dev_fp = ?1").bind(devFp).first();
      const at = Number(row && row.started_at) || startedAt;
      return { startedAt: at, already: Boolean(carried) || at !== startedAt };
    } catch { /* fall through to KV rather than refuse a trial over an outage */ }
  }
  if (!env.RL) return null;
  const ledgerKey = `trial:${devFp}`;
  try {
    const prior = Number(await env.RL.get(ledgerKey)) || 0;
    if (prior) return { startedAt: prior, already: true };
    const now = Date.now();
    await env.RL.put(ledgerKey, String(now), { expirationTtl: TRIAL_TTL_S });
    return { startedAt: now, already: false };
  } catch { return null; }
}

/** The pre-D1 trial record, or 0. Never throws: a missing carry-over costs a
 *  free week, and a thrown one would cost the whole request. */
async function trialFromKV(env, devFp) {
  if (!env.RL) return 0;
  try { return Number(await env.RL.get(`trial:${devFp}`)) || 0; } catch { return 0; }
}

/**
 * /trial takes no licence key, so the per-key bucket cannot bound it and the
 * IP bucket is all there is. A real client calls this ONCE per profile, ever —
 * startTrial() returns early once a record exists — so ten an hour is roomy
 * for a shared NAT and tight against a script.
 */
async function trialRateLimited(env, ip) {
  if (!env.RL) return false;
  const slot = Math.floor(Date.now() / (RL_WINDOW_S * 1000));
  const bucket = `rltrial:${await sha256Hex(ip || "unknown", 16)}:${slot}`;
  try {
    const seen = Number(await env.RL.get(bucket)) || 0;
    if (seen >= RL_TRIAL_IP_MAX) return true;
    await env.RL.put(bucket, String(seen + 1), { expirationTtl: RL_WINDOW_S * 2 });
    return false;
  } catch { return false; }
}

/* ---------- sharing observer ---------- */

/**
 * rateLimited() has been writing `ip:<keyFp>:<ipHash>` for 30 days and nothing
 * has ever read it. This reads it.
 *
 * It does NOT deny anything, and that is a decision rather than an omission.
 * Distinct-IP count is a genuinely noisy signal — a VPN, a phone on cellular,
 * an office and a coffee shop are four IPs belonging to one honest person —
 * and refusing a paying customer costs more than the sharing does. So a
 * licence over the threshold gets a `flag:<keyFp>` record instead of a 403,
 * and the decision stays with a human:
 *
 *     wrangler kv key list --binding RL --prefix flag:
 *
 * If the flags turn out to be real rather than noise, the enforcement point is
 * one line in the handler. Until they do, this is evidence, not a verdict.
 */
async function observeSharing(env, keyFp) {
  if (!env.RL) return 0;
  try {
    const listed = await env.RL.list({ prefix: `ip:${keyFp}:`, limit: 100 });
    const n = (listed && listed.keys && listed.keys.length) || 0;
    if (n >= SHARE_IP_SOFT) {
      await env.RL.put(`flag:${keyFp}`, JSON.stringify({ ips: n, at: Date.now() }),
        { expirationTtl: 90 * 86400 });
      console.log(`sharing-watch ${keyFp} ${n} distinct IPs in 30d`);
    }
    return n;
  } catch { return 0; }
}

/* ---------- Dodo ---------- */

/**
 * Authoritative licence check. Validate is the same endpoint the extension can
 * reach, but calling it here means the answer reaches signing code the client
 * never touches. The secret key adds the customer record on top.
 */
async function dodoValidate(env, licenseKey, instanceId) {
  /* Without the secret, /licenses/validate still answers — it is the same
     public endpoint the client can reach — so the worker went on issuing
     signed 90-day tokens with no customer record behind them and `email` empty
     everywhere downstream. A deployment missing its key is a misconfigured
     deployment, and it should say so rather than quietly sign things. */
  if (!env.DODO_API_KEY) return { branch: "service" };

  const base = env.DODO_MODE === "test"
    ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
  const body = { license_key: licenseKey };
  if (instanceId) body.license_key_instance_id = instanceId;

  let res;
  try {
    res = await fetch(base + "/licenses/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(env.DODO_API_KEY ? { Authorization: `Bearer ${env.DODO_API_KEY}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DODO_TIMEOUT_MS)
    });
  } catch {
    return { branch: "service" };
  }

  if (res.status === 404) return { branch: "notfound" };
  if (res.status === 403) return { branch: "inactive" };
  if (res.status === 422) return { branch: "limit" };
  if (res.status >= 500) return { branch: "service" };
  if (!res.ok) return { branch: "badrequest" };

  let data;
  try { data = await res.json(); } catch { return { branch: "service" }; }

  // Only a literal true is a pass. Missing field is not consent.
  if (data && data.valid === true) {
    return { branch: "ok", email: (data.customer && data.customer.email) || "" };
  }
  return { branch: "invalid" };
}

/* ---------- seat ledger ---------- */

/**
 * Server-side device count. lib/dodo.js keeps a client registry for UX; this is
 * the copy that decides. Clearing extension storage does not reset it.
 */
async function claimSeat(env, keyFp, devFp) {
  const db = d1(env);
  if (db) {
    try {
      const rows = await seatRows(db, env, keyFp);
      const now = Date.now();
      const held = rows.some((r) => r.dev_fp === devFp);
      const writes = [];

      if (!held && rows.length >= SEAT_LIMIT) {
        // Evict only genuinely idle seats; an active fleet must hit the wall.
        const stale = rows
          .filter((r) => now - Number(r.last_seen) > SEAT_IDLE_MS)
          .sort((a, b) => Number(a.last_seen) - Number(b.last_seen));
        if (!stale.length) return { ok: false, seats: rows.length };
        writes.push(db.prepare("DELETE FROM seats WHERE key_fp = ?1 AND dev_fp = ?2")
          .bind(keyFp, stale[0].dev_fp));
      }

      writes.push(db.prepare(
        "INSERT INTO seats (key_fp, dev_fp, last_seen) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key_fp, dev_fp) DO UPDATE SET last_seen = excluded.last_seen"
      ).bind(keyFp, devFp, now));

      // One transaction: the eviction and the claim that depends on it cannot
      // half-apply and leave the licence a seat short.
      await db.batch(writes);
      return { ok: true, seats: await seatCount(db, keyFp) };
    } catch {
      return { ok: true, seats: 0 };  // a DB outage must not lock a paying user out
    }
  }

  if (!env.RL) return { ok: true, seats: 0 };
  const ledgerKey = `seats:${keyFp}`;
  try {
    const raw = await env.RL.get(ledgerKey, "json");
    const seats = (raw && typeof raw === "object" ? raw : {});
    const now = Date.now();

    if (!seats[devFp] && Object.keys(seats).length >= SEAT_LIMIT) {
      const stale = Object.entries(seats)
        .filter(([, t]) => now - Number(t) > SEAT_IDLE_MS)
        .sort((a, b) => Number(a[1]) - Number(b[1]));
      if (!stale.length) return { ok: false, seats: Object.keys(seats).length };
      delete seats[stale[0][0]];
    }

    seats[devFp] = now;
    await env.RL.put(ledgerKey, JSON.stringify(seats), { expirationTtl: 400 * 86400 });
    return { ok: true, seats: Object.keys(seats).length };
  } catch {
    return { ok: true, seats: 0 };   // KV down must not lock a paying user out
  }
}

/** Rows for one licence, importing the pre-D1 KV ledger the first time we find
 *  none. Without the import, moving to D1 would silently release every seat
 *  every licence had ever claimed. */
async function seatRows(db, env, keyFp) {
  const read = async () => {
    const res = await db.prepare("SELECT dev_fp, last_seen FROM seats WHERE key_fp = ?1").bind(keyFp).all();
    return (res && res.results) || [];
  };
  const rows = await read();
  if (rows.length || !env.RL) return rows;

  let raw;
  try { raw = await env.RL.get(`seats:${keyFp}`, "json"); } catch { return rows; }
  if (!raw || typeof raw !== "object") return rows;
  const carried = Object.entries(raw).slice(0, SEAT_LIMIT);
  if (!carried.length) return rows;

  try {
    await db.batch(carried.map(([fp, seen]) => db.prepare(
      "INSERT INTO seats (key_fp, dev_fp, last_seen) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(key_fp, dev_fp) DO NOTHING"
    ).bind(keyFp, String(fp), Number(seen) || 0)));
  } catch { return rows; }
  return read();
}

async function seatCount(db, keyFp) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM seats WHERE key_fp = ?1").bind(keyFp).first();
  return Number(row && row.n) || 0;
}

/**
 * The seat list, as the ledger actually holds it.
 *
 * This is the copy that DECIDES, and until now nothing could read it. The
 * client kept its own list in chrome.storage.sync and showed that instead —
 * which is a different list, scoped to one Google account, and silently
 * disagreed with this one the moment a seat was released.
 */
async function readSeats(env, keyFp) {
  const db = d1(env);
  if (db) {
    try {
      const out = {};
      for (const r of await seatRows(db, env, keyFp)) out[r.dev_fp] = Number(r.last_seen) || 0;
      return out;
    } catch { return null; }
  }
  if (!env.RL) return null;
  try {
    const raw = await env.RL.get(`seats:${keyFp}`, "json");
    return (raw && typeof raw === "object") ? raw : {};
  } catch { return null; }
}

/**
 * Give a seat back.
 *
 * The bug this closes: releasing a device used to call the payment provider's
 * deactivate endpoint and update the client's own registry, and never touched
 * THIS ledger at all. The seat stayed claimed here until it went 90 days
 * unused, so a user who sold a laptop, released it in the popup, and activated
 * a new one was told "device limit reached" by a server that had just watched
 * them free a slot. They had paid, done exactly the right thing, and been
 * refused — the single worst shape a bug can have in a paid product.
 *
 * Idempotent: releasing a seat that is already gone is a success, because from
 * the caller's point of view it is.
 */
async function releaseSeat(env, keyFp, targetFp) {
  const db = d1(env);
  if (db) {
    try {
      // Import first: releasing a seat the ledger has not carried over yet
      // would report success and free nothing.
      await seatRows(db, env, keyFp);
      await db.prepare("DELETE FROM seats WHERE key_fp = ?1 AND dev_fp = ?2").bind(keyFp, targetFp).run();
      return { ok: true, seats: await seatCount(db, keyFp) };
    } catch { return { ok: false, reason: "unavailable" }; }
  }
  if (!env.RL) return { ok: false, reason: "unavailable" };
  const ledgerKey = `seats:${keyFp}`;
  try {
    const raw = await env.RL.get(ledgerKey, "json");
    const seats = (raw && typeof raw === "object") ? raw : {};
    if (!seats[targetFp]) return { ok: true, seats: Object.keys(seats).length };
    delete seats[targetFp];
    await env.RL.put(ledgerKey, JSON.stringify(seats), { expirationTtl: 400 * 86400 });
    return { ok: true, seats: Object.keys(seats).length };
  } catch { return { ok: false, reason: "unavailable" }; }
}

/* ---------- archive stamp secret ---------- */

/**
 * A stable per-licence secret: HMAC(ARCHIVE_SECRET, keyFp). Same value for
 * every token this licence is ever issued, so a backup sealed today still
 * verifies after the token renews. Derived from a secret only this Worker
 * holds — a client cannot compute it, which is what makes the stamp mean
 * something.
 */
async function archiveSecret(env, keyFp) {
  const raw = String(env.ARCHIVE_SECRET || env.SIGNING_KEY || "");
  if (!raw) return "";
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode("lct-archive-v1:" + keyFp));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/* ---------- signing ---------- */

let signingKey = null;

async function getSigningKey(env) {
  if (signingKey) return signingKey;
  const raw = Uint8Array.from(atob(String(env.SIGNING_KEY || "")), (c) => c.charCodeAt(0));
  signingKey = await crypto.subtle.importKey(
    "pkcs8", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  return signingKey;
}

async function mintToken(env, claims) {
  const payload = enc.encode(JSON.stringify(claims));
  const key = await getSigningKey(env);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, payload);
  return `LCT2.${b64url(payload)}.${b64url(sig)}`;
}

/* ---------- refunds: the Dodo webhook ----------
 *
 * Until now a refund was two manual steps: refund in the dashboard, then hand-
 * write a revocations row. Step two is the one that gets forgotten, and the
 * result is a refunded customer keeping Pro indefinitely.
 *
 * schema.sql says revocation rows are written BY HAND so an upstream hiccup can
 * never revoke a purchase on its own. That still holds. This does not open the
 * kill list to Dodo generally — it opens it to two terminal events, verified by
 * signature, where the money has already left. Everything else is a no-op.
 */

const WEBHOOK_SKEW_MS = 5 * 60 * 1000;
const WEBHOOK_MAX_BODY = 64 * 1024;

/* Terminal only. dispute.opened is a claim, refund.failed is money that never
   moved; a revocation from either takes Pro from someone who still paid. */
const REVOKING = {
  "refund.succeeded": "refunded",
  "dispute.lost": "chargeback",
  "dispute.accepted": "chargeback"
};

/* Equal-length compare without an early exit. A length mismatch is already
   public from the header, so only this case needs the care. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Standard Webhooks: HMAC-SHA256 over "<id>.<timestamp>.<raw body>".
 * Returns "ok" | "unconfigured" | "malformed" | "stale" | "bad" — the caller
 * maps those to statuses, because they are not the same failure.
 */
async function verifyWebhook(env, headers, raw) {
  const secret = String(env.DODO_WEBHOOK_SECRET || "");
  if (!secret) return "unconfigured";

  const id = headers.get("webhook-id") || "";
  const ts = headers.get("webhook-timestamp") || "";
  const sigHeader = headers.get("webhook-signature") || "";
  if (!id || !ts || !sigHeader) return "malformed";

  // Freshness: without it a captured delivery replays forever.
  const when = Number(ts) * 1000;
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > WEBHOOK_SKEW_MS) return "stale";

  // whsec_ is a label; the secret is the base64 after it.
  const body = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes;
  try { keyBytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0)); }
  catch { return "unconfigured"; }

  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(id + "." + ts + "." + raw));
  const want = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Space-separated "<version>,<signature>" pairs: during a secret rotation
  // more than one is valid at once.
  for (const part of sigHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) !== "v1") continue;
    if (timingSafeEqual(part.slice(comma + 1), want)) return "ok";
  }
  return "bad";
}

/**
 * One delivery, one effect. Deliveries retry, and a retry must not re-run the
 * seat sweep. Claimed before the work, released if the work fails — a claim
 * held over a failure would swallow the retry that was going to fix it.
 */
async function claimWebhook(env, id) {
  const db = d1(env);
  if (!db) return true;                       // no ledger: revoking twice is a no-op
  try {
    const r = await db.prepare(
      "INSERT INTO webhook_events (id, at) VALUES (?1, ?2) ON CONFLICT DO NOTHING"
    ).bind(id, Date.now()).run();
    return (r.meta.changes || 0) > 0;
  } catch { return true; }
}

async function releaseWebhook(env, id) {
  const db = d1(env);
  if (!db) return;
  try { await db.prepare("DELETE FROM webhook_events WHERE id = ?1").bind(id).run(); }
  catch { /* the retry re-claims or re-runs; neither is harmful */ }
}

/**
 * A refund names a payment and a customer, never a licence — Dodo issues the
 * licence as a separate object. Ask which keys the customer holds and keep the
 * one this payment bought.
 *
 * { ok:false } means we could not find out, which is not the same as "there was
 * none" and must be retried rather than treated as nothing to do.
 */
async function licencesForRefund(env, data) {
  if (!env.DODO_API_KEY) return { ok: false, keys: [] };
  const customerId = String((data && data.customer && data.customer.customer_id) || "");
  const paymentId = String((data && data.payment_id) || "");
  if (!customerId) return { ok: true, keys: [] };

  const base = env.DODO_MODE === "test"
    ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
  let res;
  try {
    res = await fetch(base + "/license_keys?page_size=100&customer_id=" + encodeURIComponent(customerId), {
      headers: { Authorization: "Bearer " + env.DODO_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(DODO_TIMEOUT_MS)
    });
  } catch { return { ok: false, keys: [] }; }
  if (!res.ok) return { ok: false, keys: [] };

  let payload;
  try { payload = await res.json(); } catch { return { ok: false, keys: [] }; }
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const keysOf = (list) => list.map((k) => String((k && k.key) || "")).filter(Boolean);

  // Only what this payment bought. Revoking every key a customer holds because
  // one of several purchases was refunded is the wrong blast radius.
  if (paymentId) return { ok: true, keys: keysOf(items.filter((k) => k && k.payment_id === paymentId)) };

  /* No payment on the event, so nothing attributes it. One licence is still
     unambiguous. Several is a guess, and guessing wrong takes Pro from a
     purchase nobody refunded — so it revokes none and reports the ambiguity for
     a human, which is what the kill list was always meant to need. */
  if (items.length === 1) return { ok: true, keys: keysOf(items) };
  return { ok: true, keys: [], ambiguous: items.length };
}

/** Kill list plus seats: a refunded licence holding five of five would refuse
    the owner's next purchase from the same machines. */
async function revokeLicence(env, keyFp, reason) {
  const db = d1(env);
  if (!db) return false;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO revocations (key_fp, reason, at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key_fp) DO UPDATE SET reason = excluded.reason, at = excluded.at"
      ).bind(keyFp, reason, Date.now()),
      db.prepare("DELETE FROM seats WHERE key_fp = ?1").bind(keyFp)
    ]);
    return true;
  } catch { return false; }
}

async function handleWebhook(request, env) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > WEBHOOK_MAX_BODY) return json({ error: "too large" }, 413, "");
  const raw = await request.text();
  if (raw.length > WEBHOOK_MAX_BODY) return json({ error: "too large" }, 413, "");

  const verdict = await verifyWebhook(env, request.headers, raw);
  if (verdict === "unconfigured") return json({ error: "webhook not configured" }, 503, "");
  if (verdict !== "ok") return json({ error: "bad signature" }, 401, "");

  let evt;
  try { evt = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400, ""); }

  const type = String((evt && evt.type) || "");
  const reason = REVOKING[type];
  // 200 for anything we do not act on: a 4xx here is retried until Dodo
  // disables the endpoint, taking the events we DO act on with it.
  if (!reason) return json({ ok: true, ignored: type }, 200, "");

  const id = request.headers.get("webhook-id") || "";
  if (!(await claimWebhook(env, id))) return json({ ok: true, duplicate: true }, 200, "");

  const found = await licencesForRefund(env, (evt && evt.data) || {});
  if (!found.ok) {
    await releaseWebhook(env, id);
    return json({ error: "upstream" }, 500, "");     // 5xx: please retry
  }

  let revoked = 0;
  for (const key of found.keys) {
    if (await revokeLicence(env, await sha256Hex(key), reason)) revoked++;
  }
  // Resolved keys but wrote nothing: the ledger is down, not the refund absent.
  if (found.keys.length && !revoked) {
    await releaseWebhook(env, id);
    return json({ error: "ledger" }, 500, "");
  }
  /* Surfaced rather than swallowed: Worker Traces is where an operator finds
     out a refund arrived that nobody could attribute. */
  if (found.ambiguous) {
    console.warn("dodo webhook: " + type + " with no payment_id and " +
      found.ambiguous + " licences for the customer — revoked nothing");
    return json({ ok: true, revoked: 0, ambiguous: found.ambiguous }, 200, "");
  }
  return json({ ok: true, revoked }, 200, "");
}

/* ---------- handler ---------- */

export default {
  async fetch(request, env) {
    /* Dodo's webhook, ahead of the origin gate: a server-to-server call carries
       no Origin and no device proof. Its own signature is the authentication,
       and handleWebhook checks it before the body is trusted for anything. */
    if (new URL(request.url).pathname === "/webhook/dodo") {
      if (request.method !== "POST") return json({ error: "method" }, 405, "");
      return handleWebhook(request, env);
    }

    const origin = request.headers.get("Origin") || "";

    /* ---------- step 1: origin ---------- */
    if (request.method === "OPTIONS") {
      if (!originAllowed(origin, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!originAllowed(origin, env)) return new Response("forbidden", { status: 403 });
    if (request.method !== "POST") return json({ error: "method" }, 405, origin);

    /* ---------- edge rate limit ----------
       The KV counters further down are a brake: their get-then-put races, so a
       burst can slip through. This is the bound. It runs at the edge before the
       body is read, so a flood costs us one binding call rather than a parse, a
       signature verify and a KV round trip.

       Optional, and failing open on purpose — a limiter we cannot reach must
       not become an outage. The KV brakes still apply either way. */
    if (env.EDGE_RL) {
      try {
        const seen = await env.EDGE_RL.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
        if (seen && seen.success === false) return json({ error: "slow down" }, 429, origin);
      } catch { /* not a verdict */ }
    }

    const url = new URL(request.url);
    const route = url.pathname;
    const ROUTES = ["/entitlement", "/trial", "/devices", "/devices/revoke"];
    if (!ROUTES.includes(route)) return json({ error: "not found" }, 404, origin);
    // Everything except /trial is scoped to a licence.
    const needsLicence = route !== "/trial";

    /* A body cap before parsing. request.json() on an unbounded stream is a
       memory cost an unauthenticated caller gets to choose. */
    const declaredLen = Number(request.headers.get("Content-Length") || 0);
    if (declaredLen > 8192) return json({ error: "too large" }, 413, origin);

    let body;
    try {
      const text = await request.text();
      if (text.length > 8192) return json({ error: "too large" }, 413, origin);
      body = JSON.parse(text);
    } catch { return json({ error: "bad json" }, 400, origin); }
    if (!body || typeof body !== "object") return json({ error: "bad json" }, 400, origin);

    /* ---------- protocol gate ----------
       v2 clients sent no device proof. Accepting them would make steps 3 and 4
       opt-out, which is the same as not having them, so this refuses with a
       verdict the popup can turn into "update Tvara" rather than a bare 400. */
    if (Number(body.v) !== PROTOCOL) {
      return json({ error: "outdated client", need: PROTOCOL }, 426, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "";
    const devicePub = str(body.device_pub);
    const nonce = str(body.nonce);
    const sig = str(body.sig);
    // Likewise: a timestamp is a number. "1700000000000" is a client we did not
    // write, and a freshness check is not the place to be accommodating.
    const clientTs = typeof body.ts === "number" && Number.isFinite(body.ts) ? body.ts : 0;

    // Shapes first: everything below costs CPU or a KV round trip, and none of
    // it should be spent on a body that was never going to be well-formed.
    if (devicePub.length < 80 || devicePub.length > 256) return json({ error: "bad device key" }, 400, origin);
    if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) return json({ error: "bad nonce" }, 400, origin);
    if (sig.length < 80 || sig.length > 128) return json({ error: "bad signature" }, 400, origin);

    /* ---------- step 2: freshness ----------
       Required, not optional. An optional freshness check is one a replayer
       defeats by deleting the field — and every client we ship sends it. */
    if (!clientTs) return json({ error: "stale request" }, 400, origin);
    if (Math.abs(Date.now() - clientTs) > MAX_CLOCK_SKEW_MS) {
      return json({ error: "clock skew" }, 400, origin);
    }

    const licenseKey = needsLicence ? str(body.license_key) : "";
    if (needsLicence && !/^[A-Za-z0-9._-]{8,64}$/.test(licenseKey)) {
      return json({ error: "bad key" }, 400, origin);
    }
    // The seat being revoked. Derived fingerprints only — 32 hex chars.
    const target = route === "/devices/revoke" ? str(body.target) : "";
    if (route === "/devices/revoke" && !/^[a-f0-9]{32}$/.test(target)) {
      return json({ error: "bad target" }, 400, origin);
    }

    /* ---------- step 4: device proof ----------
       Before the nonce is spent and before Dodo is called: an unsigned request
       must not be able to burn a nonce or an upstream call. The signed input
       carries the route and every field that matters, so a proof captured on
       one endpoint cannot be presented at the other, and no field can be
       swapped after signing. */
    const SIGN_FIELDS = {
      "/entitlement":    ["entitlement",    [licenseKey]],
      "/trial":          ["trial",          []],
      "/devices":        ["devices",        [licenseKey]],
      "/devices/revoke": ["devices-revoke", [licenseKey, target]]
    };
    const [signRoute, signFields] = SIGN_FIELDS[route];
    const input = signingInput(signRoute, [...signFields, devicePub, nonce, String(clientTs)]);

    const spki = await verifyDeviceProof(devicePub, sig, input);
    if (!spki) return json({ error: "device proof failed" }, 401, origin);

    // Derived from the PROVEN key, never taken from the body. This is the
    // single change that makes a seat something a caller has to hold rather
    // than something it gets to claim.
    const devFp = await sha256Hex(devicePub, 16);

    /* ---------- step 3: single use ---------- */
    if (await seenNonce(env, nonce, devFp)) {
      return json({ error: "replayed request" }, 409, origin);
    }

    /* ---------- /trial ----------
       No licence, so steps 5 and 6 do not apply. Everything above does: a
       trial now costs a real keypair and a signature, which is what stops the
       endpoint from being an open KV writer with our name on the bill. */
    if (route === "/trial") {
      if (await trialRateLimited(env, ip)) return json({ error: "slow down" }, 429, origin);

      const claimed = await claimTrial(env, devFp);
      // No ledger available: say so plainly rather than inventing a start date.
      // registerTrial() reads a missing startedAt as "issuer unreachable" and
      // falls back to the client clock, which is the correct outcome here.
      if (!claimed) return json({ error: "unavailable" }, 503, origin);

      return json({
        startedAt: claimed.startedAt,
        already: claimed.already,
        ks: await archiveSecret(env, "trial:" + devFp)
      }, 200, origin);
    }

    /* ---------- licence-scoped routes ---------- */
    const keyFp = await sha256Hex(licenseKey);

    /* ---------- step 7: kill list ----------
       Before the seat lookup and before Dodo, and covering /devices too: a
       revoked licence must not be able to keep managing seats it no longer
       owns. This is checked on every call rather than only at issue, which is
       the whole point — it is what makes revocation take minutes instead of
       the token's remaining life. */
    const killed = await revoked(env, keyFp);
    if (killed) return json({ error: "licence revoked", reason: killed }, 403, origin);

    /* ---------- /devices and /devices/revoke ----------
       Authorisation here is HOLDING A SEAT, not holding the key.
       
       That distinction is the whole reason these are worth having. If the key
       were enough, anyone who found one in a forum post could list a stranger's
       devices and kick them off all five — griefing that costs the attacker
       nothing and the owner everything, with no way for us to tell which of the
       two was real. Requiring a seat means the caller has already proved
       possession of a device key that this licence enrolled, which an outsider
       cannot obtain and cannot copy off the machine that made it.
       
       Deliberately NOT re-validated against Dodo: a seat can only exist because
       a validated activation created it, and spending an upstream call on every
       device-screen open buys nothing. */
    if (route === "/devices" || route === "/devices/revoke") {
      if (await rateLimited(env, keyFp, ip)) return json({ error: "slow down" }, 429, origin);

      const seats = await readSeats(env, keyFp);
      if (!seats) return json({ error: "unavailable" }, 503, origin);
      if (!seats[devFp]) return json({ error: "not enrolled" }, 403, origin);

      if (route === "/devices") {
        /* lastSeen only. No IP, no user agent, no location: this list is shown
           to whoever holds the key, which on a shared licence is not
           necessarily the person whose device is on it. Coarse by design. */
        return json({
          seats: Object.entries(seats).map(([fp, seen]) => ({
            device: fp, lastSeen: Number(seen) || 0, self: fp === devFp
          })).sort((a, b) => b.lastSeen - a.lastSeen),
          limit: SEAT_LIMIT
        }, 200, origin);
      }

      const freed = await releaseSeat(env, keyFp, target);
      if (!freed.ok) return json({ error: "unavailable" }, 503, origin);
      return json({ ok: true, seats: freed.seats, revoked: target }, 200, origin);
    }

    /* ---------- /entitlement ---------- */
    const instanceId = str(body.instance_id).slice(0, 64);

    if (await rateLimited(env, keyFp, ip)) return json({ error: "slow down" }, 429, origin);

    /* ---------- step 5: licence validity ---------- */
    const check = await dodoValidate(env, licenseKey, instanceId);
    if (check.branch === "notfound" || check.branch === "invalid") return json({ error: "unknown licence" }, 404, origin);
    if (check.branch === "inactive") return json({ error: "licence inactive" }, 403, origin);
    if (check.branch !== "ok") return json({ error: "upstream" }, 503, origin);

    // Evidence only; never blocks. See observeSharing().
    await observeSharing(env, keyFp);

    /* ---------- step 6: seat ---------- */
    const seat = await claimSeat(env, keyFp, devFp);
    if (!seat.ok) return json({ error: "device limit reached", seats: seat.seats }, 422, origin);

    /* ---------- step 8: token ---------- */
    const now = Date.now();
    const token = await mintToken(env, {
      v: 2,                       // token format, not protocol version
      sub: keyFp,
      dev: devFp,
      plan: "pro",
      feat: FEATURES,
      email: check.email || "",
      ks: await archiveSecret(env, keyFp),
      iat: now,
      exp: now + TTL_MS,
      jti: crypto.randomUUID()
    });

    return json({ token, exp: now + TTL_MS, seats: seat.seats }, 200, origin);
  }
};
