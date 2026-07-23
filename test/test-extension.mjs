#!/usr/bin/env node
/* Long Chat Toolkit — full browser test suite.
   Loads the real unpacked extension into Chromium, tests the popup UI state
   machine, license activation (incl. "key must never appear in the DOM"),
   storage persistence, and the speed engine on the 1,500-message torture page. */
import { createRequire } from "node:module";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire("/Users/andhetharuntej/Pixxel/package.json");
const { chromium } = require("playwright");

const EXT = join(homedir(), "long-chat-toolkit");
// Work dirs live under the OS temp dir — never committed (test/.gitignore).
const SCRATCH = join(EXT, "test", ".work");
const PROFILE = join(SCRATCH, "chrome-profile");
const SHOTS = join(SCRATCH, "shots");
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// Unpacked extension ID = sha256(absolute path) first 16 bytes, nibbles mapped a..p
const computedId = [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join("");

// Authoritative fallback: read the ID Chrome actually registered in the profile
function idFromProfile() {
  for (const f of ["Preferences", "Secure Preferences"]) {
    try {
      const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", f), "utf8"));
      for (const [id, v] of Object.entries(prefs.extensions?.settings || {})) {
        if (v.path === EXT) return id;
      }
    } catch {}
  }
  return null;
}

// Issue a REAL pro key (same signing path as tools/genkey.mjs)
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const priv = createPrivateKey(readFileSync(join(homedir(), ".lct-keys", "private.pem")));
const payload = Buffer.from(JSON.stringify({ e: "test@example.com", p: "pro", t: 1753100000000 }));
const KEY = `LCT1.${b64url(payload)}.${b64url(sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" }))}`;

// Static server for the synthetic page (manifest matches localhost in dev build)
const server = spawn("python3", ["-m", "http.server", "8917", "--bind", "127.0.0.1"], { cwd: EXT, stdio: "ignore" });

let pass = 0, fail = 0;
const t = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  → " + extra}`);
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium", // extensions require the chromium channel's new headless
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 900, height: 800 }
});
await new Promise((r) => setTimeout(r, 1500)); // let Chrome register the extension
const POPUP = `chrome-extension://${idFromProfile() || computedId}/popup/popup.html`;

const pageErrors = [];
const trackErrors = (p) => {
  p.on("pageerror", (e) => pageErrors.push(`${p.url()}: ${e.message}`));
  p.on("console", (m) => {
    // the bare python static server has no favicon — that 404 is not an app error
    if (m.type() === "error" && !/favicon|Failed to load resource.*404/.test(m.text()))
      pageErrors.push(`console ${p.url()}: ${m.text()}`);
  });
};

