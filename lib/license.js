/**
 * Long Chat Toolkit — OFFLINE license verification.
 *
 * Privacy contract: this extension has ZERO network permissions, so license
 * checks are cryptographic, not server calls. A license key is a signed token:
 *
 *   LCT1.<base64url(payload-json)>.<base64url(ECDSA-P256-signature)>
 *
 * The public key below verifies signatures locally via WebCrypto. Keys are
 * issued by tools/genkey.mjs (private key never ships in the extension).
 * Yes — this is client-side and the code is open source; a determined person
 * can fork the free version. That's fine. Honest users buy honest software.
 */
(() => {
  "use strict";

  // SPKI, base64. Replace by running: node tools/genkey.mjs init
  const PUBLIC_KEY_B64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzu9GjZdEdFyy2BQjo1lKOzbkW+J0MqEXxX2lUt63hZLfNYrkv6E/nl+00CWaTLOJBvxAXs0qVV2hRmivKbkQsg==";

  const b64urlToBytes = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };

  async function importPublicKey() {
    if (PUBLIC_KEY_B64.startsWith("__")) return null; // dev build, no key yet
    const raw = Uint8Array.from(atob(PUBLIC_KEY_B64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey(
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
      const ok = await crypto.subtle.verify(
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

  self.LCTLicense = { verify };
})();
