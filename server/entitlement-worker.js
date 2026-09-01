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
 * POST /checkout       {v,device_pub,nonce,ts,sig}                      -> {ref,url}
 * POST /checkout/claim {v,ref,device_pub,nonce,ts,sig}                  -> {state,key?}
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
 *   9. Signed TRIAL      The free week is a signature too, not a date and a
 *                        boolean in the client's own storage. Same key, prefix
 *                        LCTT1, bound to identity + device, expiring exactly
 *                        when the week does. Without it the whole trial gate
 *                        was one DevTools edit, renewable weekly, forever.
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
 * Vars expected (wrangler.toml, not secrets):
 *   DODO_PRODUCT_ID — what /checkout sells. Here rather than on the marketing
 *                     site so price and provider move with a deploy, in
 *                     seconds, instead of with a page edit and a store review.
 *   RETURN_URL      — where the provider sends the buyer afterwards. Carries no
 *                     licence key: the extension claims its own order instead.
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

/* The trial week, as the ISSUER measures it. It has to live here because the
   client no longer decides: /trial hands back a signed token whose exp IS the
   end of the week, and lib/entitlement.js grants nothing the token does not
   say. Must stay equal to TRIAL_MS in bg.js — the client still draws the
   countdown from its own constant. */
const TRIAL_MS = 7 * 864e5;

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

/* Distinct IPs on one licence in 30 days that start to look like a key being
   passed around. Deliberately NOT enforced — see observeSharing(). */
const SHARE_IP_SOFT = 12;
const DODO_TIMEOUT_MS = 8000;

/* One definition. It was written out three times, and a fourth caller reaching
   for live while the other three were in test is a class of bug that only shows
   up as real money. */
const dodoBase = (env) =>
  env.DODO_MODE === "test" ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;  // reject requests older than 5 min

/* How long a paid order waits for `license_key.created` before the worker goes
   and asks. Long enough that the ordinary webhook wins the race and we spend no
   upstream call; short enough that a lost delivery costs the buyer seconds. */
const CLAIM_PULL_AFTER_MS = 20e3;

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
  if (!origin || !env) return false;
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

/* `extra` exists for Retry-After. A 429 with no wait in it leaves a client to
   guess, and the ones that guess wrong retry immediately — which is how a
   brake becomes the thing being braked against. */
const json = (body, status, origin, extra) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...corsHeaders(origin),
      ...(extra || {})
    }
  });

/** Seconds a throttled caller should wait, as a header the client already
 *  knows how to read. Rounded up: 0 would mean "immediately". */
const retryAfter = (ms) => ({ "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) });

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

/* ---------- identity: the anchor that outlives an install ----------
 *
 * WHY THIS EXISTS.
 *
 * Every ledger above this line keys on `devFp` — the fingerprint of a keypair
 * generated into the extension's own IndexedDB. That was the right anchor for
 * a seat (it proves a device) and the wrong one for a trial and for ownership,
 * because uninstalling the extension destroys it. Remove Tvara, add it back,
 * and you are a new device with a new week; a buyer who did the same lost the
 * licence record with it and burned a fresh seat re-activating.
 *
 * The anchor here is a VERIFIED EMAIL, reachable two ways:
 *
 *   /identity/start + /identity/verify   a 6-digit code we mail
 *   /identity/google                     a Google id_token we verify
 *
 * Both collapse to the same value — sha256 of the CANONICAL address — so one
 * person arriving by both routes is one identity, one trial, one owner row.
 *
 * WHAT IS STORED: the hash. Never the address. The OTP path mails it and drops
 * it; the Google path reads it out of a signed token and drops it. A dump of
 * `identities` is a list of opaque 32-hex strings that cannot be mailed.
 */

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_TRIES = 5;
/* Resend floor. Without it, "send code" is a mail cannon aimed at any address
   an attacker types, billed to us and landing in someone else's inbox. */
const OTP_RESEND_MS = 60 * 1000;
const OTP_SEND_IP_MAX = 8;              // sends per IP per RL_WINDOW_S
const OTP_SEND_EMAIL_MAX = 5;           // sends per address per RL_WINDOW_S

/* The identity token the client carries afterwards, so a verified user is not
   asked for a code on every call. Long, because its whole job is to be the
   thing that survives — and it is inert on its own: it names an identity, it
   does not grant entitlement. */
const IDENTITY_TTL_MS = 400 * 864e5;

/* Throwaway-mailbox domains. A short built-in list plus DISPOSABLE_EXTRA (a
   comma-separated env var) so a newly-popular one is a config change, not a
   deploy. This is a speed bump by design: the list can never be complete, and
   the canonicalisation below is what actually does the work. */
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "yopmail.com", "throwawaymail.com", "getnada.com",
  "trashmail.com", "sharklasers.com", "maildrop.cc", "dispostable.com",
  "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com"
]);

/**
 * The canonical form of an address, and the single most important function in
 * this file.
 *
 * Gmail treats `a.b@gmail.com`, `ab@gmail.com` and `ab+anything@gmail.com` as
 * ONE mailbox. Without folding those, a single Gmail account mints unlimited
 * trials at zero cost — a worse hole than the reinstall one this replaces,
 * because it needs no uninstall and no new account.
 *
 * Plus-addressing is folded for every domain, not only Gmail: it is close to
 * universal among providers that support it at all, and the cost of being
 * wrong is that two of one person's addresses share one trial. That is the
 * safe direction to be wrong in.
 *
 * Returns "" for anything that is not a plausible address.
 */
function canonicalEmail(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s.length < 6 || s.length > 254) return "";
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return "";
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  /* Split-then-test rather than one pattern with a nested quantifier. The
     readable regex for a domain backtracks catastrophically on a crafted
     address, and this runs on unauthenticated input. */
  if (!/^[a-z0-9._%+-]+$/.test(local)) return "";
  const labels = domain.split(".");
  if (labels.length < 2) return "";
  for (const label of labels) if (!/^[a-z0-9-]+$/.test(label)) return "";
  if (domain === "googlemail.com") domain = "gmail.com";
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? local + "@" + domain : "";
}


/** The stored form. 32 hex chars, and there is no way back to the address. */
const emailFpOf = (canonical) => sha256Hex("lct-identity-v1:" + canonical, 16);

function disposableDomain(canonical, env) {
  const domain = canonical.slice(canonical.lastIndexOf("@") + 1);
  if (DISPOSABLE.has(domain)) return true;
  const extra = String(env.DISPOSABLE_EXTRA || "").split(",").map((s) => s.trim().toLowerCase());
  return extra.includes(domain);
}

/* ---------- identity token ---------- */

/**
 * Signed by the same key that signs entitlements, with a different prefix and
 * a different payload shape so one can never be presented as the other.
 *
 * It carries no entitlement. Holding one says "this browser proved it can read
 * mail at some address"; what that buys is decided every time by the ledgers.
 */
async function mintIdentityToken(env, emailFp) {
  const key = await identityMacKey(env);
  if (!key) return "";
  const now = Date.now();
  const payload = enc.encode(JSON.stringify({ v: 1, efp: emailFp, iat: now, exp: now + IDENTITY_TTL_MS }));
  const mac = await crypto.subtle.sign("HMAC", key, payload);
  return `LCTID1.${b64url(payload)}.${b64url(mac)}`;
}

let idMacKey = null;

/* HMAC, not the ECDSA entitlement key. Nothing outside this Worker ever needs
   to verify an identity token — the extension only carries one — so a shared
   secret is the honest shape, and it keeps the signing key's public half out
   of a second job it was not issued for. */
async function identityMacKey(env) {
  if (idMacKey) return idMacKey;
  const raw = String(env.SIGNING_KEY || "");
  if (!raw) return null;
  const material = await crypto.subtle.digest("SHA-256", enc.encode("lct-identity-mac-v1:" + raw));
  try {
    idMacKey = await crypto.subtle.importKey(
      "raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  } catch { return null; }
  return idMacKey;
}

/**
 * The identity behind a token, or "".
 *
 * Fails CLOSED on a missing key: an unverifiable token is not a verified
 * identity, and treating it as one would make the whole anchor optional for
 * anyone who can type a JSON body.
 */
async function readIdentityClaims(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "LCTID1") return null;
  const key = await identityMacKey(env);
  if (!key) return null;
  let payload, mac;
  try { payload = b64urlToBytes(parts[1]); mac = b64urlToBytes(parts[2]); } catch { return null; }
  let ok;
  try { ok = await crypto.subtle.verify("HMAC", key, mac, payload); } catch { return null; }
  if (!ok) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(payload)); } catch { return null; }
  if (!claims || claims.v !== 1) return null;
  if (!/^[a-f0-9]{32}$/.test(String(claims.efp || ""))) return null;
  if (!(Number(claims.exp) > Date.now())) return null;
  return { efp: String(claims.efp), iat: Number(claims.iat) || 0 };
}


/* ---------- OTP ---------- */

/** Uniform over 000000-999999. Modulo of a single byte is not. */
function otpCode() {
  const buf = new Uint32Array(1);
  let n;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, "0");
}

/* Peppered with SIGNING_KEY so a stolen `otp_codes` table is not six-digit
   codes waiting to be rainbow-tabled — 10^6 is nothing without the pepper. */
const otpHash = (env, emailFp, code) =>
  sha256Hex("lct-otp-v1:" + emailFp + ":" + code + ":" + String(env.SIGNING_KEY || ""), 32);

async function otpSendLimited(env, emailFp, ip) {
  if (!env.RL) return false;
  const slot = Math.floor(Date.now() / (RL_WINDOW_S * 1000));
  const buckets = [
    [`rlotpip:${await sha256Hex(ip || "unknown", 16)}:${slot}`, OTP_SEND_IP_MAX],
    [`rlotpem:${emailFp}:${slot}`, OTP_SEND_EMAIL_MAX]
  ];
  for (const [bucket, max] of buckets) {
    try {
      const seen = Number(await env.RL.get(bucket)) || 0;
      if (seen >= max) return true;
      await env.RL.put(bucket, String(seen + 1), { expirationTtl: RL_WINDOW_S * 2 });
    } catch { /* a brake we cannot reach is not a refusal */ }
  }
  return false;
}

/**
 * Mail one code.
 *
 * Returns "sent" | "unconfigured" | "failed". `unconfigured` is its own answer
 * on purpose: it means the deploy has no mail sender, which the caller turns
 * into a 503 so the client falls back to an unverified trial rather than
 * showing the user a code entry box no code will ever arrive for.
 */
async function sendCodeMail(env, to, code) {
  const apiKey = String(env.MAIL_API_KEY || "");
  const from = String(env.MAIL_FROM || "");
  if (!apiKey || !from) return "unconfigured";
  const body = {
    from,
    to: [to],
    subject: `${code} is your Tvara code`,
    text: [
      `${code}`,
      "",
      "That is your Tvara verification code. It expires in 10 minutes.",
      "",
      "It ties your free trial and your purchase to you, so reinstalling",
      "Tvara — or moving to another browser — brings them back.",
      "",
      "If you did not ask for this, ignore it. Nothing has been started."
    ].join("\n")
  };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DODO_TIMEOUT_MS)
    });
    return res.ok ? "sent" : "failed";
  } catch { return "failed"; }
}

/**
 * Put a code in flight.
 *
 * The row is REPLACED on resend, so an older code stops working the moment a
 * newer one is asked for — two live codes double the guessing surface for no
 * benefit.
 */
async function startOtp(env, emailFp, email) {
  const db = d1(env);
  if (!db) return { ok: false, reason: "unavailable" };
  const now = Date.now();
  try {
    const prior = await db.prepare("SELECT sent_at FROM otp_codes WHERE email_fp = ?1").bind(emailFp).first();
    if (prior && now - Number(prior.sent_at) < OTP_RESEND_MS) {
      return { ok: false, reason: "too soon", retryInMs: OTP_RESEND_MS - (now - Number(prior.sent_at)) };
    }
  } catch { /* fall through: a read failure must not block a first send */ }

  const code = otpCode();
  const posted = await sendCodeMail(env, email, code);
  /* Write only AFTER the mail is away. A row for a code nobody received is a
     resend floor working against the user for a message that never existed. */
  if (posted !== "sent") return { ok: false, reason: posted };

  try {
    await db.prepare(
      /* `excluded.` rather than repeating ?2/?3/?4. A repeated parameter number
         is valid SQLite and is bound POSITIONALLY by some drivers, which makes
         the same statement need four arguments in one place and seven in
         another. This form has one argument per placeholder, everywhere. */
      "INSERT INTO otp_codes (email_fp, code_hash, expires_at, tries, sent_at) VALUES (?1, ?2, ?3, 0, ?4) " +
      "ON CONFLICT(email_fp) DO UPDATE SET code_hash = excluded.code_hash, " +
      "expires_at = excluded.expires_at, tries = 0, sent_at = excluded.sent_at"
    ).bind(emailFp, await otpHash(env, emailFp, code), now + OTP_TTL_MS, now).run();
  } catch { return { ok: false, reason: "unavailable" }; }
  return { ok: true, expiresInMs: OTP_TTL_MS };
}

/**
 * Spend a code.
 *
 * Every outcome deletes or increments, so nothing here is free to retry: a
 * wrong code costs one of five, and a right one costs the code itself.
 */
