#!/usr/bin/env node
/**
 * Tvara — temporary / private / signed-out conversations, in a real browser.
 *
 * test-ephemeral.mjs proves the decision function. This proves the FEATURE:
 * the real unpacked extension, loaded into Chromium, running against a page
 * served at https://chatgpt.com/ with no conversation id — which is exactly the
 * shape a temporary chat, a private chat and a signed-out session all take.
 *
 * The page is served by page.route rather than fetched, so the content scripts
 * match the real host pattern and the real adapter is chosen. Nothing about the
 * extension is patched: this is the build that ships.
 *
 * What it has to prove, because unit tests cannot:
 *   · the messages are actually read off a page with no /c/ in its URL
 *   · nothing is archived while the toggle is off
 *   · everything is archived once it is on, under an id derived from the chat
 *   · two different temporary chats do not overwrite each other
 *   · the recording badge is visible while it happens
 *   · Context Bridge can still reach the composer and insert
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const SRC = join(import.meta.dirname, "..");
const SCRATCH = join(SRC, "test", ".work-temp");
const PROFILE = join(SCRATCH, "chrome-profile");
const EXT = join(SCRATCH, "ext");
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });

const sync = spawnSync("rsync", [
  "-a", "--exclude", ".git", "--exclude", "node_modules",
  "--exclude", "test/.work*", "--exclude", ".stryker-tmp",
  SRC + "/", EXT + "/"
]);
if (sync.status !== 0) { console.error("FATAL: could not mirror the extension"); process.exit(1); }

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

function idSeed(dir) {
  // Chrome derives an unpacked extension's id from its absolute path.
  return dir;
}
const computedId = [...createHash("sha256").update(idSeed(EXT)).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join("");
function idFromProfile() {
  for (const f of ["Preferences", "Secure Preferences"]) {
    try {
      const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", f), "utf8"));
      for (const [id, v] of Object.entries(prefs.extensions?.settings || {})) {
        if (v.path === EXT) return id;
      }
    } catch { /* not written yet */ }
  }
  return null;
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: process.env.PW_CHANNEL || "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 800 }
});
await new Promise((r) => setTimeout(r, 1500));

/* The id Chrome actually registered. The service worker's own URL carries it,
   which beats deriving it from the path and beats reading Preferences before
   Chrome has written them. */
async function extensionId() {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    try { sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 }); }
    catch { /* fall through */ }
  }
  if (sw) { try { return new URL(sw.url()).host; } catch { /* fall through */ } }
  return idFromProfile() || computedId;
}
const EXT_ID = await extensionId();

/* ---------- the page a temporary chat actually is ----------
   Real ChatGPT markup: data-message-id + data-message-author-role, which is the
   adapter's layer 1. The URL is "/" — no conversation id, because the provider
   never made one. */
/* Both fixtures deliberately reuse the SAME message ids (tm-0, tm-1 …). That is
   the adversarial case: a host that numbers messages per conversation rather
   than globally. If the ephemeral id ever goes back to seeding from the
   provider id alone, these two chats collide and this file says so. */
function transcript(turns) {
  return turns.map((txt, i) =>
    `<div data-message-id="tm-${i}" data-message-author-role="${i % 2 ? "assistant" : "user"}">
       <div class="markdown"><p>${txt}</p></div>
     </div>`).join("\n");
}

const chatHtml = (title, turns) => `<!doctype html><html><head><title>${title}</title></head>
<body><main>${transcript(turns)}</main>
<textarea id="prompt-textarea" rows="3"></textarea>
</body></html>`;

const CHAT_A = Array.from({ length: 14 }, (_, i) =>
  i === 0 ? "How do I make a Cloudflare Worker verify a webhook signature"
          : `Turn ${i} about HMAC and Standard Webhooks, padded so it counts as real text.`);
const CHAT_B = Array.from({ length: 12 }, (_, i) =>
  i === 0 ? "Explain why IndexedDB transactions auto-close"
          : `Turn ${i} about IndexedDB lifetimes, padded so it counts as real text.`);

/* Each chat gets its own query string. The pathname stays "/" — which is what
   the ephemeral check actually reads — but the URL differs, so Chrome cannot
   serve the second temporary chat out of the first one's cache. That bit us
   once already: two pages at the identical URL came back byte-identical, which
   looked exactly like the archive overwriting itself. The query also mirrors
   the real thing, since ChatGPT sets ?temporary-chat=true. */
async function openChat(html, tag) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { fail++; failed.push("pageerror: " + e.message); });
  await page.route("https://chatgpt.com/**", (route) =>
    route.fulfill({
      status: 200, contentType: "text/html", body: html,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" }
    }));
  await page.goto(`https://chatgpt.com/?temporary-chat=true&c=${tag}`);
  return page;
}

/* Ground truth, straight out of the archive's own IndexedDB.
   recall-search would be the natural read, but it is entitlement-gated — an
   unlicensed test install gets an empty result whether the write happened or
   not, which is exactly the false green this file exists to avoid. An extension
   page shares the worker's origin, so it sees the same database. */
async function archive() {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${EXT_ID}/recall.html`);
  const rows = await p.evaluate(() => new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    setTimeout(() => finish([]), 8000);
    const req = indexedDB.open("lct-recall");
    req.onerror = () => finish([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chats")) return finish([]);
      const all = db.transaction("chats", "readonly").objectStore("chats").getAll();
      all.onerror = () => finish([]);
      all.onsuccess = () => finish(all.result.map((c) => ({
        id: c.id, host: c.host, path: c.path, temp: c.temp || 0,
        n: (c.msgs || []).length, title: c.title || "",
        first: (((c.msgs || [])[0] || {}).t || "").slice(0, 60)
      })));
    };
  }));
  await p.close();
  return rows;
}

async function setSettings(patch) {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${EXT_ID}/popup/popup.html`);
  await p.evaluate(async (patch) => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } });
  }, patch);
  await p.close();
}

