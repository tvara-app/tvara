#!/usr/bin/env node
/* Tvara — does an encrypted backup actually OPEN where a person needs it to?
 *
 * "The file downloaded" proves nothing. A backup exists so a reinstall, a new
 * machine or a change of plan costs nothing, and the stamp that marks a file as
 * made by a licensed copy is keyed differently on each plan. This runs the REAL
 * functions — stampSecret, stampCreds and stampAltSecrets extracted from the
 * shipped worker, archiveSecret from the shipped issuer, seal and open from
 * lib/backup-crypto.js — through the journeys people actually take, and
 * compares what comes back with what went in.
 *
 * Found this way (2026-09-15): a backup made during the trial could not be
 * opened after buying Pro. The trial's secret was still held; stampAltSecrets
 * only offered it while the trial was the active plan.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { workerSource } from "../tools/worker-source.mjs";

const ROOT = join(import.meta.dirname, "..");
let pass = 0, fail = 0;
const t = (name, ok, got = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !got ? "" : "  → " + got}`); };

// ---------- the real code ----------
const scope = { self: {} };
new Function("self", readFileSync(join(ROOT, "lib", "backup-crypto.js"), "utf8"))(scope.self);
const C = scope.self.LCTBackupCrypto;

/** Slice `[async ]function name(...) {...}` out of a source, braces balanced. */
function extract(src, name) {
  let at = src.indexOf(`async function ${name}(`);
  if (at < 0) at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`no function ${name} in source`);
  let depth = 0, i = src.indexOf("{", at), q = "", lineC = false, blockC = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineC) { if (c === "\n") lineC = false; continue; }
    if (blockC) { if (c === "*" && n === "/") { blockC = false; i++; } continue; }
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = ""; continue; }
    if (c === "/" && n === "/") { lineC = true; continue; }
    if (c === "/" && n === "*") { blockC = true; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const bg = workerSource(ROOT);
const issuer = readFileSync(join(ROOT, "server", "entitlement-worker.js"), "utf8");
const LOCAL_KEY = (bg.match(/const LOCAL_STAMP_KEY = "([^"]+)"/) || [])[1];

/** One install: its own storage, its own verdict, the worker's real functions. */
function install(verdict) {
  const store = new Map();
  const chrome = { storage: { local: {
    get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k || {});
      const o = {}; for (const key of keys) if (store.has(key)) o[key] = store.get(key); return o; },
    set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
  } } };
  const LCTEntitlement = { sha256Hex: async (s, n) => createHash("sha256").update(s).digest("hex").slice(0, n || 64) };
  const body = ["stampSecret", "ensureLocalStampSecret", "stampCreds", "stampAltSecrets"].map((f) => extract(bg, f)).join("\n");
  const make = new Function("chrome", "self", "entitlementVerdict", "LOCAL_STAMP_KEY",
    `${body}\nreturn { stampCreds, store: null };`);
  const self = { LCTEntitlement };
  const api = make(chrome, self, async () => verdict, LOCAL_KEY);
  return { ...api, chrome, setLicence: (key) => store.set("license", { key }) };
}

const archiveSecret = new Function("crypto", "enc", `${extract(issuer, "archiveSecret")}\nreturn archiveSecret;`)(
  globalThis.crypto, new TextEncoder());
const ENV = { ARCHIVE_SECRET: "test-archive-secret-do-not-ship" };

/** What pages.js does with an archive-stamp answer. */
async function pageKeys(creds) {
  const toKey = async (s) => { try { return await crypto.subtle.importKey("raw", C.base64ToBytes(s),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); } catch { return null; } };
  const stampKey = creds.secret ? await toKey(creds.secret) : null;
  const stampKeys = [];
  for (const a of creds.alts || []) { const k = await toKey(a); if (k) stampKeys.push(k); }
  return { stampKey, stampSub: creds.stampSub || "", stampKeys };
}

const PASS = "correct horse battery staple — long enough";
const ARCHIVE = { chats: [
  { i: "chatgpt.com/c/1", t: "Designing the sync engine", r: "chatgpt", m: [
    { role: "user", text: "How should retries back off?" },
    { role: "assistant", text: "Exponential with jitter.\n```js\nconst d = Math.min(cap, base * 2 ** n);\n```" }] },
  { i: "claude.ai/chat/2", t: "Maths: $\\int_0^1 x\\,dx$", r: "claude", m: [
    { role: "user", text: "Prove it" }, { role: "assistant", text: "$$\\frac{1}{2}$$ — ünïcødé ✓ 日本語" }] },
] };

/* The snapshot shape pages.js collectSnapshot() hands to seal(). */
const snapshotOf = (archive) => ({ format: C.PAYLOAD_FORMAT, version: 1, createdAt: 1789400000000,
  chats: archive.chats, ledger: { version: 2, checkpoints: {} }, profile: null });
async function seal(inst, archive = ARCHIVE) {
  const k = await pageKeys(await inst.stampCreds());
  if (!k.stampKey) throw new Error("this install cannot seal (locked)");
  // The bytes pages.js writes to disk: sealed.json, not the object around it.
  const sealed = await C.seal(snapshotOf(archive), { passphrase: PASS, stampKey: k.stampKey, stampSub: k.stampSub, iterations: 600000 });
  return sealed.json;
}
async function reopen(inst, file, passphrase = PASS) {
  const k = await pageKeys(await inst.stampCreds());
  try {
    const snap = await C.open(file, passphrase,
      { stampKey: k.stampKey, stampKeys: k.stampKeys });
    return { ok: true, snap };
  } catch (e) { return { ok: false, err: String(e.message || e) }; }
}
/* Byte for byte: every chat, every message, every character — code fences,
   LaTeX and non-Latin text included. A count would pass a restore that
   truncated every message. */
