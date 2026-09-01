#!/usr/bin/env node
/**
 * Tvara — the states nobody plans for.
 *
 * Every case here is one where the honest answer and the convenient answer
 * differ: a trial record the user has edited, a clock wound forward, a licence
 * field that is a string where a number was assumed, an issuer that is simply
 * not there. The gate has to survive all of them without either locking out a
 * paying customer or handing out Pro for free.
 *
 * The issuer is pointed at an unreachable host on purpose. Offline is the
 * adversary's best case — no server to correct a forged record — so every
 * assertion below holds with nothing to appeal to.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const SRC = join(import.meta.dirname, "..");
const SCRATCH = join(SRC, "test", ".work-edge");
const PROFILE = join(SCRATCH, "chrome-profile");
const EXT = join(SCRATCH, "ext");
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });

const sync = spawnSync("rsync", [
  "-a", "--exclude", ".git", "--exclude", "node_modules",
  "--exclude", "test/.work*", "--exclude", ".stryker-tmp",
  "--exclude", "dist", "--exclude", "store", "--exclude", "tools/.keys",
  SRC + "/", EXT + "/"
]);
if (sync.status !== 0) { console.error("FATAL: could not mirror the extension"); process.exit(1); }

/* No issuer. Fail-open must not mean fail-generous.

   The mirror also trusts a throwaway keypair instead of the production one, so
   this file can mint the ONE thing a trial now turns on — the issuer's signed
   grant — without the real private key, which is deliberately on no dev
   machine. Everything else the mirror sees is the shipping code. */
const { publicKey, privateKey: priv } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const TEST_INTEGRITY = [...createHash("sha256").update(TEST_PUB).digest().subarray(0, 16)]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

const entPath = join(EXT, "lib", "entitlement.js");
const patched = readFileSync(entPath, "utf8")
  .replace(/const ISSUER = "[^"]*";/, 'const ISSUER = "https://issuer.unreachable.invalid";')
  .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`)
  .replace(/const _KEY_INTEGRITY = "[^"]*";/, `const _KEY_INTEGRITY = "${TEST_INTEGRITY}";`);
if (!patched.includes("issuer.unreachable.invalid") || !patched.includes(TEST_PUB) ||
    !patched.includes(TEST_INTEGRITY)) {
  console.error("FATAL: could not patch the mirrored entitlement lib"); process.exit(1);
}
writeFileSync(entPath, patched);

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: process.env.PW_CHANNEL || "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
await new Promise((r) => setTimeout(r, 1500));
let sw = ctx.serviceWorkers()[0];
if (!sw) { try { sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 }); } catch { /* none */ } }
const EXT_ID = sw ? new URL(sw.url()).host : null;
if (!EXT_ID) { console.error("FATAL: extension service worker never started"); process.exit(1); }

const page = await ctx.newPage();
await page.goto(`chrome-extension://${EXT_ID}/popup/popup.html`);

const DAY = 864e5;

/* The issuer's signed grant, minted here because the issuer is unreachable by
   design. Bound to THIS install's device fingerprint — the popup and the
   service worker share the keypair, so what the page reports is what the gate
   will check against. */
const b64u = (buf) => Buffer.from(buf).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const DEV_FP = await page.evaluate(() => self.LCTEntitlement.deviceFpFor(""));
function signedTrial(startedAt, over = {}) {
  const payload = Buffer.from(JSON.stringify({
    v: 1, typ: "trial", idf: "edge-identity", dev: DEV_FP,
    sta: startedAt, iat: Date.now(), exp: startedAt + 7 * DAY, ks: "edge-stamp",
    jti: "tt-edge", ...over
  }));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  return `LCTT1.${b64u(payload)}.${b64u(sig)}`;
}
/** A trial record as the issuer would have left it. */
const grantedTrial = (startedAt, over = {}) => ({
  startedAt, v: 2, verified: true, checkedAt: Date.now(), ks: "edge-stamp",
  tt: signedTrial(startedAt, over)
});

