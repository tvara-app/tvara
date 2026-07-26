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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log("failed:\n  " + failed.join("\n  "));
process.exit(fail ? 1 : 0);