async function verifyOtp(env, emailFp, code) {
  const db = d1(env);
  if (!db) return { ok: false, reason: "unavailable" };
  let row;
  try {
    row = await db.prepare("SELECT code_hash, expires_at, tries FROM otp_codes WHERE email_fp = ?1")
      .bind(emailFp).first();
  } catch { return { ok: false, reason: "unavailable" }; }
  if (!row) return { ok: false, reason: "no code" };

  if (Number(row.expires_at) < Date.now()) {
    try { await db.prepare("DELETE FROM otp_codes WHERE email_fp = ?1").bind(emailFp).run(); } catch { /* swept later */ }
    return { ok: false, reason: "expired" };
  }
  if (Number(row.tries) >= OTP_MAX_TRIES) {
    try { await db.prepare("DELETE FROM otp_codes WHERE email_fp = ?1").bind(emailFp).run(); } catch { /* swept later */ }
    return { ok: false, reason: "too many tries" };
  }

  const want = String(row.code_hash);
  const got = await otpHash(env, emailFp, String(code || ""));
  if (!timingSafeEqual(got, want)) {
    try {
      await db.prepare("UPDATE otp_codes SET tries = tries + 1 WHERE email_fp = ?1").bind(emailFp).run();
    } catch { /* the expiry still bounds it */ }
    return { ok: false, reason: "wrong code", left: Math.max(0, OTP_MAX_TRIES - Number(row.tries) - 1) };
  }

  try { await db.prepare("DELETE FROM otp_codes WHERE email_fp = ?1").bind(emailFp).run(); } catch { /* swept later */ }
  return { ok: true };
}

/* ---------- Google ---------- */

let jwksCache = { at: 0, keys: null };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function googleJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
      signal: AbortSignal.timeout(DODO_TIMEOUT_MS)
    });
    if (!res.ok) return jwksCache.keys;          // stale beats none
    const data = await res.json();
    if (!data || !Array.isArray(data.keys)) return jwksCache.keys;
    jwksCache = { at: Date.now(), keys: data.keys };
    return data.keys;
  } catch { return jwksCache.keys; }
}

/**
 * The verified email inside a Google id_token, or "".
 *
 * Checks, and every one of them matters:
 *   signature  against Google's published JWKS, by `kid`
 *   iss        one of Google's two spellings, and nothing else
 *   aud        OUR client id — a token minted for another app is not a login
 *              to ours, and skipping this is the classic id_token forgery
 *   exp        not expired
 *   nonce      equal to the nonce this very request signed, so an id_token
 *              captured elsewhere cannot be replayed here
 *   email_verified  literal true; Google will hand out unverified addresses
 *              on some account types and an unverified one anchors nothing
 */
async function verifyGoogleIdToken(env, idToken, expectNonce) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "");
  if (!clientId) return "";
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return "";

  let header, claims, signed, sig;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    sig = b64urlToBytes(parts[2]);
    signed = enc.encode(parts[0] + "." + parts[1]);
  } catch { return ""; }
  if (!header || header.alg !== "RS256" || !header.kid) return "";

  const keys = await googleJwks();
  if (!keys) return "";
  const jwk = keys.find((k) => k.kid === header.kid && k.alg === "RS256");
  if (!jwk) return "";

  let ok;
  try {
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
  } catch { return ""; }
  if (!ok) return "";

  const iss = String(claims.iss || "");
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") return "";
  if (String(claims.aud || "") !== clientId) return "";
  if (!(Number(claims.exp) * 1000 > Date.now())) return "";
  if (String(claims.nonce || "") !== String(expectNonce || "")) return "";
  if (claims.email_verified !== true && claims.email_verified !== "true") return "";
  return canonicalEmail(claims.email);
}

/* ---------- identity ledgers ---------- */

/** Remember that this identity exists. Idempotent; `via` records the first
 *  route only, because that is the one that says how it was proven. */
async function noteIdentity(env, emailFp, via) {
  const db = d1(env);
  if (!db) return;
  try {
    await db.prepare(
      "INSERT INTO identities (email_fp, first_seen, via) VALUES (?1, ?2, ?3) ON CONFLICT(email_fp) DO NOTHING"
    ).bind(emailFp, Date.now(), via).run();
  } catch { /* the trial ledger is the one that has to be right */ }
}

/**
 * Keep the address itself, encrypted.
 *
 * `email_fp` answers "is this the same person"; it cannot answer "who do I
 * write to" or "what do you hold about me". This can. Stored under its own
 * AES-GCM key so a dump is ciphertext, and NEVER read back into a response —
 * no route returns it, so there is nothing on the wire to intercept.
 *
 * Best-effort by design: failing to file the address must not fail a sign-in.
 */
async function rememberEmail(env, emailFp, email) {
  const db = d1(env);
  if (!db || !emailFp || !email) return;
  const blob = await aesSeal(await aesKeyFor(env, "lct-email-v1"), email);
  if (!blob) return;                     // no SIGNING_KEY: store nothing rather than plaintext
  try {
    await db.prepare(
      "INSERT INTO identity_emails (email_fp, email_enc, updated_at) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(email_fp) DO UPDATE SET email_enc = excluded.email_enc, updated_at = excluded.updated_at"
    ).bind(emailFp, blob, Date.now()).run();
  } catch { /* the identity row is the one that has to be right */ }
}

/** Support path only. No route calls this; it exists so an operator answering
 *  an access or erasure request is not reading ciphertext by hand. */
async function readEmail(env, emailFp) {
  const db = d1(env);
  if (!db || !emailFp) return "";
  try {
    const row = await db.prepare("SELECT email_enc FROM identity_emails WHERE email_fp = ?1")
      .bind(emailFp).first();
    return row ? aesOpen(await aesKeyFor(env, "lct-email-v1"), String(row.email_enc || "")) : "";
  } catch { return ""; }
}

/**
 * The trial, keyed on identity instead of device.
 *
 * CARRY-OVER is the whole subtlety. Two ledgers can already hold a week this
 * person spent: `trials` keyed on the device that spent it, and — for installs
 * older than D1 — KV. Both are consulted, and the EARLIEST date wins, so
 * verifying an identity can only ever confirm a trial that is already running
 * or already over. It can never restart one.
 *
 * Returns null when there is no ledger at all, and the caller says 503.
 */
async function claimIdentityTrial(env, emailFp, devFp) {
  const db = d1(env);
  if (!db) return null;
  try {
    const seen = await db.prepare("SELECT started_at FROM trials_id WHERE email_fp = ?1").bind(emailFp).first();
    if (seen) {
      /* An identity that already has a week, arriving from a device that also
         has an older one: keep the older. The only way this ordering appears
         is a trial started before identity existed and verified afterwards. */
      const prior = devFp ? await deviceTrialStart(env, db, devFp) : 0;
      const at = Number(seen.started_at) || 0;
      if (prior && prior < at) {
        try {
          await db.prepare("UPDATE trials_id SET started_at = ?2 WHERE email_fp = ?1").bind(emailFp, prior).run();
        } catch { /* the older date is a correction, not a requirement */ }
        return { startedAt: prior, already: true };
      }
      await stampDeviceTrial(db, devFp, at);
      return { startedAt: at, already: true };
    }

    const carried = devFp ? await deviceTrialStart(env, db, devFp) : 0;
    const startedAt = carried || Date.now();
    await db.prepare("INSERT INTO trials_id (email_fp, started_at) VALUES (?1, ?2) ON CONFLICT(email_fp) DO NOTHING")
      .bind(emailFp, startedAt).run();
    const row = await db.prepare("SELECT started_at FROM trials_id WHERE email_fp = ?1").bind(emailFp).first();
    const at = Number(row && row.started_at) || startedAt;
    await stampDeviceTrial(db, devFp, at);
    return { startedAt: at, already: Boolean(carried) || at !== startedAt };
  } catch { return null; }
}

/**
 * Re-stamp the device-keyed ledger every time a trial is claimed.
 *
 * The identity anchor closes "uninstall and reinstall". It does NOT close
 * "verify a second address on the same install", which needs no uninstall at
 * all and costs a spare mailbox. Keeping the dev_fp row current means the
 * second identity inherits the first one's start date through the carry-over
 * path below, so a fresh address on a machine that already spent its week gets
 * that same spent week back.
 *
 * DO NOTHING on conflict, never UPDATE: the row must only ever record the
 * EARLIEST week this device saw. Moving it forward is how a device farms.
 */
async function stampDeviceTrial(db, devFp, startedAt) {
  if (!devFp || !startedAt) return;
  try {
    await db.prepare("INSERT INTO trials (dev_fp, started_at) VALUES (?1, ?2) ON CONFLICT(dev_fp) DO NOTHING")
      .bind(devFp, startedAt).run();
  } catch { /* the identity ledger is the bound; this is the extra one */ }
}

/** The week this DEVICE already spent, from either pre-identity ledger. */
async function deviceTrialStart(env, db, devFp) {
  let fromD1 = 0;
  try {
    const row = await db.prepare("SELECT started_at FROM trials WHERE dev_fp = ?1").bind(devFp).first();
    fromD1 = Number(row && row.started_at) || 0;
  } catch { /* KV may still hold it */ }
  const fromKv = await trialFromKV(env, devFp);
  if (fromD1 && fromKv) return Math.min(fromD1, fromKv);
  return fromD1 || fromKv || 0;
}

/** The week this identity has already been granted, without creating one.
 *  Verifying an identity must not silently start a trial — /trial does that,
 *  when the user actually asks for it. */
async function readIdentityTrial(env, emailFp) {
  const db = d1(env);
  if (!db) return 0;
  try {
    const row = await db.prepare("SELECT started_at FROM trials_id WHERE email_fp = ?1").bind(emailFp).first();
    return Number(row && row.started_at) || 0;
  } catch { return 0; }
}

/** Does this identity hold an owner row for this licence? The question
 *  evictOldestSeat() must answer yes to before it removes anything. */
async function ownsLicence(env, keyFp, emailFp) {
  const db = d1(env);
  if (!db || !emailFp) return false;
  try {
    const row = await db.prepare("SELECT 1 AS n FROM owners WHERE key_fp = ?1 AND email_fp = ?2")
      .bind(keyFp, emailFp).first();
    return Boolean(row);
  } catch { return false; }
}

/**
 * The answer both verification routes give, so OTP and Google are
 * indistinguishable from here on.
 *
 * Reports the trial WITHOUT starting one, and reports whether this identity
 * owns anything so the client knows to call /restore instead of showing a
 * trial button to somebody who already paid.
 */
async function identityAnswer(env, emailFp, devFp, origin, seat) {
  const idt = await mintIdentityToken(env, emailFp);
  if (!idt) return json({ error: "unavailable" }, 503, origin);

  /* Signing in IS the moment this device joins the account, so its row is
     written here rather than at the first paid check-in. A trial or free
     device never reaches /entitlement, and before this the device screen was
     empty for the very person who had just signed in on it. Written before the
     answer goes out, so the list is already right by the time the client can
     ask for it. */
  if (devFp) {
    await touchSession(env, {
      devFp, keyFp: null, emailFp,
      plat: (seat && seat.plat) || "", geo: (seat && seat.geo) || "",
      label: (seat && seat.label) || ""
    });
    await enforceFreeDeviceLimit(env, emailFp, devFp);
  }

  const startedAt = await readIdentityTrial(env, emailFp);
  /* A device that spent a week before identity existed. Reported so the client
     shows the truth immediately; /trial writes it across when it is called. */
  const db = d1(env);
  const carried = (!startedAt && db && devFp) ? await deviceTrialStart(env, db, devFp) : 0;
  const owned = await ownedLicences(env, emailFp);
  return json({
    ok: true,
    idt,
    verified: true,
    startedAt: startedAt || carried || 0,
    owns: owned.length > 0
  }, 200, origin);
}

/* ---------- ownership ---------- */

/** AES-GCM under a key derived from SIGNING_KEY. See schema.sql: /entitlement
 *  re-validates upstream and that call needs the key itself, so it has to be
 *  recoverable — but a dump of `owners` must not be a pile of live licences. */
async function aesKeyFor(env, domain) {
  const raw = String(env.SIGNING_KEY || "");
  if (!raw) return null;
  // Domain-separated: one leaked plaintext/ciphertext pair must not weaken the
  // other store, and the two have different lifetimes.
  const material = await crypto.subtle.digest("SHA-256", enc.encode(domain + ":" + raw));
  try {
    return await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch { return null; }
}

const ownerCipherKey = (env) => aesKeyFor(env, "lct-owner-v1");

async function aesSeal(key, text) {
  if (!key) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
    const out = new Uint8Array(iv.length + ct.byteLength);
    out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
    return b64url(out);
  } catch { return ""; }
}

async function aesOpen(key, blob) {
  if (!key || !blob) return "";
  try {
    const bytes = b64urlToBytes(blob);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return new TextDecoder().decode(pt);
  } catch { return ""; }
}

const encLic = async (env, licKey) => aesSeal(await ownerCipherKey(env), licKey);
const decLic = async (env, blob) => aesOpen(await ownerCipherKey(env), blob);

/**
 * Tie a licence to an identity, so a reinstall can find it again.
 *
 * Called on every successful /entitlement that carries an identity token —
 * not only at activation — so buyers who verify an identity months after
 * purchase get the binding too.
 */
