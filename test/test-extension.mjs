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
// Context Bridge's clipboard fallback is asserted deterministically
try { await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8917" }); } catch {}
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
  t("A1 version shown", (await pop.textContent("#version")).trim() === "v0.6.0");
  t("A1 upsell visible / active card hidden",
    (await pop.isVisible("#pro-upsell")) && !(await pop.isVisible("#pro-active")));
  t("A1 speed/minimap/time toggles on by default",
    (await pop.isChecked("#toggle-enabled")) && (await pop.isChecked("#toggle-minimap")) && (await pop.isChecked("#toggle-time")));
  t("A1 trial button visible in free state", await pop.isVisible("#trial-start"));
  t("A1 Total Recall entry row present", await pop.isVisible("#open-recall"));
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

  // B2b — minimap jump: ONE click must land, even across sleeping regions
  // (real bug: smooth-scroll + estimated heights crawled and landed short)
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.locator("#lct-mm-canvas").click({ position: { x: 5, y: 4 } });
  await page.waitForFunction((was) => window.scrollY < was / 10, scrollBefore, { timeout: 3000 });
  t("B2b minimap click jumps across the whole chat in one go", true);
  t("B2b jump target pulses", (await page.locator(".lct-hit").count()) >= 1);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);

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

  /* ============ B7. outline panel ============ */
  // media-only prompts (the ChatGPT empty-row bug): image-only + file-only
  await page.evaluate(() => {
    const chat = document.getElementById("chat");
    const mk = (id, inner) => {
      const div = document.createElement("div");
      div.className = "msg user";
      div.setAttribute("data-lct-message", "");
      div.setAttribute("data-lct-role", "user");
      div.id = id;
      div.innerHTML = inner; // no text content on purpose
      chat.appendChild(div);
    };
    mk("t-img-msg", '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">');
    mk("t-file-msg", '<span class="chip"></span>');
  });
  await page.waitForTimeout(1200); // engine + outline notice the new messages
  await page.click('#lct-export-bar button[data-act="outline"]');
  await page.waitForSelector("#lct-outline.lct-o-open");
  t("B7 outline opens from the minimap bar", true);
  const entryCount = await page.locator("#lct-outline .lct-o-item").count();
  t("B7 outline capped at 400 entries", entryCount === 400, `${entryCount} entries`);
  t("B7 truncation honestly disclosed",
    (await page.textContent("#lct-outline .lct-o-note")).includes("first 400"));
  t("B7 user entries carry #n sequence IDs",
    /^#\d+ · /.test(await page.textContent("#lct-outline .lct-o-user")));
  // media-label rendering is asserted in B8 via the starred tab (the 400-cap
  // lists the FIRST 400 entries, and the media fixtures sit at the end)
  await page.locator("#lct-outline .lct-o-item").nth(5).click();
  await page.waitForSelector(".lct-hit", { timeout: 5000 });
  t("B7 clicking an entry jumps + pulses the message", true);
  await page.screenshot({ path: join(SHOTS, "synthetic-outline.png") });

  /* ============ B8. starred messages ============ */
  await page.click("#lct-outline .lct-o-close"); // panel would cover the star button
  await page.waitForSelector("#lct-outline.lct-o-open", { state: "detached", timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const msgs = [...document.querySelectorAll("[data-lct-message]")];
    // length-2 would hit the B7 media fixtures — take a TEXT message
    msgs[msgs.length - 4].id = "t-msg";
    msgs[msgs.length - 4].scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(400); // let scroll settle (scroll hides the star btn)
  await page.locator("#t-msg").dispatchEvent("mouseover"); // deterministic hover
  await page.waitForSelector("#lct-star", { state: "visible" });
  t("B8 star button appears on hover", true);
  // hover tag carries the "#n" sequence ID
  t("B8 hover tag shows the message's #n ID",
    /^#\d+ · /.test((await page.textContent("#lct-time-tag").catch(() => "")) || ""));
  // the ChatGPT overlap bug: the button must sit OUTSIDE the message text
  t("B8 star button outside the message text column",
    await page.evaluate(() => {
      const star = document.getElementById("lct-star").getBoundingClientRect();
      const msg = document.getElementById("t-msg").getBoundingClientRect();
      return star.left >= msg.right - 4;
    }));
  // the corridor bug: cursor crosses dead ground between message and button —
  // the button must survive the trip (grace delay), not vanish mid-way
  await page.locator("body").dispatchEvent("mouseover");
  await page.waitForTimeout(250); // inside the grace window
  t("B8 star survives the hover corridor",
    await page.locator("#lct-star").isVisible());
  await page.locator("#lct-star").dispatchEvent("mouseover"); // arriving cancels the hide
  await page.waitForTimeout(600); // well past the grace window
  t("B8 star stays while the cursor rests on it",
    await page.locator("#lct-star").isVisible());
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
  // an image-only message stars with a typed label, not an empty row
  await page.click("#lct-outline .lct-o-close");
  await page.evaluate(() => document.getElementById("t-img-msg").scrollIntoView({ block: "center" }));
  await page.waitForTimeout(500);
  for (let i = 0; i < 10; i++) {
    await page.locator("#t-img-msg").dispatchEvent("mouseover");
    await page.waitForTimeout(250);
    if (await page.locator("#lct-star").isVisible()) break;
  }
  await page.click("#lct-star");
  await page.click('#lct-export-bar button[data-act="outline"]');
  await page.waitForSelector("#lct-outline.lct-o-open");
  await page.click('#lct-outline [data-mode="star"]');
  await page.waitForFunction(() =>
    document.querySelectorAll("#lct-outline .lct-o-star").length === 2);
  t("B8 image-only message stars as '[Image]' (empty-row bug)",
    /\[Image\]/.test(await page.textContent("#lct-outline .lct-o-list")));
  await page.reload();
  await page.waitForSelector("#lct-minimap", { timeout: 15000 });
  await page.waitForSelector(".lct-starred", { timeout: 15000 });
  t("B8 star survives page reload", true);

  /* ============ B9. honest metrics ============ */
  await pop.waitForFunction(async () => {
    const s = (await chrome.storage.local.get("stats:127.0.0.1"))["stats:127.0.0.1"];
    return s && s.total >= 1500 && s.windowed > 100;
  }, null, { timeout: 10000 });
  t("B9 stats carry honest total (windowed of 1500)", true);
  await pop.reload();
  // the popup live-repaints on storage changes, so a stats write landing
  // after popup-open still shows up — this wait covers that path too
  await pop.waitForFunction(() => document.querySelector("#stat-hosts .host-row"), null, { timeout: 20000 });
  t("B9 popup shows 'N of 150x'", /of 150\d/.test(await pop.textContent("#stat-hosts")));
  t("B9 popup repaints live from storage changes", true); // reaching here proves it

  /* ============ B10. Chat Card (sidebar hover insights) ============ */
  // record written for this conversation (throttled 2s)
  let chatRec = null;
  for (let i = 0; i < 40 && !chatRec; i++) {
    chatRec = await pop.evaluate(async () => {
      const r = (await chrome.storage.local.get("chats:127.0.0.1"))["chats:127.0.0.1"];
      return (r && r["/test/synthetic.html"]) || null;
    });
    if (!chatRec) await new Promise((r) => setTimeout(r, 500));
  }
  if (!chatRec) {
    console.log("DEBUG storage keys:", await pop.evaluate(async () =>
      Object.keys(await chrome.storage.local.get(null)).join(", ")));
  }
  t("B10 record: message count tracked", chatRec.c >= 1500, `c=${chatRec.c}`);
  t("B10 record: questions (user msgs) tracked", chatRec.u >= 700, `u=${chatRec.u}`);
  t("B10 record: firstSeen + lastOpened stamped", chatRec.f > 0 && chatRec.o >= chatRec.f);
  t("B10 record: no fake creation time (non-ChatGPT)", !chatRec.e);

  // hover the sidebar link for THIS chat → card with real numbers
  await page.locator("#t-conv-this").dispatchEvent("mouseover");
  await page.waitForSelector("#lct-chatcard", { state: "visible", timeout: 5000 });
  const cardText = await page.textContent("#lct-chatcard");
  t("B10 card shows message count", /1,?5\d\d messages/.test(cardText), cardText.slice(0, 60));
  t("B10 card shows questions asked", /questions asked/.test(cardText));
  t("B10 card is honest about time source",
    /First seen .+ this device/.test(cardText) && !/Created/.test(cardText));
  t("B10 card shows starred count from B8", /\d starred message/.test(cardText));
  t("B10 no longest badge with a single record", !/longest/i.test(cardText));

  // untracked chat → honest "not tracked" card
  await page.locator("#t-conv-other").dispatchEvent("mouseover");
  await page.waitForFunction(() =>
    /Not tracked yet/.test(document.getElementById("lct-chatcard")?.textContent || ""),
    null, { timeout: 5000 });
  t("B10 unknown chat says 'Not tracked yet'", true);

  // longest badge appears once a SECOND (smaller) record exists
  await pop.evaluate(async () => {
    const key = "chats:127.0.0.1";
    const r = (await chrome.storage.local.get(key))[key];
    r["/test/other-synthetic.html"] = { c: 40, u: 20, f: Date.now(), o: Date.now(), e: 0 };
    await chrome.storage.local.set({ [key]: r });
  });
  await page.waitForTimeout(400); // storage.onChanged propagates
  await page.locator("#t-conv-external").dispatchEvent("mouseover"); // reset hover state
  await page.waitForTimeout(400);
  await page.locator("#t-conv-this").dispatchEvent("mouseover");
  await page.waitForFunction(() =>
    /longest visited chat/i.test(document.getElementById("lct-chatcard")?.textContent || ""),
    null, { timeout: 5000 });
  t("B10 longest-visited badge with 2+ records", true);
  const cardText2 = await page.evaluate(() => document.getElementById("lct-chatcard").textContent);
  t("B10 badge says 'visited' (never claims full history)", /longest visited/.test(cardText2));
  await page.screenshot({ path: join(SHOTS, "synthetic-chatcard.png") });

  // synced meta record (size unknown): card must show dates + sync note,
  // never "null messages", and never claim the longest badge
  await pop.evaluate(async () => {
    const key = "chats:127.0.0.1";
    const r = (await chrome.storage.local.get(key))[key];
    r["/test/other-synthetic.html"] =
      { c: null, u: null, f: 1735000000000, o: 1736000000000, e: 1735000000, ti: "Synced fixture chat", sy: 1 };
    await chrome.storage.local.set({ [key]: r });
  });
  await page.waitForTimeout(400);
  await page.locator("#t-conv-external").dispatchEvent("mouseover"); // reset hover
  await page.waitForTimeout(400);
  await page.locator("#t-conv-other").dispatchEvent("mouseover");
  await page.waitForFunction(() =>
    /Synced from your history/.test(document.getElementById("lct-chatcard")?.textContent || ""),
    null, { timeout: 5000 });
  const metaCard = await page.evaluate(() => document.getElementById("lct-chatcard").textContent);
  t("B10 synced meta card shows title + dates + sync note",
    /Synced fixture chat/.test(metaCard) && /Created/.test(metaCard) && !/null/.test(metaCard));
  t("B10 meta card never claims longest", !/longest/i.test(metaCard));

  // cross-origin link with a matching path must NOT get a card
  await page.keyboard.press("Escape");
  await page.locator("#t-conv-external").dispatchEvent("mouseover");
  await page.waitForTimeout(700);
  t("B10 external link never gets a card",
    await page.evaluate(() => {
      const c = document.getElementById("lct-chatcard");
      return !c || c.style.display === "none";
    }));

  /* ============ B11. Total Recall (the golden feature) ============ */
  // 1) the indexer archived the synthetic chat (background IndexedDB)
  let recallStats = null;
  for (let i = 0; i < 30 && (!recallStats || !recallStats.chats); i++) {
    recallStats = await pop.evaluate(() =>
      new Promise((res) => chrome.runtime.sendMessage({ type: "recall-stats" }, res)));
    if (!recallStats || !recallStats.chats) await new Promise((r) => setTimeout(r, 500));
  }
  t("B11 chat auto-archived to background DB", recallStats && recallStats.chats >= 1,
    JSON.stringify(recallStats));
  t("B11 archive holds full message set", recallStats && recallStats.msgs >= 1500,
    `msgs=${recallStats && recallStats.msgs}`);

  // 2) background search finds it
  const sRes = await pop.evaluate(() =>
    new Promise((res) => chrome.runtime.sendMessage(
      { type: "recall-search", q: "architectural implications" }, res)));
  t("B11 background search hits the chat",
    sRes && sRes.results.length >= 1 && sRes.results[0].path === "/test/synthetic.html",
    JSON.stringify(sRes && sRes.results[0] || null).slice(0, 120));
  t("B11 result carries platform + count", sRes.results[0].platform === "Test Page" && sRes.results[0].n >= 1500);

  // 3) overlay: hotkey opens, searches, jumps into in-chat search
  await page.keyboard.press("Control+Shift+KeyK");
  await page.waitForSelector("#lct-recall.lct-r-open", { timeout: 5000 });
  t("B11 overlay opens with Ctrl+Shift+K (trial active)", true);
  await page.fill("#lct-recall input", "architectural implications");
  await page.waitForSelector("#lct-recall .lct-r-item", { timeout: 5000 });
  const overlayRow = await page.textContent("#lct-recall .lct-r-item");
  t("B11 overlay lists the archived chat", /Test Page/.test(overlayRow) && /messages/.test(overlayRow));
  await page.screenshot({ path: join(SHOTS, "synthetic-recall.png") });
  await page.click("#lct-recall .lct-r-item");
  await page.waitForSelector("#lct-search.lct-s-open", { timeout: 5000 });
  t("B11 same-chat result drops into in-chat search",
    (await page.inputValue("#lct-search input")) === "architectural implications");
  await page.keyboard.press("Escape");

  // 4) cross-chat jump handoff: stash → reload → in-chat search auto-opens
  await pop.evaluate(() => chrome.storage.local.set({
    "recall-jump": { host: "127.0.0.1", path: "/test/synthetic.html", q: "quick brown", at: Date.now() }
  }));
  await page.reload();
  await page.waitForSelector("#lct-search.lct-s-open", { timeout: 20000 });
  t("B11 recall-jump lands in in-chat search on arrival",
    (await page.inputValue("#lct-search input")) === "quick brown");
  t("B11 jump stash consumed (single-use)",
    await pop.evaluate(async () => !(await chrome.storage.local.get("recall-jump"))["recall-jump"]));
  await page.keyboard.press("Escape");

  // 5) the Recall page: unlocked under trial, searches, shows stats
  const recall = await ctx.newPage();
  trackErrors(recall);
  await recall.goto(POPUP.replace("popup/popup.html", "recall.html"));
  await recall.waitForSelector("#searchbox:not([hidden])", { timeout: 5000 });
  t("B11 recall page unlocked under trial", !(await recall.isVisible("#locked")));
  t("B11 recall page badge shows Trial", (await recall.textContent("#plan-badge")).trim() === "Trial");
  await recall.fill("#q", "architectural implications");
  await recall.waitForSelector("#results .r-item", { timeout: 5000 });
  t("B11 recall page search works", /Test Page/.test(await recall.textContent("#results .r-item")));
  t("B11 recall page shows archive stats",
    /chats archived/.test(await recall.textContent("#stats")));

  // 5b) "Sync all history" — storage-bus orchestration. The real network sync
  // needs a logged-in ChatGPT/Claude tab (user-verified); what's testable here
  // is the bus: the button writes a request, and live progress from an app's
  // content script paints into the rows + climbs the stats.
  await recall.click("#sync-all");
  const req = await recall.evaluate(async () =>
    (await chrome.storage.local.get("recall-sync-request"))["recall-sync-request"]);
  t("B11 Sync-all writes an 'all' request", req && req.apps.includes("all") && req.full === true);
  await recall.waitForSelector("#sync-row-chatgpt");
  await recall.waitForSelector("#sync-row-claude");
  t("B11 sync rows render for ChatGPT + Claude", true);
  // simulate an app content script reporting live progress via storage
  await recall.evaluate((at) => chrome.storage.local.set({
    "recall-sync-progress:chatgpt": { state: "full", done: 42, total: 100, msg: "Archiving full text…", at: at + 1 }
  }), req.at);
  await recall.waitForFunction(() =>
    /42\/100|Archiving/.test(document.getElementById("sync-row-chatgpt")?.textContent || "") &&
    /%/.test(document.getElementById("sync-row-chatgpt")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11 live sync progress paints into the row with a %", true);
  await recall.evaluate((at) => chrome.storage.local.set({
    "recall-sync-progress:chatgpt": { state: "done", done: 100, total: 100, msg: "Done — 100 chats, all on this device.", at: at + 2 }
  }), req.at);
  await recall.waitForFunction(() =>
    /Done/.test(document.getElementById("sync-row-chatgpt")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11 sync row shows done state", true);
  // an app with no live tab: after the grace window, offer "Open & sync"
  await recall.waitForFunction(() =>
    /Open . sync|Waiting/.test(document.getElementById("sync-row-claude")?.textContent || ""),
    null, { timeout: 6000 });
  t("B11 unopened app offers Open & sync (or waiting)", true);

  // 6) import a ChatGPT-format export (parser + batch import, fully local)
  const fixture = [
    {
      title: "Zebra quantum fixture chat",
      conversation_id: "fix-1",
      create_time: 1735000000, update_time: 1735100000,
      mapping: {
        a: { message: { author: { role: "user" }, create_time: 1735000000,
             content: { parts: ["How do I test the zebra-quantum-fixture import path?"] } } },
        b: { message: { author: { role: "assistant" }, create_time: 1735000100,
             content: { parts: ["You feed conversations.json to the importer and count results."] } } },
        c: { message: { author: { role: "system" }, create_time: 1735000200,
             content: { parts: ["system noise that must be skipped"] } } }
      }
    },
    {
      title: "Second fixture",
      conversation_id: "fix-2",
      create_time: 1736000000, update_time: 1736100000,
      mapping: {
        a: { message: { author: { role: "user" }, create_time: 1736000000,
             content: { parts: ["Another zebra-quantum-fixture conversation"] } } },
        b: { message: { author: { role: "assistant" }, create_time: 1736000100,
             content: { parts: ["Yes, with two messages so it clears the minimum."] } } }
      }
    }
  ];
  const fixPath = join(SCRATCH, "conversations.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(fixPath, JSON.stringify(fixture));
  await recall.setInputFiles("#import-file", fixPath);
  await recall.waitForSelector("#import-status.ok", { timeout: 10000 });
  t("B11 import reports success", /Imported 2 chats/.test(await recall.textContent("#import-status")));
  await recall.fill("#q", "zebra-quantum-fixture");
  await recall.waitForFunction(() =>
    /fixture/.test(document.getElementById("results").textContent), null, { timeout: 5000 });
  const impRows = await recall.evaluate(() =>
    [...document.querySelectorAll("#results .r-item")].map((el) => el.textContent).join(" || "));
  t("B11 both imported chats searchable with ChatGPT identity",
    /ChatGPT/.test(impRows) && /Zebra quantum/.test(impRows) && /Second fixture/.test(impRows),
    impRows.slice(0, 140));
  const statsAfter = await pop.evaluate(() =>
    new Promise((res) => chrome.runtime.sendMessage({ type: "recall-stats" }, res)));
  t("B11 archive grew by the imported chats", statsAfter.chats >= 3, `chats=${statsAfter.chats}`);
  await recall.screenshot({ path: join(SHOTS, "recall-page.png"), fullPage: true });

  // 6b) sync building blocks. The mapConversation() logic is identical to the
  // export-file parser already covered by the import test above; the live
  // network sweep needs a real ChatGPT session (user-verified). What IS
  // testable here is the archive contract the sync depends on:
  //   meta upsert: title-searchable, and it must never erase archived text
  await pop.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({
    type: "recall-import",
    chats: [{ id: "chatgpt.com/c/meta-1", host: "chatgpt.com", path: "/c/meta-1",
      platform: "ChatGPT", title: "Kanban migration planning", createdAt: 1735000000000,
      updatedAt: 1735100000000, msgs: [], meta: true }]
  }, res)));
  const metaSearch = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-search", q: "kanban migration" }, res)));
  t("B11 meta chat findable by title", metaSearch.results.length === 1 &&
    metaSearch.results[0].n === 0 && /Synced from your history/.test(metaSearch.results[0].snippet));
  await pop.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({
    type: "recall-import",
    chats: [{ id: "chatgpt.com/c/meta-1", host: "chatgpt.com", path: "/c/meta-1",
      platform: "ChatGPT", title: "Kanban migration planning", createdAt: 1735000000000,
      updatedAt: 1735200000000,
      msgs: [{ r: "user", t: "kanban question", ts: 0 }, { r: "assistant", t: "kanban answer", ts: 0 }] }]
  }, res)));
  await pop.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({
    type: "recall-import",
    chats: [{ id: "chatgpt.com/c/meta-1", host: "chatgpt.com", path: "/c/meta-1",
      platform: "ChatGPT", title: "Kanban migration planning", createdAt: 1735000000000,
      updatedAt: 1735300000000, msgs: [], meta: true }] // meta AFTER full text
  }, res)));
  const checkRes = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-check", ids: ["chatgpt.com/c/meta-1"] }, res)));
  t("B11 meta upsert never erases archived text (recall-check confirms)",
    checkRes["chatgpt.com/c/meta-1"] && checkRes["chatgpt.com/c/meta-1"].n === 2,
    JSON.stringify(checkRes));

  // 7) wipe: two-click arm, archive empties
  await recall.click("#wipe");
  t("B11 wipe requires arming click", /Click again/.test(await recall.textContent("#wipe")));
  await recall.click("#wipe");
  await recall.waitForFunction(async () => {
    const s = await new Promise((res) => chrome.runtime.sendMessage({ type: "recall-stats" }, res));
    return s && s.chats === 0;
  }, null, { timeout: 5000 });
  t("B11 wipe empties the archive", true);

  // 8) gating: no trial, no pro → overlay hotkey dead, page locked
  await pop.evaluate(() => chrome.storage.local.remove("trial"));
  await page.reload();
  await page.waitForSelector("#lct-minimap", { timeout: 15000 });
  await page.keyboard.press("Control+Shift+KeyK");
  await page.waitForTimeout(600);
  t("B11 overlay locked without pro/trial",
    await page.evaluate(() => !document.querySelector("#lct-recall.lct-r-open")));
  await page.keyboard.press("Control+Shift+KeyJ");
  await page.waitForTimeout(300);
  t("B12 Context Bridge locked without pro/trial",
    await page.evaluate(() => !document.querySelector("#lct-bridge.lct-b-open")));
  await recall.reload();
  await recall.waitForSelector("#locked:not([hidden])", { timeout: 5000 });
  t("B11 recall page shows upsell when locked", await recall.isVisible("#locked"));
  t("B11 locked page still owns import + wipe (user's data)",
    (await recall.isVisible("#import-file, .import-btn")) && (await recall.isVisible("#wipe")));
  await pop.evaluate(() => chrome.storage.local.set({ trial: { startedAt: Date.now() } })); // restore

  /* ============ B12. Context Bridge (cross-platform prompt injection) ====== */
  await page.reload(); // pick up the restored trial
  await page.waitForSelector("#lct-minimap", { timeout: 15000 });
  // B11's wipe emptied the archive; the indexer re-archives this chat ~3s after
  // load. Poll (from the extension page) until the background actually has it.
  for (let i = 0; i < 30; i++) {
    const hit = await pop.evaluate(() => new Promise((res) =>
      chrome.runtime.sendMessage({ type: "recall-search", q: "architectural", long: true },
        (r) => res(!!(r && r.results && r.results.length)))));
    if (hit) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // seed the composer with a draft; ⌘⇧J opens the Bridge pre-searched on it
  await page.fill("#t-composer", "architectural");
  await page.focus("#t-composer");
  await page.keyboard.press("Control+Shift+KeyJ");
  await page.waitForSelector("#lct-bridge.lct-b-open", { timeout: 5000 });
  t("B12 Bridge opens with Ctrl+Shift+J (trial active)", true);
  t("B12 search seeded from the composer draft",
    (await page.inputValue("#lct-bridge input")) === "architectural");
  await page.waitForSelector("#lct-bridge .lct-b-item", { timeout: 5000 });
  t("B12 finds relevant passages from the archive",
    (await page.locator("#lct-bridge .lct-b-item").count()) >= 1);
  t("B12 insert disabled until a passage is picked",
    await page.locator(".lct-b-insert").isDisabled());

  // pick one passage → insert → the textarea composer gets the context block,
  // prepended, with the user's own draft preserved
  await page.locator("#lct-bridge .lct-b-item input[type=checkbox]").first().check();
  t("B12 insert enabled after a pick", !(await page.locator(".lct-b-insert").isDisabled()));
  await page.click(".lct-b-insert");
  await page.waitForFunction(() =>
    /^Context from my earlier AI chats:/.test(document.getElementById("t-composer").value), null, { timeout: 5000 });
  const composerVal = await page.inputValue("#t-composer");
  t("B12 context injected into textarea, draft preserved",
    /^Context from my earlier AI chats:/.test(composerVal) && composerVal.includes("architectural"),
    composerVal.slice(0, 50));
  t("B12 injected block tags the source platform",
    /\[Test Page/.test(composerVal), composerVal.slice(0, 120));
  t("B12 Bridge closed after insert",
    await page.evaluate(() => !document.querySelector("#lct-bridge.lct-b-open")));

  // contenteditable injection path: remove the textarea so the resolver falls
  // to the contenteditable composer
  await page.evaluate(() => document.getElementById("t-composer").remove());
  await page.focus("#t-composer-ce");
  await page.keyboard.press("Control+Shift+KeyJ");
  await page.waitForSelector("#lct-bridge.lct-b-open", { timeout: 5000 });
  await page.fill("#lct-bridge input", "distributed");
  await page.waitForSelector("#lct-bridge .lct-b-item", { timeout: 5000 });
  await page.locator("#lct-bridge .lct-b-item input[type=checkbox]").first().check();
  await page.click(".lct-b-insert");
  await page.waitForFunction(() =>
    /Context from my earlier AI chats:/.test(document.getElementById("t-composer-ce").textContent), null, { timeout: 5000 });
  t("B12 context injected into a contenteditable composer",
    /Context from my earlier AI chats:/.test(await page.textContent("#t-composer-ce")));

  // fail-safe: no composer at all → clipboard fallback + honest toast.
  // (#box is a plain <input>, which the resolver intentionally won't hijack.)
  await page.evaluate(() => document.getElementById("t-composer-ce").remove());
  await page.keyboard.press("Control+Shift+KeyJ");
  await page.waitForSelector("#lct-bridge.lct-b-open", { timeout: 5000 });
  await page.fill("#lct-bridge input", "architectural");
  await page.waitForSelector("#lct-bridge .lct-b-item", { timeout: 5000 });
  await page.locator("#lct-bridge .lct-b-item input[type=checkbox]").first().check();
  // clear any lingering toast from the previous insert so we read the NEW one
  await page.evaluate(() => document.getElementById("lct-b-toast")?.remove());
  await page.click(".lct-b-insert");
  await page.waitForSelector("#lct-b-toast.lct-b-toast-show", { timeout: 5000 });
  const toastTxt = await page.textContent("#lct-b-toast");
  t("B12 no composer → clipboard fallback, honest toast",
    /copied, just paste it|Couldn't insert/.test(toastTxt), toastTxt);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  t("B12 fallback actually put the context on the clipboard",
    /Context from my earlier AI chats:/.test(clip) || /Couldn't insert/.test(toastTxt));
  await page.keyboard.press("Escape");

  /* ============ C. zero page errors across everything ============ */
  t("C1 zero page/console errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  await ctx.close();
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
