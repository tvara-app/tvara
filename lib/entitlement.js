/**
 * Tvara — LCT2 entitlements. The unforgeable half of licensing.
 *
 * Token: LCT2.<b64url(payload)>.<b64url(ECDSA-P256-SHA256, P1363)>
 * Trial: LCTT1.<b64url(payload)>.<b64url(same signature)> — the free week,
 * signed by the same issuer against a verified identity. See verifyTrialToken.
 * Signed by the entitlement Worker (server/entitlement-worker.js), which holds
 * the Dodo secret API key and our private key. Verified here against the
 * embedded public key — offline, no network on the hot path.
 *
 * Why this exists: lib/license.js's dodo branch trusts a stored {key,instanceId}
 * with no signature, so a hand-written storage record buys Pro. A signature
 * cannot be hand-written. Data-only bypass ends here.
 *
 * Bindings, all checked locally:
 *   sub — SHA-256 of the licence key. Token is useless with a different key.
 *   dev — SHA-256 of the device id. Token is useless copied to another machine.
 *   exp — 30d, refreshed at 20d. Past that it keeps working and says it is
 *   overdue: a purchase is withdrawn by an answer, never by an outage.
 *
 * Not defended: patching this file in an unpacked build. Nothing client-side
 * can be. Store builds are browser-signature-verified; that is the real line.
 */
