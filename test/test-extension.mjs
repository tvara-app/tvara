#!/usr/bin/env node
/* Long Chat Toolkit — full browser test suite.
   Loads the real unpacked extension into Chromium, tests the popup UI state
   machine, license activation (incl. "key must never appear in the DOM"),
   storage persistence, and the speed engine on the 1,500-message torture page. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

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
    // "Failed to load resource" is Chrome's network log, not an app exception:
    // the static server has no favicon, and A9 serves deliberate 4xx/5xx bodies.
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()))
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
  t("A1 version shown", (await pop.textContent("#version")).trim() === "v0.7.0");
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
  const uiCache = await pop.evaluate(() => localStorage.getItem("lct-ui-v3") || "");
  t("A5 first-paint cache is present and holds NO key, NO full email",
    uiCache.length > 2 && !uiCache.includes("LCT1.") && !uiCache.includes("test@example.com"));

  // A5b — a query must never expand the fixed popup surface. Results replace
  // the archive-check row and are deliberately a compact preview.
  await pop.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({
    type: "recall-import",
    chats: [{
      id: "chatgpt.com/c/popup-layout", host: "chatgpt.com", path: "/c/popup-layout",
      platform: "ChatGPT", title: "Popup layout regression", n: 2,
      createdAt: Date.now(), updatedAt: Date.now(),
      msgs: [{ r: "user", t: "fixed popup layout" }, { r: "assistant", t: "The popup must never grow when results appear." }]
    }]
  }, resolve)));
  await pop.setViewportSize({ width: 380, height: 560 });
  await pop.fill("#recall-query", "popup");
  await pop.waitForSelector("#recall-results .recall-result");
  const popupMetrics = await pop.evaluate(() => ({
    rootScroll: document.documentElement.scrollHeight,
    rootClient: document.documentElement.clientHeight,
    bodyScroll: document.body.scrollHeight,
    bodyClient: document.body.clientHeight
  }));
  // The root is the real scroller and stays strict. body is allowed one pixel:
  // its height lands on a fractional boundary and rounds either way between
  // runs. A genuine regression here is tens of pixels, not one.
  t("A5b popup search keeps its fixed panel height",
    popupMetrics.rootScroll <= popupMetrics.rootClient &&
    popupMetrics.bodyScroll <= popupMetrics.bodyClient + 1,
    JSON.stringify(popupMetrics));
  await pop.fill("#recall-query", "");
  await pop.setViewportSize({ width: 900, height: 800 });

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


  /* ============ A9. Dodo activation + 5-device seats ============
     Every branch is driven through page.route — the real licence server is
     never contacted. Routes survive pop.reload(), which A9p-A9t rely on. */

  const dodo = { calls: [], queue: [] };
  const dodoReset = (...queue) => { dodo.calls.length = 0; dodo.queue = queue; };
  await pop.route("https://*.dodopayments.com/**", async (route) => {
    const req = route.request();
    dodo.calls.push({
      path: new URL(req.url()).pathname,
      method: req.method(),
      headers: req.headers(),
      body: req.postDataJSON()
    });
    const next = dodo.queue.shift();
    if (!next) return route.abort("failed");
    await route.fulfill({
      status: next.status,
      contentType: next.raw ? "text/html" : "application/json",
      body: next.raw || JSON.stringify(next.body || {})
    });
  });
  const DKEY = "DODO-TEST-KEY-0001";
  const OK201 = { status: 201, body: { id: "lki_new", license_key_id: "lk_1", customer: { email: "buyer@example.com" } } };
  const seedSeats = (seats, keyFp) => pop.evaluate(async ([seats, keyFp]) => {
    await chrome.storage.sync.set({ "lct-seats-v1": { version: 1, keyFp, seats } });
  }, [seats, keyFp]);
  const readSeats = () => pop.evaluate(async () =>
    (await chrome.storage.sync.get("lct-seats-v1"))["lct-seats-v1"]);
  const licenseOf = () => pop.evaluate(async () => (await chrome.storage.local.get("license")).license);
  const clearLicense = () => pop.evaluate(async () => {
    await chrome.storage.local.remove(["license", "lct-license-state-v1", "trial"]);
    await chrome.storage.sync.remove(["lct-seats-v1", "lct-device-id-v1"]);
  });
  const doActivate = async (key) => {
    await pop.fill("#license-input", key);
    await pop.click("#license-activate");
    await pop.waitForFunction(() => !document.getElementById("license-activate").disabled);
  };

  // A9a — an LCT1 key must never touch the network. The regression guard for
  // every customer who bought before Dodo existed.
  await clearLicense();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset();
  await doActivate(KEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  t("A9a LCT1 key activates with ZERO network calls", dodo.calls.length === 0, JSON.stringify(dodo.calls.map((c) => c.path)));
  await pop.evaluate(() => chrome.storage.local.remove("license"));

  // A9b — happy path
  await clearLicense();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset(OK201);
  await doActivate(DKEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  const licB = await licenseOf();
  const seatsB = await readSeats();
  t("A9b Dodo key activates to Pro", (await pop.textContent("#plan-badge")).trim() === "Pro");
  t("A9b masked email from the activation response",
    (await pop.textContent("#licensed-to")).includes("bu•••@example.com"));
  t("A9b licence record carries the activation receipt",
    licB && licB.kind === "dodo" && licB.instanceId === "lki_new" && licB.key === DKEY);
  t("A9b input cleared and key absent from the DOM", (await pop.inputValue("#license-input")) === "" &&
    !(await pop.evaluate(() => document.documentElement.outerHTML)).includes(DKEY));
  t("A9b exactly one seat registered, key never written to sync",
    Object.keys(seatsB.seats).length === 1 && !JSON.stringify(seatsB).includes(DKEY));

  // A9d — request hygiene: no cookies, and only the two documented fields
  const act = dodo.calls.find((c) => c.path === "/licenses/activate");
  t("A9d request carries no cookie header", act && !act.headers.cookie && !act.headers.Cookie);
  t("A9d body is exactly {license_key, name}",
    act && JSON.stringify(Object.keys(act.body).sort()) === '["license_key","name"]');
  const devId = await pop.evaluate(async () => (await chrome.storage.sync.get("lct-device-id-v1"))["lct-device-id-v1"].id);
  t("A9d instance name is a coarse label, not identity",
    act && act.body.name.length <= 60 && !act.body.name.includes("@") && !act.body.name.includes(devId));
  t("A9c deviceId was minted and stored in sync", /^[0-9a-f-]{20,}$/i.test(devId));

  // A9e — 422 evicts the OLDEST seat, retries exactly once, and succeeds
  await clearLicense();
  const fp = await pop.evaluate(async (k) => self.LCTDodo.fingerprint(k), DKEY);
  await pop.evaluate(async (id) => chrome.storage.sync.set({ "lct-device-id-v1": { id, mintedAt: 1 } }), devId);
  await seedSeats({
    old: { instanceId: "lki_old", label: "Old laptop", activatedAt: 1000 },
    mid: { instanceId: "lki_mid", label: "Tablet", activatedAt: 5000 },
    a: { instanceId: "lki_a", label: "A", activatedAt: 9000 },
    b: { instanceId: "lki_b", label: "B", activatedAt: 9500 },
    c: { instanceId: "lki_c", label: "C", activatedAt: 9900 }
  }, fp);
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset({ status: 422, body: { code: "LIMIT" } }, { status: 200, body: {} }, OK201);
  await doActivate(DKEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  const seatsE = await readSeats();
  t("A9e three calls, in order activate/deactivate/activate",
    dodo.calls.length === 3 &&
    dodo.calls.map((c) => c.path).join(",") === "/licenses/activate,/licenses/deactivate,/licenses/activate",
    JSON.stringify(dodo.calls.map((c) => c.path)));
  t("A9e the OLDEST seat was the one released",
    dodo.calls[1].body.license_key_instance_id === "lki_old");
  t("A9e oldest pruned, this device added, still 5 seats",
    !seatsE.seats.old && Object.keys(seatsE.seats).length === 5);
  t("A9e status names the freed device", (await pop.textContent("#license-status")).includes("Old laptop"));

  // A9f — a second 422 stops. Never a third activate, never a loop.
  await clearLicense();
  await pop.evaluate(async (id) => chrome.storage.sync.set({ "lct-device-id-v1": { id, mintedAt: 1 } }), devId);
  await seedSeats({ old: { instanceId: "lki_old", label: "Old laptop", activatedAt: 1000 } }, fp);
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset({ status: 422, body: {} }, { status: 200, body: {} }, { status: 422, body: {} });
  await doActivate(DKEY);
  await pop.waitForSelector("#device-manager:not([hidden])");
  t("A9f exactly 3 calls — eviction is attempted once, never looped", dodo.calls.length === 3,
    String(dodo.calls.length));
  t("A9f device screen shown, still Free", (await pop.textContent("#plan-badge")).trim() === "Free");
  t("A9f never says the key is invalid",
    !(await pop.textContent("#license-status")).toLowerCase().includes("invalid"));

  // A9g/A9h — a dead key and an unknown key read differently, and write nothing
  for (const [code, label, needle] of [[403, "A9g", "no longer active"], [404, "A9h", "couldn't find"]]) {
    await clearLicense();
    await pop.reload();
    await pop.waitForSelector("#pro-upsell:not([hidden])");
    dodoReset({ status: code, body: { code: "X" } });
    await doActivate(DKEY);
    const txt = (await pop.textContent("#license-status")).toLowerCase();
    t(`${label} HTTP ${code} has its own copy, never "invalid"`,
      txt.includes(needle) && !txt.includes("invalid"), txt);
    t(`${label} nothing written to storage on ${code}`, (await licenseOf()) === undefined);
  }

  // A9i — an outage must never disturb an activation the user already holds
  await clearLicense();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset(OK201);
  await doActivate(DKEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  // The UI hides the key field once Pro, so drive the layer directly: an
  // outage must report "network" and leave every stored byte alone.
  const licBefore = JSON.stringify(await licenseOf());
  const seatsBefore = JSON.stringify(await readSeats());
  dodoReset(); // queue empty → route.abort → network branch
  const outage = await pop.evaluate((k) => self.LCTDodo.activateWithSeats(k), DKEY);
  t("A9i an outage reports network, never a key problem",
    outage.ok === false && outage.branch === "network", JSON.stringify(outage));
  t("A9i an outage writes nothing and keeps Pro",
    JSON.stringify(await licenseOf()) === licBefore &&
    JSON.stringify(await readSeats()) === seatsBefore &&
    (await pop.textContent("#plan-badge")).trim() === "Pro");

  // A9j — the second Chrome on a synced profile re-uses its seat
  const fiveWithSelf = async () => {
    await pop.evaluate(async (id) => chrome.storage.sync.set({ "lct-device-id-v1": { id, mintedAt: 1 } }), devId);
    await seedSeats({
      [devId]: { instanceId: "lki_mine", label: "This one", activatedAt: 2000 },
      a: { instanceId: "lki_a", label: "A", activatedAt: 3000 }, b: { instanceId: "lki_b", label: "B", activatedAt: 4000 },
      c: { instanceId: "lki_c", label: "C", activatedAt: 5000 }, d: { instanceId: "lki_d", label: "D", activatedAt: 6000 }
    }, fp);
  };
  await pop.evaluate(() => chrome.storage.local.remove(["license", "lct-license-state-v1"]));
  await fiveWithSelf();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset({ status: 200, body: { valid: true } });
  await doActivate(DKEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  const licJ = await licenseOf();
  t("A9j re-paste on a synced profile validates instead of activating",
    dodo.calls.length === 1 && dodo.calls[0].path === "/licenses/validate" &&
    dodo.calls[0].body.license_key_instance_id === "lki_mine",
    JSON.stringify(dodo.calls.map((c) => c.path)));
  t("A9j no second seat burned", Object.keys((await readSeats()).seats).length === 5);
  t("A9j the existing instance is adopted", licJ && licJ.instanceId === "lki_mine");

  // A9k — a seat the server no longer recognises is replaced, not doubled
  await pop.evaluate(() => chrome.storage.local.remove(["license", "lct-license-state-v1"]));
  await fiveWithSelf();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset({ status: 200, body: { valid: false } }, OK201);
  await doActivate(DKEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  t("A9k stale seat validated, pruned, then re-activated",
    dodo.calls.length === 2 && (await readSeats()).seats[devId].instanceId === "lki_new" &&
    Object.keys((await readSeats()).seats).length === 5);

  // A9l — terminate: 200 prunes, and so does 403 (the registry was just stale)
  await pop.click("#license-devices");
  await pop.waitForSelector("#device-manager:not([hidden])");
  t("A9l device screen lists every seat and marks this one",
    (await pop.locator(".device-row").count()) === 5 &&
    (await pop.locator(".device-row.is-self").count()) === 1);
  // A9o — five rows must not widen the fixed 380px popup
  const dmBox = await pop.evaluate(() => ({
    w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth
  }));
  t("A9o five device rows do not widen the popup", dmBox.w <= dmBox.c + 1, JSON.stringify(dmBox));
  dodoReset({ status: 200, body: {} });
  await pop.locator(".device-row:not(.is-self) button").first().click();
  await pop.waitForFunction(() => document.querySelectorAll(".device-row").length === 4);
  t("A9l terminate on 200 prunes the row", Object.keys((await readSeats()).seats).length === 4);
  dodoReset({ status: 403, body: {} });
  await pop.locator(".device-row:not(.is-self) button").first().click();
  await pop.waitForFunction(() => document.querySelectorAll(".device-row").length === 3);
  t("A9l terminate on 403 also prunes — the network answer wins",
    Object.keys((await readSeats()).seats).length === 3);

  // A9m — releasing this device gives up Pro here
  dodoReset({ status: 200, body: {} });
  await pop.locator(".device-row.is-self button").click();
  await pop.waitForFunction(() => document.getElementById("plan-badge").textContent.trim() !== "Pro");
  t("A9m releasing this device drops to Free and frees the slot",
    (await licenseOf()) === undefined && !(await readSeats()).seats[devId]);

  // A9n — Remove with no reach still removes locally, and flags the held slot
  await clearLicense();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset(OK201);
  await doActivate(DKEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  dodoReset(); // abort → deactivate fails
  await pop.click("#license-remove");
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  const seatsN = await readSeats();
  const orphaned = Object.values(seatsN.seats).filter((x) => x.orphan === true);
  t("A9n Remove without reach still removes locally", (await licenseOf()) === undefined);
  t("A9n the un-released slot is flagged orphan, not silently lost",
    orphaned.length === 1, JSON.stringify(seatsN.seats));

  // A9p-A9t — lazy re-validation, fail-open
  const seedDodoPro = async (state) => {
    await pop.evaluate(async ([key, state]) => {
      await chrome.storage.local.set({
        license: { key, email: "buyer@example.com", plan: "pro", kind: "dodo", instanceId: "lki_1", activatedAt: Date.now() - 60 * 864e5 },
        "lct-license-state-v1": state
      });
    }, [DKEY, state]);
  };
  const stateOf = () => pop.evaluate(async () => (await chrome.storage.local.get("lct-license-state-v1"))["lct-license-state-v1"]);
  const NOW = Date.now();

  dodoReset({ status: 200, body: { valid: true } });
  await seedDodoPro({ lastValidatedAt: NOW - 2 * 864e5, lastAttemptAt: 0, strikes: [] });
  await pop.waitForSelector("#pro-active:not([hidden])");
  await pop.waitForTimeout(500);
  t("A9p no re-validation inside the 30-day window", dodo.calls.length === 0,
    JSON.stringify(dodo.calls.map((c) => c.path)));

  dodoReset({ status: 200, body: { valid: true } });
  await seedDodoPro({ lastValidatedAt: NOW - 31 * 864e5, lastAttemptAt: 0, strikes: [] });
  // Wait for the CALL, not for a storage side-effect: a state-based wait can be
  // satisfied by a straggler and then assert against a request that never came.
  for (let i = 0; i < 60 && dodo.calls.length === 0; i++) await pop.waitForTimeout(100);
  await pop.waitForFunction(async () => {
    const st = (await chrome.storage.local.get("lct-license-state-v1"))["lct-license-state-v1"] || {};
    return st.lastValidatedAt > Date.now() - 60000;
  });
  t("A9q re-validates at 30 days and stays Pro",
    dodo.calls.length === 1 && dodo.calls[0].path === "/licenses/validate" &&
    (await stateOf()).strikes.length === 0 &&
    (await pop.textContent("#plan-badge")).trim() === "Pro",
    JSON.stringify(dodo.calls.map((c) => c.path)));

  dodoReset({ status: 200, body: { valid: false } });
  await seedDodoPro({ lastValidatedAt: NOW - 31 * 864e5, lastAttemptAt: 0, strikes: [] });
  await pop.waitForFunction(async () =>
    (((await chrome.storage.local.get("lct-license-state-v1"))["lct-license-state-v1"] || {}).strikes || []).length === 1);
  t("A9r one refusal does not withdraw Pro",
    (await pop.textContent("#plan-badge")).trim() === "Pro" && (await licenseOf()).revokedAt === undefined);

  dodoReset({ status: 200, body: { valid: false } });
  await seedDodoPro({ lastValidatedAt: NOW - 31 * 864e5, lastAttemptAt: 0, strikes: [NOW - 40 * 864e5] });
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  const licS = await licenseOf();
  t("A9s two refusals 7+ days apart withdraw Pro",
    (await pop.textContent("#plan-badge")).trim() === "Free" && licS && typeof licS.revokedAt === "number");
  t("A9s the key is kept, not deleted — support can still fix it", licS.key === DKEY);
  t("A9s the copy says deactivated, never invalid",
    (await pop.textContent("#license-status")).toLowerCase().includes("deactivated"));

  // A9t — the fail-open contract, in all three failure shapes.
  // Driven directly rather than through storage.onChanged: the auto path races
  // its own writes across rounds, and what matters here is the rule, not the
  // trigger (A9q already proves load() fires it).
  await pop.evaluate(async ([key]) => chrome.storage.local.set({
    license: {
      key, email: "buyer@example.com", plan: "pro", kind: "dodo",
      instanceId: "lki_1", activatedAt: Date.now() - 60 * 864e5
    }
  }), [DKEY]);
  await pop.waitForSelector("#pro-active:not([hidden])");
  await pop.waitForTimeout(400);   // let the load()-triggered attempt drain

  for (const [label, queued] of [
    ["network abort", null],
    ["HTTP 500", { status: 500, body: {} }],
    ["an HTML body", { status: 200, raw: "<html>maintenance</html>" }]
  ]) {
    // writing only the state key does not trigger load() — it is not watched
    await pop.evaluate((st) => chrome.storage.local.set({ "lct-license-state-v1": st }),
      { lastValidatedAt: NOW - 31 * 864e5, lastAttemptAt: 0, strikes: [NOW - 40 * 864e5] });
    dodoReset(...(queued ? [queued] : []));
    const out = await pop.evaluate(async () => {
      const { license } = await chrome.storage.local.get("license");
      return self.LCTDodo.maybeRevalidate(license);
    });
    const st = await stateOf();
    t(`A9t ${label} never counts as a strike`,
      out.outcome === "inconclusive" &&
      st.strikes.length === 1 &&                       // the pre-existing strike, unchanged
      st.lastValidatedAt === NOW - 31 * 864e5 &&       // the 30-day clock does NOT restart
      st.lastAttemptAt > 0 &&                          // but the retry floor does
      (await licenseOf()).revokedAt === undefined &&
      (await pop.textContent("#plan-badge")).trim() === "Pro",
      JSON.stringify({ out, st }));
  }

  // A9x — nothing secret reaches the synchronous first-paint cache
  await clearLicense();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset(OK201);
  await doActivate(DKEY);
  await pop.waitForSelector("#pro-active:not([hidden])");
  await pop.reload();
  await pop.waitForSelector("#pro-active:not([hidden])");
  const cacheX = await pop.evaluate(() => localStorage.getItem("lct-ui-v3") || "");
  t("A9x first-paint cache holds no key, no instance id, no full email, no device id",
    !cacheX.includes(DKEY) && !cacheX.includes("lki_") &&
    !cacheX.includes("buyer@example.com") && !cacheX.includes(devId));

  // A3b — a typo must not be called invalid, and must not hit the network
  await clearLicense();
  await pop.reload();
  await pop.waitForSelector("#pro-upsell:not([hidden])");
  dodoReset();
  await pop.fill("#license-input", "hello");
  await pop.click("#license-activate");
  await pop.waitForSelector("#license-status.err");
  t("A3b a short typo is caught locally, with no network call",
    dodo.calls.length === 0 &&
    (await pop.textContent("#license-status")).includes("doesn't look like"));

  // leave the suite in the state the later sections expect: no licence, trial
  // running again (B11 asserts Total Recall is reachable under trial)
  await clearLicense();
  await pop.unroute("https://*.dodopayments.com/**");
  await pop.evaluate(() => chrome.storage.local.set({ trial: { startedAt: Date.now() } }));
  await pop.reload();
  await pop.waitForSelector("#trial-active:not([hidden])");

  /* ============ B. CONTENT — 1,500-message torture page ============ */
  const page = await ctx.newPage();
  trackErrors(page);
  await page.goto("http://127.0.0.1:8917/test/synthetic.html");
  await page.waitForSelector("#lct-minimap", { timeout: 15000 });
  t("B1 minimap injected", true);

  // Shortcuts now come from the browser commands API → background → storage
  // signal → the active (visible) tab. We can't press a browser-level command
  // headlessly, so we drive the exact relay the browser uses: make `page` the
  // visible tab, then write the signal from an extension page.
  const fireCmd = async (name) => {
    await page.bringToFront();
    await pop.evaluate((n) => chrome.storage.local.set({ "lct-cmd": { name: n, at: Date.now() } }), name);
  };

  await page.waitForFunction(() => document.querySelectorAll(".lct-cv").length > 100, null, { timeout: 15000 });
  const asleep = await page.evaluate(() => document.querySelectorAll(".lct-cv").length);
  t("B1 speed engine sleeping messages", asleep > 100, `${asleep} asleep`);

  // B1b — REGRESSION: the host app tears our nodes out on its own re-renders;
  // the minimap must re-inject itself on the next engine tick. (A content-sig
  // optimization once gated this and the minimap vanished on some chats.)
  await page.evaluate(() => document.getElementById("lct-minimap").remove());
  await page.evaluate(() => { // nudge the DOM so the engine's observer fires
    const c = document.getElementById("chat");
    const n = document.createTextNode(""); c.appendChild(n); n.remove();
  });
  await page.waitForSelector("#lct-minimap", { timeout: 8000 });
  t("B1b minimap re-injects after the host removes it", true);

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

  // B4 — in-chat search via the in-chat-search command
  await fireCmd("in-chat-search");
  await page.waitForSelector("#lct-search.lct-s-open", { timeout: 5000 });
  t("B4 search opens on the in-chat-search command", true);
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
  // the popup groups thousands (toLocaleString), so "1500" paints as "1,500"
  t("B9 popup shows 'N of 150x'", /of 1\D?50\d/.test(await pop.textContent("#stat-hosts")));
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

  // 3) overlay: command opens, searches, jumps into in-chat search
  await fireCmd("open-recall");
  await page.waitForSelector("#lct-recall.lct-r-open", { timeout: 5000 });
  t("B11 overlay opens via the open-recall command (trial active)", true);
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

  // A fresh install with a durable migration marker must block history checks
  // until the user restores or explicitly skips the encrypted archive.
  await recall.evaluate(() => chrome.storage.local.set({
    "lct-recall-install-v1": { at: Date.now() },
    "lct-recall-recovery-v1": {
      state: "restore-required", backup: { chats: 3, filename: "archive.lctbackup" }
    }
  }));
  await recall.reload();
  await recall.waitForFunction(() =>
    /Restore your archive before syncing/.test(document.getElementById("recovery-title")?.textContent || "") &&
    document.getElementById("sync-all")?.disabled,
    null, { timeout: 5000 });
  t("B11 recovery-required blocks automatic archive sync", true);
  await recall.evaluate(() => chrome.storage.local.set({
    "lct-recall-recovery-v1": { state: "ready" }
  }));
  await recall.reload();
  await recall.waitForSelector("#searchbox:not([hidden])", { timeout: 5000 });

  // 5b) Durable worker-owned sync state. The live network sweep needs real
  // provider sessions; this covers the state contract the UI observes without
  // kicking off a synthetic first-history request in a test profile.
  await recall.waitForSelector("#sync-row-chatgpt");
  await recall.waitForSelector("#sync-row-claude");
  t("B11 sync rows render for ChatGPT + Claude", true);
  const syncAt = Date.now();
  await recall.evaluate(async (at) => {
    const ids = ["chatgpt", "claude", "deepseek", "grok"];
    const checkpoints = Object.fromEntries(ids.map((id) => [id + ":test-account", {
      version: 2, platform: id, safeWatermark: at - 300000,
      completedAt: at, lastResult: "up-to-date", archived: 0
    }]));
    await chrome.storage.sync.set({
      "lct-recall-sync-ledger-v2": { version: 2, checkpoints },
      "lct-recall-sync-profile-v1": { version: 1, salt: "0123456789abcdef0123456789abcdef" }
    });
    await chrome.storage.local.set({
      "lct-recall-active-account-v1": Object.fromEntries(ids.map((id) => [id, id + ":test-account"])),
      "recall-sync-progress:chatgpt": {
        state: "syncing", phase: "syncing", done: 42, total: 100,
        msg: "Capturing 42 of 100 new chats…", at: at + 1
      }
    });
  }, syncAt);
  await recall.waitForFunction(() =>
    /42\/100|Capturing/.test(document.getElementById("sync-row-chatgpt")?.textContent || "") &&
    /%/.test(document.getElementById("sync-row-chatgpt")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11 live sync progress paints into the row with a %", true);
  await recall.evaluate((at) => chrome.storage.local.set({
    "recall-sync-progress:chatgpt": {
      state: "done", phase: "up-to-date", done: 100, total: 100,
      msg: "Everything is already backed up", at: at + 2
    }
  }), syncAt);
  // A row states what it holds and when it last looked; the one verdict for the
  // whole archive is the headline (#sync-summary), so both are asserted here.
  await recall.waitForFunction(() =>
    /Up to date|chats archived/.test(document.getElementById("sync-row-chatgpt")?.textContent || ""),
    null, { timeout: 5000 });
  await recall.waitForFunction(() =>
    /Everything is already backed up/.test(document.getElementById("sync-summary")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11 empty delta reports everything already backed up", true);
  await pop.waitForFunction(() =>
    /Everything is already backed up/.test(document.getElementById("sync-status")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11 popup restores durable synchronized state without starting a sync", true);
  await recall.evaluate((at) => chrome.storage.local.set({
    "lct-recall-sync-run-v1": {
      id: "interrupted-run", state: "running", workerId: "a-previous-worker",
      startedAt: at, heartbeatAt: at, platforms: ["chatgpt", "claude"]
    }
  }), syncAt);
  const interrupted = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11 service-worker restart preserves the safe checkpoint and reports interruption",
    interrupted && interrupted.run?.state === "interrupted" &&
    // only the platform still mid-flight is paused…
    interrupted.platforms.claude.progress?.state === "interrupted" &&
    // …a platform that already finished keeps its backed-up state
    interrupted.platforms.chatgpt.progress?.state !== "interrupted" &&
    interrupted.platforms.chatgpt.checkpoint?.completedAt === syncAt,
    JSON.stringify({ run: interrupted?.run?.state,
                     chatgpt: interrupted?.platforms?.chatgpt?.progress?.state,
                     claude: interrupted?.platforms?.claude?.progress?.state }));
  /* ---- B11b. automatic background sync ---- */

  // The alarm is what wakes a terminated MV3 worker. Without it, "background
  // sync" would only ever mean "sync while a page happens to be open".
  const alarm = await recall.evaluate(() => chrome.alarms.get("lct-auto-sync"));
  t("B11b an auto-sync alarm is registered", !!alarm, JSON.stringify(alarm));
  t("B11b it repeats rather than firing once", alarm && alarm.periodInMinutes === 360,
    JSON.stringify(alarm));
  t("B11b the first tick is delayed, not on startup",
    alarm && alarm.scheduledTime > Date.now() + 60000, JSON.stringify(alarm));

  // The toggle must actually gate it — an automatic authenticated request is
  // the one thing a privacy-first extension may not do behind the user's back.
  await recall.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings || {}), autoSync: false } });
    await chrome.storage.local.remove("lct-recall-sync-run-v1");
  });
  const offTick = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-auto-tick" }, res)));
  const runAfterOff = await recall.evaluate(async () =>
    (await chrome.storage.local.get("lct-recall-sync-run-v1"))["lct-recall-sync-run-v1"]);
  t("B11b a tick with the setting off does nothing at all",
    offTick && offTick.status === "disabled" && runAfterOff === undefined,
    JSON.stringify({ offTick, runAfterOff }));

  // ...and with it on, a tick is exactly the manual button's code path.
  await recall.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings || {}), autoSync: true } });
  });
  const onTick = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-auto-tick" }, res)));
  t("B11b a tick with the setting on runs the same pass as the button",
    onTick && onTick.status !== "disabled", JSON.stringify(onTick));
  t("B11b the toggle reflects the stored setting",
    await recall.isChecked("#auto-sync"));

  // The percentage must describe the whole pass. Reporting one platform's
  // numbers made four providers look like they kept restarting at 0%.
  // No run record: a seeded one carries a foreign workerId, which normalizeRun
  // rightly treats as an interrupted pass and rewrites the progress rows.
  await recall.evaluate((at) => chrome.storage.local.set({
    "recall-sync-progress:chatgpt": { state: "syncing", phase: "syncing", done: 30, total: 100, msg: "Capturing…", at },
    "recall-sync-progress:claude": { state: "syncing", phase: "syncing", done: 10, total: 100, msg: "Capturing…", at }
  }), Date.now());
  const agg = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11b the percentage covers every platform in the pass",
    agg.summary.state === "syncing" && agg.summary.done === 40 && agg.summary.total === 200,
    JSON.stringify(agg.summary));
  t("B11b the message names the number of platforms, not just one",
    /2 platforms/.test(agg.summary.message), agg.summary.message);
  await recall.waitForFunction(() =>
    /20%/.test(document.getElementById("sync-summary")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11b the aggregate percentage is painted for the user", true);
  await recall.evaluate(() => chrome.storage.local.remove("lct-recall-sync-run-v1"));

  await recall.evaluate(() => chrome.storage.local.remove([
    "lct-recall-sync-run-v1", "recall-sync-progress:chatgpt", "recall-sync-progress:claude",
    "recall-sync-progress:deepseek", "recall-sync-progress:grok"
  ]));

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
  await recall.emulateMedia({ colorScheme: "dark" });
  await recall.screenshot({ path: join(SHOTS, "recall-page-dark.png"), fullPage: true });
  await recall.emulateMedia({ colorScheme: "light" });
  await recall.screenshot({ path: join(SHOTS, "recall-page-light.png"), fullPage: true });

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

  // 7) encrypted reinstall backup. It contains the archive plus compact
  // checkpoint ledger, but never the passphrase itself.
  const reinstallPassphrase = "test migration archive passphrase";
  await recall.fill("#backup-passphrase", reinstallPassphrase);
  await recall.fill("#backup-passphrase-confirm", reinstallPassphrase);
  const backupDownloadEvent = recall.waitForEvent("download");
  await recall.click("#create-backup");
  const backupDownload = await backupDownloadEvent;
  const backupPath = join(SCRATCH, "reinstall-archive.lctbackup");
  await backupDownload.saveAs(backupPath);
  await recall.waitForSelector("#backup-status.ok", { timeout: 20000 });
  t("B11 reinstall backup is encrypted and downloaded",
    /encrypted/.test(await recall.textContent("#backup-status")) && /\.lctbackup/.test(backupDownload.suggestedFilename()));

  // The encrypted envelope must validate before it changes any archive data.
  const corruptBackupPath = join(SCRATCH, "corrupt-reinstall-archive.lctbackup");
  writeFileSync(corruptBackupPath, "{not valid backup json");
  await recall.setInputFiles("#restore-file", corruptBackupPath);
  await recall.fill("#restore-passphrase", reinstallPassphrase);
  await recall.click("#restore-run");
  await recall.waitForSelector("#restore-status.err", { timeout: 20000 });
  t("B11 corrupted reinstall-backup envelope cannot change the archive",
    /not a valid|not supported/.test(await recall.textContent("#restore-status")));
  await recall.setInputFiles("#restore-file", backupPath);
  await recall.fill("#restore-passphrase", "definitely the wrong passphrase");
  await recall.click("#restore-run");
  await recall.waitForSelector("#restore-status.err", { timeout: 20000 });
  t("B11 wrong reinstall-backup passphrase cannot change the archive",
    /incorrect|changed/.test(await recall.textContent("#restore-status")));

  // 8) wipe then restore: this models the local-data half of an
  // uninstall/reinstall handoff while keeping the encrypted file external.
  await recall.click("#wipe");
  t("B11 wipe requires arming click", /Click again/.test(await recall.textContent("#wipe")));
  await recall.click("#wipe");
  await recall.waitForFunction(async () => {
    const s = await new Promise((res) => chrome.runtime.sendMessage({ type: "recall-stats" }, res));
    return s && s.chats === 0;
  }, null, { timeout: 5000 });
  t("B11 wipe empties the archive", true);
  await recall.fill("#restore-passphrase", reinstallPassphrase);
  await recall.click("#restore-run");
  await recall.waitForSelector("#restore-status.ok", { timeout: 30000 });
  await recall.waitForFunction(async () => {
    const s = await new Promise((res) => chrome.runtime.sendMessage({ type: "recall-stats" }, res));
    return s && s.chats >= 3;
  }, null, { timeout: 30000 });
  t("B11 encrypted reinstall backup restores the archive in batches", true);
  const restoredLedger = await recall.evaluate(async () =>
    (await chrome.storage.sync.get("lct-recall-sync-ledger-v2"))["lct-recall-sync-ledger-v2"]);
  t("B11 reinstall restore merges the durable gap checkpoint",
    restoredLedger && Object.keys(restoredLedger.checkpoints || {}).length >= 4);
  const restoredProfile = await recall.evaluate(async () =>
    (await chrome.storage.sync.get("lct-recall-sync-profile-v1"))["lct-recall-sync-profile-v1"]);
  t("B11 reinstall restore preserves the opaque account fingerprint salt",
    restoredProfile && restoredProfile.salt === "0123456789abcdef0123456789abcdef");
  await recall.evaluate(() => chrome.storage.local.set({
    "lct-recall-active-account-v1": {
      chatgpt: "chatgpt:different-account", claude: "claude:test-account",
      deepseek: "deepseek:test-account", grok: "grok:test-account"
    }
  }));
  const otherAccountStatus = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11 a different provider account never inherits another checkpoint",
    otherAccountStatus && otherAccountStatus.platforms.chatgpt.checkpoint === null);

  // 9) gating: no trial, no pro → commands don't open, and say why
  await pop.evaluate(() => chrome.storage.local.remove("trial"));
  await page.reload();
  await page.waitForSelector("#lct-minimap", { timeout: 15000 });
  await fireCmd("open-recall");
  await page.waitForFunction(() =>
    /Total Recall is a Pro feature/.test(document.getElementById("lct-note")?.textContent || ""),
    null, { timeout: 5000 }).catch(() => {});
  t("B11 overlay locked without pro/trial",
    await page.evaluate(() => !document.querySelector("#lct-recall.lct-r-open")));
  t("B11 locked open-recall explains why (not silent)",
    /Total Recall is a Pro feature/.test(await page.textContent("#lct-note").catch(() => "")),
    await page.textContent("#lct-note").catch(() => "NO NOTE"));
  await fireCmd("open-bridge");
  await page.waitForFunction(() =>
    /Context Bridge is a Pro feature/.test(document.getElementById("lct-note")?.textContent || ""),
    null, { timeout: 5000 }).catch(() => {});
  t("B12 Context Bridge locked without pro/trial",
    await page.evaluate(() => !document.querySelector("#lct-bridge.lct-b-open")));
  t("B12 locked command explains why (not a silent no-op)",
    /Context Bridge is a Pro feature/.test(await page.textContent("#lct-note").catch(() => "")));
  await recall.reload();
  await recall.waitForSelector("#core-locked:not([hidden])", { timeout: 5000 });
  t("B11 recall page shows upsell when locked", await recall.isVisible("#core-locked"));
  // the file input itself is hidden by design — its label is the control
  t("B11 locked page still owns import + wipe (user's data)",
    (await recall.isVisible('label[for="import-file"]')) && (await recall.isVisible("#wipe")));
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

  // seed the composer with a draft; the Bridge opens pre-searched on it
  await page.fill("#t-composer", "architectural");
  await page.focus("#t-composer");
  await fireCmd("open-bridge");
  await page.waitForSelector("#lct-bridge.lct-b-open", { timeout: 5000 });
  t("B12 Bridge opens via the open-bridge command (trial active)", true);
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
  await fireCmd("open-bridge");
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
  await fireCmd("open-bridge");
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
