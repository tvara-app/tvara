#!/usr/bin/env node
/* Tvara — the store review, rehearsed.
 *
 * What a reviewer does: installs the UPLOADED package into a clean Chrome, reads
 * the description, clicks through it. Two rejections came from exactly that and
 * from nothing the suites had exercised, so this does it the same way:
 *
 *   - the packed zip, not the repo, in a profile created empty for this run;
 *   - real Google Chrome, one instance, spawned without automation flags;
 *   - every stated surface opened by hand, with page and extension errors
 *     collected rather than assumed absent;
 *   - Google sign-in clicked, and where it LANDS read back;
 *   - each supported site visited, to prove the host page is never broken;
 *   - the worker measured idle, because a reviewer notices a fan.
 *
 * One deliberate difference from the upload: the repo's manifest key is put
 * back, so the id is the registered dev id and sign-in can be exercised end to
 * end. The store id's redirect is checked against Google by preflight instead;
 * a local load cannot carry the store's key.
 *
 *   node test/reviewer-run.mjs
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const WORK = join(ROOT, "test", ".work");
const VERSION = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")).version;
const ZIP = join(ROOT, "dist", `tvara-v${VERSION}.zip`);
const EXT = join(WORK, "reviewer-ext");
const PROFILE = join(WORK, "reviewer-profile");

process.env.LCT_CHROME_PROFILE = PROFILE;
process.env.LCT_CDP_PORT = "9333";
const { ensureChrome, shutdown, PORT } = await import("../tools/chrome-real.mjs");

let pass = 0, fail = 0;
const failed = [];
const t = (name, ok, got = "") => {
  ok ? pass++ : (fail++, failed.push(name));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !got ? "" : "  → " + got}`);
};
const step = (s) => console.log(`\n— ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the package ----------
step("the package a reviewer receives");
t(`dist/tvara-v${VERSION}.zip exists`, existsSync(ZIP));
const mfSrc = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
rmSync(EXT, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });
execFileSync("unzip", ["-q", ZIP, "-d", EXT]);
const mf = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
t("packed version matches manifest.json", mf.version === mfSrc.version, `${mf.version} vs ${mfSrc.version}`);
t("packed manifest carries no key", !("key" in mf));
t("packed manifest carries no localhost host", !JSON.stringify(mf).includes("127.0.0.1") && !JSON.stringify(mf).includes("localhost"));
t("Manifest V3", mf.manifest_version === 3);
const missing = [mf.background?.service_worker, mf.action?.default_popup, ...Object.values(mf.icons || {}),
  ...(mf.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])]
  .filter(Boolean).filter((f) => !existsSync(join(EXT, f)));
t("every file the manifest names is in the package", !missing.length, missing.join(", "));
t("no source maps or keys shipped", !execFileSync("unzip", ["-l", ZIP], { encoding: "utf8" }).match(/\.(map|pem|key)\b|tools\/\.keys/));
mf.key = mfSrc.key;
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(mf, null, 2));

// ---------- a clean browser ----------
step("a clean Google Chrome");
await shutdown();   // never delete a profile a running Chrome still owns
rmSync(PROFILE, { recursive: true, force: true });
const t0 = Date.now();
const { ctx, extensionId, build } = await ensureChrome({ extPath: EXT }).catch((e) => {
  console.error("✋ " + e.message); process.exit(2);
});
t("real Google Chrome, not Chromium or Chrome for Testing", /^Chrome\/\d/.test(build), build);
t("the extension installed from the packed build", !!extensionId, extensionId);
const base = `chrome-extension://${extensionId}`;

const errorsOf = (page, bucket) => {
  page.on("pageerror", (e) => bucket.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") bucket.push("console: " + m.text()); });
};

const extInfo = async () => {
  const pg = await ctx.newPage();
  await pg.goto("chrome://extensions");
  const info = await pg.evaluate((id) => new Promise((r) => chrome.developerPrivate.getExtensionsInfo(
    { includeDisabled: true }, (l) => r((l || []).find((e) => e.id === id) || null))), extensionId);
  await pg.close();
  return info;
};

let info = await extInfo();
t("enabled after install", info?.state === "ENABLED", info?.state);
t("no manifest warnings", !(info?.manifestErrors || []).length, JSON.stringify(info?.manifestErrors));
t("install-time runtime errors: none", !(info?.runtimeErrors || []).length,
  (info?.runtimeErrors || []).map((e) => e.message).slice(0, 3).join(" | "));

// ---------- first run ----------
step("first run, the way a new user meets it");
await sleep(2500);
const onboarding = ctx.pages().find((p) => p.url().includes("/pages/onboarding.html"));
t("onboarding opens on install", !!onboarding, ctx.pages().map((p) => p.url()).join(", "));

const health = await (async () => {
  const pg = await ctx.newPage();
  await pg.goto(`${base}/popup/popup.html`);
  const h = await pg.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "worker-health" }, r)))
    .catch((e) => ({ error: String(e) }));
  await pg.close();
  return h;
})();
t("service worker answers worker-health", !!health && !health.error, JSON.stringify(health).slice(0, 200));
t("…with every module loaded", !(health?.failed || health?.missing || []).length, JSON.stringify(health).slice(0, 200));

// ---------- the popup ----------
step("the popup");
const popErr = [];
const pop = await ctx.newPage();
errorsOf(pop, popErr);
const popT = Date.now();
await pop.goto(`${base}/popup/popup.html`);
await pop.waitForSelector("#plan-badge", { timeout: 15000 }).catch(() => {});
await sleep(2500);
const popOpenMs = Date.now() - popT;
const popState = await pop.evaluate(() => ({
  dead: !document.getElementById("worker-dead")?.hidden,
  badge: (document.getElementById("plan-badge")?.textContent || "").trim(),
  google: !document.getElementById("identity-google")?.hidden,
  text: document.body.innerText.length,
}));
t("popup renders", popState.text > 200, `${popState.text} chars`);
t("popup never shows the dead-worker banner", !popState.dead);
t("plan badge states a plan", !!popState.badge, JSON.stringify(popState.badge));
t(`popup settles quickly (${popOpenMs} ms)`, popOpenMs < 6000);

// ---------- Google sign-in ----------
step("Continue with Google — the button the reviewer pressed");
t("Continue with Google is offered", popState.google);
if (popState.google) {
  const before = new Set((await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).map((x) => x.id));
  await pop.click("#identity-google");
  let authUrl = "";
  for (let i = 0; i < 40 && !authUrl; i++) {
    await sleep(250);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const fresh = list.find((x) => !before.has(x.id) && /accounts\.google\.com/.test(x.url));
    if (fresh) authUrl = fresh.url;
  }
  let reason = "";
  const m = authUrl.match(/authError=([^&]+)/);
  if (m) { try { reason = Buffer.from(decodeURIComponent(m[1]), "base64").toString("latin1"); } catch {} }
  t("sign-in opens Google", !!authUrl, "no accounts.google.com window appeared");
  t("Google does not refuse it (no redirect_uri_mismatch)", !!authUrl && !/signin\/oauth\/error/.test(authUrl),
    reason.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 120) || authUrl.slice(0, 120));
  t("it asks which account (no silent sign-in)", /select_account|identifier|accountchooser/i.test(authUrl), authUrl.slice(0, 100));
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  for (const x of list.filter((x) => /accounts\.google\.com/.test(x.url))) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${x.id}`).catch(() => {});
  }
  await sleep(800);
  const afterCancel = await pop.evaluate(() => document.body.innerText.length).catch(() => 0);
  t("closing the Google window leaves the popup usable", afterCancel > 200);
}
t("popup raised no errors", !popErr.length, popErr.slice(0, 3).join(" | "));
await pop.close();

// ---------- every page ----------
step("every page the extension ships");
for (const path of ["pages/onboarding.html", "pages/recall.html", "pages/archive.html", "pages/fetch.html"]) {
  const errs = [];
  const pg = await ctx.newPage();
  errorsOf(pg, errs);
  const s = Date.now();
  await pg.goto(`${base}/${path}`);
  await sleep(2000);
  const len = await pg.evaluate(() => document.body.innerText.length).catch(() => 0);
  t(`${path} renders (${Date.now() - s} ms)`, len > 100, `${len} chars`);
  t(`${path} raised no errors`, !errs.length, errs.slice(0, 2).join(" | "));
  await pg.close();
}

// ---------- the host pages ----------
step("the supported sites, signed out — the host page must never break");
/* A bot wall can leave a page whose main thread never yields, and then
   page.evaluate never returns: the run hung for an hour on chatgpt.com with the
   whole rehearsal behind it. Every site gets a deadline, and missing it is a
   SKIP — a host that will not answer this network proves nothing either way. */
