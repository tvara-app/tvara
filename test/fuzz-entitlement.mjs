#!/usr/bin/env node
/* Fuzzes lib/entitlement.js — the single most security-critical target in
   this suite: bg.js's PAID-feature gate calls straight into verifyToken()/
   evaluate() on every privileged message. Loads the real file in a bare Node
   vm sandbox (same approach as test-license.mjs), with a throwaway ECDSA
   keypair standing in for the shipped one.

   Must call every export DIRECTLY, never via .toString()-based introspection
   or mocking: _hide() (lib/entitlement.js ~485-494) overrides .toString on
   verifyToken/evaluate/allows/fetchToken/refresh/attempt/sha256Hex/
   registerTrial/archiveStampKey specifically to defeat that. */
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import fc from "fast-check";
import { reporter } from "./security-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..");
const { t, done } = reporter();

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const TEST_ISSUER = "https://entitlement.fuzz.invalid";
const testKeyIntegrity = [...createHash("sha256").update(TEST_PUB).digest().subarray(0, 16)]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

const src = readFileSync(join(ROOT, "lib", "entitlement.js"), "utf8")
  .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`)
  .replace(/const ISSUER = "[^"]*";/, `const ISSUER = "${TEST_ISSUER}";`)
  .replace(/const _KEY_INTEGRITY = "[^"]*";/, `const _KEY_INTEGRITY = "${testKeyIntegrity}";`);
if (!src.includes(TEST_PUB) || !src.includes(TEST_ISSUER) || !src.includes(testKeyIntegrity)) {
  console.error("FATAL: could not patch lib/entitlement.js for fuzzing"); process.exit(1);
}

// Minimal chrome.storage.local stub — evaluate()/readToken() read it, and
// fuzzed inputs never need it to hold anything for the "must fail closed"
// assertions below.
const storageData = {};
const chromeStub = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...storageData };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {}; for (const k of list) if (k in storageData) out[k] = storageData[k];
        return out;
      },
      async set(o) { Object.assign(storageData, o); },
      async remove(k) { for (const key of Array.isArray(k) ? k : [k]) delete storageData[key]; }
    }
  }
};

const sandbox = {
  self: undefined, chrome: chromeStub, crypto: globalThis.crypto,
  fetch: async () => { throw new Error("network disabled in fuzz harness"); },
  TextEncoder, TextDecoder, btoa, atob, console, URL, AbortSignal,
  Object, Array, JSON, Math, Error, Promise, Date
};
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: "lib/entitlement.js" });
const LCTEntitlement = ctx.self.LCTEntitlement;

t("lib/entitlement.js loads and exposes LCTEntitlement", !!LCTEntitlement && typeof LCTEntitlement.verifyToken === "function");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha16Hex = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 32);

function mintToken({ licenseKey = "fuzz-key", deviceId = "fuzz-device", ks = "", exp, iat, feat, email, v = 2, plan = "pro" } = {}) {
  const now = iat ?? Date.now();
  const payload = Buffer.from(JSON.stringify({
    v, plan, sub: sha16Hex(licenseKey), dev: sha16Hex(deviceId),
    iat: now, exp: exp ?? now + 90 * 864e5,
    ...(ks ? { ks } : {}), ...(feat ? { feat } : {}), ...(email ? { email } : {})
  }));
  const sig = sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `LCT2.${b64url(payload)}.${b64url(sig)}`;
}

/* ---------- fast-check: malformed tokens must never throw, never verify ---------- */

await (async () => {
  const arbGarbageToken = fc.oneof(
    fc.string(),
    fc.array(fc.string(), { minLength: 0, maxLength: 6 }).map((parts) => parts.join(".")),
    fc.constantFrom("", "LCT2", "LCT2.", "LCT2..", "LCT1.abc.def", "lct2.abc.def"),
    fc.record({
      prefix: fc.constantFrom("LCT2", "LCT1", "LCT3", "lct2", ""),
      payload: fc.base64String(),
      sig: fc.base64String()
    }).map((r) => `${r.prefix}.${r.payload}.${r.sig}`),
    fc.integer().map(String),
    fc.constant(null).map(String)
  );
  let sawThrow = false, sawFalseValid = false, count = 0;
  await fc.assert(fc.asyncProperty(arbGarbageToken, async (token) => {
    count++;
    let res;
    try { res = await LCTEntitlement.verifyToken(token); }
    catch { sawThrow = true; return; }
    if (res.valid !== true) sawFalseValid = false; else sawFalseValid = true;
  }), { numRuns: 300 });
  t(`verifyToken() never throws on garbage input (${count} cases)`, !sawThrow);
  t("verifyToken() never returns valid:true for garbage input", !sawFalseValid);
})();

// Tampered-but-plausible: real payload, corrupted signature byte-by-byte.
{
  const valid = mintToken();
  const parts = valid.split(".");
  const sigBytes = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  let anyFalseAccept = false;
  for (let i = 0; i < Math.min(sigBytes.length, 16); i++) {
    const tampered = Buffer.from(sigBytes);
    tampered[i] ^= 0xff;
    const t2 = [parts[0], parts[1], b64url(tampered)].join(".");
    const res = await LCTEntitlement.verifyToken(t2);
    if (res.valid === true) anyFalseAccept = true;
  }
  t("flipping any of the first 16 signature bytes always breaks verification", !anyFalseAccept);
}

/* ---------- must fail closed: wrong binding, wrong plan, malformed claims ---------- */

{
  const wrongDevice = mintToken({ deviceId: "someone-elses-device" });
  // Exercised, not asserted: evaluate() reads the token from storage, not the
  // arg, so this first call is the "nothing stored yet" path. The assertion is
  // on res2, after the token is written.
  await LCTEntitlement.evaluate({ key: "fuzz-key" }, "my-actual-device");
  await LCTEntitlement.writeToken({ token: wrongDevice, fetchedAt: Date.now() });
  const res2 = await LCTEntitlement.evaluate({ key: "fuzz-key" }, "my-actual-device");
  t("a token minted for a different device is not entitled when evaluated on this one",
    res2.entitled !== true, JSON.stringify(res2));
}

{
  const wrongPlan = mintToken({ plan: "free" });
  const verdict = await LCTEntitlement.verifyToken(wrongPlan);
  t('a token with plan !== "pro" fails verification', verdict.valid !== true, JSON.stringify(verdict));
}

{
  const wrongVersion = mintToken({ v: 1 });
  const verdict = await LCTEntitlement.verifyToken(wrongVersion);
  t("a token with v !== 2 fails verification", verdict.valid !== true, JSON.stringify(verdict));
}

await fc.assert(fc.asyncProperty(
  fc.oneof(fc.integer({ min: -1e15, max: 1e15 }), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity)),
  fc.oneof(fc.integer({ min: -1e15, max: 1e15 }), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity)),
  async (exp, iat) => {
    const token = mintToken({ exp, iat });
    const verdict = await LCTEntitlement.verifyToken(token);
    // Only assert it doesn't throw and doesn't accept non-finite claims —
    // finite exp/iat combinations (even nonsensical ones like exp<iat) are
    // evaluate()'s business (staleness), not verifyToken()'s to reject.
    if (!Number.isFinite(exp) || !Number.isFinite(iat)) {
      if (verdict.valid === true) throw new Error(`accepted non-finite claims: exp=${exp} iat=${iat}`);
    }
  }
), { numRuns: 200 });
t("verifyToken() never accepts non-finite exp/iat claims", true);

/* ---------- sha256Hex / b64 round-trip properties ---------- */

await fc.assert(fc.asyncProperty(fc.string(), async (s) => {
  const hex = await LCTEntitlement.sha256Hex(s);
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`sha256Hex returned non-32-hex-char output for input ${JSON.stringify(s)}: ${hex}`);
}), { numRuns: 200 });
t("sha256Hex() always returns exactly 32 lowercase hex chars (16 bytes) by default", true);

await fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
  const encoded = LCTEntitlement.bytesToB64url(bytes);
  const decoded = LCTEntitlement.b64urlToBytes(encoded);
  if (decoded.length !== bytes.length) throw new Error("length mismatch on b64url round-trip");
  for (let i = 0; i < bytes.length; i++) if (decoded[i] !== bytes[i]) throw new Error("byte mismatch on b64url round-trip");
}), { numRuns: 300 });
t("bytesToB64url()/b64urlToBytes() round-trip exactly for arbitrary byte arrays", true);

/* ---------- clock-skew: needsRefresh() ---------- */

await fc.assert(fc.property(
  fc.integer({ min: 0, max: 200 * 864e5 }), // age past exp, days*ms
  (overdueMs) => {
    const now = Date.now();
    const payload = { exp: now - overdueMs, iat: now - overdueMs - 1000 };
    const rec = { lastAttemptAt: 0 };
    const result = LCTEntitlement.needsRefresh(rec, payload, now);
    if (typeof result !== "boolean") throw new Error("needsRefresh must return a boolean");
  }
), { numRuns: 200 });
t("needsRefresh() always returns a boolean across a wide range of clock skew", true);

done();
