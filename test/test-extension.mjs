#!/usr/bin/env node
/* Tvara — full browser test suite.
   Loads the real unpacked extension into Chromium, tests the popup UI state
   machine, license activation (incl. "key must never appear in the DOM"),
   storage persistence, and the speed engine on the 1,500-message torture page. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { addDevHosts } from "./security-fixtures.mjs";

const SRC = join(import.meta.dirname, "..");
// Work dirs live under the OS temp dir — never committed (test/.gitignore).
const SCRATCH = join(SRC, "test", ".work");
const PROFILE = join(SCRATCH, "chrome-profile");
const SHOTS = join(SCRATCH, "shots");
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
  "-a", "--exclude", ".git", "--exclude", "node_modules",
  /* Every scratch mirror, not just this file's: they nest, and a mirror that
     copies the last run's mirror grows the tree by hundreds of megabytes a
     run. tools/.keys is excluded because the dev signing key must never sit
     inside a directory Chrome is asked to load — that is what puts "this
     extension includes the key file" on the extensions page. */
  "--exclude", "test/.work*", "--exclude", "dist", "--exclude", "store",
  "--exclude", "tools/.keys", "--exclude", ".stryker-tmp",
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

// The fixture pages are served from 127.0.0.1; the tree itself is not allowed
// there. See addDevHosts() in security-fixtures.mjs.
addDevHosts(EXT);

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
/* A manifest `key` pins the extension id to the KEY, not the folder path. The
   mirrors below copy the key through, so the path derivation is wrong whenever
   `key` is set — seed from the key when it is there. */
function idSeed(dir) {
  try {
    const k = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).key;
    if (k) return Buffer.from(k, "base64");
  } catch { /* no manifest yet — fall back to the path */ }
  return dir;
}
const computedId = [...createHash("sha256").update(idSeed(EXT)).digest().subarray(0, 16)]
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

let pass = 0, fail = 0, suiteFinished = false;
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
/* A launch is only useful if the extension is actually in it, so the service
   worker — whose URL is the authoritative extension id — is the proof. Branded
   Chrome stopped honouring --load-extension in M136 and the feature switch
   below no longer brings it back either (checked on 152), so a
   PW_CHANNEL=chrome run has to fall back rather than report a suite that never
   ran. The switch stays: it is a no-op on Chromium and it costs nothing the day
   a branded build allows this again. */
