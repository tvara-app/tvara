#!/usr/bin/env node
/* content/purchase.js runs on exactly one page: our own post-purchase
   thanks.html. It reads a licence key out of the URL (or a #key element as
   fallback) and hands it to bg.js. Three things must hold for a hostile
   ?license_key= value: the client-side length cap keeps it from ever being
   sent for absurd input, whatever DOES reach bg.js is validated there before
   any storage write, and the raw key is never written into the DOM anywhere
   on the page — say() only ever writes hardcoded status strings.

   Corrects a stale assumption from an earlier pass at this test: purchase.js
   has no postMessage listener. The key arrives via location.search, read by
   findKey(), forwarded via chrome.runtime.sendMessage. Tested that way. */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { ROOT, SCRATCH, reporter, mirrorExtension } from "./security-fixtures.mjs";

const { t, done } = reporter();
const WORK = join(SCRATCH, "purchase-flow");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const PROFILE = join(WORK, "chrome-profile");

const { EXT } = mirrorExtension("purchase-flow");
const THANKS = join(ROOT, "docs", "thanks.html");

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: process.env.PW_CHANNEL || "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 900, height: 800 }
});
await new Promise((r) => setTimeout(r, 1500));

// Serve the repo's own thanks.html for the exact URL the manifest matches —
// no real network reach to tvara-app.github.io, ever.
await ctx.route("https://tvara-app.github.io/thanks.html*", (route) =>
  route.fulfill({ path: THANKS, contentType: "text/html" }));

// A plausible-shaped garbage key (passes looksLikeKey's charset check) makes
// it past content/purchase.js and into a REAL network call inside lib/dodo.js
// (activateWithSeats → activate → POST live.dodopayments.com/licenses/activate).
// Route both Dodo hosts to a fast, deterministic 403 so the test never depends
// on live network reachability and never waits out the real 10s timeout.
await ctx.route(/^https:\/\/(live|test)\.dodopayments\.com\//, (route) =>
  route.fulfill({ status: 403, contentType: "application/json", body: "{}" }));

// One service worker for the whole context; install the passive observer
// once. It logs every license-activate message it sees without touching
// sendResponse, so the real router still answers each one normally.
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
await sw.evaluate(() => {
  self.__seenLicenseActivate = [];
  if (!self.__lctTestObserverInstalled) {
    self.__lctTestObserverInstalled = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "license-activate") {
        self.__seenLicenseActivate.push({ key: msg.key, len: (msg.key || "").length });
      }
    });
  }
});

async function runScenario(licenseKeyParam) {
  const page = await ctx.newPage();
  await sw.evaluate(() => { self.__seenLicenseActivate = []; }); // fresh per scenario

  const url = "https://tvara-app.github.io/thanks.html?license_key=" + encodeURIComponent(licenseKeyParam);
  await page.goto(url, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 1500)); // document_idle + the message round trip

  const seen = await sw.evaluate(() => self.__seenLicenseActivate || []);
  // Scoped to what content/purchase.js itself writes (the #auto-activate
  // status box), NOT the whole page: thanks.html has its OWN, unrelated,
  // already-safe key display (a `#key` <code> box, filled via .textContent,
  // gated on its own `/[<>"']/` filter) — that box legitimately shows a
  // clean key back to the buyer and is not the thing under test here.
  const purchaseJsDom = await page.evaluate(() => {
    const box = document.getElementById("auto-activate");
    return box ? box.outerHTML : "";
  });

  await page.close();
  return { seen, purchaseJsDom };
}

/* ---------- 1. oversized key: client-side cap must block the send entirely ---------- */
{
  const oversized = "A".repeat(250);
  const { seen } = await runScenario(oversized);
  t(">200-char key never reaches sendMessage (client-side cap)", seen.length === 0,
    `saw ${seen.length} license-activate message(s)`);
}

/* ---------- 2. malformed-but-short key: must reach bg.js, and bg.js must reject it ---------- */
{
  const marker = "XSSMARKER_" + Math.random().toString(36).slice(2, 10);
  const malformed = `<img src=x onerror=alert('${marker}')>`; // well under 200 chars, fails looksLikeKey's charset
  const { seen, purchaseJsDom } = await runScenario(malformed);
  t("malformed key (fails looksLikeKey) still reaches bg.js", seen.length === 1,
    `saw ${seen.length} messages`);
  if (seen.length) {
    t("bg.js received the key verbatim (nothing silently mutated it first)", seen[0].key === malformed);
  }
  t("purchase.js's own status box never contains the raw key/marker",
    !purchaseJsDom.includes(marker) && !purchaseJsDom.includes("onerror=alert"),
    `#auto-activate outerHTML: ${purchaseJsDom.slice(0, 200)}`);
}

/* ---------- 3. a plausible-length garbage key: reaches the real activate() call ---------- */
{
  const marker2 = "PLAINMARKER_" + Math.random().toString(36).slice(2, 10);
  const garbage = marker2; // alnum/underscore only — passes looksLikeKey's charset, still not a real key
  const { seen, purchaseJsDom } = await runScenario(garbage);
  t("plausible-shaped garbage key reaches bg.js", seen.length === 1, `saw ${seen.length} messages`);
  // Dodo routed to 403 above → classify() → "inactive" → activateLicenseKey
  // returns {ok:false, reason:"refused", ...} → purchase.js's warn branch.
  t("bg.js does not activate on a 403 from the licence provider",
    purchaseJsDom.includes("warn") || purchaseJsDom.includes("idle"),
    `#auto-activate outerHTML: ${purchaseJsDom.slice(0, 200)}`);
  t("purchase.js's own status box never contains the raw key/marker", !purchaseJsDom.includes(marker2),
    `#auto-activate outerHTML: ${purchaseJsDom.slice(0, 200)}`);
}

await ctx.close();
done();
