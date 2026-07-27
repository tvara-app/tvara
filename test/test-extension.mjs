#!/usr/bin/env node
/* Long Chat Toolkit — full browser test suite.
   Loads the real unpacked extension into Chromium, tests the popup UI state
   machine, license activation (incl. "key must never appear in the DOM"),
   storage persistence, and the speed engine on the 1,500-message torture page. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";

const SRC = join(homedir(), "long-chat-toolkit");
// Work dirs live under the OS temp dir — never committed (test/.gitignore).
const SCRATCH = join(SRC, "test", ".work");
const PROFILE = join(SCRATCH, "chrome-profile");
const SHOTS = join(SCRATCH, "shots");
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

/* Chromium loads a mirror of the repo, not the repo itself: activation can
   only be tested with a key the extension trusts, and the shipped public key's
   private half is deliberately not on any dev machine. The mirror differs from
   what ships by exactly one line — PUBLIC_KEY_B64 — so every other byte under
   test is the real thing. */
const EXT = join(SCRATCH, "ext");
rmSync(EXT, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });
const sync = spawnSync("rsync", [
  "-a", "--exclude", ".git", "--exclude", "node_modules", "--exclude", "test/.work",
  SRC + "/", EXT + "/"
]);
if (sync.status !== 0) { console.error("FATAL: could not mirror the extension"); process.exit(1); }

const { publicKey, privateKey: priv } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const licPath = join(EXT, "lib", "license.js");
const patched = readFileSync(licPath, "utf8")
  .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`);
if (!patched.includes(TEST_PUB)) {
  console.error("FATAL: PUBLIC_KEY_B64 not found in lib/license.js — test key not installed");
  process.exit(1);
}
writeFileSync(licPath, patched);

// Same treatment for the entitlement verifier, plus a test issuer origin so
// page.route can intercept it. Both must carry the SAME key: a token verifies
// against one file, an LCT1 licence against the other.
const entPath = join(EXT, "lib", "entitlement.js");
const TEST_ISSUER = "https://entitlement.test.invalid";
// Compute the integrity hash for the test public key so the key-integrity
// guard inside entitlement.js passes with the swapped key.
const testKeyIntegrity = [...createHash("sha256").update(TEST_PUB).digest().subarray(0, 16)]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
let entPatched = readFileSync(entPath, "utf8")
  .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`)
  .replace(/const ISSUER = "[^"]*";/, `const ISSUER = "${TEST_ISSUER}";`)
  .replace(/const _KEY_INTEGRITY = "[^"]*";/, `const _KEY_INTEGRITY = "${testKeyIntegrity}";`);
if (!entPatched.includes(TEST_PUB) || !entPatched.includes(TEST_ISSUER)) {
  console.error("FATAL: could not patch lib/entitlement.js for tests");
  process.exit(1);
}
writeFileSync(entPath, entPatched);

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

// Issue a pro key the mirror trusts (same signing path as tools/genkey.mjs)
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const payload = Buffer.from(JSON.stringify({ e: "test@example.com", p: "pro", t: 1753100000000 }));
const KEY = `LCT1.${b64url(payload)}.${b64url(sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" }))}`;

// Static server for the synthetic page (manifest matches localhost in dev build)
const server = spawn("python3", ["-m", "http.server", "8917", "--bind", "127.0.0.1"], { cwd: EXT, stdio: "ignore" });

let pass = 0, fail = 0;
const failed = []; // reprinted at the end: one FAIL in 180 lines scrolls past
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