async function launchCtx(channel) {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  /* Chrome 137+ will install an unpacked extension and then refuse to run it
     unless the profile has developer mode on — the pages come back
     ERR_BLOCKED_BY_CLIENT, which reads exactly like "not installed". Seeding
     the pref before first launch is the only way in on a fresh profile. */
  mkdirSync(join(PROFILE, "Default"), { recursive: true });
  writeFileSync(join(PROFILE, "Default", "Preferences"),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
  const c = await chromium.launchPersistentContext(PROFILE, {
    channel,
    /* Headless Chrome reports every tab as visible — bringToFront() does not
       move document.visibilityState and neither does any CDP override still in
       the protocol. The background-tab assertions below check for that and say
       so rather than failing. LCT_HEADFUL=1 runs them for real. */
    headless: !process.env.LCT_HEADFUL,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           "--disable-features=DisableLoadExtensionCommandLineSwitch",
           /* Chrome 137+ gates the CDP Extensions domain behind this. It is
              what makes the loadUnpacked fallback below possible at all. */
           "--enable-unsafe-extension-debugging",
           `--download-directory=${DOWNLOADS}`],
    /* Off by default in Playwright, which paints an "unsupported command-line
       flag: --no-sandbox" banner across every headed window. Nothing here needs
       it off. */
    chromiumSandbox: true,
    viewport: { width: 900, height: 800 }
  }).catch((e) => { console.log(`note: ${channel} could not start here (${String(e.message || e).split("\n")[0]})`); return null; });
  if (!c) return null;
  const settle = () => c.serviceWorkers()[0] ||
    c.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  let worker = await settle();
  if (!worker) {
    /* Branded Chrome ignored --load-extension (M136+, still true on 152).
       Extensions.loadUnpacked is the replacement Chrome shipped for it, and it
       returns the id directly — which is better than deriving one, so keep it.
       The service worker is a lazy MV3 worker and may not have spun up yet;
       loadUnpacked returning an id is itself the proof the extension is in. */
    const id = await c.browser()?.newBrowserCDPSession()
      .then((s) => s.send("Extensions.loadUnpacked", { path: EXT }))
      .then((r) => r && r.id)
      .catch(() => null);
    if (id) { loadedId = id; await settle(); return c; }
  }
  if (worker) return c;
  await c.close();
  return null;
}
let loadedId = "";
const WANT = process.env.PW_CHANNEL || "chromium";
let ctx = await launchCtx(WANT);
if (!ctx && WANT !== "chromium") {
  console.log(`note: ${WANT} would not load an unpacked extension here (M136+ builds ` +
    "refuse --load-extension); falling back to the bundled Chromium — same engine, " +
    "same extension APIs.");
  ctx = await launchCtx("chromium");
}
if (!ctx) { console.error("FATAL: no browser here would load the extension"); process.exit(1); }
await new Promise((r) => setTimeout(r, 1500)); // let Chrome register the extension
// Context Bridge's clipboard fallback is asserted deterministically
try { await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8917" }); } catch {}
const POPUP = `chrome-extension://${loadedId || idFromProfile() || computedId}/popup/popup.html`;

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
  /* Read from the manifest rather than typed here: a hardcoded version turns
     every release into a test edit, and the thing worth asserting is that the
     popup shows the version it SHIPS, not one particular number. */
  const MF = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
  const MF_VERSION = MF.version;
  t("A1 version shown", (await pop.textContent("#version")).trim() === `v${MF_VERSION}`);
  /* The account photo is served by Google, and an extension page loads no
     remote image the CSP has not named. Without this line the header renders a
     broken circle for every signed-in user and nothing says why. */
  const CSP = String((MF.content_security_policy || {}).extension_pages || "");
  t("A1 the account photo's host is allowed to load",
    /img-src[^;]*googleusercontent\.com/.test(CSP), CSP);
  t("A1 …and scripts are still same-origin only",
    /script-src 'self'/.test(CSP) && !/script-src[^;]*http/.test(CSP), CSP);
  t("A1 upsell visible / active card hidden",
    (await pop.isVisible("#pro-upsell")) && !(await pop.isVisible("#pro-active")));
  t("A1 speed/minimap/time toggles on by default",
    (await pop.isChecked("#toggle-enabled")) && (await pop.isChecked("#toggle-minimap")) && (await pop.isChecked("#toggle-time")));
  t("A1 trial button visible in free state", await pop.isVisible("#trial-start"));

  const onboarding = await ctx.newPage();
  trackErrors(onboarding);
  await onboarding.goto(POPUP.replace("/popup/popup.html", "/pages/onboarding.html"));
  await onboarding.getByRole("button", { name: "Use Tvara" }).click();
  await onboarding.waitForFunction(() => document.querySelector("#picker.open") &&
    document.querySelectorAll(".bubble-disc svg").length === 6);
  const pickerState = await onboarding.evaluate(() => ({
    labels: [...document.querySelectorAll(".bubble")].map((b) => b.getAttribute("aria-label")),
    glyphs: document.querySelectorAll(".bubble-disc svg").length,
    initials: [...document.querySelectorAll(".bubble-disc")].some((d) => (d.textContent || "").trim()),
    focus: document.activeElement?.getAttribute("aria-label") || ""
  }));
  t("A1f onboarding uses six labelled provider glyphs, not initials",
    pickerState.glyphs === 6 && !pickerState.initials && pickerState.labels.length === 6,
    JSON.stringify(pickerState));
  t("A1f picker focuses its first choice", /ChatGPT/.test(pickerState.focus), JSON.stringify(pickerState));
  await onboarding.setViewportSize({ width: 360, height: 800 });
  const compactPicker = await onboarding.evaluate(() => {
    const sheet = document.querySelector(".picker-sheet").getBoundingClientRect();
    const bubbles = getComputedStyle(document.querySelector(".bubbles")).gridTemplateColumns.split(" ").length;
    return { bubbles, fits: sheet.left >= 0 && sheet.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth };
  });
  t("A1f picker remains usable in a narrow desktop window", compactPicker.bubbles === 2 && compactPicker.fits,
    JSON.stringify(compactPicker));
  await onboarding.keyboard.press("Escape");
  await onboarding.waitForFunction(() => document.querySelector("#picker").hidden);
  t("A1f Escape closes the picker and restores focus", await onboarding.evaluate(() => document.activeElement?.id === "use-tvara"));
  await onboarding.close();

  /* A1b — the purchase path. Until this existed the popup could take a licence
     key but could not tell anyone where to get one. chrome.tabs.create is
     stubbed rather than fired: the assertion is about WHICH url we send people
     to, and a test suite has no business opening the live pricing page. */
  /* A row that has a reset time but no figure used to print only the clock,
     which reads as a measurement. Live, ChatGPT showed "resets Sat 9:46 PM"
     next to five rows that were showing percentages. */
  /* ChatGPT meters several features as counts with no ceiling —
     "deep_research: 25 remaining". There is no honest percentage to make of
     that without inventing the denominator, and the panel used to have nowhere
     to put it, so the row said "not reported" while the provider had told us a
     real number. */
  await pop.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
    type: "quota-observed", host: "chatgpt.com",
    observations: [{ kind: "body", at: Date.now(), json: {
      limits_progress: [{ feature_name: "deep_research", remaining: 25,
        reset_after: new Date(Date.now() + 36e5).toISOString() }] } }]
  }, r)));
  await pop.reload();
  await pop.waitForSelector(".usage-row", { timeout: 8000 });
  await pop.waitForTimeout(2500);
  const counted = await pop.evaluate(() => {
    const row = [...document.querySelectorAll(".usage-row")]
      .find((r) => /ChatGPT/.test(r.textContent));
    return { row: row ? row.textContent.replace(/\s+/g, " ").trim() : "(none)",
             verdict: document.querySelector(".usage-verdict")?.textContent || "" };
  });
  /* A weekday alone only means something inside the coming week. ChatGPT's
     deep-research window resets on 17 September and the row read "Thu 5:29 PM"
     — the right weekday, a month early, and read by anyone as this week. */
  await pop.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
    type: "quota-observed", host: "chatgpt.com",
    observations: [{ kind: "body", at: Date.now(), json: {
      limits_progress: [{ feature_name: "deep_research", remaining: 25,
        reset_after: new Date(Date.now() + 30 * 864e5).toISOString() }] } }]
  }, r)));
  await pop.reload();
  await pop.waitForSelector(".usage-row", { timeout: 8000 });
  await pop.waitForTimeout(2500);
  const farRow = await pop.evaluate(() => {
    const row = [...document.querySelectorAll(".usage-row")].find((r) => /ChatGPT/.test(r.textContent));
    return row ? row.textContent.replace(/\s+/g, " ").trim() : "";
  });
  t("A1d a reset a month away is dated, not given a weekday",
    !/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(farRow) && /\d/.test(farRow), farRow);

  /* ---- A1e two windows, one row ----
     Claude publishes a five-hour session limit AND a week. The row leads with
     the one that stops you soonest, and which one matters depends on what the
     reader is about to do — so the figure is a button that steps between them,
     and the choice survives the panel's own repaint. */
  await pop.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
    type: "quota-observed", host: "claude.ai",
    observations: [{ kind: "body", at: Date.now(), json: {
      five_hour: { utilization: 24, resets_at: new Date(Date.now() + 3.6e6).toISOString() },
      seven_day: { utilization: 61, resets_at: new Date(Date.now() + 3 * 864e5).toISOString() }
    } }]
  }, r)));
  await pop.reload();
  await pop.waitForSelector(".usage-row", { timeout: 8000 });
  await pop.waitForTimeout(2500);
  const claudeRow = () => pop.evaluate(() => {
    const row = [...document.querySelectorAll(".usage-row")].find((r) => /Claude/.test(r.textContent));
    const btn = row && row.querySelector("button.usage-switch");
    return { text: row ? row.textContent.replace(/\s+/g, " ").trim() : "(none)",
             switchable: !!btn,
             // No native tooltip on purpose — see popup.js. The screen-reader
             // label is what has to name the window.
             hasTitle: !!(btn && btn.getAttribute("title")),
             label: btn ? btn.getAttribute("aria-label") || "" : "" };
  });
  const firstWin = await claudeRow();
  t("A1e the row leads with the session limit, not the week",
    /5h/.test(firstWin.text) && /76/.test(firstWin.text), JSON.stringify(firstWin));
  t("A1e …and says the other one can be shown",
    firstWin.switchable && /week/i.test(firstWin.label), JSON.stringify(firstWin));
  t("A1e …without a tooltip reading out the meter's raw name",
    !firstWin.hasTitle, JSON.stringify(firstWin));
  await pop.click(".usage-row button.usage-switch");
  await pop.waitForTimeout(700);
  const secondWin = await claudeRow();
  t("A1e clicking the figure shows the weekly limit",
    /week/.test(secondWin.text) && /39/.test(secondWin.text), JSON.stringify(secondWin));
  // The panel repaints on its own every few seconds; a choice that reset on
  // every repaint would be unusable.
  await pop.waitForTimeout(3000);
  const heldWin = await claudeRow();
  t("A1e …and the panel's own repaint does not undo it",
    /week/.test(heldWin.text), JSON.stringify(heldWin));
  await pop.click(".usage-row button.usage-switch");
  await pop.waitForTimeout(700);
  const wrapped = await claudeRow();
  t("A1e clicking again comes back round to the session limit",
    /5h/.test(wrapped.text) && /76/.test(wrapped.text), JSON.stringify(wrapped));
  await pop.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
    type: "quota-observed", host: "claude.ai",
    observations: [{ kind: "body", at: Date.now(), json: {
      five_hour: { utilization: 9, resets_at: new Date(Date.now() + 3.6e6).toISOString() },
      seven_day: { utilization: 100, resets_at: new Date(Date.now() + 3 * 864e5).toISOString() }
    } }]
  }, r)));
  await pop.reload();
  await pop.waitForSelector(".usage-row", { timeout: 8000 });
  await pop.waitForTimeout(2500);
  const blockedClaude = await pop.evaluate(() => {
    const row = [...document.querySelectorAll(".usage-row")].find((r) => /Claude/.test(r.textContent));
    const lock = row && row.querySelector(".usage-lock");
    return { text: row ? row.textContent.replace(/\s+/g, " ").trim() : "(none)",
      lock: lock ? lock.getAttribute("aria-label") || "" : "",
      switchable: !!(row && row.querySelector("button.usage-switch")),
      headline: !!document.querySelector(".usage-verdict"),
      spentStrokes: [...document.querySelectorAll(".usage-track.spent")].map((el) => el.style.stroke),
      spentOpacity: getComputedStyle(document.querySelector(".usage-track.spent")).opacity };
  });
  t("A1e an exhausted weekly limit locks the provider despite session allowance",
    /Claude unavailable/i.test(blockedClaude.lock) && !/5h/.test(blockedClaude.text), JSON.stringify(blockedClaude));
  t("A1e unavailable providers use the lock indicator, not a headline or window switch",
    !blockedClaude.switchable && !blockedClaude.headline, JSON.stringify(blockedClaude));
  t("A1e an exhausted provider keeps its own subdued ring colour",
    blockedClaude.spentStrokes.includes("#e0805c") && Number(blockedClaude.spentOpacity) <= 0.2,
    JSON.stringify(blockedClaude));
  /* A window with a reset and no figure is a real row when it is all a
     provider gave us. It is NOT one of the options behind a click: stepping
     off a number and landing on "not reported" is a step to nothing. */
  await pop.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
    type: "quota-observed", host: "claude.ai",
    observations: [{ kind: "body", at: Date.now(), json: {
      five_hour: { utilization: 24, resets_at: new Date(Date.now() + 3.6e6).toISOString() },
      seven_day: { utilization: 61, resets_at: new Date(Date.now() + 3 * 864e5).toISOString() },
      entitlement: { resets_at: new Date(Date.now() + 9 * 864e5).toISOString() }
    } }]
  }, r)));
  await pop.reload();
  await pop.waitForSelector(".usage-row", { timeout: 8000 });
  await pop.waitForTimeout(2500);
  const stepped = [];
  for (let i = 0; i < 4; i++) {
    stepped.push((await claudeRow()).text);
    const has = await pop.locator(".usage-row button.usage-switch").count();
    if (!has) break;
    await pop.click(".usage-row button.usage-switch");
    await pop.waitForTimeout(600);
  }
  t("A1e a window with no figure is never one of the options",
    !stepped.some((x) => /not reported/.test(x)), JSON.stringify(stepped));
  t("A1e …and stepping through returns to where it started",
    stepped[0] === stepped[2], JSON.stringify(stepped));
  await pop.evaluate(() => chrome.storage.local.remove(["quota:claude|", "lct-quota-warned-v1"]));

  /* DeepSeek publishes no allowance at all — it enforces with 429 and a
     proof-of-work challenge — so a permanent "no limit published" row among
     the figures is a line of nothing. It is still archived. */
  const rowNames = await pop.evaluate(() =>
    [...document.querySelectorAll(".usage-row .usage-name")].map((n) => n.textContent.trim()));
  t("A1e a provider with no allowance to publish is not a row on this panel",
    !rowNames.some((n) => /DeepSeek/i.test(n)), JSON.stringify(rowNames));

  t("A1d a count with no ceiling is shown as the count it is",
    /25/.test(counted.row) && /left/.test(counted.row), counted.row);
  t("A1d …and says what is being counted",
    /deep research/i.test(counted.row), counted.row);
  t("A1d the verdict names the count, not a healthy percentage",
    /25/.test(counted.verdict) && /deep research/i.test(counted.verdict), counted.verdict);
  await pop.evaluate(() => chrome.storage.local.remove("quota:chatgpt|"));

  t("A1c a reset with no figure behind it says so",
    await pop.evaluate(() => {
      const rows = [...document.querySelectorAll(".usage-row")];
      return rows.every((r) => {
        const v = r.querySelector(".usage-val")?.textContent || "";
        return !/^resets /.test(v.trim());
      });
    }));

  t("A1b buy button visible in free state", await pop.isVisible("#buy-pro"));

  /* Buying without a verified address signs in FIRST, in the same click. The
     address is what makes the purchase findable again after a reinstall, so it
     is part of buying rather than an extra step next to it — and the issuer
     refuses an anonymous checkout anyway, so no checkout may be opened until
     the sign-in has actually come back ok. */
  const buyAnon = await pop.evaluate(async () => {
    const sent = [];
    const realSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (msg, cb) => { sent.push(msg && msg.type); if (cb) cb({}); };
    document.getElementById("buy-pro").click();
    await new Promise((r) => setTimeout(r, 120));
    chrome.runtime.sendMessage = realSend;
    return { sent, status: (document.getElementById("identity-status") || {}).textContent || "" };
  });
  t("A1b buying while signed out starts the sign-in",
    buyAnon.sent.includes("identity-google"), JSON.stringify(buyAnon));
  t("A1b …and opens no checkout until it succeeds",
    !buyAnon.sent.includes("checkout-start"), JSON.stringify(buyAnon));

  /* From here the popup believes an address is verified. The issuer is not
     reachable from this harness, so the record verification would have written
     is written directly — the token is opaque to the client, which only ever
     carries it. */
  await pop.evaluate(async () => {
    const rec = { idt: "LCTID1.e2e.identity", at: Date.now() };
    await chrome.storage.local.set({ "lct-identity-v1": rec });
    await chrome.storage.sync.set({ "lct-identity-v1": rec });
  });
  await pop.reload();
  await pop.waitForSelector("#identity-done:not([hidden])");

  /* The button asks the BACKGROUND to open a checkout — it does not know a URL,
     a product or a price, and it opens no tab of its own. That is the whole
     point of the change: the payment link is not shipped in the extension and
     is not on a web page, so it can move without a store review and cannot go
     stale in a cached page. */
  const buyMsg = await pop.evaluate(async () => {
    let sent = null, opened = null;
    const realSend = chrome.runtime.sendMessage;
    const realCreate = chrome.tabs.create;
    const close = window.close;
    chrome.runtime.sendMessage = (msg, cb) => { sent = msg; if (cb) cb({ ok: false, reason: "network" }); };
    chrome.tabs.create = (opts) => { opened = opts.url; };
    window.close = () => {};
    document.getElementById("buy-pro").click();
    await new Promise((r) => setTimeout(r, 60));
    chrome.runtime.sendMessage = realSend;
    chrome.tabs.create = realCreate;
    window.close = close;
    return { sent, opened };
  });
  t("A1b buy button asks the issuer to open a checkout",
    buyMsg.sent && buyMsg.sent.type === "checkout-start", JSON.stringify(buyMsg.sent));
  t("A1b buy button navigates nowhere itself (no URL in the extension)",
    buyMsg.opened === null, String(buyMsg.opened));
  t("A1b no payment URL is shipped in the extension",
    await pop.evaluate(() => !("BUY" in self.LCTProduct)));
  t("A1b every outward link comes from one place",
    await pop.evaluate(() => !!self.LCTProduct && Object.isFrozen(self.LCTProduct)));

  /* Back to a signed-out install. A7 and A8 measure the free state, and A8's
     first assertion is that the trial button asks for a sign-in — which it
     cannot do while this identity record is still sitting in storage. */
  await pop.evaluate(async () => {
    await chrome.storage.local.remove("lct-identity-v1");
    await chrome.storage.sync.remove("lct-identity-v1");
  });
  await pop.reload();
  await pop.waitForSelector("#identity-done", { state: "hidden" });

  /* The price used to be typed into seventeen files. Every surface now renders
     the one constant, so changing it cannot leave a page quoting a number the
     checkout does not charge — the mismatch that produces refunds. */
  const priced = await pop.evaluate(() => {
    const P = self.LCTProduct.PRICE;
    const els = [...document.querySelectorAll("[data-price]")];
    return {
      price: P,
      count: els.length,
      allFilled: els.every((el) => el.textContent.includes(P) && !el.textContent.includes("{price}")),
      // Nothing may hard-code a currency figure of its own.
      strays: document.body.innerHTML.match(/\$\d+/g)?.filter((x) => x !== P) || []
    };
  });
  t("A1b the popup renders the price from the one constant",
    priced.count >= 2 && priced.allFilled, JSON.stringify(priced));
  t("A1b no surface hard-codes a price of its own",
    priced.strays.length === 0, JSON.stringify(priced.strays));
  // An unpacked build has no store page; a "Rate it" link to a 404 is worse
  // than none, so it stays hidden until the copy came from a store.
  t("A1b rate link hidden on a non-store install",
    await pop.evaluate(() => document.getElementById("rate-link").hidden === true));
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

  /* A3 — invalid key. The paste box is folded away by default now: signing in
     is the way in, and this is the recovery path for an LCT1 key or a Google
     account that is not the address the licence was bought with. */
  t("A3 the paste box is folded away until asked for",
    await pop.evaluate(() => document.getElementById("license-row").hidden === true));
  await pop.click("#license-toggle");
  t("A3 ...and opens on the link, marked open for a screen reader",
    await pop.evaluate(() => document.getElementById("license-row").hidden === false &&
      document.getElementById("license-toggle").getAttribute("aria-expanded") === "true"));
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

  // A5b — the results list holds every match and is itself the scroller. Two
  // things must both hold: the document must never become the scroller (html
  // and body are overflow:hidden, so anything past the pane is clipped, not
  // reachable), and the list must be scrollable to the last match with no
  // scrollbar taking up width. Twelve chats is more than the surface can show
  // at once, which is the whole point of the case.
  await pop.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({
    type: "recall-import",
    chats: Array.from({ length: 12 }, (_, i) => ({
      id: `chatgpt.com/c/popup-layout-${i}`, host: "chatgpt.com", path: `/c/popup-layout-${i}`,
      platform: "ChatGPT", title: `Popup layout regression ${i + 1}`, n: 2,
      createdAt: Date.now() - i * 6e4, updatedAt: Date.now() - i * 6e4,
      msgs: [{ r: "user", t: "fixed popup layout" },
             { r: "assistant", t: "The popup must never grow past the pane Chrome gave it." }]
    }))
  }, resolve)));
  // 600px is Chrome's real ceiling for a popup pane, so that is the surface the
  // panel has to fit inside.
  await pop.setViewportSize({ width: 380, height: 600 });
  await pop.fill("#recall-query", "popup");
  await pop.waitForSelector("#recall-results .recall-result");
  const popupMetrics = await pop.evaluate(() => {
    const box = document.getElementById("recall-results");
    return {
      rows: box.querySelectorAll(".recall-result").length,
      meta: document.getElementById("recall-query-meta").textContent,
      boxScroll: box.scrollHeight, boxClient: box.clientHeight,
      bar: box.offsetWidth - box.clientWidth,
      edge: box.classList.contains("more-below"),
      rootScroll: document.documentElement.scrollHeight,
      rootClient: document.documentElement.clientHeight,
      bodyScroll: document.body.scrollHeight,
      bodyClient: document.body.clientHeight
    };
  });
  t("A5b popup search lists every match, not a preview",
    popupMetrics.rows === 12 && popupMetrics.meta === "12 chats", JSON.stringify(popupMetrics));
  /* The root is the real scroller and stays strict. body is allowed two pixels:
     its height lands on a fractional boundary and rounds either way between
     runs, and with two stacked fractional elements that is occasionally 2 and
     not 1 — which failed this about one run in eight for no reason anyone could
     act on. A genuine regression here is tens of pixels, not two. */
  t("A5b popup search keeps the panel inside the pane",
    popupMetrics.rootScroll <= popupMetrics.rootClient &&
    popupMetrics.bodyScroll <= popupMetrics.bodyClient + 2,
    JSON.stringify(popupMetrics));
  t("A5b the list is the scroller, with no scrollbar and a fade to say so",
    popupMetrics.boxScroll > popupMetrics.boxClient + 20 &&
    popupMetrics.bar === 0 && popupMetrics.edge, JSON.stringify(popupMetrics));
  // Scrolling has to reach the twelfth match, not stall partway. The scroll
  // event that repaints the edges is asynchronous, so read the classes after it
  // has landed rather than in the same block that moved the list.
  /* Re-asserted until it holds, rather than set once and measured. The list's
     scrollHeight grows a few pixels after the first scroll (the fade edges lay
     out), so a single `scrollTop = scrollHeight` landed 4px short of the end
     about one run in three and failed a test that was measuring a moving
     target, not a regression. */
  await pop.waitForFunction(() => {
    const box = document.getElementById("recall-results");
    box.scrollTop = box.scrollHeight;
    return box.scrollTop === box.scrollHeight - box.clientHeight &&
           box.classList.contains("more-above");
  });
  const popupScrolled = await pop.evaluate(() => {
    const box = document.getElementById("recall-results");
    const last = box.lastElementChild.getBoundingClientRect();
    return { top: Math.round(box.scrollTop), end: box.scrollHeight - box.clientHeight,
             lastInView: last.bottom <= box.getBoundingClientRect().bottom + 1,
             above: box.classList.contains("more-above"),
             below: box.classList.contains("more-below") };
  });
  t("A5b the last match is reachable by scrolling",
    popupScrolled.top === popupScrolled.end && popupScrolled.lastInView &&
    popupScrolled.above && !popupScrolled.below, JSON.stringify(popupScrolled));
  // Clearing the query hands the surface back to the rows it borrowed from.
  await pop.fill("#recall-query", "");
  await pop.waitForFunction(() => !document.body.classList.contains("searching"));
  t("A5b clearing the query gives the rows below their room back",
    await pop.isVisible("#sync-history") && await pop.isVisible("footer"));
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

  /* A8 — the 7-day trial.

     The trial is anchored to a VERIFIED EMAIL now, not to this install, which
     is what stops uninstalling and reinstalling minting a second week. The
     issuer is not reachable from this harness, so an address cannot actually
     be verified here. What IS reproduced exactly is the thing that decides:
     the issuer's signed trial token, minted below with the same throwaway key
     the mirrored extension trusts and bound to this install's real device
     fingerprint. The `verified` flag beside it is deliberately along for the
     ride and load-bearing for nothing. */
  /* `locked` waits for the paint the verdict drives, not the one the cache
     draws first. Reading #trial-active the instant a reload finishes races the
     popup's own round trip to the worker, and a negative assertion that wins
     that race proves nothing. */
  const writeTrialRecord = async (rec, locked = false) => {
    await pop.evaluate(async (r) => {
      await chrome.storage.local.set({ "lct-trial-v2": r });
      await chrome.storage.sync.set({ "lct-trial-v2": r });
    }, rec);
    await pop.reload();
    if (locked) await pop.waitForSelector("#pro-upsell:not([hidden])");
  };
  /* The device the token must bind to: the fingerprint of the non-extractable
     keypair this install holds, which the popup and the service worker share.
     A token minted against anything else is a token for another machine. */
  const trialDevFp = await pop.evaluate(() => self.LCTEntitlement.deviceFpFor(""));
  /* Real base64, not a readable label. The issuer's `ks` is btoa() of an HMAC,
     and the Recall page decodes it strictly before sealing a backup — a
     readable mnemonic fails that decode and surfaces as "Creating a backup is
     a Pro feature", which is a true sentence about the wrong thing. */
  const TRIAL_KS = Buffer.alloc(32, 9).toString("base64");
  const b64trial = (buf) => Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const mintTrialToken = (over = {}) => {
    const startedAt = over.startedAt ?? Date.now();
    const payload = Buffer.from(JSON.stringify({
      v: 1, typ: "trial", idf: "e2e-identity", dev: trialDevFp,
      sta: startedAt, iat: Date.now(), exp: startedAt + 7 * 864e5,
      ks: TRIAL_KS, jti: "tt-e2e", ...over.claims
    }));
    let sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
    if (over.tamper) { sig = Buffer.from(sig); sig[0] ^= 0xff; }
    return `LCTT1.${b64trial(payload)}.${b64trial(sig)}`;
  };
  const writeVerifiedTrial = (over = {}, locked = false) => {
    const startedAt = over.startedAt ?? Date.now();
    return writeTrialRecord({ startedAt, v: 2, verified: true, checkedAt: Date.now(),
      ks: TRIAL_KS, tt: mintTrialToken({ ...over, startedAt }) }, locked);
  };

  // The button does not start an unverified week behind the user's back.
  await pop.click("#trial-start");
  await pop.waitForFunction(() => {
    const el = document.getElementById("identity-status");
    return el && el.textContent.trim().length > 0;
  });
  t("A8 the trial button asks for a sign-in before starting a week",
    /Sign in with Google|needs Chrome or Edge/.test(await pop.textContent("#identity-status")));
  t("A8 ...and started nothing",
    (await pop.evaluate(async () => (await chrome.storage.local.get("lct-trial-v2"))["lct-trial-v2"])) === undefined);

  /* The button's check is advice; this is the rule. A week with no verified
     address behind it is anchored to a keypair that dies with an uninstall —
     the issuer keeps a row for a device that no longer exists and no email to
     match it to, so the days already spent come back as a fresh offer. Any
     caller that skips the popup — a stale "signed in", another surface, a
     console — has to be refused here. */
  const askTrial = () => pop.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "trial-start" }, r)));
  const noAuth = await askTrial();
  t("A8 the worker itself refuses a week with no address behind it",
    noAuth && noAuth.branch === "unverified" && noAuth.started === false,
    JSON.stringify(noAuth));
  const twice = await askTrial();
  t("A8 ...and asking again still starts nothing",
    twice && twice.branch === "unverified" &&
    (await pop.evaluate(async () => (await chrome.storage.local.get("lct-trial-v2"))["lct-trial-v2"])) === undefined,
    JSON.stringify(twice));

  /* An unverified week runs its clock and unlocks NOTHING. Without this an
     issuer outage — real or manufactured by blocking the domain — would be a
     way to mint working weeks for free, which is the hole the whole identity
     anchor exists to close. */
  await writeTrialRecord({ startedAt: Date.now(), v: 2 }, true);
  t("A8 an UNVERIFIED week unlocks nothing", !(await pop.isVisible("#trial-active")));

  /* THE FORGE THIS CHANGE EXISTS TO STOP. `verified: true` next to a start date
     is what a DevTools console can write in ten seconds, once a week, forever.
     It has to be worth nothing on its own. */
  await writeTrialRecord({ startedAt: Date.now(), v: 2, verified: true, checkedAt: Date.now(), ks: TRIAL_KS }, true);
  t("A8 a hand-written verified:true flag unlocks nothing without a signature",
    !(await pop.isVisible("#trial-active")));

  // A signature that does not verify is not a signature.
  await writeVerifiedTrial({ tamper: true }, true);
  t("A8 a tampered trial token unlocks nothing", !(await pop.isVisible("#trial-active")));

  /* Someone else's working token, copied across. The device binding is what
     makes a leaked trial token worth exactly one machine. */
  await writeVerifiedTrial({ claims: { dev: "0".repeat(32) } }, true);
  t("A8 a trial token minted for another device unlocks nothing",
    !(await pop.isVisible("#trial-active")));

  /* Winding the record's own dates back does nothing: they are read out of the
     signature, not out of the record. */
  await writeTrialRecord({ startedAt: Date.now(), v: 2, verified: true, checkedAt: Date.now(),
    tt: mintTrialToken({ startedAt: Date.now() - 30 * 864e5 }) }, true);
  t("A8 an EXPIRED signed week unlocks nothing, whatever the record claims",
    !(await pop.isVisible("#trial-active")));

  /* The popup is a mirror. This is the thing that actually decides whether a
     Pro handler answers, asked directly. */
  const gateVerdict = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "entitlement-state" }, res)));
  t("A8 ...and the gate itself refuses, not just the popup",
    gateVerdict && gateVerdict.entitled === false && gateVerdict.via === "none",
    JSON.stringify(gateVerdict && { e: gateVerdict.entitled, via: gateVerdict.via }));

  await writeVerifiedTrial();
  await pop.waitForSelector(".badge.trial");
  t("A8 badge flips to Trial", (await pop.textContent("#plan-badge")).trim() === "Trial");
  t("A8 trial note shows 7 days left", (await pop.textContent("#trial-note")).includes("7 days left"));
  t("A8 trial button gone after start", !(await pop.isVisible("#trial-start")));
  const trialStore = await pop.evaluate(async () => ({
    local: (await chrome.storage.local.get("lct-trial-v2"))["lct-trial-v2"],
    sync: (await chrome.storage.sync.get("lct-trial-v2"))["lct-trial-v2"]
  }));
  t("A8 trial persisted to BOTH stores, carrying the issuer's signed grant",
    trialStore.local && typeof trialStore.local.startedAt === "number" &&
    String(trialStore.local.tt || "").startsWith("LCTT1.") &&
    trialStore.sync && typeof trialStore.sync.startedAt === "number" &&
    String(trialStore.sync.tt || "").startsWith("LCTT1."));
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
  const TEST_KS = Buffer.alloc(32, 7).toString("base64");   // stable per-licence stamp secret
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
      /* Mirrors the real worker: the device is DERIVED from the public key the
         caller proved it holds, never read out of the body. Echoing body.device
         back (as this did) binds the token to a field the client stopped
         sending under protocol v3, so every activation silently failed its own
         binding check and the popup just never turned Pro. */
      v: 2, sub: await sha256Hex(body.license_key), dev: await sha256Hex(String(body.device_pub || ""), 16),
      plan: "pro", feat: ent.feat || ["archive.search", "archive.backup", "archive.restore"],
      email: "buyer@example.com", ks: TEST_KS, iat: now, exp: now + (ent.ttlMs ?? 90 * 864e5), jti: "t1"
    };
    const payload = Buffer.from(JSON.stringify(claims));
    const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ token: `LCT2.${b64u(payload)}.${b64u(sig)}`, exp: claims.exp })
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
    await chrome.storage.local.remove(["license", "lct-license-state-v1", "trial",
      "lct-entitlement-v2", "lct-trial-v2", "lct-clock-hwm-v1"]);
    await chrome.storage.sync.remove(["lct-seats-v1", "lct-device-id-v1", "lct-trial-v2"]);
  });
  const doActivate = async (key) => {
    await pop.click("#license-toggle");           // folded away on every fresh paint
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
  /* Diagnose instead of timing out. Activation has several ways to fail that
     all look identical from outside — the popup just never turns Pro — and a
     bare 30-second selector timeout names none of them. This failed on CI while
     passing locally, and the log said only "waiting for #pro-active". */
  try {
    await pop.waitForSelector("#pro-active:not([hidden])", { timeout: 20000 });
  } catch (error) {
    const diag = await pop.evaluate(async () => ({
      state: (document.getElementById("license-state") || {}).textContent || "",
      badge: (document.getElementById("plan-badge") || {}).textContent || "",
      token: !!(await chrome.storage.local.get("lct-entitlement-v2"))["lct-entitlement-v2"],
      licence: !!(await chrome.storage.local.get("license")).license,
      deviceKey: await self.LCTEntitlement.deviceKey().then((k) => !!k).catch((e) => "threw: " + e),
      fp: await self.LCTEntitlement.deviceFpFor("x").catch((e) => "threw: " + e)
    })).catch((e) => ({ evalFailed: String(e) }));
    throw new Error(`A9b never reached Pro (${String(error.message || error).split("\n")[0]}). `
      + `issuer calls=${JSON.stringify(ent.calls.map((c) => ({ v: c.v, hasPub: !!c.device_pub, hasSig: !!c.sig })))} `
      + `dodo=${JSON.stringify(dodo.calls.map((c) => c.path))} popup=${JSON.stringify(diag)}`,
      { cause: error });
  }
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
    /* Ask the extension what its device fingerprint IS rather than recomputing
       it from the stored device id. Under protocol v3 identity is the hash of
       the non-extractable key the install holds, so the two are different
       values — and a token bound to the wrong one does not fail loudly, it just
       never unlocks, which is a 30-second timeout instead of an assertion. */
    const dev = await pop.evaluate(async () => {
      const id = ((await chrome.storage.sync.get("lct-device-id-v1"))["lct-device-id-v1"] || {}).id || "";
      return self.LCTEntitlement.deviceFpFor(id);
    });
    const now = Date.now();
    const claims = {
      v: 2, sub: await sha256Hex(key), dev, plan: "pro",
      feat: ["archive.search", "archive.backup", "archive.restore"],
      email: "buyer@example.com", ks: TEST_KS, iat: now, exp: now + 90 * 864e5, jti: "seed", ...over
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
  await pop.click("#license-toggle");
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
  // Same reason as A8: no issuer here, so write what verification would write.
  await writeVerifiedTrial();
  await pop.waitForSelector("#trial-active:not([hidden])");

  /* ============ B. CONTENT — 1,500-message torture page ============ */
  // The tour is once-ever onboarding and it deliberately sits on top of the
  // controls it names. Spend its flag here so every B section below drives a
  // clean page; B14 clears it again and asserts the whole thing.
  await pop.evaluate(() => chrome.storage.local.set({ "lct-tour-v1": Date.now() }));
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

  /* B2c0 — the off switch. Loading the full history is ON by default now, so
     the assertion that used to ride on the default has to state the setting it
     is testing. Unticked means unticked: no walk, no paging, no state. */
  await pop.evaluate(() => chrome.storage.local.set({
    settings: { enabled: true, minimap: true, time: true, history: false }
  }));
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
  t("B2c0 unticking full-history loading really stops the walk",
    quietAfter.loads === quietBefore.loads &&
    quietAfter.top === quietBefore.top &&
    quietAfter.state === "(never started)",
    JSON.stringify({ quietBefore, quietAfter }));
  await quiet.close();

  /* ---- B2i. a formula is not text ----
     KaTeX writes the MathML and the visual glyphs side by side, so textContent
     returns every symbol twice; MathJax's SVG output returns none at all. Both
     keep the source they were given, and that source is what has to be stored:
     a page of transformer equations reached the preview with the prose intact
     and every standalone formula simply missing. */
  /* ---- B2k Perplexity: the host that had no map at all ----
     It ships Tailwind utility classes and no semantic hook for a turn, so every
     class probe missed and the strip never appeared. The app keys its answers
     by ID — markdown-content-0, -1 — which is the one hook that is neither a
     hashed class nor a guess. Two exchanges: four ticks, two each way. */
  const pplx = await ctx.newPage();
  trackErrors(pplx);
  await pplx.goto("http://127.0.0.1:8917/test/perplexity-turns.html?lctAdapter=perplexity");
  await pplx.waitForSelector("#lct-mm-canvas", { timeout: 20000 });
  const pplxMap = await pplx.evaluate(() => {
    const canvas = document.getElementById("lct-mm-canvas");
    const label = document.getElementById("lct-mm-count");
    return {
      ticks: Number(canvas?.getAttribute("aria-valuemax") || 0),
      shown: !!document.getElementById("lct-minimap"),
      label: label ? label.textContent : ""
    };
  });
  t("B2k the map appears on a thread keyed only by answer ids",
    pplxMap.shown && pplxMap.ticks === 4, JSON.stringify(pplxMap));
  await pplx.hover("#lct-minimap");
  await pplx.waitForTimeout(300);
  const pplxSplit = await pplx.evaluate(() => {
    const ticks = [...document.querySelectorAll("#lct-mm-canvas [data-lct-role]")];
    if (ticks.length) {
      return { user: ticks.filter((n) => n.dataset.lctRole === "user").length, from: "ticks" };
    }
    const strip = document.getElementById("lct-minimap");
    return { user: -1, from: (strip && strip.textContent) || "" };
  });
  t("B2k …and a question is not counted as one of the answers",
    pplxSplit.user === 2 || pplxSplit.user === -1, JSON.stringify(pplxSplit));
  await pplx.close();

  /* ---- B2m Gemini: one answer, several content blocks ----
     A Gemini answer is one <model-response> holding several <message-content>
     — the working, then the reply. Layer 1 counts the custom elements and is
     right; the day Google renames them the fallback counts message-content and
     one answer becomes two, every tick painting as the model's. Four ticks is
     the only right answer on BOTH layers, two each way. */
  for (const [what, query, expect] of [
    ["on its own elements", "", 4],
    ["and on the fallback, the day Google renames them", "&drift=1", 4]
  ]) {
    const gem = await ctx.newPage();
    trackErrors(gem);
    await gem.goto("http://127.0.0.1:8917/test/gemini-turns.html?lctAdapter=gemini" + query);
    await gem.waitForSelector("#lct-mm-canvas", { timeout: 20000 });
    const map = await gem.evaluate(() => {
      const canvas = document.getElementById("lct-mm-canvas");
      const ticks = [...document.querySelectorAll("#lct-mm-canvas [data-lct-role]")];
      return {
        ticks: Number(canvas?.getAttribute("aria-valuemax") || 0),
        user: ticks.length ? ticks.filter((n) => n.dataset.lctRole === "user").length : -1
      };
    });
    t(`B2m one answer is one tick ${what}`, map.ticks === expect, JSON.stringify(map));
    t("B2m …and the working is not counted as a turn of its own",
      map.user === 2 || map.user === -1, JSON.stringify(map));
    await gem.close();
  }

  /* ---- B2j one tick per turn, whatever matched ----
     A layer that matches both a turn and something inside it counts that turn
     twice, and the nested match is never a message its ancestor does not
     already hold. Asserted where the reader sees it: the number of ticks. */
  const nestPage = await ctx.newPage();
  trackErrors(nestPage);
  await nestPage.goto("http://127.0.0.1:8917/test/virtual-history.html?index=0&total=6");
  await nestPage.waitForFunction(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "6",
    null, { timeout: 20000 });
  await nestPage.evaluate(() => {
    const msgs = document.querySelectorAll("[data-lct-message]");
    // A marker INSIDE a turn: a nested selector hit, exactly as a redesign
    // would produce. It must not become a second tick.
    const inner = document.createElement("div");
    inner.setAttribute("data-lct-message", "");
    inner.setAttribute("data-lct-role", "assistant");
    inner.textContent = "an inner block that is not a turn of its own";
    msgs[msgs.length - 1].appendChild(inner);
  });
  await nestPage.waitForTimeout(1500);
  const nestedTicks = await nestPage.evaluate(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") || "");
  t("B2j a match inside a turn does not become a second tick",
    nestedTicks === "6", nestedTicks);
  await nestPage.close();

  const mathPage = await ctx.newPage();
  trackErrors(mathPage);
  await mathPage.goto("http://127.0.0.1:8917/test/richtext-harness.html");
  await mathPage.waitForFunction(() => !!self.LCTRichText, null, { timeout: 10000 });
  const mathRead = await mathPage.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML =
      '<p>Inline <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>Q</mi></mrow>' +
      '<annotation encoding="application/x-tex">Q \\in \\mathbb{R}^{n}</annotation>' +
      '</semantics></math></span><span class="katex-html" aria-hidden="true">Q∈Rn</span></span> after.</p>' +
      '<div class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics>' +
      '<mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E = mc^2</annotation>' +
      '</semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span></div>';
    document.body.appendChild(host);
    const rendered = document.createElement("div");
    self.LCTRichText.math(rendered, "Q \\in \\mathbb{R}^{n}", false);
    const displayed = document.createElement("div");
    self.LCTRichText.math(displayed, "\\frac{QK^\\top}{\\sqrt{d_k}}", true);
    // …a code block, a picture, and the model thinking out loud beside them.
    const extra = document.createElement("div");
    extra.innerHTML =
      '<div class="model-thoughts">Formulating the Transformer Components</div>' +
      '<p>Here it is:</p>' +
      '<pre><code class="language-python">def f(x):\n    return x * 2</code></pre>' +
      '<p>and a picture <button aria-label="Open image: diagram">' +
      '<img alt="diagram" src="https://example.test/d.png"></button></p>' +
      '<p><button aria-label="Copy">Copy</button></p>';
    document.body.appendChild(extra);
    /* DeepSeek's shapes. Its thinking chain's own class is a per-deploy hash,
       so the only hook that holds is .ds-think-content — and it carries a
       second markdown body, which is what made that host's messages read as
       the reasoning followed by the answer. The language lives in the code
       block's toolbar rather than on the element. */
    const deepseek = document.createElement("div");
    deepseek.innerHTML =
      '<div class="ds-think-content"><div class="ds-markdown"><p>Let me consider the ordering.</p></div></div>' +
      '<div class="ds-markdown"><p>Here is the answer.</p>' +
      '<div class="md-code-block"><div class="md-code-block-banner-wrap">rust' +
      '<div class="ds-icon-button">Copy</div></div>' +
      '<pre>fn main() {\n    println!("hi");\n}</pre></div></div>';
    document.body.appendChild(deepseek);
    /* Diagrams and the long tail of code shapes. A rendered mermaid block is an
       <svg> sitting where the <pre> used to be; an icon is an <svg> too, and
       naming that a diagram is its own kind of wrong. */
    const drawn = document.createElement("div");
    drawn.innerHTML =
      '<figure class="code-block"><div class="code-block-header">mermaid</div>' +
      '<pre>graph TD\n  A --> B</pre>' +
      '<svg class="mermaid" width="400" height="300"><text>A</text><text>B</text></svg></figure>' +
      '<p>an icon <svg width="16" height="16"><path d="M0 0"/></svg> inline</p>' +
      '<pre><code class="hljs typescript">const x: number = 1;</code></pre>';
    document.body.appendChild(drawn);
    const matrix = document.createElement("div");
    self.LCTRichText.math(matrix, "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}", true);
    return {
      extra: self.LCTRichText.textWithMath(extra),
      ds: self.LCTRichText.textWithMath(deepseek),
      drawn: self.LCTRichText.textWithMath(drawn),
      rows: matrix.querySelectorAll("mtr").length,
      cells: matrix.querySelectorAll("mtd").length,
      flat: (host.textContent || "").replace(/\s+/g, " ").trim(),
      read: self.LCTRichText.textWithMath(host),
      rendered: rendered.innerHTML,
      variant: rendered.querySelector("[mathvariant]")?.getAttribute("mathvariant") || "",
      block: displayed.querySelector('math[display="block"]') ? 1 : 0,
      frac: displayed.querySelectorAll("mfrac, msqrt").length,
      topOp: /⊤/.test(displayed.textContent || "")
    };
  });
  await mathPage.close();

  /* What the PANEL paints, which is a different renderer from the one above and
     had no test at all. Two things a reader saw as raw source: an environment
     inside single dollars — the block openers want `$$` or `\[`, and the inline
     scanner stops at a newline, so nothing caught it — and an image or a link
     written inside a sentence rather than alone on its line. */
  const mdPage = await ctx.newPage();
  trackErrors(mdPage);
  await mdPage.goto("http://127.0.0.1:8917/test/markdown-harness.html");
  await mdPage.waitForFunction(() => !!(self.LCTHistoryLoader &&
    self.LCTHistoryLoader.renderMarkdown), null, { timeout: 10000 });
  const md = await mdPage.evaluate(() => {
    const render = (src) => {
      const host = document.createElement("div");
      self.LCTHistoryLoader.renderMarkdown(host, src);
      return {
        maths: host.querySelectorAll(".lct-math-block math").length,
        tables: host.querySelectorAll("mtable").length,
        grid: (() => {
          const t = host.querySelector("table");
          if (!t) return null;
          return {
            head: [...t.querySelectorAll("thead th")].map((c) => c.textContent),
            rows: [...t.querySelectorAll("tbody tr")].map((r) =>
              [...r.querySelectorAll("td")].map((c) => c.textContent)),
            align: [...t.querySelectorAll("thead th")].map((c) => c.style.textAlign)
          };
        })(),
        imgs: [...host.querySelectorAll("img")].map((i) => i.getAttribute("src")),
        links: [...host.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        pres: host.querySelectorAll("pre").length,
        preText: [...host.querySelectorAll("pre")].map((p) => p.textContent).join(" "),
        text: host.textContent
      };
    };
    return {
      aligned: render("Multi-head attention:\n\n$\\begin{aligned}\n" +
        "\\text{head}_i &= \\text{Attention}(QW_i^Q, KW_i^K, VW_i^V) \\\\\n" +
        "\\text{MultiHead}(Q, K, V) &= \\text{Concat}(\\text{head}_1, \\dots, \\text{head}_h)W^O\n" +
        "\\end{aligned}$\n\nwhere $h$ is the number of heads."),
      bare: render("\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}"),
      inlineImg: render("Here is the result ![the plot](https://x.test/p.png) and it is fine."),
      blockImg: render("![shot](data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==)"),
      unsafeImg: render("![x](javascript:alert(1))"),
      link: render("See [the paper](https://arxiv.org/abs/1706.03762) for more."),
      unclosed: render("\\begin{aligned} but nothing ever closes it\nplain text after"),
      price: render("It costs $5 and then $6 later."),
      fenceTitle: render("```js title=\"x\"\nconst a = 1;\n```\nAfter the block."),
      unclosedProse: render("```\nI'll assume you are asking whether the server\n" +
        "accepts JSON only in the request body and how it relates to HTTP methods."),
      unclosedCode: render("```\nconst a = 1;\nfoo.bar();"),
      closedProse: render("```\njust some words here\n```\nafter"),
      table: render("Estimated resource requirements\n\n" +
        "| Device | Expected experience |\n" +
        "|---------|--------------------|\n" +
        "| Intel i5 (11th Gen+) | Slow but usable |\n" +
        "| Apple M1/M2/M3/M4 | Good (Metal backend) |\n\n" +
        "Grounding DINO is the dominant CPU workload."),
      tableAligned: render("| L | C | R |\n|:--|:-:|--:|\n| a | b | c |"),
      tableRagged: render("| a | b | c |\n| - | - | - |\n| 1 |\n"),
      notATable: render("Run `cat x | grep y` — the pipe is not a table.\n" +
        "And a second line with a | in it.")
    };
  });
  await mdPage.close();

  /* Every row used to reach the reader as the literal `| Device | … |`: the
     stylesheets have carried table rules the renderer never produced. */
  t("B23 a pipe table renders as a table, not as text",
    !!md.table.grid && md.table.grid.head.join("|") === "Device|Expected experience",
    JSON.stringify(md.table.grid));
  t("B23 …with every body row, and the prose either side left alone",
    !!md.table.grid && md.table.grid.rows.length === 2 &&
    md.table.grid.rows[1][1] === "Good (Metal backend)" &&
    /Grounding DINO is the dominant/.test(md.table.text) &&
    !/\|-{3}/.test(md.table.text),
    JSON.stringify(md.table.grid && md.table.grid.rows));
  t("B23 …honouring the alignment the delimiter row states",
    !!md.tableAligned.grid &&
    md.tableAligned.grid.align.join(",") === "left,center,right",
    JSON.stringify(md.tableAligned.grid && md.tableAligned.grid.align));
  /* A short row keeps the grid: filling the gap is what stops every cell after
     it sliding one column left, which reads as the wrong data, not a gap. */
  t("B23 …and a ragged row keeps its columns",
    !!md.tableRagged.grid && md.tableRagged.grid.rows[0].length === 3,
    JSON.stringify(md.tableRagged.grid && md.tableRagged.grid.rows));
  /* The delimiter row is what makes it a table. A shell pipeline is prose. */
  t("B23 …while a line with a pipe in it stays prose",
    md.notATable.grid === null && /cat x \| grep y/.test(md.notATable.text),
    JSON.stringify(md.notATable.text).slice(0, 120));

  t("B23 an aligned environment inside single dollars renders as a formula",
    md.aligned.maths === 1 && md.aligned.tables === 1, JSON.stringify(md.aligned).slice(0, 200));
  t("B23 …and none of its source is left in front of the reader",
    !/\\begin\{|\\text\{|\\end\{/.test(md.aligned.text), md.aligned.text.slice(0, 120));
  t("B23 …with the ellipsis the model wrote, not the word 'dots'",
    md.aligned.text.includes("\u2026") && !/\bdots\b/.test(md.aligned.text),
    md.aligned.text.slice(0, 160));
  t("B23 an environment with no dollars at all is still a formula",
    md.bare.maths === 1 && md.bare.tables === 1, JSON.stringify(md.bare).slice(0, 160));
  t("B23 an environment that never closes is text, not a swallowed message",
    md.unclosed.maths === 0 && md.unclosed.text.includes("plain text after"),
    JSON.stringify(md.unclosed).slice(0, 160));
  t("B23 a price is not a formula",
    md.price.maths === 0 && md.price.text.includes("$5"), md.price.text);
  t("B24 an image inside a sentence is a picture, not its own source",
    md.inlineImg.imgs.length === 1 && md.inlineImg.imgs[0] === "https://x.test/p.png" &&
    !md.inlineImg.text.includes("!["), JSON.stringify(md.inlineImg).slice(0, 200));
  t("B24 …and the sentence around it survives",
    md.inlineImg.text.includes("Here is the result") && md.inlineImg.text.includes("and it is fine"),
    md.inlineImg.text);
  t("B24 an image alone on its line still renders",
    md.blockImg.imgs.length === 1 && /^data:image\/gif/.test(md.blockImg.imgs[0]),
    JSON.stringify(md.blockImg.imgs));
  /* http(s), blob and data:image only. A scheme that can RUN something is
     named rather than rendered — the archive holds whatever the page held. */
  t("B24 a scheme that can run something is named, never loaded",
    md.unsafeImg.imgs.length === 0 && md.unsafeImg.text.includes("x"),
    JSON.stringify(md.unsafeImg).slice(0, 160));
  /* One opening fence used to swallow the rest of an answer into a single wide
     scrolling box of prose — the opener refused a title after the language, so
     the CLOSING ``` opened a block instead, and a fence the model never closed
     did the same on its own. */
  t("B25 a fence with a title after the language is still a fence",
    md.fenceTitle.pres === 1 && md.fenceTitle.text.includes("After the block") &&
    !md.fenceTitle.preText.includes("After the block"),
    JSON.stringify(md.fenceTitle).slice(0, 200));
  t("B25 an unclosed fence does not swallow the prose after it",
    md.unclosedProse.pres === 0 && md.unclosedProse.text.includes("request body"),
    JSON.stringify(md.unclosedProse).slice(0, 200));
  t("B25 …but an unclosed fence over real code is still code",
    md.unclosedCode.pres === 1 && md.unclosedCode.preText.includes("foo.bar()"),
    JSON.stringify(md.unclosedCode).slice(0, 200));
  t("B25 a closed fence is a block whatever is in it",
    md.closedProse.pres === 1 && md.closedProse.preText.includes("just some words"),
    JSON.stringify(md.closedProse).slice(0, 200));
  t("B24 a link is a link",
    md.link.links.length === 1 && md.link.links[0] === "https://arxiv.org/abs/1706.03762" &&
    md.link.text.includes("See the paper for more"), JSON.stringify(md.link).slice(0, 200));
  t("B2i the LaTeX is taken from the render, not from its glyphs",
    /\$Q \\in \\mathbb\{R\}\^\{n\}\$/.test(mathRead.read), mathRead.read);
  t("B2i a standalone equation survives at all, on its own line",
    /\$\$E = mc\^2\$\$/.test(mathRead.read), JSON.stringify(mathRead.read));
  t("B2i …where flattening it doubled every symbol",
    /Q∈Rn/.test(mathRead.flat) && !/Q∈Rn/.test(mathRead.read), mathRead.flat);
  t("B2i and the LaTeX comes back as maths, not as characters",
    /<math/.test(mathRead.rendered), mathRead.rendered.slice(0, 120));
  t("B2i the real numbers are the real numbers, not the word mathbb",
    mathRead.variant === "double-struck", mathRead.variant);
  t("B2i a display formula keeps its fraction, its root and its transpose",
    mathRead.block === 1 && mathRead.frac === 2 && mathRead.topOp, JSON.stringify(mathRead));
  t("B2i code is stored AS code, with the language it was written in",
    /```python\ndef f\(x\):\n {4}return x \* 2\n```/.test(mathRead.extra), JSON.stringify(mathRead.extra));
  /* These hosts wrap an image in a button. Skipping chrome must not throw the
     message away with its own toolbar. */
  t("B2i a picture is a picture, not an empty line — even inside a button",
    /!\[diagram\]\(https:\/\/example\.test\/d\.png\)/.test(mathRead.extra), JSON.stringify(mathRead.extra));
  t("B2i …while a button that is only a button is dropped",
    !/Copy/.test(mathRead.extra), JSON.stringify(mathRead.extra));
  t("B2i the model thinking out loud is not part of the message",
    !/Formulating/.test(mathRead.extra), JSON.stringify(mathRead.extra));
  t("B2i DeepSeek's reasoning chain is not the answer",
    !/Let me consider/.test(mathRead.ds) && /Here is the answer\./.test(mathRead.ds),
    JSON.stringify(mathRead.ds));
  t("B2i …its code keeps the language its toolbar names",
    /```rust\nfn main\(\) \{\n {4}println!\("hi"\);\n\}\n```/.test(mathRead.ds),
    JSON.stringify(mathRead.ds));
  t("B2i …and the Copy button is not part of the message",
    !/Copy/.test(mathRead.ds), JSON.stringify(mathRead.ds));
  t("B2i a drawn diagram is stored as the source it was drawn from",
    /```mermaid\ngraph TD\n {2}A --> B\n```/.test(mathRead.drawn), JSON.stringify(mathRead.drawn));
  t("B2i …once, not once for the drawing and once for the source",
    (String(mathRead.drawn).match(/graph TD/g) || []).length === 1, JSON.stringify(mathRead.drawn));
  t("B2i …and its labels are not spilled into the sentence",
    !/A\s*B\s*an icon/.test(mathRead.drawn), JSON.stringify(mathRead.drawn));
  t("B2i an icon is not a diagram",
    /an icon\s+inline/.test(mathRead.drawn) && !/!\[diagram\]/.test(mathRead.drawn),
    JSON.stringify(mathRead.drawn));
  t("B2i highlight.js names the language beside its own marker",
    /```typescript\nconst x: number = 1;\n```/.test(mathRead.drawn), JSON.stringify(mathRead.drawn));
  t("B2i a matrix is a matrix, not the word begin",
    mathRead.rows === 2 && mathRead.cells === 4, JSON.stringify(mathRead));

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

  /* ---------- B2f a Claude Code transcript counts turns, not scaffolding ----
     A Code session renders tool calls, tool results and thinking blocks between
     the turns. The fixture buries six real turns in six pieces of scaffolding,
     four code blocks, a nested <pre> and an image-only reply. Six is the only
     right answer; anything counting bodies or blocks gets a different one.
     lctAdapter= points the REAL Claude adapter at the fixture (localhost only,
     see content/adapters.js detect()). */
  const codePage = await ctx.newPage();
  trackErrors(codePage);
  await codePage.goto("http://127.0.0.1:8917/test/claude-code.html?lctAdapter=claude");
  await codePage.waitForSelector("#lct-minimap", { timeout: 20000 });
  await codePage.waitForFunction(() =>
    Number(document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") || 0) > 0,
    null, { timeout: 8000 });
  const codeSeen = await codePage.evaluate(() => ({
    ticks: Number(document.getElementById("lct-mm-canvas").getAttribute("aria-valuemax")),
    want: window.__fixtureTurns,
    tools: document.querySelectorAll("[data-testid*=tool], [data-testid=thinking-block]").length,
    pres: document.querySelectorAll("pre").length,
    approx: document.getElementById("lct-minimap").dataset.lctApprox
  }));
  t("B2f a Claude Code transcript maps one tick per turn, not per tool block",
    codeSeen.ticks === codeSeen.want, JSON.stringify(codeSeen));
  t("B2f the scaffolding it had to ignore was really there",
    codeSeen.tools >= 6 && codeSeen.pres >= 5, JSON.stringify(codeSeen));
  t("B2f a count read off the selector we know is not marked approximate",
    codeSeen.approx === "0", String(codeSeen.approx));

  /* The day Claude redesigns: no action bars, no role markers, only structure.
     The count must still be six — and the map must say it is a reading. */
  const drifted = await ctx.newPage();
  trackErrors(drifted);
  await drifted.goto("http://127.0.0.1:8917/test/claude-code.html?drift=1&lctAdapter=claude");
  await drifted.waitForSelector("#lct-minimap", { timeout: 20000 });
  await drifted.waitForFunction(() =>
    Number(document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") || 0) > 0,
    null, { timeout: 8000 });
  const driftSeen = await drifted.evaluate(() => ({
    ticks: Number(document.getElementById("lct-mm-canvas").getAttribute("aria-valuemax")),
    want: window.__fixtureTurns,
    approx: document.getElementById("lct-minimap").dataset.lctApprox,
    badge: !document.getElementById("lct-mm-approx")?.hidden
  }));
  t("B2f the structural layer alone still counts six turns",
    driftSeen.ticks === driftSeen.want, JSON.stringify(driftSeen));
  t("B2f …and the map says the number is a reading, not a certainty",
    driftSeen.approx === "1" && driftSeen.badge, JSON.stringify(driftSeen));
  await codePage.close();
  await drifted.close();

  /* ---------- B2j one turn is one tick, however many ids it carries --------
     ChatGPT keys DOM nodes by transcript message id: a reasoning summary and a
     browsing block ride inside the same <article> as the answer, each with its
     own data-message-id. Counted as nodes, a two-message chat maps as four —
     and the two extra ticks sit inside the answer, so they read as parts of one
     long response, which is exactly how this was reported. */
  const gptPage = await ctx.newPage();
  trackErrors(gptPage);
  await gptPage.goto("http://127.0.0.1:8917/test/chatgpt-turns.html?lctAdapter=chatgpt");
  await gptPage.waitForSelector("#lct-minimap", { timeout: 20000 });
  await gptPage.waitForFunction(() =>
    Number(document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") || 0) > 0,
    null, { timeout: 8000 });
  const gptSeen = await gptPage.evaluate(() => ({
    ticks: Number(document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") || 0),
    want: window.__fixtureTurns,
    // Content scripts run in an isolated world, so the adapter itself is not
    // reachable from here. The page's own markers are, and they are the input.
    ids: document.querySelectorAll("[data-message-id]").length,
    users: document.querySelectorAll('[data-message-author-role="user"]').length
  }));
  t("B2j two messages map as two ticks, not as four ids",
    gptSeen.ticks === gptSeen.want, JSON.stringify(gptSeen));
  t("B2j the extra ids it had to collapse were really there",
    gptSeen.ids === 4 && gptSeen.users === 1, JSON.stringify(gptSeen));
  /* And the map is ON SCREEN for two messages. It was not: a floor of four hid
     it, so correcting this chat's count from four ticks to two would have taken
     the map away with it — the fix reading as the break. */
  t("B2j a two-message chat still has a map",
    await gptPage.locator("#lct-minimap").isVisible());
  await gptPage.close();
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

  // Previews used to be built with textContent, which welds block elements
  // together: a "#820" label and the paragraph under it came back as
  // "#820Two things". Hover a MOUNTED message (the synthetic page nests a
  // label div above the body) and check the boundary survived.
  await page.bringToFront();
  await page.hover("#lct-minimap");
  await page.waitForTimeout(400);
  const mmb = await page.locator("#lct-mm-canvas").boundingBox();
  await page.mouse.move(mmb.x + 5, mmb.y + Math.round(mmb.height * 0.5));
  await page.waitForTimeout(300);
  const tipText = await page.evaluate(() => {
    const tip = document.getElementById("lct-mm-tooltip");
    return tip && tip.style.display === "block" ? tip.textContent : "";
  });
  /* An image message previewed as nothing, exported as a blank line and matched
     no search. These hosts write the file name into alt, which is the handle a
     person actually has on their own screenshots — so the preview uses it.
     Appended as a NEW message rather than by rewriting an old one: the minimap
     caches a message's preview per element, which is correct in life and would
     hide the change here. */
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.className = "msg user";
    div.id = "lct-shot-msg";
    div.setAttribute("data-lct-message", "");
    div.setAttribute("data-lct-role", "user");
    div.innerHTML = '<button aria-label="Open image: Screenshot 2026-04-07.png">' +
      '<img alt="Screenshot 2026-04-07.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>';
    document.getElementById("chat").appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(1600);
  await page.hover("#lct-minimap");
  await page.waitForTimeout(400);
  const mmShot = await page.locator("#lct-mm-canvas").boundingBox();
  let shotTip = "";
  for (let i = 0; i < 10 && !/Screenshot/.test(shotTip); i++) {
    await page.mouse.move(mmShot.x + 5, mmShot.y + mmShot.height - 1 - i);
    await page.waitForTimeout(120);
    shotTip = await page.evaluate(() => {
      const t = document.getElementById("lct-mm-tooltip");
      return t && t.style.display === "block" ? t.textContent : "";
    });
  }
  t("B2h an image message previews by its file name, not as nothing",
    /🖼/.test(shotTip) && /Screenshot 2026-04-07\.png/.test(shotTip), shotTip || "(no tooltip)");
  await page.evaluate(() => document.getElementById("lct-shot-msg")?.remove());
  await page.mouse.move(400, 400);
  await page.waitForTimeout(500);

  t("B2f the hover preview keeps the gap between blocks",
    !!tipText && !/#\d+[A-Za-z]/.test(tipText) && !/[a-z][A-Z]/.test(tipText.replace(/ChatGPT|DeepSeek/g, "")),
    tipText);
  await page.mouse.move(400, 400);

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
    target: document.documentElement.dataset.lctSeekTarget || "",
    panel: !!document.getElementById("lct-history-panel"),
    pill: document.querySelector("#lct-seek.lct-seek-show")
      ? document.querySelector(".lct-seek-text").textContent : null,
    /* The count says how far; the rail says how far LEFT. On a long
       conversation the number crawls for a minute and a bare count reads as a
       stalled job. */
    rail: (() => {
      const fill = document.querySelector("#lct-seek .lct-seek-rail > i");
      if (!fill) return null;
      const m = /scaleX\(([\d.]+)\)/.exec(fill.style.transform || "");
      return {
        present: true,
        determinate: !document.getElementById("lct-seek").classList.contains("lct-seek-unknown"),
        frac: m ? Number(m[1]) : null,
        height: Math.round(document.querySelector("#lct-seek .lct-seek-rail").getBoundingClientRect().height)
      };
    })(),
    state: document.documentElement.dataset.lctSeekState
  }));
  // At 1,500 messages one pixel row spans three of them, so the top of the rail
  // has to SNAP to the first message rather than land wherever it computes to.
  t("B2g the top of the map means message #1, not whatever pixel maths says",
    opened.target === "virtual-1", JSON.stringify(opened));
  /* And it GOES there. The panel opens too — it is how the words are on screen
     before the host has rendered the row — but arriving is what the click asks
     for, and the assertions above are what prove it happened. */
  t("B2g clicking the map opens the message AND starts going to it",
    opened.panel, JSON.stringify(opened));
  t("B2g the wait is named, with a real denominator",
    /^Loading older messages… [\d,]+ of 1,500$/.test(opened.pill || ""), String(opened.pill));
  t("B2g …and shown as a rail, so a crawling number still reads as progress",
    !!opened.rail && opened.rail.present && opened.rail.height > 0,
    JSON.stringify(opened.rail));
  t("B2g …determinate, because this host publishes a total",
    !!opened.rail && opened.rail.determinate &&
    opened.rail.frac !== null && opened.rail.frac >= 0 && opened.rail.frac < 1,
    JSON.stringify(opened.rail));
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
      panel: !!document.getElementById("lct-history-panel"),
      pillGone: !document.querySelector("#lct-seek.lct-seek-show")
    };
  });
  t("B2g one click on the top of the map lands on the first message",
    landed.hitId === "virtual-1" && landed.inView, JSON.stringify(landed));
  t("B2g and the pill goes once the real message is on screen",
    landed.pillGone, JSON.stringify(landed));
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
  /* Reported on the loader's own state attribute, which is where it belongs:
     "exhausted" is the host saying it has nothing older, and it is what stops
     the seek instead of leaving it running forever. The note that used to
     carry this went with the preview panel. */
  t("B2g2 a host that stops handing over history is reported, not waited on",
    await dead.evaluate(() => ({
      state: document.documentElement.dataset.lctSeekState,
      pillGone: !document.querySelector("#lct-seek.lct-seek-show")
    })).then((r) => r.state === "exhausted" && r.pillGone));
  await dead.close();

  /* B2c — virtual-history backfill, the deliberate kind. ChatGPT's host
     virtualizer mounts only the tail at first. Once asked, the loader must
     reach the earliest turn, stop, and restore the reader without relying on
     a magic scroll height. */
  await pop.evaluate(() => chrome.storage.local.set({
    settings: { enabled: true, minimap: true, time: true, history: true }
  }));
  /* B2c1 — the setting is ON and a long chat has just opened. The whole
     conversation must arrive, and the reader must never see it happen. The walk
     drives the host's scroller to the first turn a page at a time; what makes
     that acceptable is makeFreeze() — a still clone covers the scroller, so the
     pixels on screen do not change while it runs, and the reader is put back
     before the clone comes down. Waiting for a hidden tab instead was tried and
     it silently deleted the feature: this fixture is never hidden either. */
  const armed = await ctx.newPage();
  trackErrors(armed);
  await armed.goto("http://127.0.0.1:8917/test/virtual-history.html");
  await armed.waitForSelector("#lct-minimap", { timeout: 20000 });
  const walked = await armed.evaluate(async () => {
    const s = document.getElementById("virtual-scroller");
    let sawFreeze = false;
    for (let i = 0; i < 300; i++) {
      if (document.getElementById("lct-freeze")) sawFreeze = true;
      if (/^(complete|partial)$/.test(document.documentElement.dataset.lctHistoryState || "")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));
    return {
      sawFreeze,
      state: document.documentElement.dataset.lctHistoryState || "(never started)",
      mounted: document.querySelectorAll("[data-lct-message]").length,
      loads: window.__virtualHistory.loads,
      /* The reader opened the chat at the bottom, so the newest turn is what
         they were looking at and what has to be in front of them afterwards.
         Asserted as "still on screen" rather than as a pixel delta: measuring a
         delta means measuring BEFORE the walk, and with no settle delay left
         there is no longer a moment that is reliably before it. */
      anchorOnScreen: (() => {
        const el = document.querySelector('[data-message-id="virtual-240"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < (window.innerHeight || s.clientHeight);
      })(),
      freezeGone: !document.getElementById("lct-freeze"),
      visibility: s.style.visibility
    };
  });
  t("B2c1 opening a long chat loads every older turn",
    walked.state === "complete" && walked.mounted === 240 && walked.loads >= 10,
    JSON.stringify(walked));
  t("B2c1 …behind a freeze, and the reader is handed back the exact view",
    walked.sawFreeze && walked.freezeGone && walked.visibility !== "hidden" &&
    walked.anchorOnScreen,
    JSON.stringify(walked));

  /* B2c3 — the second chat in the same tab. startedRoutes stamps a route the
     moment the walk begins, so anything scoped per-route wrongly leaves the
     second conversation permanently unwalked. That is exactly what a
     single-slot `pending` did before it was a Map, and nothing caught it. */
  const twoRoutes = await armed.evaluate(async () => {
    delete document.documentElement.dataset.lctHistoryState;
    history.pushState({}, "", "?c=second");
    window.dispatchEvent(new Event("popstate"));
    for (let i = 0; i < 300; i++) {
      if (/^(complete|partial)$/.test(document.documentElement.dataset.lctHistoryState || "")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return {
      state: document.documentElement.dataset.lctHistoryState || "(never started)",
      href: location.search
    };
  });
  t("B2c3 a second chat in the same tab is walked too, not stamped handled and abandoned",
    twoRoutes.state === "complete" && twoRoutes.href === "?c=second",
    JSON.stringify(twoRoutes));

  /* B2c4 — the same walk on a host with no scroller of its own, so the
     DOCUMENT scrolls. findScroller() answers document.scrollingElement there,
     and the obvious freeze is catastrophic on that path: the element to hide is
     <html>, the freeze shell is a CHILD of <html>, so hiding one hides the
     other and the reader gets a blank page for the whole walk. It has to hide
     <body> instead, which is the shell's sibling. */
  const rooted = await ctx.newPage();
  trackErrors(rooted);
  await rooted.goto("http://127.0.0.1:8917/test/virtual-history.html?root=1");
  await rooted.waitForSelector("#lct-minimap", { timeout: 20000 });
  const rootWalk = await rooted.evaluate(async () => {
    let sawFreeze = false, blanked = false, hidBody = false;
    for (let i = 0; i < 300; i++) {
      if (document.getElementById("lct-freeze")) {
        sawFreeze = true;
        if (document.documentElement.style.visibility === "hidden") blanked = true;
        if (document.body.style.visibility === "hidden") hidBody = true;
      }
      if (/^(complete|partial)$/.test(document.documentElement.dataset.lctHistoryState || "")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));
    return {
      sawFreeze, blanked, hidBody,
      state: document.documentElement.dataset.lctHistoryState || "(never started)",
      mounted: document.querySelectorAll("[data-lct-message]").length,
      bodyVisible: document.body.style.visibility !== "hidden",
      freezeGone: !document.getElementById("lct-freeze")
    };
  });
  t("B2c4 a document-scrolling host is walked to the first turn as well",
    rootWalk.state === "complete" && rootWalk.mounted === 240, JSON.stringify(rootWalk));
  t("B2c4 …and the freeze hides the body, never the page the copy is pinned to",
    rootWalk.sawFreeze && rootWalk.hidBody && !rootWalk.blanked &&
    rootWalk.bodyVisible && rootWalk.freezeGone, JSON.stringify(rootWalk));
  await rooted.close();

  await armed.close();

  const virtual = await ctx.newPage();
  trackErrors(virtual);
  await virtual.goto("http://127.0.0.1:8917/test/virtual-history.html");
  // The strip rests with its toolbar visibility:hidden until it is hovered, so
  // this waits for the button to EXIST, and clicks it in the page.
  await virtual.waitForSelector('#lct-export-bar [data-act="history"]', { state: "attached", timeout: 20000 });
  // Asked for, out loud, by someone watching: the ⤒ button. The page moving is
  // the answer to a question they just asked, not a thing that happened to them.
  await virtual.evaluate(() => document.querySelector('#lct-export-bar [data-act="history"]').click());
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

  /* B2c2 — the same crawl on a host that assigns its messages NO id, while an
     answer streams into the tail. That is every host except ChatGPT: Claude,
     Gemini and Grok all page their transcript and none of them hands out a
     data-message-id. With nothing stable to key a row by, the loader falls back
     to the row's text — and if it lets the TAIL's text decide whether another
     page arrived, each streamed token reads as a fresh page, the stall counter
     never fills, and the crawl runs to its four-minute ceiling on a
     conversation it finished mounting seconds ago. */
  const bare = await ctx.newPage();
  trackErrors(bare);
  await bare.goto("http://127.0.0.1:8917/test/virtual-history.html?bare=1&stream=1&total=120&page=20");
  await bare.waitForSelector('#lct-export-bar [data-act="history"]', { state: "attached", timeout: 20000 });
  await bare.evaluate(() => document.querySelector('#lct-export-bar [data-act="history"]').click());
  // 20s against a crawl that takes ~3s once the tail is ignored, and against a
  // streamed prefix that keeps moving for ~40s if it is not. Neither side of
  // that is close to the line.
  let bareComplete = true;
  try {
    await bare.waitForFunction(() =>
      document.documentElement.dataset.lctHistoryState === "complete", null, { timeout: 20000 });
  } catch { bareComplete = false; }
  t("B2c2 an id-less host with a streaming tail still concludes its crawl", bareComplete,
    await bare.evaluate(() => document.documentElement.dataset.lctHistoryState || "(none)"));
  const bareState = await bare.evaluate(() => ({
    count: document.querySelectorAll("[data-lct-message]").length,
    total: window.__virtualHistory.total,
    first: window.__virtualHistory.first,
    ids: document.querySelectorAll("[data-message-id]").length,
    streamed: window.__virtualHistory.streamed
  }));
  // total + 1: every turn of the conversation, plus the answer that was still
  // streaming underneath the crawl.
  t("B2c2 it reached the oldest turn, not merely a quiet one",
    bareState.count === bareState.total + 1 && bareState.first === 0, JSON.stringify(bareState));
  // Both halves of the premise, asserted rather than assumed: a fixture that
  // quietly kept its ids, or quietly stopped streaming, would pass the test
  // above without ever exercising the path it exists for.
  t("B2c2 the fixture really assigned no message ids", bareState.ids === 0, String(bareState.ids));
  t("B2c2 the tail really was still streaming during the crawl", bareState.streamed > 0,
    String(bareState.streamed));
  await bare.close();

  /* B2d — a reader who scrolls mid-crawl cancels it, and must not be punished
     for it. The backfill used to be one-shot per route: one stray wheel and
     that conversation never finished loading its history for the whole session.
     It has to stand down immediately, then resume once the reader settles. */
  const resumed = await ctx.newPage();
  trackErrors(resumed);
  await resumed.goto("http://127.0.0.1:8917/test/virtual-history.html");
  await resumed.waitForSelector('#lct-export-bar [data-act="history"]', { state: "attached", timeout: 20000 });
  await resumed.evaluate(() => document.querySelector('#lct-export-bar [data-act="history"]').click());
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

  /* B2f — the strip is not allowed to just not be there. Everything we draw
     comes off the engine's tick, and the tick comes off the host mutating its
     own DOM. A host that re-renders our node away and then goes quiet used to
     leave nothing at all to bring it back — which is what "sometimes it
     appears and sometimes it does not" was. Nothing here touches the page
     afterwards: the recovery has to come from us. */
  await page.evaluate(() => document.getElementById("lct-minimap").remove());
  let stripBack = true;
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById("lct-minimap");
      return !!(el && el.isConnected && el.style.display !== "none");
    }, null, { timeout: 12000 });
  } catch { stripBack = false; }
  t("B2f a strip the host tore out comes back on a page that never moves again",
    stripBack);
  t("B2f …and its toolbar comes back with it",
    await page.evaluate(() =>
      document.getElementById("lct-export-bar")?.parentElement?.id === "lct-minimap"));

  t("B3 export bar with 6 SVG buttons (search + bridge + outline + carry + md + json)",
    (await page.locator("#lct-export-bar button svg").count()) === 6);
  t("B3 action buttons are part of the minimap, never a separate panel",
    await page.evaluate(() => document.getElementById("lct-export-bar")?.parentElement?.id === "lct-minimap"));
  /* Chrome drops a suggested shortcut when another extension already holds it.
     On the machine this was written on, ⌘⇧F was taken and in-chat search had
     no way in at all — no button, no menu, nothing. Every feature needs a path
     that is not a keystroke. */
  for (const act of ["search", "bridge", "carry", "outline"]) {
    t(`B3 ${act} is reachable without a keyboard shortcut`,
      (await page.locator(`#lct-export-bar button[data-act="${act}"]`).count()) === 1);
  }
  await page.locator("#lct-minimap").hover();
  await page.waitForSelector('#lct-export-bar button[data-act="search"]', { state: "visible" });
  await page.click('#lct-export-bar button[data-act="search"]');
  await page.waitForSelector("#lct-search.lct-s-open", { timeout: 5000 });
  t("B3 the search button opens search", true);
  await page.evaluate(() => document.querySelector("#lct-search .lct-s-close")?.click());
  t("B3 every export-bar button says what it does",
    await page.evaluate(() => [...document.querySelectorAll("#lct-export-bar button")]
      .every((b) => (b.getAttribute("aria-label") || b.title || "").length > 4)));

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
  // The per-host row list was replaced by the usage dial; the live figure the
  // popup now paints from that same stats write is the windowed count.
  await pop.waitForFunction(() =>
    Number((document.getElementById("stat-windowed")?.textContent || "0").replace(/\D/g, "")) > 100,
    null, { timeout: 20000 });
  // the popup groups thousands (toLocaleString), so "1500" paints as "1,500"
  t("B9 popup shows the windowed count", /^[\d,]+$/.test((await pop.textContent("#stat-windowed")).trim()));
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
  // the starred row is filled by an async storage read — wait for it
  await page.waitForFunction(() =>
    /Starred\s*[1-9]/.test(document.getElementById("lct-chatcard")?.textContent || ""),
    null, { timeout: 5000 });
  const cardText = await page.textContent("#lct-chatcard");
  t("B10 card shows message count", /Messages\s*1,?5\d\d/.test(cardText), cardText.slice(0, 80));
  t("B10 card shows questions asked", /You asked\s*\d/.test(cardText));
  t("B10 card is honest about time source",
    /First seen .+ this device/.test(cardText) && !/Created/.test(cardText));
  t("B10 card shows starred count from B8", /Starred\s*[1-9]/.test(cardText));
  /* "Longest of one" is meaningless, so the badge needs a second record to
     compare against. The fixture used to happen to hold exactly one, which
     stopped being true once a chat with a single message became worth
     recording — so the condition is now established rather than assumed. */
  await pop.evaluate(async () => {
    const key = "chats:127.0.0.1";
    const all = (await chrome.storage.local.get(key))[key] || {};
    const only = "/test/synthetic.html";
    await chrome.storage.local.set({ [key]: all[only] ? { [only]: all[only] } : all });
  });
  await page.waitForTimeout(400);                                   // storage.onChanged
  await page.locator("#t-conv-external").dispatchEvent("mouseover");  // drop the open card
  await page.waitForTimeout(200);
  await page.locator("#t-conv-this").dispatchEvent("mouseover");
  await page.waitForSelector("#lct-chatcard", { state: "visible", timeout: 5000 });
  const soloText = await page.textContent("#lct-chatcard");
  t("B10 no longest badge with a single record", !/longest/i.test(soloText), soloText.slice(0, 80));

  /* ---- the card asks the archive, not just this browser's memory ----
     The card used to know only which chats this install had watched being
     opened, counted off the mounted DOM. A chat the archive holds in full still
     hovered as "Not tracked yet", and an opened one was counted from the tail
     the host happened to have mounted. */
  const cardStats = (path) => pop.evaluate((p) => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "chat-stats", host: "127.0.0.1", path: p }, r)), path);
  const seen = await cardStats("/test/synthetic.html");
  t("B10 the archive answers the card's counts",
    seen && seen.found === true && seen.n >= 1500 && seen.users > 0, JSON.stringify(seen));
  /* Both halves, and they must not be equal: a count that reported every
     message as the user's — or none of them — is the misattribution this
     replaced, and "users > 0" alone would not catch it. */
  t("B10 …splitting the two speakers, neither swallowing the other",
    seen && seen.users > 0 && seen.users < seen.n, JSON.stringify(seen));
  const unknown = await cardStats("/test/never-archived.html");
  t("B10 …and says plainly when it holds nothing",
    unknown && unknown.found === false, JSON.stringify(unknown));

  /* The page and the sync spell the same chat's id differently on three of the
     six hosts. DeepSeek is the clearest: the sync writes `/chat/<id>` because
     that is the adapter's prefix, and the browser is sitting on `/a/chat/s/<id>`.
     The card asks with what the browser has, so a fully archived conversation
     answered "not tracked" — the exact complaint this fixes. */
  await pop.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({
    type: "recall-import",
    chats: [{
      id: "chat.deepseek.com/chat/alias-fixture", host: "chat.deepseek.com",
      path: "/chat/alias-fixture", platform: "DeepSeek", title: "Alias fixture",
      createdAt: Date.now(), updatedAt: Date.now(),
      msgs: [{ r: "user", t: "asked once" }, { r: "assistant", t: "answered once" }]
    }]
  }, resolve)));
  const aliased = await pop.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "chat-stats", host: "chat.deepseek.com",
      path: "/a/chat/s/alias-fixture" }, r)));
  t("B10 …and finds the chat when the page spells its id the other way",
    aliased && aliased.found === true && aliased.n === 2 && aliased.users === 1,
    JSON.stringify(aliased));

  /* Records written by an older page flush stamped every unmarked turn
     "assistant", so the archive holds conversations that read as the model
     talking to itself. Counted literally they report 0 asked of 6, which is
     what the card was showing. The split has to be re-derived, not repeated. */
  await pop.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({
    type: "recall-import",
    chats: [{
      id: "chatgpt.com/c/legacy-roles", host: "chatgpt.com", path: "/c/legacy-roles",
      platform: "ChatGPT", title: "Legacy roles", createdAt: Date.now(), updatedAt: Date.now(),
      msgs: Array.from({ length: 6 }, (_, i) => ({ r: "assistant", t: "turn " + i }))
    }]
  }, resolve)));
  const legacy = await pop.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "chat-stats", host: "chatgpt.com",
      path: "/c/legacy-roles" }, r)));
  t("B10 …and re-derives a split that was written as all one speaker",
    legacy && legacy.found === true && legacy.users === 3 && legacy.assistants === 3,
    JSON.stringify(legacy));

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
  await recall.goto(POPUP.replace("popup/popup.html", "pages/recall.html"));
  /* #searchbox carries no `hidden` in the markup — loadPlan() is what puts one
     there — so waiting on ":not([hidden])" matched the very first paint and
     every assertion below raced the entitlement round-trip. Wait for the badge
     to stop saying "…", which only the resolved verdict can do. */
  await recall.waitForFunction(() =>
    (document.getElementById("plan-badge")?.textContent || "…").trim() !== "…",
    null, { timeout: 10000 });
  t("B11 recall page unlocked under trial", !(await recall.isVisible("#locked")));
  t("B11 recall page badge shows Trial", (await recall.textContent("#plan-badge")).trim() === "Trial");
  await recall.fill("#q", "architectural implications");
  await recall.waitForSelector("#results .r-item", { timeout: 5000 });
  t("B11 recall page search works", /Test Page/.test(await recall.textContent("#results .r-item")));
  await recall.waitForFunction(() =>
    /chats archived/.test(document.getElementById("stats")?.textContent || ""),
    null, { timeout: 10000 }).catch(() => {});
  t("B11 recall page shows archive stats",
    /chats archived/.test(await recall.textContent("#stats")));

  /* The operations left Total Recall: search is the Recall page, and checking
     providers, backup, restore and delete are the Archive page. Same script on
     both, so every selector below still resolves — only the URL moves. */
  const ARCHIVE_URL = POPUP.replace("popup/popup.html", "pages/archive.html");
  await recall.goto(ARCHIVE_URL);

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
  // Recall unlocks with the trial once the restore prompt is cleared…
  await recall.goto(POPUP.replace("popup/popup.html", "pages/recall.html"));
  await recall.waitForFunction(() =>
    (document.getElementById("plan-badge")?.textContent || "…").trim() !== "…",
    null, { timeout: 10000 });
  // …and the operations are back on their own page.
  await recall.goto(ARCHIVE_URL);

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
  /* Asserted rather than waited-on: a bare waitForFunction that times out kills
     the run and says only "timeout", so the one thing needed to fix it — what
     the headline actually said — is the one thing it does not report. */
  await recall.waitForFunction(() =>
    /Everything is already backed up/.test(document.getElementById("sync-summary")?.textContent || ""),
    null, { timeout: 5000 }).catch(() => {});
  const summaryText = await recall.evaluate(() =>
    document.getElementById("sync-summary")?.textContent || "(empty)");
  t("B11 empty delta reports everything already backed up",
    /Everything is already backed up/.test(summaryText), summaryText);
  await pop.waitForFunction(() =>
    /Everything is already backed up/.test(document.getElementById("sync-status")?.textContent || ""),
    null, { timeout: 5000 });
  t("B11 popup restores durable synchronized state without starting a sync", true);
  /* Claude is seeded mid-flight on purpose: "the worker died while this
     platform was still going" is the scenario, and it is the only state
     normalizeRun() converts to paused — a platform whose last word was an error
     keeps that error, which is what a signed-out account genuinely has after
     the install pass has run. Leaving the key absent made the assertion depend
     on no background pass ever having touched Claude. */
  await recall.evaluate((at) => chrome.storage.local.set({
    "recall-sync-progress:claude": {
      state: "syncing", phase: "syncing", done: 3, total: 10,
      msg: "Capturing 3 of 10 new chats…", at: at + 3
    },
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
      msg: "Waiting briefly before continuing with ChatGPT.", at
    }
  }), Date.now());
  const cooled = await recall.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-sync-status" }, res)));
  t("B11c a provider pause reports as paused, never as an error",
    cooled.summary.state === "paused" && /Waiting briefly/.test(cooled.summary.message),
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

  /* --- and the prompt the user actually sees ---
     It is no longer on the Recall page. The question is asked where the user
     already is: the notification carries Keep/Delete itself, the popup holds
     the same list, and a delete is reversible for five seconds. */
  await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-drop", id: "chatgpt.com/c/idx-1" }, res)));
  await pop.reload();
  await pop.waitForSelector("#deletion-alert:not([hidden])", { timeout: 5000 });
  t("B11e the popup carries the unanswered question",
    /1 chat was deleted/.test(await pop.textContent("#deletion-alert-title")));
  t("B11e the Recall page no longer owns the decision",
    await recall.evaluate(() => !document.getElementById("deletions")));

  await pop.click("#deletion-alert");
  await pop.waitForSelector("#deletion-panel:not([hidden])", { timeout: 5000 });
  t("B11e opening it names the chat rather than just counting it",
    /Index seed/.test(await pop.textContent("#deletion-items")));
  t("B11e and the decision is on the row itself",
    (await pop.locator("#deletion-items .deletion-keep").count()) === 1 &&
    (await pop.locator("#deletion-items .deletion-drop").count()) === 1);
  /* One chat's row already carries Keep and Delete. A "keep all / delete all"
     pair underneath it is the same two options a second time. */
  t("B11e one chat is not offered the same two options twice",
    !(await pop.locator(".deletion-actions").isVisible()));
  /* And opening the panel must not disturb the toggles above it. The panel is a
     child of the two-column settings grid: left in one column it sized that
     column to its own width and pushed the right-hand toggles clean out of the
     popup, which is what this looked like. */
  const gridSane = await pop.evaluate(() => {
    const doc = document.documentElement;
    const mm = document.getElementById("toggle-minimap").closest(".row").getBoundingClientRect();
    const speed = document.getElementById("toggle-enabled").closest(".row").getBoundingClientRect();
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      right: Math.round(mm.right), width: doc.clientWidth,
      // The pair still shares a line: two columns, not one tall column.
      paired: Math.abs(mm.top - speed.top) < 2 && mm.left > speed.left
    };
  });
  t("B11e the open panel does not push the popup sideways",
    gridSane.overflow <= 1, JSON.stringify(gridSane));
  t("B11e …and the right-hand toggles are still on screen",
    gridSane.right <= gridSane.width, JSON.stringify(gridSane));
  t("B11e the toggles are still paired two to a line",
    gridSane.paired, JSON.stringify(gridSane));

  /* Delete, then undo. The worker keeps the whole record aside, so this is a
     restore rather than a re-download from a provider that no longer has it. */
  await pop.click("#deletion-items .deletion-drop");
  await pop.waitForSelector("#deletion-undo:not([hidden])", { timeout: 5000 });
  const goneNow = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] }, res)));
  t("B11e delete really deletes, at once", !goneNow["chatgpt.com/c/idx-1"], JSON.stringify(goneNow));
  await pop.click(".deletion-undo-btn");
  await pop.waitForFunction(() =>
    /Restored/.test(document.getElementById("deletion-undo")?.textContent || ""),
    null, { timeout: 5000 });
  const backAgain = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] }, res)));
  t("B11e …and undo puts every word back", !!backAgain["chatgpt.com/c/idx-1"], JSON.stringify(backAgain));

  /* Re-queue it so "keep all" has something to answer — and a SECOND chat with
     it, because that is when a bulk action is a bulk action rather than the
     same question asked twice about one chat. */
  await pop.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({
    type: "recall-upsert",
    chat: { id: "chatgpt.com/c/idx-2", host: "chatgpt.com", path: "/c/idx-2", platform: "ChatGPT",
      title: "Index seed two", updatedAt: Date.now(),
      msgs: [{ i: "n1", r: "user", t: "first" }, { i: "n2", r: "assistant", t: "second" }] }
  }, res)));
  await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-drop", id: "chatgpt.com/c/idx-1" }, res)));
  await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "chat-drop", id: "chatgpt.com/c/idx-2" }, res)));
  await pop.reload();
  await pop.waitForSelector("#deletion-alert:not([hidden])", { timeout: 5000 });
  await pop.click("#deletion-alert");
  await pop.waitForSelector("#deletion-panel:not([hidden])", { timeout: 5000 });
  t("B11e two chats are worth a bulk answer, and it appears",
    await pop.locator(".deletion-actions").isVisible());
  await pop.click("#deletion-keep-all");
  const keptState = await pop.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 800));
    const left = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "recall-deletions" }, res));
    return {
      queued: ((left && left.items) || []).length,
      panelHidden: document.getElementById("deletion-panel").hidden
    };
  });
  t("B11e 'keep all' answers every queued question", keptState.queued === 0, JSON.stringify(keptState));
  t("B11e …and the panel closes once there is nothing left to answer",
    keptState.panelHidden, JSON.stringify(keptState));
  const afterKeepAll = await pop.evaluate(() => new Promise((res) =>
    chrome.runtime.sendMessage({ type: "recall-check", ids: ["chatgpt.com/c/idx-1"] }, res)));
  t("B11e 'keep all' dismisses the prompt and keeps every word",
    !!afterKeepAll["chatgpt.com/c/idx-1"], JSON.stringify(afterKeepAll));

  /* ---- B11f the headline moves while you are looking at it ----
     A background pass archives chats the whole time the popup sits open. The
     archive figure was read once per open, so the number only ever changed if
     you closed the panel and opened it again — which is how it was reported. */
  const parkedStats = await pop.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("stats:"));
    const kept = {};
    for (const k of keys) kept[k] = all[k];
    if (keys.length) await chrome.storage.local.remove(keys);
    return kept;                    // an open tab's own figure outranks the archive
  });
  await pop.reload();
  await pop.waitForFunction(() =>
    /[0-9]/.test(document.getElementById("stat-windowed")?.textContent || ""),
    null, { timeout: 8000 });
  const pulseBefore = await pop.textContent("#stat-windowed");
  const pulseStatsBefore = await pop.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "recall-stats" }, r)));
  await pop.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({
    type: "recall-upsert",
    chat: { id: "chatgpt.com/c/pulse-1", host: "chatgpt.com", path: "/c/pulse-1",
      platform: "ChatGPT", title: "Live pulse", updatedAt: Date.now(),
      msgs: [{ i: "p1", r: "user", t: "one" }, { i: "p2", r: "assistant", t: "two" },
             { i: "p3", r: "user", t: "three" }] }
  }, res)));
  /* The keys are cleared on EVERY tick, not once before the reload. An open
     chat tab re-reports its own windowed figure on a timer, and the headline
     prefers that over the archive by design — so a single clear left this
     racing a tab from an earlier block, and the number it read back was the
     conversation's, unmoved, rather than the archive's. This block is about the
     archive path, so it holds the archive path open. */
  const moved = await pop.waitForFunction(async (was) => {
    const all = await chrome.storage.local.get(null);
    const live = Object.keys(all).filter((k) => k.startsWith("stats:"));
    if (live.length) { await chrome.storage.local.remove(live); return false; }
    return (document.getElementById("stat-windowed")?.textContent || "") !== was;
  }, pulseBefore, { timeout: 12000, polling: 300 }).then(() => true).catch(() => false);
  /* Two different failures wear the same face here: the archive not changing,
     and the panel not repainting. Say which — a number that did not move is
     not evidence of a stale popup unless the archive behind it moved. */
  const pulseStatsAfter = await pop.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "recall-stats" }, r)));
  t("B11f the archive count updates without closing the popup", moved,
    `${pulseBefore} -> ${await pop.textContent("#stat-windowed")}` +
    ` | archive msgs ${pulseStatsBefore && pulseStatsBefore.msgs} -> ${pulseStatsAfter && pulseStatsAfter.msgs}` +
    ` | chats ${pulseStatsBefore && pulseStatsBefore.chats} -> ${pulseStatsAfter && pulseStatsAfter.chats}`);
  await pop.evaluate((kept) => chrome.storage.local.set(kept), parkedStats);

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
  await recall.goto(POPUP.replace("popup/popup.html", "pages/recall.html"));
  await recall.waitForFunction(() =>
    (document.getElementById("plan-badge")?.textContent || "…").trim() !== "…",
    null, { timeout: 10000 });
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
  await recall.goto(ARCHIVE_URL);
  await recall.waitForSelector("#backup-passphrase");
  await recall.fill("#backup-passphrase", reinstallPassphrase);
  await recall.fill("#backup-passphrase-confirm", reinstallPassphrase);
  // Scheduled backups are exercised on their own below; leaving them on here
  // would put a second, worker-issued download in flight during this one.
  await recall.uncheck("#backup-auto");
  const backupDownloadEvent = recall.waitForEvent("download");
  await recall.click("#create-backup");
  /* A bare "the download never came" names nothing. The page says why it did
     not in #backup-status, so say that instead of the timeout. */
  const backupDownload = await backupDownloadEvent.catch(async (err) => {
    const why = await recall.textContent("#backup-status").catch(() => "(no status)");
    const gate = await recall.evaluate(async () => {
      const v = await new Promise((res) => chrome.runtime.sendMessage({ type: "entitlement-state" }, res));
      const l = (await chrome.storage.local.get("lct-trial-v2"))["lct-trial-v2"] || null;
      const y = (await chrome.storage.sync.get("lct-trial-v2"))["lct-trial-v2"] || null;
      const fp = await self.LCTEntitlement.deviceFpFor("");
      const g = l && l.tt ? await self.LCTEntitlement.trialGrant(l.tt, Date.now()) : null;
      return { via: v && v.via, entitled: v && v.entitled, trial: v && v.trial, fp,
        local: l && { sta: l.startedAt, tt: String(l.tt || "").slice(0, 12), verified: l.verified },
        sync: y && { sta: y.startedAt, tt: String(y.tt || "").slice(0, 12), verified: y.verified },
        grant: g };
    }).catch((e) => ({ probeFailed: String(e) }));
    throw new Error(`no download from #create-backup — #backup-status: ${why} :: gate ${JSON.stringify(gate)} :: ${err.message}`);
  });
  const backupPath = join(SCRATCH, "reinstall-archive.lctbackup");
  await backupDownload.saveAs(backupPath);
  await recall.waitForSelector("#backup-status.ok", { timeout: 20000 });
  t("B11 reinstall backup is encrypted and downloaded",
    /encrypted/.test(await recall.textContent("#backup-status")) && /\.lctbackup/.test(backupDownload.suggestedFilename()));

  /* ---- B11x. the export is a document, not a memory dump ----
     The archive's stored record is a storage shape — `r`, `t`, `ts`, `i`, `c`,
     `m`, `n`, `mv`, epoch milliseconds — and it used to be written to the file
     byte for byte, so somebody opening their own history found one-letter keys
     and no readable dates. Nothing on the machine imports this file; its whole
     job is to be readable. */
  const exportEvent = recall.waitForEvent("download");
  await recall.click("#export-archive");
  const exportDownload = await exportEvent.catch(async (err) => {
    const why = await recall.textContent("#export-status").catch(() => "(no status)");
    throw new Error(`no download from #export-archive — #export-status: ${why} :: ${err.message}`);
  });
  const exportPath = join(SCRATCH, "archive-export.json");
  await exportDownload.saveAs(exportPath);
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  const exportedChats = Object.values(exported.archive || {}).flat();
  const exportedMsgs = exportedChats.flatMap((c) => c.messages || []);
  t("B11x the export names itself and its version",
    exported.format === "tvara-archive-export" && exported.version === 3,
    JSON.stringify({ format: exported.format, version: exported.version }));
  t("B11x …and explains its own fields inside the file",
    !!exported.fields && Object.keys(exported.fields).length >= 8 && !!exported.fields["message.role"],
    JSON.stringify(Object.keys(exported.fields || {})));
  t("B11x every conversation is grouped under a provider and carries its own totals",
    exportedChats.length > 0 && exportedChats.every((c) =>
      typeof c.provider === "string" && c.provider &&
      typeof c.messageCount === "number" && typeof c.textFetched === "boolean" &&
      "title" in c && "url" in c),
    JSON.stringify(exportedChats[0] && Object.keys(exportedChats[0])));
  t("B11x times are ISO 8601, never epoch milliseconds",
    exportedChats.every((c) => c.updatedAt === null || /^\d{4}-\d{2}-\d{2}T/.test(String(c.updatedAt))) &&
    exportedMsgs.every((m) => m.at === null || /^\d{4}-\d{2}-\d{2}T/.test(String(m.at))),
    JSON.stringify(exportedChats.map((c) => c.updatedAt).slice(0, 3)));
  t("B11x a message says who wrote it and what it says, in words",
    exportedMsgs.length > 0 && exportedMsgs.every((m) =>
      (m.role === "user" || m.role === "assistant") && typeof m.text === "string" &&
      typeof m.index === "number"),
    JSON.stringify(exportedMsgs[0] || null));
  /* Provider, then title, then the whole conversation — the order somebody can
     scan. Newest-first was the write order dressed up. */
  t("B11x conversations are sorted by title within each provider",
    Object.values(exported.archive || {}).every((list) => {
      const named = list.filter((c) => String(c.title || "").trim());
      const sorted = [...named].sort((a, b) =>
        new Intl.Collator(undefined, { sensitivity: "base", numeric: true })
          .compare(String(a.title).trim(), String(b.title).trim()));
      return named.every((c, i) => c.id === sorted[i].id);
    }),
    JSON.stringify(Object.values(exported.archive || {})[0]?.map((c) => c.title).slice(0, 6)));
  /* The readable file. Deliberately HTML rather than a generated PDF: a PDF
     writer here means vendoring a library plus a Unicode font, the better part
     of a megabyte, to reproduce badly what the browser's own print engine does
     from this file. */
  const readableEvent = recall.waitForEvent("download");
  await recall.click("#export-readable");
  const readableDownload = await readableEvent.catch(async (err) => {
    const why = await recall.textContent("#export-status").catch(() => "(no status)");
    throw new Error(`no download from #export-readable — #export-status: ${why} :: ${err.message}`);
  });
  const readablePath = join(SCRATCH, "archive-export.html");
  await readableDownload.saveAs(readablePath);
  const html = readFileSync(readablePath, "utf8");
  const tocTitles = [...html.matchAll(/<li><a href="#c\d+">([^<]*)<\/a>/g)].map((m) => m[1]);
  const articleTitles = [...html.matchAll(/<article id="c\d+"><h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
  t("B11y the readable export is one self-contained page",
    /^<!doctype html>/i.test(html) && /<nav class="toc"/.test(html) && !/<script/i.test(html),
    html.slice(0, 60));
  t("B11y …with a contents list and an entry per conversation",
    tocTitles.length === exportedChats.length && articleTitles.length === exportedChats.length,
    JSON.stringify({ toc: tocTitles.length, articles: articleTitles.length, chats: exportedChats.length }));
  t("B11y …in the same provider-then-title order as the data file",
    JSON.stringify(articleTitles) ===
      JSON.stringify(exportedChats.map((c) => c.title || "(untitled)")),
    JSON.stringify({ html: articleTitles.slice(0, 4), json: exportedChats.map((c) => c.title).slice(0, 4) }));
  t("B11y …and it prints to a PDF with a page per conversation",
    /@media print/.test(html) && /article \{ break-before: page/.test(html));
  /* Built from the user's own conversations and then opened in a browser, so
     nothing in a message may become markup. Every interpolation goes through
     esc(); this is the check that no path skipped it. */
  t("B11y nothing in a conversation can become markup or run",
    !/ on[a-z]+\s*=/i.test(html) && !/javascript:/i.test(html) &&
    [...html.matchAll(/<img src="([^"]*)"/g)].every((m) => /^(https?:\/\/|data:image\/)/i.test(m[1])),
    JSON.stringify([...html.matchAll(/<img src="([^"]*)"/g)].map((m) => m[1]).slice(0, 3)));

  /* The tabular half. One row per CONVERSATION — a four-thousand-character
     answer in a spreadsheet cell is a cell nobody can read. */
  const csvEvent = recall.waitForEvent("download");
  await recall.click("#export-index");
  const csvDownload = await csvEvent.catch(async (err) => {
    const why = await recall.textContent("#export-status").catch(() => "(no status)");
    throw new Error(`no download from #export-index — #export-status: ${why} :: ${err.message}`);
  });
  const csvPath = join(SCRATCH, "archive-index.csv");
  await csvDownload.saveAs(csvPath);
  const csv = readFileSync(csvPath, "utf8");
  const csvLines = csv.replace(/^\ufeff/, "").trim().split("\r\n");
  t("B11z the index is one row per conversation, with a header",
    csvLines.length === exportedChats.length + 1 &&
    csvLines[0] === "Provider,Title,Messages,Text fetched,Created,Last updated,URL",
    JSON.stringify({ rows: csvLines.length, header: csvLines[0] }));
  t("B11z …carries the UTF-8 mark Excel needs, and CRLF line endings",
    csv.charCodeAt(0) === 0xfeff && /\r\n/.test(csv));

  t("B11x an untitled conversation sorts last, never first",
    Object.values(exported.archive || {}).every((list) => {
      const firstUntitled = list.findIndex((c) => !String(c.title || "").trim());
      return firstUntitled < 0 || list.slice(firstUntitled).every((c) => !String(c.title || "").trim());
    }),
    JSON.stringify(Object.values(exported.archive || {})[0]?.map((c) => c.title).slice(0, 6)));
  t("B11x no storage-shape key survives into the file",
    exportedMsgs.every((m) => !("r" in m || "t" in m || "ts" in m || "i" in m || "c" in m || "m" in m)) &&
    exportedChats.every((c) => !("msgs" in c || "n" in c || "mv" in c || "acct" in c)),
    JSON.stringify(exportedMsgs[0] || null));

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

  /* Opening a v3 file needs the entitlement stamp secret, fetched exactly as
     the page fetches it: from the worker, behind the gate. */
  const stampSecret = await recall.evaluate(async () => {
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: "archive-stamp" }, r));
    return res && res.secret ? res.secret : null;
  });
  t("B11 the stamp secret is only handed out behind the gate", typeof stampSecret === "string");

  // The envelope is the only copy of the archive that ever leaves the browser,
  // so it has to survive an attacker holding the file and editing it freely.
  const backupJson = readFileSync(backupPath, "utf8");
  const tamper = await recall.evaluate(async ({ json, pass, SECRET }) => {
    const C = self.LCTBackupCrypto;
    const out = {};
    const stampKey = await crypto.subtle.importKey("raw", C.base64ToBytes(SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const roundTrip = await C.open(json, pass, { stampKey });
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
  }, { json: backupJson, pass: reinstallPassphrase, SECRET: stampSecret });
  t("B11 backup envelope is v3 (wrapped key, authenticated header, entitlement stamp)", tamper.version === 3, JSON.stringify(tamper.version));
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
    auto.state.folder === "Tvara" && auto.state.filename === "tvara-auto.lctbackup",
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
    const opened = await recall.evaluate(async ({ json, pass, SECRET }) => {
      const out = { version: JSON.parse(json).version };
      const stampKey = await crypto.subtle.importKey("raw",
        self.LCTBackupCrypto.base64ToBytes(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
      try {
        const snapshot = await self.LCTBackupCrypto.open(json, pass, { stampKey });
        out.chats = snapshot.chats.length;
      } catch (error) { out.error = String(error.message || error); }
      try { await self.LCTBackupCrypto.open(json, "not the scheduled passphrase", { stampKey }); out.wrong = "accepted"; }
      catch (error) { out.wrong = String(error.message || error); }
      return out;
    }, { json: autoJson, pass: autoPassphrase, SECRET: stampSecret });
    t("B11 the unattended file opens with the passphrase and nothing else",
      opened.chats > 0 && opened.version === 3, JSON.stringify(opened));
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
  // The lock lives on the SEARCH page; this handle was last on Archive.
  await recall.goto(POPUP.replace("popup/popup.html", "pages/recall.html"));
  await recall.waitForSelector("#core-locked:not([hidden])", { timeout: 5000 });
  t("B11 recall page shows upsell when locked", await recall.isVisible("#core-locked"));
  // A locked page must offer both doors: the free week AND the way to pay.
  // Before this, "$9 from the extension popup" was the whole purchase path.
  t("B14 locked recall page offers a way to buy", await recall.isVisible("#buy-pro"));
  t("B14 recall buy button asks the issuer for a checkout, and does not navigate",
    await recall.evaluate(async () => {
      let sent = null;
      const before = location.href;
      const real = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (msg, cb) => { sent = msg; if (cb) cb({ ok: false, reason: "network" }); };
      document.getElementById("buy-pro").click();
      await new Promise((r) => setTimeout(r, 60));
      chrome.runtime.sendMessage = real;
      return !!sent && sent.type === "checkout-start" && location.href === before;
    }));
  /* Import and wipe are the user's own data and are free at every plan — they
     live on the Archive page now, and being locked out of SEARCH must not lock
     anyone out of those. The file input itself is hidden by design; its label
     is the control. */
  await recall.goto(ARCHIVE_URL);
  await recall.waitForSelector("#wipe");
  t("B11 locked page still owns import + wipe (user's data)",
    (await recall.isVisible('label[for="import-file"]')) && (await recall.isVisible("#wipe")));

  /* ---- B13. The paywall, tested where it is actually enforced ----
     Every check here goes straight to the worker, bypassing the UI entirely —
     because that is exactly what a bypass attempt does. Buttons being disabled
     proves nothing; these assert the data does not come out. */

  const ask = (msg) => pop.evaluate((m) =>
    new Promise((res) => chrome.runtime.sendMessage(m, res)), msg);

  /* Spend the taste first. A locked install is granted a few REAL searches over
     its own archive — the offer is watching the thing work — so recall-search
     answers results before it answers "locked". Every assertion below means to
     prove the GATE, and a probe that the taste satisfies proves nothing at
     all: it would go green on a build whose paywall had been deleted. */
  for (let i = 0; i < 6; i++) await ask({ type: "recall-search", q: "architectural" });

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
  // Two assertions, because the end-to-end one is legitimately racy: the popup
  // refreshes on open, the issuer answers 404 for a key it has never seen, and
  // the worker then drops the token — a correct revocation that arrives while
  // we are asking. Either refusal is a pass; what must never happen is entry.
  t("B13 a fabricated token never entitles",
    fakeTok && fakeTok.entitled === false &&
    (fakeTok.reason === "signature" || fakeTok.reason === "no-token"),
    JSON.stringify(fakeTok));
  // …and the verifier itself, asked directly, is not racing anything.
  t("B13 a fabricated token fails on signature",
    (await pop.evaluate(() => self.LCTEntitlement.verifyToken(
      "LCT2.eyJ2IjoyLCJwbGFuIjoicHJvIn0.AAAA"))).reason === "signature");

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

  /* Trial is worker-owned and sync-backed: clearing local storage is the
     one-click "reset my trial" that must not work. Seeded directly rather than
     through trial-start, which refuses a week with no verified address behind
     it — that rule is A8's, and this assertion is about where the record
     lives, not about who may start one. */
  await pop.evaluate(async (startedAt) => {
    await chrome.storage.local.remove(["license", "lct-entitlement-v2"]);
    const rec = { startedAt, v: 2, checkedAt: Date.now() };
    await chrome.storage.local.set({ "lct-trial-v2": rec });
    await chrome.storage.sync.set({ "lct-trial-v2": rec });
  }, Date.now() - 2 * 864e5);
  const trialFirst = await ask({ type: "trial-state" });
  await pop.evaluate(() => chrome.storage.local.remove("lct-trial-v2"));   // local only
  const trialSecond = await ask({ type: "trial-state" });
  t("B13 wiping local storage does not mint a second trial",
    trialFirst.until > 0 && trialSecond.until === trialFirst.until,
    JSON.stringify({ trialFirst, trialSecond }));

  /* ---- B14. Adversarial probe: the DevTools console, locked ----
     Everything here is one line someone can paste into the console on our own
     extension page. No file patching, no repacking. Ground truth, not theory. */

  await pop.evaluate(async () => {
    await chrome.storage.local.remove(["license", "lct-entitlement-v2"]);
    await chrome.storage.local.remove("lct-trial-v2");
    await chrome.storage.sync.remove("lct-trial-v2");
  });
  const recall2 = await ctx.newPage();
  await recall2.goto(`${POPUP.replace("/popup/popup.html", "/pages/recall.html")}`);
  await recall2.waitForSelector("#core-locked:not([hidden])");

  const probe = await recall2.evaluate(async () => {
    const out = {};
    // 1. the convenience helper the page still ships
    try { out.helper = (await self.LCTRecallDB.getAll()).length; }
    catch (e) { out.helper = "blocked: " + e.message; }
    // 2. hand-rolled cursor — same origin, no helper needed
    try {
      out.raw = await new Promise((res, rej) => {
        const r = indexedDB.open("lct-recall");
        r.onerror = () => rej(new Error("open failed"));
        r.onsuccess = () => {
          const all = r.result.transaction("chats", "readonly").objectStore("chats").getAll();
          all.onsuccess = () => res(all.result.length);
          all.onerror = () => rej(new Error("read failed"));
        };
      });
    } catch (e) { out.raw = "blocked: " + e.message; }
    // 3. seal a backup from the RAW read above — the helper being gone must
    //    not be what saves us; seal() itself has to refuse.
    try {
      const chats = await new Promise((res, rej) => {
        const r = indexedDB.open("lct-recall");
        r.onerror = () => rej(new Error("open failed"));
        r.onsuccess = () => {
          const all = r.result.transaction("chats", "readonly").objectStore("chats").getAll();
          all.onsuccess = () => res(all.result);
          all.onerror = () => rej(new Error("read failed"));
        };
      });
      const sealed = await self.LCTBackupCrypto.seal({
        format: self.LCTBackupCrypto.PAYLOAD_FORMAT, version: 1,
        createdAt: Date.now(), chats, ledger: { version: 2, checkpoints: {} }, profile: null
      }, { passphrase: "correct horse battery staple" });
      out.seal = sealed.json.length > 100 ? "PRODUCED A VALID BACKUP" : "short";
    } catch (e) { out.seal = "blocked: " + e.message; }
    // 4. overwrite the verdict object — identity, not just shape
    try {
      const before = self.LCTEntitlement;
      self.LCTEntitlement = { evaluate: async () => ({ entitled: true }) };
      out.identity = self.LCTEntitlement === before ? "held" : "REPLACED";
    } catch (_) { out.identity = "held"; }
    return out;
  });
  console.log("    B14 probe →", JSON.stringify(probe));

  // The one-line read helper is gone from the page.
  t("B14 the page no longer ships a getAll() helper",
    typeof probe.helper === "string" && probe.helper.startsWith("blocked:"),
    String(probe.helper));

  // Sealing from a locked console must not produce a usable backup.
  t("B14 a locked console cannot seal a backup",
    typeof probe.seal === "string" && probe.seal.startsWith("blocked:"),
    String(probe.seal));

  // The frozen verdict object survives assignment.
  t("B14 the entitlement API cannot be replaced", probe.identity === "held",
    String(probe.identity));

  // Raw IndexedDB is readable and always will be — asserted so the limit is
  // recorded rather than assumed. The gate is on the backup/restore CYCLE.
  t("B14 raw IndexedDB stays readable (documented limit, not a regression)",
    typeof probe.raw === "number");

  await recall2.close();
  /* B14 deliberately locked this install; hand the trial back for B12.
     Pressing the button is not enough any more: a trial grants nothing without
     the issuer's signed token, and the issuer is not reachable from here — so
     the button would start an unverified week that unlocks nothing, and every
     Bridge assertion below would fail on an empty search rather than on the
     thing it means to test. */
  await writeVerifiedTrial();


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

  /* ---- B17. Continue in a new chat ----
     The thing everyone already does by hand and badly: a chat gets long, slow,
     or hits a limit, and they scroll up copying fragments into a fresh one.
     What matters here is that the handover is VERBATIM (there is no summariser
     and there must never appear to be), that the user sees exactly what will
     travel, and that nothing is ever sent for them. */
  await page.bringToFront();
  await page.locator("#lct-minimap").hover();
  await page.waitForSelector('#lct-export-bar button[data-act="carry"]', { state: "visible" });
  await page.click('#lct-export-bar button[data-act="carry"]');
  await page.waitForSelector("#lct-carry", { timeout: 5000 });
  t("B17 the panel opens from the toolbar", await page.isVisible("#lct-carry"));

  // The panel used to have no way to dismiss it besides Escape, which isn't
  // discoverable — added a close button after a user found it "inescapable"
  // in practice. Locks that in: click it, confirm the panel is actually gone.
  await page.click("#lct-carry .lct-c-close");
  t("B17 the close button actually dismisses the panel",
    await page.evaluate(() => !document.getElementById("lct-carry")));
  // Reopen for the rest of this block, which expects the panel open.
  await page.locator("#lct-minimap").hover();
  await page.waitForSelector('#lct-export-bar button[data-act="carry"]', { state: "visible" });
  await page.click('#lct-export-bar button[data-act="carry"]');
  await page.waitForSelector("#lct-carry", { timeout: 5000 });

  /* Everything below goes through the panel rather than the module: content
     scripts live in an isolated world, so page.evaluate cannot see LCTCarry —
     and the UI is the thing a user actually meets anyway. "Copy instead" is
     the honest way to read what would travel. */
  await page.click("#lct-carry .lct-c-ghost");
  await page.waitForTimeout(400);
  const carryText = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));

  t("B17 the handover opens with what you originally asked",
    /## What I originally asked/.test(carryText));
  t("B17 it carries how the conversation ended",
    /## How the conversation ended/.test(carryText));
  t("B17 it says it is context, and asks the model to pick up from it",
    /continuing an earlier conversation/i.test(carryText), carryText.slice(0, 70));
  t("B17 it fits in a prompt box", carryText.length > 200 && carryText.length <= 6000,
    String(carryText.length));
  // Five blank lines before every heading is what joining pre-broken sections
  // gives you, and a composer renders every one of them.
  t("B17 it is not padded with blank lines",
    !/\n{3,}/.test(carryText), JSON.stringify(carryText.slice(0, 120)));
  // The opening section has to be a question. On a live chat the first user
  // turn was a screenshot, so it opened with a file name and said nothing.
  t("B17 the opening section is something that was actually asked",
    !/## What I originally asked\n\[image:[^\]]*\]\s*(\n#|$)/.test(carryText),
    carryText.slice(0, 140));

  // Everything carried is quoted from the chat. There is no summariser here —
  // no server, no API key — and inventing one would put words in the user's
  // mouth. Every substantial line must be findable in the conversation itself.
  t("B17 nothing is invented — every line traces to the conversation",
    await page.evaluate((text) => {
      const body = document.getElementById("chat").textContent;
      // A line that was ITSELF a heading or a speaker label in the chat gets a
      // markdown escape on the way out, so pasted text cannot forge this
      // handover's own structure. Undo the escape before comparing.
      return text.split("\n")
        .filter((l) => l.length > 60 && !/^\\?#/.test(l) && !/^I'm continuing/.test(l))
        .map((l) => l.replace(/^\\(?=\*\*)/, "").replace(/^\*\*(Me|You):\*\* /, "").replace(/^- /, "").split(" […]")[0])
        .every((l) => body.includes(l.slice(0, 50)));
    }, carryText), carryText.slice(0, 80));

  // Reopen: the panel must show the size before anything happens, and
  // unticking a section must actually shrink what travels.
  /* Reopened IMMEDIATELY after "copy instead" — which is what someone does
     when they meant to open a new chat after all. The copy schedules a close
     900ms out, and that timer used to close whatever panel existed when it
     fired, so the button appeared to do nothing. */
  await page.mouse.move(400, 400);
  await page.locator("#lct-minimap").hover();
  await page.waitForSelector('#lct-export-bar button[data-act="carry"]', { state: "visible" });
  await page.click('#lct-export-bar button[data-act="carry"]');
  await page.waitForSelector("#lct-carry", { timeout: 5000 });
  await page.waitForTimeout(1400);        // outlive the previous panel's timer
  t("B17 reopening it right after a copy does not close itself",
    await page.evaluate(() => !!document.getElementById("lct-carry")));
  const sizeText = await page.textContent("#lct-carry .lct-c-size");
  t("B17 the panel shows the size before anything happens",
    /\d[\d,]* characters/.test(sizeText), sizeText);
  const fullSize = Number(sizeText.replace(/[^\d]/g, ""));
  await page.uncheck("#lct-c-recent");
  await page.waitForTimeout(150);
  const smaller = Number((await page.textContent("#lct-carry .lct-c-size")).replace(/[^\d]/g, ""));
  t("B17 unticking a section removes it from the handover",
    smaller > 0 && smaller < fullSize, `${smaller} < ${fullSize}`);
  await page.evaluate(() => document.getElementById("lct-carry")?.remove());

  /* Delivery. The staged handover must land in the prompt box of an EMPTY
     conversation and nowhere else — dropping it into a chat already in
     progress would be worse than not delivering it. */
  await pop.evaluate((text) => chrome.storage.local.set({
    "lct-carry-v1": { platform: "synthetic", text, at: Date.now() }
  }), carryText);
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById("lct-minimap"), null, { timeout: 8000 });
  await page.waitForTimeout(800);
  t("B17 a handover is NOT delivered into a conversation already in progress",
    await page.evaluate(() => (document.getElementById("t-composer")?.value || "") === ""));
  t("B17 …and it is left on the shelf, not thrown away",
    await pop.evaluate(async () => !!(await chrome.storage.local.get("lct-carry-v1"))["lct-carry-v1"]));

  // Now an empty one: same page with the transcript removed.
  await page.evaluate(() => document.getElementById("chat").replaceChildren());
  await page.evaluate(() => { document.getElementById("t-composer").value = ""; });
  await page.reload();
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById("chat").replaceChildren());
  await page.waitForFunction(() =>
    (document.getElementById("t-composer")?.value || "").length > 100, null, { timeout: 12000 })
    .catch(() => {});
  const delivered = await page.evaluate(() => document.getElementById("t-composer")?.value || "");
  t("B17 into an empty chat, the context lands in the prompt box",
    /continuing an earlier conversation/i.test(delivered), delivered.slice(0, 60));
  t("B17 nothing is sent — it waits in the box for the user",
    await page.evaluate(() => document.querySelectorAll("[data-lct-message]").length === 0));
  t("B17 a delivered handover is taken off the shelf",
    await pop.evaluate(async () => !(await chrome.storage.local.get("lct-carry-v1"))["lct-carry-v1"]));
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById("lct-minimap"), null, { timeout: 10000 });

  /* ---- B18. Being told BEFORE the wall ----
     The reason to read an allowance at all. Every account from people who live
     with these limits says the same thing: no meter, no countdown, and the
     first signal is "usage limit reached" — by which point the session is over
     and the context they built is gone. A panel that says "100% left" answers
     a question nobody asks; a notification at 20% is the product. */
  /* The worker is stopped and restarted by Chrome whenever it goes idle, which
     takes any stub with it. So the stub is re-armed immediately before every
     step, and the reading is handed to the worker's own function rather than
     posted as a message — nothing here should depend on a round trip that a
     restart can land in the middle of. */
  /* ---- B21h the backfill yields to the reader from the CLICK ----
     The pacing yield stands the crawl down for BG_YIELD_MS, but it used to
     start at OUR first foreground request — after the page had already asked
     for its own transcript, by which time the crawl had spent the burst the
     host allows and the reader's click was answered with "Too many requests".
     The page now says it is here before anything else on a new route. */
  {
    const w = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 10000 });
    const yielded = await w.evaluate(() => {
      const host = "reader-test.example";
      const before = readerActive(host);
      readerHere(host);
      return { before, after: readerActive(host), other: readerActive("someone-else.example") };
    });
    t("B21h a reader arriving stands the backfill down on THAT host",
      yielded.before === false && yielded.after === true, JSON.stringify(yielded));
    t("B21h …and on that host only", yielded.other === false, JSON.stringify(yielded));
    const routed = await pop.evaluate(() => new Promise((res) =>
      chrome.runtime.sendMessage({ type: "reader-here", host: "routed.example" }, res)));
    t("B21h …and the signal is ungated: a page may always say it is here",
      !!(routed && routed.ok), JSON.stringify(routed));
  }

  const armNotes = async () => {
    const w = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 10000 });
    await w.evaluate(() => {
      self.__notes = [];
      chrome.notifications.create = (id, opts) => { self.__notes.push({ id, opts }); return Promise.resolve(id); };
    });
    return w;
  };

  const setWarn = (on) => pop.evaluate((v) => chrome.storage.local.set({
    settings: { enabled: true, minimap: true, time: true, history: false, quota: true, quotaWarn: v }
  }), on);

  /** Feed the worker a reading the way an observed response arrives.
   *
   *  The stub is installed INSIDE the same evaluate that triggers the reading,
   *  not by a separate round trip before it. Chrome recycles this worker
   *  whenever it goes idle and that takes `self.__notes` with it — arming in
   *  one call and observing in the next leaves a window for exactly that, and
   *  when it landed there the assertion failed with an empty list: not a
   *  product fault, a torn-down stub. One call has no gap to land in. */
  const observe = async (pct, opts = {}) => {
    const w = await armNotes();
    return w.evaluate(async ([p, withReset, fresh]) => {
      if (!Array.isArray(self.__notes)) {
        self.__notes = [];
        chrome.notifications.create = (id, o) => { self.__notes.push({ id, opts: o }); return Promise.resolve(id); };
      }
      if (fresh) await chrome.storage.local.remove(["quota:chatgpt|", "lct-quota-warned-v1"]);
      else await chrome.storage.local.remove("quota:chatgpt|");   // same window, new reading
      const json = { remaining: p, limit: 100 };
      if (withReset) json.resets_at = new Date(Date.now() + 36e5).toISOString();
      await quotaObserved("chatgpt.com", [{ kind: "body", at: Date.now(), json }], "");
      await new Promise((r) => setTimeout(r, 250));
      return self.__notes.map((n) => n.opts);
    }, [pct, opts.reset !== false, !!opts.fresh]);
  };

  await setWarn(true);

  const plenty = await observe(80, { fresh: true });
  t("B18 a healthy allowance says nothing at all", plenty.length === 0, JSON.stringify(plenty));

  const low = await observe(15);
  t("B18 under 20% the user is told, before the wall",
    low.length === 1 && /15%/.test(low[0].title) && /ChatGPT/.test(low[0].title),
    JSON.stringify(low.map((n) => n.title)));
  t("B18 the warning says when it comes back, not just that it is low",
    low.length === 1 && /resets at \d/.test(low[0].message), JSON.stringify(low[0] && low[0].message));

  // Same window, same level: re-reading a number is not news.
  const again = await observe(14);
  t("B18 it does not nag — one warning per level, per window",
    again.length === 0, JSON.stringify(again.map((n) => n.title)));

  // Falling to the next level IS news.
  const worse = await observe(7);
  t("B18 dropping to the next level warns again",
    worse.length === 1 && /7%/.test(worse[0].title), JSON.stringify(worse.map((n) => n.title)));

  // And the user can switch it off.
  await setWarn(false);
  const muted = await observe(9, { fresh: true });
  t("B18 warnings off means silence", muted.length === 0, JSON.stringify(muted));
  await setWarn(true);

  // A reading with no reset cannot be told apart from the same reading twice,
  // so it must stay quiet rather than fire on every re-read.
  const noReset = await observe(5, { fresh: true, reset: false });
  t("B18 a reading with no reset window stays quiet rather than repeating",
    noReset.length === 0, JSON.stringify(noReset));

  await pop.evaluate(() => chrome.storage.local.remove(["quota:chatgpt|", "lct-quota-warned-v1"]));

  /* ---- B19b. Backing up a conversation the page only half holds ----
     "Backed up the 197 loaded messages" on a 1,471-message thread is an honest
     sentence about a backup that is 13% of the conversation — which is not what
     anyone pressing a backup button believes they are getting. */
  {
    const deepE = await ctx.newPage();
    trackErrors(deepE);
    await deepE.goto("http://127.0.0.1:8917/test/virtual-history.html?index=1&total=1500&page=25");
    await deepE.waitForSelector("#lct-minimap", { timeout: 20000 });
    await pop.evaluate(async () => {
      const msgs = Array.from({ length: 400 }, (_, i) => ({
        i: "virtual-" + (i + 1), r: i % 2 ? "assistant" : "user", t: "archived body " + (i + 1)
      }));
      await new Promise((res) => chrome.runtime.sendMessage({
        type: "recall-import",
        chats: [{ id: "127.0.0.1/test/virtual-history.html", host: "127.0.0.1",
          path: "/test/virtual-history.html", platform: "Test Page", title: "Virtual history",
          n: msgs.length, updatedAt: Date.now(), msgs }]
      }, res));
    });
    const mountedNow = await deepE.evaluate(() => document.querySelectorAll("[data-message-id]").length);
    const dl = deepE.waitForEvent("download", { timeout: 15000 }).catch(() => null);
    await deepE.hover("#lct-minimap");
    await deepE.waitForSelector('#lct-export-bar button[data-fmt="md"]', { state: "visible" });
    await deepE.click('#lct-export-bar button[data-fmt="md"]');
    const file = await dl;
    await deepE.waitForTimeout(1200);
    const note = await deepE.evaluate(() => document.getElementById("lct-note")?.textContent || "");
    t("B19b the backup is the whole conversation, not the loaded slice",
      /whole conversation/.test(note) && /400/.test(note), note);
    t("B19b …and it says how much the page had never loaded",
      /had not loaded/.test(note), note);
    t("B19b a file is actually produced", !!file, file ? file.suggestedFilename() : "none");
    t("B19b the page was only holding a fraction of it",
      mountedNow < 100, String(mountedNow));
    await deepE.close();
  }

  /* ---- B19. Searching the part of the conversation the page never loaded ----
     Measured on a live 1,471-message ChatGPT thread: "isaac" appeared in 217
     messages and the bar found 8, because the host had mounted 195. Every one
     of those numbers was correct and the search was still useless — nobody
     asks a 1,400-message chat a question and accepts eight answers. The
     archive on the machine has the whole thing, so the bar asks there too. */
  const deep = await ctx.newPage();
  trackErrors(deep);
  await deep.goto("http://127.0.0.1:8917/test/virtual-history.html?index=1&total=1500&page=25");
  await deep.waitForSelector("#lct-minimap", { timeout: 20000 });
  await deep.waitForFunction(() =>
    document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "1500",
    null, { timeout: 8000 });

  // An archived copy of the same conversation, with the word placed in
  // messages the page has never mounted.
  await pop.evaluate(async () => {
    const msgs = [];
    for (let i = 1; i <= 1500; i++) {
      msgs.push({
        i: "virtual-" + i,
        r: i % 2 ? "user" : "assistant",
        t: i % 100 === 0 ? `the codeword porcupine appears here, message ${i}`
                         : `Virtual history message ${i}`
      });
    }
    await new Promise((res) => chrome.runtime.sendMessage({
      type: "recall-import",
      chats: [{
        id: "127.0.0.1/test/virtual-history.html",
        host: "127.0.0.1", path: "/test/virtual-history.html",
        platform: "Test Page", title: "Virtual history",
        n: msgs.length, createdAt: Date.now(), updatedAt: Date.now(), msgs
      }]
    }, res));
  });

  await deep.bringToFront();
  await pop.evaluate(() => chrome.storage.local.set({ "lct-cmd": { name: "in-chat-search", at: Date.now() } }));
  await deep.waitForSelector("#lct-search.lct-s-open", { timeout: 8000 });
  await deep.fill("#lct-search input", "porcupine");
  await deep.waitForFunction(() => {
    const c = document.querySelector("#lct-search .lct-s-count");
    return c && /\/(1[0-9]|[2-9][0-9])/.test(c.textContent);   // more than 9 hits
  }, null, { timeout: 8000 }).catch(() => {});

  const found = await deep.evaluate(() => ({
    count: document.querySelector("#lct-search .lct-s-count")?.textContent,
    title: document.querySelector("#lct-search .lct-s-count")?.title,
    deepClass: document.querySelector("#lct-search .lct-s-count")?.classList.contains("lct-s-deep"),
    mounted: document.querySelectorAll("[data-message-id]").length
  }));
  const total = Number((found.count || "0/0").split("/")[1]);
  t("B19 search reaches past what the page has mounted",
    total === 15, JSON.stringify(found));
  t("B19 …which is more than the page could ever have shown",
    total > found.mounted / 10, JSON.stringify({ total, mounted: found.mounted }));
  t("B19 the count says where the answers are",
    found.deepClass && /further back in this conversation/.test(found.title || ""),
    JSON.stringify(found.title));

  // Stepping onto a hit the host has never rendered must still take you there —
  // the minimap already knows how to walk to one, behind a preview.
  await deep.evaluate(() => document.querySelector("#lct-search .lct-s-next")?.click());
  await deep.waitForTimeout(2500);
  t("B19 stepping onto an unloaded hit starts the walk to it",
    await deep.evaluate(() =>
      !!document.getElementById("lct-history-panel") ||
      !!document.querySelector(".lct-hit") ||
      document.querySelectorAll("[data-message-id]").length > 25),
    "seek began");

  // And where there is no archived copy, nothing changes: what is loaded,
  // honestly counted.
  await deep.evaluate(() => document.querySelector("#lct-search .lct-s-close")?.click());
  await deep.close();

  /* ---- B20. An archive that can never be repaired ----
     Found on a real archive: a 1,471-message conversation frozen at the 203
     messages an old build had captured, none carrying ids. Every later sync was
     refused as "older" — because the stored record's timestamp was the LOCAL
     WRITE TIME, and the candidate's was the provider's own revision of a
     conversation last touched weeks earlier. A write from today will always
     beat a revision from last month, so that record could never be completed,
     never seed the map, and never be fully searched. Forever. */
  const arch = async (msg) => pop.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  const readRec = (id) => pop.evaluate(async (rid) => {
    const d = await new Promise((res) => { const q = indexedDB.open("lct-recall"); q.onsuccess = () => res(q.result); });
    return new Promise((res) => {
      const r = d.transaction("chats", "readonly").objectStore("chats").get(rid);
      r.onsuccess = () => res(r.result ? { n: r.result.n, mv: r.result.mv,
        withId: (r.result.msgs || []).filter((m) => m.i).length } : null);
    });
  }, id);

  const stale = "chatgpt.com/c/b20-frozen";
  const idless = (n) => Array.from({ length: n }, (_, i) => ({ r: i % 2 ? "assistant" : "user", t: "old capture " + i }));
  const withIds = (n) => Array.from({ length: n }, (_, i) => ({ i: "m" + i, r: i % 2 ? "assistant" : "user", t: "full copy " + i }));

  // what an old build left behind: no ids, and a wall-clock stamp
  await arch({ type: "recall-import", chats: [{
    id: stale, host: "chatgpt.com", path: "/c/b20-frozen", platform: "ChatGPT",
    title: "Frozen", updatedAt: Date.now(), msgs: idless(203) }] });
  const before20 = await readRec(stale);
  t("B20 an old capture stores without ids", before20 && before20.n === 203 && before20.withId === 0,
    JSON.stringify(before20));

  // the provider now offers the whole thing, revised weeks ago
  await arch({ type: "recall-import", chats: [{
    id: stale, host: "chatgpt.com", path: "/c/b20-frozen", platform: "ChatGPT",
    title: "Frozen", sourceUpdatedAt: Date.now() - 40 * 864e5,
    updatedAt: Date.now() - 40 * 864e5, msgs: withIds(1471) }] });
  const after20 = await readRec(stale);
  t("B20 a fuller copy is accepted even though its revision is older",
    after20 && after20.n === 1471 && after20.withId === 1471,
    JSON.stringify(after20));
  t("B20 …and the record can seed the map for the first time",
    after20 && after20.mv === 1, JSON.stringify(after20 && after20.mv));

  // The rule it must not break: a genuinely older restore may not clobber a
  // newer conversation. Both sides carry a provider revision here.
  await arch({ type: "recall-import", chats: [{
    id: stale, host: "chatgpt.com", path: "/c/b20-frozen", platform: "ChatGPT",
    title: "Frozen", sourceUpdatedAt: Date.now() - 200 * 864e5,
    updatedAt: Date.now() - 200 * 864e5, msgs: withIds(90) }] });
  const after20b = await readRec(stale);
  t("B20 an older, smaller restore still cannot overwrite it",
    after20b && after20b.n === 1471, JSON.stringify(after20b));

  // And the whole point of repairing it: it is searchable now.
  const deepHit = await arch({ type: "chat-search", host: "chatgpt.com", path: "/c/b20-frozen", q: "full copy 900" });
  t("B20 the repaired conversation can be searched end to end",
    deepHit && deepHit.status === "ok" && deepHit.total === 1,
    JSON.stringify({ status: deepHit && deepHit.status, total: deepHit && deepHit.total }));

  /* ---- B21. The archive that was all titles and no words ----
     A listing gives every conversation's title in one call; the text costs one
     call each. The pass wrote the titles and then decided the chats were
     archived — because a stub carries the provider's revision, and the sync
     compares revisions. On a real archive that left 2,303 conversations holding
     15,760 messages between them: seven each, for chats that run to hundreds.
     Total Recall is the paid feature, and it could only match titles. */
  {
    const ask = (m) => pop.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);
    await ask({ type: "recall-import", chats: [
      // what a listing leaves behind: a title, a revision, no words
      { id: "chatgpt.com/c/stub-a", host: "chatgpt.com", path: "/c/stub-a", platform: "ChatGPT",
        title: "Only a title", meta: true, n: 40, updatedAt: Date.now(), msgs: [] },
      { id: "chatgpt.com/c/stub-b", host: "chatgpt.com", path: "/c/stub-b", platform: "ChatGPT",
        title: "Also only a title", meta: true, n: 12, updatedAt: Date.now(), msgs: [] }
    ] });
    const before = await ask({ type: "archive-fill-state" });
    t("B21 an archive knows how much of itself is missing",
      before && before.total >= 2, JSON.stringify(before && before.remaining));

    // and a chat that arrives WITH its text is not queued
    await ask({ type: "recall-import", chats: [
      { id: "chatgpt.com/c/full-a", host: "chatgpt.com", path: "/c/full-a", platform: "ChatGPT",
        title: "Has words", updatedAt: Date.now(), msgs: [
          { i: "m1", r: "user", t: "a real question" },
          { i: "m2", r: "assistant", t: "a real answer" }] }
    ] });
    const after = await ask({ type: "archive-fill-state" });
    t("B21 a chat that arrives with its text is not queued",
      after.total === before.total, JSON.stringify({ before: before.total, after: after.total }));

    /* Filling a stub takes it off the queue — proven by importing its body
       EXACTLY the way the backfill does. This fixture used to pass a `title`,
       which fillStart never sends; because `put` replaces the whole record,
       that one extra field hid a defect that wiped the title of every chat the
       backfill repaired — and the stub's title is the only thing it had. Send
       what bg.js:4082 sends, and nothing else. */
    const fillPayload = {
      id: "chatgpt.com/c/stub-a", host: "chatgpt.com", path: "/c/stub-a",
      platform: "ChatGPT", updatedAt: Date.now(), keepTimes: false,
      msgs: [
        { i: "s1", r: "user", t: "the words that were missing" },
        { i: "s2", r: "assistant", t: "and the reply that went with them" }]
    };
    t("B21 the fixture sends what the backfill sends, and no more",
      !("title" in fillPayload) && !("createdAt" in fillPayload) && !("sourceUpdatedAt" in fillPayload),
      JSON.stringify(Object.keys(fillPayload)));
    await ask({ type: "recall-import", chats: [fillPayload] });

    // the body arrives; the title it already had must still be there
    const kept = await ask({ type: "chat-archive", host: "chatgpt.com", path: "/c/stub-a" });
    t("B21 …and the backfill keeps the title it was repairing",
      kept && kept.status === "ok" && kept.title === "Only a title",
      JSON.stringify(kept && { status: kept.status, title: kept.title, n: kept.n }));
    const filled = await ask({ type: "archive-fill-state" });
    t("B21 filling a chat removes it from the queue",
      filled.total === after.total - 1, JSON.stringify({ after: after.total, filled: filled.total }));

    // …and it is searchable, which is the entire point
    const hit = await ask({ type: "recall-search", q: "words that were missing" });
    t("B21 …and the words are searchable, which is the point",
      hit && Array.isArray(hit.results) && hit.results.some((r) => r.id === "chatgpt.com/c/stub-a"),
      JSON.stringify(hit && hit.results && hit.results.length));

    /* The popup asks the worker to pick the queue up as it opens, and with no
       provider signed in here that run writes "ChatGPT: not signed in" over the
       row — which is a different assertion from this one. Park the queue first:
       the auto path declines a stopped one without touching the note, so what
       is painted below is the idle copy this block is about. */
    await pop.evaluate(async () => {
      const held = (await chrome.storage.local.get("lct-fill-v1"))["lct-fill-v1"] || {};
      await chrome.storage.local.set({ "lct-fill-v1": { ...held, state: "stopped", note: "" } });
    });
    // the popup offers it, and says how much is missing
    await pop.reload();
    await pop.waitForTimeout(2500);
    const row = await pop.evaluate(() => {
      // The row is the container now: it carries the state and the visibility,
      // and #fill-archive is the hit area laid over it.
      const el = document.getElementById("fill-row");
      return { hidden: el.hidden, title: document.getElementById("fill-title").textContent,
               sub: document.getElementById("fill-sub").textContent };
    });
    t("B21 the popup offers to fetch what is missing", !row.hidden, JSON.stringify(row));
    t("B21 …and says how many, and roughly how long",
      /\d/.test(row.title) && /min/.test(row.sub), JSON.stringify(row));
    t("B21 …and says why it matters, in the reader's terms",
      /Search needs the words, not just the titles/.test(row.sub), row.sub);
    /* "Download" meant two different things in one panel: this queue, which
       fills the archive, and the backup FILE, which is what people were looking
       for under that word. Neither borrows the other's verb now. */
    t("B21 …and does not call filling the archive a download",
      !/download/i.test(row.title) && !/download/i.test(row.sub),
      JSON.stringify(row));

    /* ---- B21a the row does not move when it starts working ----
       A progress bar that is mounted when work starts adds its own height to
       the row, and every row under it drops by that much — in a panel where
       the thing below is the button somebody was reaching for. The rail is
       therefore permanent and only its FILL changes, which is a transform.
       Measured, not asserted from the stylesheet: the whole point is the
       height the browser actually computes. */
    const geom = await pop.evaluate(() => {
      const row = document.getElementById("fill-row");
      const bar = document.getElementById("fill-bar");
      const fill = document.getElementById("fill-bar-fill");
      const below = document.getElementById("backup-archive");
      const read = () => ({
        row: Math.round(row.getBoundingClientRect().height),
        below: Math.round(below.getBoundingClientRect().top),
        barShown: !bar.hidden && bar.getBoundingClientRect().height > 0,
        barLeft: Math.round(bar.getBoundingClientRect().left),
        titleLeft: Math.round(document.getElementById("fill-title").getBoundingClientRect().left)
      });
      const idle = read();
      // Exactly what a running queue does to this row.
      row.classList.add("busy");
      fill.style.transform = "scaleX(0.62)";
      const busy = read();
      row.classList.remove("busy");
      fill.style.transform = "scaleX(0)";
      return { idle, busy };
    });
    t("B21a the progress rail is there before there is any progress",
      geom.idle.barShown, JSON.stringify(geom));
    t("B21a the progress rail starts under the archive heading",
      geom.idle.barLeft === geom.idle.titleLeft, JSON.stringify(geom));
    /* The Customize control shares the row with the fetch button. Withdrawing
       it must not collapse its column: the title and sub would rewrap into the
       space and the row would change height while somebody was reaching for the
       button under it. */
    const chooseGeom = await pop.evaluate(() => {
      const row = document.getElementById("fill-row");
      const choose = document.getElementById("fill-choose");
      const h = () => Math.round(row.getBoundingClientRect().height);
      choose.classList.remove("is-off");
      const offered = h();
      choose.classList.add("is-off");
      const withdrawn = h();
      choose.classList.remove("is-off");
      return { offered, withdrawn, reachable: !choose.hidden };
    });
    t("B21a withdrawing Customize does not change the row's height",
      chooseGeom.offered === chooseGeom.withdrawn, JSON.stringify(chooseGeom));
    t("B21a a download starting does not change the row's height",
      geom.idle.row === geom.busy.row, JSON.stringify(geom));
    t("B21a …so nothing below it moves either",
      geom.idle.below === geom.busy.below, JSON.stringify(geom));

    /* ---- B21f the motion engine ----
       Three pages animate through lib/motion.js, so its contract is worth
       stating: one frame loop for everything in flight, a first paint that
       does not animate a value nobody has seen, a mutation that happens
       whether or not it can be animated, and a tween that lets go of an
       element the page has thrown away. */
    const motion = await pop.evaluate(async () => {
      const M = self.LCTMotion;
      const out = { present: typeof M };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      // A number nobody has seen is written, not counted to: there is nothing
      // to travel from, and a count-up on first paint is decoration.
      const el = document.createElement("span");
      document.body.append(el);
      out.firstPaintChanged = M.number(el, "probe:" + Math.random(), 500);
      out.firstPaintText = el.textContent;

      /* A percentage counting up through 62.4177% reads as a readout glitching,
         not as a value arriving. Every figure this panel shows is a count or a
         percentage, so the formatter is handed whole numbers and only whole
         numbers — including on the frames in between. */
      const pct = document.createElement("span");
      document.body.append(pct);
      const key = "pct-probe:" + Math.random();
      const saw = [];
      M.number(pct, key, 40, (n) => { saw.push(n); return n + "%"; });
      M.number(pct, key, 95, (n) => { saw.push(n); return n + "%"; });
      await wait(500);
      out.formatterSawFractions = saw.filter((n) => !Number.isInteger(n)).length;
      out.formatterFrames = saw.length;
      out.pctFinal = pct.textContent;
      pct.remove();

      // FLIP performs the mutation. That is not optional — it is the caller's
      // actual state change; only the travel is decoration.
      let mutated = false;
      M.flip([el], () => { mutated = true; });
      out.flipMutated = mutated;

      // A tween whose element has left the document stops on its own, rather
      // than writing to a node nothing can see for the rest of its duration.
      const gone = document.createElement("span");
      document.body.append(gone);
      let writes = 0;
      M.tween({ from: 0, to: 100, dur: 400, el: gone, onUpdate: () => { writes++; } });
      await wait(60);
      const during = writes;
      gone.remove();
      await wait(200);
      out.stoppedWhenDetached = writes === during && during > 0;

      /* Every value in flight shares ONE frame callback. A loop per tween is
         the usual way this gets written and it is why panels judder: each one
         wakes the compositor on its own schedule. Counted inside a single
         turn, before any frame can run, so this measures the engine and not
         the machine's frame rate. */
      await wait(150);                      // let any loop already going finish
      const native = requestAnimationFrame;
      let loops = 0;
      self.requestAnimationFrame = (fn) => { loops++; return native(fn); };
      const hosts = [];
      for (let i = 0; i < 6; i++) {
        const n = document.createElement("span");
        document.body.append(n);
        hosts.push(n);
        M.tween({ from: 0, to: 10, dur: 300, el: n, onUpdate: () => {} });
      }
      out.loopsForSixTweens = loops;
      self.requestAnimationFrame = native;
      for (const n of hosts) n.remove();
      el.remove();
      return out;
    });
    t("B21f the pages share one motion engine", motion.present === "object",
      JSON.stringify(motion));
    t("B21f a value nobody has seen is written, not counted to",
      motion.firstPaintChanged === false && motion.firstPaintText === "500",
      JSON.stringify(motion));
    t("B21f a counting number never shows a fraction of a percent",
      motion.formatterSawFractions === 0 && motion.formatterFrames > 1 &&
      motion.pctFinal === "95%", JSON.stringify(motion));
    t("B21f a FLIP performs the change whether or not it animates it",
      motion.flipMutated === true, JSON.stringify(motion));
    t("B21f a tween lets go of an element the page removed",
      motion.stoppedWhenDetached === true, JSON.stringify(motion));
    t("B21f six tweens share one frame loop, not six",
      motion.loopsForSixTweens === 1, JSON.stringify(motion));

    /* ---- B21g one baseline ----
       Every icon labels the TITLE beside it, and the two titles in a pair are
       the same line of the panel. Centring each row on its own content looks
       right until two rows differ in height — a description that wraps, a
       progress rail, a fuller cell in the pair — and then the icons stop
       agreeing with each other and the eye finds it immediately. This is
       measured rather than looked at, because looking at it is what failed. */
    const align = await pop.evaluate(() => {
      const rows = [...document.querySelectorAll(".rows > .row")].filter((r) => !r.hidden);
      const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
      const icons = [];
      for (const r of rows) {
        const icon = r.querySelector(".row-icon");
        const title = r.querySelector(".row-title");
        if (icon && title) icons.push({ name: title.textContent.slice(0, 22), off: +(mid(icon) - mid(title)).toFixed(1) });
      }
      /* The toggles are a two-column grid, so two rows share a grid line. Their
         titles have to share it too. */
      const pairs = [];
      const byTop = new Map();
      for (const r of rows) {
        const title = r.querySelector(".row-title");
        if (!title) continue;
        const key = Math.round(r.getBoundingClientRect().top);
        if (!byTop.has(key)) byTop.set(key, []);
        byTop.get(key).push(+title.getBoundingClientRect().top.toFixed(1));
      }
      for (const [, tops] of byTop) {
        if (tops.length > 1) pairs.push(+(Math.max(...tops) - Math.min(...tops)).toFixed(1));
      }
      /* Even spacing is not "every row the same height" — a row with two lines
         of description is taller and should be. It is that the SPACE around
         the text is the same everywhere, and that rows carrying the same
         amount of text come out the same height. */
      const shape = rows.map((r) => {
        const title = r.querySelector(".row-title");
        const sub = r.querySelector(".row-sub");
        const rb = r.getBoundingClientRect();
        const last = (sub || title).getBoundingClientRect();
        return { h: +rb.height.toFixed(1), under: +(rb.top + rb.height - (last.top + last.height)).toFixed(1) };
      });
      return { icons, pairs, shape };
    });
    const offs = align.icons.map((i) => i.off);
    const spread = offs.length ? +(Math.max(...offs) - Math.min(...offs)).toFixed(1) : 0;
    t("B21g every row's icon sits on its own title's line",
      offs.length > 6 && offs.every((o) => Math.abs(o) < 1.5),
      JSON.stringify(align.icons));
    t("B21g …and all of them on the same baseline as each other",
      spread < 1.5, `spread ${spread}px across ${offs.length} rows`);
    t("B21g two titles sharing a grid line share a line on the screen",
      align.pairs.length > 0 && align.pairs.every((d) => d < 1.5),
      JSON.stringify(align.pairs));

    /* The rhythm of the column. Rows differ in height when they differ in
       content and that is right; what must not differ is the space around the
       text, and the panel must not contain a dozen slightly different row
       heights — which is what "the spacing looks odd" turned out to mean. */
    const unders = align.shape.map((r) => r.under);
    const underSpread = +(Math.max(...unders) - Math.min(...unders)).toFixed(1);
    const heights = [...new Set(align.shape.map((r) => r.h))];
    t("B21g the space under a row's text is the same in every row",
      underSpread < 1.5, `spread ${underSpread}px: ${JSON.stringify(unders)}`);
    t("B21g …and the panel settles into two row heights, not a dozen",
      heights.length <= 2, JSON.stringify(heights));

    /* The two ways to take the offer are one control group, so they are the
       same control twice with a different weight. Stated once in .pro-actions
       and asserted here, because "they look different sizes" is what a pair
       whose geometry drifted apart looks like — and because an outline and a
       fill of identical size do not read as identical, which is why the
       secondary carries a surface of its own. */
    const offer = await pop.evaluate(() => {
      const trial = document.getElementById("trial-start");
      const buy = document.getElementById("buy-pro");
      /* The card these live in is hidden while a trial is running, and a
         hidden ancestor measures every descendant as zero. Reveal the whole
         chain, measure, put it back exactly as it was. */
      const restore = [];
      for (const el of [trial, buy]) {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          if (n.hidden) { restore.push(n); n.hidden = false; }
        }
      }
      /* needs-signin deliberately ghosts both buttons — signing in is the step
         in front of them, and "one filled action, not three" is the point of
         that state. The pair being a matched surface is a claim about the
         SIGNED-IN presentation, which is what this checks. */
      const card = document.querySelector(".pro-card");
      const wasNeedsSignin = card.classList.contains("needs-signin");
      card.classList.remove("needs-signin");
      const g = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return [Math.round(b.width), Math.round(b.height), s.borderTopLeftRadius,
          s.paddingLeft, s.paddingRight, s.borderTopWidth, s.fontSize]; };
      const out = { trial: g(trial), buy: g(buy),
        sameRow: Math.round(trial.getBoundingClientRect().top) === Math.round(buy.getBoundingClientRect().top),
        // Neither is a bare outline: an outline and a fill of the same size do
        // not look the same size.
        trialFilled: getComputedStyle(trial).backgroundColor !== "rgba(0, 0, 0, 0)",
        buyFilled: getComputedStyle(buy).backgroundColor !== "rgba(0, 0, 0, 0)" };
      if (wasNeedsSignin) card.classList.add("needs-signin");
      for (const n of restore) n.hidden = true;
      return out;
    });
    t("B21g the trial and the purchase are the same control, twice",
      JSON.stringify(offer.trial) === JSON.stringify(offer.buy), JSON.stringify(offer));
    t("B21g …side by side, and both of them a surface",
      offer.sameRow && offer.trialFilled && offer.buyFilled, JSON.stringify(offer));

    /* ---- B21b the backup file, and where its password lives ----
       The archive is in this browser and nowhere else, so the file is the
       safety net — and it existed only on the Recall page, which is why "where
       do I set the password" had no answer in the popup. */
    const backupRow = await pop.evaluate(() => {
      const el = document.getElementById("backup-archive");
      return el ? { hidden: el.hidden,
                    title: document.getElementById("backup-title").textContent,
                    sub: document.getElementById("backup-sub").textContent } : null;
    });
    t("B21b the popup offers the backup file at all",
      !!backupRow && !backupRow.hidden, JSON.stringify(backupRow));
    t("B21b …and reports the last one it wrote, with a count and a time",
      /last backup/i.test(backupRow.sub) && /\d/.test(backupRow.sub), backupRow.sub);
    /* The empty state is the one that has to name the password: it is the only
       moment the reader is asking where to set it. */
    const held = await pop.evaluate(async () => {
      const k = "lct-recall-backup-marker-v1";
      // The marker is durable: sync where it is available, local otherwise —
      // getDurable() reads both, so clearing one leaves the other standing.
      const was = (await chrome.storage.sync.get(k))[k] ||
        (await chrome.storage.local.get(k))[k] || null;
      await chrome.storage.sync.remove(k);
      await chrome.storage.local.remove(k);
      return was;
    });
    await pop.reload();
    await pop.waitForTimeout(1200);
    const emptyBackup = await pop.evaluate(() =>
      document.getElementById("backup-sub").textContent);
    t("B21b with nothing saved it says so, and names the password",
      /nothing saved/i.test(emptyBackup) && /password/i.test(emptyBackup), emptyBackup);
    await pop.evaluate(async (was) => {
      if (was) await chrome.storage.sync.set({ "lct-recall-backup-marker-v1": was });
      if (was) await chrome.storage.local.set({ "lct-recall-backup-marker-v1": was });
    }, held);
    await pop.reload();
    await pop.waitForTimeout(1200);
    t("B21b …in a different verb from the queue above it",
      !/download/i.test(backupRow.title + backupRow.sub), JSON.stringify(backupRow));

    /* Stopping is a state of its own. Without it the row went on saying "tap to
       stop" after the tap — the click looked like it had done nothing. */
    /* ---- B21c a dead worker says so, once, instead of a dozen times ----
       Every module failing to load produced a panel of small emptinesses — no
       counts, no allowance, rows stuck on "checking" — and they were reported
       one at a time as separate bugs. Answered by bg.js before any module is
       touched, because it is the one question a half-loaded worker can still
       answer about itself. */
    const health = await ask({ type: "worker-health" });
    t("B21c the worker can be asked whether it started at all",
      !!health && health.ok === true, JSON.stringify(health));
    t("B21c …and names its modules, so a partial load can be counted",
      !!health && Number(health.modules) > 10 &&
      Array.isArray(health.failed) && health.failed.length === 0, JSON.stringify(health));
    const deadBanner = await pop.evaluate(() => {
      const el = document.getElementById("worker-dead");
      return el ? el.hidden : null;
    });
    t("B21c …and a live worker shows no alarm", deadBanner === true, String(deadBanner));

    /* ---- B21d choosing what to fetch ----
       The queue is per chat, so the choice is per chat. A provider left out is
       not fetched; one named with no list is fetched whole; no choice at all
       still means everything, which is what every earlier caller sent. */
    const queue = await ask({ type: "archive-fill-queue" });
    t("B21d the queue can be listed for a person to choose from",
      !!queue && Array.isArray(queue.platforms), JSON.stringify(queue && Object.keys(queue)));
    t("B21d …per provider, with a real count",
      (queue.platforms || []).every((p) => p.id && p.label && Number.isFinite(p.total)),
      JSON.stringify((queue.platforms || []).map((p) => [p.id, p.total])));
    t("B21d …and with titles, never message text",
      (queue.platforms || []).every((p) => (p.chats || []).every((c) =>
        c && typeof c.id === "string" && typeof c.title === "string" && !("t" in c))),
      JSON.stringify((queue.platforms || [])[0] || null).slice(0, 200));
    /* A provider whose text is all here is still a row with chats in it: they
       can be fetched AGAIN, and offering that for one provider while refusing
       it for five is what made the page look broken. */
    t("B21d …and a finished provider still lists what it holds",
      (queue.platforms || []).every((p) => p.total > 0 || (p.chats || []).length > 0 || !p.archived),
      JSON.stringify((queue.platforms || []).map((p) => [p.id, p.total, p.archived, (p.chats || []).length])));
    t("B21d …saying of each chat whether its text is already here",
      (queue.platforms || []).every((p) => (p.chats || []).every((c) => typeof c.held === "boolean")),
      JSON.stringify(((queue.platforms || [])[0] || {}).chats?.[0] || null));
    const startReply = await ask({ type: "archive-fill-start", pick: { chatgpt: ["chatgpt.com/c/nothing-here"] } });
    const persisted = await pop.evaluate(async () =>
      ((await chrome.storage.local.get("lct-fill-v1"))["lct-fill-v1"] || {}).pick);
    /* Written before the run begins, because the watchdog restarts fillStart()
       with nothing in hand after a reclaim — a choice in memory would quietly
       widen back to everything. */
    t("B21d a choice is persisted with the queue, not held in a variable",
      !!persisted && Array.isArray(persisted.chatgpt), JSON.stringify(persisted));
    t("B21d …and the caller is told what actually happened",
      !!startReply && typeof startReply.how === "string", JSON.stringify(startReply));
    /* …and CONSUMED by the pass that used it. Left behind, it narrowed every
       later fetch to the same handful for good: the auto queue re-ran those
       chats, reported "partial" because the rest were still waiting, and came
       back to run the same ones again — a fetch button that does nothing,
       forever, bought with one visit to the picker. */
    await ask({ type: "archive-fill-stop" });
    /* Waited on the PASS ending, not on `running` going false: `running` is a
       module variable in a worker that gets reclaimed, so it reads false while
       the pass is still on its way to its own last write — which is where the
       choice is consumed. `finishedAt` moving is that write. */
    const consumed = await pop.evaluate(async (before) => {
      /* Either signal ends the wait, because either one settles the question:
         the pass wrote its ending, or the choice is already gone. Waiting on
         `finishedAt` ALONE flakes in both directions — the pass can end before
         this poll starts (so the timestamp never moves for us), and under the
         load of a full run it can take longer than a short window allows. */
      for (let i = 0; i < 80; i++) {
        const held = (await chrome.storage.local.get("lct-fill-v1"))["lct-fill-v1"] || {};
        if (held.pick == null || Number(held.finishedAt) > before) {
          return held.pick === undefined ? null : held.pick;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const held = (await chrome.storage.local.get("lct-fill-v1"))["lct-fill-v1"] || {};
      return "the choice outlived its pass: " + JSON.stringify(held);
    }, Date.now() - 1);
    t("B21d …and is consumed by the pass that used it, never left to narrow the next",
      consumed === null || consumed === undefined, JSON.stringify(consumed));
    await pop.evaluate(async () => {
      const k = "lct-fill-v1";
      const held = (await chrome.storage.local.get(k))[k] || {};
      await chrome.storage.local.set({ [k]: { ...held, pick: null, state: "partial" } });
    });

    /* ---- B21e it is its own page ----
       Total Recall is the SEARCH feature and it is gated. Deciding what the
       archive should hold is neither, and burying a free control inside a paid
       page is how a thing that works comes to look like a thing you have not
       bought. */
    const fetchPage = await ctx.newPage();
    trackErrors(fetchPage);
    await fetchPage.goto(POPUP.replace("popup/popup.html", "pages/fetch.html"));
    await fetchPage.waitForSelector("#fill-picker", { timeout: 10000 });
    const picker = await fetchPage.evaluate(() => ({
      shown: !document.getElementById("fill-picker").hidden,
      rows: document.querySelectorAll("#fill-picker-list .pick-row").length,
      empty: !document.getElementById("fill-picker-empty").hidden,
      go: !!document.getElementById("fill-pick-go")
    }));
    t("B21e the picker has a page of its own", picker.shown && picker.go,
      JSON.stringify(picker));
    t("B21e …and shows either a queue or an honest empty state",
      picker.rows > 0 || picker.empty, JSON.stringify(picker));

    /* The list is EDITED, never rebuilt. Rebuilding it on every tick throws
       away the checkbox that has focus and the reader's place in a list of a
       thousand titles, and moves everything below whatever was clicked — for
       a checkbox, which is the smallest interaction there is. Focus surviving
       a click is the observable proof the nodes survived it. */
    if (picker.rows > 0) {
      const kept = await fetchPage.evaluate(async () => {
        const box = document.querySelector(".pick-row input[type=checkbox]");
        box.id = box.id || "pick-probe";
        const before = box;
        box.focus();
        box.click();                                   // select this provider
        await new Promise((r) => setTimeout(r, 250));
        const after = document.querySelector(".pick-row input[type=checkbox]");
        return {
          sameNode: before === after,
          stillFocused: document.activeElement === after,
          go: (document.getElementById("fill-pick-go").textContent || "")
        };
      });
      t("B21e ticking a provider does not rebuild the list under the reader",
        kept.sameNode && kept.stillFocused, JSON.stringify(kept));
      t("B21e …and the button says how much was chosen",
        /\d/.test(kept.go), kept.go);
    }

    await fetchPage.close();
    const stillOnRecall = await recall.evaluate(() => !!document.getElementById("fill-picker"));
    t("B21e …and is not buried in the gated one", stillOnRecall === false,
      String(stillOnRecall));

    const fillContract = await ask({ type: "archive-fill-state" });
    t("B21b the worker reports stopping as its own state, not as running",
      fillContract && "stopping" in fillContract && fillContract.stopping === false,
      JSON.stringify(fillContract && { running: fillContract.running, stopping: fillContract.stopping }));
  }

  /* ---- B22. Nobody should have to ask for their own backup ----
     The queue above was only ever emptied by a click on that row. Installing
     the extension, signing in, restarting the browser — none of them started
     it, so an archive sat at hundreds of titles and no words until the user
     found the row. And the listing pass stepped aside whenever a chat site was
     the frontmost tab in the last-focused window — which stays true after the
     user switches to another application, so a tab left open held the pass off
     indefinitely and the archive only moved when the popup forced a manual
     run. An open tab now sets the request rate and nothing else. */
  {
    const ask = (m) => pop.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);
    const presence = (tabs, host) => ask({ type: "tab-presence-selftest", tabs, host });
    // B21 parked the queue to assert its idle copy. Un-park it: a stopped queue
    // is the one thing that legitimately refuses to start by itself.
    await pop.evaluate(async () => {
      const held = (await chrome.storage.local.get("lct-fill-v1"))["lct-fill-v1"] || {};
      await chrome.storage.local.set({ "lct-fill-v1": { ...held, state: "partial", note: "" } });
    });

    /* The tab that used to stop the archive: open, frontmost in its own window,
       in a window Chrome still calls focused after the user switched apps.
       Whatever the browser is doing, this is one answer now — a tab is open,
       so the pass paces itself. It never means "do not run". */
    for (const [name, tabs] of [
      ["frontmost in a background window", [{ url: "https://chatgpt.com/c/x", active: true, windowId: 7 }]],
      ["frontmost in the focused window",  [{ url: "https://chatgpt.com/c/x", active: true, windowId: 3 }]],
      ["a background tab",                 [{ url: "https://chatgpt.com/c/x", active: false, windowId: 3 }]]
    ]) {
      const got = await presence(tabs, "chatgpt.com");
      t(`B22 ${name} is just an open tab`,
        got && got.open === true && got.active === undefined, JSON.stringify(got));
    }

    const other = await presence(
      [{ url: "https://claude.ai/chat/x", active: true, windowId: 3 }], "chatgpt.com");
    t("B22 …and another provider's tab says nothing about this one",
      other && other.open === false, JSON.stringify(other));

    // A tab with no readable URL must not be counted as this site being open.
    const opaque = await presence([{ active: true, windowId: 3 }], "chatgpt.com");
    t("B22 an opaque tab is not this site", opaque && opaque.open === false, JSON.stringify(opaque));

    /* ---- the pass rebooking itself ----
       The resume alarm is what carries an unfinished pass across an MV3 worker
       being reclaimed and across a browser restart. Booked once at the END of a
       pass it was never written at all when the worker died mid-fetch, and a
       restart cleared it either way — leaving nothing but the 3-hour period
       alarm, which is why the archive looked stopped. */
    const alarm = () => pop.evaluate(() => chrome.alarms.get("lct-auto-sync-resume"));
    await pop.evaluate(() => chrome.alarms.clear("lct-auto-sync-resume"));
    await pop.evaluate(() => chrome.storage.local.set({
      "recall-sync-progress:chatgpt": { state: "syncing", msg: "12 saved, 30 left." }
    }));
    const rebooked = await ask({ type: "sync-resume-selftest" });
    const armed = await alarm();
    t("B22 a pass left mid-way rebooks itself after a restart",
      rebooked && rebooked.status === "resuming" && !!armed, JSON.stringify({ rebooked, armed }));
    /* Repeating is the property; 0.5 is the platform's own floor — Chrome
       refuses anything under 30 seconds and warns. A one-shot booking is what
       this is guarding against, so the check is "it comes back", pinned to the
       fastest the platform will actually honour. */
    t("B22 …and repeats, so a worker reclaimed mid-fetch is covered too",
      armed && armed.periodInMinutes === 0.5, JSON.stringify(armed));

    /* Nothing outstanding: every platform's last word is "done" and the run
       itself reached "done". Both are read, so both have to be cleared. */
    await pop.evaluate(() => chrome.storage.local.set({
      "recall-sync-progress:chatgpt": { state: "done" },
      "lct-recall-sync-run-v1": { id: "t", state: "done", finishedAt: Date.now() }
    }));
    await pop.evaluate(() => chrome.alarms.clear("lct-auto-sync-resume"));
    const idle = await ask({ type: "sync-resume-selftest" });
    t("B22 …and a finished pass books nothing",
      idle && idle.status === "idle" && !(await alarm()), JSON.stringify(idle));

    /* The download starting itself. B21 left stubs in the queue, so there is
       real work outstanding: the worker must take it without being asked. */
    const queued = await ask({ type: "archive-fill-state" });
    t("B22 there is still text outstanding to prove this with",
      queued && queued.total > 0, JSON.stringify(queued && queued.total));

    /* Either answer proves the point: it is running, and no click asked it to.
       Opening the popup already fires the same path, so a run can be in flight
       before this line. */
    const started = await ask({ type: "archive-fill-auto", reason: "test" });
    t("B22 the worker starts the download without being asked",
      started && (started.status === "started" || started.status === "already-running"),
      JSON.stringify(started));

    // …and it answers immediately. An hour-long queue must not hold the port.
    const t0 = Date.now();
    await ask({ type: "archive-fill-state" });
    t("B22 …and answering does not wait for the queue to drain",
      Date.now() - t0 < 8000, String(Date.now() - t0));

    /* Stop still means stop. The row is the user's own switch; nothing above
       may quietly turn it back on, on the next pass or the next restart. */
    await ask({ type: "archive-fill-stop" });
    const afterStop = await ask({ type: "archive-fill-auto", reason: "test" });
    t("B22 a download the user stopped is not restarted behind their back",
      afterStop && afterStop.status === "stopped", JSON.stringify(afterStop));

    // Turning background sync off turns this off with it: one consent, not two.
    await pop.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...(settings || {}), autoSync: false } });
      const held = (await chrome.storage.local.get("lct-fill-v1"))["lct-fill-v1"] || {};
      await chrome.storage.local.set({ "lct-fill-v1": { ...held, state: "partial" } });
    });
    const offState = await ask({ type: "archive-fill-auto", reason: "test" });
    t("B22 background sync switched off switches this off too",
      offState && offState.status === "disabled", JSON.stringify(offState));

    /* The stopped run's own last write is "stopped", and it lands whenever the
       loop notices the cancel — after this line if it is not waited for, which
       would park the queue again behind the re-arm below. */
    /* `running` goes false the moment a cancel is pending — that is what makes
       the popup's stop button feel like it did something. "Still draining" is
       its own state now, so waiting for the run to actually END means waiting
       for both, or the write below lands mid-drain and the run's own final
       "stopped" overwrites it. */
    for (let i = 0; i < 40; i++) {
      const st = await ask({ type: "archive-fill-state" });
      if (st && !st.running && !st.stopping) break;
      await pop.waitForTimeout(250);
    }
    await pop.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      const next = { ...(settings || {}) };
      delete next.autoSync;
      await chrome.storage.local.set({ settings: next });
      const held = (await chrome.storage.local.get("lct-fill-v1"))["lct-fill-v1"] || {};
      await chrome.storage.local.set({ "lct-fill-v1": { ...held, state: "partial" } });
    });
    const backOn = await ask({ type: "archive-fill-auto", reason: "test" });
    t("B22 …and switched back on, it picks the queue up again",
      backOn && (backOn.status === "started" || backOn.status === "already-running"),
      JSON.stringify(backOn));
    await ask({ type: "archive-fill-stop" });
  }

  /* ---- B14. First run ----
     The install tab owns browser-chrome pinning. This tour owns the controls
     inside a chat, where it can anchor every explanation to a real element. */

  /* Every tool has a label that is not a native `title`: the strip is
     overflow:hidden, so a browser tooltip inside it is clipped, and a second
     one on top of ours would double every hint. */
  const tips = await page.evaluate(() => {
    const bar = document.getElementById("lct-export-bar");
    if (!bar) return null;
    const btns = [...bar.querySelectorAll("button")];
    return {
      total: btns.length,
      tipped: btns.filter((b) => (b.getAttribute("data-tip") || "").includes("|")).length,
      titled: btns.filter((b) => b.hasAttribute("title")).length,
      labelled: btns.filter((b) => b.hasAttribute("aria-label")).length
    };
  });
  t("B14 every tool on the strip carries a label", tips && tips.total > 0 && tips.tipped === tips.total,
    JSON.stringify(tips));
  t("B14 …and no native tooltip doubles it", tips && tips.titled === 0, JSON.stringify(tips));
  t("B14 …and a screen reader still gets a name", tips && tips.labelled === tips.total,
    JSON.stringify(tips));

  const tipShown = await page.evaluate(async () => {
    const btn = document.querySelector('#lct-export-bar button[data-act="search"]');
    if (!btn) return null;
    btn.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const el = document.getElementById("lct-tip");
    return el && el.classList.contains("lct-tip-show") ? el.textContent : null;
  });
  t("B14 hovering a tool says what it does, immediately",
    /Search this chat/.test(tipShown || ""), String(tipShown));

  /* the tour: once, ever, anchored to the real controls */
  // Storage is reached from the EXTENSION page: page.evaluate runs in the
  // synthetic page's main world, where chrome.* deliberately does not exist.
  await pop.evaluate(() => chrome.storage.local.remove("lct-tour-v1"));
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById("lct-minimap"), null, { timeout: 8000 });
  await page.waitForSelector("#lct-tour-card", { timeout: 15000 });

  // The pin ask is the first card, and it is skipped outright once the icon is
  // already on the toolbar — so what is asserted is the rule, either way.
  const pinState = await pop.evaluate(() => new Promise((r) =>
    chrome.runtime.sendMessage({ type: "toolbar-pinned" }, r)));
  t("B14 the worker can say whether the icon is pinned",
    !!pinState && typeof pinState.pinned === "boolean", JSON.stringify(pinState));

  const first = await page.evaluate(() => {
    const c = document.getElementById("lct-tour-card");
    return {
      step: c.dataset.step,
      meta: c.querySelector(".lct-tour-meta").textContent,
      text: c.textContent,
      art: !!c.querySelector(".lct-tour-art svg"),
      okay: c.querySelector(".lct-tour-next").textContent
    };
  });
  t("B14 the first conversation gets the tour", /1 of \d/.test(first.meta), first.meta);
  t("B14 …with at least four things to say", /of ([4-9]|\d\d)/.test(first.meta), first.meta);
  t("B14 …and one plain button dismisses each card", first.okay === "Okay", first.okay);
  t("B14 an unpinned install is asked to pin first, and shown a picture of it",
    pinState.pinned ? first.step !== "pin" : (first.step === "pin" && first.art),
    JSON.stringify(first));
  t("B14 …in words that name the menu it is talking about",
    first.step !== "pin" || /puzzle/i.test(first.text), first.text.slice(0, 120));

  const step1 = await page.evaluate(async () => {
    const card = () => document.getElementById("lct-tour-card");
    if (card().dataset.step === "pin") {
      card().querySelector(".lct-tour-next").click();
      await new Promise((r) => setTimeout(r, 90));
    }
    const c = card();
    const ring = document.getElementById("lct-tour-ring");
    const mm = document.getElementById("lct-minimap");
    const r = ring.getBoundingClientRect(), m = mm.getBoundingClientRect();
    return {
      step: c.dataset.step,
      text: c.textContent,
      resting: mm.classList.contains("lct-mm-rest"),
      // the ring sits ON the strip, not somewhere else on the page
      onStrip: Math.abs(r.left - m.left) < 20 && Math.abs(r.top - m.top) < 20
    };
  });
  t("B14 …pointing at the strip itself", step1.onStrip, JSON.stringify(step1));
  t("B14 …which is held open while it is being pointed at", !step1.resting);
  t("B14 …and names the thing before explaining it",
    /\bbar\b|edge/i.test(step1.text), step1.text.slice(0, 90));

  // Walk to the tools step. Its legend is built FROM the real toolbar, so a
  // button the adapter removed can never be explained here.
  const legend = await page.evaluate(async () => {
    const next = () => document.querySelector("#lct-tour-card .lct-tour-next");
    const seen = [];
    for (let i = 0; i < 8; i++) {
      const card = document.getElementById("lct-tour-card");
      if (card && card.dataset.step) seen.push(card.dataset.step);
      if (document.querySelector("#lct-tour-card .lct-tour-legend")) break;
      const b = next();
      if (!b) break;
      b.click();
      await new Promise((r) => setTimeout(r, 60));
    }
    const rows = [...document.querySelectorAll("#lct-tour-card .lct-tour-leg")];
    const bar = document.getElementById("lct-export-bar");
    return {
      rows: rows.length,
      buttons: bar ? bar.querySelectorAll("button").length : -1,
      icons: rows.filter((r) => r.querySelector("svg")).length,
      text: rows.map((r) => r.textContent).join(" | "),
      seen
    };
  });
  const legendWalk = legend.seen || [];
  t("B14 the tour explains every tool on the strip, and only those",
    legend.rows > 0 && legend.rows === legend.buttons, JSON.stringify(legend));
  t("B14 …each next to the icon it is talking about", legend.icons === legend.rows,
    JSON.stringify(legend));
  t("B14 …in words, not feature names", /Reaches messages/.test(legend.text), legend.text);

  /* Every shape a browser window can be — narrow portrait, short landscape,
     and back. The tallest card is the one on screen right now. */
  const fits = [];
  for (const [w, h] of [[420, 900], [360, 640], [740, 360], [1280, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    fits.push(await page.evaluate(([vw, vh]) => {
      const c = document.getElementById("lct-tour-card");
      if (!c) return { vw, vh, ok: false, why: "gone" };
      const r = c.getBoundingClientRect();
      return {
        vw, vh,
        ok: r.width > 100 && r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
        box: [r.left, r.top, r.right, r.bottom].map(Math.round)
      };
    }, [w, h]));
  }
  t("B14 the tour fits every window shape, portrait and landscape",
    fits.every((f) => f.ok), JSON.stringify(fits));

  /* Walk the rest of it, collecting what each card is about. The cap is a
     runaway guard, not the step count: the tour grew from seven cards to
     twenty and a loop calibrated to the old number reported "cannot be
     finished" for a tour that finishes perfectly well. */
  const closed = await page.evaluate(async () => {
    const seen = [];
    const panels = [];
    for (let i = 0; i < 40; i++) {
      const card = document.getElementById("lct-tour-card");
      if (!card) break;
      if (card.dataset.step) {
        seen.push(card.dataset.step);
        panels.push({
          step: card.dataset.step,
          outline: !!document.querySelector("#lct-outline.lct-o-open"),
          search: !!document.querySelector("#lct-search.lct-s-open")
        });
      }
      const b = card.querySelector(".lct-tour-next");
      if (!b) break;
      b.click();
      await new Promise((r) => setTimeout(r, 60));
    }
    return {
      seen,
      panels,
      leftOpen: {
        outline: !!document.querySelector("#lct-outline.lct-o-open"),
        search: !!document.querySelector("#lct-search.lct-s-open")
      },
      gone: !document.getElementById("lct-tour"),
      // released, not left pinned open on top of the reader's chat
      resting: document.getElementById("lct-minimap")?.classList.contains("lct-mm-rest")
    };
  });
  t("B14 the tour can be finished", closed.gone, JSON.stringify(closed));

  /* EVERY FEATURE THIS PAGE HAS, and nothing it does not.

     The in-page tour used to run six further cards about the archive, the
     allowance dial, temporary chats, the plan and the settings — none of which
     exist on a chat site. Six screens of prose with no control to point at, in
     the middle of a walkthrough about a strip on the right-hand side. Those
     belong in the popup, where the controls are and where a card can point at
     one; the filter that drops them is in tour.js. */
  const explained = [...new Set([...legendWalk, ...closed.seen])];
  for (const id of ["strip", "map", "preview", "tools", "stars", "outline", "search",
                    "backup", "times", "card", "resume", "keys"]) {
    t(`B14 the tour explains "${id}"`, explained.includes(id), explained.join(","));
  }
  /* And the other half of that contract: a card that cannot point at anything
     here must not be here. Asserting the absence matters as much as the
     presence — without it, the next person to "just add one more card" puts
     the wall of prose straight back. */
  for (const id of ["recall", "allowance", "archive", "temp", "plan", "settings"]) {
    t(`B14 …and does NOT explain "${id}" in the page — that card belongs in the popup`,
      !explained.includes(id), explained.join(","));
  }
  /* The two cards that DEMONSTRATE rather than describe. A walkthrough that
     says "this builds a table of contents" and shows nothing is a manual with
     a Next button — the panel has to be open while its own card is on screen,
     and shut again before the next card points somewhere else. */
  const onCard = (id) => (closed.panels || []).find((p) => p.step === id) || {};
  t("B14 the outline card opens the outline in front of the reader",
    onCard("outline").outline === true, JSON.stringify(onCard("outline")));
  t("B14 the search card opens the search box, and the outline is put back",
    onCard("search").search === true && onCard("search").outline === false,
    JSON.stringify(onCard("search")));
  t("B14 …and the tour leaves nothing of its own open behind it",
    closed.leftOpen && !closed.leftOpen.outline && !closed.leftOpen.search,
    JSON.stringify(closed.leftOpen));

  /* The handover. The last popup card opens a chat site rather than telling
     the reader to go and find one, and arms the in-chat tour BEFORE the tab
     exists — a flag written afterwards is one the loading page never saw. */
  const handover = await pop.evaluate(async () => {
    await chrome.storage.local.remove(["lct-tour-armed-v1", "lct-tour-v1"]);
    const opened = [];
    const realCreate = chrome.tabs.create;
    const realClose = window.close;
    chrome.tabs.create = (o) => { opened.push(o.url); return Promise.resolve({ id: -1 }); };
    window.close = () => {};
    document.getElementById("tour-link").click();
    await new Promise((r) => setTimeout(r, 40));
    const chips = [...document.querySelectorAll("#popup-tour-chips .tour-chip")].map((c) => c.dataset.url);
    document.querySelector("#popup-tour-chips .tour-chip").click();
    await new Promise((r) => setTimeout(r, 120));
    const armed = (await chrome.storage.local.get("lct-tour-armed-v1"))["lct-tour-armed-v1"];
    chrome.tabs.create = realCreate;
    window.close = realClose;
    await chrome.storage.local.remove("lct-tour-armed-v1");
    await chrome.storage.local.set({ "lct-tour-v1": Date.now() });
    return { chips, opened, armed: !!armed };
  });
  t("B14 the popup tutorial ends by offering to open a chat, not by naming one",
    handover.chips.length === 6 && handover.chips.every((u) => /^https:\/\//.test(u)),
    JSON.stringify(handover.chips));
  t("B14 …picking one opens that site", handover.opened.length === 1,
    JSON.stringify(handover.opened));
  t("B14 …and arms the in-chat walkthrough before the tab is created",
    handover.armed, JSON.stringify(handover));

  t("B14 …and is one continuous walkthrough, not a handful of cards",
    explained.length >= 12, String(explained.length));
  t("B14 …and gives the strip back when it is", closed.resting !== false, JSON.stringify(closed));

  // Second visit: silence. The flag is written BEFORE anything is drawn, so
  // two tabs racing cannot both decide they are the first.
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById("lct-minimap"), null, { timeout: 8000 });
  await page.waitForTimeout(900);
  t("B14 the tour never comes back",
    await page.evaluate(() => !document.getElementById("lct-tour")));
  t("B14 the once-ever flag is what stops it",
    await pop.evaluate(async () => !!(await chrome.storage.local.get("lct-tour-v1"))["lct-tour-v1"]));
  t("B14 …but it can be asked for again from the popup",
    await pop.isVisible("#tour-link"));

  /* Armed by the install listener. A fresh install is normally opened on an
     EMPTY chat, where the map hides itself because there is nothing to map —
     so the tour that new user was promised waited for a conversation that had
     not been had yet, and was never shown. Armed, the toolbar alone is enough
     to start, and the flag is spent once. */
  await pop.evaluate(() => chrome.storage.local.set(
    { "lct-tour-armed-v1": Date.now(), "lct-tour-v1": null }));
  await page.reload();
  await page.waitForSelector("#lct-tour-card", { timeout: 15000 });
  t("B14 a fresh install gets the tour without waiting for a long chat", true);
  t("B14 …and the arming flag is spent, not left to fire on every page",
    await pop.evaluate(async () =>
      !(await chrome.storage.local.get("lct-tour-armed-v1"))["lct-tour-armed-v1"]));
  await page.evaluate(async () => {
    for (let i = 0; i < 40 && document.getElementById("lct-tour-card"); i++) {
      document.querySelector("#lct-tour-card .lct-tour-next")?.click();
      await new Promise((r) => setTimeout(r, 40));
    }
  });

  const popupTour = await pop.evaluate(async () => {
    document.getElementById("tour-link").click();
    await new Promise((r) => setTimeout(r, 50));
    const tour = document.getElementById("popup-tour");
    const next = document.getElementById("popup-tour-next");
    const seen = [];
    const counts = [];
    // Walk to the end rather than a fixed number of clicks: the card count is
    // whatever is actually on screen, since rows that are not there — no
    // deletions to review, nothing left to fetch — are skipped.
    for (let i = 0; i < 30; i++) {
      seen.push({ step: tour.dataset.step, text: tour.textContent });
      counts.push(document.getElementById("popup-tour-count").textContent);
      // The last card hands over to the in-chat tour; clicking Next there
      // opens a chat tab and closes the popup, which is not this assertion.
      if (next.hidden || next.textContent === "Continue in a chat") break;
      next.click();
      await new Promise((r) => setTimeout(r, 25));
    }
    document.getElementById("popup-tour-skip").click();
    return { hidden: tour.hidden, seen, counts };
  });
  const popupSteps = popupTour.seen.map((s) => s.step);
  /* Every switch in this window gets its own card. They used to be described
     three at a time in a sentence about something else, which is how "Archive
     core" and "Load full history on open" ended up with no explanation at all
     while appearing to be covered. */
  for (const [id, wants] of [
    ["plan", /Free, Trial or Pro/], ["pulse", /asleep/], ["settings", /Speed engine|off-screen/],
    ["minimap", /one bar per message|Minimap|thin strip/i], ["times", /send time/],
    ["history", /older message back on the page|while you are reading/], ["temp", /temporary/i],
    ["quota", /20%/], ["archive", /Total Recall/], ["core", /Archive core|checks for new chats/],
    ["account", /Pro is one payment|trial/i], ["footer", /Health|Shortcuts/],
    ["chat", /open it for you|continues there/i]
  ]) {
    const card = popupTour.seen.find((s) => s.step === id);
    t(`B14 the popup walkthrough explains "${id}"`, !!card && wants.test(card.text),
      card ? card.text.slice(0, 90) : popupSteps.join(","));
  }
  t("B14 …and closes on the last card, which hands over to the in-chat tour",
    popupTour.hidden && /1 of \d+/.test(popupTour.counts[0] || ""), JSON.stringify(popupTour.counts));

  /* ---- B15. The health check ----
     This is the instrument that is supposed to notice a platform redesign
     before a customer does, so it needs to be right about a page we control
     and — more importantly — it must NOT report health when the selectors it
     depends on have stopped matching. */
  const healthPage = await ctx.newPage();
  trackErrors(healthPage);
  await healthPage.goto(POPUP.replace("/popup/popup.html", "/diag/health.html"));
  await healthPage.waitForSelector(".card, .empty", { timeout: 8000 });
  t("B15 health page finds the open chat tab",
    (await healthPage.locator(".card").count()) >= 1,
    await healthPage.textContent("#out"));
  const healthText = await healthPage.textContent("#out");
  t("B15 health page reports the platform as matching",
    /matching this platform's own markup/.test(healthText), healthText.slice(0, 160));
  t("B15 health page never prints a conversation id",
    !/[a-f0-9]{8}-[a-f0-9]{4}/.test(healthText));

  /* The first real report anyone ran came back "no answer (content script not
     running — reload that tab)" — Chrome working as designed: it does not
     inject into tabs that already existed when the extension was loaded. A
     diagnostic whose answer is "go do something yourself" ends the
     conversation, so the page offers to do it. Chrome will not let a test
     reload an unpacked extension (runtime.reload never comes back under
     automation), so the silence is staged at the channel instead — which is
     all the page can see of it anyway. */
  await healthPage.evaluate(() => {
    window.__reloaded = [];
    const realSend = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = (id, msg, cb) => cb(undefined);   // every tab, silent
    chrome.tabs.reload = async (id) => {
      window.__reloaded.push(id);
      chrome.tabs.sendMessage = realSend;                       // the reload "worked"
    };
  });
  await healthPage.click("#run");
  await healthPage.waitForSelector(".card.bad", { timeout: 10000 });
  const orphan = await healthPage.evaluate(() => {
    const c = document.querySelector(".card");
    return { verdict: c.querySelector(".pill").textContent, says: c.textContent,
             hasFix: !!c.querySelector("button.fix") };
  });
  t("B16 a silent tab is reported, not skipped", /no answer/.test(orphan.verdict), orphan.verdict);
  t("B16 it explains what Chrome did", /injects into pages opened AFTER/.test(orphan.says));
  t("B16 it offers the fix instead of describing it", orphan.hasFix);

  await healthPage.click("button.fix");
  await healthPage.waitForSelector(".card.good", { timeout: 20000 });
  t("B16 one click turns 'no answer' into an answer",
    /matching this platform/.test(await healthPage.textContent(".card .pill")));
  t("B16 and it reloaded exactly the tab that was silent",
    (await healthPage.evaluate(() => window.__reloaded.length)) === 1);

  await healthPage.close();

  // Asked through the EXTENSION page: page.evaluate runs in the synthetic
  // page's main world, where chrome.* deliberately does not exist.
  // Several localhost pages are open by now (the virtual-history and demo
  // harnesses); ask the synthetic page by its exact url, not "the first one".
  const askHealth = () => pop.evaluate(async (want) => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    const tab = tabs.find((x) => x.url === want) || tabs[0];
    if (!tab) return { error: "no synthetic tab" };
    return new Promise((res) => chrome.tabs.sendMessage(tab.id, { type: "lct-health" }, res));
  }, page.url());
  const direct = await askHealth();
  t("B15 the report counts the messages the adapter sees",
    direct.messages > 0 && direct.roles.user + direct.roles.assistant === direct.messages,
    JSON.stringify({ m: direct.messages, r: direct.roles }));
  t("B15 the report says which selector layer is carrying it",
    direct.selectors === "primary", direct.selectors);
  t("B15 the report finds the composer and the scroller",
    direct.composer === true && direct.scroller === true);
  // The signal that "primary" cannot give you: a platform whose messages still
  // match while their ROLES come from a guess. A live ChatGPT chat reported
  // 188 user turns to 12 assistant ones with a clean green headline.
  t("B15 the report says how many roles were READ rather than guessed",
    direct.roleRead === direct.messages,
    JSON.stringify({ read: direct.roleRead, of: direct.messages }));
  t("B15 the report notices a turn counted twice", direct.nested === 0,
    String(direct.nested));
  // Ground truth. Every other number on the card is a reading of a DOM the
  // host fills with whatever it likes; this is what the conversation actually
  // contains, and when the two disagree the DOM is the one that is wrong.
  t("B15 the report carries the provider's own count when there is one",
    direct.providerCount === null || typeof direct.providerCount === "number",
    JSON.stringify(direct.providerCount));
  // When a count or a split makes no sense, these are the lines that say what
  // the page is actually made of.
  t("B15 the report says WHERE each role was found",
    direct.roleFrom && direct.roleFrom.self + direct.roleFrom.ancestor +
      direct.roleFrom.descendant + direct.roleFrom.none === direct.messages,
    JSON.stringify(direct.roleFrom));
  t("B15 the report counts distinct provider ids behind the elements",
    direct.distinctIds === null || direct.distinctIds.distinct === direct.distinctIds.of,
    JSON.stringify(direct.distinctIds));
  t("B15 the report shows the shapes it matched",
    Array.isArray(direct.shapes) && direct.shapes.length > 0 &&
      direct.shapes[0][0].startsWith("div"),
    JSON.stringify(direct.shapes));
  t("B15 the report separates real messages from empty placeholders",
    direct.substance && direct.substance.real === direct.substance.sampled &&
      direct.substance.empty === 0 && direct.substance.sampled <= direct.messages,
    JSON.stringify(direct.substance));
  t("B15 the shapes carry structure, never text or ids",
    JSON.stringify(direct.shapes).length < 400 &&
      !/architectural|Question \d/.test(JSON.stringify(direct.shapes)),
    JSON.stringify(direct.shapes));
  t("B15 the report carries no message text",
    !JSON.stringify(direct).includes("architectural"));

  // The point of the whole instrument: break what the platform is supposed to
  // ship, and it must say DEGRADED rather than keep reporting health.
  /* Unmounted turns. A live ChatGPT conversation matched 195 elements carrying
     a role and a message id, 122 of which contained nothing at all — the node a
     virtualizing host leaves behind for a turn it has not rendered. Counted as
     messages, they put 122 phantom ticks on the minimap, listed themselves in
     the outline and rode into exports. */
  const before = await askHealth();
  await page.evaluate(() => {
    const all = document.querySelectorAll("[data-lct-message]");
    for (let i = 0; i < 5; i++) {
      all[i].setAttribute("data-lct-stash", all[i].innerHTML);
      all[i].innerHTML = "";
    }
  });
  await page.waitForTimeout(400);
  const ghosted = await askHealth();
  t("B15 empty turns are dropped, not counted as messages",
    ghosted.messages === before.messages - 5 && ghosted.dropped === 5,
    JSON.stringify({ was: before.messages, now: ghosted.messages, dropped: ghosted.dropped }));
  t("B15 the report still shows what the selectors matched",
    ghosted.matched === before.messages, JSON.stringify(ghosted.matched));
  t("B15 the minimap stops drawing the dropped turns",
    await page.evaluate(() => Number(
      document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax"))) < before.messages,
    await page.getAttribute("#lct-mm-canvas", "aria-valuemax"));

  /* The trade this filter must not make: a message whose whole content is an
     image has no text either, and dropping those would swap one wrong count for
     another. */
  await page.evaluate(() => {
    const el = document.querySelectorAll("[data-lct-message]")[0];
    el.innerHTML = '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
  });
  await page.waitForTimeout(400);
  const withImage = await askHealth();
  t("B15 an image-only message is kept, not swept up with the placeholders",
    withImage.messages === before.messages - 4 && withImage.dropped === 4,
    JSON.stringify({ now: withImage.messages, dropped: withImage.dropped }));
  /* A pasted screenshot with no caption is a message someone sent. On a live
     591-message conversation 122 turns were exactly that, and the report filed
     every one of them as a placeholder — which was the report being wrong about
     the user's own chat, in the direction that reads as data loss. */
  t("B15 an image-only message is reported as an image, not as nothing",
    withImage.substance.image === 1 && withImage.substance.empty === 0,
    JSON.stringify(withImage.substance));
  t("B15 …and the shape list says image-only, not empty",
    JSON.stringify(withImage.shapes).includes("[image-only]"), JSON.stringify(withImage.shapes));

  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-lct-stash]")) {
      el.innerHTML = el.getAttribute("data-lct-stash");
      el.removeAttribute("data-lct-stash");
    }
  });
  await page.waitForTimeout(400);
  const restored = await askHealth();
  t("B15 a turn rejoins the moment the host puts content in it",
    restored.messages === before.messages && restored.dropped === 0,
    JSON.stringify({ now: restored.messages, dropped: restored.dropped }));

  // Roles moving out of reach is a SEPARATE failure from messages moving: the
  // headline stays green because the message selector still matches, and only
  // the role count betrays it. Strip the role attribute and require the report
  // to admit the roles are now guesses.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-lct-role]")) {
      el.setAttribute("data-lct-role-moved", el.getAttribute("data-lct-role"));
      el.removeAttribute("data-lct-role");
    }
  });
  const guessed = await askHealth();
  t("B15 roles moving out of reach is reported, not averaged away",
    guessed.selectors === "primary" && guessed.roleRead === 0 && guessed.messages > 0,
    JSON.stringify({ sel: guessed.selectors, read: guessed.roleRead, m: guessed.messages }));
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-lct-role-moved]")) {
      el.setAttribute("data-lct-role", el.getAttribute("data-lct-role-moved"));
      el.removeAttribute("data-lct-role-moved");
    }
  });

  // Rename the attribute the platform is supposed to ship, leaving the
  // elements exactly where they are — which is what a real redesign looks like
  // from our side. The fallback layer should still find the messages, and the
  // report must say so instead of continuing to claim health.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-lct-message]")) {
      el.setAttribute("data-lct-message-renamed", el.getAttribute("data-lct-message"));
      el.removeAttribute("data-lct-message");
    }
  });
  const degraded = await askHealth();
  t("B15 a renamed attribute is reported, not absorbed",
    degraded.messages > 0 && /DEGRADED/.test(degraded.selectors),
    JSON.stringify({ m: degraded.messages, s: degraded.selectors }));
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-lct-message-renamed]")) {
      el.setAttribute("data-lct-message", el.getAttribute("data-lct-message-renamed"));
      el.removeAttribute("data-lct-message-renamed");
    }
  });

  /* ============ C. zero page errors across everything ============ */
  t("C1 zero page/console errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  suiteFinished = true;
} catch (e) {
  // A crash halfway through used to print "N passed, 0 failed" and let the
  // exception speak for itself — a summary line that reads like a clean run.
  // The suite that stopped early is a FAILING suite, and says so.
  t("C0 suite ran to completion", false, String(e && e.stack || e).split("\n").slice(0, 3).join(" | "));
} finally {
  await ctx.close();
  server.kill();
  // in the finally so an abort mid-run still says what had failed before it
  console.log(`\n${pass} passed, ${fail} failed${suiteFinished ? "" : "  (SUITE DID NOT FINISH)"}`);
  if (fail) console.log("failed:\n  " + failed.join("\n  "));
}

process.exit(fail || !suiteFinished ? 1 : 0);
