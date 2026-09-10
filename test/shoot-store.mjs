#!/usr/bin/env node
/* Tvara — store screenshot generator.
   Captures evidence-led listing shots (1280×800, captions baked in) from the REAL
   extension running on test/demo.html. It promotes the five approved images
   to store/screenshots after every successful run.                            */
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { mirrorExtension, mintTrialToken } from "./security-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..");
/* Shot from a mirror whose signing key is a test key, because Total Recall is
   gated on a trial the ISSUER signs and the issuer refuses an unknown origin.
   Nothing visible differs: same code, same pixels, only the trust anchor. */
const { EXT, priv: SHOOT_KEY } = mirrorExtension("shoot");
const BRAND_ICON = `data:image/png;base64,${readFileSync(join(EXT, "icons", "icon128.png")).toString("base64")}`;
const WORK = join(ROOT, "test", ".work");
const PROFILE = join(WORK, "shoot-profile");
const OUT = join(WORK, "store");
const STORE = join(ROOT, "store", "screenshots");
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(STORE, { recursive: true });

const server = spawn("python3", ["-m", "http.server", "8918", "--bind", "127.0.0.1"], { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: process.env.PW_CHANNEL || "chromium",
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
  // A manifest `key` pins the id to the key, not the path — check it before
  // falling back to the path derivation, which is wrong whenever `key` is set.
  try {
    const mf = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
    if (mf.key) {
      return [...createHash("sha256").update(Buffer.from(mf.key, "base64")).digest().subarray(0, 16)]
        .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
    }
  } catch { /* no manifest read — fall through */ }
  return [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}
await new Promise((r) => setTimeout(r, 1200));
const ID = extId();

/* The popup page exists from the start because it is the only context with
   chrome.* APIs — the demo page has none. Shortcuts are fired through the same
   storage bus the test suite uses rather than as real keystrokes: a browser
   command binding is not reliably deliverable to a headless window, and a shot
   run that silently fails to open the panel is worse than one that errors. */
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${ID}/popup/popup.html`);
const fireCmd = async (page, name) => {
  await page.bringToFront();
  await pop.evaluate((n) => chrome.storage.local.set({ "lct-cmd": { name: n, at: Date.now() } }), name);
};

/* ---------- caption banner, injected into the live page ---------- */
/* `tag` marks a shot Free or Pro, in the slot the banner already reserved to
   keep the caption centred. Only where the answer is the same on all six
   providers: the minimap, the speed engine and the card are free everywhere,
   Total Recall and Context Bridge both reach the archive through the gated
   `recall-search`, and in-chat search is neither — free on four hosts, Pro on
   Claude and Gemini (FREE_TOOL_PLATFORMS, content/main.js). A badge that is
   right two thirds of the time is the confident wrong answer this project
   spends most of its rules avoiding, so that shot carries none. */
async function caption(page, text, tag = "") {
  await page.evaluate(({ text: t, icon, tag: g }) => {
    document.getElementById("lct-shoot-banner")?.remove();
    document.getElementById("lct-note")?.remove(); // no mid-fade toast in shots
    const b = document.createElement("div");
    b.id = "lct-shoot-banner";
    b.innerHTML = `<span class="lb"><img src="${icon}" alt="">Tvara</span><span class="lc">${t}</span>` +
      `<span class="lr">${g ? `<span class="tg">${g}</span>` : ""}</span>`;
    Object.assign(b.style, {
      position: "fixed", left: 0, right: 0, bottom: 0, height: "76px", zIndex: 2147483647,
      display: "flex", alignItems: "center", padding: "0 28px",
      background: "#060406", borderTop: "2px solid #ff5d8a",
      font: "600 24px/1.2 -apple-system, 'Segoe UI', sans-serif", color: "#fbf6f8"
    });
    const lb = b.querySelector(".lb"), lc = b.querySelector(".lc"), lr = b.querySelector(".lr");
    Object.assign(lb.style, { display: "flex", alignItems: "center", gap: "7px", fontSize: "14px", fontWeight: "700", color: "#ff5d8a", flex: "1 0 0", whiteSpace: "nowrap" });
    Object.assign(lb.querySelector("img").style, { width: "24px", height: "24px", borderRadius: "6px" });
    Object.assign(lc.style, { flex: "0 1 auto", textAlign: "center" });
    Object.assign(lr.style, { flex: "1 0 0", textAlign: "right" });
    const tg = b.querySelector(".tg");
    if (tg) Object.assign(tg.style, {
      fontSize: "13px", fontWeight: "700", letterSpacing: ".09em", textTransform: "uppercase",
      padding: "5px 12px", borderRadius: "999px", whiteSpace: "nowrap",
      color: g === "Pro" ? "#ff5d8a" : "#cbb2ba",
      border: `1px solid ${g === "Pro" ? "rgba(255,93,138,.45)" : "rgba(255,220,230,.20)"}`
    });
    document.body.appendChild(b);
  }, { text, icon: BRAND_ICON, tag });
}
const shoot = (page, name) =>
  page.screenshot({ path: join(OUT, name), scale: "css" }); // css scale → exactly 1280×800

/* ---------- shots 1–5: the demo conversation ---------- */
// The first-run hint is correct behaviour and wrong for a store shot: these
// images show the product in use, not its first four seconds. Marking it seen
// before the page loads is the same thing every real second visit does.
await pop.evaluate(() => chrome.storage.local.set({
  "lct-hint-v1": Date.now(),
  // The onboarding tour is a first-run overlay; its card lands on top of the
  // controls these shots drive. Marked seen, exactly as a second visit does.
  "lct-tour-v1": Date.now()
}));

const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8918/test/demo.html");
await page.waitForSelector("#lct-minimap", { timeout: 10000 });
await page.waitForTimeout(1800); // engine settles, count pill fills

// 1 — hero. The minimap rests as a 13px strip until it is touched, so the
// shot that is supposed to sell the product was a picture of an ordinary chat
// with a faint line down one edge. Hover it: this is the state a user is
// looking at whenever the map matters, and the count pill is only drawn here.
// Two moves, in this order: the strip has to be touched before anything inside
// it becomes visible, and then the pointer has to leave the canvas — otherwise
// the message preview sits across the conversation in the hero image.
await page.locator("#lct-minimap").hover();
await page.waitForSelector("#lct-mm-toggle", { state: "visible" });
await page.locator("#lct-mm-toggle").hover();
await page.waitForFunction(() => {
  const c = document.getElementById("lct-mm-count");
  return c && getComputedStyle(c).visibility === "visible" && /\d/.test(c.textContent);
}, null, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(500);   // the width transition finishes
await caption(page, "Long conversation. Less rendering overhead. Nothing deleted.", "Free");
await shoot(page, "1-hero.png");
await page.mouse.move(640, 400);  // leave the map at rest for the next shots

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
await fireCmd(page, "in-chat-search");
await page.waitForSelector("#lct-search.lct-s-open");
await page.fill("#lct-search input", "recurring");
await page.waitForFunction(() => {
  const c = document.querySelector("#lct-search .lct-s-count");
  return c && /\d+/.test(c.textContent) && !/^0/.test(c.textContent.trim());
});
await caption(page, "Search the conversation you are viewing.");
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
// The minimap rests as a thin strip and only shows its buttons on hover —
// so the shot has to hover it first, exactly as a hand would.
await page.locator("#lct-minimap").hover();
await page.waitForSelector('#lct-export-bar button[data-act="outline"]', { state: "visible" });
await page.click('#lct-export-bar button[data-act="outline"]');
await page.waitForSelector("#lct-outline.lct-o-open");
await page.waitForTimeout(300);
await caption(page, "Auto table of contents — every prompt, every heading.");
await shoot(page, "2-outline.png");
await page.click("#lct-outline .lct-o-close");


/* ---------- shot 7: Total Recall overlay — the golden feature ---------- */
// trial on (Recall is Pro/trial) + a few sample archive records so the shot
// shows what it's FOR: one query, results across platforms.
// Start the trial the way a person does — through the worker. This used to
// write a `trial` key by hand, which stopped meaning anything when the trial
// moved to a worker-owned, sync-backed record, and the shots quietly became
// pictures of a locked panel.
/* A trial grants nothing unless the issuer signed it (bg.js trialState), so
   the token is minted here against the mirror's test key and written into the
   record the worker reads. `dev` must be this install's own device
   fingerprint — trialGrant compares the two and refuses a mismatch. */
const shootDev = await pop.evaluate(() => self.LCTEntitlement.deviceFpFor(""));
const shootTt = mintTrialToken(SHOOT_KEY, { dev: shootDev, startedAt: Date.now() });
await pop.evaluate(async ({ tt }) => {
  const rec = { startedAt: Date.now(), v: 2, checkedAt: Date.now(), tt, verified: true };
  await chrome.storage.sync.set({ "lct-trial-v2": rec });
  await chrome.storage.local.set({ "lct-trial-v2": rec });
}, { tt: shootTt });
await page.waitForFunction(() => !!window.chrome, null).catch(() => {});
await pop.evaluate(() => new Promise((res) => {
  chrome.storage.local.set({ __lct_shot: 1 }, () => {
    // Each sample chat carries its OWN question. Three rows repeating one
    // sentence read as a mock-up; the shot has to look like an archive.
    const mk = (host, path, platform, title, ask, text, n, days) => ({
      id: host + path, host, path, platform, title, n,
      createdAt: Date.now() - days * 864e5, updatedAt: Date.now() - days * 864e5,
      msgs: [
        { r: "user", t: ask, ts: 0 },
        { r: "assistant", t: text, ts: 0 }
      ]
    });
    chrome.runtime.sendMessage({
      type: "recall-import",
      chats: [
        mk("chatgpt.com", "/c/demo-1", "ChatGPT", "Verifying Stripe webhooks",
           "How do I check a webhook signature without a library?",
           "Compute the HMAC over the RAW body — parsing to JSON first is what breaks a webhook signature check — then compare in constant time.", 214, 42),
        mk("claude.ai", "/chat/demo-2", "Claude", "Refactoring the sync service",
           "The webhook signature fails in staging but passes locally. Why?",
           "Your staging proxy re-encodes the body, so the webhook signature is computed over bytes the sender never signed. Verify before any middleware touches it.", 385, 11),
        mk("gemini.google.com", "/app/demo-3", "Gemini", "Notes: HMAC and replay",
           "What stops someone replaying a captured webhook?",
           "A webhook signature proves who sent it, not when — the timestamp in the signed payload is what makes a replay detectable.", 92, 3)
      ]
    }, res);
  });
}));
await page.waitForTimeout(600);

const backup = await ctx.newPage();
await backup.goto(`chrome-extension://${ID}/pages/archive.html`);
await backup.waitForSelector("#backup-panel", { timeout: 8000 });
await backup.locator("#backup-panel").scrollIntoViewIfNeeded();
await backup.fill("#backup-passphrase", "Store-demo-backup-passphrase-2026");
await backup.fill("#backup-passphrase-confirm", "Store-demo-backup-passphrase-2026");
await backup.waitForTimeout(250);
await caption(backup, "Encrypted local backup. Your passphrase stays with you.");
await shoot(backup, "4-backup.png");
await backup.close();

await fireCmd(page, "open-recall");
await page.waitForSelector("#lct-recall.lct-r-open", { timeout: 8000 });
await page.fill("#lct-recall input", "webhook signature");
await page.waitForFunction(() =>
  document.querySelectorAll("#lct-recall .lct-r-item").length >= 3, null, { timeout: 8000 });
// Rows animate in on a per-row delay. Shooting the moment the third one exists
// caught them mid-fade, and the flagship screenshot showed one ghost row under
// a header that said four. Wait for the animation to finish, not for the DOM.
await page.waitForFunction(() => {
  const items = [...document.querySelectorAll("#lct-recall .lct-r-item")];
  return items.length >= 3 && items.every((el) => Number(getComputedStyle(el).opacity) === 1);
}, null, { timeout: 8000 });
await page.waitForTimeout(350);
await caption(page, "Search saved chats on supported AI sites. Stored locally.", "Pro");
await shoot(page, "7-recall.png");
await page.keyboard.press("Escape");

/* ---------- shot 8: Context Bridge — the v0.6 headline ---------- */
await page.waitForTimeout(300);
await fireCmd(page, "open-bridge");
await page.waitForSelector("#lct-bridge.lct-b-open", { timeout: 8000 });
await page.fill("#lct-bridge input", "webhook signature");
await page.waitForFunction(() =>
  document.querySelectorAll("#lct-bridge .lct-b-item").length >= 2, null, { timeout: 8000 });
await page.waitForTimeout(350);   // let the rows finish arriving, as above
// pre-check two passages so the shot shows the pick-then-insert flow
await page.evaluate(() => {
  const boxes = document.querySelectorAll("#lct-bridge .lct-b-item input[type=checkbox]");
  for (let i = 0; i < Math.min(2, boxes.length); i++) {
    boxes[i].checked = true; boxes[i].dispatchEvent(new Event("change", { bubbles: true }));
  }
});
await caption(page, "Context Bridge: pull past answers from any AI into your prompt.", "Pro");
await shoot(page, "8-bridge.png");
await page.keyboard.press("Escape");

/* ---------- shot 9: continue in a new chat ---------- */
await page.locator("#lct-minimap").hover();
await page.waitForSelector('#lct-export-bar button[data-act="carry"]', { state: "visible" });
await page.click('#lct-export-bar button[data-act="carry"]');
await page.waitForSelector("#lct-carry", { timeout: 8000 });
await page.waitForTimeout(400);
await caption(page, "Chat too long? Carry it into a fresh one, in one click.");
await shoot(page, "9-continue.png");
await page.evaluate(() => document.getElementById("lct-carry")?.remove());

/* ---------- shot 6: popup in trial state, composited ---------- */
await pop.evaluate(() => new Promise((res) =>
  chrome.storage.local.set({ trial: { startedAt: Date.now() } }, res)));
await pop.reload();
await pop.waitForFunction(() => document.getElementById("plan-badge")?.textContent === "Trial");
await pop.waitForTimeout(600); // stats rows arrive from storage
const body = pop.locator("body");
const buf = await body.screenshot(); // device pixels: 2× crisp
const b64 = buf.toString("base64");

const comp = await ctx.newPage();
await comp.setContent(`<!DOCTYPE html><html><body style="margin:0;width:1280px;height:800px;
  display:flex;align-items:center;justify-content:center;
  background:radial-gradient(900px 600px at 50% 30%, #2a1a22 0%, #120c0f 70%);
  font-family:-apple-system,'Segoe UI',sans-serif">
  <img src="data:image/png;base64,${b64}"
       style="width:auto;height:640px;border-radius:16px;
              box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06)"/>
  <div style="position:fixed;left:0;right:0;bottom:0;height:76px;display:flex;align-items:center;
              padding:0 28px;background:#060406;border-top:2px solid #ff5d8a;color:#fbf6f8;
              font-weight:600;font-size:24px">
    <span style="display:flex;align-items:center;gap:7px;font-size:14px;font-weight:700;color:#ff5d8a;flex:1 0 0"><img src="${BRAND_ICON}" alt="" style="width:24px;height:24px;border-radius:6px">Tvara</span>
    <span style="flex:0 1 auto;text-align:center">Allowance visibility when reported. Archive stays local.</span>
    <span style="flex:1 0 0"></span>
  </div></body></html>`);
await comp.waitForTimeout(400);
await comp.screenshot({ path: join(OUT, "6-popup-trial.png"), scale: "css" });

await ctx.close();
server.kill();
for (const name of ["1-hero.png", "3-search.png", "6-popup-trial.png", "7-recall.png", "8-bridge.png"]) {
  copyFileSync(join(OUT, name), join(STORE, name));
}
console.log("Store shots written to", STORE);