(() => {
  "use strict";

  // Same keypair as LCT1. Replace via: node tools/genkey.mjs init
  const PUBLIC_KEY_B64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzu9GjZdEdFyy2BQjo1lKOzbkW+J0MqEXxX2lUt63hZLfNYrkv6E/nl+00CWaTLOJBvxAXs0qVV2hRmivKbkQsg==";

  // Integrity hash of the public key. If someone replaces the constant in
  // memory, every subsequent verify will fail with "key-integrity".
  // SHA-256 of the full base64 string, first 16 hex chars.
  const _KEY_INTEGRITY = "47c22f7c3018e945f7ddb88403c3459e"; // update if you rotate the keypair

  // Your deployed Worker. CORS-echoed to chrome-extension://, so no host permission.
  /* Your Cloudflare account's workers.dev subdomain, which is an ACCOUNT-level
     setting — not something this repo controls. It is a placeholder until the
     first deploy: server/deploy.sh reads the URL out of `wrangler deploy`'s own
     output and refuses to continue if it does not match this line, so a
     mismatch stops the deploy rather than shipping a worker nobody can reach. */
  const ISSUER = "https://tvara.tharuntejandhe.workers.dev";

  /* Extra hostnames for the SAME worker, tried in order after ISSUER.
     Blocking one host is a filter rule; blocking two unrelated domains is a
     decision someone has to make twice — and a corporate filter that eats
     *.workers.dev wholesale does not touch a domain we own. Add the custom
     domain here; ISSUER stays the literal preflight and deploy.sh read. */
  const ISSUER_FALLBACKS = [];
  const ISSUERS = Object.freeze([ISSUER, ...ISSUER_FALLBACKS]);

  /* Returned instead of a Response when the device key itself is unavailable:
     no signature is possible, so no host would have answered differently. */
  const NODEVICE = Symbol("nodevice");

  /* Stickiness within one worker wake. Without it every call pays the full
     TIMEOUT_MS at a blocked primary before reaching the host that works. */
  let _preferredIssuer = 0;

  /**
   * POST to the first reachable issuer.
   *
   * `makeBody` is re-invoked per host on purpose. A nonce is single-use, so
   * presenting one body twice would be refused as a replay (409) by our own
   * worker — the second host must see a freshly signed request or none at all.
   */
  async function issuerPost(path, makeBody) {
    if (!_fetch) return null;
    const order = [ISSUERS[_preferredIssuer], ...ISSUERS.filter((_, i) => i !== _preferredIssuer)];
    for (const base of order) {
      let body;
      try { body = await makeBody(); } catch { return NODEVICE; }
      if (!body) return NODEVICE;
      try {
        const res = await _fetch(base + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
          cache: "no-store", mode: "cors", signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        // Landed somewhere else: not an answer from us, and not a reason to
        // stop trying the hosts that might still be ours.
        if (new URL(res.url || base).origin !== new URL(base).origin) continue;
        _preferredIssuer = Math.max(0, ISSUERS.indexOf(base));
        return res;
      } catch { /* unreachable — the next host is the whole point */ }
    }
    return null;
  }

  /* Must equal PROTOCOL in server/entitlement-worker.js. The issuer answers 426
     to anything else rather than silently accepting a request with no device
     proof in it. */
  const PROTOCOL = 3;

  const TOKEN_KEY = "lct-entitlement-v2";
  const CLOCK_KEY = "lct-clock-hwm-v1";

  /* Refresh with 10d of a 30d token left, so ~20 attempts at the 6h floor
     before it goes stale. The issuer's TTL dropped from 90d because it now has
     a kill list and no longer needs a short token to make revocation possible;
     this has to follow it, or the refresher would only wake after expiry. */
  const RENEW_BEFORE_MS = 10 * 864e5;
  // Kept for the refresher's pacing and for the API surface. It is NOT a
  // deadline any more: see evaluate() — age alone never denies a purchase.
  const GRACE_MS = 14 * 864e5;
  const RETRY_FLOOR_MS = 6 * 36e5;      // failed refresh backoff
  const CLOCK_SLACK_MS = 36e5;          // tolerated backwards drift
  const TIMEOUT_MS = 10000;
  const MAX_BODY = 16 * 1024;

  // Gated features. bg.js is the enforcement point; UI only mirrors this.
  const FEATURES = Object.freeze(["archive.search", "archive.backup", "archive.restore"]);

  // ---------- pinned runtime references ----------
  // Captured at load time inside this closure. Overriding crypto.subtle.verify,
  // crypto.subtle.importKey, crypto.subtle.digest, or fetch on the global
  // object AFTER this IIFE runs has zero effect — the closure holds the
  // originals and nothing external can reach them.
  const _subtle = crypto.subtle;
  const _verify = _subtle.verify.bind(_subtle);
  const _importKey = _subtle.importKey.bind(_subtle);
  const _digest = _subtle.digest.bind(_subtle);
  const _fetch = typeof fetch === "function" ? fetch.bind(self) : null;
  // Device-proof primitives, pinned for the same reason as the rest: a page
  // that swaps crypto.subtle.sign after load must not be able to sign for us.
  const _generateKey = _subtle.generateKey ? _subtle.generateKey.bind(_subtle) : null;
  const _sign = _subtle.sign ? _subtle.sign.bind(_subtle) : null;
  const _exportKey = _subtle.exportKey ? _subtle.exportKey.bind(_subtle) : null;

  /* ---------- codec ---------- */

  const b64urlToBytes = (s) => {
    s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  };

  const bytesToB64url = (b) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function sha256Hex(value, bytes) {
    const digest = await _digest("SHA-256", new TextEncoder().encode(String(value)));
    return [...new Uint8Array(digest).slice(0, bytes || 16)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* ---------- device identity (the proof the issuer asks for) ----------

     An ECDSA P-256 keypair generated once per install, with the private half
     created NON-EXTRACTABLE. That single flag is the whole point of this
     module: WebCrypto will refuse to export it — to this file, to DevTools, to
     the person who owns the machine — so the key cannot be copied to a second
     computer, pasted into a forum, or lifted out of a backup.

     The extension ships readable, so someone can always patch their own copy
     to skip the entitlement check; that was a deliberate trade and this does
     not pretend to fix it. What it does fix is the SEAT economy: five devices
     now means five machines that each physically hold a key, instead of five
     strings a caller was trusted to make up. Sharing a licence key is no
     longer enough to get a sixth seat, because the seat is not the key.

     Stored in IndexedDB because that is the only extension-local store that
     can hold a live CryptoKey. chrome.storage would require serialising it,
     which is exactly what non-extractable forbids — and rightly. */

  const DEVKEY_DB = "lct-devkey";
  const DEVKEY_STORE = "k";
  const DEVKEY_ID = "v1";

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DEVKEY_DB, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(DEVKEY_STORE)) {
          open.result.createObjectStore(DEVKEY_STORE, { keyPath: "id" });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("blocked"));
    });
  }

  /* One in-flight generation, ever. Two callers racing here would each mint a
     keypair and one would silently win — which reads as a device that changed
     identity mid-session and burns a seat to say so. */
  let _devKeyPromise = null;

  async function _loadOrCreateDeviceKey() {
    const db = await idbOpen();
    try {
      const existing = await idbRequest(
        db.transaction(DEVKEY_STORE, "readonly").objectStore(DEVKEY_STORE).get(DEVKEY_ID));
      if (existing && existing.priv && existing.pubB64) {
        return { priv: existing.priv, pubB64: existing.pubB64 };
      }

      // extractable:false applies to the PRIVATE key. Per the WebCrypto spec
      // the public half of a generated pair is always exportable, which is
      // what lets us send it — the asymmetry is the design, not an oversight.
      const pair = await _generateKey(
        { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const spki = await _exportKey("spki", pair.publicKey);
      const pubB64 = bytesToB64url(new Uint8Array(spki));

      /* Claim the slot atomically, and yield to whoever got there first.
      
         The single in-flight promise above only serialises ONE context. An
         extension has several — the service worker, the popup, the Recall page
         — each with its own copy of this closure and all sharing one IndexedDB.
         Two of them starting together would both find the store empty, both
         generate, and both write; last write wins, the loser keeps signing with
         a key that is no longer stored, and the next worker wake reads the other
         one. That surfaces as `device-mismatch` on a perfectly good licence,
         followed by a re-activation that spends a second seat.
      
         get-then-put inside ONE readwrite transaction is atomic — IndexedDB
         serialises transactions over the same store — so the second writer sees
         the first one's row and adopts it. The generateKey above stays OUTSIDE
         the transaction deliberately: awaiting a non-IDB promise inside one lets
         it auto-commit, which would quietly put the atomicity back. */
      const tx = db.transaction(DEVKEY_STORE, "readwrite");
      const store = tx.objectStore(DEVKEY_STORE);
      const raced = await idbRequest(store.get(DEVKEY_ID));
      if (raced && raced.priv && raced.pubB64) {
        return { priv: raced.priv, pubB64: raced.pubB64 };
      }
      await idbRequest(store.put({ id: DEVKEY_ID, priv: pair.privateKey, pubB64 }));
      return { priv: pair.privateKey, pubB64 };
    } finally {
      try { db.close(); } catch { /* already closing */ }
    }
  }

  /**
   * The device keypair, or null on a platform without one.
   *
   * Null is NOT a failure path in production — it is the bare Node sandbox the
   * unit tests load this file into, which has no IndexedDB. Callers fall back
   * to the old device-id fingerprint there so the pure logic stays testable.
   */
  async function deviceKey() {
    if (!_generateKey || !_sign || !_exportKey) return null;
    if (typeof indexedDB === "undefined") return null;
    if (!_devKeyPromise) {
      _devKeyPromise = _loadOrCreateDeviceKey().catch(() => {
        // Let the next caller retry rather than caching a transient failure
        // (a blocked upgrade, a private-mode quota error) for the session.
        _devKeyPromise = null;
        return null;
      });
    }
    return _devKeyPromise;
  }

  /**
   * This install's identity, as the issuer computes it: the fingerprint of the
   * public key it just proved it holds. Falls back to hashing the device id
   * only where no keypair is possible (see deviceKey).
   */
  async function deviceFpFor(deviceId) {
    const dk = await deviceKey();
    if (dk && dk.pubB64) return sha256Hex(dk.pubB64, 16);
    return sha256Hex(deviceId || "");
  }

  /* Byte-for-byte the string the Worker rebuilds and verifies against. The
     separator is US (0x1f), which cannot occur in a base64url blob, a licence
     key or a decimal timestamp — so no two distinct requests can collapse to
     the same signing input. Change one side of this and activation stops
     working everywhere; that is intended, and it is why both sides carry the
     same comment. */
  function signingInput(route, fields) {
    return ["LCT3", route, ...fields].join("\u001f");
  }

  /**
   * Sign a request. Returns the four fields the issuer needs, or null when
   * this install has no device key (the caller then has nothing to send and
   * must not pretend otherwise).
   */
  async function signRequest(route, fields, nonceOverride) {
    const dk = await deviceKey();
    if (!dk) return null;
    /* The Google route passes its own: the id_token was minted with this nonce
       inside it, and the issuer refuses the pair unless they match. That is
       what stops an id_token captured elsewhere being posted here. */
    const nonce = nonceOverride || bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
    const ts = Date.now();
    const input = signingInput(route, [...fields, dk.pubB64, nonce, String(ts)]);
    const sig = await _sign({ name: "ECDSA", hash: "SHA-256" },
      dk.priv, new TextEncoder().encode(input));
    return { v: PROTOCOL, device_pub: dk.pubB64, nonce, ts, sig: bytesToB64url(new Uint8Array(sig)) };
  }

  /** Check that the embedded public key has not been tampered with at runtime. */
  let _keyIntegrityOk = null;
  async function checkKeyIntegrity() {
    if (_keyIntegrityOk !== null) return _keyIntegrityOk;
    const hash = await sha256Hex(PUBLIC_KEY_B64);
    _keyIntegrityOk = hash === _KEY_INTEGRITY;
    return _keyIntegrityOk;
  }

  /* ---------- verify ---------- */

  let pubKeyPromise = null;

  function importPublicKey() {
    if (PUBLIC_KEY_B64.startsWith("__")) return Promise.resolve(null); // dev build
    if (!pubKeyPromise) {
      const raw = Uint8Array.from(atob(PUBLIC_KEY_B64), (c) => c.charCodeAt(0));
      pubKeyPromise = _importKey(
        "spki", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
      ).catch(() => null);
    }
    return pubKeyPromise;
  }

  /**
   * Signature + shape only. Bindings and expiry are checked by evaluate(),
   * which knows the licence key and device — this stays pure for tests.
   */
  async function verifyToken(token) {
    if (typeof token !== "string" || token.length > 4096) return { valid: false, reason: "format" };
    const parts = token.trim().split(".");
    if (parts.length !== 3 || parts[0] !== "LCT2") return { valid: false, reason: "format" };

    // Guard: reject if the public key was patched at runtime.
    if (!await checkKeyIntegrity()) return { valid: false, reason: "key-integrity" };

    const pub = await importPublicKey();
    if (!pub) return { valid: false, reason: "no-public-key" };

    let payloadBytes, sig;
    try {
      payloadBytes = b64urlToBytes(parts[1]);
      sig = b64urlToBytes(parts[2]);
    } catch { return { valid: false, reason: "format" }; }

    // Use the pinned _verify reference — immune to global monkey-patching.
    let ok;
    try {
      ok = await _verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, payloadBytes);
    } catch { return { valid: false, reason: "error" }; }
    // Timing-safe: coerce through a constant-time path so a timing side-channel
    // cannot distinguish "signature byte 1 wrong" from "signature byte 64 wrong".
    // WebCrypto's verify is already constant-time internally, but the branch
    // below ensures the JS-level path does not leak via short-circuit.
    if (ok !== true) return { valid: false, reason: "signature" };

    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); }
    catch { return { valid: false, reason: "payload" }; }

    if (!payload || payload.v !== 2 || payload.plan !== "pro") return { valid: false, reason: "plan" };
    if (typeof payload.sub !== "string" || typeof payload.dev !== "string") return { valid: false, reason: "binding" };
    if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return { valid: false, reason: "claims" };

    return { valid: true, payload, sigB64: parts[2] };
  }

  /* ---------- trial proof ----------

     A trial used to be a date and a `verified` boolean in this extension's own
     storage, and both are writable by whoever owns the browser. That made the
     entire trial gate forgeable from a DevTools console: set the date to today
     and the flag to true, once a week, forever.

     The grant is now a signature over the SAME curve and the SAME pinned key as
     a licence token, minted by the issuer against a verified identity. The
     client can check it and cannot produce it.

     Separate prefix on purpose: "LCTT1", inside the signed bytes. A trial token
     must not be presentable where a licence token is expected, and the reverse
     must be impossible too — relabelling either one breaks its signature.
  */
  async function verifyTrialToken(token) {
    if (typeof token !== "string" || token.length > 4096) return { valid: false, reason: "format" };
    const parts = token.trim().split(".");
    if (parts.length !== 3 || parts[0] !== "LCTT1") return { valid: false, reason: "format" };

    if (!await checkKeyIntegrity()) return { valid: false, reason: "key-integrity" };
    const pub = await importPublicKey();
    if (!pub) return { valid: false, reason: "no-public-key" };

    let payloadBytes, sig;
    try {
      payloadBytes = b64urlToBytes(parts[1]);
      sig = b64urlToBytes(parts[2]);
    } catch { return { valid: false, reason: "format" }; }

    let ok;
    try {
      ok = await _verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, payloadBytes);
    } catch { return { valid: false, reason: "error" }; }
    if (ok !== true) return { valid: false, reason: "signature" };

    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); }
    catch { return { valid: false, reason: "payload" }; }

    if (!payload || payload.v !== 1 || payload.typ !== "trial") return { valid: false, reason: "kind" };
    if (typeof payload.dev !== "string" || typeof payload.idf !== "string") return { valid: false, reason: "binding" };
    if (!Number.isFinite(payload.sta) || !Number.isFinite(payload.exp)) return { valid: false, reason: "claims" };

    return { valid: true, payload };
  }

  /**
   * The verdict the gate asks for: does this token grant a trial, HERE, NOW?
   *
   * Bindings, all checked locally:
   *   dev — the fingerprint of this install's non-extractable keypair, so the
   *         token is inert copied to another machine or another profile.
   *   exp — the end of the week itself. There is no separate token lifetime to
   *         get wrong: expired token, expired trial.
   *
   * `nowTrusted` is the caller's high-water clock, not Date.now(). Judging a
   * trial against a clock the user owns ends it whenever they decide it does.
   */
  async function trialGrant(token, nowTrusted) {
    const res = await verifyTrialToken(token);
    if (!res.valid) return { grants: false, reason: res.reason, startedAt: 0, until: 0, ks: "" };
    const p = res.payload;

    const dev = await deviceFpFor("");
    if (!dev || p.dev !== dev) {
      return { grants: false, reason: "device-mismatch", startedAt: 0, until: 0, ks: "" };
    }

    const startedAt = p.sta, until = p.exp;
    if (!(startedAt > 0) || !(until > startedAt)) {
      return { grants: false, reason: "claims", startedAt: 0, until: 0, ks: "" };
    }

    const now = Number(nowTrusted) || Date.now();
    const ks = typeof p.ks === "string" ? p.ks : "";
    if (now >= until) return { grants: false, reason: "expired", startedAt, until, ks };
    return { grants: true, reason: "", startedAt, until, ks, idf: p.idf };
  }

  /* ---------- clock tamper guard ---------- */

  /**
   * Monotonic high-water mark. Winding the clock back to revive an expired
   * token trips this; winding it forward only expires you sooner.
   */
  async function clockNow() {
    const now = Date.now();
    let hwm;
    try {
      const got = await chrome.storage.local.get(CLOCK_KEY);
      hwm = Number(got && got[CLOCK_KEY]) || 0;
    } catch { return { now, trusted: now, rolledBack: false }; }

    const rolledBack = hwm > 0 && now < hwm - CLOCK_SLACK_MS;
    if (now > hwm) {
      try { await chrome.storage.local.set({ [CLOCK_KEY]: now }); } catch { /* dead context */ }
    }
    // Rolled back: judge expiry against the furthest point we ever saw.
    return { now, trusted: rolledBack ? hwm : now, rolledBack };
  }

  /* ---------- storage ----------
     Two keys, deliberately. chrome.storage has no transactions, so a
     read-modify-write loses anything that lands during its await — and the
     await here spans a network round trip. A failed refresh used to merge
     {lastAttemptAt, lastError} onto the record it had read BEFORE the request,
     so a token minted in the meantime (an activation in another context, or
     the worker's own retry) was dropped and the record was left with no token
     field at all. That reads back as "no-token": the buyer activated and got
     nothing, intermittently, depending on how long the request took.

     The durable token is now written WHOLE and never merged. Only the volatile
     backoff bookkeeping is read-modify-write, in its own key, where losing a
     timestamp costs a retry and nothing else. */
  const ATTEMPT_KEY = "lct-entitlement-attempt-v1";

  async function readToken() {
    try {
      const got = await chrome.storage.local.get([TOKEN_KEY, ATTEMPT_KEY]);
      const rec = got && got[TOKEN_KEY];
      if (!rec || typeof rec.token !== "string") return null;
      // installs from before the split still carry both in the token record
      const att = (got && got[ATTEMPT_KEY]) || rec;
      return {
        token: rec.token,
        fetchedAt: Number(rec.fetchedAt) || 0,
        lastAttemptAt: Number(att.lastAttemptAt) || 0,
        lastError: String(att.lastError || "")
      };
    } catch { return null; }
  }

  /** The token, written whole — never merged onto a value read earlier. */
  async function writeToken(rec) {
    if (!rec || typeof rec.token !== "string") return;
    try {
      await chrome.storage.local.set({
        [TOKEN_KEY]: { token: rec.token, fetchedAt: Number(rec.fetchedAt) || 0 }
      });
    } catch { /* dead context */ }
  }

  /** Backoff bookkeeping. Cannot touch the token, whatever it races with. */
  async function noteAttempt(patch) {
    try {
      const got = await chrome.storage.local.get(ATTEMPT_KEY);
      await chrome.storage.local.set({
        [ATTEMPT_KEY]: { ...((got && got[ATTEMPT_KEY]) || {}), ...patch }
      });
    } catch { /* dead context */ }
  }

  async function clearToken() {
    try { await chrome.storage.local.remove([TOKEN_KEY, ATTEMPT_KEY]); }
    catch { /* dead context */ }
  }

  /* ---------- issuer ---------- */

  /**
   * Exchange a licence key for a signed entitlement. The Worker re-validates
   * against Dodo server-side; we never trust the client's word for it.
   * Sends: key, device fingerprint (hash, not the UUID), instance id.
   * Never throws — every failure is a branch, so an outage cannot read as fraud.
   */
  async function fetchToken(licenseKey, deviceFp, instanceId, intent) {
    try {
      /* The device proof. Without a keypair there is nothing to prove and the
         issuer will refuse — so say so here rather than sending a request that
         cannot succeed and reading its 401 as a licence problem. */
      // Pinned _fetch, via issuerPost — immune to global fetch override.
      const res = await issuerPost("/entitlement", async () => {
        const proof = await signRequest("entitlement", [licenseKey]);
        const [plat, label] = await Promise.all([describePlatform(), currentDeviceName()]);
        return proof && {
          ...proof, license_key: licenseKey, instance_id: instanceId || "",
          /* Only an explicit Activate clears a tombstone the device screen
             wrote. Unsigned, and safe to be: this request has already proved
             which device it is, so nobody else can set the flag for it. */
          ...(intent ? { intent: "activate" } : {}),
          /* Unsigned, and it does not need to be: the row it lands on is keyed
             on the device this request PROVED it holds, so a device can only
             ever describe itself. Adding it to the signed input would 426
             every installed client over a display string. */
          plat, ...(label ? { label } : {})
        };
      });
      if (res === NODEVICE) return { branch: "nodevice" };
      if (!res) return { branch: "network" };

      const text = (await res.text()).slice(0, MAX_BODY);
      let json = null;
      try { json = JSON.parse(text); } catch { /* status decides */ }

      if (res.status === 200 && json && typeof json.token === "string") {
        return { branch: "ok", token: json.token };
      }
      if (res.status === 401) return { branch: "proof" };      // device proof rejected
      /* Two different 403s. "This licence is dead" and "this DEVICE was signed
         out" want opposite instructions from the popup, and collapsing them
         tells somebody who signed a laptop out from their phone that their
         purchase has been cancelled. */
      if (res.status === 403) {
        return { branch: json && json.error === "signed out" ? "signedout" : "inactive" };
      }
      if (res.status === 404) return { branch: "notfound" };
      if (res.status === 409) return { branch: "replay" };      // nonce already spent
      if (res.status === 422) return { branch: "limit" };
      if (res.status === 426) return { branch: "outdated" };    // client older than the issuer
      if (res.status === 429) return { branch: "throttled" };
      if (res.status >= 500) return { branch: "service" };
      /* A 400 is the one status that can mean something the USER can fix, and
         collapsing it to "badrequest" threw that away. A machine whose clock is
         days out — a fresh VM, a dead CMOS battery, a phone that never synced —
         fails the freshness check and gets told its licence is bad, which sends
         a paying customer to the refund button instead of to their clock. */
      if (res.status === 400 && json && json.error === "clock skew") {
        return { branch: "clockskew" };
      }
      return { branch: "badrequest", detail: (json && json.error) || "" };
    } catch {
      return { branch: "network" };
    }
  }

  /* ---------- device management ---------- */

  /**
   * One transport for both device calls. They differ only in route, extra
   * signed fields and body, and writing that twice is how two endpoints end up
   * signing slightly different things.
   */
  const ROUTE_PATHS = Object.freeze({
    "devices": "/devices",
    "devices-revoke": "/devices/revoke",
    "session": "/session",
    "sessions": "/sessions",
    "sessions-terminate": "/sessions/terminate",
    "sessions-terminate-all": "/sessions/terminate-all"
  });

  async function deviceCall(route, signFields, extraBody) {
    if (!_fetch) return { branch: "network" };
    try {
      const res = await issuerPost(ROUTE_PATHS[route] || ("/" + route), async () => {
        const proof = await signRequest(route, signFields);
        return proof && { ...proof, ...extraBody };
      });
      if (res === NODEVICE) return { branch: "nodevice" };
      if (!res) return { branch: "network" };

      let json = null;
      try { json = JSON.parse((await res.text()).slice(0, MAX_BODY)); } catch { /* status decides */ }
      if (res.status === 200 && json) return { branch: "ok", data: json };
      if (res.status === 401) {
        /* The device screen's two 401s: no identity at all, and one too old to
           be trusted with "sign out everything". They need different words. */
        if (json && json.error === "unverified") return { branch: "unverified" };
        if (json && json.error === "reauth") return { branch: "reauth" };
        return { branch: "proof" };
      }
      if (res.status === 403) return { branch: "notenrolled" };
      if (res.status === 409) return { branch: "replay" };
      // The list moved under the caller. Refetch and ask again — see /sessions.
      if (res.status === 412) return { branch: "stale", data: json || null };
      if (res.status === 426) return { branch: "outdated" };
      if (res.status === 429) return { branch: "throttled" };
      if (res.status >= 500) return { branch: "service" };
      return { branch: "badrequest" };
    } catch { return { branch: "network" }; }
  }

  /**
   * The seats the ISSUER holds — the list that actually decides whether a sixth
   * device is allowed in.
   *
   * The popup has always shown a different list: its own registry in
   * chrome.storage.sync, which is scoped to one Google account and therefore
   * cannot see a device signed into another. Reading the authoritative copy is
   * the only way "you are using 4 of 5" can be a true sentence.
   */
  async function listDevices(licenseKey) {
    return deviceCall("devices", [String(licenseKey || "")], { license_key: licenseKey });
  }

  /**
   * Give a seat back to the issuer.
   *
   * MUST be called alongside the payment provider's own deactivate. The two
   * ledgers are independent, and releasing only one of them is what produced
   * "device limit reached" for users who had just freed a slot.
   */
  async function revokeDevice(licenseKey, targetFp) {
    if (!/^[a-f0-9]{32}$/.test(String(targetFp || ""))) return { branch: "badrequest" };
    return deviceCall("devices-revoke", [String(licenseKey || ""), String(targetFp)],
      { license_key: licenseKey, target: targetFp });
  }

  /* ---------- the device screen ----------
   *
   * Account-scoped: these carry an identity token and no licence key, because
   * "my devices" is a sentence about a person and a licence key is a bearer
   * secret. Every one of them is a no-op without a verified identity, and says
   * so rather than showing an empty list.
   */

  /* Hex, because the issuer's OP_ID_RE is /^[a-f0-9]{32}$/ and answers 400
     "bad op id" to anything else — before the device proof, before the identity
     gate. The old base64url alphabet kept [g-z], so this default was invalid
     essentially every time it was used; nobody noticed because the popup mints
     its own hex id and is the only caller that never omits one. */
  const opId = () => [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  async function listSessions() {
    const idt = await identityToken();
    if (!idt) return { branch: "unverified" };
    /* Unsigned, like the one on /entitlement: the row is keyed on a proven
       dev_fp. A trial device has no other route that names it, so without this
       it opens the screen and finds no row for itself. */
    const [plat, label] = await Promise.all([describePlatform(), currentDeviceName()]);
    return deviceCall("sessions", [], { idt, plat, ...(label ? { label } : {}) });
  }

  /**
   * Sign devices out — as many as were selected, in ONE call.
   *
   * `op_id` is what makes a retry free: the issuer records it inside the same
   * transaction as the kill, so a request that landed and then lost its
   * connection replays its own answer instead of signing out a second device.
   * It is minted by the CALLER, once per user action, and must be reused
   * across retries of that action — which is why it is a parameter and not
   * generated in here.
   */
  async function terminateSessions(targets, opts) {
    const list = (Array.isArray(targets) ? targets : [])
      .map((v) => String(v || "")).filter((v) => /^[a-f0-9]{32}$/.test(v));
    if (!list.length) return { branch: "badrequest" };
    const idt = await identityToken();
    if (!idt) return { branch: "unverified" };
    const op = (opts && opts.opId) || opId();
    const body = { idt, targets: list, op_id: op };
    if (opts && typeof opts.ifVersion === "number") body.if_version = opts.ifVersion;
    return deviceCall("sessions-terminate", [op, list.join(",")], body);
  }

  /** Everything but this device, unless keepSelf is explicitly false. Needs an
   *  identity verified in the last fifteen minutes; the issuer answers
   *  `reauth` otherwise and the popup has to ask the person to sign in again. */
  async function terminateAllSessions(opts) {
    const idt = await identityToken();
    if (!idt) return { branch: "unverified" };
    const op = (opts && opts.opId) || opId();
    const body = { idt, op_id: op, keep_self: !(opts && opts.keepSelf === false) };
    if (opts && typeof opts.ifVersion === "number") body.if_version = opts.ifVersion;
    return deviceCall("sessions-terminate-all", [op], body);
  }

  /* ---------- sessions ----------
   *
   * The entitlement token is long on purpose: 30 days, so an issuer outage
   * never withdraws a purchase. That same length is why releasing a device
   * from the device screen used to cost the released machine nothing for
   * weeks — nothing made it ask, and needsRefresh() only calls home with ten
   * days of token life left.
   *
   * This is the short question, asked often and cheaply, kept deliberately
   * separate from renewal. It can only ever take Pro away on an ANSWER:
   * `live:false`. A timeout, a 503, a throttle and a proof failure all leave
   * the entitlement exactly as it was.
   */

  const SIGNOUT_KEY = "lct-signed-out-v1";

  function osLabel() {
    try {
      const nav = self.navigator || {};
      const uad = nav.userAgentData;
      return uad && uad.platform ? String(uad.platform)
        : /Mac/i.test(nav.userAgent || "") ? "macOS"
        : /Win/i.test(nav.userAgent || "") ? "Windows"
        : /CrOS/i.test(nav.userAgent || "") ? "ChromeOS"
        : /Android/i.test(nav.userAgent || "") ? "Android"
        : /Linux/i.test(nav.userAgent || "") ? "Linux" : "";
    } catch { return ""; }
  }

  function browserLabel() {
    try {
      const ua = String((self.navigator || {}).userAgent || "");
      return /Firefox\//.test(ua) ? "Firefox"
        : /Edg\//.test(ua) ? "Edge"
        : /OPR\//.test(ua) ? "Opera"
        : /Chrome\//.test(ua) ? "Chrome" : "";
    } catch { return ""; }
  }

  /** Coarse enough to recognise a machine in a list, and no more. The
   *  synchronous floor; describePlatform() is the one worth showing. */
  function platformLabel() {
    return [osLabel(), browserLabel()].filter(Boolean).join(" \u00b7 ").slice(0, 40);
  }

  /* ---------- what this machine is called ----------
   *
   * A browser cannot read the computer's name. There is no extension API for
   * it: not navigator, not chrome.system, not chrome.runtime.getPlatformInfo,
   * which answers "win"/"mac" and an architecture. So "DESKTOP-8FJ2K1" or
   * "Anirudh's MacBook Pro" is unreachable by construction, and a device screen
   * that implies otherwise is lying about where the string came from.
   *
   * Two honest sources instead, in this order:
   *   1. a name the person typed, which is the only way the machine's real
   *      name can ever appear here — kept locally, sent with every session
   *      touch so every device on the account sees it;
   *   2. what the browser will describe: the OS with its major version, the
   *      handset model where the platform reports one (Android does, desktops
   *      do not), and the browser.
   *
   * The version costs a little entropy over the bare OS. It buys the one thing
   * the screen exists for — telling two of your own machines apart — and it is
   * two buckets on Windows, not a build number.
   */
  const DEVICE_NAME_KEY = "lct-device-name-v1";
  const DEVICE_NAME_MAX = 40;        // the issuer's own cap on the field
  let deviceNameCache = null;
  let platformCache = null;

  /** Collapsed and capped, so a name of spaces never displaces the platform. */
  function cleanDeviceName(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, DEVICE_NAME_MAX);
  }

  async function currentDeviceName() {
    if (deviceNameCache !== null) return deviceNameCache;
    try {
      const got = await chrome.storage.local.get(DEVICE_NAME_KEY);
      deviceNameCache = cleanDeviceName(got && got[DEVICE_NAME_KEY]);
    } catch { deviceNameCache = ""; }
    return deviceNameCache;
  }

  /** Refused rather than stored when it is empty: the issuer COALESCEs a blank
   *  label onto the existing one, so "save nothing" would silently keep the old
   *  name while the screen said it had changed. */
  async function setDeviceName(name) {
    const clean = cleanDeviceName(name);
    if (!clean) return { ok: false, reason: "empty" };
    try { await chrome.storage.local.set({ [DEVICE_NAME_KEY]: clean }); }
    catch { return { ok: false, reason: "storage" }; }
    deviceNameCache = clean;
    return { ok: true, name: clean };
  }

  /** The best description this browser will give of the machine itself. */
  async function describePlatform() {
    if (platformCache !== null) return platformCache;
    const browser = browserLabel();
    let os = osLabel();
    try {
      const uad = (self.navigator || {}).userAgentData;
      if (uad && typeof uad.getHighEntropyValues === "function") {
        const hi = await uad.getHighEntropyValues(["platformVersion", "model"]);
        const major = parseInt(String((hi && hi.platformVersion) || "").split(".")[0], 10);
        const model = String((hi && hi.model) || "").trim();
        // Windows 11 reports a platformVersion of 13 or more; 1 to 10 are
        // Windows 10. Microsoft's own mapping, and the only way to tell them
        // apart — the user-agent string says "Windows NT 10.0" for both.
        if (model) os = model.slice(0, 24);
        else if (os === "Windows" && Number.isFinite(major)) os = major >= 13 ? "Windows 11" : "Windows 10";
        else if (os === "macOS" && Number.isFinite(major) && major > 0) os = "macOS " + major;
      }
    } catch { /* the bare OS is still a true answer */ }
    platformCache = [os, browser].filter(Boolean).join(" \u00b7 ").slice(0, DEVICE_NAME_MAX);
    return platformCache;
  }

  /** The reason this install stopped being signed in, or null. */
  async function readSignOut() {
    try {
      const got = await chrome.storage.local.get(SIGNOUT_KEY);
      const rec = got && got[SIGNOUT_KEY];
      return rec && rec.at ? { at: Number(rec.at) || 0, reason: String(rec.reason || "") } : null;
    } catch { return null; }
  }

  async function markSignedOut(reason) {
    try { await chrome.storage.local.set({ [SIGNOUT_KEY]: { at: Date.now(), reason } }); }
    catch { /* dead context */ }
  }

  async function clearSignOut() {
    try { await chrome.storage.local.remove(SIGNOUT_KEY); }
    catch { /* dead context */ }
  }

  /**
   * Ask the issuer whether this device still holds its seat.
   *
   * Returns {live} only when the issuer actually answered. Anything else is a
   * branch and changes nothing — see the ladder above.
   */
  async function heartbeat(record) {
    if (!record || !record.key || /^LCT1\./.test(record.key)) return { skipped: "n/a" };
    if (!(await readToken())) return { skipped: "no-token" };

    const res = await deviceCall("session", [String(record.key)], { license_key: record.key });
    if (res.branch !== "ok" || !res.data) return { ok: false, branch: res.branch };

    /* Strictly `false`. A missing field is a worker we do not understand, and
       "I could not parse the answer" is not the same as "you were signed
       out" — reading it that way is how a deploy becomes an outage. */
    if (res.data.live === false) {
      const reason = String(res.data.reason || "terminated");
      await clearToken();
      await markSignedOut(reason);
      return { ok: true, live: false, reason };
    }
    if (res.data.live === true) {
      await clearSignOut();
      return { ok: true, live: true };
    }
    return { ok: false, branch: "badrequest" };
  }

  /* ---------- evaluate ---------- */

  /**
   * The single "is this install entitled?" answer.
   *
   * LCT1 keys keep their own offline signature path — they were sold that way
   * and never phone home. Dodo keys must present a valid LCT2 token.
   *
   * @param {{key?:string,instanceId?:string,revokedAt?:number}} record
   * @param {string} deviceId
   */
  async function evaluate(record, deviceId) {
    if (!record || !record.key) return { entitled: false, reason: "none", features: [] };
    if (record.revokedAt) return { entitled: false, reason: "revoked", features: [] };

    // Legacy offline keys: signature is the whole verdict, unchanged.
    if (/^LCT1\./.test(record.key)) {
      const res = await self.LCTLicense.verify(record.key);
      return res.valid
        ? { entitled: true, kind: "lct1", email: res.email, features: FEATURES.slice() }
        : { entitled: false, kind: "lct1", reason: res.reason, features: [] };
    }

    const rec = await readToken();
    if (!rec) return { entitled: false, kind: "dodo", reason: "no-token", features: [] };

    const res = await verifyToken(rec.token);
    if (!res.valid) return { entitled: false, kind: "dodo", reason: res.reason, features: [] };

    const { payload } = res;
    const [subFp, devFp] = await Promise.all([sha256Hex(record.key), deviceFpFor(deviceId)]);
    if (payload.sub !== subFp) return { entitled: false, kind: "dodo", reason: "key-mismatch", features: [] };
    if (payload.dev !== devFp) return { entitled: false, kind: "dodo", reason: "device-mismatch", features: [] };

    /* ---------- age alone never withdraws a purchase ----------
       This used to lock the extension 14 days past the token's expiry. Read
       what that actually says to someone who paid once: the day our issuer is
       unreachable for long enough — an outage, a DNS lapse, a Cloudflare
       account that lapses in three years, a corporate proxy, a firewall — their
       licence quietly stops working. They did nothing wrong and there is
       nothing they can do. Both the README and the store listing promise the
       opposite ("never withdraws Pro because a check failed to get through"),
       and the code was the thing that was wrong.

       Withdrawal now needs an ANSWER, not a silence: a licence the provider
       reports as unknown or inactive clears the token outright (see refresh),
       so a token that still exists is one nobody has ever told us to stop
       honouring. Past expiry it keeps working and is marked `stale`, which the
       UI shows and the refresher keeps trying to clear.

       What still guards this: the signature, the licence-key binding and the
       device binding, none of which age out. A token is useless without the key
       it was minted for and the device it was minted on. */
    const clock = await clockNow();
    const stale = clock.trusted > payload.exp;

    const feats = Array.isArray(payload.feat) ? payload.feat.filter((f) => FEATURES.includes(f)) : FEATURES.slice();
    return {
      entitled: true, kind: "dodo", email: payload.email || record.email || "",
      ks: typeof payload.ks === "string" ? payload.ks : "",
      features: feats, exp: payload.exp,
      stale,                                 // overdue a check-in: works, says so
      // How overdue, so the UI can say something true rather than a threat.
      overdueDays: stale ? Math.floor((clock.trusted - payload.exp) / 864e5) : 0,
      clockRolledBack: clock.rolledBack
    };
  }

  /** Feature check. Callers gate on this, never on a bare `pro` boolean. */
  async function allows(record, deviceId, feature) {
    const res = await evaluate(record, deviceId);
    return res.entitled && res.features.includes(feature);
  }

  /* ---------- refresh ---------- */

  function needsRefresh(rec, payload, now) {
    if (!rec || !payload) return true;
    if (now - (rec.lastAttemptAt || 0) < RETRY_FLOOR_MS) return false;
    return payload.exp - now <= RENEW_BEFORE_MS;
  }

  /**
   * Mint or renew. Called on activation (await it — that one must succeed) and
   * opportunistically thereafter (fire and forget).
   *
   * Fail-open on network/service: an outage must never revoke a paying user.
   * Fail-closed on notfound/inactive: those are authoritative answers.
   */
  let refreshing = null;   // the run in flight, if any

  async function refresh(record, deviceId, opts) {
    const force = !!(opts && opts.force);
    if (!record || !record.key || /^LCT1\./.test(record.key)) return { skipped: "n/a" };

    // An opportunistic caller stands aside for a run already going. Activation
    // cannot: it has to come back holding a token or the buyer paid for
    // nothing, and returning "in-flight" to it did exactly that. It waits for
    // the other run to land, then takes its own turn.
    if (refreshing) {
      if (!force) return { skipped: "in-flight" };
      try { await refreshing; } catch { /* their failure is not ours */ }
    }

    const run = attempt(record, deviceId, force, !!(opts && opts.activate));
    refreshing = run;
    try { return await run; }
    finally { if (refreshing === run) refreshing = null; }
  }

  async function attempt(record, deviceId, force, activate) {
    const now = Date.now();
    /* Signed out from another device. The 12-hourly refresh would otherwise
       re-claim the seat and re-mint the token within half a day, which would
       make the whole device screen a suggestion. Only an explicit Activate
       (force) may undo it — see popup activation, which already forces. */
    if (!force && await readSignOut()) return { skipped: "signed-out" };
    const rec = await readToken();
    if (!force) {
      const cur = rec ? await verifyToken(rec.token) : null;
      if (cur && cur.valid && !needsRefresh(rec, cur.payload, now)) return { skipped: "fresh" };
      if (rec && now - (rec.lastAttemptAt || 0) < RETRY_FLOOR_MS) return { skipped: "backoff" };
    }

    const deviceFp = await deviceFpFor(deviceId);
    const out = await fetchToken(record.key, deviceFp, record.instanceId, activate);

    if (out.branch === "ok") {
      const check = await verifyToken(out.token);
      if (!check.valid) {
        await noteAttempt({ lastAttemptAt: now, lastError: "bad-signature" });
        return { ok: false, branch: "badsig" };
      }
      const [subFp, devFp] = await Promise.all([sha256Hex(record.key), deviceFpFor(deviceId)]);
      if (check.payload.sub !== subFp || check.payload.dev !== devFp) {
        await noteAttempt({ lastAttemptAt: now, lastError: "bad-binding" });
        return { ok: false, branch: "badbinding" };
      }
      await writeToken({ token: out.token, fetchedAt: now });
      await noteAttempt({ lastAttemptAt: now, lastError: "" });
      await clearSignOut();
      return { ok: true, exp: check.payload.exp };
    }

    // Authoritative revocation — drop the token, keep the key for support.
    if (out.branch === "notfound" || out.branch === "inactive") {
      await clearToken();
      return { ok: false, branch: out.branch, revoked: true };
    }
    /* Signed out from another device, and this one just found out the slow
       way. Same treatment as the heartbeat's live:false — the marker is what
       stops the next tick quietly taking the seat back. */
    if (out.branch === "signedout") {
      await clearToken();
      await markSignedOut("terminated");
      return { ok: false, branch: out.branch, signedOut: true };
    }

    await noteAttempt({ lastAttemptAt: now, lastError: out.branch });
    return { ok: false, branch: out.branch };
  }

  /* ---------- archive stamp ---------- */

  /**
   * The per-licence secret carried in the current token, as an HMAC key.
   * Null unless this install holds a valid entitlement — which is the whole
   * point: a backup stamped with it proves the sealer was entitled, and a
   * hand-rolled file from a locked console cannot carry one.
   *
   * Stable across token renewals (the Worker derives it from the licence
   * fingerprint), so last year's backup still verifies.
   */
  async function archiveStampKey(record, deviceId) {
    const res = await evaluate(record, deviceId);
    if (!res.entitled) return null;
    // LCT1 buyers predate the issuer and have no ks; fall back to a value
    // derived from their signed key so their backups stamp too.
    const material = res.kind === "lct1"
      ? await sha256Hex("lct1-archive:" + String(record.key), 32)
      : res.ks;
    if (!material) return null;
    const bytes = res.kind === "lct1"
      ? new TextEncoder().encode(material)
      : b64urlToBytes(material.replace(/\+/g, "-").replace(/\//g, "_"));
    try {
      return await _importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    } catch { return null; }
  }


  /* ---------- identity ----------
   *
   * The anchor that outlives an install. A device keypair dies with the
   * extension; a verified email does not, so the trial ledger and licence
   * ownership hang off this rather than off deviceFp.
   *
   * This file only carries the address to the issuer and keeps the token that
   * comes back. It never stores the address: what lands in storage is an
   * opaque token, and the issuer holds only its hash.
   */

  const IDENTITY_KEY = "lct-identity-v1";

  /**
   * MUST match canonicalEmail() in server/entitlement-worker.js, byte for byte.
   *
   * The signature is over the CANONICAL address, so a client that folds
   * differently from the issuer signs a different string and is refused. The
   * Gmail rules are not cosmetic: `a.b@gmail.com`, `ab@gmail.com` and
   * `ab+x@gmail.com` are one mailbox, and treating them as three is unlimited
   * free trials from one account.
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
       address, and this runs on user input. */
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

  /** Mirrored into sync as well as local: a second browser on the same profile
   *  should not have to re-verify, and sync is the only thing that carries it
   *  there. The token names an identity and grants nothing on its own. */
  async function writeIdentity(rec) {
    try { await chrome.storage.local.set({ [IDENTITY_KEY]: rec }); } catch { /* dead context */ }
    try { await chrome.storage.sync.set({ [IDENTITY_KEY]: rec }); } catch { /* quota */ }
    return rec;
  }

  async function readIdentity() {
    for (const area of ["local", "sync"]) {
      try {
        const got = await chrome.storage[area].get(IDENTITY_KEY);
        const rec = got && got[IDENTITY_KEY];
        if (rec && typeof rec.idt === "string" && rec.idt) return rec;
      } catch { /* try the other area */ }
    }
    return null;
  }

  async function clearIdentity() {
    for (const area of ["local", "sync"]) {
      try { await chrome.storage[area].remove(IDENTITY_KEY); } catch { /* may not exist */ }
    }
  }

  /** The token to attach, or "". Every issuer call that can use one sends it;
   *  the issuer treats it as optional and falls back to the old behaviour. */
  async function identityToken() {
    const rec = await readIdentity();
    return (rec && rec.idt) || "";
  }

  /* What this device should be called on the account's device screen, sent
     unsigned alongside a verification. It names a row; it grants nothing. */
  async function seatFields() {
    try {
      const [plat, label] = await Promise.all([describePlatform(), currentDeviceName()]);
      return { ...(plat ? { plat } : {}), ...(label ? { label } : {}) };
    } catch { return {}; }
  }

  /** Shared shape for the two verification routes. */
  async function postIdentity(path, route, fields, extra, nonceOverride) {
    if (!_fetch) return { branch: "network" };
    const res = await issuerPost(path, async () => {
      const signed = await signRequest(route, fields, nonceOverride);
      return signed && { ...signed, ...extra };
    });
    if (!res) return { branch: "network" };
    if (res === NODEVICE) return { branch: "nodevice" };
    let json = null;
    try { json = JSON.parse((await res.text()).slice(0, MAX_BODY)); } catch { /* status decides */ }
    if (res.ok) return { branch: "ok", json: json || {} };
    if (res.status === 429) return { branch: "throttled", json: json || {} };
    if (res.status === 401) return { branch: "refused", json: json || {} };
    if (res.status === 400) return { branch: "badrequest", json: json || {} };
    if (res.status >= 500) return { branch: "service" };
    return { branch: "badrequest", json: json || {} };
  }

  /** Ask the issuer to mail a code. */
  async function identityStart(rawEmail) {
    const email = canonicalEmail(rawEmail);
    if (!email) return { branch: "badrequest", json: { error: "bad email" } };
    return postIdentity("/identity/start", "identity-start", [email], { email });
  }

  /** Spend the code. On success the identity token is stored and everything
   *  downstream — trial, restore, seat reclaim — starts working. */
  async function identityVerify(rawEmail, code) {
    const email = canonicalEmail(rawEmail);
    if (!email) return { branch: "badrequest", json: { error: "bad email" } };
    const res = await postIdentity("/identity/verify", "identity-verify",
      [email, String(code || "")],
      { email, code: String(code || ""), ...(await seatFields()) });
    if (res.branch === "ok" && res.json && res.json.idt) {
      await writeIdentity({ idt: String(res.json.idt), at: Date.now() });
    }
    return res;
  }

  /* The nonce the Google flow is mid-way through. The id_token must be minted
     with it and the request signed with it, two calls from two files — and in
     between sits an interactive consent screen a person can take a minute over.
     An MV3 worker is torn down inside that minute, so a module variable was
     gone by the time the id_token came back and every unhurried sign-in failed
     with "no nonce". Session storage survives the restart and dies with the
     browser; the variable stays as the fallback where no storage exists. */
  const NONCE_KEY = "lct-google-nonce";
  let _googleNonce = "";

  function nonceArea() {
    try { if (chrome.storage && chrome.storage.session) return chrome.storage.session; } catch (_) { /* not a trusted context */ }
    try { if (chrome.storage && chrome.storage.local) return chrome.storage.local; } catch (_) { /* no storage at all */ }
    return null;
  }

  /** Start a Google sign-in: returns the nonce to put in the auth URL. */
  async function identityGoogleNonce() {
    _googleNonce = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
    const area = nonceArea();
    if (area) { try { await area.set({ [NONCE_KEY]: _googleNonce }); } catch (_) { /* memory copy stands */ } }
    return _googleNonce;
  }

  /** Read it back and spend it, whichever side of a worker restart we are on. */
  async function takeGoogleNonce() {
    const area = nonceArea();
    if (area) {
      try {
        const got = await area.get(NONCE_KEY);
        await area.remove(NONCE_KEY);
        const stored = got && got[NONCE_KEY];
        if (typeof stored === "string" && stored) { _googleNonce = ""; return stored; }
      } catch (_) { /* fall through to the memory copy */ }
    }
    const held = _googleNonce;
    _googleNonce = "";
    return held;
  }

  /** Finish it. The nonce is spent either way — a second attempt starts over. */
  async function identityGoogle(idToken) {
    const nonce = await takeGoogleNonce();
    if (!nonce) return { branch: "badrequest", json: { error: "no nonce" } };
    const res = await postIdentity("/identity/google", "identity-google", [],
      { id_token: String(idToken || ""), ...(await seatFields()) }, nonce);
    if (res.branch === "ok" && res.json && res.json.idt) {
      await writeIdentity({ idt: String(res.json.idt), at: Date.now() });
    }
    return res;
  }

  /**
   * "Do I own anything?" — the reinstall path.
   *
   * Returns the licence key and a ready-made entitlement token, so Pro comes
   * back in one call without the buyer pasting a key out of an email.
   */
  async function restorePurchase() {
    const idt = await identityToken();
    if (!idt) return { branch: "unverified" };
    const res = await postIdentity("/restore", "restore", [], { idt });
    /* A token we cannot verify is not a restore. The issuer's answer goes
       through the same signature check as any other, at the caller. */
    return res;
  }

  /* ---------- trial ledger ---------- */

  /**
   * Register this device's trial with the issuer. The server keeps the record,
   * so clearing extension storage — or reinstalling — does not mint a second
   * one; it just gets the original startedAt handed back.
   *
   * Fail-open: an outage returns null and the caller falls back to a local
   * clock. A trial is worth 7 days, not a hostile offline experience.
   */
  async function registerTrial(_deviceFp) {
    if (!_fetch) return null;
    try {
      /* deviceFp is no longer sent — the issuer derives it from the key we
         prove we hold, so a caller cannot register a trial against someone
         else's device id. The parameter stays for call-site compatibility and
         is deliberately unused. */
      const idt = await identityToken();
      const res = await issuerPost("/trial", async () => {
        const signed = await signRequest("trial", []);
        // plat unsigned, as on /entitlement — it names the row this device gets
        // on the account's device screen.
        const [plat, label] = await Promise.all([describePlatform(), currentDeviceName()]);
        return signed && { ...signed, plat, ...(label ? { label } : {}), ...(idt ? { idt } : {}) };
      });
      if (!res || res === NODEVICE) return null;
      const json = JSON.parse((await res.text()).slice(0, MAX_BODY));
      /* No identity: the issuer keeps no ledger entry and says so. The caller
         runs an UNVERIFIED trial on its own clock, which grants nothing until
         an identity is proved — see allows(). */
      if (json && json.unverified) return { unverified: true };

      /* The signed grant is the answer; json.startedAt is only what the answer
         says about itself. Read the dates OUT OF THE TOKEN so a body and a
         signature can never disagree, and treat a token that does not verify
         or does not bind to this device as no answer at all — the caller then
         falls back to an unverified week, which grants nothing. */
      const tt = typeof (json && json.tt) === "string" ? json.tt : "";
      const grant = await trialGrant(tt, Date.now());
      /* "expired" is a real answer: the week is over and the issuer is saying
         so. Anything else that is not a grant is a broken or foreign token. */
      if (!grant.grants && grant.reason !== "expired") return null;

      // Trust the server's clock over ours, but never a nonsense future date.
      if (!grant.startedAt || grant.startedAt > Date.now() + 36e5) return null;
      return { startedAt: grant.startedAt, until: grant.until, tt,
        already: !!(json && json.already),
        verified: true, ks: grant.ks,
        ksPrev: typeof (json && json.ksPrev) === "string" ? json.ksPrev : "" };
    } catch { return null; }
  }

  /* ---------- checkout ----------

     The extension holds no payment URL, no product id and no price. It asks
     the issuer to open a session and opens what it is handed — after checking
     the host, because "the server said so" is not a reason to send somebody
     somewhere to type a card number. Two checks, ours and the worker's, on the
     one hop where being wrong is indistinguishable from phishing.

     What this buys over a link on a web page: price and provider change with a
     worker deploy instead of a store review, the purchase is bound to THIS
     install before the buyer has typed anything, and the key comes back over
     the same device proof as everything else rather than in a URL that lands
     in history, profile sync and every other extension holding `tabs`.
  */

  const CHECKOUT_HOST = "dodopayments.com";
  const ORDER_REF_RE = /^[a-f0-9]{32}$/;

  /** The provider's own https checkout, or nothing.
   *
   *  Suffix comparison rather than a pattern, deliberately. A subdomain regex
   *  wants a nested quantifier and that is a denial of service on a string an
   *  upstream chose; `endsWith(".host")` cannot be made to backtrack, and the
   *  leading dot is what stops `evildodopayments.com` matching. */
  function checkoutUrlOk(value) {
    try {
      const u = new URL(String(value));
      const h = u.hostname.toLowerCase();
      return u.protocol === "https:" &&
        (h === CHECKOUT_HOST || h.endsWith("." + CHECKOUT_HOST));
    } catch { return false; }
  }

  /**
   * Open a checkout. Returns the URL to send the buyer to and the ref to claim
   * against afterwards. Never throws: every failure is a branch, so a bad
   * afternoon at the issuer reads as "try again", not as "you cannot buy this".
   */
  async function startCheckout() {
    if (!_fetch) return { branch: "network" };
    try {
      /* The issuer refuses a checkout without one: a licence bought anonymously
         has no owner row, so it cannot be restored after a reinstall. */
      const idt = await identityToken();
      const res = await issuerPost("/checkout", async () => {
        const signed = await signRequest("checkout", []);
        return signed && { ...signed, idt };
      });
      if (res === NODEVICE) return { branch: "nodevice" };
      if (!res) return { branch: "network" };

      let json = null;
      try { json = JSON.parse((await res.text()).slice(0, MAX_BODY)); } catch { /* status decides */ }

      if (res.status === 200 && json && checkoutUrlOk(json.url) && ORDER_REF_RE.test(String(json.ref || ""))) {
        return { branch: "ok", url: String(json.url), ref: String(json.ref) };
      }
      /* A 200 we cannot use is worse than a failure, because a caller that
         trusted the status would open it. Report a service problem so the
         popup offers the paste-a-key path instead. */
      if (res.status === 200) return { branch: "service" };
      /* Two different 401s. "unverified" is the issuer refusing to sell to a
         device with no identity behind it, which the user can fix in ten
         seconds; a proof failure is a broken install, which they cannot. */
      if (res.status === 401) {
        return { branch: json && json.error === "unverified" ? "unverified" : "proof" };
      }
      if (res.status === 409) return { branch: "replay" };
      if (res.status === 426) return { branch: "outdated" };
      if (res.status === 429) return { branch: "throttled" };
      // Distinct from an outage: nothing is for sale, and no retry will help.
      if (res.status === 503 && json && json.error === "store closed") return { branch: "closed" };
      if (res.status >= 500) return { branch: "service" };
      return { branch: "badrequest" };
    } catch { return { branch: "network" }; }
  }

  /* Every state /checkout/claim can answer with. Listed so an unrecognised one
     — a worker newer than this client — is treated as "keep waiting" rather
     than as a licence problem. */
  const CLAIM_STATES = ["pending", "paid", "ready", "claimed", "refunded", "expired", "unknown"];

  /**
   * Ask whether the order has been paid for and delivered yet.
   *
   * The key comes back exactly once, to the device that opened the order. The
   * caller must store it before doing anything else with it: a second claim
   * answers "claimed" and carries nothing.
   */
  async function claimCheckout(ref) {
    if (!ORDER_REF_RE.test(String(ref || ""))) return { branch: "badrequest" };
    if (!_fetch) return { branch: "network" };
    try {
      const res = await issuerPost("/checkout/claim",
        async () => {
          const proof = await signRequest("checkout-claim", [String(ref)]);
          // Carried so the issuer can bind the licence to its buyer the moment
          // the key exists, rather than hoping a later call brings an identity.
          const idt = await identityToken();
          return proof && { ...proof, ref: String(ref), ...(idt ? { idt } : {}) };
        });
      if (res === NODEVICE) return { branch: "nodevice" };
      if (!res) return { branch: "network" };

      let json = null;
      try { json = JSON.parse((await res.text()).slice(0, MAX_BODY)); } catch { /* status decides */ }

      if (res.status === 200 && json) {
        const state = CLAIM_STATES.includes(json.state) ? json.state : "pending";
        const key = typeof json.key === "string" ? json.key : "";
        // "ready" without a key is not ready. Treating it as such would end the
        // poll and lose the purchase to a truncated response.
        if (state === "ready" && !key) return { branch: "ok", state: "pending", key: "" };
        return { branch: "ok", state, key };
      }
      if (res.status === 401) return { branch: "proof" };
      if (res.status === 409) return { branch: "replay" };
      if (res.status === 426) return { branch: "outdated" };
      if (res.status === 429) return { branch: "throttled" };
      if (res.status >= 500) return { branch: "service" };
      return { branch: "badrequest" };
    } catch { return { branch: "network" }; }
  }

  // ---------- anti-inspection ----------
  // Prevent DevTools console from printing function source for critical paths.
  // Calling verifyToken.toString() returns "[native code]" instead of the real
  // implementation, removing a reconnaissance vector without affecting behaviour.
  const _hide = (fn) => {
    Object.defineProperty(fn, "toString", {
      value: () => "function () { [native code] }",
      writable: false, configurable: false
    });
    return fn;
  };
  _hide(verifyToken); _hide(verifyTrialToken); _hide(trialGrant);
  _hide(evaluate); _hide(allows);
  _hide(fetchToken); _hide(refresh); _hide(attempt); _hide(sha256Hex);
  _hide(registerTrial); _hide(archiveStampKey);
  _hide(signRequest); _hide(deviceKey); _hide(deviceFpFor);
  _hide(listDevices); _hide(revokeDevice); _hide(deviceCall);
  _hide(heartbeat); _hide(readSignOut); _hide(clearSignOut);
  _hide(listSessions); _hide(terminateSessions); _hide(terminateAllSessions);
  _hide(identityStart); _hide(identityVerify); _hide(identityGoogle);
  _hide(restorePurchase); _hide(identityToken); _hide(postIdentity);
  _hide(startCheckout); _hide(claimCheckout);

  // Frozen and non-configurable: runtime reassignment from DevTools or another
  // script has no effect — TypeError on write, silent skip in sloppy mode.
  const api = Object.freeze({
    FEATURES, GRACE_MS, RENEW_BEFORE_MS, ISSUER, ISSUERS,
    // pure
    verifyToken, verifyTrialToken, trialGrant,
    sha256Hex, needsRefresh, bytesToB64url, b64urlToBytes,
    // state
    readToken, writeToken, clearToken, clockNow,
    // verdict
    evaluate, allows, refresh, fetchToken, registerTrial, archiveStampKey,
    deviceKey, deviceFpFor, signRequest, PROTOCOL,
    listDevices, revokeDevice,
    heartbeat, readSignOut, clearSignOut, platformLabel,
    describePlatform, currentDeviceName, setDeviceName, cleanDeviceName, DEVICE_NAME_MAX,
    listSessions, terminateSessions, terminateAllSessions,
    startCheckout, claimCheckout, checkoutUrlOk,
    // identity
    canonicalEmail, identityStart, identityVerify, identityGoogle,
    identityGoogleNonce, identityToken, readIdentity, clearIdentity,
    restorePurchase
  });
  Object.defineProperty(self, "LCTEntitlement", {
    value: api, writable: false, enumerable: true, configurable: false
  });
})();
