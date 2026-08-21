#!/usr/bin/env node
/**
 * Tvara, live adapter check across every supported platform.
 *
 *   ./tools/chrome-clone.sh "Profile N"     # once, if the clone does not exist
 *   node tools/live-check.mjs               # then this
 *
 * WHY THIS EXISTS SEPARATELY FROM verify-live.mjs
 * verify-live launches its own throwaway profile, so it can only see platforms
 * you have signed into IN that profile. This attaches over CDP to a Chrome that
 * is already running with your real sessions, which is the only way to check
 * six providers without signing into six accounts twice.
 *
 * It opens each platform, waits for the adapter to settle, and asks the content
 * script for the same health report the diagnostics page reads. Nothing is
 * typed, nothing is sent, no conversation text leaves the tab: the report is
 * counts and selector names.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "test", ".work", "live");
const PORT = Number(process.env.LCT_CDP_PORT || 9222);

/* `conv` is how a real conversation is reached from the landing page. Checking
   the landing page alone proves only that nothing crashed: every adapter reads
   zero messages there, which is now correct behaviour and tells us nothing
   about whether it can read a conversation. */
const PLATFORMS = [
  { id: "chatgpt",    name: "ChatGPT",    url: "https://chatgpt.com/",          conv: 'a[href^="/c/"]' },
  { id: "claude",     name: "Claude",     url: "https://claude.ai/recents",     conv: 'a[href^="/chat/"]' },
  { id: "gemini",     name: "Gemini",     url: "https://gemini.google.com/app", conv: '[data-test-id="conversation"], a[href^="/app/"]' },
  { id: "deepseek",   name: "DeepSeek",   url: "https://chat.deepseek.com/",    conv: 'a[href*="/chat/s/"]' },
  { id: "grok",       name: "Grok",       url: "https://grok.com/",             conv: 'a[href^="/c/"], a[href^="/chat/"]' },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/",    conv: 'a[href^="/search/"]' }
];

const only = (() => {
  const i = process.argv.indexOf("--only");
  return i < 0 ? null : (process.argv[i + 1] || "").split(",").map((s) => s.trim());
})();
const wanted = PLATFORMS.filter((p) => !only || only.includes(p.id));

/* --matrix: cross-reference this run against the Layer-4 combinatorial
   matrix's real-provider slice (test/matrix-rows.mjs) — the ~82% of rows
   that need a real, already-logged-in session and are deliberately kept off
   CI (see the plan's Item 0). This doesn't drive those rows itself (that's
   real UI-matrix work, not a health ping); it reports which (surface, host)
   pairs the matrix wants covered, so a human running this attended check
   knows what a "healthy" verdict here does and doesn't stand in for.
   Defensive: matrix-rows.mjs's shape has changed during active development
   on this repo — a failure here degrades to a note, never blocks the actual
   health check below, which has run standalone since before the matrix
   existed and must keep working if it's gone or reshaped again. */
async function matrixRealProviderSummary() {
  try {
    const mod = await import(join(root, "test", "matrix-rows.mjs"));
    if (typeof mod.generateRows !== "function") return null;
    const rows = mod.generateRows();
    const REAL_HOSTS = new Set(PLATFORMS.map((p) => p.id));
    const relevant = rows.filter((r) => REAL_HOSTS.has(r.host));
    if (!relevant.length) return null;
    const bySurfaceHost = new Map(); // "surface|host" -> count
    for (const r of relevant) {
      const k = `${r.surface}|${r.host}`;
      bySurfaceHost.set(k, (bySurfaceHost.get(k) || 0) + 1);
    }
    const surfaces = [...new Set(relevant.map((r) => r.surface))].sort();
    return { totalRows: relevant.length, surfaces, bySurfaceHost };
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}
const showMatrix = process.argv.includes("--matrix");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
if (!browser) {
  console.error(`✋ Nothing is listening on 127.0.0.1:${PORT}.`);
  console.error("   Start the cloned Chrome first, then run this again.");
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
    return info && info.n === "Tvara" ? info.id : null;
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

/** Ask ONE tab for its health report, through the worker (content scripts live
 *  in an isolated world that page.evaluate cannot reach). */
async function ask(sw, urlPrefix) {
  return sw.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => (x.url || "").startsWith(prefix));
    if (!t) return { missing: true };
    return new Promise((res) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; res(v); } };
      setTimeout(() => finish({ timeout: true }), 6000);
      try {
        chrome.tabs.sendMessage(t.id, { type: "lct-health" }, (r) => {
          void chrome.runtime.lastError;
          finish(r || { noAnswer: true });
        });
      } catch { finish({ noAnswer: true }); }
    });
  }, urlPrefix);
}

