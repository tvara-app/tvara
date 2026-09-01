#!/usr/bin/env node
/* Backup password options — the two choices the file format now carries:
   whether there is a password at all, and (for the browser, not the file) how
   long it is remembered.

   What matters here is that turning the password OFF gives up secrecy and
   nothing else: an unprotected file must still be signed by a licensed copy,
   must still refuse to restore if a single byte of its snapshot was edited,
   and must not be convertible into or out of the encrypted form. The
   remembering half is bg.js state and is covered by test-extension.mjs. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const scope = { self: {} };
new Function("self", readFileSync(join(ROOT, "lib", "backup-crypto.js"), "utf8"))(scope.self);
const C = scope.self.LCTBackupCrypto;
if (!C) throw new Error("lib/backup-crypto.js did not define self.LCTBackupCrypto");

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  cond ? pass++ : (fail++, failed.push(`${name}${extra ? "  → " + extra : ""}`));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};
const threw = async (fn) => {
  try { await fn(); return ""; } catch (error) { return String(error.message || error); }
};

const mintStampKey = (seed = 7) => crypto.subtle.importKey(
  "raw", new Uint8Array(32).fill(seed), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const payload = () => ({
  format: C.PAYLOAD_FORMAT, version: 1, createdAt: 1750000000000,
  chats: [
    { id: "chatgpt.com/c/a", host: "chatgpt.com", path: "/c/a", platform: "ChatGPT",
      msgs: [{ role: "user", text: "one" }, { role: "assistant", text: "two" }], updatedAt: 1 },
    { id: "claude.ai/chat/b", host: "claude.ai", path: "/chat/b", platform: "Claude",
      msgs: [{ role: "user", text: "three" }, { role: "assistant", text: "four" }], updatedAt: 2 }
  ],
  ledger: { version: 2, checkpoints: { chatgpt: 9 } },
  profile: { salt: "abc" }
});

const PASSPHRASE = "correct horse battery staple 9000";

const main = async () => {
  const stampKey = await mintStampKey();
  const otherKey = await mintStampKey(9);

  /* ---------- no password: readable, but not forgeable or editable ---------- */

  const plain = await C.sealPlain(payload(), { stampKey, stampSub: "sub-1" });
  t("unprotected file declares itself", plain.envelope.protection === C.PROTECTION_NONE);
  t("unprotected file carries the archive in readable form",
    plain.envelope.snapshot.chats[0].msgs[1].text === "two");
  t("unprotected file says so in its own text", /NOT ENCRYPTED/.test(plain.json));
  t("unprotected file holds no key material",
    !plain.envelope.kdf && !plain.envelope.wrap && plain.keyring === null);

  const opened = await C.open(plain.json, "", { stampKey });
  t("unprotected file opens with no passphrase", opened.chats.length === 2);

  const noPass = await C.open(plain.json, undefined, { stampKey });
  t("an absent passphrase is not an error on an unprotected file", noPass.chats.length === 2);

  const edited = JSON.parse(plain.json);
  edited.snapshot.chats[0].msgs[1].text = "two, but altered";
  t("an edited unprotected snapshot is refused",
    (await threw(() => C.open(JSON.stringify(edited), "", { stampKey })))
      .includes("altered"));

  const reordered = JSON.parse(plain.json);
  reordered.snapshot.chats[0] = {
    updatedAt: 1, platform: "ChatGPT", path: "/c/a", host: "chatgpt.com",
    id: "chatgpt.com/c/a", msgs: reordered.snapshot.chats[0].msgs
  };
  t("re-serialising with different key order is not treated as tampering",
    (await C.open(JSON.stringify(reordered), "", { stampKey })).chats.length === 2);

  t("an unprotected file from another licence is refused",
    (await threw(() => C.open(plain.json, "", { stampKey: otherKey })))
      .includes("not created by a licensed copy"));

  const unsigned = JSON.parse(plain.json);
  unsigned.ent.mac = "";
  t("an unprotected file with no stamp is refused",
    (await threw(() => C.open(JSON.stringify(unsigned), "", { stampKey })))
      .includes("not created by a licensed copy"));

  const dropped = JSON.parse(plain.json);
  delete dropped.digest;
  t("an unprotected file with no digest is refused",
    (await threw(() => C.open(JSON.stringify(dropped), "", { stampKey })))
      .includes("integrity digest"));

  const relabelled = JSON.parse(plain.json);
  relabelled.protection = "passphrase";
  t("a stamp cannot be carried from an unprotected file to an encrypted one",
    (await threw(() => C.open(JSON.stringify(relabelled), PASSPHRASE, { stampKey }))).length > 0);

  t("sealing without a licence key is refused",
    (await threw(() => C.sealPlain(payload(), {}))).includes("Pro feature"));
  t("sealing something that is not a snapshot is refused",
    (await threw(() => C.sealPlain({ format: "not-ours" }, { stampKey }))).includes("unrecognised"));

  /* ---------- with a password ---------- */

  const sealed = await C.seal(payload(), { passphrase: PASSPHRASE, stampKey, stampSub: "sub-1" });
  t("an encrypted file exposes no chat text", !/battery|assistant|two/.test(sealed.json));
  t("an encrypted file still opens", (await C.open(sealed.json, PASSPHRASE, { stampKey })).chats.length === 2);
  t("an encrypted file needs its passphrase",
    (await threw(() => C.open(sealed.json, "", { stampKey }))).includes("Enter the backup passphrase"));
  t("the wrong passphrase is refused",
    (await threw(() => C.open(sealed.json, "wrong passphrase entirely", { stampKey }))).includes("Wrong passphrase"));

  /* ---------- iteration count: raised by the device, never lowered ---------- */

  const fast = await C.seal(payload(), { passphrase: PASSPHRASE, stampKey, stampSub: "s", iterations: 2500000 });
  t("a faster device writes more rounds", fast.envelope.kdf.iterations === 2500000);
  t("more rounds still round-trip", (await C.open(fast.json, PASSPHRASE, { stampKey })).chats.length === 2);

  const floored = await C.seal(payload(), { passphrase: PASSPHRASE, stampKey, stampSub: "s", iterations: 1 });
  t("a request for fewer rounds than the floor is ignored",
    floored.envelope.kdf.iterations === C.KDF_ITERATIONS);

  const capped = await C.seal(payload(), { passphrase: PASSPHRASE, stampKey, stampSub: "s", iterations: 1e12 });
  t("rounds are capped so a file cannot be made unopenable",
    capped.envelope.kdf.iterations === C.KDF_MAX_ITERATIONS);

  const lowered = JSON.parse(sealed.json);
  lowered.kdf.iterations = 1000;
  t("a file claiming cheap rounds is refused before any derivation",
    (await threw(() => C.open(JSON.stringify(lowered), PASSPHRASE, { stampKey })))
      .includes("unsafe encryption settings"));

  const measured = await C.calibrateIterations(50);
  t("calibration never returns less than the floor", measured >= C.KDF_ITERATIONS);
  t("calibration never returns more than the ceiling", measured <= C.KDF_MAX_ITERATIONS);
  t("calibration is stable within a context", (await C.calibrateIterations(50)) === measured);

  /* ---------- generated passwords ---------- */

  const drawn = new Set();
  for (let i = 0; i < 200; i++) drawn.add(C.generatePassphrase());
  t("generated passwords do not repeat", drawn.size === 200);
  const sample = C.generatePassphrase();
  t("generated password is grouped for typing", /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/.test(sample));
  t("generated password omits the misread letters", !/[ILOU]/.test(sample));
  t("generated password passes the policy the UI enforces", C.ratePassphrase(sample).ok);
  t("generated password opens what it sealed",
    (await C.open((await C.seal(payload(), { passphrase: sample, stampKey, stampSub: "s" })).json,
      sample, { stampKey })).chats.length === 2);

  /* ---------- inspect tells the UI which kind it has ---------- */

  t("inspect reports an unprotected file", C.inspect(plain.json).protection === C.PROTECTION_NONE);
  t("inspect reports an encrypted file", C.inspect(sealed.json).protection === C.PROTECTION_PASSPHRASE);
  t("inspect refuses a file that is not ours",
    (await threw(() => C.inspect('{"format":"something-else"}'))).includes("not a Tvara backup"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { for (const line of failed) console.log("  " + line); process.exit(1); }
};

main().catch((error) => { console.error(error); process.exit(1); });
