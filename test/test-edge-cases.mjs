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
  SRC + "/", EXT + "/"
]);
if (sync.status !== 0) { console.error("FATAL: could not mirror the extension"); process.exit(1); }

/* No issuer. Fail-open must not mean fail-generous. */
const entPath = join(EXT, "lib", "entitlement.js");
const patched = readFileSync(entPath, "utf8")
  .replace(/const ISSUER = "[^"]*";/, 'const ISSUER = "https://issuer.unreachable.invalid";');
if (!patched.includes("issuer.unreachable.invalid")) {
  console.error("FATAL: could not point the issuer at nowhere"); process.exit(1);
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
  const justInside = await verdictWith({ trial: { startedAt: Date.now() - 7 * DAY + 60000, verified: true, v: 2 } });
  t("a trial with a minute left is still active",
    justInside.verdict && justInside.verdict.entitled === true, JSON.stringify(justInside.verdict));
  t("…and reports itself as a trial",
    justInside.verdict && justInside.verdict.via === "trial", JSON.stringify(justInside.verdict));

  const justOutside = await verdictWith({ trial: { startedAt: Date.now() - 7 * DAY - 60000, verified: true, v: 2 } });
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
    trial: { startedAt: started, verified: true, v: 2 },
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
    trial: { startedAt: Date.now() - 2 * DAY, verified: true, v: 2 }
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
