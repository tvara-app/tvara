#!/usr/bin/env node
/* License crypto unit tests — runs lib/license.js in Node with a `self` shim.
   Node 18+ exposes WebCrypto as globalThis.crypto, same API the browser uses. */
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(homedir(), "long-chat-toolkit");

/* Signatures are tested against a throwaway keypair minted here, never the
   shipped one. The production public key is pinned in lib/license.js and its
   private half is deliberately not on any dev machine — depending on
   ~/.lct-keys made these tests pass or fail on whatever that folder last
   held. The code under test (WebCrypto import → ECDSA verify → payload parse)
   is byte for byte the shipped path; only the trusted key differs. */
const { publicKey, privateKey: priv } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const licenseSrc = readFileSync(join(ROOT, "lib", "license.js"), "utf8")
  .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`);
if (!licenseSrc.includes(TEST_PUB)) {
  console.error("FATAL: PUBLIC_KEY_B64 not found in lib/license.js — test key not installed");
  process.exit(1);
}

const sandbox = {
  self: {}, crypto: globalThis.crypto, atob: globalThis.atob,
  TextDecoder, TextEncoder, JSON, console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(licenseSrc, sandbox);
// lib/dodo.js must survive a bare sandbox with no chrome.* and no navigator —
// that is the guarantee that it touches nothing at load time.
vm.runInContext(readFileSync(join(ROOT, "lib", "dodo.js"), "utf8"), sandbox);
const { verify, evaluate, kindOf } = sandbox.self.LCTLicense;
const D = sandbox.self.LCTDodo;

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const issue = (payloadObj) => {
  const payload = Buffer.from(JSON.stringify(payloadObj));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  return `LCT1.${b64url(payload)}.${b64url(sig)}`;
};

let pass = 0, fail = 0;
const failed = []; // reprinted at the end: a lone FAIL scrolls past in a long run
const t = (name, cond) => {
  cond ? pass++ : (fail++, failed.push(name));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};

const good = issue({ e: "buyer@example.com", p: "pro", t: 1753100000000 });

// 1. Valid key verifies, carries email + plan
let r = await verify(good);
t("valid key accepted", r.valid === true && r.email === "buyer@example.com" && r.plan === "pro");

// 2. Tampered payload (email swapped after signing) must fail on signature
{
  const parts = good.split(".");
  const forged = b64url(Buffer.from(JSON.stringify({ e: "thief@example.com", p: "pro", t: 1753100000000 })));
  r = await verify(`LCT1.${forged}.${parts[2]}`);
  t("tampered payload rejected (signature)", r.valid === false && r.reason === "signature");
}

// 3. Tampered signature must fail
{
  const parts = good.split(".");
  const badSig = parts[2].slice(0, -4) + (parts[2].endsWith("AAAA") ? "BBBB" : "AAAA");
  r = await verify(`LCT1.${parts[1]}.${badSig}`);
  t("tampered signature rejected", r.valid === false);
}

// 4. Correctly signed key for a NON-pro plan must be rejected on plan
r = await verify(issue({ e: "buyer@example.com", p: "free", t: 1753100000000 }));
t("signed non-pro plan rejected", r.valid === false && r.reason === "plan");

// 5. Wrong prefix
r = await verify("LCT9." + good.split(".").slice(1).join("."));
t("wrong prefix rejected (format)", r.valid === false && r.reason === "format");

// 6. Garbage inputs never throw
for (const junk of ["", null, undefined, "hello", "LCT1.a.b", "LCT1..", "LCT1.%%%.%%%", 42]) {
  r = await verify(junk);
  if (r.valid !== false) { t(`garbage "${String(junk)}" rejected`, false); }
}
t("all garbage inputs rejected without throwing", true);

// 7. Whitespace-padded valid key still accepted (users paste with spaces)
r = await verify("  " + good + "  ");
t("whitespace-padded key accepted", r.valid === true);

/* ===== Dual-path evaluation (LCT1 offline + Dodo activation receipt) ===== */

// 8. An LCT1 record still resolves through the signature path
r = await evaluate({ key: good });
t("L8 evaluate: LCT1 record is pro via signature", r.pro === true && r.kind === "lct1" && r.email === "buyer@example.com");

// 9. An activated Dodo record is pro
r = await evaluate({ key: "DODO-1234-ABCD", kind: "dodo", instanceId: "lki_1", email: "a@b.co" });
t("L9 evaluate: activated Dodo record is pro", r.pro === true && r.kind === "dodo" && r.email === "a@b.co");

// 10. A Dodo key with no activation receipt is NOT pro
r = await evaluate({ key: "DODO-1234-ABCD", kind: "dodo" });
t("L10 evaluate: unactivated Dodo record is not pro", r.pro === false && r.reason === "unactivated");

// 11. Revocation wins over a present instanceId
r = await evaluate({ key: "DODO-1234-ABCD", kind: "dodo", instanceId: "lki_1", revokedAt: Date.now() });
t("L11 evaluate: revoked Dodo record is not pro", r.pro === false && r.reason === "revoked");

// 12. Garbage records never throw
{
  let ok = true;
  for (const junk of [null, undefined, {}, 42, "x", { key: "" }]) {
    const e = await evaluate(junk);
    if (e.pro !== false) ok = false;
  }
  t("L12 evaluate: garbage records are not pro and never throw", ok);
}

// 13. A stored `kind` must never route a key around its own scheme
r = await evaluate({ key: good, kind: "dodo", instanceId: "lki_forged" });
const r13b = await evaluate({ key: "DODO-1234-ABCD", kind: "lct1", instanceId: "lki_1" });
t("L13 evaluate: stored kind is not trusted, key prefix decides",
  r.pro === true && r.kind === "lct1" && r13b.pro === true && r13b.kind === "dodo");

// 14. verify() is unchanged for a non-LCT1 key: rejects on format, no network
r = await verify("DODO-1234-ABCD");
t("L14 verify: a Dodo key is a format rejection, not a network call",
  r.valid === false && r.reason === "format");
t("L14b kindOf splits the two schemes", kindOf(good) === "lct1" && kindOf("DODO-1") === "dodo" && kindOf(null) === "dodo");

/* ===== Dodo pure logic ===== */

// 15. Downgrade needs two authoritative strikes at least a week apart
{
  const now = Date.now(), d = 864e5;
  t("L15 shouldDowngrade: needs 2 strikes >= 7d apart",
    D.shouldDowngrade([]) === false &&
    D.shouldDowngrade([now]) === false &&
    D.shouldDowngrade([now, now + 6 * d]) === false &&
    D.shouldDowngrade([now, now + 8 * d]) === true &&
    D.shouldDowngrade([now, now + 40 * d]) === true &&
    D.shouldDowngrade(null) === false);
}

// 16. HTTP status -> branch
t("L16 classify maps every branch",
  D.classify(201) === "ok" && D.classify(200) === "ok" && D.classify(422) === "limit" &&
  D.classify(403) === "inactive" && D.classify(404) === "notfound" &&
  D.classify(500) === "service" && D.classify(0) === "network" && D.classify(400) === "badrequest");

// 17. Eviction picks the oldest seat and never our own
{
  const seats = { a: { instanceId: "i", activatedAt: 3 }, b: { instanceId: "i", activatedAt: 1 }, c: { instanceId: "i", activatedAt: 2 } };
  t("L17 oldestSeat picks oldest, excludes self",
    D.oldestSeat(seats, "b")[0] === "c" &&
    D.oldestSeat(seats, "x")[0] === "b" &&
    D.oldestSeat({}, "x") === null &&
    D.oldestSeat({ a: { instanceId: "i", activatedAt: 1 } }, "a") === null);
}

// 18. Shape gate keeps typos off the network
t("L18 looksLikeKey gates typos",
  D.looksLikeKey("hello") === false && D.looksLikeKey("a b c d e f") === false &&
  D.looksLikeKey("DODO-1234-ABCD") === true && D.looksLikeKey("x".repeat(65)) === false &&
  D.looksLikeKey(null) === false);

// 19. Fingerprint is short, stable, and discloses nothing
{
  const f1 = await D.fingerprint("DODO-1234-ABCD");
  const f2 = await D.fingerprint("DODO-1234-ABCE");
  t("L19 fingerprint is 8 stable hex chars, differs per key",
    /^[a-f0-9]{8}$/.test(f1) && f1 === (await D.fingerprint("DODO-1234-ABCD")) && f1 !== f2);
}

// 20. Nothing sensitive survives redact(); the registry normalizer is total
t("L20 redact hides key-shaped strings", !D.redact("key DODO-1234-ABCD failed").includes("DODO-1234-ABCD"));
{
  const reg = D.normalizeRegistry({ seats: { a: { instanceId: "lki_1", label: "x".repeat(90), activatedAt: 5 }, b: null, c: {} } });
  t("L20b normalizeRegistry drops malformed seats and clamps",
    Object.keys(reg.seats).length === 1 && reg.seats.a.label.length <= 40 && reg.version === 1);
}
{
  const junk = [null, undefined, 42, "x", { seats: null }, { seats: { a: 1 } }];
  t("L20c normalizeRegistry never throws", junk.every((j) => D.normalizeRegistry(j).version === 1));
}

// 21. The revalidation gate: offline keys never phone home, and the floors hold
{
  const now = Date.now(), d = 864e5;
  const dodoRec = { key: "DODO-1", instanceId: "lki_1", activatedAt: now - 60 * d };
  const fresh = { lastValidatedAt: now - 2 * d, lastAttemptAt: 0, strikes: [] };
  const due = { lastValidatedAt: now - 31 * d, lastAttemptAt: 0, strikes: [] };
  const justTried = { lastValidatedAt: now - 31 * d, lastAttemptAt: now - 2 * 3600e3, strikes: [] };
  t("L21 shouldRevalidate honours every gate",
    D.shouldRevalidate({ key: good, instanceId: "lki_1" }, due, now) === false &&   // LCT1 never
    D.shouldRevalidate({ key: "DODO-1" }, due, now) === false &&                    // unactivated
    D.shouldRevalidate({ ...dodoRec, revokedAt: now }, due, now) === false &&       // already revoked
    D.shouldRevalidate(dodoRec, fresh, now) === false &&                            // < 30d
    D.shouldRevalidate(dodoRec, justTried, now) === false &&                        // < 24h since attempt
    D.shouldRevalidate(dodoRec, due, now) === true);
}

/* ==========================================================================
   Entitlements (LCT2). These are the paywall tests — each one is a bypass
   that used to work, or would work if the check were dropped.
   ========================================================================== */

// Compute the integrity hash for the test public key so the integrity check
// in entitlement.js passes with the swapped key.
const testKeyHash = [...new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TEST_PUB))
).slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");

const entSrc = readFileSync(join(ROOT, "lib", "entitlement.js"), "utf8")
  .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`)
  .replace(/const _KEY_INTEGRITY = "[^"]*";/, `const _KEY_INTEGRITY = "${testKeyHash}";`);
