/**
 * Tvara — LCT2 entitlements. The unforgeable half of licensing.
 *
 * Token: LCT2.<b64url(payload)>.<b64url(ECDSA-P256-SHA256, P1363)>
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
 *   exp — 90d, refreshed at 60d. Past that it keeps working and says it is
 *   overdue: a purchase is withdrawn by an answer, never by an outage.
 *
 * Not defended: patching this file in an unpacked build. Nothing client-side
 * can be. Store builds are browser-signature-verified; that is the real line.
 */
(() => {
  "use strict";

  // Same keypair as LCT1. Replace via: node tools/genkey.mjs init
  const PUBLIC_KEY_B64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeEGkTUsdoEz/4ZDziENEBEHHlLbRfg69LzKmqVyKqAKy3+jNyfTdTvv9zCCBUEC66JMBGIY3A6gMDlBd93ggWg==";

  // Integrity hash of the public key. If someone replaces the constant in
  // memory, every subsequent verify will fail with "key-integrity".
  // SHA-256 of the full base64 string, first 16 hex chars.
  const _KEY_INTEGRITY = "97bed67e0ce0b5465257ad21b19eb701"; // update if you rotate the keypair

  // Your deployed Worker. CORS-echoed to chrome-extension://, so no host permission.
  /* Your Cloudflare account's workers.dev subdomain, which is an ACCOUNT-level
     setting — not something this repo controls. It is a placeholder until the
     first deploy: server/deploy.sh reads the URL out of `wrangler deploy`'s own
     output and refuses to continue if it does not match this line, so a
     mismatch stops the deploy rather than shipping a worker nobody can reach. */
  const ISSUER = "https://entitlement.tvara.workers.dev";

  /* Must equal PROTOCOL in server/entitlement-worker.js. The issuer answers 426
     to anything else rather than silently accepting a request with no device
     proof in it. */
  const PROTOCOL = 3;

  const TOKEN_KEY = "lct-entitlement-v2";
  const CLOCK_KEY = "lct-clock-hwm-v1";

  const RENEW_BEFORE_MS = 30 * 864e5;   // refresh with 30d of life left
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
  async function signRequest(route, fields) {
    const dk = await deviceKey();
    if (!dk) return null;
    const nonce = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
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
    let ok = false;
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

  /* ---------- clock tamper guard ---------- */

  /**
   * Monotonic high-water mark. Winding the clock back to revive an expired
   * token trips this; winding it forward only expires you sooner.
   */
  async function clockNow() {
    const now = Date.now();
    let hwm = 0;
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
  async function fetchToken(licenseKey, deviceFp, instanceId) {
    try {
      /* The device proof. Without a keypair there is nothing to prove and the
         issuer will refuse — so say so here rather than sending a request that
         cannot succeed and reading its 401 as a licence problem. */
      const proof = await signRequest("entitlement", [licenseKey]);
      if (!proof) return { branch: "nodevice" };

      // Use the pinned _fetch — immune to global fetch override.
      const res = await _fetch(ISSUER + "/entitlement", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...proof, license_key: licenseKey, instance_id: instanceId || "" }),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        mode: "cors",
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (new URL(res.url || ISSUER).origin !== new URL(ISSUER).origin) return { branch: "network" };

      const text = (await res.text()).slice(0, MAX_BODY);
      let json = null;
      try { json = JSON.parse(text); } catch { /* status decides */ }

      if (res.status === 200 && json && typeof json.token === "string") {
        return { branch: "ok", token: json.token };
      }
      if (res.status === 401) return { branch: "proof" };      // device proof rejected
      if (res.status === 403) return { branch: "inactive" };
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
  async function deviceCall(route, signFields, extraBody) {
    if (!_fetch) return { branch: "network" };
    try {
      const proof = await signRequest(route, signFields);
      if (!proof) return { branch: "nodevice" };

      const res = await _fetch(ISSUER + "/" + route.replace("devices-revoke", "devices/revoke"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...proof, ...extraBody }),
        credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        cache: "no-store", mode: "cors", signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (new URL(res.url || ISSUER).origin !== new URL(ISSUER).origin) return { branch: "network" };

      let json = null;
      try { json = JSON.parse((await res.text()).slice(0, MAX_BODY)); } catch { /* status decides */ }
      if (res.status === 200 && json) return { branch: "ok", data: json };
      if (res.status === 401) return { branch: "proof" };
      if (res.status === 403) return { branch: "notenrolled" };
      if (res.status === 409) return { branch: "replay" };
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
    return payload.exp - now < RENEW_BEFORE_MS;
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

    const run = attempt(record, deviceId, force);
    refreshing = run;
    try { return await run; }
    finally { if (refreshing === run) refreshing = null; }
  }

  async function attempt(record, deviceId, force) {
    const now = Date.now();
    const rec = await readToken();
    if (!force) {
      const cur = rec ? await verifyToken(rec.token) : null;
      if (cur && cur.valid && !needsRefresh(rec, cur.payload, now)) return { skipped: "fresh" };
      if (rec && now - (rec.lastAttemptAt || 0) < RETRY_FLOOR_MS) return { skipped: "backoff" };
    }

    const deviceFp = await deviceFpFor(deviceId);
    const out = await fetchToken(record.key, deviceFp, record.instanceId);

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
      return { ok: true, exp: check.payload.exp };
    }

    // Authoritative revocation — drop the token, keep the key for support.
    if (out.branch === "notfound" || out.branch === "inactive") {
      await clearToken();
      return { ok: false, branch: out.branch, revoked: true };
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
      const proof = await signRequest("trial", []);
      if (!proof) return null;

      const res = await _fetch(ISSUER + "/trial", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(proof),
        credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        cache: "no-store", mode: "cors", signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (new URL(res.url || ISSUER).origin !== new URL(ISSUER).origin) return null;
      const json = JSON.parse((await res.text()).slice(0, MAX_BODY));
      const startedAt = Number(json && json.startedAt) || 0;
      // Trust the server's clock over ours, but never a nonsense future date.
      if (!startedAt || startedAt > Date.now() + 36e5) return null;
      return { startedAt, already: !!(json && json.already),
        ks: typeof json.ks === "string" ? json.ks : "" };
    } catch { return null; }
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
  _hide(verifyToken); _hide(evaluate); _hide(allows);
  _hide(fetchToken); _hide(refresh); _hide(attempt); _hide(sha256Hex);
  _hide(registerTrial); _hide(archiveStampKey);
  _hide(signRequest); _hide(deviceKey); _hide(deviceFpFor);
  _hide(listDevices); _hide(revokeDevice); _hide(deviceCall);

  // Frozen and non-configurable: runtime reassignment from DevTools or another
  // script has no effect — TypeError on write, silent skip in sloppy mode.
  const api = Object.freeze({
    FEATURES, GRACE_MS, RENEW_BEFORE_MS, ISSUER,
    // pure
    verifyToken, sha256Hex, needsRefresh, bytesToB64url, b64urlToBytes,
    // state
    readToken, writeToken, clearToken, clockNow,
    // verdict
    evaluate, allows, refresh, fetchToken, registerTrial, archiveStampKey,
    deviceKey, deviceFpFor, signRequest, PROTOCOL,
    listDevices, revokeDevice
  });
  Object.defineProperty(self, "LCTEntitlement", {
    value: api, writable: false, enumerable: true, configurable: false
  });
})();
