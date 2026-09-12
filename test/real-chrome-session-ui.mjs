#!/usr/bin/env node
/* Tvara — the trial card's Buy and the account device screen, driven the way a
 * person drives them, in real Google Chrome (channel "chrome", never bundled
 * Chromium).
 *
 * The upsell card is hidden for the whole week a trial runs, and it used to be
 * the only place holding Buy, sign-in and the device screen. This walks the
 * journeys that produced that gap: sign in, start a trial, look at your
 * devices, sign one out, come back, then buy.
 *
 * The popup is served over http with `chrome` and `fetch` stubbed before any
 * script runs, so the real popup.js and lib/entitlement.js execute unmodified.
 * The stub world is mutable, so a scenario can change what the issuer says
 * between clicks — which is what actually happens to somebody sitting there.
 * It ATTACHES to the one Chrome tools/chrome-real.mjs owns and never closes
 * it: two real-Chrome suites in a session share one window.
 *
 *   node test/real-chrome-session-ui.mjs [--shots <dir>]
 */
import { join } from "node:path";
import { serve } from "../tools/serve.mjs";
import { ensureChrome, detach } from "../tools/chrome-real.mjs";

const ROOT = join(import.meta.dirname, "..");
const PORT = 8931;
/** `--shots <dir>` writes what a person would be looking at. */
const SHOTS = process.argv.includes("--shots")
  ? process.argv[process.argv.indexOf("--shots") + 1] : "";

let pass = 0, fail = 0;
const t = (name, ok, got = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !got ? "" : "  → " + got}`);
};
const step = (name) => console.log(`\n— ${name}`);

const srv = await serve(ROOT, PORT);

/* No profile wipe. It was here because python3 -m http.server sends no
   Cache-Control and Chrome would serve a popup.js from the previous run, so the
   suite tested the edit before last; tools/serve.mjs sends no-store, which
   fixes that without throwing away the browser between runs. */
const { ctx } = await ensureChrome({ quiet: true }).catch((err) => {
  console.error("✋ " + err.message);
  process.exit(2);
});

const shut = async (code) => {
  srv.close();
  detach(code);
};

/**
 * Everything the popup asks the service worker and the issuer, answered from
 * one mutable object. `__reply` and `__issuer` let a scenario move the world
 * between clicks; `__sent` records the traffic, so a refused purchase can be
 * told apart from one that quietly went through.
 */
function stubs(state) {
  return `(() => {
    const S = ${JSON.stringify(state)};
    // Every scenario is a fresh install; the popup's paint cache is per-origin
    // and would otherwise carry the previous one's plan into this one.
    try { localStorage.clear(); } catch {}
    self.__sent = [];
    self.__reply = (type, value) => { S.replies[type] = value; };
    self.__issuer = (path, value) => { S.issuer[path] = value; };
    const store = { local: { ...S.local }, sync: {}, session: {} };
    const area = (name) => ({
      get: async (keys) => {
        const bag = store[name];
        if (keys === null || keys === undefined) return { ...bag };
        const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        const out = {};
        for (const k of list) if (k in bag) out[k] = bag[k];
        return out;
      },
      set: async (obj) => { Object.assign(store[name], obj); },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[name][k];
      }
    });
    self.chrome = {
      runtime: {
        id: "tvara-test",
        lastError: null,
        getManifest: () => ({ version: "1.0.0", content_scripts: [] }),
        getURL: (p) => "/" + String(p).replace(/^\\/+/, ""),
        sendMessage: (msg, cb) => {
          self.__sent.push(msg && msg.type);
          const reply = S.replies[(msg && msg.type) || ""] ?? null;
          setTimeout(() => cb && cb(reply), 0);
        }
      },
      storage: {
        local: area("local"), sync: area("sync"), session: area("session"),
        onChanged: { addListener() {} }
      },
      tabs: { create() {}, query: async () => [], sendMessage() {} }
    };
    // Pinned by lib/entitlement.js at load, so replacing it here is the only
    // seam the issuer calls have. \`__status\` rides on the body so a scenario
    // can serve a 412 or a 503 without a second field to thread through.
    self.fetch = async (url) => {
      const path = String(url).replace(/^https?:\\/\\/[^/]+/, "");
      const body = S.issuer[path];
      self.__sent.push("fetch:" + path);
      const status = (body && body.__status) || (body ? 200 : 503);
      return new Response(JSON.stringify(body ?? { error: "unavailable" }),
        { status, headers: { "Content-Type": "application/json" } });
    };
    // window.close() is a no-op on a page the script did not open, and the
    // purchase path calls it on success — record it instead.
    self.close = () => { self.__sent.push("closed"); };
  })();`;
}

const SELF_FP = "a".repeat(32), WORK_FP = "b".repeat(32), PHONE_FP = "c".repeat(32);
const DEVICES = [
  { device: SELF_FP, label: "", plat: "macOS · Chrome", geo: "IN", lastSeen: Date.now(), self: true },
  { device: WORK_FP, label: "Work laptop", plat: "Windows · Edge", geo: "DE", lastSeen: Date.now() - 36e5, self: false },
  { device: PHONE_FP, label: "", plat: "Android · Chrome", geo: "IN", lastSeen: Date.now() - 3 * 864e5, self: false }
];
const TRIAL = { grants: true, until: Date.now() + 6 * 864e5 };

const world = (over = {}) => ({
  local: {}, issuer: {},
  // `over` first: `replies` below is a MERGE, and spreading over afterwards
  // would put the partial back and drop every default.
  ...over,
  replies: {
    "entitlement-state": { entitled: false, via: "trial", trial: TRIAL },
    "identity-state": { verified: true, google: true },
    "checkout-state": { pending: false },
    "quota-state": null, "archive-state": null, "sync-summary": null,
    ...(over.replies || {})
  }
});

/** One popup, freshly opened against the given world — a person clicking the
 *  toolbar icon. */
async function popup(state, extraInit) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { pageErrors.push(String(e.message)); console.log("  page error: " + e.message); });
  await page.addInitScript(stubs(state));
  // After the stubs, before any page script: this is where a scenario decides
  // what navigator says the machine is.
  if (extraInit) await page.addInitScript(extraInit);
  await page.goto(`http://127.0.0.1:${PORT}/popup/popup.html`, { waitUntil: "load" });
  // Wait for the card a person would be looking at, not a fixed sleep: the
  // plan is painted from the cache first and settled a round trip later.
  await page.waitForSelector(
    "#trial-active:not([hidden]), #pro-upsell:not([hidden]), #pro-active:not([hidden])",
    { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(350);
  return page;
}

/* A popup that threw on load fails every later assertion for a reason none of
   them state. Surfaced here so the first failure names the actual error. */
const pageErrors = [];

const sent = (page) => page.evaluate(() => self.__sent);
const text = async (page, sel) => ((await page.textContent(sel)) || "").replace(/\s+/g, " ").trim();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + ".png") }); };