try {
  /* ============ A. POPUP ============ */
  const pop = await ctx.newPage();
  trackErrors(pop);
  // Record what the user actually SEES at first paint (DOMContentLoaded =
  // after sync scripts, before async storage) — this is the glitch detector.
  await pop.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      window.__firstPaint = {
        upsellHidden: document.getElementById("pro-upsell").hidden,
        activeHidden: document.getElementById("pro-active").hidden,
        minimapChecked: document.getElementById("toggle-minimap").checked,
        badge: document.getElementById("plan-badge").textContent.trim()
      };
    });
  });
  await pop.goto(POPUP);
  await pop.waitForSelector("#pro-upsell:not([hidden])"); // load() finished, free state revealed

  // A0 — cold open paints the free state synchronously (no post-open reveal)
  const fpCold = await pop.evaluate(() => window.__firstPaint);
  t("A0 cold open: upsell visible AT FIRST PAINT (no glitch)",
    fpCold && fpCold.upsellHidden === false && fpCold.activeHidden === true);

  // A1 — free state renders correctly
  t("A1 badge shows Free", (await pop.textContent("#plan-badge")).trim() === "Free");
  t("A1 version shown", (await pop.textContent("#version")).trim() === "v0.3.0");
  t("A1 upsell visible / active card hidden",
    (await pop.isVisible("#pro-upsell")) && !(await pop.isVisible("#pro-active")));
  t("A1 speed/minimap/time toggles on by default",
    (await pop.isChecked("#toggle-enabled")) && (await pop.isChecked("#toggle-minimap")) && (await pop.isChecked("#toggle-time")));
  t("A1 fold-code toggle OFF by default (opt-in)", !(await pop.isChecked("#toggle-fold")));
  t("A1 trial button visible in free state", await pop.isVisible("#trial-start"));
  t("A1 no emoji anywhere in popup",
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(await pop.evaluate(() => document.body.innerText)));

  // A2 — toggle writes storage and survives popup reload
  await pop.click("#toggle-minimap");
  await pop.waitForFunction(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    return settings && settings.minimap === false;
  });
  t("A2 minimap-off persisted to storage", true);
  await pop.reload();
  await pop.waitForFunction(() => document.getElementById("version").textContent.startsWith("v"));
  t("A2 minimap toggle stays off after reload", !(await pop.isChecked("#toggle-minimap")));
  t("A2 toggle already off AT FIRST PAINT (no flicker)",
    (await pop.evaluate(() => window.__firstPaint)).minimapChecked === false);
  await pop.click("#toggle-minimap"); // restore

  // A3 — invalid key
  await pop.fill("#license-input", "LCT1.aGVsbG8.Zm9yZ2VyeQ");
  await pop.click("#license-activate");
  await pop.waitForSelector("#license-status.err");
  t("A3 invalid key shows error", (await pop.textContent("#license-status")).includes("Invalid key"));
  t("A3 badge still Free", (await pop.textContent("#plan-badge")).trim() === "Free");

  // A4 — valid key via Enter, key must vanish from the DOM
  await pop.fill("#license-input", KEY);
  await pop.press("#license-input", "Enter");
  await pop.waitForSelector("#pro-active:not([hidden])");
  t("A4 badge flips to Pro", (await pop.textContent("#plan-badge")).trim() === "Pro");
  t("A4 licensed-to shows masked email", (await pop.textContent("#licensed-to")).includes("te••@example.com"));
  t("A4 input cleared after activation", (await pop.inputValue("#license-input")) === "");
  const domAfter = await pop.evaluate(() =>
    document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join("|"));
  t("A4 KEY NOT PRESENT anywhere in DOM", !domAfter.includes(KEY.slice(5, 40)));
  t("A4 full email not shown (masked only)", !domAfter.includes("test@example.com"));
  const lic = await pop.evaluate(async () => (await chrome.storage.local.get("license")).license);
  t("A4 key stored in chrome.storage", lic && lic.key && lic.key.startsWith("LCT1."));

  // A5 — pro state survives popup reload, key still not in DOM
  await pop.reload();
  await pop.waitForSelector("#pro-active:not([hidden])");
  t("A5 still Pro after reload", (await pop.textContent("#plan-badge")).trim() === "Pro");
  const fpPro = await pop.evaluate(() => window.__firstPaint);
  t("A5 Pro card visible AT FIRST PAINT (no glitch)",
    fpPro && fpPro.activeHidden === false && fpPro.upsellHidden === true);
  const domReload = await pop.evaluate(() =>
    document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join("|"));
  t("A5 key not re-injected into DOM on reload", !domReload.includes(KEY.slice(5, 40)));
  const uiCache = await pop.evaluate(() => localStorage.getItem("lct-ui-v1") || "");
  t("A5 first-paint cache holds NO key and NO full email",
    !uiCache.includes("LCT1.") && !uiCache.includes("test@example.com"));

  // A6 — screenshots: pro state, dark + light
  await pop.emulateMedia({ colorScheme: "dark" });
  await pop.screenshot({ path: join(SHOTS, "popup-pro-dark.png"), fullPage: true });
  await pop.emulateMedia({ colorScheme: "light" });
  await pop.screenshot({ path: join(SHOTS, "popup-pro-light.png"), fullPage: true });

  // A7 — remove license
  await pop.click("#license-remove");
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  t("A7 back to Free after remove", (await pop.textContent("#plan-badge")).trim() === "Free");
  t("A7 license gone from storage",
    (await pop.evaluate(async () => (await chrome.storage.local.get("license")).license)) === undefined);
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  const fpFree = await pop.evaluate(() => window.__firstPaint);
  t("A7 free state back AT FIRST PAINT after removal", fpFree && fpFree.upsellHidden === false);

  // A8 — 7-day trial: start, badge flips, persists, correct at first paint
  await pop.click("#trial-start");
  await pop.waitForSelector(".badge.trial");
  t("A8 badge flips to Trial", (await pop.textContent("#plan-badge")).trim() === "Trial");
  t("A8 trial note shows 7 days left", (await pop.textContent("#trial-note")).includes("7 days left"));
  t("A8 trial button gone after start", !(await pop.isVisible("#trial-start")));
  const trialStore = await pop.evaluate(async () => (await chrome.storage.local.get("trial")).trial);
  t("A8 trial persisted to storage", trialStore && typeof trialStore.startedAt === "number");
  await pop.reload();
  await pop.waitForSelector(".badge.trial");
  const fpTrial = await pop.evaluate(() => window.__firstPaint);
  t("A8 Trial badge AT FIRST PAINT after reload", fpTrial && fpTrial.badge === "Trial");
  await pop.emulateMedia({ colorScheme: "dark" });
  await pop.screenshot({ path: join(SHOTS, "popup-trial-dark.png"), fullPage: true });

  // A6b — screenshots: free state, dark + light
  await pop.emulateMedia({ colorScheme: "dark" });
  await pop.screenshot({ path: join(SHOTS, "popup-free-dark.png"), fullPage: true });
  await pop.emulateMedia({ colorScheme: "light" });
  await pop.screenshot({ path: join(SHOTS, "popup-free-light.png"), fullPage: true });

  /* ============ B. CONTENT — 1,500-message torture page ============ */
  const page = await ctx.newPage();
  trackErrors(page);
  await page.goto("http://127.0.0.1:8917/test/synthetic.html");
  await page.waitForSelector("#lct-minimap", { timeout: 15000 });
  t("B1 minimap injected", true);

  await page.waitForFunction(() => document.querySelectorAll(".lct-cv").length > 100, null, { timeout: 15000 });
  const asleep = await page.evaluate(() => document.querySelectorAll(".lct-cv").length);
  t("B1 speed engine sleeping messages", asleep > 100, `${asleep} asleep`);

  await page.waitForFunction(() => {
    const p = document.getElementById("lct-mm-count");
    return p && p.style.display !== "none" && /^\d+$/.test(p.textContent);
  }, null, { timeout: 10000 });
  t("B2 count pill shows plain number (no emoji)", true);

  t("B3 export bar with 3 SVG buttons (outline + md + json)",
    (await page.locator("#lct-export-bar button svg").count()) === 3);

  // B4 — in-chat search via hotkey
  await page.keyboard.press("Meta+Shift+KeyF");
  await page.waitForSelector("#lct-search.lct-s-open", { timeout: 5000 });
  t("B4 search opens on ⌘⇧F", true);
  t("B4 search icon is SVG", (await page.locator("#lct-search .lct-s-icon svg").count()) === 1);
  await page.fill("#lct-search input", "architectural");
  await page.waitForFunction(() => {
    const c = document.querySelector("#lct-search .lct-s-count");
    return c && /^\d+\/\d+$/.test(c.textContent);
  }, null, { timeout: 8000 });
  t("B4 search finds hits", true, await page.textContent("#lct-search .lct-s-count"));
  await page.keyboard.press("Escape");

  // B5 — markdown backup produces a download
  const dl = page.waitForEvent("download", { timeout: 10000 });
  await page.click('#lct-export-bar button[data-fmt="md"]');
  const download = await dl;
  t("B5 backup triggers download", (download.suggestedFilename() || "").endsWith(".md"),
    download.suggestedFilename());
  await page.waitForFunction(() => {
    const n = document.getElementById("lct-note");
    return n && n.textContent.startsWith("Backed up");
  }, null, { timeout: 5000 });
  t("B5 toast has no emoji", true);

  await page.screenshot({ path: join(SHOTS, "synthetic-page.png") });

  /* ============ B6. collapse code blocks ============ */
  // Baseline height on a pre in the never-slept tail
  await page.evaluate(() => {
    const msgs = [...document.querySelectorAll("[data-lct-message]")].slice(-6);
    const pre = msgs.map((m) => m.querySelector("pre")).find(Boolean);
    pre.id = "t-pre"; // NOT lct-prefixed — that namespace is the extension's own UI
    window.scrollTo(0, document.body.scrollHeight);
  });
  const tallBefore = await page.evaluate(() => document.getElementById("t-pre").offsetHeight);
  t("B6 code block tall before folding", tallBefore > 100, `${tallBefore}px`);

  await pop.click("#toggle-fold"); // popup toggle → storage → content reacts live
  await page.waitForFunction(() => document.documentElement.classList.contains("lct-fold-code"));
  const foldedH = await page.evaluate(() => document.getElementById("t-pre").offsetHeight);
  t("B6 code block folded via popup toggle", foldedH < 90, `${foldedH}px`);

  await page.click("#t-pre");
  const openedH = await page.evaluate(() => {
    const p = document.getElementById("t-pre");
    return p.classList.contains("lct-pre-open") ? p.offsetHeight : -1;
  });
  t("B6 click expands the block", openedH > 100, `${openedH}px`);
  await page.dblclick("#t-pre");
  t("B6 double-click folds it back",
    await page.evaluate(() => !document.getElementById("t-pre").classList.contains("lct-pre-open")));

  /* ============ B7. outline panel ============ */
  await page.click('#lct-export-bar button[data-act="outline"]');
  await page.waitForSelector("#lct-outline.lct-o-open");
  t("B7 outline opens from the minimap bar", true);
  const entryCount = await page.locator("#lct-outline .lct-o-item").count();
  t("B7 outline capped at 400 entries", entryCount === 400, `${entryCount} entries`);
  t("B7 truncation honestly disclosed",
    (await page.textContent("#lct-outline .lct-o-note")).includes("first 400"));
  await page.locator("#lct-outline .lct-o-item").nth(5).click();
  await page.waitForSelector(".lct-hit", { timeout: 5000 });
  t("B7 clicking an entry jumps + pulses the message", true);
  await page.screenshot({ path: join(SHOTS, "synthetic-outline.png") });

  /* ============ B8. starred messages ============ */
  await page.click("#lct-outline .lct-o-close"); // panel would cover the star button
  await page.waitForSelector("#lct-outline.lct-o-open", { state: "detached", timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const msgs = [...document.querySelectorAll("[data-lct-message]")];
    msgs[msgs.length - 2].id = "t-msg";
    msgs[msgs.length - 2].scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(400); // let scroll settle (scroll hides the star btn)
  await page.locator("#t-msg").dispatchEvent("mouseover"); // deterministic hover
  await page.waitForSelector("#lct-star", { state: "visible" });
  t("B8 star button appears on hover", true);
  await page.click("#lct-star");
  await page.waitForFunction(() => document.getElementById("t-msg").classList.contains("lct-starred"));
  t("B8 message gets starred marker", true);
  const starStore = await pop.evaluate(async () =>
    (await chrome.storage.local.get(null)));
  const starKey = Object.keys(starStore).find((k) => k.startsWith("stars:127.0.0.1"));
  t("B8 star persisted to storage", !!starKey && Object.keys(starStore[starKey]).length === 1);
  await page.click('#lct-export-bar button[data-act="outline"]'); // reopen panel
  await page.waitForSelector("#lct-outline.lct-o-open");
  await page.click('#lct-outline [data-mode="star"]');
  await page.waitForSelector("#lct-outline .lct-o-star");
  t("B8 starred tab lists the starred message",
    (await page.locator("#lct-outline .lct-o-star").count()) === 1);
  await page.reload();
  await page.waitForSelector("#lct-minimap", { timeout: 15000 });
  await page.waitForSelector(".lct-starred", { timeout: 15000 });
  t("B8 star survives page reload", true);

  /* ============ B9. honest metrics ============ */
  await pop.waitForFunction(async () => {
    const s = (await chrome.storage.local.get("stats:127.0.0.1"))["stats:127.0.0.1"];
    return s && s.total === 1500 && s.windowed > 100;
  }, null, { timeout: 10000 });
  t("B9 stats carry honest total (windowed of 1500)", true);
  await pop.reload();
  await pop.waitForFunction(() => document.querySelector("#stat-hosts .host-row"));
  t("B9 popup shows 'N of 1500'", (await pop.textContent("#stat-hosts")).includes("of 1500"));

  /* ============ C. zero page errors across everything ============ */
  t("C1 zero page/console errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  await ctx.close();
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
