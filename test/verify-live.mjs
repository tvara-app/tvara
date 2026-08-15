#!/usr/bin/env node
/**
 * Long Chat Toolkit — live-site verification.
 *
 *   node test/verify-live.mjs login          # once: sign in to your test accounts
 *   node test/verify-live.mjs                # every time after: check the real sites
 *   node test/verify-live.mjs --only chatgpt,claude
 *   node test/verify-live.mjs --shots        # also save screenshots (your chats — off by default)
 *   node test/verify-live.mjs --self-test    # prove the harness works, against the local page
 *
 * The whole suite otherwise runs against mock providers and a synthetic page:
 * it can prove the logic and never the selectors, and selectors are the thing
 * these sites change without telling anyone. This is the gap-closer.
 *
 * It runs the REAL extension in its OWN Chrome profile at ~/.lct-verify — not
 * your everyday browser, and nothing to do with any other account. The profile
 * persists, so signing in is a one-time cost. Delete it any time:
 *
 *   rm -rf ~/.lct-verify
 *
 * What it reads: the extension's own health report — adapter, message count,
 * whether those messages still match the platform's own attributes, composer,
 * scroller, role split. No message text; the conversation id is stripped.
 * With the archive on, a run also syncs your history into THIS profile's local
 * storage, which is what proves the provider APIs still answer — it stays on
 * this machine, and the line above deletes it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const EXT = join(homedir(), "long-chat-toolkit");
const HOME = join(homedir(), ".lct-verify");
const PROFILE = join(HOME, "profile");
const OUT = join(EXT, "test", ".work", "live");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + 1]; };
const LOGIN = argv[0] === "login";
const SELF_TEST = has("--self-test");
const SHOTS = has("--shots");

const PLATFORMS = [
  { id: "chatgpt",    name: "ChatGPT",    url: "https://chatgpt.com/",          conv: 'a[href^="/c/"]' },
  { id: "claude",     name: "Claude",     url: "https://claude.ai/recents",     conv: 'a[href^="/chat/"]' },
  { id: "gemini",     name: "Gemini",     url: "https://gemini.google.com/app", conv: 'a[href^="/app/"], [data-test-id="conversation"]' },
  { id: "deepseek",   name: "DeepSeek",   url: "https://chat.deepseek.com/",    conv: 'a[href*="/chat/s/"]' },
  { id: "grok",       name: "Grok",       url: "https://grok.com/",             conv: 'a[href^="/c/"], a[href^="/chat/"]' },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/",    conv: 'a[href^="/search/"]' }
];

const only = valueOf("--only");
const wanted = SELF_TEST
  ? [{ id: "synthetic", name: "Test page", url: "http://127.0.0.1:8921/test/synthetic.html", conv: null }]
  : PLATFORMS.filter((p) => !only || only.split(",").map((s) => s.trim()).includes(p.id));

mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

const ask = async (q) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a;
};

let server = null;
if (SELF_TEST) {
  server = spawn("python3", ["-m", "http.server", "8921", "--bind", "127.0.0.1"],
    { cwd: EXT, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
}

console.log(`\nLong Chat Toolkit — live check`);
console.log(`profile: ${PROFILE}${existsSync(join(PROFILE, "Default")) ? "" : "  (new)"}\n`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  // Chromium, not Chrome: Playwright only exposes an extension's service
  // worker under the channel it bundles, and that worker is how we ask the
  // content scripts anything. Headed either way — sign-in and bot checks both
  // want a real window.
  channel: "chromium",
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
await new Promise((r) => setTimeout(r, 1500));

try {
  /* ---------- login mode ---------- */
  if (LOGIN) {
    console.log("Signing in — a window is open. Do this in it:\n");
    for (const p of wanted) console.log(`  • ${p.name}  ${p.url}`);
    console.log(`
Sign in to whichever ones you actually use. Use your TEST accounts.
The session is stored in this profile only, and never leaves this machine.

One known wall: Google refuses to sign in inside an automated browser, so
Gemini usually cannot be done this way. Check that one by hand instead —
extension popup → Health → Copy report — which needs no script at all.
`);
    for (const p of wanted) {
      const page = await ctx.newPage();
      await page.goto(p.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await ask("Press Enter when you are signed in everywhere you want to check… ");
    console.log("\nSaved. From now on: node test/verify-live.mjs\n");
    await ctx.close();
    if (server) server.kill();
    process.exit(0);
  }

  /* ---------- verification run ---------- */
  const pages = [];
  for (const p of wanted) {
    const page = await ctx.newPage();
    pages.push({ p, page });
    try {
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch {
      console.log(`  ! ${p.name}: page did not load`);
      continue;
    }
    await page.waitForTimeout(3500);
    // Open a conversation if one is listed. Best-effort by design: when a
    // sidebar is rebuilt, this is the first thing to break, and the fallback
    // is a human clicking — which is why the prompt below exists either way.
    if (p.conv) {
      try {
        const link = page.locator(p.conv).first();
        if (await link.count() && await link.isVisible()) {
          await link.click({ timeout: 5000 });
          await page.waitForTimeout(4000);
        }
      } catch { /* the prompt covers it */ }
    }
  }

  console.log(`
${wanted.length} tab${wanted.length === 1 ? "" : "s"} open. Before pressing Enter:

  • make sure each tab has a real CONVERSATION open (not the new-chat screen)
  • the longer the chat, the more this tells us
  • if a tab is a login screen, sign in now — it is remembered next time
`);
  if (!SELF_TEST) await ask("Press Enter when the tabs are ready… ");

  // Ask the extension's own service worker, not a page. Real Chrome under
  // automation refuses to navigate to a chrome-extension:// URL, and the worker
  // is the more honest place to ask anyway: it is the same channel the health
  // page uses, one hop shorter.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  if (!sw) throw new Error("the extension's service worker never started — is the unpacked build loaded?");

  const answers = await sw.evaluate(async () => {
    const cs = chrome.runtime.getManifest().content_scripts || [];
    const matches = [...new Set(cs.flatMap((c) => c.matches || []))];
    const tabs = await chrome.tabs.query({ url: matches });
    const out = [];
    for (const t of tabs) {
      const report = await new Promise((res) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; res(v); } };
        setTimeout(() => finish(null), 4000);
        try {
          chrome.tabs.sendMessage(t.id, { type: "lct-health" }, (r) => {
            void chrome.runtime.lastError;
            finish(r || null);
          });
        } catch { finish(null); }
      });
      out.push({ host: (() => { try { return new URL(t.url).hostname; } catch { return "?"; } })(), report });
    }
    return out;
  });

  // Same verdict language as the health page, so a report pasted from either
  // reads identically.
  const cards = answers.map(({ host, report: h }) => {
    const base = { title: h?.platform || h?.adapter || host, rows: [] };
    if (!h) return { ...base, cls: "bad", verdict: "no answer — reload that tab and re-run" };
    if (h.error) return { ...base, cls: "bad", verdict: "the adapter threw: " + h.error };
    if (!h.messages) {
      return { ...base, cls: h.inConversation === false ? "idle" : "bad",
        verdict: h.inConversation === false
          ? "no conversation open in this tab"
          : "a conversation is open but NO messages were found" };
    }
    // A platform whose messages match but whose ROLES are guessed is not
    // healthy, however green the headline looks.
    const rolesGuessed = typeof h.roleRead === "number" && h.roleRead < h.messages;
    const cls = /DEGRADED/.test(h.selectors) ? "bad"
      : (/mixed/.test(h.selectors) || rolesGuessed || h.nested) ? "warn" : "good";
    const yn = (x) => x === null ? "n/a" : x === "threw" ? "the lookup failed" : x ? "yes" : "no";
    return {
      cls, title: h.platform || h.adapter,
      verdict: cls === "good" ? "matching this platform's own markup"
        : cls === "bad" ? "running on a fallback layer — this platform has changed"
        : rolesGuessed ? `roles guessed for ${h.messages - h.roleRead} of ${h.messages} messages`
        : h.nested ? `${h.nested} turns counted twice`
        : `partly matching — ${h.selectors}`,
      rows: [
        ["messages seen", String(h.messages)],
        ["elements matched before empty turns were dropped",
          h.matched === undefined ? "n/a" : `${h.matched}${h.dropped ? ` (${h.dropped} dropped)` : ""}`],
        ["matching the platform's own attributes", `${h.canonical} of ${h.messages}`],
        ["roles read", `${h.roles.user} yours · ${h.roles.assistant} the model's`],
        ["roles taken from the page itself",
          typeof h.roleRead === "number" ? `${h.roleRead} of ${h.messages}` : "inferred on this platform"],
        ["where that role was found", h.roleFrom
          ? `${h.roleFrom.self} on the message · ${h.roleFrom.ancestor} on a wrapper · ${h.roleFrom.descendant} inside it · ${h.roleFrom.none} nowhere`
          : "n/a"],
        ["distinct messages behind those elements", h.distinctIds
          ? `${h.distinctIds.distinct} ids for ${h.distinctIds.of} elements` : "no ids on this platform"],
        ["counted twice", String(h.nested ?? 0)],
        ["elements with actual text", h.substance
          ? `${h.substance.real} real · ${h.substance.tiny} near-empty · ${h.substance.empty} empty` +
            (h.substance.sampled < h.messages ? ` (of the first ${h.substance.sampled})` : "")
          : "n/a"],
        ["not rendered at all", h.substance ? String(h.substance.unrendered) : "n/a"],
        ["what was matched", (h.shapes || []).map(([sh, n]) => `${n}× ${sh}`).join("  |  ") || "n/a"],
        ["asleep right now", String(h.sleeping)],
        ["prompt box found", yn(h.composer)],
        ["scroll container found", yn(h.scroller)],
        ["speed engine", h.engine ? "running" : "off"],
        ["minimap", h.minimap ? "on screen" : "not drawn"],
        ["plan", h.plan]
      ]
    };
  });

  if (SHOTS) {
    for (const { p, page } of pages) {
      await page.screenshot({ path: join(OUT, `${p.id}.png`) }).catch(() => {});
    }
  }

  /* ---------- verdict ---------- */
  const mark = { good: "✓", warn: "!", bad: "✗", idle: "·" };
  console.log("\n─────────────────────────────────────────────────────────────\n");
  if (!cards.length) console.log("  No chat tabs were seen. Were they open in THIS window?");
  for (const c of cards) {
    console.log(`  ${mark[c.cls] || "?"} ${c.title.padEnd(12)} ${c.verdict}`);
    for (const [k, v] of c.rows) console.log(`      ${k}: ${v}`);
    console.log("");
  }

  const broken = cards.filter((c) => c.cls === "bad");
  const shaky = cards.filter((c) => c.cls === "warn");
  console.log(broken.length
    ? `  ✗ ${broken.length} platform(s) have drifted — ${broken.map((c) => c.title).join(", ")}`
    : shaky.length
      ? `  ! ${shaky.length} platform(s) partly matching — worth a look`
      : `  ✓ every platform checked still matches its own markup`);

  const md = `# Live check — ${new Date().toISOString()}\n\n` +
    cards.map((c) => `## ${c.title} — ${c.verdict}\n\n` +
      c.rows.map(([k, v]) => `- ${k}: ${v}`).join("\n")).join("\n\n") +
    "\n";
  writeFileSync(join(OUT, "report.md"), md);
  console.log(`\n  report: ${join(OUT, "report.md")}`);
  console.log(`  paste that file into the chat — it holds no message text.\n`);

  process.exitCode = broken.length ? 1 : 0;
} finally {
  await ctx.close().catch(() => {});
  if (server) server.kill();
}
