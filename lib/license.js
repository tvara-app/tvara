/**
 * Long Chat Toolkit — license verification. Two kinds of key, one verdict.
 *
 * LCT1 keys (everyone who bought before Dodo) are signed tokens:
 *
 *   LCT1.<base64url(payload-json)>.<base64url(ECDSA-P256-signature)>
 *
 * The public key below verifies them locally via WebCrypto — no network, ever,
 * exactly as on the day they were sold. Keys are issued by tools/genkey.mjs
 * (the private key never ships in the extension).
 *
 * Dodo keys are activated once against the payment provider (see lib/dodo.js),
 * which caps them at 5 devices. The receipt of that activation is what this
 * file reads back: a stored instanceId, not a signature.
 *
 * Privacy contract: the extension still holds no host permission beyond the AI
 * sites you use. Activation reaches the licence server through ordinary CORS —
 * it sends your key and a device label, never a cookie, never chat text.
 *
 * Yes — this is client-side and the code is open source; a determined person
 * can hand-write a receipt or fork the free version. That's fine, and it was
 * true of the signature check too. Honest users buy honest software.
 */
(() => {
  "use strict";

  // SPKI, base64. Replace by running: node tools/genkey.mjs init
  const PUBLIC_KEY_B64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeEGkTUsdoEz/4ZDziENEBEHHlLbRfg69LzKmqVyKqAKy3+jNyfTdTvv9zCCBUEC66JMBGIY3A6gMDlBd93ggWg==";

  // Pin WebCrypto references at load time. Overriding crypto.subtle.verify or
  // crypto.subtle.importKey on the global after this IIFE runs has no effect on
  // licence verification — the closure holds the original binding.
  const _subtle = crypto.subtle;
  const _verify = _subtle.verify.bind(_subtle);
  const _importKey = _subtle.importKey.bind(_subtle);

  const b64urlToBytes = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };

  async function importPublicKey() {
    if (PUBLIC_KEY_B64.startsWith("__")) return null; // dev build, no key yet
    const raw = Uint8Array.from(atob(PUBLIC_KEY_B64), (c) => c.charCodeAt(0));
    return _importKey(
      "spki",
      raw,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  }

  /**
   * @returns {Promise<{valid:boolean, email?:string, plan?:string, reason?:string}>}
   */
  async function verify(key) {
    try {
      if (!key || typeof key !== "string") return { valid: false, reason: "empty" };
      const parts = key.trim().split(".");
      if (parts.length !== 3 || parts[0] !== "LCT1") return { valid: false, reason: "format" };

      const pub = await importPublicKey();
      if (!pub) return { valid: false, reason: "no-public-key" };

      const payloadBytes = b64urlToBytes(parts[1]);
      const sig = b64urlToBytes(parts[2]);
      const ok = await _verify(
        { name: "ECDSA", hash: "SHA-256" },
        pub,
        sig,
        payloadBytes
      );
      if (!ok) return { valid: false, reason: "signature" };

      const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
      if (payload.p !== "pro") return { valid: false, reason: "plan" };
      return { valid: true, email: payload.e, plan: payload.p };
    } catch (_) {
      return { valid: false, reason: "error" };
    }
  }

  /** Which scheme a key belongs to. Derived from the key itself — never read
   *  back from a stored `kind` field, or a hand-edited record could route an
   *  LCT1 key around its own signature check. */
  function kindOf(key) {
    return /^LCT1\./.test(String(key || "")) ? "lct1" : "dodo";
  }

  /**
   * The single "is this user Pro?" answer, for a stored license record.
   * Offline and synchronous in spirit: no network, no chrome.* — this runs
   * inside content scripts on five AI sites.
   *
   * SECURITY NOTE: For Dodo keys the check here is a UI courtesy only. The
   * real enforcement lives in bg.js's requireEntitlement(), which demands an
   * ECDSA-signed LCT2 token. Unhiding locked UI via DevTools or forging a
   * storage record changes nothing: every data request still hits the
   * background worker's signature gate.
   *
   * @param {{key?:string,email?:string,plan?:string,instanceId?:string,revokedAt?:number}} record
   * @returns {Promise<{pro:boolean, email?:string, plan?:string, kind?:string, reason?:string}>}
   */
  async function evaluate(record) {
    if (!record || typeof record !== "object" || !record.key) return { pro: false, reason: "none" };
    const kind = kindOf(record.key);

    if (kind === "lct1") {
      const res = await verify(record.key);
      return res.valid
        ? { pro: true, email: res.email, plan: res.plan, kind }
        : { pro: false, kind, reason: res.reason };
    }

    if (record.revokedAt) return { pro: false, kind, reason: "revoked" };
    if (!record.instanceId) return { pro: false, kind, reason: "unactivated" };
    return { pro: true, email: record.email, plan: "pro", kind };
  }

  // Frozen: runtime reassignment of verify/evaluate/kindOf from DevTools or
  // another script has no effect. Object.freeze is shallow, but every value
  // here is a function reference — there is nothing deeper to mutate.
  const api = Object.freeze({ verify, evaluate, kindOf });
  Object.defineProperty(self, "LCTLicense", {
    value: api, writable: false, enumerable: true, configurable: false
  });
})();