/** Put the profile into an exact state, then ask the gate what it thinks. */
async function verdictWith(state) {
  return page.evaluate(async (state) => {
    await chrome.storage.local.remove(["license", "lct-trial-v2", "lct-clock-hwm-v1",
      "lct-entitlement-v2", "lct-entitlement-attempt-v1"]);
    try { await chrome.storage.sync.remove(["lct-trial-v2"]); } catch { /* none */ }
    if (state.trial !== undefined) {
      try { await chrome.storage.sync.set({ "lct-trial-v2": state.trial }); } catch { /* none */ }
      await chrome.storage.local.set({ "lct-trial-v2": state.trial });
    }
    if (state.license !== undefined) await chrome.storage.local.set({ license: state.license });
    if (state.hwm !== undefined) await chrome.storage.local.set({ "lct-clock-hwm-v1": state.hwm });
    const v = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "entitlement-state" }, res));
    const stored = await chrome.storage.local.get("lct-trial-v2");
    return { verdict: v, stored: stored["lct-trial-v2"] || null };
  }, state);
}

/* ---------- a trial record the user wrote themselves ---------- */

{
  const far = Date.now() + 3650 * DAY;
  const r = await verdictWith({ trial: { startedAt: far, verified: true, v: 2 } });
  t("a trial dated ten years in the future grants nothing",
    r.verdict && r.verdict.entitled === false, JSON.stringify(r.verdict));
  t("…and the forged date is clamped in storage, not just ignored",
    r.stored && r.stored.startedAt <= Date.now() + 36e5, JSON.stringify(r.stored));
  t("…and its self-asserted 'verified' is cleared",
    r.stored && !r.stored.verified, JSON.stringify(r.stored));
}

{
  // The clamp must not be a fresh week on every read.
  const far = Date.now() + 3650 * DAY;
  await verdictWith({ trial: { startedAt: far, verified: true, v: 2 } });
  const again = await page.evaluate(async () => {
    const v = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "entitlement-state" }, res));
    const s = await chrome.storage.local.get("lct-trial-v2");
    return { v, s: s["lct-trial-v2"] };
  });
  t("re-reading a clamped record does not re-issue the week",
    again.s && again.s.startedAt <= Date.now() + 36e5, JSON.stringify(again.s));
}

/* ---------- a record with no signature on it ----------

   The forge this whole change exists to stop. A start date and verified:true
   are two fields a DevTools console writes in ten seconds, and until the grant
   became a signature they were the entire trial gate. */