const sameArchive = (snap) => !!snap && JSON.stringify(snap.chats) === JSON.stringify(ARCHIVE.chats);

// ---------- the identities ----------
const ID = "identity-fp-anirudh", OTHER = "identity-fp-stranger";
const trialKs = await archiveSecret(ENV, "trial:" + ID);
const trialVerdict = (id = ID) => ({ entitled: true, via: "trial",
  trial: { grants: true, ks: id === ID ? trialKs : null, ksPrev: "" } });
const LICENCE = "LCT1.test-licence-for-portability";
const lct1Verdict = (trial) => ({ entitled: true, via: "lct1", kind: "lct1", trial: trial || { grants: false } });
const proKs = await archiveSecret(ENV, "licence-keyfp-abc");
const issuerProVerdict = (trial) => ({ entitled: true, via: "pro", kind: "pro", ks: proKs, trial: trial || { grants: false } });

console.log("\n— a trial backup");
{
  const a = install(trialVerdict());
  const file = await seal(a);
  const text = file;
  t("a trial install can seal an encrypted backup", !!file);
  t("the file on disk is not readable as plain text", !/sync engine|Exponential|日本語/.test(text));

  const b = install({ entitled: true, via: "trial", trial: { grants: true, ks: await archiveSecret(ENV, "trial:" + ID), ksPrev: "" } });
  const r1 = await reopen(b, file);
  t("…opens after a reinstall on the same Google account", r1.ok, r1.err);
  t("…and every message comes back exactly", r1.ok && sameArchive(r1.snap));

  const sameInstallPro = install(lct1Verdict({ grants: false, ks: trialKs, ksPrev: "" }));
  sameInstallPro.setLicence(LICENCE);
  const r2 = await reopen(sameInstallPro, file);
  t("…opens after BUYING Pro on the same install (trial record still held)", r2.ok, r2.err);
  t("…and every message comes back exactly", r2.ok && sameArchive(r2.snap));

  const issuerPro = install(issuerProVerdict({ grants: false, ks: trialKs, ksPrev: "" }));
  const r3 = await reopen(issuerPro, file);
  t("…opens after buying Pro through the issuer", r3.ok, r3.err);

  /* A NEW machine after buying. The trial record comes back only by signing in
     with Google — settleAfterVerify() re-fetches it from the issuer — so the
     outcome depends on that, and both answers are asserted. */
  const newMachineSignedIn = install(lct1Verdict({ grants: false, ks: await archiveSecret(ENV, "trial:" + ID), ksPrev: "" }));
  newMachineSignedIn.setLicence(LICENCE);
  const r4 = await reopen(newMachineSignedIn, file);
  t("…opens on a NEW machine after buying, once signed in with the same Google account", r4.ok, r4.err);
  t("…and every message comes back exactly", r4.ok && sameArchive(r4.snap));
  const newMachineNoSignIn = install(lct1Verdict({ grants: false }));
  newMachineNoSignIn.setLicence(LICENCE);
  const r5 = await reopen(newMachineNoSignIn, file);
  t("…before signing in there, it is refused rather than half-opened", !r5.ok);
  t("…with a refusal that says what to do, not that the file is forged",
    /Sign in with the Google account/.test(r5.err || "") && !/licensed copy/i.test(r5.err || ""), r5.err);

  const stranger = install(trialVerdict(OTHER));
  stranger.chrome.storage.local.set({});
  const strangerKeys = await pageKeys(await install({ entitled: true, via: "trial",
    trial: { grants: true, ks: await archiveSecret(ENV, "trial:" + OTHER), ksPrev: "" } }).stampCreds());
  let strangerOpened = false;
  try { await C.open(file, PASS, { stampKey: strangerKeys.stampKey, stampKeys: strangerKeys.stampKeys }); strangerOpened = true; } catch {}
  t("…does NOT open under somebody else's account, even with the passphrase", !strangerOpened);

  const wrong = await reopen(b, file, "definitely not the passphrase at all");
  t("…refuses a wrong passphrase", !wrong.ok, wrong.err);
  t("…and says so in words a person can act on", /passphrase|altered/i.test(wrong.err || ""), wrong.err);
}

console.log("\n— a Pro backup");
{
  const a = install(lct1Verdict()); a.setLicence(LICENCE);
  const file = await seal(a);
  const b = install(lct1Verdict()); b.setLicence(LICENCE);
  const r = await reopen(b, file);
  t("an LCT1 backup opens after a reinstall with the same key", r.ok, r.err);
  t("…and every message comes back exactly", r.ok && sameArchive(r.snap));

  const other = install(lct1Verdict()); other.setLicence("LCT1.someone-elses-licence");
  const r2 = await reopen(other, file);
  t("…does not open under a different licence", !r2.ok);

  const ia = install(issuerProVerdict());
  const ifile = await seal(ia);
  const ib = install(issuerProVerdict());
  const ir = await reopen(ib, ifile);
  t("an issuer Pro backup opens after a reinstall", ir.ok, ir.err);
}

console.log("\n— what the refusal says");
{
  const src = readFileSync(join(ROOT, "lib", "backup-crypto.js"), "utf8");
  t("no refusal still names the old product (Long Chat Toolkit)", !/Long Chat Toolkit/.test(src),
    (src.match(/.*Long Chat Toolkit.*/) || [""])[0].trim().slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