if (!entSrc.includes(TEST_PUB)) {
  console.error("FATAL: PUBLIC_KEY_B64 not found in lib/entitlement.js");
  process.exit(1);
}

// Minimal chrome.storage.local so evaluate() can read the token it verifies.
const store = new Map();
sandbox.chrome = {
  storage: {
    local: {
      get: async (k) => {
        const keys = Array.isArray(k) ? k : [k];
        const out = {};
        for (const key of keys) if (store.has(key)) out[key] = store.get(key);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) store.delete(key); }
    }
  }
};
sandbox.btoa = globalThis.btoa;
sandbox.fetch = async () => { throw new Error("no network in tests"); };
sandbox.AbortSignal = AbortSignal;
sandbox.URL = URL;
vm.runInContext(entSrc, sandbox);
const E = sandbox.self.LCTEntitlement;

const KEY = "dodo_live_abc123XYZ";
const DEVICE = "11111111-2222-3333-4444-555555555555";
const subFp = await E.sha256Hex(KEY);
const devFp = await E.sha256Hex(DEVICE);

const mint = (over = {}) => {
  const now = Date.now();
  const claims = {
    v: 2, sub: subFp, dev: devFp, plan: "pro",
    feat: ["archive.search", "archive.backup", "archive.restore"],
    iat: now, exp: now + 90 * 864e5, ...over
  };
  const payload = Buffer.from(JSON.stringify(claims));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  return `LCT2.${b64url(payload)}.${b64url(sig)}`;
};