const settle = (ms = 5000) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. the adapter reads a page with no conversation id ---------- */

await setSettings({ enabled: true, tempArchive: false });
const a = await openChat(chatHtml("Cloudflare webhooks", CHAT_A), "a");
await settle(4000);

/* Content scripts run in an isolated world, so self.LCTAdapters is invisible to
   page.evaluate. Everything below is asserted through what the extension does
   to the page and to the archive, which is the better test anyway. */
const seen = await a.evaluate(() => ({
  path: location.pathname,
  minimap: !!document.getElementById("lct-minimap"),
  composer: !!document.querySelector("#prompt-textarea")
}));
t("the URL carries no conversation id", seen.path === "/", seen.path);
t("the extension attaches to a temporary chat at all", seen.minimap, JSON.stringify(seen));
t("the composer Context Bridge injects into is present", seen.composer, JSON.stringify(seen));

/* ---------- 2. off by default ---------- */

const before = await archive();
t("nothing is archived while the toggle is off",
  before.length === 0, JSON.stringify(before.map((r) => r.id)));
t("no recording badge while the toggle is off",
  (await a.locator("#lct-temp-badge").count()) === 0);

/* ---------- 3. opted in ---------- */

await setSettings({ enabled: true, tempArchive: true });
await a.reload();
await settle(6000);

t("the recording badge is shown while archiving",
  (await a.locator("#lct-temp-badge").count()) === 1);

const after = await archive();
t("the temporary chat is archived once opted in", after.length === 1, JSON.stringify(after));
t("…under an id derived from the chat, not the URL",
  after.some((r) => r.id.includes("#temp-")), JSON.stringify(after.map((r) => r.id)));
t("…flagged temporary, so Recall can label it",
  after.every((r) => r.temp === 1), JSON.stringify(after.map((r) => r.temp)));
t("…with EVERY message scraped off the page",
  after[0] && after[0].n === CHAT_A.length,
  `${after[0] && after[0].n} of ${CHAT_A.length}`);
t("…and the real transcript text, not a placeholder",
  after[0] && /Cloudflare Worker/.test(after[0].first), JSON.stringify(after[0] && after[0].first));

/* ---------- 4. a second temporary chat does not overwrite the first ---------- */

const b = await openChat(chatHtml("IndexedDB lifetimes", CHAT_B), "b");
await settle(6000);

const both = await archive();
const tempRows = both.filter((r) => r.temp === 1);
t("a second temporary chat is archived separately, not over the first",
  tempRows.length === 2, JSON.stringify(both.map((r) => `${r.id} n=${r.n}`)));
t("…and both keep their own transcript",
  tempRows.some((r) => /Cloudflare Worker/.test(r.first)) &&
  tempRows.some((r) => /IndexedDB/.test(r.first)),
  JSON.stringify(tempRows.map((r) => r.first)));
t("…even though both sat at the same URL",
  tempRows.every((r) => r.path === "/"), JSON.stringify(tempRows.map((r) => r.path)));

/* ---------- 5. the minimap does not carry ghosts between them ---------- */

/* The map paints to a canvas, so there are no ticks to count. What can be
   checked is that it drew: a blank canvas is the ghost-free failure mode too. */
const mapB = await b.evaluate(() => {
  const rail = document.getElementById("lct-minimap");
  const cv = document.getElementById("lct-mm-canvas");
  if (!rail || !cv || !cv.width) return { present: !!rail, painted: false };
  const px = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let ink = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 8) ink++;
  return { present: true, painted: ink > 0, ink };
});
t("the minimap renders on a temporary chat", mapB.present, JSON.stringify(mapB));
t("…and actually paints the conversation", mapB.painted, JSON.stringify(mapB));

/* ---------- 6. Context Bridge can still reach the composer ---------- */

/* Opening the Bridge panel needs Pro, which this unlicensed install has not
   got. What matters here is that a temporary chat is a valid Bridge TARGET —
   the toolbar wired up and the composer resolvable — since bridge.js has no
   path gate of its own. The insertion path itself is covered by the suite. */
const bridge = await b.evaluate(() => ({
  toolbar: !!document.getElementById("lct-export-bar"),
  bridgeButton: !!document.querySelector('[data-act="bridge"]'),
  composer: !!document.querySelector("#prompt-textarea")
}));
t("the Tvara toolbar renders on a temporary chat", bridge.toolbar, JSON.stringify(bridge));
t("…including the Context Bridge control", bridge.bridgeButton, JSON.stringify(bridge));
t("…and the composer it injects into is reachable", bridge.composer, JSON.stringify(bridge));

/* ---------- 7. turning it back off stops new writes ---------- */

await setSettings({ enabled: true, tempArchive: false });
const c = await openChat(chatHtml("Third chat", CHAT_B.map((s) => s.replace("Turn", "Third"))), "c");
await settle(5000);
const afterOff = await archive();
t("the archive keeps what it already had when switched off",
  afterOff.filter((r) => r.temp === 1).length === 2,
  JSON.stringify(afterOff.map((r) => r.id)));
t("…and the third chat is NOT added",
  !afterOff.some((r) => /Third/.test(r.first)), JSON.stringify(afterOff.map((r) => r.first)));
t("no badge once switched back off", (await c.locator("#lct-temp-badge").count()) === 0);

await ctx.close();
if (failed.length) { console.log("\n--- failures ---"); failed.forEach((f) => console.log("  " + f)); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
