#!/usr/bin/env node
/* _senderAllowed (bg.js) accepts http(s)://localhost and 127.0.0.1 as a
   dev/test convenience — the source code branch is real and stays real.
   What actually protects a shipped install is that tools/pack.mjs strips
   every localhost/127.0.0.1 match from the manifest before a zip is built,
   so no content script can ever run there to reach that branch in the first
   place. This test proves the second half against the ACTUAL packed
   artifact — not the source tree, not an assumption about pack.mjs's own
   verify() step, which only checks the manifest JSON, not live behavior. */
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..");
const SCRATCH = join(ROOT, "test", ".work", "sender-allowlist");
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

// Build the real, store-ready zip via the real script — not a reimplementation.
console.log("Packing (node tools/pack.mjs)…");
const packResult = spawnSync("node", ["tools/pack.mjs"], { cwd: ROOT, encoding: "utf8" });
if (packResult.status !== 0) {
  console.error(packResult.stdout, packResult.stderr);
  console.error("FATAL: tools/pack.mjs failed — cannot test a build that doesn't exist");
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")).version;
const zipPath = join(ROOT, "dist", `tvara-v${version}.zip`);
t("pack.mjs produced a zip", existsSync(zipPath), zipPath);

// Unpack it — Chrome's --load-extension needs a directory, not a zip. This
// exercises the exact bytes the store would receive, not a staging dir that
// pack.mjs itself deletes when it's done (dist/staging is cleaned up by pack.mjs).
const PACKED = join(SCRATCH, "packed");
mkdirSync(PACKED, { recursive: true });
const unzip = spawnSync("unzip", ["-q", zipPath, "-d", PACKED], { encoding: "utf8" });
t("packed zip extracts cleanly", unzip.status === 0, unzip.stderr);

const mf = JSON.parse(readFileSync(join(PACKED, "manifest.json"), "utf8"));
const mfText = JSON.stringify(mf);

// ---- 1. Independent re-check of pack.mjs's own verify() ----
t("shipped manifest: no 'localhost' substring anywhere", !mfText.includes("localhost"), mfText.match(/.{0,20}localhost.{0,20}/)?.[0]);
t("shipped manifest: no '127.0.0.1' substring anywhere", !mfText.includes("127.0.0.1"), mfText.match(/.{0,20}127\.0\.0\.1.{0,20}/)?.[0]);
t("shipped manifest: no content_scripts match targets localhost/127.0.0.1",
  (mf.content_scripts || []).every((cs) => (cs.matches || []).every((m) => !/localhost|127\.0\.0\.1/.test(m))));
t("shipped manifest: no host_permissions entry targets localhost/127.0.0.1",
  (mf.host_permissions || []).every((m) => !/localhost|127\.0\.0\.1/.test(m)));

// Positive control: stripping localhost must not have taken the real hosts with it.
const REAL_HOSTS = ["chatgpt.com", "chat.openai.com", "claude.ai", "chat.deepseek.com",
  "grok.com", "perplexity.ai", "gemini.google.com"];
t("shipped manifest: all 6 real provider hosts still present in host_permissions",
  REAL_HOSTS.every((h) => (mf.host_permissions || []).some((m) => m.includes(h))),
  JSON.stringify(mf.host_permissions));

// ---- 2. Live proof: nothing injects on 127.0.0.1 when the packed build loads ----
const PORT = 8918;
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"],
  { cwd: SCRATCH, stdio: "ignore" });
try {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SCRATCH, "index.html"), "<!doctype html><html><body>plain page, no extension markup expected</body></html>");
  await new Promise((r) => setTimeout(r, 300));

  const PROFILE = join(SCRATCH, "chrome-profile");
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${PACKED}`, `--load-extension=${PACKED}`],
  });
  await new Promise((r) => setTimeout(r, 1500)); // let Chrome register the extension

  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForTimeout(2000); // isolated-world scripts run at document_idle; MAIN-world at document_start — give both room

    const injected = await page.evaluate(() => ({
      lctIds: document.querySelectorAll('[id^="lct-"]').length,
      lctClasses: document.querySelectorAll('[class*="lct-"]').length,
      bodyHtml: document.body.innerHTML.length,
    }));
    t("packed build on 127.0.0.1: zero lct-* DOM markers (isolated-world content scripts did not inject)",
      injected.lctIds === 0 && injected.lctClasses === 0, JSON.stringify(injected));

    // MAIN-world injectors (quota-probe.js, fiber-times.js) run in the page's
    // own realm and hook window.fetch/XHR — if either loaded, window.fetch
    // would no longer be the native function.
    const fetchTampered = await page.evaluate(() =>
      !window.fetch.toString().includes("[native code]"));
    t("packed build on 127.0.0.1: window.fetch is still native (MAIN-world quota-probe.js did not inject)",
      !fetchTampered);
  } finally {
    await ctx.close();
  }
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFAILED:"); failed.forEach((l) => console.log("  " + l)); }
process.exitCode = fail ? 1 : 0;