async function bindOwner(env, keyFp, emailFp, licKey) {
  const db = d1(env);
  if (!db || !emailFp) return;
  try {
    const have = await db.prepare("SELECT lic_enc FROM owners WHERE key_fp = ?1 AND email_fp = ?2")
      .bind(keyFp, emailFp).first();
    if (have && have.lic_enc) return;
    /* A licence has exactly one owner: the first identity to present it.
       Binding every activator made a leaked key a weapon — the stranger got
       eviction rights over the buyer's seats and a permanent /restore. */
    if (!have) {
      const taken = await db.prepare("SELECT 1 AS n FROM owners WHERE key_fp = ?1 LIMIT 1")
        .bind(keyFp).first();
      if (taken) return;
    }
    await db.prepare(
      "INSERT INTO owners (key_fp, email_fp, lic_enc, bound_at) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT(key_fp, email_fp) DO UPDATE SET lic_enc = excluded.lic_enc"
    ).bind(keyFp, emailFp, await encLic(env, licKey), Date.now()).run();
  } catch { /* restore is a convenience; failing it must not fail the call */ }
}

/**
 * The licences this identity owns, newest binding first.
 *
 * Revoked ones are filtered HERE rather than at the caller: a refunded licence
 * must not come back to life just because someone reinstalled and signed in.
 */
async function ownedLicences(env, emailFp) {
  const db = d1(env);
  if (!db || !emailFp) return [];
  try {
    const res = await db.prepare(
      "SELECT key_fp, lic_enc FROM owners WHERE email_fp = ?1 ORDER BY bound_at DESC LIMIT 8"
    ).bind(emailFp).all();
    const rows = (res && res.results) || [];
    const out = [];
    for (const r of rows) {
      if (await revoked(env, String(r.key_fp))) continue;
      const key = await decLic(env, r.lic_enc);
      if (key) out.push({ keyFp: String(r.key_fp), key });
    }
    return out;
  } catch { return []; }
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

  const base = dodoBase(env);
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

/* ---------- checkout: orders this worker owns ----------

   WHY THE SERVER OPENS THE CHECKOUT.

   What this replaced: a static pricing page carrying a hard-coded payment
   link, whose success redirect handed the licence key back in the query
   string. Three faults, and only the first is cosmetic.

     1. Price, product id and provider were baked into a page deploy. A launch
        discount, a second currency, a provider migration — each one a content
        edit racing a CDN cache, on the single surface where being wrong costs
        money rather than embarrassment.

     2. Nothing tied the payment to the install that made it, so the buyer paid
        and then re-entered their own purchase by hand out of an email. Every
        step between paying and having the thing is somewhere a person asks for
        a refund instead.

     3. The key travelled in a URL. `no-referrer` keeps it out of the Referer
        header and out of nothing else — history, profile sync, the omnibox and
        every other extension holding `tabs` all read full URLs. A bearer
        secret does not belong in one.

   The shape now is the one payment systems converge on:

     client asks the server to open a session
       -> server owns product, price and metadata, hands back a URL and a ref
     provider takes the money
       -> the WEBHOOK is the only thing that decides money moved
     client claims against the server with the device proof it already holds

   The redirect is UX and nothing else. It carries no secret, so there is
   nothing on it to steal and nothing to scrub.

   METADATA IS THE DURABLE LINK, not the row below. If D1 is unreachable when
   the session opens, the session still opens: ref and device fingerprint ride
   in the provider's own metadata and the webhook writes the row when it lands.
   A ledger having a bad afternoon must not cost a sale.

   WHAT STAYS AS A FALLBACK. Dodo emails the key regardless, and the popup
   still takes a pasted one. That path is not legacy — it is how a buyer moves
   their licence to a second machine, and how they recover if every webhook in
   a delivery window is lost. */

const ORDER_TTL_MS = 24 * 3600e3;    // an unpaid order is litter after a day
const ORDER_MAX_OPEN = 5;            // unpaid orders per device per TTL
const CHECKOUT_RL_MAX = 10;          // sessions per device, and per IP, per hour
const ORDER_KEEP_MS = 180 * 864e5;   // settled orders, kept for support, then dropped
const ORDER_REF_RE = /^[a-f0-9]{32}$/;
const CHECKOUT_HOST = "dodopayments.com";

/**
 * The only hosts we will ever hand a client as a place to type a card number.
 * Checked here as well as in the extension: a compromised or confused upstream
 * answering with someone else's URL must not become a phishing redirect we
 * signed for.
 */
function checkoutUrlOk(value) {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    // Suffix comparison, not a pattern: the leading dot is what stops
    // `evildodopayments.com`, and a string compare cannot be made to backtrack.
    return u.protocol === "https:" &&
      (h === CHECKOUT_HOST || h.endsWith("." + CHECKOUT_HOST));
  } catch { return false; }
}

/** Open a hosted checkout session. `ref` is ours and comes back on the webhook. */
async function dodoCheckout(env, ref, devFp) {
  const productId = str(env.DODO_PRODUCT_ID);
  if (!productId || !env.DODO_API_KEY) return { branch: "closed" };

  let res;
  try {
    res = await fetch(dodoBase(env) + "/checkouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + env.DODO_API_KEY,
        /* A double-tapped Buy button is the ordinary case, not the adversarial
           one, and two sessions for one intent is two chances to be charged. */
        "Idempotency-Key": ref
      },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        return_url: str(env.RETURN_URL) || undefined,
        metadata: { tv_ref: ref, tv_dev: devFp }
      }),
      signal: AbortSignal.timeout(DODO_TIMEOUT_MS)
    });
  } catch { return { branch: "service" }; }

  if (!res.ok) return { branch: res.status >= 500 ? "service" : "badrequest" };
  let data;
  try { data = await res.json(); } catch { return { branch: "service" }; }

  const url = String((data && data.checkout_url) || "");
  // No URL means the session was created in a mode we did not ask for. Refusing
  // beats handing the popup something it cannot open.
  if (!checkoutUrlOk(url)) return { branch: "service" };
  return { branch: "ok", url, sessionId: String((data && data.session_id) || "") };
}

/** Unpaid orders this device already has in flight. -1 when unknown. */
async function openOrderCount(env, devFp) {
  const db = d1(env);
  if (!db) return -1;
  try {
    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE dev_fp = ?1 AND state = 'created' AND created_at > ?2"
    ).bind(devFp, Date.now() - ORDER_TTL_MS).first();
    return Number(row && row.n) || 0;
  } catch { return -1; }
}

/**
 * /checkout takes no licence key either, so it cannot use the per-key bucket —
 * and it must not borrow it: that counter also feeds the sharing observer, and
 * filling it with device fingerprints would be evidence about nothing.
 *
 * Every call here costs an upstream session creation, which is the reason to
 * bound it at all. A real client presses Buy once and occasionally twice.
 */
async function checkoutRateLimited(env, devFp, ip) {
  if (!env.RL) return false;
  const slot = Math.floor(Date.now() / (RL_WINDOW_S * 1000));
  const buckets = [
    `rlco:${devFp}:${slot}`,
    `rlcoip:${await sha256Hex(ip || "unknown", 16)}:${slot}`
  ];
  try {
    for (const bucket of buckets) {
      const seen = Number(await env.RL.get(bucket)) || 0;
      if (seen >= CHECKOUT_RL_MAX) return true;
      await env.RL.put(bucket, String(seen + 1), { expirationTtl: RL_WINDOW_S * 2 });
    }
    return false;
  } catch {
    // An outage is not a verdict. ORDER_MAX_OPEN and the edge limiter both hold.
    return false;
  }
}

async function openOrder(env, devFp) {
  const open = await openOrderCount(env, devFp);
  // -1 is "the ledger did not answer", which is not evidence of abuse.
  if (open >= ORDER_MAX_OPEN) return { branch: "throttled" };

  const ref = crypto.randomUUID().replace(/-/g, "");
  const made = await dodoCheckout(env, ref, devFp);
  if (made.branch !== "ok") return made;

  const db = d1(env);
  if (db) {
    try {
      const now = Date.now();
      await db.batch([
        db.prepare("DELETE FROM orders WHERE state = 'created' AND created_at < ?1")
          .bind(now - ORDER_TTL_MS),
        /* Settled orders are kept for a season and then dropped. They are how a
           support ticket gets from "my licence stopped" to a payment id, which
           is worth more than the row costs — but not forever, and an unbounded
           table is a slow outage nobody schedules. */
        db.prepare("DELETE FROM orders WHERE state IN ('claimed','refunded') AND updated_at < ?1")
          .bind(now - ORDER_KEEP_MS),
        db.prepare(
          "INSERT INTO orders (ref, dev_fp, state, session_id, created_at, updated_at) " +
          "VALUES (?1, ?2, 'created', ?3, ?4, ?4) ON CONFLICT(ref) DO NOTHING"
        ).bind(ref, devFp, made.sessionId, now)
      ]);
    } catch { /* the metadata is the link; the webhook writes the row */ }
  }
  return { branch: "ok", ref, url: made.url };
}

/**
 * Every licence key a customer holds. Shared by the refund sweep and by the
 * claim's pull fallback, because "which key did this payment buy" is one
 * question and answering it twice is how the two answers drift.
 *
 * { ok:false } is "could not find out", which is not "there was none".
 */