const setTok = (token) => store.set("lct-entitlement-v2", { token, fetchedAt: Date.now() });
const reset = () => { store.clear(); };

// E1. The happy path exists at all.
reset(); setTok(mint());
let e = await E.evaluate({ key: KEY }, DEVICE);
t("E1 valid signed token entitles", e.entitled === true && e.features.length === 3);

// E2. THE bug this whole layer exists for: a hand-written storage record used
//     to be worth Pro. Now it is worth nothing without a signature.
reset();
e = await E.evaluate({ key: KEY, instanceId: "lki_forged", plan: "pro" }, DEVICE);
t("E2 forged licence record with no token is NOT entitled",
  e.entitled === false && e.reason === "no-token");

// E3. Editing the claims (longer expiry, more features) breaks the signature.
reset();
{
  const real = mint();
  const [, payload, sig] = real.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  claims.exp = Date.now() + 3650 * 864e5;
  setTok(`LCT2.${b64url(Buffer.from(JSON.stringify(claims)))}.${sig}`);
  e = await E.evaluate({ key: KEY }, DEVICE);
  t("E3 tampered claims rejected on signature", e.entitled === false && e.reason === "signature");
}

// E4. A token signed by anyone else is not a token.
reset();
{
  const { privateKey: other } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const payload = Buffer.from(JSON.stringify({
    v: 2, sub: subFp, dev: devFp, plan: "pro", feat: [], iat: Date.now(), exp: Date.now() + 864e5
  }));
  const sig = sign("sha256", payload, { key: other, dsaEncoding: "ieee-p1363" });
  setTok(`LCT2.${b64url(payload)}.${b64url(sig)}`);
  e = await E.evaluate({ key: KEY }, DEVICE);
  t("E4 token signed by a foreign key rejected", e.entitled === false && e.reason === "signature");
}