try {
  /* ── 1. Free, never signed in. The upsell is what they see, and the account
        block is where the device screen has to live for them. ─────────────── */
  step("free, signed out — the first open");
  {
    const page = await popup(world({
      replies: {
        "entitlement-state": { entitled: false, reason: "none" },
        "identity-state": { verified: false, google: true }
      }
    }));
    t("upsell is the card on screen", await page.isVisible("#pro-upsell"));
    t("sign-in is offered", await page.isVisible("#identity-google"));
    t("no device screen before signing in", !(await page.isVisible("#identity-devices")));
    await shot(page, "1-free-signed-out");
    await page.close();
  }

  /* ── 2. They sign in. Everything the account unlocks has to appear without a
        reopen, because nothing tells them to reopen. ──────────────────────── */
  step("signing in from the upsell");
  {
    const page = await popup(world({
      replies: {
        "entitlement-state": { entitled: false, reason: "none" },
        "identity-state": { verified: false, google: true },
        "identity-google": { branch: "ok", settled: {} }
      }
    }));
    await page.evaluate(() => self.__reply("identity-state", { verified: true, google: true }));
    await page.click("#identity-google");
    await page.waitForTimeout(500);
    t("signing in confirms itself", /verified/i.test(await text(page, "#identity-status")),
      await text(page, "#identity-status"));
    t("…and the device screen appears without a reopen", await page.isVisible("#identity-devices"));
    await shot(page, "2-signed-in");
    await page.close();
  }

  /* ── 3. The trial card. Both buttons a person needs during that week. ───── */
  step("a trial is running");
  {
    const page = await popup(world());
    t("trial card is the card on screen", await page.isVisible("#trial-active"));
    t("…and it says how long is left", /days? left/i.test(await text(page, "#trial-status")),
      await text(page, "#trial-status"));
    t("Buy is on the trial card", await page.isVisible("#trial-buy"));
    t("Devices is on the trial card", await page.isVisible("#trial-devices"));
    t("Buy names the price", /\$1/.test(await text(page, "#trial-buy")), await text(page, "#trial-buy"));
    await shot(page, "3-trial");
    await page.close();
  }

  /* ── 4. The device screen, opened from the trial. This is the journey that
        was impossible before: no licence, no seat, a real device list. ────── */
  step("opening the device screen during a trial");
  {
    const page = await popup(world({
      local: { "lct-identity-v1": { idt: "test-identity-token" } },
      issuer: { "/sessions": { version: 3, limit: 5, devices: DEVICES } }
    }));
    await page.click("#trial-devices");
    await page.waitForSelector("#device-manager:not([hidden])", { timeout: 8000 });
    await page.waitForTimeout(400);
    t("the device screen opens", await page.isVisible("#device-manager"));
    const rows = await page.locator("#device-list .device-row").count();
    t("every device on the account is listed", rows === 3, "rows=" + rows);
    t("this device is named as this one", /this device/i.test(await text(page, "#device-list")));
    t("each row says where and when",
      /IN · active now/i.test(await text(page, "#device-list")), await text(page, "#device-list"));
    t("a trial count is not framed as seats", !/of 5/.test(await text(page, "#device-count")),
      await text(page, "#device-count"));
    t("the help link asks a question a trial can answer",
      !/slots/i.test(await text(page, "#device-help-link")), await text(page, "#device-help-link"));

    /* Nothing picked yet, so the button that signs devices out must not be
       pressable — a person tabbing through would otherwise land on a live
       destructive control that acts on nothing. */
    t("Sign out is dead until something is picked", await page.isDisabled("#device-signout"));

    /* A row's own Sign out acts on THAT device. It must not sweep in whatever
       is ticked, and it must leave those ticks alone. */
    await page.locator("#device-list .device-row").nth(2).locator(".device-pick").check();
    await page.locator("#device-list .device-row").nth(1).locator(".device-signout-one").click();
    await page.waitForTimeout(200);
    t("a row's Sign out arms the same confirmation", await page.isVisible("#device-confirm"));
    t("…for that one device, not it plus what was ticked",
      /out 1 device\?/i.test(await text(page, "#device-confirm-text")),
      await text(page, "#device-confirm-text"));
    await page.click("#device-confirm-no");
    await page.waitForTimeout(200);
    t("…and a tick it never touched survives",
      await page.locator("#device-list .device-row").nth(2).locator(".device-pick").isChecked());
    await page.locator("#device-list .device-row").nth(2).locator(".device-pick").uncheck();
    await page.waitForTimeout(150);

    // Tick the work laptop, the way a person picks the machine they lost.
    await page.locator("#device-list .device-row").nth(1).locator(".device-pick").check();
    await page.waitForTimeout(150);
    t("picking one arms the button", !(await page.isDisabled("#device-signout")));
    t("…and the button counts what is picked", /\(1\)/.test(await text(page, "#device-signout")),
      await text(page, "#device-signout"));
    await shot(page, "4-devices-picked");

    /* Signing a machine out is not undoable from here, so it is two clicks. */
    await page.click("#device-signout");
    await page.waitForTimeout(200);
    t("a confirmation stands between them and the sign-out",
      await page.isVisible("#device-confirm"));
    t("…and it says what happens", /lose Pro/i.test(await text(page, "#device-confirm-text")),
      await text(page, "#device-confirm-text"));
    t("the list's own buttons stand down while confirming",
      !(await page.isVisible("#device-actions")));

    // Change of mind. A cancel must leave the list exactly as it was.
    await page.click("#device-confirm-no");
    await page.waitForTimeout(200);
    t("cancel returns the list untouched",
      (await page.isVisible("#device-actions")) && !(await page.isVisible("#device-confirm")));
    t("…with the pick still made", !(await page.isDisabled("#device-signout")));

    // Go through with it this time.
    await page.evaluate((left) => self.__issuer("/sessions/terminate",
      { ok: true, version: 4, terminated: [left], devices: [] }), WORK_FP);
    await page.evaluate((rest) => self.__issuer("/sessions/terminate",
      { ok: true, version: 4, terminated: [rest.gone], devices: rest.left }),
      { gone: WORK_FP, left: DEVICES.filter((d) => d.device !== WORK_FP) });
    await page.click("#device-signout");
    await page.waitForTimeout(150);
    await page.click("#device-confirm-yes");
    await page.waitForTimeout(600);
    t("the device is signed out", /signed out 1 device/i.test(await text(page, "#device-manager-note")),
      await text(page, "#device-manager-note"));
    const after = await page.locator("#device-list .device-row").count();
    t("…and it leaves the list", after === 2, "rows=" + after);
    await shot(page, "5-devices-after");

    /* Back is the only way out of this screen, and it must restore the card
       they came from rather than a blank panel. */
    await page.click("#device-manager-back");
    await page.waitForTimeout(300);
    t("Back closes the device screen", !(await page.isVisible("#device-manager")));
    t("…and returns them to the trial card", await page.isVisible("#trial-active"));
    await page.close();
  }

  /* ── 5. Sign out of everything. The one irreversible button, and the one
        that asks for a fresh sign-in. ─────────────────────────────────────── */
  step("sign out of all devices");
  {
    const page = await popup(world({
      local: { "lct-identity-v1": { idt: "test-identity-token" } },
      issuer: {
        "/sessions": { version: 3, limit: 5, devices: DEVICES },
        "/sessions/terminate-all": { __status: 401, error: "reauth" }
      }
    }));
    await page.click("#trial-devices");
    await page.waitForSelector("#device-manager:not([hidden])", { timeout: 8000 });
    await page.waitForTimeout(300);
    t("sign-out-of-all is offered once there is more than one",
      await page.isVisible("#device-signout-all"));
    await page.click("#device-signout-all");
    await page.waitForTimeout(200);
    t("it confirms too", await page.isVisible("#device-confirm"));
    await page.click("#device-confirm-yes");
    await page.waitForTimeout(600);
    t("a stale sign-in is asked to sign in again, not shown an error",
      /sign in again/i.test(await text(page, "#device-manager-note")),
      await text(page, "#device-manager-note"));
    t("…and nothing was signed out",
      (await page.locator("#device-list .device-row").count()) === 3);
    await page.close();
  }

  /* ── 6. The list moved while they were deciding. Acting on what is no longer
        there is how the wrong machine gets signed out. ────────────────────── */
  step("the list moves under them");
  {
    const page = await popup(world({
      local: { "lct-identity-v1": { idt: "test-identity-token" } },
      issuer: {
        "/sessions": { version: 3, limit: 5, devices: DEVICES },
        "/sessions/terminate": { __status: 412, error: "stale", version: 9,
          devices: DEVICES.filter((d) => d.device !== PHONE_FP) }
      }
    }));
    await page.click("#trial-devices");
    await page.waitForSelector("#device-manager:not([hidden])", { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.locator("#device-list .device-row").nth(1).locator(".device-pick").check();
    await page.click("#device-signout");
    await page.waitForTimeout(150);
    await page.click("#device-confirm-yes");
    await page.waitForTimeout(600);
    t("a moved list is shown again rather than acted on",
      /changed on another device/i.test(await text(page, "#device-manager-note")),
      await text(page, "#device-manager-note"));
    t("…and it is the new list", (await page.locator("#device-list .device-row").count()) === 2);
    await page.close();
  }

  /* ── 7. The issuer is unreachable. A device screen that cannot answer must
        say so, not present this browser's own registry as the whole account. */
  step("the licence server is down");
  {
    const page = await popup(world({
      local: { "lct-identity-v1": { idt: "test-identity-token" } }   // no /sessions body → 503
    }));
    await page.click("#trial-devices");
    await page.waitForSelector("#device-manager:not([hidden])", { timeout: 8000 });
    await page.waitForTimeout(500);
    t("the device screen still opens", await page.isVisible("#device-manager"));
    t("…and does not offer sign-outs it cannot perform",
      !(await page.isVisible("#device-actions")));
    await page.close();
  }

  /* ── 7b. The issuer has been flipped to SESSION_SCOPE = "paid". A free
        account must be told what it takes, not shown a broken screen. ─────── */
  step("the device list has been made a Pro feature");
  {
    const page = await popup(world({
      local: { "lct-identity-v1": { idt: "test-identity-token" } },
      issuer: { "/sessions": { __status: 403, error: "paid only" } }
    }));
    await page.click("#trial-devices");
    await page.waitForSelector("#device-manager:not([hidden])", { timeout: 8000 });
    await page.waitForTimeout(500);
    t("the screen says what it takes to get the list",
      /comes with Pro/i.test(await text(page, "#device-manager-note")),
      await text(page, "#device-manager-note"));
    t("…and offers no sign-outs it cannot perform", !(await page.isVisible("#device-actions")));
    await page.close();
  }

  /* ── 8. Buying during the trial. Signed out first, because the issuer
        refuses an anonymous checkout and the address is what makes the
        purchase findable again after a reinstall. ─────────────────────────── */
  step("buying while signed out");
  {
    const page = await popup(world({
      replies: { "identity-state": { verified: false, google: true },
                 "identity-google": { branch: "cancelled" } }
    }));
    t("the button says a sign-in is coming", /sign in/i.test(await text(page, "#trial-buy")),
      await text(page, "#trial-buy"));
    await page.click("#trial-buy");
    await page.waitForTimeout(400);
    const log = await sent(page);
    t("pressing Buy signs them in first", log.includes("identity-google"), log.join(","));
    t("a cancelled sign-in opens no checkout", !log.includes("checkout-start"), log.join(","));
    t("…and says nothing was charged",
      /nothing was charged/i.test(await text(page, "#trial-buy-status")),
      await text(page, "#trial-buy-status"));
    t("the button is pressable again", !(await page.isDisabled("#trial-buy")));
    await shot(page, "6-buy-signed-out");
    await page.close();
  }

  /* ── 9. Signing in can answer the question instead: this account already
        owns the licence. Charging them again would be the bug. ────────────── */
  step("signing in finds a purchase they already made");
  {
    const page = await popup(world({
      replies: { "identity-state": { verified: false, google: true },
                 "identity-google": { branch: "ok", settled: { restored: true } } }
    }));
    await page.click("#trial-buy");
    await page.waitForTimeout(600);
    const log = await sent(page);
    t("an already-owned licence opens no checkout", !log.includes("checkout-start"), log.join(","));
    await page.close();
  }

  /* ── 10. Signed in: straight through to the payment page. ───────────────── */
  step("buying while signed in");
  {
    const page = await popup(world({ replies: { "checkout-start": { ok: true } } }));
    await page.click("#trial-buy");
    await page.waitForTimeout(400);
    const log = await sent(page);
    t("Buy asks for a checkout", log.includes("checkout-start"), log.join(","));
    t("…and the popup gets out of the way", log.includes("closed"), log.join(","));
    await page.close();
  }

  /* ── 11. A refusal has to be readable on the trial card, which has no
        licence line underneath it to fall back on. ────────────────────────── */
  step("the checkout is refused");
  {
    for (const [reason, expect] of [["throttled", /too many checkouts/i],
                                    ["closed", /store isn't open/i],
                                    ["network", /couldn't reach/i]]) {
      const page = await popup(world({ replies: { "checkout-start": { ok: false, reason } } }));
      await page.click("#trial-buy");
      await page.waitForTimeout(400);
      const note = await text(page, "#trial-buy-status");
      t(`"${reason}" is explained on the trial card`, expect.test(note), note || "(empty)");
      t(`…and Buy still works after "${reason}"`, !(await page.isDisabled("#trial-buy")));
      await page.close();
    }
  }

  /* ── 12. A purchase already in flight. Pressing Buy again is a second
        chance to be charged. ─────────────────────────────────────────────── */
  step("a purchase is already going through");
  {
    const page = await popup(world({ replies: { "checkout-state": { pending: true, held: false } } }));
    await page.waitForTimeout(400);
    t("Buy is disabled while an order is open", await page.isDisabled("#trial-buy"));
    t("…and it says why", /waiting for your payment/i.test(await text(page, "#trial-buy-status")),
      await text(page, "#trial-buy-status"));
    await page.close();
  }

  /* ── 13. Signed out from another machine. They open the popup, are told, and
        need a way to see which devices are on the account. ────────────────── */
  step("this device was signed out from somewhere else");
  {
    const page = await popup(world({
      local: { "license": { key: "dodo-test-key", email: "a@b.com" },
               "lct-signed-out-v1": { at: Date.now(), reason: "terminated" } },
      replies: { "entitlement-state": { entitled: false, reason: "no-token", kind: "dodo" } }
    }));
    t("the device screen is still reachable", await page.isVisible("#identity-devices"));
    t("Buy is still reachable", await page.isVisible("#buy-pro"));
    await page.close();
  }

  /* ── 14. Pro. Nothing about the old entry point may have moved. ─────────── */
  step("a paid licence");
  {
    const page = await popup(world({
      replies: { "entitlement-state": { entitled: true, via: "license", kind: "dodo" } }
    }));
    t("Pro keeps its own Devices button", await page.isVisible("#license-devices"));
    t("…and the trial card is gone", !(await page.isVisible("#trial-active")));
    await page.close();
  }
  /* ── 15. What the card actually looks like while Google is opening. The
        status line had no size or colour of its own, so it came out at the
        body's 13px full ink under 10.5px controls — the line in the report. ─ */
  step("the sign-in card while Google opens");
  {
    const page = await popup(world({
      replies: {
        "entitlement-state": { entitled: false, reason: "none" },
        "identity-state": { verified: false, google: true },
        "identity-google": { branch: "ok", settled: {} }
      }
    }));
    // Hold the reply open so the busy state can be looked at, the way a person
    // looks at it for the second the consent window takes to appear.
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m, cb) =>
        m && m.type === "identity-google" ? setTimeout(() => orig(m, cb), 900) : orig(m, cb);
    });
    const style = (sel, prop) => page.evaluate(([s, p]) =>
      getComputedStyle(document.querySelector(s)).getPropertyValue(p), [sel, prop]);
    const noteSize = parseFloat(await style(".pro-note", "font-size"));

    // Awaited: an unawaited click has not necessarily been DISPATCHED yet, so
    // the assertion below would read the button before the handler ran.
    await page.click("#identity-google");
    await page.waitForTimeout(200);
    t("the button says it is opening Google", /opening google/i.test(await text(page, "#identity-google")),
      await text(page, "#identity-google"));
    t("…and cannot be pressed twice", await page.isDisabled("#identity-google"));
    t("…and no full-size sentence is dropped under the card",
      (await text(page, "#identity-status")) === "", await text(page, "#identity-status"));

    // The failure line is the one that does get written. It has to read as a
    // note, not as body copy.
    await page.evaluate(() => self.__reply("identity-google", { branch: "cancelled" }));
    const page2 = await popup(world({
      replies: {
        "entitlement-state": { entitled: false, reason: "none" },
        "identity-state": { verified: false, google: true },
        "identity-google": { branch: "cancelled" }
      }
    }));
    await page2.click("#identity-google");
    await page2.waitForTimeout(300);
    const statusSize = await page2.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById("identity-status")).fontSize));
    t("the status line is note-sized, not body-sized",
      statusSize <= noteSize + 0.51, `${statusSize}px vs .pro-note ${noteSize}px`);
    t("…and the button comes back", !(await page2.isDisabled("#identity-google")) &&
      /continue with google/i.test(await text(page2, "#identity-google")));
    await shot(page2, "15-signin-status");

    // Three full-width buttons of equal weight was the other half of the
    // report: one decision asked three times.
    const filled = await page2.evaluate(() => ["identity-google", "trial-start", "buy-pro"]
      .filter((id) => {
        const el = document.getElementById(id);
        if (!el || el.hidden) return false;
        const bg = getComputedStyle(el).backgroundColor;
        return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      }));
    t("only one button on the card is a filled one", filled.length === 1, filled.join(","));
    t("…and it is the step that is actually in front", filled[0] === "identity-google", filled.join(","));

    // The 380px pane is the constraint the copy kept losing to.
    const overflow = await page2.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("the card does not push the pane sideways", overflow <= 0, `${overflow}px over`);
    await page.close();
    await page2.close();
  }

  /* ── 16. The reinstall. The archive is gone, the ledger is not, and the pass
        is deliberately capturing only new chats — which is invisible unless
        this row says so where the person is already looking. ─────────────── */
  step("reopened after a reinstall");
  {
    const page = await popup(world({
      replies: {
        "recall-sync-status": {
          recovery: { state: "restore-offered", backup: { chats: 714, filename: "a.lctbackup" } },
          deletions: { count: 0 },
          summary: { state: "syncing", message: "Capturing 3 of 3 new chats…", done: 3, total: 3 }
        }
      }
    }));
    await page.waitForTimeout(400);
    t("the reinstall is called out in the popup", await page.isVisible("#restore-alert"));
    t("…naming what the backup holds", /714/.test(await text(page, "#restore-alert-title")),
      await text(page, "#restore-alert-title"));
    t("…and saying why the count is small",
      /only new chats/i.test(await text(page, "#restore-alert-sub")),
      await text(page, "#restore-alert-sub"));
    await shot(page, "16-reinstall");
    await page.close();
  }

  /* ── 17. …and it stays out of the way when there was no reinstall. ─────── */
  step("an ordinary open");
  {
    const page = await popup(world({
      replies: { "recall-sync-status": { recovery: { state: "ready" }, deletions: { count: 0 },
        summary: { state: "current", message: "Everything is already backed up", checkedAt: Date.now() } } }
    }));
    await page.waitForTimeout(400);
    t("no restore row when nothing was lost", !(await page.isVisible("#restore-alert")));
    await page.close();
  }

  /* ── 18. What a device is CALLED. A browser cannot read the computer's name
        — no extension API exposes it — so the row has exactly two honest
        sources: a name the person typed, and what the browser will describe.
        "Unknown device" about the machine you are holding is neither. ─────── */
  const NAMED = [
    { device: SELF_FP, label: "", plat: "", geo: "IN", lastSeen: Date.now(), self: true },
    { device: WORK_FP, label: "Work laptop", plat: "Windows 11 · Edge", geo: "DE",
      lastSeen: Date.now() - 36e5, self: false }
  ];
  const deviceWorld = (devices, over = {}) => world({
    local: { "lct-identity-v1": { idt: "test-identity-token" }, ...(over.local || {}) },
    issuer: { "/sessions": { version: 3, limit: 5, devices }, ...(over.issuer || {}) },
    ...over
  });
  const openDevices = async (page) => {
    await page.click("#trial-devices");
    await page.waitForSelector("#device-manager:not([hidden])", { timeout: 8000 });
    await page.waitForTimeout(400);
  };
  const rowText = (page, n) => text(page, `#device-list .device-row:nth-child(${n})`);

  step("what each device is called");
  {
    const page = await popup(deviceWorld(NAMED));
    await openDevices(page);
    const mine = await rowText(page, 1);
    t("this device is never called Unknown", !/unknown device/i.test(mine), mine);
    t("…it is described by what the browser does know", /chrome/i.test(mine), mine);
    t("a device someone named shows the NAME, not the platform",
      /^Work laptop/.test(await rowText(page, 2)), await rowText(page, 2));
    t("…with the machine kept underneath it",
      /Windows 11 · Edge/.test(await rowText(page, 2)), await rowText(page, 2));
    t("only this device's name is the rename control",
      await page.locator("#device-list .device-row").nth(0).locator(".device-name-edit").count() === 1 &&
      await page.locator("#device-list .device-row").nth(1).locator(".device-name-edit").count() === 0);
    t("every row carries its own Sign out instead of a rename button",
      await page.locator("#device-list .device-signout-one").count() === 2 &&
      await page.locator("#device-list .device-rename").count() === 0);
    await shot(page, "18-device-names");
    await page.close();
  }

  /* ── 19. Naming it. The name has to reach the ACCOUNT, not just this
        browser, or the other devices go on showing the old row. ──────────── */
  step("naming this device");
  {
    const page = await popup(deviceWorld(NAMED));
    await openDevices(page);
    await page.locator(".device-name-edit").first().click();
    await page.fill(".device-rename-input", "Anirudh's ThinkPad");
    await page.evaluate(() => self.__issuer("/sessions", { version: 4, limit: 5, devices: [
      { device: "a".repeat(32), label: "Anirudh's ThinkPad", plat: "Windows 11 · Chrome",
        geo: "IN", lastSeen: Date.now(), self: true }] }));
    await page.click(".device-rename-save");
    await page.waitForTimeout(600);
    const named = await rowText(page, 1);
    t("the typed name is what the row is called", /Anirudh's ThinkPad/.test(named), named);
    t("…and it is still marked as this device", /this device/i.test(named), named);
    t("…with the machine underneath, not the name twice",
      (named.match(/Anirudh's ThinkPad/g) || []).length === 1, named);
    t("the note says the account got it, not just this browser",
      /every device/i.test(await text(page, "#device-manager-note")),
      await text(page, "#device-manager-note"));
    t("the row action stayed Sign out, not a rename button",
      /^sign out$/i.test((await text(page, ".device-signout-one")).trim()),
      await text(page, ".device-signout-one"));
    await shot(page, "19-device-named");
    await page.close();
  }

  /* ── 20. What a name may be. A label is written by one device and READ on
        every other one, so it is untrusted input on arrival. ──────────────── */
  step("names that are not names");
  {
    const page = await popup(deviceWorld(NAMED));
    await openDevices(page);
    await page.locator(".device-name-edit").first().click();

    await page.fill(".device-rename-input", "    ");
    await page.click(".device-rename-save");
    await page.waitForTimeout(250);
    t("a name of spaces is refused", /give it a name/i.test(await text(page, ".device-rename-err")),
      await text(page, ".device-rename-err"));
    t("…and the form stays open rather than saving nothing",
      await page.isVisible(".device-rename-input"));

    const XSS = '<img src=x onerror="document.title=\'pwned\'">';
    await page.fill(".device-rename-input", XSS);
    await page.evaluate((name) => self.__issuer("/sessions", { version: 5, limit: 5, devices: [
      { device: "a".repeat(32), label: name, plat: "macOS · Chrome",
        geo: "IN", lastSeen: Date.now(), self: true }] }), XSS);
    await page.click(".device-rename-save");
    await page.waitForTimeout(600);
    t("markup in a name is text, never an element",
      await page.locator("#device-list img").count() === 0 &&
      (await page.title()) !== "pwned");
    t("…and it is shown as typed", (await rowText(page, 1)).includes("<img src=x"),
      await rowText(page, 1));

    await page.locator(".device-name-edit").first().click();
    await page.fill(".device-rename-input", "Anirudh 💻 ノート");
    await page.evaluate(() => self.__issuer("/sessions", { version: 6, limit: 5, devices: [
      { device: "a".repeat(32), label: "Anirudh 💻 ノート", plat: "macOS · Chrome",
        geo: "IN", lastSeen: Date.now(), self: true }] }));
    await page.click(".device-rename-save");
    await page.waitForTimeout(600);
    t("emoji and non-Latin names survive", /Anirudh 💻 ノート/.test(await rowText(page, 1)),
      await rowText(page, 1));

    // The issuer caps the field at 40; the box must not let a person type 200
    // and then silently lose 160 of them.
    const cap = await page.evaluate(() => {
      const el = document.querySelector(".device-name-edit");
      el.click();
      return document.querySelector(".device-rename-input").maxLength;
    });
    t("the box caps at what the issuer stores", cap === 40, String(cap));
    const kept = await page.evaluate(() => self.LCTEntitlement.cleanDeviceName("x".repeat(200)).length);
    t("…and an over-long name is trimmed, not rejected", kept === 40, String(kept));
    await page.close();
  }

  /* ── 21. Saved here, not confirmed there. Reporting "renamed" would promise
        the other devices something that has not happened. ─────────────────── */
  step("the issuer is unreachable while renaming");
  {
    const page = await popup(deviceWorld(NAMED));
    await openDevices(page);
    await page.locator(".device-name-edit").first().click();
    await page.fill(".device-rename-input", "Kitchen iMac");
    await page.evaluate(() => self.__issuer("/sessions", null));   // 503 from here on
    await page.click(".device-rename-save");
    await page.waitForTimeout(600);
    const note = await text(page, "#device-manager-note");
    t("the note does not claim the account has it", !/every device/i.test(note), note);
    t("…and says where it actually got to", /saved on this device/i.test(note), note);
    t("the name is still shown here", /Kitchen iMac/.test(await rowText(page, 1)),
      await rowText(page, 1));
    await page.close();
  }

  /* ── 22. Windows 10 and Windows 11 both say "Windows NT 10.0" in the user
        agent. Only platformVersion tells them apart, and telling two of your
        own machines apart is the whole job of this screen. ────────────────── */
  step("the platform the browser reports");
  {
    const fakeUA = (version, platform, model) => `(() => {
      Object.defineProperty(navigator, "userAgentData", { configurable: true, value: {
        platform: ${JSON.stringify(platform)},
        brands: [{ brand: "Chromium", version: "140" }],
        getHighEntropyValues: async () => ({ platformVersion: ${JSON.stringify(version)},
          model: ${JSON.stringify(model || "")} })
      } });
    })();`;
    for (const [version, platform, model, expect] of [
      ["15.0.0", "Windows", "", /Windows 11/],
      ["10.0.0", "Windows", "", /Windows 10/],
      ["15.3.0", "macOS", "", /macOS 15/],
      ["14.0.0", "Android", "Pixel 8", /Pixel 8/]
    ]) {
      const page = await popup(deviceWorld(NAMED), fakeUA(version, platform, model));
      await openDevices(page);
      const mine = await rowText(page, 1);
      t(`${platform} ${version}${model ? " " + model : ""} is described as itself`,
        expect.test(mine), mine);
      await page.close();
    }

    // A browser with no client hints at all — Firefox, and Chrome with the
    // feature off. The row still has to say something true.
    const page = await popup(deviceWorld(NAMED),
      `Object.defineProperty(navigator, "userAgentData", { configurable: true, value: undefined });`);
    await openDevices(page);
    const mine = await rowText(page, 1);
    t("a browser that reports no client hints still names the machine",
      !/unknown device/i.test(mine) && mine.length > 0, mine);
    await page.close();
  }

  /* ── 23. The face on the account. A signed-in header carries the Google
        photo in a ring, and the ring is the plan — so "which account am I on,
        and what am I paying" is one glance rather than two. ──────────────── */
  step("the account face");
  {
    const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" +
      "CAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const withFace = (state, over = {}) => world({
      replies: {
        "entitlement-state": state,
        "identity-state": { verified: true, google: true,
          profile: { picture: PHOTO, name: "Anirudh Aravalli", email: "a@example.com" } },
        ...(over.replies || {})
      },
      ...over
    });

    for (const [label, state, cls] of [
      ["trial", { entitled: true, via: "trial", trial: TRIAL }, "trial"],
      ["pro", { entitled: true, via: "dodo", kind: "dodo", trial: null }, "pro"],
      ["free", { entitled: false, via: "none", trial: null }, "free"]
    ]) {
      const page = await popup(withFace(state));
      t(`${label}: the photo is on screen`, await page.isVisible("#account-photo"));
      t(`${label}: the ring names the plan`,
        (await page.getAttribute("#account", "class") || "").includes(cls),
        await page.getAttribute("#account", "class"));
      t(`${label}: the pill agrees with the ring`,
        (await text(page, "#plan-badge")).toLowerCase() === label,
        await text(page, "#plan-badge"));
      await shot(page, "23-face-" + label);
      await page.close();
    }
  }

  /* ── 24. What the pill is allowed to say. A licensed install can be holding a
        signed trial at the same time, and the header used to read TRIAL over a
        purchase. The pill names what is actually unlocking the extension. ── */
  step("the pill never overstates the plan");
  {
    const faced = (state) => world({
      replies: { "entitlement-state": state,
        "identity-state": { verified: true, google: true } }
    });

    let page = await popup(faced({ entitled: true, via: "dodo", kind: "dodo", trial: TRIAL }));
    t("a purchase with a live trial on it still reads Pro",
      (await text(page, "#plan-badge")) === "Pro", await text(page, "#plan-badge"));
    await page.close();

    // A week that runs and grants nothing: the clock is real, the entitlement
    // is not, and only the entitlement may show as Trial.
    page = await popup(faced({ entitled: false, via: "none",
      trial: { grants: false, until: Date.now() + 5 * 864e5 } }));
    t("an unsigned week is not a trial on the badge",
      (await text(page, "#plan-badge")) === "Free", await text(page, "#plan-badge"));
    t("…and the upsell is still the card on screen", await page.isVisible("#pro-upsell"));
    await page.close();
  }

  /* ── 25. No photo, and no account. Neither may leave an empty circle. ──── */
  step("the face falls back rather than breaking");
  {
    let page = await popup(world({
      replies: {
        "entitlement-state": { entitled: false, via: "none", trial: null },
        "identity-state": { verified: true, google: true,
          profile: { picture: "", name: "Riya Menon", email: "r@example.com" } }
      }
    }));
    t("an account with no photo still shows a monogram",
      await page.isVisible("#account-initial") && !(await page.isVisible("#account-photo")));
    t("…and the monogram is theirs", (await text(page, "#account-initial")) === "R",
      await text(page, "#account-initial"));
    await page.close();

    page = await popup(world({
      replies: {
        "entitlement-state": { entitled: false, via: "none", trial: null },
        "identity-state": { verified: false, google: true }
      }
    }));
    t("signed out there is no ring at all", !(await page.isVisible("#account-ring")));
    t("…and the plan pill is still there", await page.isVisible("#plan-badge"));
    await page.close();
  }

  /* ── 26. "0 devices" on the machine you just signed in on. The issuer writes
        the row at sign-in now, but the screen must not depend on that having
        landed: the device in front of the person is always on the list. ──── */
  step("the device list is never empty while signed in");
  {
    const seatedWorld = (devices) => world({
      local: { "lct-identity-v1": { idt: "test-identity-token" } },
      issuer: { "/sessions": { version: 1, limit: 5, devices } }
    });
    const open = async (page) => {
      await page.click("#trial-devices");
      await page.waitForSelector("#device-manager:not([hidden])", { timeout: 8000 });
      await page.waitForTimeout(400);
    };
    const row = (page, n) => text(page, `#device-list .device-row:nth-child(${n})`);

    let page = await popup(seatedWorld([]));
    await open(page);
    t("an empty answer still shows this device",
      await page.locator("#device-list .device-row").count() === 1,
      await text(page, "#device-count"));
    t("…and it is not counted as zero",
      /^1 device$/.test(await text(page, "#device-count")), await text(page, "#device-count"));
    t("…named as this machine, not Unknown",
      !/unknown device/i.test(await row(page, 1)), await row(page, 1));
    t("…and it cannot be signed out, because the issuer has no row for it",
      await page.locator("#device-list .device-row").nth(0)
        .locator(".device-pick").isDisabled());
    t("…but it can still be named", await page.locator("#device-list .device-row").nth(0)
      .locator(".device-name-edit").count() === 1);
    t("…and its own Sign out is dead too, for the same reason",
      await page.locator("#device-list .device-row").nth(0)
        .locator(".device-signout-one").isDisabled());
    await shot(page, "26-never-zero");
    await page.close();

    /* The other half: a list that DOES contain this device must not grow a
       second copy of it. */
    page = await popup(seatedWorld(DEVICES));
    await open(page);
    t("a list that already has this device is left alone",
      await page.locator("#device-list .device-row").count() === DEVICES.length,
      await text(page, "#device-count"));
    t("…with exactly one row marked as this one",
      await page.locator("#device-list .device-row.is-self").count() === 1);
    await page.close();
  }

} catch (err) {
  t("the journey ran to the end", false, String(err && err.stack || err));
}

t("no popup threw during the run", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await shut(fail ? 1 : 0);