{
  const plausible = Date.now() - 2 * DAY;
  const r = await verdictWith({ trial: { startedAt: plausible, verified: true, v: 2, checkedAt: Date.now() } });
  t("a hand-written verified:true grants nothing without a signature",
    r.verdict && r.verdict.entitled === false, JSON.stringify(r.verdict && r.verdict.via));

  // A signature that does not verify is not a signature.
  const tampered = grantedTrial(plausible);
  tampered.tt = tampered.tt.slice(0, -4) + (tampered.tt.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  t("a tampered grant unlocks nothing",
    (await verdictWith({ trial: tampered })).verdict.entitled === false);

  // Someone else's working grant, copied across.
  t("a grant minted for another device unlocks nothing",
    (await verdictWith({ trial: grantedTrial(plausible, { dev: "0".repeat(32) }) }))
      .verdict.entitled === false);

  /* The dates are read out of the signature, so editing the record's own copy
     moves nothing. Here the record claims today and the signature says the week
     ended three weeks ago. */
  t("a fresh date beside an expired signature is still an expired trial",
    (await verdictWith({ trial: { ...grantedTrial(Date.now() - 30 * DAY), startedAt: Date.now() } }))
      .verdict.entitled === false);
}

/* ---------- shapes that were never meant to be there ---------- */

for (const [label, trial] of [
  ["a string start date", { startedAt: "yesterday", v: 2 }],
  ["a null start date", { startedAt: null, v: 2 }],
  ["a negative start date", { startedAt: -1, v: 2 }],
  ["a zero start date", { startedAt: 0, v: 2 }],
  ["an object start date", { startedAt: {}, v: 2 }],
  ["NaN", { startedAt: Number.NaN, v: 2 }],
  ["Infinity", { startedAt: Number.POSITIVE_INFINITY, v: 2 }],
  ["no record at all", undefined],
  ["an empty record", {}]
]) {
  const r = await verdictWith({ trial });
  t(`${label} grants nothing and does not throw`,
    r.verdict && r.verdict.entitled === false, JSON.stringify(r.verdict));
}

/* ---------- the boundary ---------- */

{
  const justInside = await verdictWith({ trial: grantedTrial(Date.now() - 7 * DAY + 60000) });
  t("a trial with a minute left is still active",
    justInside.verdict && justInside.verdict.entitled === true, JSON.stringify(justInside.verdict));
  t("…and reports itself as a trial",
    justInside.verdict && justInside.verdict.via === "trial", JSON.stringify(justInside.verdict));

  const justOutside = await verdictWith({ trial: grantedTrial(Date.now() - 7 * DAY - 60000) });
  t("a trial a minute past seven days is spent",
    justOutside.verdict && justOutside.verdict.entitled === false, JSON.stringify(justOutside.verdict));
  t("…and says so rather than saying 'never started'",
    justOutside.verdict && justOutside.verdict.trial && justOutside.verdict.trial.spent === true,
    JSON.stringify(justOutside.verdict.trial));
}

/* ---------- winding the clock back ---------- */

{
  const started = Date.now() - 30 * DAY;
  const r = await verdictWith({
    trial: grantedTrial(started),
    hwm: Date.now()            // this profile has already seen today
  });
  t("a spent trial stays spent (the high-water clock holds)",
    r.verdict && r.verdict.entitled === false, JSON.stringify(r.verdict));
}

/* ---------- a licence record that is not one ---------- */

for (const [label, license] of [
  ["an empty licence", {}],
  ["a licence with no key", { activatedAt: Date.now() }],
  ["a licence whose key is a number", { key: 12345 }],
  ["a licence whose key is an object", { key: {} }],
  ["a revoked licence", { key: "LCT-SOMETHING", revokedAt: Date.now() }]
]) {
  const r = await verdictWith({ license });
  t(`${label} grants nothing and does not throw`,
    r.verdict && r.verdict.entitled === false, JSON.stringify(r.verdict && r.verdict.via));
}

/* ---------- a revoked licence must not eat an unspent trial ---------- */

{
  const r = await verdictWith({
    license: { key: "LCT-REFUNDED", revokedAt: Date.now() },
    trial: grantedTrial(Date.now() - 2 * DAY)
  });
  t("a refunded licence still leaves an unspent trial usable",
    r.verdict && r.verdict.entitled === true && r.verdict.via === "trial",
    JSON.stringify(r.verdict && { e: r.verdict.entitled, via: r.verdict.via }));
}

/* ---------- activation, with the issuer gone ---------- */

async function activate(key) {
  return page.evaluate((key) => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "license-activate", key }, res)), key);
}

for (const [label, key] of [
  ["an empty key", ""],
  ["a null key", null],
  ["a key of spaces", "     "],
  ["a one-character key", "x"],
  ["a key with a newline", "ABCD1234\nEFGH"],
  ["a 10,000-character key", "A".repeat(10000)],
  ["a key that is an object", { evil: true }],
  ["a key with angle brackets", "<script>alert(1)</script>"]
]) {
  const r = await activate(key);
  t(`activating with ${label} fails cleanly`,
    r && r.ok !== true, JSON.stringify(r));
}

{
  // Two at once must not mint two seats or throw an unhandled rejection.
  const both = await page.evaluate(() => Promise.all([
    new Promise((res) => chrome.runtime.sendMessage({ type: "license-activate", key: "LCT-RACE-0001" }, res)),
    new Promise((res) => chrome.runtime.sendMessage({ type: "license-activate", key: "LCT-RACE-0001" }, res))
  ]));
  t("two simultaneous activations both answer, neither throws",
    Array.isArray(both) && both.length === 2 && both.every((r) => r && r.ok !== true),
    JSON.stringify(both));
}

/* ---------- the gate itself, with everything gone ---------- */

{
  const r = await verdictWith({});
  t("a clean install with no licence and no trial is locked",
    r.verdict && r.verdict.entitled === false && r.verdict.via === "none",
    JSON.stringify(r.verdict));
  t("…and reports the trial as unstarted, so the offer still stands",
    r.verdict && r.verdict.trial && r.verdict.trial.started === false,
    JSON.stringify(r.verdict.trial));
}

/* ---------- a Pro action must not be servable from a locked install ---------- */

{
  await verdictWith({});
  const gated = await page.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-search", q: "anything", long: true }, res)));
  t("a locked install cannot search the archive",
    !gated || gated.err || (gated.results || []).length === 0, JSON.stringify(gated));
}

await ctx.close();
if (failed.length) { console.log("\n--- failures ---"); failed.forEach((f) => console.log("  " + f)); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
