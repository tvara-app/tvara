#!/usr/bin/env node
/* Tvara — the autoscroll gate, checked in the real Google Chrome you are
 * already running. It ATTACHES; it never launches or closes a browser.
 *
 * Branded Chrome has refused --load-extension since M136, and on 152 the CDP
 * replacement (Extensions.loadUnpacked) returns an id while installing
 * nothing — chrome://extensions comes back empty. So the extension has to be
 * put in by hand, once, and this reads the result.
 *
 *   1. Quit Chrome, then:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 --user-data-dir="$HOME/.lct-chrome-test"
 *      (The port is refused on the default profile since M136. Not optional.)
 *   2. chrome://extensions -> Developer mode -> Load unpacked -> test/.work/ext
 *      (npm run test:extension builds that mirror; it is the repo plus a test
 *      signing key and the 127.0.0.1 fixture host.)
 *   3. node test/real-chrome-check.mjs
 *
 * What it proves: an automatic history walk never takes the scroller off
 * somebody looking at the page, and the ⤒ walk they asked for still works.
 */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";

const EXT = join(import.meta.dirname, ".work", "ext");
const URL = "http://127.0.0.1:8917/test/virtual-history.html";
let pass = 0, fail = 0;
const t = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c || !x ? "" : "  → " + x}`); };

const srv = spawn("python3", ["-m", "http.server", "8917", "--bind", "127.0.0.1"], { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const PORT = Number(process.env.LCT_CDP_PORT || 9222);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
if (!browser) {
  srv.kill();
  console.error(`\nNothing is listening on 127.0.0.1:${PORT}. See the header of this file: ` +
    `start Chrome with --remote-debugging-port and a --user-data-dir, load test/.work/ext ` +
    `unpacked, then run this again.`);
  process.exit(2);
}
const ctx = browser.contexts()[0];
// Attached, never owned: closing pages we opened is the most this may do.
/* Attached, never owned. Disconnect; do NOT close — the browser outlives this
   script so every run reuses the one instance a person already has open. */
const done = async (code) => { srv.kill(); process.exit(code); };

/* Chrome 152 will not take an unpacked extension from the command line, and
   Extensions.loadUnpacked reports an id while installing nothing. What is left
   is the button, and the button opens a native file dialog — so the dialog gets
   driven too. Idempotent: if it is already installed this does nothing. */
const info = async (pg) => pg.evaluate(() =>
  new Promise((r) => chrome.developerPrivate.getExtensionsInfo({}, (l) => r(l || [])))).catch(() => []);
const ex = await ctx.newPage();
await ex.goto("chrome://extensions");
if (!(await info(ex)).length) {
  await ex.evaluate(() => {
    const m = document.querySelector("extensions-manager");
    const tb = m.shadowRoot.querySelector("extensions-toolbar");
    const tog = tb.shadowRoot.querySelector("#devMode");
    if (tog && !tog.checked) tog.click();
  });
  await ex.waitForTimeout(600);
  await ex.bringToFront();
  await ex.evaluate(() => {
    const m = document.querySelector("extensions-manager");
    const tb = m.shadowRoot.querySelector("extensions-toolbar");
    tb.shadowRoot.querySelector("#loadUnpacked").click();
  });
  await ex.waitForTimeout(1500);
  execFileSync("osascript", ["-e", `
    tell application "System Events"
      keystroke "g" using {shift down, command down}
      delay 0.6
      keystroke "${EXT}"
      delay 0.5
      keystroke return
      delay 0.9
      keystroke return
    end tell`]);
  await ex.waitForTimeout(2500);
}
const installed = await info(ex);
t("the extension is installed in this Google Chrome", installed.length === 1,
  JSON.stringify(installed.map((e) => ({ name: e.name, state: e.state }))));
await ex.close();
if (!installed.length) {
  console.error("\nCould not install it automatically (the file dialog needs Accessibility " +
    "permission for whatever is running this). In the Chrome window that is already open: " +
    "chrome://extensions -> Load unpacked -> " + EXT + ", then run this again.");
  await done(1);
}

const page = await ctx.newPage();
await page.goto(URL);
const alive = await page.waitForSelector("#lct-minimap", { timeout: 25000 }).then(() => true).catch(() => false);
t("the extension is running in real Google Chrome", alive);
if (!alive) await done(1);

const worker = ctx.serviceWorkers()[0] ||
  await ctx.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
t("its service worker is reachable", !!worker);
if (worker) {
  await worker.evaluate(() => chrome.storage.local.set({
    settings: { enabled: true, minimap: true, time: true, history: true }
  }));
}

// Full-history loading ON, long chat freshly opened.
await page.reload();
await page.waitForSelector("#lct-minimap", { timeout: 25000 });
const opened = await page.evaluate(async () => {
  const s = document.getElementById("virtual-scroller");
  const top = s.scrollTop;
  await new Promise((r) => setTimeout(r, 3000));
  return { moved: s.scrollTop !== top, state: document.documentElement.dataset.lctHistoryState || "(never started)" };
});
t("opening a long chat does not move it", !opened.moved && opened.state === "(never started)", JSON.stringify(opened));

/* The reported bug: the reader scrolls back to read older turns, and the walk
   used to read that as permission and take the page for sixty round trips. */
await page.evaluate(() => { document.getElementById("virtual-scroller").scrollTop = 0; });
await page.waitForTimeout(3500);
const atTop = await page.evaluate(() => document.documentElement.dataset.lctHistoryState || "(never started)");
t("scrolling up to read older turns is not permission to walk", atTop === "(never started)", atTop);

// The ⤒ button — asked for out loud, so it still moves the page.
await page.waitForSelector('#lct-export-bar [data-act="history"]', { state: "attached", timeout: 20000 });
await page.evaluate(() => document.querySelector('#lct-export-bar [data-act="history"]').click());
const walked = await page.waitForFunction(
  () => document.documentElement.dataset.lctHistoryState === "complete", null, { timeout: 40000 }
).then(() => true).catch(() => false);
const mounted = await page.evaluate(() => document.querySelectorAll("[data-message-id]").length);
t("the ⤒ walk still loads every older message", walked && mounted === 240, `state walked=${walked}, mounted=${mounted}`);

console.log(`\n${pass} passed, ${fail} failed`);
await done(fail ? 1 : 0);
