#!/usr/bin/env node
/**
 * Tvara — attach to a Chrome you are already using.
 *
 *   node tools/attach.mjs            # health check across your open chat tabs
 *   node tools/attach.mjs --watch    # …and keep checking every 30s
 *   node tools/attach.mjs --tabs     # just list what it can see
 *
 * The point: no second profile, no signing in again, no extension installed in
 * a browser that is not yours to use. You start Chrome once with a debugging
 * port open, and this reads the extension's own health report out of the tabs
 * you already have — the same report the popup's Health link produces, without
 * you having to click it and paste a screenshot.
 *
 * START CHROME LIKE THIS (quit Chrome first):
 *
 *   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
 *     --remote-debugging-port=9222 \\
 *     --user-data-dir="$HOME/.lct-chrome-test"
 *
 * The --user-data-dir is not optional. Since Chrome 136 the debugging port is
 * refused on the DEFAULT profile directory, deliberately, so that a random page
 * cannot talk to a browser holding your real logins. A dedicated directory is
 * the supported way.
 *
 * Whether that directory is a small blast radius depends on which one you
 * point it at. ~/.lct-chrome-test (what tools/chrome-debug.sh opens) holds only
 * what you sign into there. ~/.lct-chrome is the CLONE made by
 * tools/chrome-clone.sh and carries every live session it copied — attaching to
 * that one puts your real accounts on the port.
 *
 * WHAT THIS CAN DO WHILE IT IS CONNECTED: everything a person at that keyboard
 * could. The port is bound to localhost, nothing outside the machine can reach
 * it, and closing Chrome ends it. Use a test account in that window.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "test", ".work", "live");
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.LCT_CDP_PORT || 9222);
const watch = process.argv.includes("--watch");
const listOnly = process.argv.includes("--tabs");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
if (!browser) {
  console.error(`
✋ Nothing is listening on 127.0.0.1:${PORT}.

Quit Chrome, then start it like this:

  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
    --remote-debugging-port=${PORT} \\
    --user-data-dir="$HOME/.lct-chrome-test"

Load the extension in that window (chrome://extensions → Developer mode →
Load unpacked → ~/tvara), sign in to your test accounts, open a
long chat, and run this again.
`);
  process.exit(1);
}

const ctx = browser.contexts()[0];

/* The extension's own service worker is the shortest path to the content
   scripts: one hop instead of a page that Chrome may refuse to navigate to. */
async function worker() {
  /* BY NAME, not "the first extension worker": a real profile has a dozen
     extensions, and evaluating inside someone else's worker means
     chrome.tabs.sendMessage reaches THEIR content scripts, which answer
     nothing, so every platform reports "no answer".
     But the name probe itself has to be time-boxed and URL-filtered first.
     Asking every extension worker for its manifest hung indefinitely: at least
     one of them never answers an evaluate, and that one blocked the whole run
     before any platform was checked. */
  const named = async (w) => {
    if (!/^chrome-extension:\/\//.test(w.url())) return false;
    const probe = w.evaluate(() => chrome.runtime.getManifest().name).catch(() => null);
    const name = await Promise.race([probe, new Promise((r) => setTimeout(() => r(null), 2500))]);
    return /^Tvara\b/.test(name || "");
  };
  const candidates = ctx.serviceWorkers();
  // Ours is bg.js; try those first so a stranger's worker is never even asked.
  for (const w of candidates.filter((w) => /\/bg\.js(\?|$)/.test(w.url()))) {
    if (await named(w)) return w;
  }
  for (const w of candidates.filter((w) => !/\/bg\.js(\?|$)/.test(w.url()))) {
    if (await named(w)) return w;
  }
  const w = await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null);
  return w && (await named(w)) ? w : null;
}

async function report() {
  const sw = await worker();
  if (!sw) {
    console.error("✋ Connected, but the extension's service worker is not running in this Chrome.");
    console.error("   Load ~/tvara at chrome://extensions, then open a chat tab.");
    return null;
  }

  return sw.evaluate(async () => {
    const cs = chrome.runtime.getManifest().content_scripts || [];
    const matches = [...new Set(cs.flatMap((c) => c.matches || []))];
    const tabs = await chrome.tabs.query({ url: matches });
    const out = [];
    for (const t of tabs) {
      const h = await new Promise((res) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; res(v); } };
        setTimeout(() => finish(null), 4000);
        try {
          chrome.tabs.sendMessage(t.id, { type: "lct-health" }, (r) => {
            void chrome.runtime.lastError; finish(r || null);
          });
        } catch { finish(null); }
      });
      let host = "?";
      try { host = new URL(t.url).hostname; } catch { /* keep */ }
      out.push({ host, title: (t.title || "").slice(0, 60), health: h });
    }
    return out;
  });
}

function render(rows) {
  const mark = { good: "✓", warn: "!", bad: "✗", idle: "·" };
  const lines = [];
  for (const { host, health: h } of rows) {
    if (!h) { lines.push(["bad", host, "no answer — reload that tab"]); continue; }
    if (h.error) { lines.push(["bad", host, "adapter threw: " + h.error]); continue; }
    if (!h.messages) {
      lines.push([h.inConversation === false ? "idle" : "bad", h.platform || host,
        h.inConversation === false ? "no conversation open" : "conversation open, no messages found"]);
      continue;
    }
    const guessed = typeof h.roleRead === "number" && h.roleRead < h.messages;
    const gap = typeof h.providerCount === "number" ? h.messages - h.providerCount : 0;
    const cls = /DEGRADED/.test(h.selectors) ? "bad"
      : (guessed || h.nested || gap > 0 || /mixed/.test(h.selectors)) ? "warn" : "good";
    lines.push([cls, h.platform || host, h.selectors]);
    lines.push([null, "", `messages ${h.messages} (matched ${h.matched}, dropped ${h.dropped})`]);
    if (typeof h.providerCount === "number") {
      lines.push([null, "", `provider says ${h.providerCount}${gap ? ` — we are ${gap > 0 ? "over" : "under"} by ${Math.abs(gap)}` : " — agrees"}`]);
    }
    lines.push([null, "", `roles ${h.roles.user}/${h.roles.assistant}, ${h.substance ? `${h.substance.real} with text / ${h.substance.empty} empty` : "?"}`]);
    lines.push([null, "", `composer ${h.composer ? "y" : "n"}, scroller ${h.scroller ? "y" : "n"}, asleep ${h.sleeping}`]);
    for (const [shape, n] of h.shapes || []) lines.push([null, "", `${n}× ${shape}`]);
  }
  for (const [cls, name, text] of lines) {
    console.log(cls ? `  ${mark[cls]} ${name.padEnd(12)} ${text}` : `        ${text}`);
  }
}

if (listOnly) {
  for (const p of ctx.pages()) console.log("  " + p.url().slice(0, 110));
  await browser.close();
  process.exit(0);
}

const once = async () => {
  const rows = await report();
  if (!rows) return;
  console.log(`\n${new Date().toLocaleTimeString()} — ${rows.length} tab(s)\n`);
  render(rows);
  writeFileSync(join(OUT, "attach-report.json"), JSON.stringify(rows, null, 2));
};

await once();
if (watch) {
  // Deliberately not a tight loop: this is for watching a real browsing session
  // while someone works in it, not for polling.
  setInterval(once, 30000);
} else {
  // connectOverCDP must not close the browser it attached to — that is the
  // user's own window. Detach only.
  await browser.close();
}