async function licenceKeysForCustomer(env, customerId) {
  // No customer to ask about is a real, complete answer. No API key is not:
  // it is a misconfigured deployment, and it must read as "could not find out".
  if (!customerId) return { ok: true, items: [] };
  if (!env.DODO_API_KEY) return { ok: false, items: [] };
  let res;
  try {
    res = await fetch(dodoBase(env) + "/license_keys?page_size=100&customer_id=" +
      encodeURIComponent(customerId), {
      headers: { Authorization: "Bearer " + env.DODO_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(DODO_TIMEOUT_MS)
    });
  } catch { return { ok: false, items: [] }; }
  if (!res.ok) return { ok: false, items: [] };
  let payload;
  try { payload = await res.json(); } catch { return { ok: false, items: [] }; }
  return { ok: true, items: Array.isArray(payload && payload.items) ? payload.items : [] };
}

/**
 * Record that money moved. Called from the webhook, and written as an UPSERT
 * on purpose: the row may not exist, because the ledger may have been down
 * when the session opened. The provider's metadata is the authority on who
 * this belongs to, and it is the one copy an attacker cannot write.
 *
 * State never moves backwards — a retried `payment.succeeded` arriving after
 * `license_key.created` must not knock a fulfilled order back to paid.
 */
async function orderPaid(env, ref, devFp, paymentId, customerId) {
  const db = d1(env);
  if (!db || !ORDER_REF_RE.test(ref) || !/^[a-f0-9]{32}$/.test(devFp)) return false;
  try {
    const now = Date.now();
    await db.prepare(
      "INSERT INTO orders (ref, dev_fp, state, payment_id, customer, created_at, updated_at) " +
      "VALUES (?1, ?2, 'paid', ?3, ?4, ?5, ?5) " +
      "ON CONFLICT(ref) DO UPDATE SET " +
      "  payment_id = excluded.payment_id, customer = excluded.customer, updated_at = excluded.updated_at, " +
      "  state = CASE WHEN orders.state = 'created' THEN 'paid' ELSE orders.state END"
    ).bind(ref, devFp, paymentId, customerId, now).run();
    // The key may already have arrived and be waiting on this row.
    await adoptParkedKey(env, paymentId);
    return true;
  } catch { return false; }
}

/**
 * Attach the issued key to the order the payment came from.
 *
 * Matched on payment_id rather than on the metadata, because `license_key`
 * events describe the key and carry no metadata of ours. A key with no order
 * behind it is not an error: it is the email path, or a purchase made before
 * this endpoint existed.
 */
/* The at-rest form of a held licence key. schema.sql says a bearer secret at
   rest is a liability with a shelf life — and the shelf life only starts when
   the buyer claims. An order that is fulfilled and never claimed held a
   plaintext key indefinitely, which is the one case the comment did not cover.
   Prefixed rather than sniffed: a licence key and a base64url blob share a
   character set, so "is this encrypted?" has to be answered by the writer. */
const ENCLIC_PREFIX = "enc1:";

async function storedLicKey(env, key) {
  const blob = await encLic(env, key);
  /* No cipher key means no SIGNING_KEY, which means this deploy cannot mint a
     token either — it is broken in a way an operator has to see. Keeping the
     buyer's key is still better than losing the purchase, so store it as it is
     and say so where somebody will read it. */
  if (!blob) {
    console.warn("orders: storing a licence key UNENCRYPTED — SIGNING_KEY is missing");
    return key;
  }
  return ENCLIC_PREFIX + blob;
}

async function heldLicKey(env, stored) {
  const v = String(stored || "");
  if (!v) return "";
  // Rows written before the prefix existed are plaintext, and stay claimable.
  if (!v.startsWith(ENCLIC_PREFIX)) return v;
  return await decLic(env, v.slice(ENCLIC_PREFIX.length));
}

async function orderFulfilled(env, paymentId, key, keyFp) {
  const db = d1(env);
  if (!db || !paymentId || !key) return false;
  try {
    const res = await db.prepare(
      "UPDATE orders SET lic_key = ?2, key_fp = ?3, state = 'fulfilled', updated_at = ?4 " +
      "WHERE payment_id = ?1 AND state IN ('created', 'paid')"
    ).bind(paymentId, await storedLicKey(env, key), keyFp, Date.now()).run();
    if (((res && res.meta && res.meta.changes) || 0) > 0) return true;
    /* No order carries this payment yet. Dodo delivers license_key.created
       before payment.succeeded often enough that discarding it here lost the
       key for good — the 200 we return means it is never redelivered. Park it;
       orderPaid() adopts it the moment the payment lands. */
    await parkKey(env, paymentId, key, keyFp);
    return false;
  } catch { return false; }
}

/** Hold an unmatched key until its order exists. Overwrites: one key per payment. */
async function parkKey(env, paymentId, key, keyFp) {
  const db = d1(env);
  if (!db) return;
  try {
    await db.prepare(
      "INSERT INTO pending_keys (payment_id, lic_key, key_fp, at) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT(payment_id) DO UPDATE SET lic_key = excluded.lic_key, key_fp = excluded.key_fp, at = excluded.at"
    ).bind(paymentId, await storedLicKey(env, key), keyFp, Date.now()).run();
  } catch { /* parked delivery is best effort; pullLicence is the other half */ }
}

/** Attach a parked key to an order that has just been marked paid. */
async function adoptParkedKey(env, paymentId) {
  const db = d1(env);
  if (!db || !paymentId) return false;
  let row;
  try {
    row = await db.prepare("SELECT lic_key, key_fp FROM pending_keys WHERE payment_id = ?1")
      .bind(paymentId).first();
  } catch { return false; }
  if (!row || !row.lic_key) return false;
  try {
    const res = await db.prepare(
      "UPDATE orders SET lic_key = ?2, key_fp = ?3, state = 'fulfilled', updated_at = ?4 " +
      "WHERE payment_id = ?1 AND state IN ('created', 'paid')"
    ).bind(paymentId, row.lic_key, row.key_fp, Date.now()).run();
    if (((res && res.meta && res.meta.changes) || 0) > 0) {
      await db.prepare("DELETE FROM pending_keys WHERE payment_id = ?1").bind(paymentId).run();
      return true;
    }
  } catch { /* leave it parked for the sweep or the next event */ }
  return false;
}

/** A refunded purchase stops being claimable, and drops the key it was holding. */
async function orderRefunded(env, keyFp) {
  const db = d1(env);
  if (!db) return;
  try {
    await db.prepare(
      "UPDATE orders SET state = 'refunded', lic_key = NULL, updated_at = ?2 WHERE key_fp = ?1"
    ).bind(keyFp, Date.now()).run();
  } catch { /* the kill list is the thing that matters; this is bookkeeping */ }
}

/**
 * The webhook is late or was lost. Ask the provider directly.
 *
 * Push-only fulfilment is the standard way a payment system quietly stops
 * delivering: one bad delivery window and the buyer is holding a receipt and
 * nothing else. This is the pull half.
 */
async function pullLicence(env, row) {
  const paymentId = String(row.payment_id || "");
  const customerId = String(row.customer || "");
  if (!paymentId || !customerId) return false;
  const found = await licenceKeysForCustomer(env, customerId);
  if (!found.ok) return false;
  const match = found.items.find((k) => k && String(k.payment_id || "") === paymentId);
  const key = String((match && match.key) || "");
  if (!key) return false;
  return orderFulfilled(env, paymentId, key, await sha256Hex(key));
}

/**
 * Hand the key back to the device that opened the order — once.
 *
 * `devFp` here was PROVEN by signature over a single-use nonce, not declared
 * in the body, so possession of a ref is not enough. That is the whole reason
 * this can be a plain identifier the client is allowed to remember.
 */
async function claimOrder(env, devFp, ref) {
  const db = d1(env);
  if (!db) return { state: "pending" };

  let row;
  try {
    row = await db.prepare(
      "SELECT dev_fp, state, payment_id, customer, lic_key, created_at, updated_at FROM orders WHERE ref = ?1"
    ).bind(ref).first();
  } catch { return { state: "pending" }; }

  // Someone else's order reads exactly like one that never existed.
  if (!row || String(row.dev_fp) !== devFp) return { state: "unknown" };

  if (row.state === "refunded") return { state: "refunded" };
  if (row.state === "claimed") return { state: "claimed" };

  if (row.state === "paid" && !row.lic_key &&
      Date.now() - Number(row.updated_at || row.created_at) > CLAIM_PULL_AFTER_MS) {
    if (await pullLicence(env, row)) {
      try {
        row = await db.prepare(
          "SELECT dev_fp, state, payment_id, customer, lic_key, created_at, updated_at FROM orders WHERE ref = ?1"
        ).bind(ref).first();
      } catch { return { state: "paid" }; }
    }
  }

  if (row && row.state === "fulfilled" && row.lic_key) {
    /* Conditional, so two claims racing cannot both come away with a key and
       a caller cannot re-read one by asking twice. The loser is told the order
       is claimed, which is true. */
    let won;
    try {
      const res = await db.prepare(
        "UPDATE orders SET state = 'claimed', lic_key = NULL, updated_at = ?2 " +
        "WHERE ref = ?1 AND state = 'fulfilled'"
      ).bind(ref, Date.now()).run();
      won = ((res && res.meta && res.meta.changes) || 0) > 0;
    } catch { return { state: "pending" }; }
    if (!won) return { state: "claimed" };
    const key = await heldLicKey(env, row.lic_key);
    /* The row is already marked claimed and the key already nulled. If it will
       not decrypt — a rotated SIGNING_KEY — say "claimed" rather than hand back
       a ciphertext the client would try to activate. The buyer still has the
       key in their purchase email, and /restore still finds it. */
    if (!key) return { state: "claimed" };
    return { state: "ready", key };
  }

  /* Only an order nobody paid for expires. Ageing out a paid or fulfilled one
     told a buyer their purchase had lapsed while the money had already moved. */
  if (row.state === "created" && Date.now() - Number(row.created_at) > ORDER_TTL_MS) {
    return { state: "expired" };
  }
  return { state: row.state === "paid" ? "paid" : "pending" };
}

/* ---------- seat ledger ---------- */

/**
 * Server-side device count. lib/dodo.js keeps a client registry for UX; this is
 * the copy that decides. Clearing extension storage does not reset it.
 */
async function claimSeat(env, keyFp, devFp, opts) {
  const emailFp = (opts && opts.emailFp) || "";
  /* Declared by the client, unsigned, and that is honest rather than lax: this
     request already PROVED which device it is, so the only party who can set
     the flag for a device is that device. A patched client could always set it
     — and a patched client could always skip the whole gate, which is the
     trade the ladder at the top of this file already names. Signing it instead
     would 426 every installed client for no attacker we do not already have. */
  const intent = !!(opts && opts.activate);
  const db = d1(env);
  if (db) {
    try {
      /* Signed out from the device screen. A silent 12-hourly check-in must not
         take the seat back; an explicit Activate may, and clears the tombstone
         on its way through. */
      const kill = await killedAt(db, devFp, [keyFp, emailFp]);
      if (kill) {
        if (!intent) return { ok: false, reason: "signed-out", seats: 0 };
        await db.prepare("DELETE FROM session_kills WHERE dev_fp = ?1 AND scope IN (?2, ?3)")
          .bind(devFp, keyFp, emailFp || keyFp).run();
      }
      const rows = await seatRows(db, env, keyFp);
      const now = Date.now();
      const held = rows.some((r) => r.dev_fp === devFp);
      const writes = [];
      let evicted = "";

      if (!held && rows.length >= SEAT_LIMIT) {
        // Evict only genuinely idle seats; an active fleet must hit the wall.
        const stale = rows
          .filter((r) => now - Number(r.last_seen) > SEAT_IDLE_MS)
          .sort((a, b) => Number(a.last_seen) - Number(b.last_seen));
        if (!stale.length) return { ok: false, seats: rows.length };
        evicted = stale[0].dev_fp;
        writes.push(db.prepare("DELETE FROM seats WHERE key_fp = ?1 AND dev_fp = ?2")
          .bind(keyFp, evicted));
        writes.push(db.prepare("DELETE FROM sessions WHERE dev_fp = ?1 AND key_fp = ?2")
          .bind(evicted, keyFp));
      }

      writes.push(db.prepare(
        "INSERT INTO seats (key_fp, dev_fp, last_seen) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key_fp, dev_fp) DO UPDATE SET last_seen = excluded.last_seen"
      ).bind(keyFp, devFp, now));

      // One transaction: the eviction and the claim that depends on it cannot
      // half-apply and leave the licence a seat short.
      await db.batch(writes);
      if (evicted) await dropMirror(env, keyFp, evicted);
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
      /* One transaction. A released seat whose session row survives still
         reads as signed in at /session, which is the exact bug this route
         exists to stop. */
      await db.batch([
        db.prepare("DELETE FROM seats WHERE key_fp = ?1 AND dev_fp = ?2").bind(keyFp, targetFp),
        db.prepare("DELETE FROM sessions WHERE dev_fp = ?1 AND key_fp = ?2").bind(targetFp, keyFp)
      ]);
      await dropMirror(env, keyFp, targetFp);
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

/**
 * Free the seat this licence has not used in longest.
 *
 * Called ONLY when the caller has proven it owns the licence (an identity
 * token whose `owners` row matches) and the ledger is full. That combination
 * is a reinstall: the same person, on the same machine, holding a new device
 * key because the old one died with the uninstall. Without this they are told
 * "device limit reached" on their fifth reinstall of software they paid for —
 * the same shape of bug releaseSeat() was written to close.
 *
 * Never evicts on behalf of an unverified caller. That would turn the seat cap
 * into a revolving door anyone could spin.
 */
async function evictOldestSeat(env, keyFp) {
  const db = d1(env);
  if (!db) return false;
  try {
    const row = await db.prepare(
      "SELECT dev_fp FROM seats WHERE key_fp = ?1 ORDER BY last_seen ASC LIMIT 1").bind(keyFp).first();
    if (!row) return false;
    const gone = String(row.dev_fp);
    await db.batch([
      db.prepare("DELETE FROM seats WHERE key_fp = ?1 AND dev_fp = ?2").bind(keyFp, gone),
      db.prepare("DELETE FROM sessions WHERE dev_fp = ?1 AND key_fp = ?2").bind(gone, keyFp)
    ]);
    await dropMirror(env, keyFp, gone);
    return true;
  } catch { return false; }
}

/* ---------- sessions ----------
 *
 * `seats` answers "may this device have Pro". It cannot answer "which devices
 * am I signed in on": it has no room for a name, it cannot see a trial device,
 * and it is keyed on a licence rather than on the person holding it. This is
 * the table the device screen reads, and /session is the route that makes a
 * termination mean something on the machine being terminated.
 *
 * Until now, releasing a seat freed a slot and nothing else. The released
 * device kept a valid 30-day token, and nothing made it ask — needsRefresh()
 * only calls home with 10 days of token life left. So "Terminate" cost the
 * target roughly nothing for weeks. /session is the cheap frequent question
 * the long token deliberately does not ask.
 */

/* How stale "last active" may get. A heartbeat inside this window writes
   nothing: the alternative is a D1 write per device per hour to move a column
   the owner reads once a month. */
const SESSION_SEEN_MS = 30 * 60e3;

/* Mirror life, and the entire risk budget of caching this. 60s is KV's floor.
   A stale mirror can only DELAY a kill by that long — it cannot invent one and
   it cannot undo one, because the verdict compares timestamps rather than
   reading a flag. */
const SESSION_MIRROR_TTL_S = 60;

/* Heartbeats are frequent by design, so they cannot share RL_MAX (20/hour):
   five devices would exhaust a licence's whole hourly budget before lunch and
   then start refusing the calls that decide whether they are still signed in.
   Its own bucket, sized for five devices checking in every few minutes. */
const RL_SESSION_MAX = 200;

const mirrorKey = (keyFp, devFp) => `live:${keyFp}:${devFp}`;

async function sessionRateLimited(env, keyFp, ip) {
  if (!env.RL) return false;
  const slot = Math.floor(Date.now() / (RL_WINDOW_S * 1000));
  try {
    const ipBucket = `rlip:${await sha256Hex(ip || "unknown", 16)}:${slot}`;
    const ipSeen = Number(await env.RL.get(ipBucket)) || 0;
    if (ipSeen >= RL_IP_MAX) return true;
    await env.RL.put(ipBucket, String(ipSeen + 1), { expirationTtl: RL_WINDOW_S * 2 });

    const bucket = `rlses:${keyFp}:${slot}`;
    const seen = Number(await env.RL.get(bucket)) || 0;
    if (seen >= RL_SESSION_MAX) return true;
    await env.RL.put(bucket, String(seen + 1), { expirationTtl: RL_WINDOW_S * 2 });
    return false;
  } catch { return false; }   // an outage is not a verdict
}

/** Coarse platform string, capped. Client-supplied and unsigned on purpose:
 *  the row is keyed on a PROVEN dev_fp, so a device can only ever label
 *  itself, and adding fields to the signed input would 426 every installed
 *  client for a cosmetic string. */
function sessionPlat(v) {
  return str(v).replace(/[^\w .·–—-]/g, "").slice(0, 40);
}

/** Two-letter country, derived by Cloudflare rather than declared by the
 *  caller — the one piece of location data a client cannot lie about, and the
 *  coarsest one worth showing. No IP is stored anywhere. */
function sessionGeo(request) {
  const cc = String((request && request.cf && request.cf.country) || "");
  return /^[A-Z]{2}$/.test(cc) ? cc : "";
}

/* ---------- who the device screen is for ----------
 *
 * Two vars, both flippable with a `wrangler deploy` and no extension release.
 *
 * SESSION_SCOPE     "all" (default) puts every verified account on the device
 *                   screen, free ones included — which is how the system is
 *                   being exercised before there are many paying accounts to
 *                   exercise it with. "paid" narrows it to accounts that own a
 *                   licence. Nothing else changes: the same tables, the same
 *                   kills, the same list.
 *
 * FREE_DEVICE_LIMIT 0 (default) caps nothing. Set it to SEAT_LIMIT to impose
 *                   the paid rule on free accounts — oldest device out when an
 *                   N+1th signs in, with a real tombstone rather than a silent
 *                   delete the next check-in would undo.
 */
function sessionScope(env) {
  return String((env && env.SESSION_SCOPE) || "all").toLowerCase() === "paid" ? "paid" : "all";
}

function freeDeviceLimit(env) {
  const n = Number((env && env.FREE_DEVICE_LIMIT) || 0);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 0;
}

/** Does this account own a licence — i.e. is it a paid account? */
async function accountHasLicence(db, emailFp) {
  try {
    const row = await db.prepare("SELECT 1 AS ok FROM owners WHERE email_fp = ?1 LIMIT 1")
      .bind(emailFp).first();
    return !!(row && row.ok);
  } catch { return false; }
}

/**
 * Hold a free account to FREE_DEVICE_LIMIT devices, newest kept.
 *
 * Deliberately the same mechanism a person's own Sign out uses: the row goes
 * and a tombstone is written under the account scope, so the evicted device's
 * next check-in reads as signed out instead of silently claiming itself back.
 * `by` is 'sweep', which is what tells the two apart in the audit.
 *
 * Only ever touches rows with no licence on them. A paid device is governed by
 * the seat ledger and must not be evicted by a free-tier rule.
 */
async function enforceFreeDeviceLimit(env, emailFp, keepDev) {
  const limit = freeDeviceLimit(env);
  const db = d1(env);
  if (!limit || !db || !emailFp) return;
  try {
    const res = await db.prepare(
      "SELECT dev_fp FROM sessions WHERE email_fp = ?1 AND key_fp IS NULL " +
      "ORDER BY last_seen DESC LIMIT -1 OFFSET ?2"
    ).bind(emailFp, limit).all();
    const over = ((res && res.results) || [])
      .map((r) => String(r.dev_fp)).filter((d) => d !== keepDev);
    if (!over.length) return;
    const now = Date.now();
    const writes = [];
    for (const devFp of over) {
      writes.push(db.prepare("DELETE FROM sessions WHERE dev_fp = ?1 AND email_fp = ?2")
        .bind(devFp, emailFp));
      writes.push(db.prepare(
        "INSERT INTO session_kills (scope, dev_fp, at, by) VALUES (?1, ?2, ?3, 'sweep') " +
        "ON CONFLICT(scope, dev_fp) DO UPDATE SET at = excluded.at, by = excluded.by"
      ).bind(emailFp, devFp, now));
    }
    writes.push(db.prepare(
      "UPDATE account_state SET version = version + 1, updated_at = ?2 WHERE email_fp = ?1"
    ).bind(emailFp, now));
    await db.batch(writes);
  } catch { /* a cap is not worth failing the call it rode in on */ }
}

/**
 * Record that this device is alive, with whatever we now know about it.
 *
 * claimed_at moves only when the row is new or the licence changed. It is the
 * watermark every kill is compared against, so a routine check-in must not
 * advance it — otherwise a device outlives its own termination by heartbeating.
 */
async function touchSession(env, { devFp, keyFp, emailFp, plat, geo, label }) {
  const db = d1(env);
  if (!db) return;
  const now = Date.now();
  let labelEnc = null;
  if (label) {
    try {
      const key = await aesKeyFor(env, "session-label");
      /* aesSeal answers "" when it cannot seal, and "" is not NULL: COALESCE
         below would take it as a new label and blank the name the device
         already had. Only a real ciphertext may reach the statement. */
      labelEnc = (key && await aesSeal(key, String(label).slice(0, 40))) || null;
    } catch { labelEnc = null; }
  }
  try {
    await db.prepare(
      "INSERT INTO sessions (dev_fp, email_fp, key_fp, created_at, claimed_at, last_seen, label_enc, plat, geo) " +
      "VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?5, ?6, ?7) " +
      "ON CONFLICT(dev_fp) DO UPDATE SET " +
      "  email_fp   = COALESCE(excluded.email_fp, sessions.email_fp), " +
      "  key_fp     = COALESCE(excluded.key_fp, sessions.key_fp), " +
      "  last_seen  = excluded.last_seen, " +
      "  label_enc  = COALESCE(excluded.label_enc, sessions.label_enc), " +
      "  plat       = COALESCE(NULLIF(excluded.plat, ''), sessions.plat), " +
      "  geo        = COALESCE(NULLIF(excluded.geo, ''), sessions.geo), " +
      /* The licence changed under this device: a different purchase is a
         different session, so the watermark restarts with it. */
      "  claimed_at = CASE WHEN sessions.key_fp IS NOT ?3 THEN excluded.claimed_at ELSE sessions.claimed_at END"
    ).bind(devFp, emailFp || null, keyFp || null, now, labelEnc, plat || "", geo || "").run();
  } catch { /* a session row must never cost somebody their token */ }
}

/** The session row, adopting a pre-sessions seat the first time we find none.
 *  Without the adoption every device that predates this table reads as signed
 *  out the moment the feature ships. */
async function sessionRow(db, devFp, { keyFp, emailFp, seatSeen }) {
  const read = () => db.prepare(
    "SELECT dev_fp, email_fp, key_fp, claimed_at, last_seen FROM sessions WHERE dev_fp = ?1"
  ).bind(devFp).first();

  const row = await read();
  if (row) return row;
  if (!seatSeen) return null;

  /* claimed_at is the seat's own age, not now(): adopting must not hand a
     device a fresher watermark than the seat it is standing on. */
  await db.prepare(
    "INSERT INTO sessions (dev_fp, email_fp, key_fp, created_at, claimed_at, last_seen) " +
    "VALUES (?1, ?2, ?3, ?4, ?4, ?4) ON CONFLICT(dev_fp) DO NOTHING"
  ).bind(devFp, emailFp || null, keyFp || null, seatSeen).run();
  return await read();
}

/** The newest termination that could apply to this device, across both scopes
 *  a kill can be written under. */
async function killedAt(db, devFp, scopes) {
  const live = scopes.filter(Boolean);
  if (!live.length) return 0;
  const marks = live.map((_, i) => `?${i + 2}`).join(", ");
  const row = await db.prepare(
    `SELECT MAX(at) AS at FROM session_kills WHERE dev_fp = ?1 AND scope IN (${marks})`
  ).bind(devFp, ...live).first();
  return Number(row && row.at) || 0;
}

async function accountEpoch(db, emailFp) {
  if (!emailFp) return 0;
  const row = await db.prepare("SELECT epoch FROM account_state WHERE email_fp = ?1").bind(emailFp).first();
  return Number(row && row.epoch) || 0;
}

/**
 * Is this device still signed in?
 *
 * Throws on a ledger failure, deliberately: the caller turns that into a 503
 * and the client keeps working. The ONLY thing that may end an entitlement is
 * a successful read that says so — a database having a bad afternoon is not an
 * answer, and this is the function where that rule would be easiest to lose.
 */
async function sessionVerdict(env, { devFp, keyFp, emailFp }) {
  const db = d1(env);
  if (!db) return { live: true, reason: "no-ledger" };

  /* The seat IS the entitlement. Releasing one from the device screen deletes
     this row, which is what finally makes that button do something on the
     machine it is aimed at. seatRows() first, so a licence still living in the
     pre-D1 KV ledger is carried over rather than read as terminated. */
  const rows = await seatRows(db, env, keyFp);
  const seat = rows.find((r) => r.dev_fp === devFp);
  if (!seat) return { live: false, reason: "terminated" };

  const seatSeen = Number(seat.last_seen) || Date.now();
  const row = await sessionRow(db, devFp, { keyFp, emailFp, seatSeen });
  const claimedAt = Number(row && row.claimed_at) || seatSeen;
  const account = (row && row.email_fp) || emailFp || "";

  if (await killedAt(db, devFp, [keyFp, account]) > claimedAt) {
    return { live: false, reason: "terminated" };
  }
  if (await accountEpoch(db, account) > claimedAt) {
    return { live: false, reason: "signed-out" };
  }
  return { live: true, reason: "", claimedAt, lastSeen: Number(row && row.last_seen) || 0 };
}

/** Move `last_seen` at most once per SESSION_SEEN_MS. The WHERE clause is the
 *  throttle, so two heartbeats racing cannot both write. */
async function noteSessionSeen(env, devFp, now) {
  const db = d1(env);
  if (!db) return;
  try {
    await db.prepare("UPDATE sessions SET last_seen = ?2 WHERE dev_fp = ?1 AND last_seen < ?3")
      .bind(devFp, now, now - SESSION_SEEN_MS).run();
  } catch { /* a timestamp is not worth failing a heartbeat over */ }
}

async function readMirror(env, keyFp, devFp) {
  if (!env.RL) return null;
  try {
    const raw = await env.RL.get(mirrorKey(keyFp, devFp), "json");
    return (raw && typeof raw === "object") ? raw : null;
  } catch { return null; }
}

async function writeMirror(env, keyFp, devFp, value) {
  if (!env.RL) return;
  try {
    await env.RL.put(mirrorKey(keyFp, devFp), JSON.stringify(value),
      { expirationTtl: SESSION_MIRROR_TTL_S });
  } catch { /* the mirror is an optimisation; D1 is the answer */ }
}

/** Drop a cached "live". Called wherever a seat stops existing, so the mirror
 *  cannot keep answering for a device that was just signed out. */
async function dropMirror(env, keyFp, devFp) {
  if (!env.RL || !env.RL.delete) return;
  try { await env.RL.delete(mirrorKey(keyFp, devFp)); } catch { /* TTL is the backstop */ }
}

/* ---------- the device screen ----------
 *
 * Account-scoped, not licence-scoped, and that is the whole design. A licence
 * key is not an account: it cannot see a trial device, it is shared by whoever
 * holds it, and "your devices" is a sentence about a person. So these three
 * routes authenticate with an IDENTITY token — the same bar a streaming site
 * sets by asking for the password before it shows you the list.
 *
 * /devices and /devices/revoke stay exactly as they were, for a device that
 * has never verified an identity and for the extension already in the store.
 * A device may always sign ITSELF out with a device proof alone; signing out
 * somebody else is what needs the account.
 */

const SESSION_LIST_MAX = 50;
const TERMINATE_MAX = 20;
const OP_ID_RE = /^[a-f0-9]{32}$/;
const DEV_FP_RE = /^[a-f0-9]{32}$/;

/* "Sign out of ALL devices" is the one irreversible button on the screen, and
   an identity token is good for 400 days — long enough that finding one in a
   copied profile would otherwise be a fleet-wide kill switch. Fifteen minutes
   means the person is at the keyboard now. */
const IDENTITY_FRESH_MS = 15 * 60e3;

/** The account's counters, created on demand. `version` is what makes a stale
 *  device screen unable to terminate a row that has stopped being what it was
 *  showing; `epoch` is sign-out-everywhere as one write instead of five. */
async function accountState(db, emailFp) {
  await db.prepare(
    "INSERT INTO account_state (email_fp, epoch, version, updated_at) VALUES (?1, 0, 0, ?2) " +
    "ON CONFLICT(email_fp) DO NOTHING"
  ).bind(emailFp, Date.now()).run();
  const row = await db.prepare(
    "SELECT epoch, version FROM account_state WHERE email_fp = ?1").bind(emailFp).first();
  return { epoch: Number(row && row.epoch) || 0, version: Number(row && row.version) || 0 };
}

/**
 * Pull every seat under this account's licences into the session table.
 *
 * Two jobs in one statement. A device that predates `sessions` gets a row, and
 * a device that has one but has never verified an identity gets attached to
 * the account that owns the licence it is sitting on. Without the second, a
 * machine activated from a pasted key would be invisible on the screen that
 * exists to show every machine.
 *
 * COALESCE, not overwrite: a session already attached to an identity keeps it.
 */
async function attachOwnedSeats(db, emailFp) {
  const res = await db.prepare(
    "SELECT key_fp FROM owners WHERE email_fp = ?1 ORDER BY bound_at DESC LIMIT 8"
  ).bind(emailFp).all();
  const keys = ((res && res.results) || []).map((r) => String(r.key_fp)).filter(Boolean);
  if (!keys.length) return;
  const marks = keys.map((_, i) => `?${i + 2}`).join(", ");
  await db.prepare(
    "INSERT INTO sessions (dev_fp, email_fp, key_fp, created_at, claimed_at, last_seen) " +
    `SELECT dev_fp, ?1, key_fp, last_seen, last_seen, last_seen FROM seats WHERE key_fp IN (${marks}) ` +
    "ON CONFLICT(dev_fp) DO UPDATE SET " +
    "  email_fp = COALESCE(sessions.email_fp, excluded.email_fp), " +
    "  key_fp   = COALESCE(sessions.key_fp, excluded.key_fp)"
  ).bind(emailFp, ...keys).run();
}

/**
 * The list, as the ledger holds it.
 *
 * `label` comes back decrypted because the caller has just proved they own the
 * account; it is sealed at rest so that a dump of the table is not a device
 * inventory. `geo` is a country and nothing finer, and no IP is stored to
 * derive it from — see sessionGeo().
 */
async function listSessions(env, emailFp, selfDev) {
  const db = d1(env);
  if (!db) return null;
  await attachOwnedSeats(db, emailFp);
  const res = await db.prepare(
    "SELECT dev_fp, key_fp, created_at, last_seen, label_enc, plat, geo FROM sessions " +
    "WHERE email_fp = ?1 ORDER BY last_seen DESC LIMIT ?2"
  ).bind(emailFp, SESSION_LIST_MAX).all();

  const rows = (res && res.results) || [];
  const labelKey = rows.some((r) => r.label_enc) ? await aesKeyFor(env, "session-label") : null;
  const out = [];
  for (const r of rows) {
    out.push({
      device: String(r.dev_fp),
      label: r.label_enc ? await aesOpen(labelKey, String(r.label_enc)) : "",
      plat: String(r.plat || ""),
      geo: String(r.geo || ""),
      lastSeen: Number(r.last_seen) || 0,
      createdAt: Number(r.created_at) || 0,
      pro: !!r.key_fp,
      self: String(r.dev_fp) === selfDev
    });
  }
  return out;
}

/**
 * Sign devices out. One transaction, however many were selected.
 *
 * Terminating three devices with three requests is how two end up signed out
 * and one does not, so the array is the unit of work: the seats, the sessions,
 * the tombstones, the version bump and the audit row either all land or none
 * of them do.
 *
 * A kill is written under BOTH scopes — the account and the licence — because
 * a device can come back presenting only a licence key, with no identity token
 * on it, and that request must be refused too.
 */
async function killTargets(env, { emailFp, rows, by, setEpoch, opId, kind, version }) {
  const db = d1(env);
  const now = Date.now();
  const nextVersion = version + 1;
  const terminated = rows.map((r) => String(r.dev_fp));
  const result = { ok: true, version: nextVersion, terminated };

  const kill = (scope, devFp) => db.prepare(
    "INSERT INTO session_kills (scope, dev_fp, at, by) VALUES (?1, ?2, ?3, ?4) " +
    "ON CONFLICT(scope, dev_fp) DO UPDATE SET at = excluded.at, by = excluded.by"
  ).bind(scope, devFp, now, by);

  const writes = [];
  for (const r of rows) {
    const devFp = String(r.dev_fp);
    const keyFp = r.key_fp ? String(r.key_fp) : "";
    if (keyFp) {
      writes.push(db.prepare("DELETE FROM seats WHERE key_fp = ?1 AND dev_fp = ?2").bind(keyFp, devFp));
      writes.push(kill(keyFp, devFp));
    }
    writes.push(db.prepare("DELETE FROM sessions WHERE dev_fp = ?1 AND email_fp = ?2").bind(devFp, emailFp));
    writes.push(kill(emailFp, devFp));
  }

  /* The survivors have to be re-stamped BEFORE the epoch moves past them.
     `epoch` says "anything claimed before now is signed out", and the device
     that pressed Sign out of all devices was claimed long before now — so
     without this, keeping yourself signed in signs you out. The deletes above
     have already gone, so what is left under this account is exactly the set
     that was kept. Found by the five-device run against wrangler dev; the D1
     fake never caught it because no test kept a device with an old claim. */
  if (setEpoch) {
    writes.push(db.prepare("UPDATE sessions SET claimed_at = ?2 WHERE email_fp = ?1")
      .bind(emailFp, now));
  }

  writes.push(db.prepare(
    "UPDATE account_state SET version = version + 1, updated_at = ?2" +
    (setEpoch ? ", epoch = ?2" : "") + " WHERE email_fp = ?1"
  ).bind(emailFp, now));

  /* The idempotency row rides INSIDE the transaction. Written afterwards it
     would be missing exactly when it is needed — the retry of a call that
     landed and then lost its connection. */
  writes.push(db.prepare(
    "INSERT INTO session_ops (op_id, email_fp, kind, targets, at, result) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(op_id) DO NOTHING"
  ).bind(opId, emailFp, kind, JSON.stringify(terminated), now, JSON.stringify(result)));

  await db.batch(writes);

  // Outside the transaction on purpose: a cache we cannot clear is a 60-second
  // delay, and rolling back a completed sign-out to fix that would be worse.
  for (const r of rows) if (r.key_fp) await dropMirror(env, String(r.key_fp), String(r.dev_fp));
  return result;
}

/** A previous answer to this exact op_id, or null. */
async function replayOp(db, opId, emailFp) {
  const row = await db.prepare(
    "SELECT result FROM session_ops WHERE op_id = ?1 AND email_fp = ?2").bind(opId, emailFp).first();
  if (!row) return null;
  try { return JSON.parse(String(row.result)); } catch { return null; }
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

/**
 * The trial's proof. Same private key as LCT2, deliberately different prefix:
 * a trial token must never be presentable where a licence token is expected,
 * and the prefix is inside the signed bytes so it cannot be relabelled.
 *
 * `verified: true` used to be a boolean in the client's own storage, which
 * made the whole trial gate forgeable by anyone willing to open DevTools once.
 * This is the fix: the grant is a signature the client can check and cannot
 * produce. `exp` is the end of the week itself, so an expired token is an
 * expired trial — there is no second lifetime to get wrong.
 */
async function mintTrialToken(env, { identityFp, devFp, startedAt, ks }) {
  const payload = enc.encode(JSON.stringify({
    v: 1, typ: "trial", idf: identityFp, dev: devFp,
    sta: startedAt, iat: Date.now(), exp: startedAt + TRIAL_MS,
    ...(ks ? { ks } : {}), jti: crypto.randomUUID()
  }));
  const key = await getSigningKey(env);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, payload);
  return `LCTT1.${b64url(payload)}.${b64url(sig)}`;
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

/* Not revoking anything — these are the two events that DELIVER a purchase.
   `payment.succeeded` carries our metadata and says money moved; the licence is
   minted separately and afterwards, so `license_key.created` is what actually
   completes an order. Either can arrive first, and both are handled as if the
   other has not. */
const FULFILLING = {
  "payment.succeeded": "paid",
  "license_key.created": "fulfilled"
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
  const customerId = String((data && data.customer && data.customer.customer_id) || "");
  const paymentId = String((data && data.payment_id) || "");

  const found = await licenceKeysForCustomer(env, customerId);
  if (!found.ok) return { ok: false, keys: [] };
  const items = found.items;
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

/**
 * Advance an order on a delivery event.
 *
 * { ok:false } means the ledger refused a write we needed, and the caller turns
 * that into a 5xx so the delivery is retried. Everything else — a purchase with
 * no metadata of ours, a key with no order behind it — is a complete and
 * ordinary answer, because the email path and support-issued keys both produce
 * exactly those events and neither is a failure.
 */
async function applyFulfilment(env, type, data) {
  // No ledger bound at all: nothing to record, and retrying will not conjure
  // one. Consistent with every other path here, which degrades open.
  if (!d1(env)) return { ok: true, detail: { noledger: true } };

  if (type === "payment.succeeded") {
    const meta = (data && data.metadata) || {};
    const ref = str(meta.tv_ref);
    const dev = str(meta.tv_dev);
    /* Bought through something other than a session we opened. Not an error:
       it is the email path, an invoice, or a purchase made before this endpoint
       existed. There is simply no install to attribute it to. */
    if (!ORDER_REF_RE.test(ref) || !/^[a-f0-9]{32}$/.test(dev)) {
      return { ok: true, detail: { unattributed: true } };
    }
    const wrote = await orderPaid(env, ref, dev,
      str(data.payment_id),
      str((data.customer && data.customer.customer_id) || ""));
    return wrote ? { ok: true, detail: { paid: true } } : { ok: false };
  }

  // license_key.created — matched to an order by payment, since key events
  // carry the key and none of our metadata.
  const key = str(data.key);
  const paymentId = str(data.payment_id);
  if (!key || !paymentId) return { ok: true, detail: { unattributed: true } };
  const attached = await orderFulfilled(env, paymentId, key, await sha256Hex(key));
  return { ok: true, detail: { fulfilled: attached } };
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
  const data = (evt && evt.data) || {};
  const reason = REVOKING[type];
  // 200 for anything we do not act on: a 4xx here is retried until Dodo
  // disables the endpoint, taking the events we DO act on with it.
  if (!reason && !FULFILLING[type]) return json({ ok: true, ignored: type }, 200, "");

  const id = request.headers.get("webhook-id") || "";
  if (!(await claimWebhook(env, id))) return json({ ok: true, duplicate: true }, 200, "");

  /* Everything past the claim, under one guard.
     Each failure path below already releases the claim before asking Dodo to
     retry — but a THROW skipped all of them, leaving the receipt row in place.
     Dodo's retry then reads as a duplicate and is answered 200, and the refund
     or the fulfilment behind it is lost with no error anywhere. Releasing on
     the way out is what makes "please retry" true. */
  try {
    return await settleWebhook(env, id, type, data, reason);
  } catch (e) {
    await releaseWebhook(env, id);
    console.error("webhook " + type + " threw: " + String((e && e.stack) || e));
    return json({ error: "unavailable" }, 500, "");   // 5xx: please retry
  }
}

async function settleWebhook(env, id, type, data, reason) {
  if (!reason) {
    const done = await applyFulfilment(env, type, data);
    if (!done.ok) {
      await releaseWebhook(env, id);
      return json({ error: "ledger" }, 500, "");     // 5xx: please retry
    }
    return json({ ok: true, ...done.detail }, 200, "");
  }

  const found = await licencesForRefund(env, data);
  if (!found.ok) {
    await releaseWebhook(env, id);
    return json({ error: "upstream" }, 500, "");     // 5xx: please retry
  }

  let revoked = 0;
  for (const key of found.keys) {
    const keyFp = await sha256Hex(key);
    if (await revokeLicence(env, keyFp, reason)) revoked++;
    // The order stops being claimable too. Without this a refund taken in the
    // seconds before the buyer's first claim still hands them a live key.
    await orderRefunded(env, keyFp);
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

/* ---------- retention ----------
 *
 * WHY THIS EXISTS. Every ledger in this file was written with a self-sweep or
 * no sweep at all, and "no sweep at all" was the answer for three of them:
 * otp_codes only lost a row when somebody touched it, webhook_events grew
 * forever, and identities/trials had no expiry despite the privacy page saying
 * plainly that a trial start date is kept "up to 400 days". A retention promise
 * nothing enforces is not a retention promise.
 *
 * WHAT IS NOT SWEPT, deliberately:
 *   revocations — a refund is permanent. A swept kill-list row is a refunded
 *                 licence quietly coming back to life.
 *   owners      — this is what makes a purchase restorable after a reinstall.
 *                 Deleting it because a buyer went quiet for a year costs them
 *                 the thing they paid for. Kept for the life of the licence.
 *
 * Each statement runs on its own. A batch would be tidier and would also mean
 * one locked table stops the other six from being cleaned.
 */
const RETAIN_MS = 400 * 864e5;          // the figure the privacy page names
const WEBHOOK_RETAIN_MS = 30 * 864e5;   // long enough to dedupe a retry storm
const SEAT_RETAIN_MS = 400 * 864e5;
/* A settled order is the receipt behind a support mail. ORDER_TTL_MS is how
   long an UNPAID order is worth keeping (a day); it is not a refund window. */
const SETTLED_RETAIN_MS = 180 * 864e5;
/* Long enough that a support question about "who signed my laptop out" can
   still be answered, short enough that it is not a permanent record. */
const SESSION_OPS_RETAIN_MS = 90 * 864e5;

async function sweepLedgers(env) {
  const db = d1(env);
  if (!db) return { swept: 0, skipped: "no database" };
  const now = Date.now();
  const jobs = [
    ["nonces", "DELETE FROM nonces WHERE expires_at < ?1", now],
    ["otp_codes", "DELETE FROM otp_codes WHERE expires_at < ?1", now],
    ["webhook_events", "DELETE FROM webhook_events WHERE at < ?1", now - WEBHOOK_RETAIN_MS],
    ["orders:abandoned", "DELETE FROM orders WHERE state = 'created' AND created_at < ?1", now - ORDER_TTL_MS],
    ["orders:settled", "DELETE FROM orders WHERE state IN ('claimed','refunded') AND updated_at < ?1",
      now - SETTLED_RETAIN_MS],
    ["pending_keys", "DELETE FROM pending_keys WHERE at < ?1", now - SETTLED_RETAIN_MS],
    ["seats", "DELETE FROM seats WHERE last_seen < ?1", now - SEAT_RETAIN_MS],
    ["sessions", "DELETE FROM sessions WHERE last_seen < ?1", now - SEAT_RETAIN_MS],
    /* A kill must outlive every token it was written against, or a device
       comes back from the dead when its tombstone is swept. */
    ["session_kills", "DELETE FROM session_kills WHERE at < ?1", now - SEAT_RETAIN_MS],
    ["session_ops", "DELETE FROM session_ops WHERE at < ?1", now - SESSION_OPS_RETAIN_MS],
    ["trials", "DELETE FROM trials WHERE started_at < ?1", now - RETAIN_MS],
    ["trials_id", "DELETE FROM trials_id WHERE started_at < ?1", now - RETAIN_MS],
    /* An identity that still owns a licence is kept whatever its age — it is
       the only thing standing between that buyer and a lost purchase. */
    ["identities",
      "DELETE FROM identities WHERE first_seen < ?1 " +
      "AND email_fp NOT IN (SELECT email_fp FROM owners)", now - RETAIN_MS],
    /* Ordered AFTER identities so the address never outlives the row that
       justified keeping it. Same carve-out: a live owner keeps both. */
    ["identity_emails",
      "DELETE FROM identity_emails WHERE updated_at < ?1 " +
      "AND email_fp NOT IN (SELECT email_fp FROM owners)", now - RETAIN_MS]
  ];

  let swept = 0;
  const failed = [];
  for (const [name, sql, cutoff] of jobs) {
    try {
      const res = await db.prepare(sql).bind(cutoff).run();
      swept += (res && res.meta && res.meta.changes) || 0;
    } catch (e) { failed.push(name + ": " + String((e && e.message) || e)); }
  }
  /* Worker Traces is the only place an operator finds out the cleaner has been
     failing quietly for a month. Silence here was the actual risk. */
  if (failed.length) console.warn("sweep: " + failed.join(" | "));
  return { swept, failed };
}

/* ---------- handler ---------- */

/* Named, not routed. Reading an address back is an operator action for an
   access or erasure request, not something a client may ask for — no handler
   below calls this, and adding one would put a plaintext address on the wire. */
export { readEmail };

export default {
  /* Cron. Everything here is disposable or past its stated retention; nothing
     here is load-bearing for a live licence. Failing is logged, not fatal —
     a cleaner that throws must not become a pager. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweepLedgers(env).then((r) => {
      console.log("sweep: removed " + r.swept + " row(s)");
    }).catch((e) => console.warn("sweep failed: " + String((e && e.message) || e))));
  },

  /**
   * Every answer this worker gives, including the ones it did not mean to.
   *
   * Without the wrapper an unexpected throw — a malformed SIGNING_KEY secret
   * makes importKey throw before anything catches it — becomes a bare runtime
   * 500 with NO CORS headers, which the extension cannot read and reports as a
   * network failure. That is the worst possible shape for a licensing error:
   * indistinguishable from an outage, so the client waits it out instead of
   * saying anything useful. One catch, one JSON answer, one trace line.
   */
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin") || "";
    try {
      return await route(request, env);
    } catch (e) {
      console.error("unhandled: " + String((e && e.stack) || e));
      /* Guarded, because the thing that threw may be the reason origin policy
         cannot be evaluated either — a missing env is exactly that case, and a
         catch block that throws leaves us back at the bare 500 this exists to
         prevent. No echoed origin is a worse answer than none at all. */
      let echo = "";
      try { echo = originAllowed(requestOrigin, env) ? requestOrigin : ""; }
      catch { /* nothing to echo */ }
      return json({ error: "unavailable" }, 503, echo);
    }
  }
};

async function route(request, env) {
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
      if (seen && seen.success === false) return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));
    } catch { /* not a verdict */ }
  }

  const url = new URL(request.url);
  const route = url.pathname;
  const ROUTES = ["/entitlement", "/trial", "/devices", "/devices/revoke", "/session",
    "/sessions", "/sessions/terminate", "/sessions/terminate-all",
    "/checkout", "/checkout/claim",
    "/identity/start", "/identity/verify", "/identity/google", "/restore"];
  if (!ROUTES.includes(route)) return json({ error: "not found" }, 404, origin);
  /* Which routes are scoped to a licence. Checkout is the route you take
     BECAUSE you have no licence, so requiring one would close the circle. */
  /* The device screen is keyed on the ACCOUNT, so it carries no licence key —
     it has to show a trial device and a second purchase in the same list. */
  const NO_LICENCE = ["/trial", "/checkout", "/checkout/claim",
    "/sessions", "/sessions/terminate", "/sessions/terminate-all",
    "/identity/start", "/identity/verify", "/identity/google", "/restore"];
  const needsLicence = !NO_LICENCE.includes(route);

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
  /* Which devices are being signed out, and the key that makes a retry free.
     Fingerprints only — the screen never sends a licence key to sign somebody
     out, and never learns one it did not already hold. */
  const terminating = route === "/sessions/terminate" || route === "/sessions/terminate-all";
  const targets = route === "/sessions/terminate" && Array.isArray(body.targets)
    ? body.targets.filter((v) => typeof v === "string") : [];
  if (route === "/sessions/terminate") {
    if (!targets.length || targets.length > TERMINATE_MAX) {
      return json({ error: "bad targets" }, 400, origin);
    }
    if (!targets.every((v) => DEV_FP_RE.test(v))) return json({ error: "bad targets" }, 400, origin);
  }
  const opId = terminating ? str(body.op_id) : "";
  if (terminating && !OP_ID_RE.test(opId)) return json({ error: "bad op id" }, 400, origin);
  /* Optional. A caller that sends no version is saying "I am not looking at a
     list", which is true of a script and of nothing the popup does. */
  const ifVersion = typeof body.if_version === "number" && Number.isFinite(body.if_version)
    ? body.if_version : null;

  /* The order being claimed. Opaque, ours, and worthless without the device
     key that opened it — which is why it is safe for the client to keep one
     in plain storage and safe for us to accept it as an identifier. */
  const ref = route === "/checkout/claim" ? str(body.ref) : "";
  if (route === "/checkout/claim" && !ORDER_REF_RE.test(ref)) {
    return json({ error: "bad ref" }, 400, origin);
  }

  /* ---------- identity fields ----------
     Canonicalised BEFORE anything is signed over it, so the bytes the client
     proved and the bytes the ledger keys on are the same string. Signing the
     raw address and storing the folded one would let two spellings of one
     mailbox present two different signed requests for one identity. */
  const rawEmail = (route === "/identity/start" || route === "/identity/verify") ? str(body.email) : "";
  const email = rawEmail ? canonicalEmail(rawEmail) : "";
  if ((route === "/identity/start" || route === "/identity/verify") && !email) {
    return json({ error: "bad email" }, 400, origin);
  }
  const code = route === "/identity/verify" ? str(body.code) : "";
  if (route === "/identity/verify" && !/^[0-9]{6}$/.test(code)) {
    return json({ error: "bad code" }, 400, origin);
  }
  const googleToken = route === "/identity/google" ? str(body.id_token) : "";
  if (route === "/identity/google" && (googleToken.length < 64 || googleToken.length > 4096)) {
    return json({ error: "bad id_token" }, 400, origin);
  }

  /* The identity token rides along on EVERY route that can use one. It is
     optional everywhere: an unverified caller still gets the old behaviour,
     just without the parts that need an identity to be true. */
  const identityClaims = await readIdentityClaims(env, str(body.idt));
  const identityFp = identityClaims ? identityClaims.efp : "";

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
    "/devices/revoke": ["devices-revoke", [licenseKey, target]],
    "/session":        ["session",        [licenseKey]],
    /* The target list is inside the signature: which devices get signed out is
       not a field anything between here and the popup gets to edit. */
    "/sessions":                 ["sessions",             []],
    "/sessions/terminate":       ["sessions-terminate",   [opId, targets.join(",")]],
    "/sessions/terminate-all":   ["sessions-terminate-all", [opId]],
    "/checkout":       ["checkout",       []],
    "/checkout/claim": ["checkout-claim", [ref]],
    /* The canonical address, not what was typed. See the note above. */
    "/identity/start":  ["identity-start",  [email]],
    "/identity/verify": ["identity-verify", [email, code]],
    /* Nothing extra: the id_token carries `nonce`, which must equal the
       nonce already inside this signature, so it cannot be swapped. */
    "/identity/google": ["identity-google", []],
    "/restore":         ["restore",         []]
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
  /* ---------- /identity/start ----------
     Mails a code. Says the same thing whether or not the address has been
     seen before: "did this email already start a trial" is not a question a
     stranger gets to ask about someone else's address. */
  /* ---------- OTP, off by default ----------
     Verification is Google-only now: one route, one provider, and no address
     leaves this Worker for a third party to deliver a code. The code below is
     kept and reachable by setting OTP_ENABLED=1, because turning email
     verification back on must not need a code change under pressure.

     410, not 404: an older client that still shows a code box gets told the
     route is gone rather than that it typed the URL wrong. */
  const otpEnabled = String(env.OTP_ENABLED || "") === "1";
  if (!otpEnabled && (route === "/identity/start" || route === "/identity/verify")) {
    return json({ error: "otp disabled" }, 410, origin);
  }

  if (route === "/identity/start") {
    if (disposableDomain(email, env)) return json({ error: "disposable" }, 400, origin);
    const emailFp = await emailFpOf(email);
    if (await otpSendLimited(env, emailFp, ip)) return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));

    const sent = await startOtp(env, emailFp, email);
    if (!sent.ok) {
      if (sent.reason === "too soon") {
          return json({ error: "too soon", retryInMs: sent.retryInMs }, 429, origin,
            retryAfter(sent.retryInMs));
        }
      /* unconfigured / failed / unavailable are all one thing to the client:
         we could not deliver, fall back to an unverified trial. */
      return json({ error: "unavailable" }, 503, origin);
    }
    return json({ ok: true, expiresInMs: sent.expiresInMs }, 200, origin);
  }

  /* ---------- /identity/verify ---------- */
  if (route === "/identity/verify") {
    const emailFp = await emailFpOf(email);
    const res = await verifyOtp(env, emailFp, code);
    if (res.ok) await rememberEmail(env, emailFp, email);
    if (!res.ok) {
      if (res.reason === "unavailable") return json({ error: "unavailable" }, 503, origin);
      return json({ error: res.reason, left: res.left }, 401, origin);
    }
    await noteIdentity(env, emailFp, "otp");
    return identityAnswer(env, emailFp, devFp, origin, { plat: sessionPlat(body.plat), geo: sessionGeo(request), label: str(body.label) });
  }

  /* ---------- /identity/google ----------
     The one-tap route to the SAME anchor. Whatever Google says the verified
     address is, it is canonicalised and hashed exactly as the OTP route
     does, so signing in with Google after using a code — or the reverse —
     lands on one identity and one trial. */
  if (route === "/identity/google") {
    const googleEmail = await verifyGoogleIdToken(env, googleToken, nonce);
    if (!googleEmail) return json({ error: "bad id_token" }, 401, origin);
    if (disposableDomain(googleEmail, env)) return json({ error: "disposable" }, 400, origin);
    const emailFp = await emailFpOf(googleEmail);
    await noteIdentity(env, emailFp, "google");
    await rememberEmail(env, emailFp, googleEmail);
    return identityAnswer(env, emailFp, devFp, origin, { plat: sessionPlat(body.plat), geo: sessionGeo(request), label: str(body.label) });
  }

  /* ---------- /restore ----------
     The reinstall path. A verified identity asks "do I own anything?", and
     if it does, this runs the whole entitlement flow on its behalf — upstream
     validity, seat, token — so Pro is back without a key pasted from an email.

     It is not a way to discover licences: an identity that owns nothing gets
     an empty answer, and the owner rows are only ever written by a caller who
     already held the key. */
  if (route === "/restore") {
    if (!identityFp) return json({ error: "unverified" }, 401, origin);
    const owned = await ownedLicences(env, identityFp);
    if (!owned.length) return json({ ok: true, restored: false }, 200, origin);

    /* Bounded upstream work. `owners` returns up to eight rows and each one
       costs a validation call with an 8s timeout — eight in series is a minute
       of wall clock on a request nobody will wait for, and it is a free
       amplifier: one signed call in, eight upstream ones out. Newest binding
       first, three tries, and a wall-clock stop. */
    const RESTORE_MAX_UPSTREAM = 3;
    const restoreUntil = Date.now() + 12e3;
    let tried = 0;

    for (const lic of owned) {
      if (tried >= RESTORE_MAX_UPSTREAM || Date.now() > restoreUntil) break;
      tried++;
      const check = await dodoValidate(env, lic.key, "");
      if (check.branch !== "ok") continue;

      let seat = await claimSeat(env, lic.keyFp, devFp, { emailFp: identityFp, activate: true });
      /* Full, and the caller owns it: this is a reinstall holding a new
         device key. Make room rather than refusing the buyer their own
         licence. See evictOldestSeat(). */
      if (!seat.ok && await evictOldestSeat(env, lic.keyFp)) {
        seat = await claimSeat(env, lic.keyFp, devFp, { emailFp: identityFp, activate: true });
      }
      if (!seat.ok) return json({ error: "device limit reached", seats: seat.seats }, 422, origin);
      await touchSession(env, {
        devFp, keyFp: lic.keyFp, emailFp: identityFp,
        plat: sessionPlat(body.plat), geo: sessionGeo(request), label: str(body.label)
      });

      const now = Date.now();
      const token = await mintToken(env, {
        v: 2, sub: lic.keyFp, dev: devFp, plan: "pro", feat: FEATURES,
        email: check.email || "", ks: await archiveSecret(env, lic.keyFp),
        iat: now, exp: now + TTL_MS, jti: crypto.randomUUID()
      });
      return json({ ok: true, restored: true, key: lic.key, token,
        exp: now + TTL_MS, seats: seat.seats }, 200, origin);
    }
    /* Owned something, and none of it is live any more — refunded, or
       cancelled upstream. Not an error, and not a restore either. */
    return json({ ok: true, restored: false }, 200, origin);
  }

  if (route === "/trial") {
    if (await trialRateLimited(env, ip)) return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));

    /* No identity, no ledger entry. The client starts an UNVERIFIED trial on
       its own clock: the week runs, and lib/entitlement.js grants no feature
       against it until an identity is proved. That is what keeps an issuer
       outage from being a way to mint free weeks — an unverified week buys
       nothing, so there is no reason to farm one. */
    if (!identityFp) return json({ unverified: true }, 200, origin);

    const claimed = await claimIdentityTrial(env, identityFp, devFp);
    // No ledger available: say so plainly rather than inventing a start date.
    if (!claimed) return json({ error: "unavailable" }, 503, origin);

    const ks = await archiveSecret(env, "trial:" + identityFp);
    /* The secret this used to be, before the stamp was re-keyed from device to
       identity. Every v3 archive sealed during a trial before that deploy
       verifies only under it, so it is handed back too and the client offers
       both when opening a backup. Sealing always uses `ks`. */
    const ksPrev = devFp ? await archiveSecret(env, "trial:" + devFp) : "";
    /* The grant itself. Without it the client has a date and a boolean, both
       of which it can write for itself; with it the client has a signature it
       cannot produce. A mint failure is a 503, not a token-free 200 — a
       client that gets a date it cannot verify unlocks nothing anyway, and
       saying so is more useful than pretending the trial started. */
    let tt;
    try {
      tt = await mintTrialToken(env, { identityFp, devFp, startedAt: claimed.startedAt, ks });
    } catch { return json({ error: "unavailable" }, 503, origin); }

    // Register the trial device so it is on the account's device screen from
    // the first day, not only once it buys something.
    await touchSession(env, {
      devFp, keyFp: null, emailFp: identityFp,
      plat: sessionPlat(body.plat), geo: sessionGeo(request), label: str(body.label)
    });
    await enforceFreeDeviceLimit(env, identityFp, devFp);

    return json({
      startedAt: claimed.startedAt,
      already: claimed.already,
      verified: true,
      tt,
      exp: claimed.startedAt + TRIAL_MS,
      ks,
      ksPrev
    }, 200, origin);
  }

  /* ---------- /checkout ----------
     Opens a hosted session and hands back its URL plus our own ref. Nothing
     here is a secret: the URL is public by construction and the ref is inert
     without the device key that just signed for it. */
  if (route === "/checkout") {
    /* No sale to an anonymous device. The whole reason a buyer never has to
       paste a key is that the purchase is bound to a verified address at the
       moment it is made; a checkout opened without one produces a licence
       with no owner row, and its buyer has nothing to restore from after a
       reinstall except the key in their email. Refuse here rather than sell
       them that problem. */
    if (!identityFp) return json({ error: "unverified" }, 401, origin);
    if (await checkoutRateLimited(env, devFp, ip)) return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));

    const made = await openOrder(env, devFp);
    /* "closed" is a deployment with no product configured. It is deliberately
       a distinct answer from an upstream failure, because the popup should
       say the store is not open rather than blame the network. */
    if (made.branch === "closed") return json({ error: "store closed" }, 503, origin);
    if (made.branch === "throttled") return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));
    if (made.branch !== "ok") return json({ error: "upstream" }, 503, origin);
    return json({ ref: made.ref, url: made.url }, 200, origin);
  }

  /* ---------- /checkout/claim ----------
     200 for every state, "unknown" included. These are answers to a poll and
     not failures, and a client that reads the status code as the verdict
     would give up on "not yet". */
  if (route === "/checkout/claim") {
    const claimed = await claimOrder(env, devFp, ref);
    /* Ownership is written HERE, at the one moment the key and the buyer's
       identity are both in hand. Waiting for the first /entitlement call
       works too, but only if that call carries an identity token — and a
       purchase that never got an owner row is a purchase that cannot be
       restored, which is the failure this whole path exists to prevent. */
    if (claimed.state === "ready" && identityFp) {
      await bindOwner(env, await sha256Hex(claimed.key), identityFp, claimed.key);
    }
    return json(claimed, 200, origin);
  }

  /* ---------- the device screen ----------
     Every route here needs an identity, and says so with 401 rather than
     pretending the account has no devices. Listing somebody's machines and
     signing them out are account powers, and the account is the verified
     email — not the licence key, which is a bearer secret anyone downstream
     of a forum post might be holding. */
  if (route === "/sessions" || terminating) {
    if (!identityFp) return json({ error: "unverified" }, 401, origin);
    const db = d1(env);
    if (!db) return json({ error: "unavailable" }, 503, origin);

    /* Per-account, not per-key: these routes carry no licence key, so the key
       bucket cannot see them. Twenty mutations an hour is far more than a
       person clicks and far less than a script needs. */
    if (await rateLimited(env, "acct:" + identityFp, ip)) {
      return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));
    }

    /* Free accounts are on the device screen while SESSION_SCOPE is "all".
       Flipping it to "paid" is the whole switch — no extension release, and
       every ledger below stays exactly as it is. */
    if (sessionScope(env) === "paid" && !(await accountHasLicence(db, identityFp))) {
      return json({ error: "paid only" }, 403, origin);
    }

    /* A trial or free device holds no seat and never reaches /entitlement, so
       nothing else ever writes its row — it would open this screen and not
       find itself. List route only: on a terminate, the caller's row is either
       already there or is about to be killed. */
    if (route === "/sessions") {
      await touchSession(env, {
        devFp, keyFp: null, emailFp: identityFp,
        plat: sessionPlat(body.plat), geo: sessionGeo(request), label: str(body.label)
      });
      await enforceFreeDeviceLimit(env, identityFp, devFp);
    }

    let state, devices;
    try {
      state = await accountState(db, identityFp);
      devices = await listSessions(env, identityFp, devFp);
    } catch { return json({ error: "unavailable" }, 503, origin); }
    if (!devices) return json({ error: "unavailable" }, 503, origin);

    if (route === "/sessions") {
      return json({ version: state.version, limit: SEAT_LIMIT, devices }, 200, origin);
    }

    /* A retry of a call that landed and then lost its connection. Answering it
       again from the ledger is the difference between "sign out one device"
       and "sign out two", and the client cannot tell the two cases apart from
       its side — only this row can. */
    let prior;
    try { prior = await replayOp(db, opId, identityFp); }
    catch { return json({ error: "unavailable" }, 503, origin); }
    if (prior) return json({ ...prior, devices, replayed: true }, 200, origin);

    /* The screen has moved under them. Answer with the list they should have
       been looking at rather than terminating a row that is no longer there. */
    if (ifVersion !== null && ifVersion !== state.version) {
      return json({ error: "stale", version: state.version, devices }, 412, origin);
    }

    let rows;
    if (route === "/sessions/terminate") {
      const marks = targets.map((_, i) => `?${i + 2}`).join(", ");
      try {
        const res = await db.prepare(
          `SELECT dev_fp, key_fp FROM sessions WHERE email_fp = ?1 AND dev_fp IN (${marks})`
        ).bind(identityFp, ...targets).all();
        rows = (res && res.results) || [];
      } catch { return json({ error: "unavailable" }, 503, origin); }
      /* A target that is not on this account is dropped, not refused: it is
         either already gone — which is the outcome being asked for — or it
         belongs to somebody else, and confirming which would turn this route
         into a way to test whether a fingerprint is a stranger's device. */
      if (!rows.length) {
        return json({ ok: true, version: state.version, terminated: [], devices }, 200, origin);
      }
    } else {
      /* Sign out of all devices. The one irreversible button on the screen, so
         it wants a person at the keyboard rather than a token found in a
         copied profile — see IDENTITY_FRESH_MS. */
      const fresh = identityClaims && (Date.now() - identityClaims.iat) < IDENTITY_FRESH_MS;
      if (!fresh) return json({ error: "reauth" }, 401, origin);
      /* Keeping the device you are standing on is the default, because the
         alternative is a person signing themselves out of the screen they are
         using to do it. `keep_self: false` is the deliberate opposite. */
      const keepSelf = body.keep_self !== false;
      const cut = new Set(devices.filter((d) => !(keepSelf && d.self)).map((d) => d.device));
      /* listSessions() does not hand back key_fp — it is not the popup's
         business — so the seats being cut are read here instead. */
      try {
        const res = await db.prepare(
          "SELECT dev_fp, key_fp FROM sessions WHERE email_fp = ?1").bind(identityFp).all();
        rows = ((res && res.results) || [])
          .filter((r) => cut.has(String(r.dev_fp)))
          .map((r) => ({ dev_fp: String(r.dev_fp), key_fp: r.key_fp ? String(r.key_fp) : "" }));
      } catch { return json({ error: "unavailable" }, 503, origin); }
      if (!rows.length) {
        return json({ ok: true, version: state.version, terminated: [], devices }, 200, origin);
      }
    }

    let result;
    try {
      result = await killTargets(env, {
        emailFp: identityFp, rows, by: "owner", opId, version: state.version,
        kind: route === "/sessions/terminate" ? "terminate" : "terminate-all",
        setEpoch: route === "/sessions/terminate-all"
      });
    } catch { return json({ error: "unavailable" }, 503, origin); }

    let after;
    try { after = await listSessions(env, identityFp, devFp); } catch { after = null; }
    return json({ ...result, devices: after || [] }, 200, origin);
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

  /* ---------- /session ----------
     The cheap, frequent question the 30-day token deliberately does not ask.

     Everything else here is about ISSUING an entitlement; this is the only
     route that can take one away, and it is the reason a device screen is not
     theatre. It answers exactly three ways:

       live: true    keep working
       live: false   an ANSWER — the seat is gone, the account signed you out.
                     The client clears its token on this and nothing else.
       503           we do not know. Keep working. An outage is not a verdict,
                     and this is the function where that rule is easiest to
                     lose: every failure below returns 503, never live:false.

     No identity is required. A device may always ask about itself, and the
     device proof already says which device is asking. */
  if (route === "/session") {
    if (await sessionRateLimited(env, keyFp, ip)) {
      return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));
    }
    if (killed) return json({ live: false, reason: "revoked" }, 200, origin);

    /* A cached "live" is worth at most SESSION_MIRROR_TTL_S, and every path
       that removes a seat drops this key, so the usual case is instant. */
    if (await readMirror(env, keyFp, devFp)) {
      return json({ live: true, reason: "", cached: true }, 200, origin);
    }

    let verdict;
    try { verdict = await sessionVerdict(env, { devFp, keyFp, emailFp: identityFp }); }
    catch { return json({ error: "unavailable" }, 503, origin); }

    if (!verdict.live) {
      await dropMirror(env, keyFp, devFp);
      return json({ live: false, reason: verdict.reason }, 200, origin);
    }
    const seen = Date.now();
    await noteSessionSeen(env, devFp, seen);
    await writeMirror(env, keyFp, devFp, { c: verdict.claimedAt || 0, s: seen });
    return json({ live: true, reason: "" }, 200, origin);
  }

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
    if (await rateLimited(env, keyFp, ip)) return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));

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

  if (await rateLimited(env, keyFp, ip)) return json({ error: "slow down" }, 429, origin, retryAfter(RL_WINDOW_S * 1000));

  /* ---------- step 5: licence validity ---------- */
  const check = await dodoValidate(env, licenseKey, instanceId);
  if (check.branch === "notfound" || check.branch === "invalid") return json({ error: "unknown licence" }, 404, origin);
  if (check.branch === "inactive") return json({ error: "licence inactive" }, 403, origin);
  if (check.branch !== "ok") return json({ error: "upstream" }, 503, origin);

  // Evidence only; never blocks. See observeSharing().
  await observeSharing(env, keyFp);

  /* ---------- step 6: seat ---------- */
  const activating = body.intent === "activate";
  let seat = await claimSeat(env, keyFp, devFp, { emailFp: identityFp, activate: activating });
  /* Full, and this caller has an identity the ledger already knows owns the
     licence: a reinstall carrying a new device key. Evict the stalest seat
     instead of refusing a buyer their own purchase. An unverified caller
     never reaches this — the seat cap has to stay a cap. */
  if (!seat.ok && seat.reason !== "signed-out" && identityFp
      && await ownsLicence(env, keyFp, identityFp) && await evictOldestSeat(env, keyFp)) {
    seat = await claimSeat(env, keyFp, devFp, { emailFp: identityFp, activate: activating });
  }
  if (!seat.ok && seat.reason === "signed-out") {
    return json({ error: "signed out" }, 403, origin);
  }
  if (!seat.ok) return json({ error: "device limit reached", seats: seat.seats }, 422, origin);

  /* Record who owns this, so /restore can find it after an uninstall. Done
     on every successful check rather than only at activation, so buyers who
     verify an identity months after paying are bound too. */
  if (identityFp) await bindOwner(env, keyFp, identityFp, licenseKey);

  /* The row the device screen shows for this machine. `plat` and `label` are
     unsigned body fields on purpose: the row is keyed on a PROVEN dev_fp, so a
     device can only ever label itself, and adding fields to the signed input
     would 426 every installed client over a cosmetic string. */
  await touchSession(env, {
    devFp, keyFp, emailFp: identityFp,
    plat: sessionPlat(body.plat), geo: sessionGeo(request), label: str(body.label)
  });

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