// E5. Licence sharing: a real token pasted next to a different key is dead.
reset(); setTok(mint());
e = await E.evaluate({ key: "dodo_live_SOMEONEELSE" }, DEVICE);
t("E5 token bound to its licence key", e.entitled === false && e.reason === "key-mismatch");

// E6. Token sharing: copied to another machine, the device binding kills it.
reset(); setTok(mint());
e = await E.evaluate({ key: KEY }, "99999999-8888-7777-6666-555555555555");
t("E6 token bound to its device", e.entitled === false && e.reason === "device-mismatch");

// E7. Expiry, and the offline grace window that must not become a loophole.
reset(); setTok(mint({ exp: Date.now() - 3 * 864e5 }));
e = await E.evaluate({ key: KEY }, DEVICE);
const inGrace = e.entitled === true && e.stale === true;
reset(); setTok(mint({ exp: Date.now() - 20 * 864e5 }));
e = await E.evaluate({ key: KEY }, DEVICE);
t("E7 expired token: 14d grace, then locked", inGrace && e.entitled === false && e.reason === "expired");

// E8. Clock rollback must not revive an expired token.
reset();
store.set("lct-clock-hwm-v1", Date.now() + 40 * 864e5);   // we have seen "later"
setTok(mint({ exp: Date.now() + 5 * 864e5 }));            // expires before that
e = await E.evaluate({ key: KEY }, DEVICE);
t("E8 clock rollback does not revive expiry", e.entitled === false && e.reason === "expired");

// E9. A revoked record is dead even holding a perfect token.
reset(); setTok(mint());
e = await E.evaluate({ key: KEY, revokedAt: Date.now() }, DEVICE);
t("E9 revoked record beats a valid token", e.entitled === false && e.reason === "revoked");

// E10. Feature scoping: a token can carry less than everything.
reset(); setTok(mint({ feat: ["archive.search"] }));
t("E10 features are scoped per token",
  (await E.allows({ key: KEY }, DEVICE, "archive.search")) === true &&
  (await E.allows({ key: KEY }, DEVICE, "archive.backup")) === false);

// E11. Unknown feature names in a token cannot invent capabilities.
reset(); setTok(mint({ feat: ["archive.search", "everything.forever"] }));
e = await E.evaluate({ key: KEY }, DEVICE);
t("E11 unknown features dropped, not honoured",
  e.entitled === true && e.features.length === 1 && e.features[0] === "archive.search");

// E12. Garbage in never throws — a crash in the gate is an open gate.
reset();
{
  let threw = false;
  for (const bad of [null, "", "LCT2", "LCT2..", "LCT2.a.b", "x".repeat(9000),
    "LCT2." + b64url(Buffer.from("not json")) + ".AAAA", {}, [], 42]) {
    try { setTok(bad); await E.evaluate({ key: KEY }, DEVICE); }
    catch { threw = true; }
  }
  t("E12 malformed tokens never throw", threw === false);
}

// E13. LCT1 buyers keep their offline path untouched.
reset();
e = await E.evaluate({ key: good }, DEVICE);
const lct1Bad = await E.evaluate({ key: "LCT1.aaa.bbb" }, DEVICE);
t("E13 LCT1 keys still verify offline, forgeries still fail",
  e.entitled === true && e.kind === "lct1" && lct1Bad.entitled === false);

// E14. needsRefresh: renew before expiry, respect the failure floor.
{
  const now = Date.now(), d = 864e5;
  t("E14 needsRefresh honours renewal window and backoff",
    E.needsRefresh({ lastAttemptAt: 0 }, { exp: now + 10 * d }, now) === true &&
    E.needsRefresh({ lastAttemptAt: 0 }, { exp: now + 60 * d }, now) === false &&
    E.needsRefresh({ lastAttemptAt: now - 60e3 }, { exp: now + 10 * d }, now) === false &&
    E.needsRefresh(null, null, now) === true);
}

// E15. A network failure must never mint entitlement out of thin air.
reset();
{
  const out = await E.refresh({ key: KEY, instanceId: "lki_1" }, DEVICE, { force: true });
  const after = await E.evaluate({ key: KEY }, DEVICE);
  t("E15 failed refresh grants nothing",
    out.ok !== true && after.entitled === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log("failed:\n  " + failed.join("\n  "));
process.exit(fail ? 1 : 0);
