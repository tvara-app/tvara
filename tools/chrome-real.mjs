/**
 * Tvara — the one real Google Chrome these suites run in.
 *
 * Branded Chrome, never Chrome for Testing and never bundled Chromium: those
 * builds answer chrome.runtime differently enough that the popup has opened on
 * an "unsupported build" error, which is a fault in the harness reported as a
 * fault in the product.
 *
 * ONE instance, reused. Chrome refuses a debugging port on the default profile
 * (M136, deliberate — a web page must not reach a browser holding real
 * logins), so the port lives on a dedicated profile that persists between
 * runs. Nothing here ever closes the browser: a suite attaches, asserts and
 * detaches, so the next run pays no start-up at all.
 *
 *   import { ensureChrome, detach } from "../tools/chrome-real.mjs";
 *   const { ctx, extensionId } = await ensureChrome({ extPath });
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

export const PORT = Number(process.env.LCT_CDP_PORT || 9222);
export const PROFILE = process.env.LCT_CHROME_PROFILE || join(homedir(), ".lct-chrome-test");

const BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
];

/* Only switches Chrome does not consider dangerous. Anything on its bad-flags
   list (--no-sandbox, --disable-web-security, --load-extension…) paints a
   yellow "unsupported command-line flag" bar across the window, and so does
   Playwright's own --enable-automation — which is why this spawns the binary
   rather than going through chromium.launch(). */
const FLAGS = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-crash-restore-bubble",
  /* Unlocks CDP Extensions.loadUnpacked. Chrome 137 removed --load-extension,
     and the only other route is the native folder dialog, which has to be
     driven with keystrokes — on a machine somebody is using, those land in
     whatever they have focused. This installs with no window at all. Measured
     on 153: it paints no infobar (87px of chrome on the startup tab and a fresh
     one alike). */
  "--enable-unsafe-extension-debugging"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init, signal: AbortSignal.timeout(3000)
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json().catch(() => ({}));
};

/** The browser on the port, or null. Reports the BUILD so a Chromium that
    wandered onto this port is refused rather than silently tested. */
export async function probe() {
  const v = await cdp("/json/version");
  if (!v) return null;
  const build = String(v.Browser || "");
  return { build, branded: /^Chrome\/\d/.test(build) };
}

function binary() {
  const found = BINARIES.find((p) => existsSync(p));
  if (!found) {
    throw new Error("Google Chrome is not installed in /Applications. These suites " +
      "deliberately do not fall back to Chromium — see the header of this file.");
  }
  return found;
}

/** Idempotent: starts Chrome only when the port is dead, so repeated runs and
    two suites in one session share one window rather than stacking browsers. */
export async function launch({ quiet = false } = {}) {
  const up = await probe();
  if (up) {
    if (!up.branded) {
      throw new Error(`127.0.0.1:${PORT} is ${up.build}, not Google Chrome. Close it, or ` +
        `point LCT_CDP_PORT somewhere else.`);
    }
    return { started: false, build: up.build };
  }
  const bin = binary();
  if (!quiet) console.log(`→ starting Google Chrome  (profile ${PROFILE}, port ${PORT})`);
  spawn(bin, FLAGS, { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const now = await probe();
    if (now) {
      if (!now.branded) throw new Error(`Started ${now.build}, expected Google Chrome.`);
      return { started: true, build: now.build };
    }
  }
  throw new Error(`Chrome started but never opened ${PORT}. Another Chrome may already own ` +
    `${PROFILE}; quit it and run again.`);
}

/** A browser whose last page was closed keeps running with no targets at all,
    and Playwright cannot attach to that. One page is enough to revive it. */
async function ensurePage() {
  const list = await cdp("/json/list");
  if (Array.isArray(list) && list.some((t) => t.type === "page")) return;
  await cdp("/json/new?about:blank", { method: "PUT" });
  await sleep(400);
}

/** One call on the browser-level CDP target. */
async function browserCall(method, params = {}) {
  const v = await cdp("/json/version");
  if (!v || !v.webSocketDebuggerUrl) throw new Error(`nothing is listening on ${PORT}`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("CDP socket refused")); });
  try {
    return await new Promise((ok) => {
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) ok(d); };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { ws.close(); }
}

