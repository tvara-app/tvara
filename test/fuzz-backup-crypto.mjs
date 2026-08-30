#!/usr/bin/env node
/* fast-check property tests for lib/backup-crypto.js — no prior coverage
   existed for this file at all (confirmed: no test-backup-crypto.mjs). This
   is the encrypt/decrypt path for a user's entire archive; the property that
   matters most is authentication failing CLOSED — a single flipped byte, a
   truncated file, or the wrong passphrase must never produce a partial or
   silently-corrupted "success".

   seal()'s real contract (read from source, not assumed — see lib/backup-crypto.js:196-208):
     seal(payload, secret) where secret = { stampKey, stampSub, passphrase }.
   stampKey is an HMAC CryptoKey proving Pro entitlement (bg.js's stampCreds()
   mints it from the live entitlement verdict; "Creating a backup is a Pro
   feature" is seal() enforcing that with no stampKey at all, not this file's
   own gate). It is NOT the encryption secret — passphrase is. This test
   builds a stampKey the same way bg.js's stampCreds() does, so it exercises
   the real encrypt/decrypt + stamp-verify paths, not a shortcut around them. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "lib", "backup-crypto.js"), "utf8");
const scope = { self: {} };
new Function("self", src)(scope.self);
const C = scope.self.LCTBackupCrypto;
if (!C) throw new Error("lib/backup-crypto.js did not define self.LCTBackupCrypto");

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

const PASSPHRASE = "correct horse battery staple 9000";

async function mintStampKey(seedByte = 7) {
  const bytes = new Uint8Array(32).fill(seedByte);
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const STAMP_SUB = "test-licence-fingerprint";

const validPayload = (extra = {}) => ({
  format: C.PAYLOAD_FORMAT, version: 1, createdAt: Date.now(),
  chats: [], ledger: { version: 2, checkpoints: {} }, profile: null, ...extra,
});

async function sealValid(extra = {}, { stampKey, passphrase = PASSPHRASE, stampSub = STAMP_SUB } = {}) {
  const key = stampKey || await mintStampKey();
  return C.seal(validPayload(extra), { stampKey: key, stampSub, passphrase });
}

// 0. Without a stampKey at all, seal() must refuse — this IS the Pro gate,
// confirm it holds (a regression here would mean free installs can seal).
{
  let threw = null;
  try { await C.seal(validPayload(), { passphrase: PASSPHRASE }); }
  catch (e) { threw = e; }
  t("seal() refuses with no stampKey at all (\"Creating a backup is a Pro feature\")",
    threw !== null && /Pro feature/.test(threw.message), threw ? threw.message : "seal() succeeded with no entitlement proof");
}

// 1. seal → open round-trips for a range of payload shapes, including the
// edges: empty archive, unicode, nested arrays — with a correctly-built
// stampKey supplied on both ends, matching how bg.js actually calls this.
{
  const stampKey = await mintStampKey();
  const cases = [
    {},
    { chats: [{ id: "a", title: "héllo wörld 你好 🎉", msgs: [] }] },
    { chats: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, title: `chat ${i}`, msgs: [] })) },
  ];
  let allRoundTrip = true, offender = "";
  for (const extra of cases) {
    try {
      const sealed = await sealValid(extra, { stampKey });
      const opened = await C.open(sealed.json, PASSPHRASE, { stampKey }); // open() returns the snapshot directly, not {payload: snapshot}
      if (JSON.stringify(opened.chats) !== JSON.stringify(extra.chats || [])) {
        allRoundTrip = false; offender = `chats mismatch after round trip: ${JSON.stringify(opened).slice(0, 200)}`;
        break;
      }
    } catch (e) { allRoundTrip = false; offender = `threw on a valid envelope: ${e.message}`; break; }
  }
  t("seal() → open() round-trips across varied payload shapes with a valid stampKey on both ends", allRoundTrip, offender);
}

// 2. Wrong passphrase must fail closed, never partially succeed.
{
  const stampKey = await mintStampKey();
  const sealed = await sealValid({}, { stampKey });
  let threw = false;
  try { await C.open(sealed.json, "definitely the wrong passphrase", { stampKey }); }
  catch { threw = true; }
  t("open() with the wrong passphrase fails closed (throws, never returns a payload)", threw);
}

// 3. Foreign/mismatched stampKey — proves the Pro-stamp is actually checked,
// not merely present-and-ignored. A file sealed under one install's stamp
// must not open under a DIFFERENT install's stamp claiming the same file.
{
  const sealerKey = await mintStampKey(7);
  const foreignKey = await mintStampKey(99); // a different install's key
  const sealed = await sealValid({}, { stampKey: sealerKey });
  let threw = false, msg = "";
  try { await C.open(sealed.json, PASSPHRASE, { stampKey: foreignKey }); }
  catch (e) { threw = true; msg = e.message; }
  t("open() with the RIGHT passphrase but a FOREIGN stampKey still fails closed (stamp is verified, not decorative)",
    threw && /not created by a licensed copy/.test(msg), msg || "opened despite a foreign stamp key");
}

// 4. No stampKey supplied to open() at all — must refuse, not silently skip the check.
{
  const stampKey = await mintStampKey();
  const sealed = await sealValid({}, { stampKey });
  let threw = false;
  try { await C.open(sealed.json, PASSPHRASE, {}); }
  catch { threw = true; }
  t("open() with no stampKey in opts fails closed rather than skipping stamp verification", threw);
}

// 5. A single flipped byte in the sealed ciphertext must be rejected.
{
  const stampKey = await mintStampKey();
  const sealed = await sealValid({ chats: [{ id: "x", n: 12345 }] }, { stampKey });
  const bytes = Buffer.from(sealed.json, "utf8");
  const flipAt = Math.floor(bytes.length * 0.6);
  bytes[flipAt] = bytes[flipAt] ^ 0xff;
  let threw = false;
  try { await C.open(bytes.toString("utf8"), PASSPHRASE, { stampKey }); }
  catch { threw = true; }
  t("open() with one flipped byte in the sealed output fails closed", threw);
}

// 6. Truncated input at various offsets — always a clean Error, never a raw crash.
{
  const stampKey = await mintStampKey();
  const full = (await sealValid({}, { stampKey })).json;
  const offsets = [0, 1, 5, Math.floor(full.length / 4), Math.floor(full.length / 2), full.length - 1];
  let allClean = true, offender = "";
  for (const off of offsets) {
    try { await C.open(full.slice(0, off), PASSPHRASE, { stampKey }); allClean = false; offender = `offset ${off} did not throw`; break; }
    catch (e) { if (!(e instanceof Error)) { allClean = false; offender = `offset ${off}: non-Error thrown`; break; } }
  }
  t("open() on truncated input at 6 different offsets always fails as a clean Error, never a raw crash", allClean, offender);
}

// 7. Non-JSON / non-envelope garbage strings, both inspect() and open() must handle cleanly.
{
  const stampKey = await mintStampKey();
  const garbage = ["", "not json at all", "{", "null", "12345", "true",
    '{"format":"wrong-format-entirely"}', "A".repeat(100000)];
  let allClean = true, offender = "";
  for (const g of garbage) {
    try { C.inspect(g); allClean = false; offender = `inspect() accepted garbage "${g.slice(0, 20)}"`; break; }
    catch (e) { if (!(e instanceof Error)) { allClean = false; offender = `inspect() threw non-Error on "${g.slice(0, 20)}"`; break; } }
  }
  if (allClean) {
    for (const g of garbage) {
      try { await C.open(g, PASSPHRASE, { stampKey }); allClean = false; offender = `open() accepted garbage "${g.slice(0, 20)}"`; break; }
      catch (e) { if (!(e instanceof Error)) { allClean = false; offender = `open() threw non-Error on "${g.slice(0, 20)}"`; break; } }
    }
  }
  t("inspect() and open() both reject 8 kinds of non-envelope garbage as a clean Error, never silently or with a crash", allClean, offender);
}

// 8. fast-check property sweep: for random (sealPassphrase, differentWrongPassphrase)
// pairs under the SAME valid stampKey, the wrong one must never open what the right one sealed.
{
  const stampKey = await mintStampKey();
  let counterexample = null;
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 40 }),
        fc.string({ minLength: 8, maxLength: 40 }),
        async (sealPass, wrongPass) => {
          fc.pre(sealPass !== wrongPass);
          let sealed;
          try { sealed = await sealValid({}, { stampKey, passphrase: sealPass }); }
          catch { return true; } // ratePassphrase rejecting a weak one is fine — not this property's concern
          try { await C.open(sealed.json, wrongPass, { stampKey }); return false; } // should have thrown
          catch { return true; }
        },
      ),
      { numRuns: 75 },
    );
  } catch (e) { counterexample = e.message; }
  t("fast-check: 75 random (sealPassphrase, differentWrongPassphrase) pairs never let the wrong one open", counterexample === null, counterexample || "");
}

/* ---------- the trial archive stamp was re-keyed once ----------

   It used to be derived from the device fingerprint and is now derived from the
   identity one. Every v3 file sealed during a trial before that deploy verifies
   under the OLD secret alone, so open() takes a list. The list must widen what
   opens and nothing else: an unrelated key in it is still no key. */
{
  const oldSecret = await mintStampKey(3);       // device-derived, pre-re-key
  const newSecret = await mintStampKey(4);       // identity-derived, current
  const sealedBefore = await sealValid({}, { stampKey: oldSecret });

  let refused = false;
  try { await C.open(sealedBefore.json, PASSPHRASE, { stampKey: newSecret }); }
  catch { refused = true; }
  t("re-key: a file sealed under the old secret does not open under the new one alone", refused);

  let opened;
  try { opened = await C.open(sealedBefore.json, PASSPHRASE, { stampKey: newSecret, stampKeys: [oldSecret] }); }
  catch (e) { opened = e.message; }
  t("re-key: it opens once the old secret is offered alongside",
    opened && opened.format === C.PAYLOAD_FORMAT, typeof opened === "string" ? opened : "");

  let stillClosed = false;
  try {
    await C.open(sealedBefore.json, PASSPHRASE, { stampKey: newSecret, stampKeys: [await mintStampKey(9)] });
  } catch { stillClosed = true; }
  t("re-key: an unrelated key in the list is still no key — the list is not a bypass", stillClosed);

  let noKeys = false;
  try { await C.open(sealedBefore.json, PASSPHRASE, {}); } catch { noKeys = true; }
  t("re-key: no keys at all still refuses a v3 file", noKeys);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFAILED:"); failed.forEach((l) => console.log("  " + l)); }
process.exitCode = fail ? 1 : 0;
