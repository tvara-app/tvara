#!/usr/bin/env node
/**
 * Tvara, live check of the BACKGROUND SYNC path.
 *
 *   node tools/sync-check.mjs            # run a real sync, report per platform
 *   node tools/sync-check.mjs --status   # just read the current state, sync nothing
 *
 * WHY THIS EXISTS ALONGSIDE live-check.mjs
 * live-check proves the DOM adapters: what Tvara reads out of the page you are
 * looking at. This proves the other half, the one Total Recall is actually sold
 * on: the background worker calling each provider's own history API with your
 * cookies and building the archive. They are different code against different
 * endpoints, and a green adapter says nothing about a broken sync.
 *
 * It reads your history into the LOCAL archive, which is exactly what the
 * product does for every user. Nothing is uploaded; there is no server.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "test", ".work", "live");
const PORT = Number(process.env.LCT_CDP_PORT || 9222);
const STATUS_ONLY = process.argv.includes("--status");
const BUDGET_MS = 6 * 60 * 1000;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
if (!browser) {
  console.error(`✋ Nothing is listening on 127.0.0.1:${PORT}. Start the cloned Chrome first.`);
  process.exit(1);
}
const ctx = browser.contexts()[0];

async function worker() {
  /* ONE install, named explicitly when there is more than one.
     Matching "the first extension worker" was wrong (a real profile has a dozen
     extensions and it reached a stranger's content scripts). Matching "the
     first TVARA worker" is also wrong: this clone had TWO copies of Tvara
     installed, each with its own IndexedDB, so consecutive runs read different
     archives and the second looked like catastrophic data loss — 2,306 chats
     down to 460 — when nothing had been lost at all.
     The name probe is URL-filtered and time-boxed because at least one other
     extension's worker never answers an evaluate and hung the whole run. */
  const named = async (w) => {
    if (!/^chrome-extension:\/\//.test(w.url())) return null;
    const probe = w.evaluate(() => ({ n: chrome.runtime.getManifest().name, id: chrome.runtime.id }))
      .catch(() => null);
    const info = await Promise.race([probe, new Promise((r) => setTimeout(() => r(null), 2500))]);
    return info && /^Tvara\b/.test(info.n || "") ? info.id : null;
  };
  const all = ctx.serviceWorkers();
  const ordered = all.filter((w) => /\/bg\.js(\?|$)/.test(w.url()))
    .concat(all.filter((w) => !/\/bg\.js(\?|$)/.test(w.url())));
  const found = [];
  for (const w of ordered) { const id = await named(w); if (id) found.push({ w, id }); }
  if (!found.length) {
    const w = await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null);
    const id = w && await named(w);
    if (id) found.push({ w, id });
  }
  if (!found.length) return null;
  const want = (() => { const i = process.argv.indexOf("--ext"); return i < 0 ? null : process.argv[i + 1]; })();
  if (want) {
    const hit = found.find((f) => f.id === want);
    if (!hit) { console.error(`✋ No Tvara install with id ${want}. Present: ${found.map((f) => f.id).join(", ")}`); process.exit(1); }
    return hit.w;
  }
  if (found.length > 1) {
    console.error("✋ More than one copy of Tvara is installed in this browser:");
    for (const f of found) console.error(`     ${f.id}`);
    console.error("   They keep SEPARATE archives, so a reading from one says nothing about");
    console.error("   the other. Disable the duplicate at chrome://extensions, or pass");
    console.error("   --ext <id> to pick one deliberately.");
    process.exit(1);
  }
  return found[0].w;
}

// A dormant MV3 worker is not listed until something wakes it.
let sw = await worker();
if (!sw) {
  const p = await ctx.newPage();
  await p.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(5000);
  sw = await worker();
}
if (!sw) { console.error("✋ The Tvara service worker is not running in this Chrome."); process.exit(1); }

/* Called directly, not messaged. chrome.runtime.sendMessage from the service
   worker never reaches the worker's OWN onMessage listener — a context does not
   receive its own message — so the first version of this got an empty reply for
   every call and reported an empty archive on a browser that has one.
   bg.js declares these as top-level `function`s, which are globals in the
   worker scope. */
