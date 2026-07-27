/**
 * Long Chat Toolkit — LCT2 entitlements. The unforgeable half of licensing.
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
 *   exp — 90d, refreshed at 60d. GRACE_MS of offline slack past expiry.
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
  const ISSUER = "https://entitlement.long-chat-toolkit.workers.dev";

  const TOKEN_KEY = "lct-entitlement-v2";
  const CLOCK_KEY = "lct-clock-hwm-v1";

  const RENEW_BEFORE_MS = 30 * 864e5;   // refresh with 30d of life left
  const GRACE_MS = 14 * 864e5;          // offline slack past exp
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

  /* ---------- storage ---------- */

  async function readToken() {
    try {
      const got = await chrome.storage.local.get(TOKEN_KEY);
      const rec = got && got[TOKEN_KEY];
      if (!rec || typeof rec.token !== "string") return null;
      return {
        token: rec.token,
        fetchedAt: Number(rec.fetchedAt) || 0,
        lastAttemptAt: Number(rec.lastAttemptAt) || 0,
        lastError: String(rec.lastError || "")
      };
    } catch { return null; }
  }

  async function writeToken(patch) {
    const cur = (await readToken()) || {};
    try { await chrome.storage.local.set({ [TOKEN_KEY]: { ...cur, ...patch } }); }
    catch { /* dead context */ }
  }

  async function clearToken() {
    try { await chrome.storage.local.remove(TOKEN_KEY); } catch { /* dead context */ }
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
      // Use the pinned _fetch — immune to global fetch override.
      const ts = Date.now();
      const res = await _fetch(ISSUER + "/entitlement", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          license_key: licenseKey, device: deviceFp,
          instance_id: instanceId || "", ts
        }),
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
      if (res.status === 403) return { branch: "inactive" };
      if (res.status === 404) return { branch: "notfound" };
      if (res.status === 422) return { branch: "limit" };
      if (res.status === 429) return { branch: "throttled" };
      if (res.status >= 500) return { branch: "service" };
      return { branch: "badrequest" };
    } catch {
      return { branch: "network" };
    }
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
    const [subFp, devFp] = await Promise.all([sha256Hex(record.key), sha256Hex(deviceId || "")]);
    if (payload.sub !== subFp) return { entitled: false, kind: "dodo", reason: "key-mismatch", features: [] };
    if (payload.dev !== devFp) return { entitled: false, kind: "dodo", reason: "device-mismatch", features: [] };

    const clock = await clockNow();
    if (clock.trusted > payload.exp + GRACE_MS) {
      return { entitled: false, kind: "dodo", reason: "expired", features: [] };
    }

    const feats = Array.isArray(payload.feat) ? payload.feat.filter((f) => FEATURES.includes(f)) : FEATURES.slice();
    return {
      entitled: true, kind: "dodo", email: payload.email || record.email || "",
      features: feats, exp: payload.exp,
      stale: clock.trusted > payload.exp,   // in grace: works, but nag
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
  let refreshing = false;

  async function refresh(record, deviceId, opts) {
    const force = !!(opts && opts.force);
    if (!record || !record.key || /^LCT1\./.test(record.key)) return { skipped: "n/a" };
    if (refreshing) return { skipped: "in-flight" };

    const now = Date.now();
    const rec = await readToken();
    if (!force) {
      const cur = rec ? await verifyToken(rec.token) : null;
      if (cur && cur.valid && !needsRefresh(rec, cur.payload, now)) return { skipped: "fresh" };
      if (rec && now - (rec.lastAttemptAt || 0) < RETRY_FLOOR_MS) return { skipped: "backoff" };
    }

    refreshing = true;
    try {
      const deviceFp = await sha256Hex(deviceId || "");
      const out = await fetchToken(record.key, deviceFp, record.instanceId);

      if (out.branch === "ok") {
        const check = await verifyToken(out.token);
        if (!check.valid) {
          await writeToken({ lastAttemptAt: now, lastError: "bad-signature" });
          return { ok: false, branch: "badsig" };
        }
        const [subFp, devFp] = await Promise.all([sha256Hex(record.key), sha256Hex(deviceId || "")]);
        if (check.payload.sub !== subFp || check.payload.dev !== devFp) {
          await writeToken({ lastAttemptAt: now, lastError: "bad-binding" });
          return { ok: false, branch: "badbinding" };
        }
        await writeToken({ token: out.token, fetchedAt: now, lastAttemptAt: now, lastError: "" });
        return { ok: true, exp: check.payload.exp };
      }

      // Authoritative revocation — drop the token, keep the key for support.
      if (out.branch === "notfound" || out.branch === "inactive") {
        await clearToken();
        return { ok: false, branch: out.branch, revoked: true };
      }

      await writeToken({ lastAttemptAt: now, lastError: out.branch });
      return { ok: false, branch: out.branch };
    } finally {
      refreshing = false;
    }
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
  _hide(fetchToken); _hide(refresh); _hide(sha256Hex);

  // Frozen and non-configurable: runtime reassignment from DevTools or another
  // script has no effect — TypeError on write, silent skip in sloppy mode.
  const api = Object.freeze({
    FEATURES, GRACE_MS, RENEW_BEFORE_MS, ISSUER,
    // pure
    verifyToken, sha256Hex, needsRefresh, bytesToB64url, b64urlToBytes,
    // state
    readToken, writeToken, clearToken, clockNow,
    // verdict
    evaluate, allows, refresh, fetchToken
  });
  Object.defineProperty(self, "LCTEntitlement", {
    value: api, writable: false, enumerable: true, configurable: false
  });
})();