const infoOf = (pg) => pg.evaluate(() => new Promise((r) =>
  chrome.developerPrivate.getExtensionsInfo({}, (l) => r((l || []).map((e) => ({
    id: e.id, name: e.name, path: e.path || "", location: e.location, state: e.state
  }))))));

const same = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/**
 * Leaves exactly one enabled unpacked Tvara in the profile, loaded from
 * `extPath`, with its code re-read from disk.
 *
 * The reload is the point: this profile remembers an unpacked extension across
 * restarts, so without it a green run proves yesterday's bytes work. A second
 * copy (the repo alongside the test mirror) is disabled rather than removed —
 * two enabled copies both claim the provider hosts, and whichever answers
 * first decides the result.
 */
async function ensureExtension(ctx, extPath) {
  const pg = await ctx.newPage();
  await pg.goto("chrome://extensions");
  let list = await infoOf(pg).catch(() => []);
  let mine = list.find((e) => e.location === "UNPACKED" && same(e.path, extPath));

  if (!mine) {
    const res = await browserCall("Extensions.loadUnpacked", { path: extPath });
    if (res.error) {
      await pg.close();
      /* A browser reused from before this flag existed cannot load an
         extension this way, and restarting somebody's session silently is not
         this module's call to make. */
      throw new Error(`Chrome refused to load ${extPath}: ${res.error.message}. ` +
        `If this Chrome was started without --enable-unsafe-extension-debugging, quit it ` +
        `(it is the one on port ${PORT}) and run again — it will be restarted with the flag.`);
    }
    for (let i = 0; i < 20 && !mine; i++) {
      await pg.waitForTimeout(300);
      list = await infoOf(pg).catch(() => []);
      mine = list.find((e) => e.location === "UNPACKED" && same(e.path, extPath));
    }
    if (!mine) {
      await pg.close();
      throw new Error(`Chrome accepted ${extPath} but never listed it as installed.`);
    }
  }

  for (const other of list) {
    if (other.id === mine.id || other.name !== mine.name) continue;
    await pg.evaluate((id) => new Promise((r) =>
      chrome.developerPrivate.updateExtensionConfiguration(
        { extensionId: id, enabled: false }, () => r())), other.id).catch(() => {});
  }
  await pg.evaluate((id) => new Promise((r) => {
    chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, enabled: true }, () => {
      chrome.developerPrivate.reload(id, { failQuietly: true }, () => r());
    });
  }), mine.id).catch(() => {});
  await pg.waitForTimeout(1200);
  await pg.close();
  return mine.id;
}

/**
 * The whole entry point: one branded Chrome, running, with `extPath` installed
 * and freshly reloaded. Never launches a second browser, never closes this one.
 */
export async function ensureChrome({ extPath, quiet = false } = {}) {
  const { started, build } = await launch({ quiet });
  await ensurePage();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const extensionId = extPath ? await ensureExtension(ctx, extPath) : "";
  if (!quiet) {
    console.log(`✓ ${build} ${started ? "started" : "reused"}` +
      (extensionId ? `  ·  extension ${extensionId}` : ""));
  }
  return { browser, ctx, extensionId, started, build };
}

/**
 * Ends the Chrome on PORT and waits until the port is gone.
 *
 * browser.close() is not this. On a browser that was ATTACHED to rather than
 * launched, it only disconnects: the process stays up with no windows. A suite
 * that then deleted the profile and started again reused that browser — with its
 * profile gone underneath it — and failed on the first test. Browser.close is
 * sent without waiting for a reply, because the socket dies with the process.
 */
export async function shutdown() {
  const v = await cdp("/json/version");
  if (!v || !v.webSocketDebuggerUrl) return true;
  await new Promise((done) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); setTimeout(done, 300); };
    ws.onerror = () => done();
  });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!(await probe())) return true;
  }
  return false;
}

/** Detach without closing: browser.close() would take every window with it and
    the next run would pay a cold start. Exiting the process is the detach. */
export function detach(code = 0) {
  process.exit(code);
}
