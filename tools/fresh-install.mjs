#!/usr/bin/env node
/**
 * Tvara, a from-scratch install walked end to end.
 *
 *   node tools/fresh-install.mjs "LCT1.xxx.yyy"
 *
 * WHY THIS IS NOT THE TEST SUITE
 * test-extension.mjs mirrors the extension and swaps the signing key for a test
 * one, so it can issue itself licences. That is right for a suite, and it means
 * the suite has never once verified a key against the key that SHIPS.
 *
 * This loads the extension exactly as published, in a profile that has never
 * seen it, and walks what a buyer walks: first run, the welcome page, the free
 * trial, a real conversation, then a real licence key from tools/genkey.mjs.
 * Nothing is mocked. If this passes, a purchase unlocks Pro.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(EXT, "test", ".work-fresh");
const KEY = process.argv[2] || "";
const PORT = 8942;

let pass = 0, fail = 0; const failed = [];
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; failed.push(`${name}${detail ? "  → " + detail : ""}`); console.log(`FAIL  ${name}${detail ? "  → " + detail : ""}`); }
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"],
  { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));

const ctx = await chromium.launchPersistentContext(join(WORK, "profile"), {
  channel: process.env.PW_CHANNEL || "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

try {
  const sw = ctx.serviceWorkers()[0] ||
    await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const id = new URL(sw.url()).host;
  t("install: the extension loads and its worker starts", !!id, id);

  /* ---------- 1. first run ---------- */
  const wel = await ctx.newPage();
  await wel.goto(`chrome-extension://${id}/welcome.html`);
  await wel.waitForSelector(".hero-card", { timeout: 15000 });
  t("first run: the welcome page opens with the chat chips first",
    await wel.isVisible(".hero-card .chips .chip"));
  t("first run: it offers to fetch history", await wel.isVisible("#fetch-history"));
  const planFresh = await wel.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "entitlement-state" }, r)));
  t("first run: a fresh install is not entitled",
    !planFresh || !planFresh.entitled, JSON.stringify(planFresh));

  /* ---------- 2. the popup, before anything ---------- */
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${id}/popup/popup.html`);
  await pop.waitForSelector("#plan-badge", { timeout: 15000 });
  t("popup: opens on a virgin profile reading Free",
    (await pop.textContent("#plan-badge")).trim() === "Free");
  t("popup: the allowance panel says so rather than drawing empty rings",
    /No allowance readings yet/i.test(await pop.textContent("#usage-bars")));
  const overflow = await pop.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }));
  t("popup: nothing overflows the pane", overflow.scroll <= overflow.client, JSON.stringify(overflow));

  /* ---------- 3. a real conversation ---------- */
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/test/synthetic.html`);
  await page.waitForSelector("#lct-minimap", { timeout: 20000 });
  t("in chat: the minimap appears on a long conversation", true);
  // Fired for its effect on the worker, not for its answer — the assertions
  // below read the DOM, not this.
  await page.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "lct-health" }, r)).catch(() => null)).catch(() => null);
  // The minimap draws to a canvas; there are no per-message nodes to count.
  // The engine marks slept messages with the class it windows on.
  const counts = await page.evaluate(() => {
    const c = document.querySelector("#lct-mm-canvas");
    return {
      canvas: !!c, canvasH: c ? Math.round(c.getBoundingClientRect().height) : 0,
      asleep: document.getElementsByClassName("lct-cv").length,
      messages: document.querySelectorAll("[data-message-id], .lct-msg, article").length
    };
  });
  t("in chat: the minimap renders a sized canvas",
    counts.canvas && counts.canvasH > 100, JSON.stringify(counts));
  t("in chat: the speed engine puts off-screen messages to sleep",
    counts.asleep > 0, JSON.stringify(counts));

  /* ---------- 4. a REAL licence key, against the SHIPPED public key ----------
     Before the trial, deliberately: the popup hides the upsell card — and the
     key field inside it — while a trial is running, which is right, and means
     this can only be typed on a profile that has not started one. */
  if (!KEY) {
    t("licence: a key was supplied to test with", false, "pass one as argv[1]");
  } else {
    const verdict = await pop.evaluate(async (k) => {
      const r = await self.LCTLicense.verify(k);
      return { valid: r.valid, reason: r.reason || "", email: r.email || "" };
    }, KEY).catch((e) => ({ valid: false, reason: String(e).slice(0, 80) }));
    t("licence: a real genkey.mjs key verifies against the SHIPPED public key",
      verdict.valid === true, JSON.stringify(verdict));

    await pop.fill("#license-input", KEY);
    await pop.click("#license-activate");
    await pop.waitForTimeout(2500);
    const badge = (await pop.textContent("#plan-badge")).trim();
    t("licence: activating it flips the popup to Pro", badge === "Pro", badge);
    const ent = await pop.evaluate(() => new Promise((r) =>
      chrome.runtime.sendMessage({ type: "entitlement-state" }, r)));
    t("licence: the worker agrees it is entitled, and by licence not trial",
      !!(ent && ent.entitled && ent.via !== "trial"), JSON.stringify(ent));
    const cached = await pop.evaluate(() => localStorage.getItem("lct-ui-v3") || "");
    t("licence: the first-paint cache never holds the key itself",
      !cached.includes(KEY.slice(0, 24)), cached.slice(0, 90));
  }

  /* ---------- 5. remove the licence, then the trial ---------- */
  await pop.bringToFront();
  if (await pop.isVisible("#license-remove")) {
    await pop.click("#license-remove");
    await pop.waitForTimeout(1500);
    t("licence: removing it drops the popup back to Free",
      (await pop.textContent("#plan-badge")).trim() === "Free",
      (await pop.textContent("#plan-badge")).trim());
  }
  await wel.bringToFront();
  await wel.click("#trial-start");
  await wel.waitForTimeout(1500);
  const trial = await wel.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "trial-state" }, r)));
  t("trial: one click starts it, with no signup", !!(trial && trial.active), JSON.stringify(trial));
  const entTrial = await wel.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "entitlement-state" }, r)));
  t("trial: it entitles the paid features", !!(entTrial && entTrial.entitled), JSON.stringify(entTrial));

  /* ---------- 6. the purchase redirect activates on its own ----------
     The four steps between paying and having the thing you paid for — find the
     email, find the icon, open the popup, paste — are where refunds come from.
     Dodo puts the key in the return URL, so this walks the real redirect and
     asserts the buyer has to do nothing at all. */
  if (KEY) {
    await pop.evaluate(() => chrome.storage.local.remove(["license", "lct-license-state-v1"]));
    const buyer = await ctx.newPage();
    await buyer.goto(`https://tvara-app.github.io/thanks.html?license_key=${encodeURIComponent(KEY)}&status=succeeded`,
      { waitUntil: "domcontentloaded", timeout: 45000 });
    await buyer.waitForTimeout(6000);
    const box = await buyer.evaluate(() => {
      const el = document.getElementById("auto-activate");
      return el && !el.hidden ? { cls: el.className, text: el.textContent } : null;
    });
    t("purchase: the redirect page activates the licence with no paste",
      !!(box && /Pro is active/i.test(box.text)), JSON.stringify(box));
    t("purchase: …and the key does not stay in the address bar",
      !/license_key=/.test(buyer.url()), buyer.url().slice(0, 80));
    await pop.reload();
    await pop.waitForSelector("#plan-badge");
    await pop.waitForTimeout(1500);
    t("purchase: …and the popup is Pro without being touched",
      (await pop.textContent("#plan-badge")).trim() === "Pro",
      (await pop.textContent("#plan-badge")).trim());
    await buyer.close();
  }

  /* ---------- 7. a garbage key is refused, and says why ---------- */
  const junk = await pop.evaluate(async () => {
    const r = await self.LCTLicense.verify("LCT1.aaaa.bbbb");
    return { valid: r.valid, reason: r.reason || "" };
  });
  t("licence: a forged key is refused", junk.valid === false, JSON.stringify(junk));
  t("licence: …and the reason is never the word invalid",
    !/invalid/i.test(junk.reason), junk.reason);

} catch (error) {
  fail++; failed.push("WALKTHROUGH THREW: " + String((error && error.stack) || error));
  console.error(error);
} finally {
  await ctx.close().catch(() => {});
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  " + f); }
process.exit(fail ? 1 : 0);
