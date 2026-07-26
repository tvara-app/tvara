import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const EXT = join(homedir(), "long-chat-toolkit");
const OUT = process.env.OUT;
const PROFILE = join(OUT, "profile");
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = spawn("python3", ["-m", "http.server", "8920", "--bind", "127.0.0.1"], { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 800 }, colorScheme: "dark",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
await new Promise((r) => setTimeout(r, 1500));
const U = "http://127.0.0.1:8920/test/virtual-history.html";

const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text()); });

const t0 = Date.now();
await page.goto(`${U}?index=1&total=1500&page=25`);
await page.waitForSelector("#lct-minimap", { timeout: 20000 });
const mapAt = Date.now();
await page.waitForFunction(() =>
  document.getElementById("lct-mm-canvas")?.getAttribute("aria-valuemax") === "1500",
  null, { timeout: 8000 });
console.log("SEED     complete in", Date.now() - mapAt, "ms after minimap appeared");
await page.evaluate(() => window.__virtualHistory.resetMotion());
await page.waitForTimeout(2500);
console.log("STILL    ", JSON.stringify(await page.evaluate(() => ({
  valuemax: document.getElementById("lct-mm-canvas").getAttribute("aria-valuemax"),
  mounted: document.querySelectorAll("[data-message-id]").length,
  loads: window.__virtualHistory.loads,
  motion: window.__virtualHistory.motion,
  hist: document.documentElement.dataset.lctHistoryState || "(never started)"
}))));

// hover a tick deep in the unmounted region -> provider snippet
await page.hover("#lct-minimap");
await page.waitForTimeout(500);
const box = await page.locator("#lct-mm-canvas").boundingBox();
await page.mouse.move(box.x + 5, box.y + Math.round(box.height * 0.08));
await page.waitForTimeout(300);
console.log("TOOLTIP  ", JSON.stringify(await page.evaluate(() => {
  const t = document.getElementById("lct-mm-tooltip");
  return { shown: t && t.style.display === "block", text: (t?.textContent || "").slice(0, 70) };
})));

// click the very top -> preview instantly, seek behind it, land on virtual-1
await page.mouse.click(box.x + 5, box.y + 1);
await page.waitForTimeout(350);
console.log("PREVIEW  ", JSON.stringify(await page.evaluate(() => ({
  open: !!document.querySelector("#lct-preview.lct-p-open"),
  title: document.querySelector(".lct-p-title")?.textContent,
  body: (document.querySelector(".lct-p-body")?.textContent || "").slice(0, 50),
  seek: document.querySelector("#lct-seek.lct-seek-show") ? document.querySelector(".lct-seek-text").textContent : null,
  state: document.documentElement.dataset.lctSeekState
}))));

await page.waitForFunction(() => document.documentElement.dataset.lctSeekState === "done", null, { timeout: 120000 })
  .catch(() => console.log("SEEK     did not finish:", "state=" + "?"));
console.log("SEEK     finished in", Date.now() - t0, "ms total; ", JSON.stringify(await page.evaluate(() => ({
  state: document.documentElement.dataset.lctSeekState,
  mounted: document.querySelectorAll("[data-message-id]").length,
  loads: window.__virtualHistory.loads
}))));
await page.waitForTimeout(600);
console.log("LANDED   ", JSON.stringify(await page.evaluate(() => {
  const el = document.querySelector('[data-message-id="virtual-1"]');
  const s = document.getElementById("virtual-scroller").getBoundingClientRect();
  const r = el && el.getBoundingClientRect();
  return {
    exists: !!el,
    hit: !!document.querySelector(".lct-hit"),
    hitId: document.querySelector(".lct-hit")?.getAttribute("data-message-id"),
    inView: !!r && r.bottom > s.top && r.top < s.bottom,
    previewClosed: !document.querySelector("#lct-preview.lct-p-open")
  };
})));
await page.screenshot({ path: join(OUT, "landed.png") });
await ctx.close();
server.kill();