// Scheduled backups are written by the service worker through chrome.downloads,
// which lands them here rather than in any page's download event.
const DOWNLOADS = join(SCRATCH, "downloads");
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium", // extensions require the chromium channel's new headless
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
         `--download-directory=${DOWNLOADS}`],
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
  const trialStore = await pop.evaluate(async () => ({
    local: (await chrome.storage.local.get("lct-trial-v2"))["lct-trial-v2"],
    sync: (await chrome.storage.sync.get("lct-trial-v2"))["lct-trial-v2"]
  }));
  t("A8 trial persisted to BOTH stores (sync survives a local wipe)",
    trialStore.local && typeof trialStore.local.startedAt === "number" &&
    trialStore.sync && typeof trialStore.sync.startedAt === "number");
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
  /* The entitlement issuer, signing with the same throwaway key the mirrored
     extension trusts. Mirrors the real Worker: bind to key + device, 90 days.
     `ent.mode` steers the branch a test wants. */
  const ent = { calls: [], mode: "ok" };
  const sha256Hex = async (value, bytes = 16) =>
    [...createHash("sha256").update(String(value)).digest().subarray(0, bytes)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64u = (buf) => Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  await pop.route(TEST_ISSUER + "/**", async (route) => {
    const body = route.request().postDataJSON() || {};
    ent.calls.push(body);
    if (ent.mode === "notfound") return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    if (ent.mode === "down")     return route.abort("failed");
    const now = Date.now();
    const claims = {
      v: 2, sub: await sha256Hex(body.license_key), dev: String(body.device || ""),
      plan: "pro", feat: ent.feat || ["archive.search", "archive.backup", "archive.restore"],
      email: "buyer@example.com", iat: now, exp: now + (ent.ttlMs ?? 90 * 864e5), jti: "t1"
    };
    const payload = Buffer.from(JSON.stringify(claims));
    const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ token: `LCT2.${b64u(payload)}.${b64u(sig)}`, exp: claims.exp })
    });
  });
  const entReset = (mode = "ok", over = {}) => {
    ent.calls.length = 0; ent.mode = mode;
    ent.feat = over.feat; ent.ttlMs = over.ttlMs;
  };

  const DKEY = "DODO-TEST-KEY-0001";
  const OK201 = { status: 201, body: { id: "lki_new", license_key_id: "lk_1", customer: { email: "buyer@example.com" } } };
  const seedSeats = (seats, keyFp) => pop.evaluate(async ([seats, keyFp]) => {
    await chrome.storage.sync.set({ "lct-seats-v1": { version: 1, keyFp, seats } });
  }, [seats, keyFp]);
  const readSeats = () => pop.evaluate(async () =>
    (await chrome.storage.sync.get("lct-seats-v1"))["lct-seats-v1"]);
  const licenseOf = () => pop.evaluate(async () => (await chrome.storage.local.get("license")).license);
  const clearLicense = () => pop.evaluate(async () => {
    await chrome.storage.local.remove(["license", "lct-license-state-v1", "trial",
      "lct-entitlement-v2", "lct-trial-v2", "lct-clock-hwm-v1"]);
    await chrome.storage.sync.remove(["lct-seats-v1", "lct-device-id-v1", "lct-trial-v2"]);
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
  /* Seeding a licence record alone is no longer worth Pro — that is the whole
     point of LCT2 (see E2 in test-license.mjs). A legitimately activated
     install also holds a signed token, so seed one, bound to this device. */
  const mintTokenFor = async (key, over = {}) => {
    const deviceId = await pop.evaluate(async () =>
      ((await chrome.storage.sync.get("lct-device-id-v1"))["lct-device-id-v1"] || {}).id || "");
    const now = Date.now();
    const claims = {
      v: 2, sub: await sha256Hex(key), dev: await sha256Hex(deviceId), plan: "pro",
      feat: ["archive.search", "archive.backup", "archive.restore"],
      email: "buyer@example.com", iat: now, exp: now + 90 * 864e5, jti: "seed", ...over
    };
    const payload = Buffer.from(JSON.stringify(claims));
    const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
    return `LCT2.${b64u(payload)}.${b64u(sig)}`;
  };

  const seedDodoPro = async (state) => {
    const token = await mintTokenFor(DKEY);
    await pop.evaluate(async ([key, state, token]) => {
      await chrome.storage.local.set({
        license: { key, email: "buyer@example.com", plan: "pro", kind: "dodo", instanceId: "lki_1", activatedAt: Date.now() - 60 * 864e5 },
        "lct-license-state-v1": state,
        "lct-entitlement-v2": { token, fetchedAt: Date.now(), lastAttemptAt: Date.now() }
      });
    }, [DKEY, state, token]);
  };
  const stateOf = () => pop.evaluate(async () => (await chrome.storage.local.get("lct-license-state-v1"))["lct-license-state-v1"]);

  /* A revalidation round is two steps — one request, then a state write built
     from the state it read BEFORE that request (lib/dodo.js maybeRevalidate).
     Seeding the next case in between lets the older write land on top of the
     new seed and carry lastValidatedAt forward, which gates the next round out
     for 30 days: no call, no strike, no downgrade, and A9s waits for a Free
     badge that can never arrive. Let the round finish before reseeding. */
  const settle = async () => {
    let calls = -1, attempt = -1;
    for (let i = 0; i < 60; i++) {
      const c = dodo.calls.length;
      const a = ((await stateOf()) || {}).lastAttemptAt || 0;
      if (c === calls && a === attempt) return;
      calls = c; attempt = a;
      await pop.waitForTimeout(150);
    }
  };
  const NOW = Date.now();

  await settle();
  dodoReset({ status: 200, body: { valid: true } });
  await seedDodoPro({ lastValidatedAt: NOW - 2 * 864e5, lastAttemptAt: 0, strikes: [] });
  await pop.waitForSelector("#pro-active:not([hidden])");
  await pop.waitForTimeout(500);
  t("A9p no re-validation inside the 30-day window", dodo.calls.length === 0,
    JSON.stringify(dodo.calls.map((c) => c.path)));

  await settle();
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

  await settle();
  dodoReset({ status: 200, body: { valid: false } });
  await seedDodoPro({ lastValidatedAt: NOW - 31 * 864e5, lastAttemptAt: 0, strikes: [] });
  await pop.waitForFunction(async () =>
    (((await chrome.storage.local.get("lct-license-state-v1"))["lct-license-state-v1"] || {}).strikes || []).length === 1);
  t("A9r one refusal does not withdraw Pro",
    (await pop.textContent("#plan-badge")).trim() === "Pro" && (await licenseOf()).revokedAt === undefined);

  await settle();
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
  await pop.evaluate(() => chrome.runtime.sendMessage({ type: "trial-start" }));
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

  // Let the jump above finish and its mark expire, then clear any remainder:
  // ".lct-hit" below must be THIS jump's target, not the first one still lit
  // further up the document.
  await page.waitForTimeout(1700);
  await page.evaluate(() =>
    document.querySelectorAll(".lct-hit").forEach((e) => e.classList.remove("lct-hit")));

  await page.hover("#lct-minimap");
  await page.waitForTimeout(300);
  const mmBox2 = await page.locator("#lct-mm-canvas").boundingBox();
  // Mid-chat, not the ends: block:"center" cannot centre a message the
  // scroller is already clamped against, so those tell us nothing about aim.
  const midY = mmBox2.y + Math.round(mmBox2.height * 0.40);

  /* B2b2 — REGRESSION: the landing must HOLD. Sleeping neighbours are
     contain-intrinsic-size guesses, and the browser used to wake them only
     AFTER the scroll landed — their real heights then shoved the target off
     centre, which is the land-wrong-then-snap the settle loop had to paper
     over. nav.js wakes the band before the first aim instead. */
  await page.mouse.click(mmBox2.x + 5, midY);
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const h = document.querySelector(".lct-hit");
    if (h) h.dataset.probeTarget = "1";
  });
  await page.waitForTimeout(1800);
  const offCentre = await page.evaluate(() => {
    const el = document.querySelector("[data-probe-target]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return Math.round(r.top + r.height / 2 - innerHeight / 2);
  });
  t("B2b2 the landing holds still after the neighbours render",
    offCentre !== null && Math.abs(offCentre) <= 20, `${offCentre}px off centre`);

  /* B2b3 — REGRESSION: jumping to a message whose pulse is still running must
     restart it. lct-hit is a one-shot animation, and re-adding a class the
     element already carries never restarts one — so the second jump landed with
     no visible mark at all. That is the "works sometimes" pulse. */
  const pulseAge = async () => page.evaluate(() => {
    const h = document.querySelector(".lct-hit");
    return h ? Math.round(h.getAnimations()[0]?.currentTime ?? -1) : -1;
  });
  await page.mouse.click(mmBox2.x + 5, midY);
  await page.waitForTimeout(600);
  const aged = await pulseAge();
  await page.mouse.click(mmBox2.x + 5, midY);
  await page.waitForTimeout(100);
  const fresh = await pulseAge();
  t("B2b3 re-jumping the same message restarts the pulse",
    aged > 300 && fresh >= 0 && fresh < aged, `${aged}ms → ${fresh}ms`);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);

  /* B2c0 — opening a long chat must be STILL. Walking a host's virtualizer to
     the first turn is sixty round trips of it yanking its own scroller to the
     top, and doing that unasked is indistinguishable from the page reloading
     itself under the reader. The backfill is opt-in for exactly this reason. */
  const quiet = await ctx.newPage();
  trackErrors(quiet);
  await quiet.goto("http://127.0.0.1:8917/test/virtual-history.html");
  await quiet.waitForSelector("#lct-minimap", { timeout: 20000 });
  const quietBefore = await quiet.evaluate(() => ({
    loads: window.__virtualHistory.loads,
    top: document.getElementById("virtual-scroller").scrollTop
  }));
  await quiet.waitForTimeout(3000);
  const quietAfter = await quiet.evaluate(() => ({
    loads: window.__virtualHistory.loads,
    top: document.getElementById("virtual-scroller").scrollTop,
    state: document.documentElement.dataset.lctHistoryState || "(never started)"
  }));
  t("B2c0 opening a long chat never hijacks the host scroller",
    quietAfter.loads === quietBefore.loads &&
    quietAfter.top === quietBefore.top &&
    quietAfter.state === "(never started)",
    JSON.stringify({ quietBefore, quietAfter }));
  await quiet.close();

  /* B2e — the provider seed. The host mounts only its recent tail, and walking
     its scroller to find the rest is what made opening a long chat feel like a
     page that could not sit still. Given the conversation's index up front, the
     map must be complete and readable with the page never moving at all. */
  const seeded = await ctx.newPage();
  trackErrors(seeded);
  await seeded.goto("http://127.0.0.1:8917/test/virtual-history.html?index=1&total=1500&page=25");
  await seeded.waitForSelector("#lct-minimap", { timeout: 20000 });
  const seedAt = Date.now();
  await seeded.waitForFunction(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "1500",
    null, { timeout: 6000 });
  const seedMs = Date.now() - seedAt;
  t("B2e the whole conversation is mapped from the index, not from scrolling",
    true, seedMs + "ms after the minimap appeared");
  t("B2e and it is there effectively at once", seedMs < 1500, seedMs + "ms");
  await seeded.evaluate(() => window.__virtualHistory.resetMotion());
  await seeded.waitForTimeout(2000);
  const seedStill = await seeded.evaluate(() => ({
    valuemax: document.getElementById("lct-mm-canvas").getAttribute("aria-valuemax"),
    mounted: document.querySelectorAll("[data-message-id]").length,
    loads: window.__virtualHistory.loads,
    framesAboveTop: window.__virtualHistory.motion.framesAboveTop,
    hist: document.documentElement.dataset.lctHistoryState || "(never started)"
  }));
  // The point of the whole design: a complete map while the host is still only
  // holding 25 rows, with its scroller never sent to the top even once.
  t("B2e the map is complete while the host still holds only its tail",
    seedStill.valuemax === "1500" && seedStill.mounted === 25, JSON.stringify(seedStill));
  t("B2e the host was never asked to page, and never yanked to the top",
    seedStill.loads === 0 && seedStill.framesAboveTop === 0 && seedStill.hist === "(never started)",
    JSON.stringify(seedStill));

  // A message the page has never rendered is still readable from the map.
  await seeded.hover("#lct-minimap");
  await seeded.waitForTimeout(400);
  const mmBox = await seeded.locator("#lct-mm-canvas").boundingBox();
  await seeded.mouse.move(mmBox.x + 5, mmBox.y + Math.round(mmBox.height * 0.08));
  await seeded.waitForTimeout(300);
  t("B2e hovering an unmounted tick shows the provider's own snippet",
    await seeded.evaluate(() => {
      const tip = document.getElementById("lct-mm-tooltip");
      return !!tip && tip.style.display === "block" && /Virtual history message \d+/.test(tip.textContent);
    }));

  // The map is the conversation, not the render window: recycling every mounted
  // row must not shrink it, and a new reply must extend it by exactly one.
  await seeded.evaluate(() => {
    document.querySelectorAll("[data-message-id]").forEach((el) => el.remove());
  });
  await seeded.waitForTimeout(900);
  t("B2e the seeded map survives the host recycling every row it had",
    (await seeded.getAttribute("#lct-mm-canvas", "aria-valuemax")) === "1500");
  await seeded.evaluate(() => {
    const el = document.createElement("article");
    el.className = "msg assistant";
    el.setAttribute("data-lct-message", "");
    el.setAttribute("data-lct-role", "assistant");
    el.setAttribute("data-message-id", "virtual-1501");
    el.textContent = "A reply that streamed in after we asked for the index.";
    document.getElementById("chat").appendChild(el);
  });
  await seeded.waitForFunction(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "1501",
    null, { timeout: 6000 });
  t("B2e a reply that arrives after the index extends the map by one", true);
  await seeded.close();

  /* B2g — clicking the top of the map. The rows for message #1 are simply not
     in the page, so no amount of interpolation reaches them: only the host's
     own upward paging does. That takes a moment, so the message itself opens
     immediately from the index while the navigation runs behind it. */
  const topClick = await ctx.newPage();
  trackErrors(topClick);
  await topClick.goto("http://127.0.0.1:8917/test/virtual-history.html?index=1&total=1500&page=25");
  await topClick.waitForFunction(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "1500",
    null, { timeout: 20000 });
  await topClick.hover("#lct-minimap");
  await topClick.waitForTimeout(400);
  const topBox = await topClick.locator("#lct-mm-canvas").boundingBox();
  await topClick.mouse.click(topBox.x + 5, topBox.y + 1);
  await topClick.waitForTimeout(300);
  const opened = await topClick.evaluate(() => ({
    open: !!document.querySelector("#lct-preview.lct-p-open"),
    title: document.querySelector(".lct-p-title")?.textContent || "",
    body: document.querySelector(".lct-p-body")?.textContent || "",
    pill: document.querySelector("#lct-seek.lct-seek-show")
      ? document.querySelector(".lct-seek-text").textContent : null,
    state: document.documentElement.dataset.lctSeekState
  }));
  // At 1,500 messages one pixel row spans three of them, so the top of the rail
  // has to SNAP to the first message rather than land wherever it computes to.
  t("B2g the top of the map means message #1, not whatever pixel maths says",
    /^#1 of 1500 /.test(opened.title), opened.title);
  t("B2g the message is readable immediately, before the host has it",
    opened.open && /Virtual history message 1\./.test(opened.body), opened.body.slice(0, 60));
  t("B2g the wait is named, with a real denominator",
    /^Loading older messages… [\d,]+ of 1,500$/.test(opened.pill || ""), String(opened.pill));
  // The click that starts a seek is itself a pointerdown, and the loader's
  // stand-down listener is in capture phase: it must not cancel its own start.
  t("B2g the click that started the seek never cancels it", opened.state === "running");

  await topClick.waitForFunction(() =>
    document.documentElement.dataset.lctSeekState === "done", null, { timeout: 90000 });
  await topClick.waitForTimeout(500);
  const landed = await topClick.evaluate(() => {
    const el = document.querySelector('[data-message-id="virtual-1"]');
    const view = document.getElementById("virtual-scroller").getBoundingClientRect();
    const r = el && el.getBoundingClientRect();
    return {
      hitId: document.querySelector(".lct-hit")?.getAttribute("data-message-id") || null,
      inView: !!r && r.bottom > view.top && r.top < view.bottom,
      previewClosed: !document.querySelector("#lct-preview.lct-p-open"),
      pillGone: !document.querySelector("#lct-seek.lct-seek-show")
    };
  });
  t("B2g one click on the top of the map lands on the first message",
    landed.hitId === "virtual-1" && landed.inView, JSON.stringify(landed));
  t("B2g the preview steps aside once the real message is on screen",
    landed.previewClosed && landed.pillGone, JSON.stringify(landed));
  await topClick.close();

  /* B2g2 — a seek must stand down the instant the reader takes over, and must
     admit it when the host has no more history rather than parking at the top. */
  const stopped = await ctx.newPage();
  trackErrors(stopped);
  await stopped.goto("http://127.0.0.1:8917/test/virtual-history.html?index=1&total=1500&page=25&latency=200");
  await stopped.waitForFunction(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "1500",
    null, { timeout: 20000 });
  await stopped.hover("#lct-minimap");
  await stopped.waitForTimeout(400);
  const stopBox = await stopped.locator("#lct-mm-canvas").boundingBox();
  await stopped.mouse.click(stopBox.x + 5, stopBox.y + 1);
  await stopped.waitForFunction(() =>
    document.documentElement.dataset.lctSeekState === "running", null, { timeout: 8000 });
  await stopped.evaluate(() => document.getElementById("virtual-scroller")
    .dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true })));
  await stopped.waitForFunction(() =>
    document.documentElement.dataset.lctSeekState === "cancelled", null, { timeout: 5000 });
  const restTop = await stopped.evaluate(() => document.getElementById("virtual-scroller").scrollTop);
  await stopped.waitForTimeout(700);
  t("B2g2 a scroll stands the seek down and it stays down",
    (await stopped.evaluate(() => document.getElementById("virtual-scroller").scrollTop)) === restTop);
  await stopped.close();

  const dead = await ctx.newPage();
  trackErrors(dead);
  await dead.goto("http://127.0.0.1:8917/test/virtual-history.html?index=1&total=1500&page=25&deadAfter=3");
  await dead.waitForFunction(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "1500",
    null, { timeout: 20000 });
  await dead.hover("#lct-minimap");
  await dead.waitForTimeout(400);
  const deadBox = await dead.locator("#lct-mm-canvas").boundingBox();
  await dead.mouse.click(deadBox.x + 5, deadBox.y + 1);
  await dead.waitForFunction(() =>
    document.documentElement.dataset.lctSeekState === "exhausted", null, { timeout: 30000 });
  await dead.waitForTimeout(400);
  t("B2g2 a host that stops handing over history is reported, not waited on",
    await dead.evaluate(() => /as far back as/i.test(document.querySelector(".lct-p-note")?.textContent || "")));
  await dead.close();

  /* B2c — virtual-history backfill, the deliberate kind. ChatGPT's host
     virtualizer mounts only the tail at first. Once asked, the loader must
     reach the earliest turn, stop, and restore the reader without relying on
     a magic scroll height. */
  await pop.evaluate(() => chrome.storage.local.set({
    settings: { enabled: true, minimap: true, time: true, history: true }
  }));
  const virtual = await ctx.newPage();
  trackErrors(virtual);
  await virtual.goto("http://127.0.0.1:8917/test/virtual-history.html");
  await virtual.waitForFunction(() => document.documentElement.dataset.lctHistoryState === "complete", null, { timeout: 20000 });
  const historyState = await virtual.evaluate(async () => {
    const scroller = document.getElementById("virtual-scroller");
    const anchor = document.getElementById(window.__virtualHistory.anchor);
    const sr = scroller.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const ids = [...document.querySelectorAll("[data-message-id]")].map((el) => el.getAttribute("data-message-id"));
    const loadsAtFinish = window.__virtualHistory.loads;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return {
      count: ids.length,
      unique: new Set(ids).size,
      first: ids[0],
      last: ids[ids.length - 1],
      total: window.__virtualHistory.total,
      loadsAtFinish,
      loadsAfterWait: window.__virtualHistory.loads,
      anchorVisible: ar.bottom > sr.top && ar.top < sr.bottom
    };
  });
  t("B2c initial loader mounts every virtual turn through the first",
    historyState.count === historyState.total && historyState.first === "virtual-1" && historyState.last === "virtual-240",
    JSON.stringify(historyState));
  t("B2c initial loader keeps virtual turns unique", historyState.unique === historyState.total);
  t("B2c initial loader restores the reader anchor", historyState.anchorVisible);
  t("B2c initial loader stops once the oldest turn is mounted", historyState.loadsAtFinish === historyState.loadsAfterWait);
  await virtual.waitForSelector('#lct-mm-canvas[role="slider"]', { timeout: 5000 });
  t("B2c redesigned minimap exposes keyboard navigation semantics", true);
  // Model the host recycling its old DOM window after the initial crawl. The
  // navigator must retain the established full-map catalog instead of snapping
  // back to only the last mounted page.
  await virtual.evaluate(() => {
    [...document.querySelectorAll("[data-message-id]")].slice(0, 200).forEach((el) => el.remove());
  });
  await virtual.waitForFunction(() => {
    const map = document.getElementById("lct-mm-canvas");
    return document.querySelectorAll("[data-message-id]").length === 40 && map?.getAttribute("aria-valuemax") === "240";
  }, null, { timeout: 8000 });
  t("B2c minimap keeps the complete map after the host recycles old DOM rows", true);
  await virtual.close();

  /* B2d — a reader who scrolls mid-crawl cancels it, and must not be punished
     for it. The backfill used to be one-shot per route: one stray wheel and
     that conversation never finished loading its history for the whole session.
     It has to stand down immediately, then resume once the reader settles. */
  const resumed = await ctx.newPage();
  trackErrors(resumed);
  await resumed.goto("http://127.0.0.1:8917/test/virtual-history.html");
  // Interrupt as soon as the crawl is genuinely under way.
  await resumed.waitForFunction(() => document.documentElement.dataset.lctHistoryState === "running", null, { timeout: 15000 });
  await resumed.evaluate(() => {
    document.getElementById("virtual-scroller")
      .dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
  });
  await resumed.waitForFunction(() => document.documentElement.dataset.lctHistoryState === "cancelled", null, { timeout: 8000 });
  const partial = await resumed.evaluate(() => document.querySelectorAll("[data-message-id]").length);
  t("B2d a scroll during the crawl stands the loader down at once", true);
  // Left alone, it picks up where the host now is and finishes the job.
  await resumed.waitForFunction(() => document.documentElement.dataset.lctHistoryState === "complete", null, { timeout: 30000 });
  const finished = await resumed.evaluate(() => ({
    count: document.querySelectorAll("[data-message-id]").length,
    first: document.querySelector("[data-message-id]")?.getAttribute("data-message-id")
  }));
  t("B2d an interrupted backfill resumes and still reaches the first turn",
    finished.count === 240 && finished.first === "virtual-1",
    JSON.stringify({ partial, finished }));
  await resumed.close();
  await pop.evaluate(() => chrome.storage.local.set({
    settings: { enabled: true, minimap: true, time: true, history: false }
  }));

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
  await page.hover("#lct-minimap"); // the map rests as a rail — its bar unfurls on hover
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
  await page.hover("#lct-minimap"); // the map rests as a rail — its bar unfurls on hover
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
  await page.hover("#lct-minimap"); // the map rests as a rail — its bar unfurls on hover
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
  await page.hover("#lct-minimap"); // the map rests as a rail — its bar unfurls on hover
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

  // A reinstall offers the previous backup — and must NOT hold archiving
  // hostage to it. Blocking the pass meant a reinstalled browser quietly
  // archived nothing at all until someone went looking for this panel.
  await recall.evaluate(() => chrome.storage.local.set({
    "lct-recall-install-v1": { at: Date.now() },
    "lct-recall-recovery-v1": {
      state: "restore-offered", backup: { chats: 3, filename: "archive.lctbackup" }
    }
  }));
  await recall.reload();
  await recall.waitForFunction(() =>
    /Bring your previous archive back/.test(document.getElementById("recovery-title")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11 reinstall offers the previous encrypted archive", true);
  t("B11 reinstall does NOT block archiving on a restore",
    !(await recall.evaluate(() => document.getElementById("sync-all")?.disabled)));
  const reinstallSync = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11 reinstall summary never reports a restore block",
    reinstallSync && reinstallSync.summary && reinstallSync.summary.state !== "restore",
    JSON.stringify(reinstallSync && reinstallSync.summary));
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
  t("B11b it repeats rather than firing once", alarm && alarm.periodInMinutes === 180,
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

  /* ---- B11c. rate-limit governor, work journal, progress hygiene ---- */

  // finishPlatform leaves a "done" row in storage forever. Summing those into
  // the live pass inflated the denominator, so the percentage disagreed with
  // the message and drifted backwards as platforms completed.
  await recall.evaluate((at) => chrome.storage.local.set({
    "recall-sync-progress:chatgpt": {
      state: "syncing", phase: "syncing", runId: "run-B", platform: "chatgpt",
      done: 25, attempted: 25, total: 50, succeeded: 25, failed: 0, msg: "Capturing 25 of 50 new chats…", at
    },
    // stale leftover from a previous run — must be ignored entirely
    "recall-sync-progress:claude": {
      state: "done", phase: "up-to-date", runId: "run-A", platform: "claude",
      done: 900, attempted: 900, total: 900, succeeded: 900, failed: 0, msg: "900 new chats backed up", at: at - 90000
    }
  }), Date.now());
  const hygiene = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11c a finished run's totals never inflate the live percentage",
    hygiene.summary.done === 25 && hygiene.summary.total === 50,
    JSON.stringify(hygiene.summary));
  t("B11c the message and the percentage describe the same pass",
    /25 of 50/.test(hygiene.summary.message), hygiene.summary.message);
  await recall.evaluate(() => chrome.storage.local.remove([
    "lct-recall-sync-run-v1", "recall-sync-progress:chatgpt", "recall-sync-progress:claude"
  ]));

  // A 429 is not user-actionable. Painting it red trained people to click
  // "sync" again, which is exactly what re-triggers the rate limit.
  await recall.evaluate((at) => chrome.storage.local.set({
    "recall-sync-progress:chatgpt": {
      state: "paused", phase: "paused", runId: "run-C", platform: "chatgpt", done: 0, total: 0,
      msg: "ChatGPT is rate-limiting — resumes automatically", at
    }
  }), Date.now());
  const cooled = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11c rate limiting reports as paused, never as an error",
    cooled.summary.state === "paused" && /resumes automatically/.test(cooled.summary.message),
    JSON.stringify(cooled.summary));
  await recall.evaluate(() => chrome.storage.local.remove("recall-sync-progress:chatgpt"));

  // Retry-After comes in two wire formats and providers use both. Mis-parsing
  // the HTTP-date form yields 0 and the backoff collapses to nothing.
  const httpDate = new Date(Date.now() + 120000).toUTCString();
  const pacing = await recall.evaluate((d) => new Promise((res) =>
    chrome.runtime.sendMessage(
      { type: "recall-sync-selftest", values: ["120", d, "", "garbage", "-5"], attempt: 3, retryAfterMs: 0 }, res)),
    httpDate);
  t("B11c Retry-After in seconds is honoured", pacing.retryAfter[0] === 120000,
    JSON.stringify(pacing.retryAfter));
  t("B11c Retry-After as an HTTP-date is honoured",
    pacing.retryAfter[1] > 110000 && pacing.retryAfter[1] <= 120000, JSON.stringify(pacing.retryAfter));
  t("B11c a missing or malformed Retry-After never becomes a negative wait",
    pacing.retryAfter[2] === 0 && pacing.retryAfter[3] === 0 && pacing.retryAfter[4] === 0,
    JSON.stringify(pacing.retryAfter));
  t("B11c backoff grows with the attempt but stays jittered and capped",
    pacing.backoff >= 4000 && pacing.backoff <= 30000, String(pacing.backoff));

  // Claude/DeepSeek/Grok used to stop at their first page, silently losing every
  // chat past it. Their pagination params are undocumented and differ by build,
  // so the walk has to page properly when it can and give up safely when it
  // cannot — never loop, never claim completeness it did not earn.
  const walk = (pages, pageSize = 2) => recall.evaluate((m) => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-page-selftest", ...m }, res)), { pages, pageSize });
  // Distinct descending timestamps per id, so "did we lose a chat" is asserted
  // on the set of ids rather than on sort order.
  const stamp = { t: 100000 };
  const P = (...ids) => ids.map((id) => ({ id, updatedAt: stamp.t-- }));
  const got = (r) => [...r.ids].sort().join(",");

  // Claude documents limit/offset, so that spelling is tried first.
  const offsetServer = await walk({
    "offset=0": P("a", "b"), "offset=2": P("c", "d"), "offset=4": P("e")
  });
  t("B11c pagination walks past the first page to the end",
    got(offsetServer) === "a,b,c,d,e" && offsetServer.complete === true,
    JSON.stringify(offsetServer));

  // A server that only understands `page` must still be paged fully — this is
  // exactly the case that silently truncated DeepSeek/Grok at their first page.
  const pageServer = await walk({
    "offset=*": P("a", "b"), "skip=*": P("a", "b"),        // both ignored
    "page=0": P("c", "d"), "page=1": P("e", "f"), "page=2": P("g")
  });
  t("B11c a server that only understands page= is still paged fully",
    got(pageServer) === "c,d,e,f,g" && pageServer.paged === true,
    JSON.stringify(pageServer));

  const noPaging = await walk({ "offset=*": P("a", "b"), "skip=*": P("a", "b"), "page=*": P("a", "b") });
  t("B11c an endpoint that cannot page stops instead of looping",
    got(noPaging) === "a,b" && noPaging.calls.length <= 8, JSON.stringify(noPaging));
  t("B11c and never claims a completeness it did not earn",
    noPaging.complete === false, JSON.stringify(noPaging));

  const rejects = await walk({ "offset=*": "error", "skip=*": "error", "page=0": P("a", "b"), "page=1": P("c") });
  t("B11c a scheme the endpoint rejects is skipped, not fatal",
    got(rejects) === "a,b,c" && rejects.complete === true, JSON.stringify(rejects));

  const ignoredLimit = await walk({ "offset=0": P("a", "b", "c") });
  t("B11c a server that ignores limit is recognised as returning everything",
    got(ignoredLimit) === "a,b,c" && ignoredLimit.complete === true &&
    ignoredLimit.calls.length === 1, JSON.stringify(ignoredLimit));

  const emptyWalk = await walk({});
  t("B11c an empty history is complete, not an error",
    emptyWalk.ids.length === 0 && emptyWalk.complete === true, JSON.stringify(emptyWalk));

  // setDurable mirrors to local when storage.sync rejects. A reader that only
  // consulted sync concluded the checkpoint never existed, regenerated the
  // profile salt, and re-synced the entire history on every reload.
  const durableBefore = await recall.evaluate(async () => {
    const keys = ["lct-recall-sync-ledger-v2", "lct-recall-sync-profile-v1"];
    const saved = await chrome.storage.sync.get(keys);
    const account = await chrome.storage.local.get("lct-recall-active-account-v1");
    await chrome.storage.sync.remove(keys);
    await chrome.storage.local.set({
      "lct-recall-sync-ledger-v2": {
        version: 2,
        checkpoints: {
          "chatgpt:localonly": {
            version: 3, platform: "chatgpt", safeWatermark: 111, completedAt: 222,
            lastResult: "delta", archived: 5, coverage: 5, coverageKnown: true
          }
        }
      },
      "lct-recall-active-account-v1": { chatgpt: "chatgpt:localonly" }
    });
    return { saved, account: account["lct-recall-active-account-v1"] || null };
  });
  const localOnly = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11c a ledger that only reached local storage is still found",
    localOnly.platforms.chatgpt.checkpoint?.safeWatermark === 111,
    JSON.stringify(localOnly.platforms.chatgpt.checkpoint));
  t("B11c a pre-v4 checkpoint survives migration and stays trusted",
    localOnly.platforms.chatgpt.checkpoint?.pendingCount === 0 &&
    localOnly.platforms.chatgpt.checkpoint?.passState === "clean",
    JSON.stringify(localOnly.platforms.chatgpt.checkpoint));

  /* ---- B11d. the transcript parse the map is built on ----
     Positions in the map have to line up with rows in the page, so the parse
     must reproduce the branch the reader is actually looking at. The worker's
     network cannot be routed from here, so the parse is reachable directly. */
  const parsed = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({
      type: "chat-index-selftest",
      conv: {
        current_node: "c",
        mapping: {
          root: { id: "root", parent: null, message: null },
          a: { id: "a", parent: "root", message: { id: "a", author: { role: "user" }, create_time: 3,
               content: { parts: ["first"] } } },
          // a dead regenerate branch: newer than the live one, and never rendered
          dead: { id: "dead", parent: "a", message: { id: "dead", author: { role: "assistant" }, create_time: 9,
                  content: { parts: ["a reply that was thrown away"] } } },
          hidden: { id: "hidden", parent: "a", message: { id: "hidden", author: { role: "user" }, create_time: 4,
                    metadata: { is_visually_hidden_from_conversation: true }, content: { parts: ["system context"] } } },
          tool: { id: "tool", parent: "a", message: { id: "tool", author: { role: "assistant" }, create_time: 5,
                  recipient: "python", content: { parts: ["tool call"] } } },
          b: { id: "b", parent: "a", message: { id: "b", author: { role: "assistant" }, create_time: 6,
               content: { parts: ["second"] } } },
          // an image-only turn: no text, but it still occupies a row
          c: { id: "c", parent: "b", message: { id: "c", author: { role: "user" }, create_time: 7,
               content: { parts: [{ asset_pointer: "file-x" }] } } }
        }
      }
    }, res)));
  t("B11d the parse follows the live branch, in reading order",
    parsed.msgs.map((m) => m.i).join(",") === "a,b,c",
    JSON.stringify(parsed.msgs.map((m) => m.i)));
  t("B11d a regenerated branch nobody can see is not in the map",
    !parsed.msgs.some((m) => m.i === "dead"));
  t("B11d hidden context turns and tool calls are not rows",
    !parsed.msgs.some((m) => m.i === "hidden" || m.i === "tool"));
  t("B11d an image-only turn keeps its position",
    parsed.entries.length === 3 && parsed.entries[2].i === "c" && parsed.entries[2].n === 0,
    JSON.stringify(parsed.entries[2]));

  const cyclic = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({
      type: "chat-index-selftest",
      conv: { current_node: "x", mapping: {
        x: { id: "x", parent: "y", message: { id: "x", author: { role: "user" }, content: { parts: ["x"] } } },
        y: { id: "y", parent: "x", message: { id: "y", author: { role: "assistant" }, content: { parts: ["y"] } } }
      } }
    }, res)));
  t("B11d a malformed parent cycle terminates instead of hanging the worker",
    Array.isArray(cyclic.msgs) && cyclic.msgs.length === 2, JSON.stringify(cyclic.msgs?.length));

  /* ---- B11e. the index cache, and the write that used to destroy it ---- */
  await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-import", chats: [{
      id: "chatgpt.com/c/idx-1", host: "chatgpt.com", path: "/c/idx-1",
      platform: "ChatGPT", title: "Indexed chat", createdAt: 1, updatedAt: 2, sourceUpdatedAt: 2,
      msgs: [{ i: "m1", r: "user", t: "question one" }, { i: "m2", r: "assistant", t: "answer one" },
             { i: "m3", r: "user", t: "question two" }]
    }] }, res)));
  const cached = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-index", host: "chatgpt.com", path: "/c/idx-1" }, res)));
  t("B11e an archived chat with message ids serves the map with no network",
    cached.status === "ok" && cached.source === "archive" && cached.entries.length === 3,
    JSON.stringify({ status: cached.status, source: cached.source, n: cached.entries?.length }));
  t("B11e the index carries what the map draws with",
    cached.entries[0].i === "m1" && cached.entries[0].r === "user" && cached.entries[0].n === 12,
    JSON.stringify(cached.entries[0]));
  const oneMsg = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-message", host: "chatgpt.com", path: "/c/idx-1", id: "m2" }, res)));
  t("B11e a single message's full text comes back for the preview",
    oneMsg.status === "ok" && oneMsg.text === "answer one", JSON.stringify(oneMsg));

  // The live page re-archives whatever the host MOUNTED, under the same id the
  // sync writes. On ChatGPT that is the tail — so without a guard, opening a
  // chat trades a complete transcript for a fragment.
  await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-upsert", chat: {
      id: "chatgpt.com/c/idx-1", host: "chatgpt.com", path: "/c/idx-1",
      platform: "ChatGPT", title: "Indexed chat",
      msgs: [{ r: "user", t: "question two" }, { r: "assistant", t: "answer two" }]
    } }, res)));
  const afterTail = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] }, res)));
  t("B11e a mounted-tail write never shrinks a complete archived chat",
    afterTail["chatgpt.com/c/idx-1"]?.n === 3, JSON.stringify(afterTail));
  const stillCached = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-index", host: "chatgpt.com", path: "/c/idx-1" }, res)));
  t("B11e and the index survives it", stillCached.entries?.length === 3);

  const unsupported = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-index", host: "gemini.google.com", path: "/app/x" }, res)));
  t("B11e a platform with no history endpoint is answered, not attempted",
    unsupported.status === "unsupported", JSON.stringify(unsupported));

  /* --- deleted upstream: a question, never an event ---
     Losing the archived copy the moment the provider loses theirs makes the
     backup strictly weaker than the thing it is backing up. */
  const gone = await pop.evaluate(async () => {
    const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    const settings = (await chrome.storage.local.get("settings")).settings || {};
    await chrome.storage.local.set({ settings: { ...settings, deletionPolicy: "ask" } });
    await send({ type: "recall-deletions-resolve", ids: [], action: "keep" });
    const noted = await send({ type: "chat-drop", id: "chatgpt.com/c/idx-1" });
    return {
      noted,
      stillArchived: await send({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] }),
      queued: await send({ type: "recall-deletions" })
    };
  });
  t("B11e a chat deleted upstream is NOT silently removed from the backup",
    !!gone.stillArchived["chatgpt.com/c/idx-1"], JSON.stringify(gone.stillArchived));
  t("B11e it is quarantined for the user to decide on",
    gone.noted && gone.noted.queued === true && gone.queued.items.some((i) => i.id === "chatgpt.com/c/idx-1"),
    JSON.stringify(gone.noted));
  t("B11e the quarantined entry carries enough to recognise it",
    gone.queued.items.some((i) => i.id === "chatgpt.com/c/idx-1" && i.messages > 0 && i.detectedAt > 0),
    JSON.stringify(gone.queued.items[0]));

  // "Keep" must leave the archive whole; only an explicit delete removes text.
  const kept = await pop.evaluate(async () => {
    const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    await send({ type: "recall-deletions-resolve", ids: ["chatgpt.com/c/idx-1"], action: "keep" });
    return {
      archived: await send({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] }),
      queued: await send({ type: "recall-deletions" })
    };
  });
  t("B11e keeping a deleted chat leaves it archived and clears the prompt",
    !!kept.archived["chatgpt.com/c/idx-1"] && kept.queued.items.length === 0, JSON.stringify(kept.queued));

  // The standing policies are the escape hatch for people who want either
  // extreme, and "mirror" is the only one that may destroy anything.
  const policies = await pop.evaluate(async () => {
    const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    const setPolicy = async (deletionPolicy) => {
      const settings = (await chrome.storage.local.get("settings")).settings || {};
      await chrome.storage.local.set({ settings: { ...settings, deletionPolicy } });
    };
    await setPolicy("keep");
    const keepResult = await send({ type: "chat-drop", id: "chatgpt.com/c/idx-1" });
    const afterKeep = await send({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] });
    await setPolicy("mirror");
    const mirrorResult = await send({ type: "chat-drop", id: "chatgpt.com/c/idx-1" });
    const afterMirror = await send({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] });
    await setPolicy("ask");
    return { keepResult, afterKeep, mirrorResult, afterMirror };
  });
  t("B11e policy 'keep' never deletes and never asks",
    policies.keepResult.removed === false && !policies.keepResult.queued && !!policies.afterKeep["chatgpt.com/c/idx-1"],
    JSON.stringify(policies.keepResult));
  t("B11e policy 'mirror' deletes on sight, as asked",
    policies.mirrorResult.removed === true && !policies.afterMirror["chatgpt.com/c/idx-1"],
    JSON.stringify(policies.mirrorResult));

  /* --- the full-listing sweep, and its refusal to be gaslit --- */
  const sweep = await pop.evaluate(async () => {
    const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    // Record ids are host + prefix + provider id, which is what the sweep
    // strips back off to compare against the journal's pending set.
    const index = Array.from({ length: 40 }, (_, i) => ({ id: `selftest/c${i}`, rev: 1000 }));
    const all = index.map((e) => e.id);
    return {
      // One chat missing from a full listing: a real deletion.
      one: await send({ type: "recall-sweep-selftest", index, listed: all.slice(1), scanStartedAt: 5000 }),
      // Half the archive missing: far likelier a broken listing than a user
      // who deleted twenty chats between two passes.
      mass: await send({ type: "recall-sweep-selftest", index, listed: all.slice(20), scanStartedAt: 5000 }),
      // An empty listing is the signed-out case. It must never mean "wipe".
      empty: await send({ type: "recall-sweep-selftest", index, listed: [], scanStartedAt: 5000 }),
      // Written during this very pass — the listing is not evidence about it.
      fresh: await send({ type: "recall-sweep-selftest",
        index: [{ id: "selftest/c0", rev: 9000 }], listed: [], scanStartedAt: 5000 }),
      // Still outstanding in the journal, so not yet expected in a listing.
      pending: await send({ type: "recall-sweep-selftest",
        index: [{ id: "selftest/c0", rev: 1000 }], listed: [], scanStartedAt: 5000, pending: ["c0"] })
    };
  });
  t("B11e a full listing notices one genuinely deleted chat", sweep.one.vanished === 1, JSON.stringify(sweep.one));
  t("B11e a listing that lost half the archive is discarded, not acted on",
    sweep.mass.vanished === 0 && sweep.mass.reason === "implausible", JSON.stringify(sweep.mass));
  t("B11e an empty listing never means 'delete everything'",
    sweep.empty.vanished === 0, JSON.stringify(sweep.empty));
  t("B11e a chat written during the pass is not called deleted", sweep.fresh.vanished === 0, JSON.stringify(sweep.fresh));
  t("B11e a chat still pending in the journal is not called deleted", sweep.pending.vanished === 0, JSON.stringify(sweep.pending));

  // Re-archive it so the backup handoff below still has this record.
  await pop.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({
    type: "recall-upsert",
    chat: { id: "chatgpt.com/c/idx-1", host: "chatgpt.com", path: "/c/idx-1", platform: "ChatGPT",
      title: "Index seed", updatedAt: Date.now(),
      msgs: [{ i: "m1", r: "user", t: "first" }, { i: "m2", r: "assistant", t: "second" }] }
  }, res)));

  /* --- and the prompt the user actually sees --- */
  await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-drop", id: "chatgpt.com/c/idx-1" }, res)));
  await recall.reload();
  await recall.waitForSelector("#deletions:not([hidden])", { timeout: 5000 });
  t("B11e the deletion prompt surfaces on the Recall page", true);
  t("B11e it names the chat rather than just counting it",
    /Index seed/.test(await recall.textContent("#deletions-list")));
  t("B11e bulk delete is armed, not one click from permanent",
    (await recall.evaluate(async () => {
      document.getElementById("deletions-delete-all").click();
      return document.getElementById("deletions-delete-all").textContent;
    })).includes("Click again"));
  await pop.reload();
  await pop.waitForSelector("#deletion-alert:not([hidden])", { timeout: 5000 });
  t("B11e the popup carries the same unanswered question",
    /1 chat was deleted/.test(await pop.textContent("#deletion-alert-title")));

  await recall.click("#deletions-keep-all");
  await recall.waitForSelector("#deletions", { state: "hidden", timeout: 5000 });
  const afterKeepAll = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] }, res)));
  t("B11e 'keep all' dismisses the prompt and keeps every word",
    !!afterKeepAll["chatgpt.com/c/idx-1"], JSON.stringify(afterKeepAll));

  // Put the seeded ledger and salt back — the backup/restore handoff below is
  // built from them.
  await recall.evaluate(async (before) => {
    await chrome.storage.local.remove(["lct-recall-sync-ledger-v2", "lct-recall-active-account-v1"]);
    if (before.saved && Object.keys(before.saved).length) await chrome.storage.sync.set(before.saved);
    if (before.account) await chrome.storage.local.set({ "lct-recall-active-account-v1": before.account });
  }, durableBefore);

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
  // Scheduled backups are exercised on their own below; leaving them on here
  // would put a second, worker-issued download in flight during this one.
  await recall.uncheck("#backup-auto");
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
    /Wrong passphrase|altered/.test(await recall.textContent("#restore-status")));

  // The envelope is the only copy of the archive that ever leaves the browser,
  // so it has to survive an attacker holding the file and editing it freely.
  const backupJson = readFileSync(backupPath, "utf8");
  const tamper = await recall.evaluate(async ({ json, pass }) => {
    const C = self.LCTBackupCrypto;
    const out = {};
    const roundTrip = await C.open(json, pass);
    out.roundTrip = roundTrip.chats.length > 0;
    out.version = JSON.parse(json).version;
    const bend = async (mutate) => {
      const envelope = JSON.parse(json);
      mutate(envelope);
      try { await C.open(JSON.stringify(envelope), pass); return "accepted"; }
      catch (error) { return String(error.message || error); }
    };
    // Cheapen the KDF so the passphrase could be brute-forced offline.
    out.floor = await bend((e) => { e.kdf.iterations = 1000; });
    // Keep it legal-looking but still a downgrade — the tag must catch it.
    out.downgrade = await bend((e) => { e.kdf.iterations = 600000; });
    // Steer the parser away from the format the tag was computed over.
    out.compression = await bend((e) => { e.compression = "none"; });
    // Swap in a key envelope that is not the one this body was sealed with.
    out.keySwap = await bend((e) => { e.wrap.key = e.wrap.key.slice(0, -6) + "AAAAAA"; });
    out.body = await bend((e) => { e.payload = e.payload.slice(0, -6) + "AAAAAA"; });
    return out;
  }, { json: backupJson, pass: reinstallPassphrase });
  t("B11 backup envelope is v2 (wrapped file key, authenticated header)", tamper.version === 2, JSON.stringify(tamper.version));
  t("B11 backup decrypts with the right passphrase", tamper.roundTrip === true);
  t("B11 backup refuses a weakened KDF outright", /unsafe encryption/.test(tamper.floor), tamper.floor);
  t("B11 backup rejects a KDF downgrade at the tag", tamper.downgrade !== "accepted", tamper.downgrade);
  t("B11 backup rejects a swapped compression field", tamper.compression !== "accepted", tamper.compression);
  t("B11 backup rejects a substituted key envelope", tamper.keySwap !== "accepted", tamper.keySwap);
  t("B11 backup rejects an edited ciphertext", tamper.body !== "accepted", tamper.body);

  // Guessing at the restore box has to get expensive, and reloading the page
  // must not be the way out of it.
  const lockout = await recall.evaluate(async () => {
    const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    await send({ type: "recall-restore-guard-reset" });
    let last = null;
    for (let i = 0; i < 5; i++) last = await send({ type: "recall-restore-guard-fail" });
    const seen = await send({ type: "recall-restore-guard" });
    await send({ type: "recall-restore-guard-reset" });
    const after = await send({ type: "recall-restore-guard" });
    return { last, seen, after };
  });
  t("B11 repeated wrong passphrases lock the restore box",
    lockout.last && lockout.last.allowed === false && lockout.last.waitMs > 0, JSON.stringify(lockout.last));
  t("B11 the lockout is worker-owned, so a page reload cannot clear it",
    lockout.seen && lockout.seen.allowed === false, JSON.stringify(lockout.seen));
  t("B11 a successful restore clears the lockout", lockout.after && lockout.after.allowed === true);

  /* --- scheduled backups ---
     The manual button only helps people who remember to press it before
     uninstalling, which is the one moment nobody remembers. */
  const autoPassphrase = "scheduled archive passphrase 42";
  const seenDownloads = await recall.evaluate(() => new Promise((res) =>
    chrome.downloads.search({}, (items) => res((items || []).map((f) => f.id)))));
  const auto = await recall.evaluate(async ({ pass, seen }) => {
    const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    const keyring = await self.LCTBackupCrypto.mintKeyring(pass);
    const enabled = await send({ type: "recall-autobackup-enable", config: { keyring, everyHours: 24 } });
    const state = await send({ type: "recall-autobackup-state" });
    const stored = await chrome.storage.local.get("lct-recall-autobackup-v1");
    const roamed = await chrome.storage.sync.get("lct-recall-autobackup-v1");
    // The worker's download surfaces on no page, and the harness rewrites the
    // on-disk name, so it is identified by being the new completed item.
    const known = new Set(seen);
    let fresh = [];
    for (let i = 0; i < 40 && !fresh.length; i++) {
      const all = await new Promise((res) => chrome.downloads.search({}, (items) => res(items || [])));
      fresh = all.filter((f) => !known.has(f.id) && f.state === "complete");
      if (!fresh.length) await new Promise((r) => setTimeout(r, 250));
    }
    return { enabled, state, roamed: roamed["lct-recall-autobackup-v1"] || null,
      keptPassphrase: JSON.stringify(stored).includes(pass),
      paths: fresh.map((f) => f.filename) };
  }, { pass: autoPassphrase, seen: seenDownloads });
  t("B11 automatic backup can be set up from a passphrase",
    auto.enabled && auto.enabled.ok === true, JSON.stringify(auto.enabled));
  t("B11 setting it up writes the first encrypted file immediately",
    auto.enabled.first && auto.enabled.first.status === "ok", JSON.stringify(auto.enabled.first));
  t("B11 the scheduled backup is filed under its own folder",
    auto.state.folder === "Long Chat Toolkit" && auto.state.filename === "long-chat-toolkit-auto.lctbackup",
    JSON.stringify(auto.state));
  t("B11 the passphrase itself is never stored", auto.keptPassphrase === false);
  t("B11 backup key material never roams to storage.sync", auto.roamed === null || auto.roamed === undefined);
  t("B11 the UI is told the state without being handed the key",
    auto.state.enabled === true && auto.state.lastChats > 0 && !("keyring" in auto.state),
    JSON.stringify(auto.state));

  // The point of the whole exercise: the file written with nobody watching has
  // to be a real, openable backup — same envelope, same passphrase, nothing
  // weaker for being unattended.
  const autoJson = auto.paths.map((p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } })
    .find((text) => text.startsWith("{") && text.includes("lct-backup"));
  t("B11 the scheduled pass actually wrote a backup file", !!autoJson, JSON.stringify(auto.paths));
  if (autoJson) {
    const opened = await recall.evaluate(async ({ json, pass }) => {
      const out = { version: JSON.parse(json).version };
      try {
        const snapshot = await self.LCTBackupCrypto.open(json, pass);
        out.chats = snapshot.chats.length;
      } catch (error) { out.error = String(error.message || error); }
      try { await self.LCTBackupCrypto.open(json, "not the scheduled passphrase"); out.wrong = "accepted"; }
      catch (error) { out.wrong = String(error.message || error); }
      return out;
    }, { json: autoJson, pass: autoPassphrase });
    t("B11 the unattended file opens with the passphrase and nothing else",
      opened.chats > 0 && opened.version === 2, JSON.stringify(opened));
    t("B11 the unattended file is unreadable without it", opened.wrong !== "accepted", opened.wrong);
  }

  await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-autobackup-disable" }, res)));

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
  // setDurable mirrors into both storage areas, so a wipe that only cleared
  // storage.sync would leave the ledger behind after "delete everything".
  const wipedDurable = await recall.evaluate(async () => {
    const local = await chrome.storage.local.get(["lct-recall-sync-ledger-v2", "lct-recall-sync-work-v1"]);
    const synced = await chrome.storage.sync.get("lct-recall-sync-ledger-v2");
    return {
      local: local["lct-recall-sync-ledger-v2"] || null,
      work: local["lct-recall-sync-work-v1"] || null,
      synced: synced["lct-recall-sync-ledger-v2"] || null
    };
  });
  t("B11 wipe clears the ledger from both storage areas",
    !wipedDurable.local && !wipedDurable.synced, JSON.stringify(wipedDurable));
  t("B11 wipe clears the outstanding-work journal too",
    !wipedDurable.work, JSON.stringify(wipedDurable));
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
  await pop.evaluate(async () => {
    await chrome.storage.local.remove(["lct-trial-v2", "trial"]);
    await chrome.storage.sync.remove("lct-trial-v2");
  });
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

  /* ---- B13. The paywall, tested where it is actually enforced ----
     Every check here goes straight to the worker, bypassing the UI entirely —
     because that is exactly what a bypass attempt does. Buttons being disabled
     proves nothing; these assert the data does not come out. */

  const ask = (msg) => pop.evaluate((m) =>
    new Promise((res) => chrome.runtime.sendMessage(m, res)), msg);

  const locked = {
    search:   await ask({ type: "recall-search", q: "architectural" }),
    snapshot: await ask({ type: "recall-snapshot" }),
    backup:   await ask({ type: "recall-backup-state" }),
    autoOn:   await ask({ type: "recall-autobackup-enable", config: { everyHours: 24 } }),
    autoRun:  await ask({ type: "recall-autobackup-run" }),
    restore:  await ask({ type: "recall-restore-ledger", ledger: {}, meta: {}, profile: null }),
    guard:    await ask({ type: "recall-restore-guard" })
  };
  t("B13 the worker refuses every paid call when locked",
    Object.values(locked).every((r) => r && r.err === "locked"),
    JSON.stringify(locked));
  t("B13 a locked refusal leaks no archive data",
    !locked.snapshot.chats && !locked.search.results,
    JSON.stringify({ s: locked.snapshot, q: locked.search }));

  // The bypass this whole layer exists to stop: writing a Pro record by hand.
  await pop.evaluate(() => chrome.storage.local.set({
    license: { key: "DODO-FORGED-KEY-9999", email: "me@example.com", plan: "pro",
      kind: "dodo", instanceId: "lki_forged", activatedAt: Date.now() }
  }));
  const forged = await ask({ type: "entitlement-state" });
  const forgedSearch = await ask({ type: "recall-search", q: "architectural" });
  t("B13 a hand-written Pro record buys nothing",
    forged && forged.entitled === false && forgedSearch.err === "locked",
    JSON.stringify(forged));

  // Same, with a fabricated token: no private key, no entitlement.
  await pop.evaluate(() => chrome.storage.local.set({
    "lct-entitlement-v2": { token: "LCT2.eyJ2IjoyLCJwbGFuIjoicHJvIn0.AAAA", fetchedAt: Date.now() }
  }));
  const fakeTok = await ask({ type: "entitlement-state" });
  t("B13 a fabricated token fails on signature",
    fakeTok && fakeTok.entitled === false && fakeTok.reason === "signature",
    JSON.stringify(fakeTok));

  // A real, correctly-signed token restores everything — proving the refusals
  // above were the gate working, not something incidentally broken.
  await pop.evaluate(async () => chrome.storage.local.remove("lct-entitlement-v2"));
  const goodTok = await mintTokenFor("DODO-FORGED-KEY-9999");
  await pop.evaluate((tok) => chrome.storage.local.set({
    "lct-entitlement-v2": { token: tok, fetchedAt: Date.now(), lastAttemptAt: Date.now() }
  }), goodTok);
  const unlockedState = await ask({ type: "entitlement-state" });
  const unlockedSnap = await ask({ type: "recall-snapshot" });
  t("B13 a properly signed token unlocks the same calls",
    unlockedState.entitled === true && unlockedState.via === "dodo" &&
    unlockedSnap && !unlockedSnap.err && Array.isArray(unlockedSnap.chats),
    JSON.stringify(unlockedState));

  // Trial is worker-owned and sync-backed: clearing local storage is the
  // one-click "reset my trial" that must not work.
  await pop.evaluate(async () => {
    await chrome.storage.local.remove(["license", "lct-entitlement-v2"]);
  });
  const trialFirst = await ask({ type: "trial-start" });
  await pop.evaluate(() => chrome.storage.local.remove("lct-trial-v2"));   // local only
  const trialSecond = await ask({ type: "trial-start" });
  t("B13 wiping local storage does not mint a second trial",
    trialFirst.until > 0 && trialSecond.until === trialFirst.until,
    JSON.stringify({ trialFirst, trialSecond }));

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
  // in the finally so an abort mid-run still says what had failed before it
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("failed:\n  " + failed.join("\n  "));
}

process.exit(fail ? 1 : 0);