const within = (ms, p, fallback) => Promise.race([
  p, new Promise((res) => setTimeout(() => res(fallback), ms)),
]);
const SITE_MS = 75000;

for (const url of ["https://chatgpt.com/", "https://claude.ai/", "https://gemini.google.com/app",
                   "https://www.perplexity.ai/", "https://chat.deepseek.com/", "https://grok.com/"]) {
  const pg = await ctx.newPage();
  const deadline = Date.now() + SITE_MS;
  const left = () => Math.max(1000, deadline - Date.now());
  const ours = [];
  pg.on("pageerror", (e) => { if (String(e.stack || "").includes(extensionId)) ours.push(e.message); });
  const s = Date.now();
  const res = await within(left(), pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => ({ err: e.message })), { slow: true });
  await sleep(Math.min(5000, left()));
  /* Gemini can render nothing at all for fifteen seconds on a cold, signed-out
     first load — measured WITHOUT the extension installed (0/0/0 characters at
     5/10/15s). A blank page is only Tvara's fault if it is still blank after the
     host has had the time it takes on its own. */
  for (let wait = 0; wait < 4 && Date.now() < deadline; wait++) {
    const chars = await within(left(), pg.evaluate(() => document.body?.innerText.length || 0).catch(() => 0), 0);
    if (chars > 20) break;
    await sleep(Math.min(5000, left()));
  }
  const page = await within(left(), pg.evaluate(() => ({
    title: document.title, text: document.body?.innerText.length || 0,
    challenge: /just a moment|verify you are human|checking your browser/i.test(document.body?.innerText || ""),
  })).catch(() => ({ title: "", text: 0, challenge: false })), { stalled: true });
  const host = new URL(url).host;
  if (res?.slow || page.stalled) console.log(`SKIP  ${host} did not answer within ${SITE_MS / 1000}s on this network — not an extension fault`);
  else if (res?.err) t(`${host} loaded`, false, res.err.slice(0, 80));
  else if (page.challenge) console.log(`SKIP  ${host} served a bot challenge to this network — not an extension fault`);
  else t(`${host} loads and still reads (${Date.now() - s} ms)`, !!page.title && page.text > 20, JSON.stringify(page));
  t(`${host}: no error thrown by Tvara`, !ours.length, ours.slice(0, 2).join(" | "));
  await pg.close().catch(() => {});
}