const call = (fn, arg) => sw.evaluate(async ([f, a]) => {
  try {
    const r = a === undefined ? await self[f]() : await self[f](a);
    return JSON.parse(JSON.stringify(r ?? null));
  } catch (e) { return { error: String((e && e.message) || e) }; }
}, [fn, arg]);

const before = await call("stats");
console.log(`archive before: ${(before?.chats ?? 0).toLocaleString()} chats, ` +
            `${(before?.msgs ?? 0).toLocaleString()} messages\n`);

if (!STATUS_ONLY) {
  console.log("→ running a real sync against your signed-in accounts…\n");
  call("bgSyncAll", { reason: "manual" }).catch(() => {});   // long-running; poll instead
  const started = Date.now();
  let last = "";
  while (Date.now() - started < BUDGET_MS) {
    await new Promise((r) => setTimeout(r, 6000));
    const st = await call("bgSyncStatus");
    const running = st && st.run && st.run.running;
    const line = st && st.run ? `${st.run.phase || "working"} ${st.run.pct ?? ""}%` : "…";
    if (line !== last) { process.stdout.write(`   ${line}\n`); last = line; }
    if (!running && Date.now() - started > 12000) break;
  }
}

const st = await call("bgSyncStatus");
const after = await call("stats");

console.log("\n" + "─".repeat(70) + "\n");
const plats = (st && st.platforms) || {};
const counts = (after && after.byPlatform) || {};
let bad = 0;
/* The states the worker can honestly be in. Rate-limiting and "waiting until
   you're done" are DESIGNED behaviours, not failures: the first backs off from
   a provider that asked it to, the second refuses to compete with the user for
   the same account. Neither is a broken sync, and reporting them as one would
   train you to ignore this tool. */
for (const [id, p] of Object.entries(plats)) {
  const pr = p.progress || {};
  const msg = String(pr.msg || "");
  const lastFull = (p.flag && p.flag.lastFull) || 0;
  const archived = Object.entries(counts)
    .find(([label]) => label.toLowerCase().replace(/\s/g, "") === (p.label || id).toLowerCase().replace(/\s/g, ""));
  const held = archived ? archived[1] : 0;
  const age = lastFull ? Math.round((Date.now() - lastFull) / 60000) : null;
  let mark = "✓", verdict;
  if (/not signed in|signed out/i.test(msg)) { mark = "·"; verdict = "not signed in, nothing to sync"; }
  else if (/rate-limit/i.test(msg)) verdict = `backing off as asked, resumes by itself · ${held.toLocaleString()} chats held`;
  else if (/waiting until/i.test(msg)) verdict = `deferring while you use the site · ${held.toLocaleString()} chats held`;
  else if (/changed its API|needs a Tvara update/i.test(msg)) { mark = "✗"; verdict = `ADAPTER BROKEN: ${msg}`; bad++; }
  else if (pr.failed) { mark = "!"; verdict = `${pr.failed} failed · ${msg}`; bad++; }
  else if (!lastFull && held) {
    /* Holding data with no error is a long pass in progress, not a failure.
       ChatGPT's first full pass takes hours behind its own rate limiting, and
       calling that "never completed" while the count climbs every run is the
       kind of false alarm that teaches you to stop reading the output. */
    verdict = `${held.toLocaleString()} chats held · first full pass still running`;
  }
  else if (!lastFull) { mark = "!"; verdict = "has never completed a pass, and holds nothing"; bad++; }
  else if (!held) { mark = "!"; verdict = `completed a pass but holds nothing · ${msg}`; bad++; }
  else verdict = `${held.toLocaleString()} chats held · ${msg.toLowerCase()}`;
  console.log(`  ${mark} ${(p.label || id).padEnd(11)} ${verdict}` +
              (age !== null && mark === "✓" ? `  (last pass ${age < 60 ? age + "m" : Math.round(age / 60) + "h"} ago)` : ""));
}
console.log(`\n  archive after: ${(after?.chats ?? 0).toLocaleString()} chats, ` +
            `${(after?.msgs ?? 0).toLocaleString()} messages`);
console.log(`  by platform: ${JSON.stringify(after?.byPlatform || {})}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "sync-check.json"), JSON.stringify({ before, status: st, after }, null, 2));
console.log(`\n  report: ${join(OUT, "sync-check.json")}\n`);
if (typeof browser.disconnect === "function") await browser.disconnect().catch(() => {});
process.exit(bad ? 1 : 0);