const rows = [];
for (const p of wanted) {
  process.stdout.write(`→ ${p.name.padEnd(11)} `);
  let page = null;
  try {
    /* Close any tab already on this origin before opening ours. A tab that was
       open before the extension last reloaded has no content script left in it
       (it is orphaned, by design), and asking THAT one instead of the tab we
       just opened reports a working adapter as "no answer". */
    for (const old of ctx.pages()) {
      try { if (new URL(old.url()).origin === new URL(p.url).origin) await old.close(); }
      catch { /* about:blank and friends */ }
    }
    page = await ctx.newPage();
    await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // These are all SPAs: the sidebar mounts well after DOMContentLoaded.
    await page.waitForTimeout(8000);

    /* Into the newest conversation. Clicked rather than navigated by URL: these
       are client-routed apps, and a cold load of a deep link takes a different
       code path from the one a user actually walks. */
    const convLinks = p.conv
      ? await page.locator(p.conv).count().catch(() => 0)
      : 0;
    let opened = false;
    if (p.conv && convLinks) {
      const link = page.locator(p.conv).first();
      /* Navigate by href where there is one. Clicking is closer to what a user
         does, but on Perplexity the sidebar click did not navigate at all and
         the health report was taken on the landing page: "0 messages" that
         looked like a broken adapter and was actually a check that never ran.
         A URL is deterministic; the click stays as the fallback for the hosts
         whose conversation entries are not links (Gemini). */
      const href = await link.getAttribute("href").catch(() => null);
      if (href) {
        const abs = href.startsWith("http") ? href : new URL(p.url).origin + href;
        await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      } else {
        await link.click({ timeout: 8000 }).catch(() => {});
      }
      await page.waitForTimeout(11000);
      opened = true;
    }
    /* Signed out is decided by EVIDENCE, not by page words. Every one of these
       sites shows "sign up" somewhere even to a signed-in user, and the earlier
       word test called a fully signed-in Perplexity account signed out while it
       was listing 27 of the user's own threads. If the sidebar has links to
       real conversations, someone is signed in. */
    const signedOut = convLinks === 0 && await page.evaluate(() => {
      const t = (document.body.innerText || "").slice(0, 4000).toLowerCase();
      return /log in|sign in|sign up|create account|continue with google/.test(t);
    }).catch(() => false);
    const sw = await worker();
    const h = sw ? await ask(sw, new URL(p.url).origin) : { noWorker: true };
    rows.push({ ...p, signedOut, opened, h });
    console.log(h && h.adapter ? "answered" : "no report");
  } catch (e) {
    rows.push({ ...p, error: String(e && e.message || e).slice(0, 90) });
    console.log("failed");
  }
}

/* ---------- verdict ---------- */
console.log("\n" + "─".repeat(66) + "\n");
let bad = 0, unchecked = 0;
for (const r of rows) {
  const h = r.h || {};
  let mark = "·", verdict;
  if (r.error) { mark = "✗"; verdict = `could not open: ${r.error}`; bad++; }
  else if (r.signedOut) { verdict = "signed out in this profile, nothing to check"; unchecked++; }
  else if (h.noWorker) { mark = "✗"; verdict = "the extension's service worker is not running"; bad++; }
  else if (h.missing || h.noAnswer || h.timeout) {
    mark = "✗"; verdict = "no answer from the content script (it did not load here)"; bad++;
  } else if (h.error) { mark = "✗"; verdict = `the adapter threw: ${h.error}`; bad++; }
  else if (typeof h.messages !== "number") { mark = "✗"; verdict = "unreadable report"; bad++; }
  else if (h.messages === 0) {
    verdict = r.opened
      ? "opened a conversation but read 0 messages: THE ADAPTER IS NOT MATCHING"
      : "no conversation found in the sidebar, nothing to read";
    if (r.opened) { mark = "✗"; bad++; } else unchecked++;
  }
  else {
    const roles = h.roles || {};
    const ok = h.messages > 0 && (roles.user > 0 || roles.assistant > 0);
    mark = ok ? "✓" : "!";
    if (!ok) bad++;
    verdict = `${h.selectors}; ${h.messages} messages ` +
      `(${h.canonical} canonical), roles ${roles.user}/${roles.assistant}, ` +
      `composer ${h.composer ? "y" : "n"}, scroller ${h.scroller ? "y" : "n"}, ` +
      `engine ${h.engine ? "on" : "off"}`;
  }
  console.log(`  ${mark} ${r.name.padEnd(11)} ${verdict}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "live-check.json"), JSON.stringify(rows, null, 2));
console.log(`\n  report: ${join(OUT, "live-check.json")}`);
console.log(`  ${bad} broken, ${unchecked} not checked, ${rows.length - bad - unchecked} healthy\n`);

if (showMatrix) {
  const m = await matrixRealProviderSummary();
  console.log("─".repeat(66));
  if (!m) {
    console.log("\n  --matrix: test/matrix-rows.mjs not found or has no generateRows() export.");
  } else if (m.error) {
    console.log(`\n  --matrix: could not read the combinatorial matrix (${m.error})`);
    console.log("  This is informational only — the health check above is unaffected.");
  } else {
    console.log(`\n  Layer-4 combinatorial matrix: ${m.totalRows} real-provider rows across ` +
      `${m.surfaces.length} injected surface(s) (${m.surfaces.join(", ")}) — NOT driven by this run.`);
    console.log("  This attended health check is the only automated signal these rows get;");
    console.log("  the rows themselves (State × Render × A11y × Lifecycle per surface × host)");
    console.log("  are exercised manually or via a follow-up attended pass, never in CI:\n");
    for (const p of wanted) {
      const surfacesForHost = m.surfaces.filter((s) => m.bySurfaceHost.has(`${s}|${p.id}`));
      const rowCount = surfacesForHost.reduce((n, s) => n + m.bySurfaceHost.get(`${s}|${p.id}`), 0);
      const r = rows.find((x) => x.id === p.id);
      const healthy = r && !r.error && !r.signedOut && r.h && typeof r.h.messages === "number" && r.h.messages > 0;
      console.log(`    ${healthy ? "✓" : "·"} ${p.name.padEnd(11)} adapter ${healthy ? "healthy" : "not confirmed this run"} — ${rowCount} matrix row(s) across ${surfacesForHost.length} surface(s) rely on that`);
    }
  }
}

/* Detach, do not close. browser.close() on a connectOverCDP session kills the
   Chrome it attached to, which is the user's cloned browser with their real
   sessions in it — running the check twice in a row would have shut it down
   between runs. */
if (typeof browser.disconnect === "function") await browser.disconnect().catch(() => {});
// Playwright keeps the process alive on a CDP connection; say so explicitly.
process.exit(bad ? 1 : 0);
process.exitCode = bad ? 1 : 0;
