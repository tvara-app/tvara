#!/usr/bin/env node
/* content/purchase.js runs on the post-purchase page.

   WHAT THIS TEST IS NOW ABOUT. It used to read a licence key out of the
   query string and hand it to bg.js, and this file tested that a hostile
   ?license_key= value was capped, validated server-side, and never written into
   the DOM. Those were mitigations for a design that put a bearer secret in a
   URL — where browser history, profile sync, the omnibox and every other
   extension holding `tabs` can read it.

   The design is gone. The extension opens the checkout itself, holds the order
   ref, and claims the licence over a device key WebCrypto will not export. So
   the assertions here are stronger than the old ones: the URL is INERT. No
   value in it can produce an activation, reach bg.js as a key, or appear on the
   page — not because it is filtered, but because nothing reads it.

   A filter can be got round. A parser that does not exist cannot. */
import { mkdirSync, rmSync, readFileSync } from "node:fs";
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

/* ---------- 0. the source itself, before a browser is involved ----------
   The cheapest and most durable check there is: the code that used to read the
   URL is not there to be re-enabled. */
{
  const src = readFileSync(join(ROOT, "content", "purchase.js"), "utf8");
  t("purchase.js never reads the query string",
    !/location\.search|URLSearchParams/.test(src));
  t("purchase.js never names a licence-key parameter",
    !/license_key|licence_key/i.test(src));
  const page = readFileSync(THANKS, "utf8");
  t("thanks.html never reads a licence key out of its own URL",
    !/license_key|licence_key/i.test(page));
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: process.env.PW_CHANNEL || "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 900, height: 800 }
});
await new Promise((r) => setTimeout(r, 1500));

// Serve the local template for the exact manifest match; no real network call.
await ctx.route("https://tvara.pages.dev/thanks*", (route) =>
  route.fulfill({ path: THANKS, contentType: "text/html" }));

/* Nothing in this test should reach a payment provider. Routing both hosts to a
   deterministic 403 means a regression that DID start calling one fails here
   rather than hanging on a real 10s timeout. */
await ctx.route(/^https:\/\/(live|test)\.dodopayments\.com\//, (route) =>
  route.fulfill({ status: 403, contentType: "application/json", body: "{}" }));

/* One service worker for the whole context. The observer logs every message the
   page sends without touching sendResponse, so the real router still answers
   each one normally. */
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
await sw.evaluate(() => {
  self.__seenMessages = [];
  if (!self.__lctTestObserverInstalled) {
    self.__lctTestObserverInstalled = true;
    chrome.runtime.onMessage.addListener((msg) => {
      self.__seenMessages.push({ type: (msg && msg.type) || "", key: (msg && msg.key) || "" });
    });
  }
});

async function runScenario(query) {
  const page = await ctx.newPage();
  await sw.evaluate(() => { self.__seenMessages = []; });

  await page.goto("https://tvara.pages.dev/thanks" + query, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2000)); // document_idle + a poll round trip

  const seen = await sw.evaluate(() => self.__seenMessages || []);
  // Scoped to what content/purchase.js itself writes. It is the only element on
  // the page the extension touches.
  const statusDom = await page.evaluate(() => {
    const box = document.getElementById("auto-activate");
    return box ? box.outerHTML : "";
  });
  const url = page.url();

  await page.close();
  return { seen, statusDom, url };
}

/* ---------- 1. a licence key in the URL activates nothing ---------- */
{
  const planted = "TVARA_PLANTED_" + Math.random().toString(36).slice(2, 10);
  const { seen, statusDom } = await runScenario("?license_key=" + planted);
  t("a key planted in the URL never becomes an activation",
    !seen.some((m) => m.type === "license-activate"),
    JSON.stringify(seen));
  t("no message carries the planted value at all",
    !seen.some((m) => String(m.key).includes(planted)), JSON.stringify(seen));
  t("the status box never echoes the planted value", !statusDom.includes(planted),
    statusDom.slice(0, 200));
}

/* ---------- 2. markup in the URL reaches no sink ---------- */
{
  const marker = "XSSMARKER_" + Math.random().toString(36).slice(2, 10);
  const payload = `<img src=x onerror=alert('${marker}')>`;
  const { seen, statusDom } = await runScenario(
    "?license_key=" + encodeURIComponent(payload) + "&key=" + encodeURIComponent(payload));
  t("markup in the URL produces no activation",
    !seen.some((m) => m.type === "license-activate"), JSON.stringify(seen));
  t("the status box contains neither the marker nor the handler",
    !statusDom.includes(marker) && !statusDom.includes("onerror=alert"),
    statusDom.slice(0, 200));
}

/* ---------- 3. what the page DOES do ----------
   It asks the background whether a purchase is waiting. With none in flight the
   honest answer is "none", and the page has to say so rather than spin forever
   on a machine that never opened a checkout. */
{
  const { seen, statusDom } = await runScenario("");
  t("the page asks the background to finish the claim",
    seen.some((m) => m.type === "checkout-poll"), JSON.stringify(seen));
  t("with no purchase in flight the page says so and stops",
    /class="auto (idle|warn)"/.test(statusDom), statusDom.slice(0, 200));
}

await ctx.close();
done();
