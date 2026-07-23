#!/usr/bin/env node
/* Long Chat Toolkit — store screenshot generator.
   Captures the 6 listing shots (1280×800, captions baked in) from the REAL
   extension running on test/demo.html. Output: test/.work/store/            */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire("/Users/andhetharuntej/Pixxel/package.json");
const { chromium } = require("playwright");

const EXT = join(homedir(), "long-chat-toolkit");
const WORK = join(EXT, "test", ".work");
const PROFILE = join(WORK, "shoot-profile");
const OUT = join(WORK, "store");
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", "8918", "--bind", "127.0.0.1"], { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2, // popup shot uses device pixels for a crisp composite
  colorScheme: "dark",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

// extension ID: what Chrome registered, else sha256(path) fallback
function extId() {
  for (const f of ["Preferences", "Secure Preferences"]) {
    try {
      const p = JSON.parse(readFileSync(join(PROFILE, "Default", f), "utf8"));
      for (const [id, s] of Object.entries(p.extensions?.settings || {}))
        if (s.path === EXT) return id;
    } catch { /* next */ }
  }
  return [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}
await new Promise((r) => setTimeout(r, 1200));
const ID = extId();

/* ---------- caption banner, injected into the live page ---------- */
async function caption(page, text) {
  await page.evaluate((t) => {
    document.getElementById("lct-shoot-banner")?.remove();
    document.getElementById("lct-note")?.remove(); // no mid-fade toast in shots
    const b = document.createElement("div");
    b.id = "lct-shoot-banner";
    b.innerHTML = `<span class="lb">⚡ Long Chat Toolkit</span><span class="lc">${t}</span><span class="lr"></span>`;
    Object.assign(b.style, {
      position: "fixed", left: 0, right: 0, bottom: 0, height: "76px", zIndex: 2147483647,
      display: "flex", alignItems: "center", padding: "0 28px",
      background: "#0b0c10", borderTop: "2px solid #7aa2ff",
      font: "600 24px/1.2 -apple-system, 'Segoe UI', sans-serif", color: "#fff"
    });
    const lb = b.querySelector(".lb"), lc = b.querySelector(".lc"), lr = b.querySelector(".lr");
    Object.assign(lb.style, { fontSize: "14px", fontWeight: "700", color: "#7aa2ff", flex: "1 0 0", whiteSpace: "nowrap" });
    Object.assign(lc.style, { flex: "0 1 auto", textAlign: "center" });
    Object.assign(lr.style, { flex: "1 0 0" });
    document.body.appendChild(b);
  }, text);
}
const shoot = (page, name) =>
  page.screenshot({ path: join(OUT, name), scale: "css" }); // css scale → exactly 1280×800

/* ---------- shots 1–5: the demo conversation ---------- */
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8918/test/demo.html");
await page.waitForSelector("#lct-minimap", { timeout: 10000 });
await page.waitForTimeout(1800); // engine settles, count pill fills

// 1 — hero
await caption(page, "1,500 messages. Zero lag. Nothing deleted.");
await shoot(page, "1-hero.png");

// 2 — timestamps (hover tag). Messages present at first load are honestly
// "sent before install" — so add a NEW message and let the timeline stamp it
// for real, exactly like a live conversation would.
await page.waitForTimeout(4000); // idle past the timeline's 2.5s baseline settle
await page.evaluate(() => {
  const chat = document.getElementById("chat");
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.setAttribute("data-lct-message", "");
  div.setAttribute("data-lct-role", "assistant");
  div.innerHTML = `<div class="who">Assistant</div><h3>Wrap-up</h3>` +
    `<p>We shipped the schema, fast rollups, the donut chart, recurring rules and a CSV import that survives real bank files. Good session.</p>`;
  chat.appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
});
await page.waitForTimeout(2000); // engine notices, timeline stamps it
const lastAI = page.locator('.msg.assistant[data-lct-message]').last();
await lastAI.dispatchEvent("mouseover");
await page.waitForFunction(() => {
  const t = document.getElementById("lct-time-tag");
  return t && !/unknown/i.test(t.textContent);
}, { timeout: 8000 });
await caption(page, "Finally: WHEN every message was said.");
await shoot(page, "5-timestamps.png");

// 3 — search with hits
await page.keyboard.press("Meta+Shift+KeyF");
await page.waitForSelector("#lct-search.lct-s-open");
await page.fill("#lct-search input", "recurring");
await page.waitForFunction(() => {
  const c = document.querySelector("#lct-search .lct-s-count");
  return c && /\d+/.test(c.textContent) && !/^0/.test(c.textContent.trim());
});
await caption(page, "Search the whole conversation, instantly.");
await shoot(page, "3-search.png");
await page.keyboard.press("Escape");

// 4 — outline panel (star a message first so the Starred tab is meaningful)
// scroll settles first: the star button hides itself on every scroll event
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(900);
for (let i = 0; i < 10; i++) {
  await lastAI.dispatchEvent("mouseover");
  await page.waitForTimeout(300);
  if (await page.locator("#lct-star").isVisible()) break;
}
await page.click("#lct-star");
await page.click('#lct-export-bar button[data-act="outline"]');
await page.waitForSelector("#lct-outline.lct-o-open");
await page.waitForTimeout(300);
await caption(page, "Auto table of contents — every prompt, every heading.");
await shoot(page, "2-outline.png");
await page.click("#lct-outline .lct-o-close");

// 5 — folded code blocks (popup toggle → storage → page reacts live)
await page.evaluate(() => document.getElementById("lct-time-tag")?.remove());
const pop = await ctx.newPage(); // popup page has chrome.* APIs; the demo page does not
await pop.goto(`chrome-extension://${ID}/popup/popup.html`);
await pop.evaluate(() => new Promise((res) => {
  chrome.storage.local.get("settings", ({ settings }) =>
    chrome.storage.local.set({ settings: { ...(settings || {}), fold: true } }, res));
}));
await page.waitForFunction(() => document.documentElement.classList.contains("lct-fold-code"));
await page.waitForTimeout(300);
await caption(page, "Fold every code block to one line — click to expand.");
await shoot(page, "4-fold.png");

/* ---------- shot 6: popup in trial state, composited ---------- */
await pop.evaluate(() => new Promise((res) => {
  // fold back off so the cached toggle state doesn't mislead in the shot
  chrome.storage.local.get("settings", ({ settings }) =>
    chrome.storage.local.set({
      settings: { ...(settings || {}), fold: false },
      trial: { startedAt: Date.now() }
    }, res));
}));
await pop.reload();
await pop.waitForFunction(() => document.getElementById("plan-badge")?.textContent === "Trial");
await pop.waitForTimeout(600); // stats rows arrive from storage
const body = pop.locator("body");
const buf = await body.screenshot(); // device pixels: 2× crisp
const b64 = buf.toString("base64");

const comp = await ctx.newPage();
await comp.setContent(`<!DOCTYPE html><html><body style="margin:0;width:1280px;height:800px;
  display:flex;align-items:center;justify-content:center;
  background:radial-gradient(900px 600px at 50% 30%, #232633 0%, #141519 70%);
  font-family:-apple-system,'Segoe UI',sans-serif">
  <img src="data:image/png;base64,${b64}"
       style="width:auto;height:640px;border-radius:16px;
              box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06)"/>
  <div style="position:fixed;left:0;right:0;bottom:0;height:76px;display:flex;align-items:center;
              padding:0 28px;background:#0b0c10;border-top:2px solid #7aa2ff;color:#fff;
              font-weight:600;font-size:24px">
    <span style="font-size:14px;font-weight:700;color:#7aa2ff;flex:1 0 0">⚡ Long Chat Toolkit</span>
    <span style="flex:0 1 auto;text-align:center">7-day free trial. $9 once. Zero network permissions.</span>
    <span style="flex:1 0 0"></span>
  </div></body></html>`);
await comp.waitForTimeout(400);
await comp.screenshot({ path: join(OUT, "6-popup-trial.png"), scale: "css" });

await ctx.close();
server.kill();
console.log("Store shots written to", OUT);
