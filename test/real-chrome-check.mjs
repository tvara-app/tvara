#!/usr/bin/env node
/* Tvara — the autoscroll gate, checked in real Google Chrome.
 *
 * What it proves: an automatic history walk never takes the scroller off
 * somebody looking at the page, and the ⤒ walk they asked for still works.
 *
 * It ATTACHES to the one branded Chrome tools/chrome-real.mjs owns, starting
 * it only if nothing is listening, and never closes it. Run it as often as you
 * like: after the first run there is no dialog and no cold start.
 *
 *   node test/real-chrome-check.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { addDevHosts } from "./security-fixtures.mjs";
import { serve } from "../tools/serve.mjs";
import { ensureChrome, detach } from "../tools/chrome-real.mjs";

const SRC = join(import.meta.dirname, "..");
const EXT = join(SRC, "test", ".work", "ext-real");
const PORT = 8918;                       // not 8917: test-extension.mjs owns that one
const URL = `http://127.0.0.1:${PORT}/test/virtual-history.html`;

let pass = 0, fail = 0;
const t = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c || !x ? "" : "  → " + x}`); };

/* A mirror, not the repo: the fixture pages are served from 127.0.0.1 and the
   shipped manifest deliberately does not match there. Its own directory, so
   test-extension.mjs wiping test/.work/ext cannot pull the tree out from under
   a Chrome that has it loaded. */
rmSync(EXT, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });
const sync = spawnSync("rsync", [
  "-a", "--exclude", ".git", "--exclude", "node_modules", "--exclude", "test/.work*",
  "--exclude", "dist", "--exclude", "store", "--exclude", "tools/.keys",
  SRC + "/", EXT + "/"
]);
if (sync.status !== 0) { console.error("FATAL: could not mirror the extension"); process.exit(1); }
addDevHosts(EXT);
/* The manifest `key` pins the id to the key rather than the path, so this
   mirror and an unpacked repo in the same profile would claim ONE id and
   Chrome would refuse the second. Dropping it makes the id path-derived:
   stable across runs, and able to sit beside whatever else is loaded. */
const mfPath = join(EXT, "manifest.json");
const mf = JSON.parse(readFileSync(mfPath, "utf8"));
delete mf.key;
writeFileSync(mfPath, JSON.stringify(mf, null, 2));

const server = await serve(EXT, PORT);
const done = (code) => { server.close(); detach(code); };

const { ctx, extensionId } = await ensureChrome({ extPath: EXT }).catch((err) => {
  console.error("✋ " + err.message);
  server.close();
  process.exit(2);
});

let page = await ctx.newPage();
await page.goto(URL);
const alive = await page.waitForSelector("#lct-minimap", { timeout: 25000 }).then(() => true).catch(() => false);
t("the extension is running in real Google Chrome", alive);
if (!alive) done(1);

/* OURS, by id. A profile holds several extensions and this one has been loaded
   from two paths; writing settings into a stranger's store is a silent no-op
   that reads as the setting being ignored. */
const mine = (w) => w.url().startsWith(`chrome-extension://${extensionId}/`);
let worker = ctx.serviceWorkers().find(mine);
for (let i = 0; !worker && i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  worker = ctx.serviceWorkers().find(mine);
}
t("its service worker is reachable", !!worker);
if (!worker) done(1);

/* The contract these two pages hold is the one test-extension.mjs B2c0/B2c1
   prove in Chromium, re-proved on the browser people actually use.

   UNTICKED: nothing is walked and nothing moves — including when the reader
   scrolls back to read older turns, which used to be taken as permission and
   cost them the page for sixty round trips. */
const set = (s) => worker.evaluate((v) => chrome.storage.local.set({ settings: v }), s);
await set({ enabled: true, minimap: true, time: true, history: false });
await page.close();
page = await ctx.newPage();
await page.goto(URL);
await page.waitForSelector("#lct-minimap", { timeout: 25000 });
const quiet = await page.evaluate(async () => {
  const s = document.getElementById("virtual-scroller");
  const before = { loads: window.__virtualHistory.loads, top: s.scrollTop };
  await new Promise((r) => setTimeout(r, 3000));
  return { before, loads: window.__virtualHistory.loads, top: s.scrollTop,
    state: document.documentElement.dataset.lctHistoryState || "(never started)" };
});
t("unticked, opening a long chat walks nothing and moves nothing",
  quiet.loads === quiet.before.loads && quiet.top === quiet.before.top &&
  quiet.state === "(never started)", JSON.stringify(quiet));

await page.evaluate(() => { document.getElementById("virtual-scroller").scrollTop = 0; });
await page.waitForTimeout(3000);
const atTop = await page.evaluate(() => document.documentElement.dataset.lctHistoryState || "(never started)");
t("scrolling up to read older turns is not permission to walk", atTop === "(never started)", atTop);

// The ⤒ button — asked for out loud, so it still moves the page.
await page.waitForSelector('#lct-export-bar [data-act="history"]', { state: "attached", timeout: 20000 });
await page.evaluate(() => document.querySelector('#lct-export-bar [data-act="history"]').click());
const walked = await page.waitForFunction(
  () => document.documentElement.dataset.lctHistoryState === "complete", null, { timeout: 60000 }
).then(() => true).catch(() => false);
const mounted = await page.evaluate(() => document.querySelectorAll("[data-message-id]").length);
t("the ⤒ walk still loads every older message", walked && mounted === 240,
  `walked=${walked}, mounted=${mounted}`);
await page.close();

/* TICKED: the whole conversation arrives on its own, and the reader never sees
   it happen — the walk runs behind makeFreeze() and hands back the exact view. */
await set({ enabled: true, minimap: true, time: true, history: true });
const armed = await ctx.newPage();
await armed.goto(URL);
await armed.waitForSelector("#lct-minimap", { timeout: 25000 });
const auto = await armed.evaluate(async () => {
  const s = document.getElementById("virtual-scroller");
  let sawFreeze = false;
  for (let i = 0; i < 600; i++) {
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
    // Opened at the bottom, so the newest turn is what has to be in front of
    // them afterwards. "Still on screen", not a pixel delta: there is no moment
    // reliably before the walk to measure a delta from.
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
t("ticked, opening a long chat loads every older turn",
  auto.state === "complete" && auto.mounted === 240 && auto.loads >= 10, JSON.stringify(auto));
t("…behind a freeze, and the reader is handed back the exact view",
  auto.sawFreeze && auto.freezeGone && auto.visibility !== "hidden" && auto.anchorOnScreen,
  JSON.stringify(auto));
await armed.close();

console.log(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
