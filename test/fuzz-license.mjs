#!/usr/bin/env node
/* Fuzzes lib/license.js — the offline LCT1 verification path. Reuses
   test-license.mjs's exact vm-sandbox loading approach (throwaway keypair,
   same `self` shim) rather than reinventing it. */
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import fc from "fast-check";
import { reporter } from "./security-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..");
const { t, done } = reporter();

const { publicKey, privateKey: priv } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const licenseSrc = readFileSync(join(ROOT, "lib", "license.js"), "utf8")
  .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`);
if (!licenseSrc.includes(TEST_PUB)) { console.error("FATAL: PUBLIC_KEY_B64 not found"); process.exit(1); }

const sandbox = { self: undefined, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, console };
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(licenseSrc, ctx, { filename: "lib/license.js" });
const LCTLicense = ctx.self.LCTLicense;

t("lib/license.js loads and exposes LCTLicense", !!LCTLicense && typeof LCTLicense.verify === "function");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function mintKey(claims = {}) {
  const payload = Buffer.from(JSON.stringify({ e: "fuzz@example.com", p: "pro", ...claims }));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  return `LCT1.${b64url(payload)}.${b64url(sig)}`;
}

/* ---------- verify(): malformed lct1-shaped keys never throw, never accept ---------- */

await (async () => {
  const arbGarbageKey = fc.oneof(
    fc.string(),
    fc.constantFrom("", "LCT1", "LCT1.", "LCT1..", "LCT1.abc", "lct1.abc.def", "LCT1.abc.def.ghi"),
    fc.record({ payload: fc.base64String(), sig: fc.base64String() }).map((r) => `LCT1.${r.payload}.${r.sig}`),
    fc.integer().map(String),
    fc.array(fc.string({ maxLength: 20 }), { minLength: 0, maxLength: 5 }).map((a) => a.join(".")),
    // Very long strings — the key-length ceiling other parts of the app
    // enforce (purchase.js's 200-char cap) isn't verify()'s own job, but it
    // still must not throw or hang on something absurd.
    fc.string({ minLength: 500, maxLength: 5000 })
  );
  let sawThrow = false, sawFalseValid = false;
  await fc.assert(fc.asyncProperty(arbGarbageKey, async (key) => {
    let res;
    try { res = await LCTLicense.verify(key); }
    catch { sawThrow = true; return; }
    if (res.valid === true) sawFalseValid = true;
  }), { numRuns: 300 });
  t("verify() never throws on garbage lct1-shaped input", !sawThrow);
  t("verify() never returns valid:true for garbage input", !sawFalseValid);
})();

// Non-string / nullish input — the function signature says string, real
// callers (chrome.storage round-trips, forwarded messages) don't guarantee it.
await fc.assert(fc.asyncProperty(
  fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.boolean(), fc.array(fc.string()), fc.object()),
  async (garbage) => {
    const res = await LCTLicense.verify(garbage);
    if (res.valid === true) throw new Error(`accepted non-string input: ${JSON.stringify(garbage)}`);
  }
), { numRuns: 100 });
t("verify() never accepts valid:true for non-string input", true);

// dodo-shaped garbage (no LCT1. prefix) through kindOf() — must route to
// "dodo", never crash, never be misclassified as "lct1" by accident.
await fc.assert(fc.property(
  fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.integer()),
  (key) => {
    const kind = LCTLicense.kindOf(key);
    if (kind !== "lct1" && kind !== "dodo") throw new Error(`kindOf returned neither lct1 nor dodo: ${kind}`);
    const startsLCT1 = typeof key === "string" && key.startsWith("LCT1.");
    if (startsLCT1 && kind !== "lct1") throw new Error("an LCT1.-prefixed key was NOT classified as lct1");
    if (!startsLCT1 && kind !== "dodo") throw new Error("a non-LCT1.-prefixed value was not classified as dodo");
  }
), { numRuns: 300 });
t("kindOf() never throws and always classifies by prefix alone, never crashes on garbage", true);

/* ---------- tampered-but-plausible: valid key, one flipped signature byte ---------- */

{
  const valid = mintKey();
  const parts = valid.split(".");
  const sigBytes = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  let anyFalseAccept = false;
  for (let i = 0; i < sigBytes.length; i++) {
    const tampered = Buffer.from(sigBytes);
    tampered[i] ^= 0xff;
    const key = [parts[0], parts[1], b64url(tampered)].join(".");
    const res = await LCTLicense.verify(key);
    if (res.valid === true) anyFalseAccept = true;
  }
  t(`flipping any single signature byte (${sigBytes.length} tried) always breaks verification`, !anyFalseAccept);
}

// Signed by a foreign, unrelated keypair — the public key pinned in
// lib/license.js must reject it even though the signature is internally consistent.
{
  const foreign = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const payload = Buffer.from(JSON.stringify({ e: "attacker@example.com", p: "pro" }));
  const sig = sign("sha256", payload, { key: foreign.privateKey, dsaEncoding: "ieee-p1363" });
  const foreignKey = `LCT1.${b64url(payload)}.${b64url(sig)}`;
  const res = await LCTLicense.verify(foreignKey);
  t("a key signed by a foreign, unrelated key is rejected", res.valid !== true, JSON.stringify(res));
}

// A key whose payload claims plan !== "pro" — signature valid, plan wrong.
{
  const key = mintKey({ p: "free" });
  const res = await LCTLicense.verify(key);
  t('a validly-signed key with p !== "pro" is rejected', res.valid !== true, JSON.stringify(res));
}

/* ---------- evaluate(): malformed records never throw, never grant pro ---------- */

await fc.assert(fc.asyncProperty(
  fc.oneof(
    fc.constant(null), fc.constant(undefined), fc.string(), fc.integer(),
    fc.record({ key: fc.oneof(fc.string(), fc.constant(undefined)), instanceId: fc.oneof(fc.string(), fc.constant(undefined)), revokedAt: fc.oneof(fc.integer(), fc.constant(undefined)) })
  ),
  async (record) => {
    const res = await LCTLicense.evaluate(record);
    if (typeof res !== "object" || res === null || typeof res.pro !== "boolean") {
      throw new Error(`evaluate() returned a malformed verdict for ${JSON.stringify(record)}: ${JSON.stringify(res)}`);
    }
  }
), { numRuns: 300 });
t("evaluate() never throws and always returns {pro: boolean, ...} for arbitrary record shapes", true);

{
  const revoked = { key: "dodo-key-1234", instanceId: "inst-1", revokedAt: Date.now() };
  const res = await LCTLicense.evaluate(revoked);
  t("evaluate() denies a Dodo record with revokedAt set", res.pro !== true, JSON.stringify(res));
}

done();