// ---------- load ----------
step("what it costs while nobody is using it");
const swTarget = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  .find((x) => x.type === "service_worker" && x.url.startsWith(base));
const cdp = (wsUrl) => new Promise((resolve) => {
  const ws = new WebSocket(wsUrl);
  let n = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result || {}); waiting.delete(d.id); }
    else if (d.method) events.push(d.method);
  };
  ws.onopen = () => resolve({
    send: (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); }),
    events, close: () => ws.close(),
  });
  ws.onerror = () => resolve(null);
});

const IDLE_S = 45;
/* Measured, not inferred. Performance.getMetrics answers NOTHING on a service
   worker target, and an empty answer read as zero reported "0.00% CPU, 0.0 MB"
   — a confident number with no measurement behind it. Heap comes from
   Runtime.getHeapUsage, which workers do support; CPU from a sampling profile,
   counting samples that were not idle. If either cannot be read, it says so. */
let sw = await swTarget();
if (!sw) {
  t("service worker is idle and was reclaimed — costs nothing at rest", true);
} else {
  const s = await cdp(sw.webSocketDebuggerUrl);
  if (!s) t("attached to the service worker", false);
  else {
    await s.send("Network.enable");
    await s.send("Profiler.enable");
    await s.send("Profiler.setSamplingInterval", { interval: 1000 });
    await s.send("Profiler.start");
    await sleep(IDLE_S * 1000);
    const { profile } = await s.send("Profiler.stop");
    const heap = await s.send("Runtime.getHeapUsage");
    if (!profile || !profile.samples || !profile.samples.length) {
      console.log("NOTE  CPU not measurable on this worker target — no claim made");
    } else {
      const idleIds = new Set(profile.nodes.filter((n) => /\((idle|program|garbage collector)\)/.test(n.callFrame.functionName)).map((n) => n.id));
      const busy = profile.samples.filter((id) => !idleIds.has(id)).length;
      const pct = (busy / profile.samples.length) * 100;
      t(`idle CPU ${pct.toFixed(2)}% of samples over ${IDLE_S}s (${profile.samples.length} samples)`, pct < 2);
    }
    if (heap && typeof heap.usedSize === "number" && heap.usedSize > 0) {
      const mb = heap.usedSize / 1048576;
      t(`worker heap ${mb.toFixed(1)} MB in use`, mb < 60);
    } else {
      console.log("NOTE  heap not measurable on this worker target — no claim made");
    }
    const requests = s.events.filter((e) => e === "Network.requestWillBeSent").length;
    t(`${requests} network request(s) while idle`, requests <= 12, "background work should be paced, not continuous");
    /* An attached debugger keeps an MV3 worker alive, so "it stayed up for 45s"
       is an artefact of measuring it, not a finding about the extension. */
    console.log("NOTE  a debugger was attached, which holds the worker awake; its lifetime here is not evidence");
    s.close();
  }
}

info = await extInfo();
t("runtime errors after the whole walk: none", !(info?.runtimeErrors || []).length,
  (info?.runtimeErrors || []).map((e) => e.message).slice(0, 3).join(" | "));

console.log(`\n${pass} passed, ${fail} failed · ${Math.round((Date.now() - t0) / 1000)}s`);
if (failed.length) console.log("\nFAILED:\n  " + failed.join("\n  "));

// A throwaway profile: END the process — browser.close() only disconnects.
await shutdown();
process.exit(fail ? 1 : 0);
