/* Shared per-row setup for the Layer-4 combinatorial matrix. Sibling to
   mock-providers.mjs in spirit: fixtures other files assemble, not a runner
   itself. State and Render are implemented generally (they don't need
   per-surface DOM knowledge — entitlement lives in chrome.storage, render
   conditions are Playwright/CDP-level browser emulation). Archive seeding is
   built to be called ONCE per shared State value and reused across every row
   in that group — a naive per-row reseed would blow the time budget on the
   two archive-scale states alone. */
import { mintLct2Token, mintTrialToken, b64url, setStorage, deviceFingerprint } from "./security-fixtures.mjs";

/**
 * Configure chrome.storage to represent one of the 8 State values. `priv` is
 * the mirrored extension's test-trusted private key (see security-fixtures.mjs
 * mirrorExtension) — required for "pro", since a real signed LCT2 token is
 * the only thing bg.js's gate accepts.
 */
export async function setEntitlement(ctx, extId, state, { priv, deviceId = "matrix-device-0001", licenseKey = "MATRIX-TEST-KEY-0001" } = {}) {
  const now = Date.now();
  /* The tour is marked done for every row. It is install onboarding, it opens
     over whatever surface the row is about, and since the install listener
     arms it on every fresh profile it turned a 104-second smoke slice into 49
     minutes — past the CI job's own timeout. The tour has its own coverage in
     test-extension.mjs; here it is noise on top of the thing under test. */
  await setStorage(ctx, extId, "local", {
    license: null, "lct-entitlement-v2": null, "lct-trial-v2": null,
    "lct-tour-v1": now, "lct-tour-armed-v1": null
  });
  await setStorage(ctx, extId, "sync", { "lct-device-id-v1": { id: deviceId, mintedAt: now } });

  switch (state) {
    case "free":
    case "empty-archive":
    case "50k-chat-archive":
      // Free tier by default — the two archive-scale states vary archive
      // size, not entitlement; free is the simpler, cheaper state to pair
      // them with unless a row's own combination says otherwise.
      break;
    /* A trial is a SIGNED grant now, not a start date in storage — the gate
       reads the dates out of the signature and ignores the record's own copy.
       An unsigned fixture is therefore a "free" row wearing a trial label, and
       every trial row would have been testing the wrong state. */
    case "trial":
    case "trial-expired": {
      if (!priv) throw new Error(`setEntitlement("${state}") requires the mirrored extension's test private key`);
      const startedAt = now - (state === "trial" ? 2 : 9) * 864e5;
      const dev = await deviceFingerprint(ctx, extId, deviceId);
      await setStorage(ctx, extId, "local", {
        "lct-trial-v2": {
          startedAt, v: 2, verified: true, checkedAt: now,
          ks: b64url(Buffer.from("matrix-trial-stamp")),
          tt: mintTrialToken(priv, { dev, startedAt, ks: b64url(Buffer.from("matrix-trial-stamp")) })
        }
      });
      break;
    }
    case "pro": {
      if (!priv) throw new Error('setEntitlement("pro") requires the mirrored extension\'s test private key');
      await setStorage(ctx, extId, "local", {
        license: { key: licenseKey, kind: "dodo", email: "matrix@example.com", instanceId: "matrix-instance-1", activatedAt: now }
      });
      /* Bound to the fingerprint the extension actually derives from its
         device key, not to the stored device id — under protocol v3 those are
         different values (see mintLct2Token). Getting it wrong is silent: the
         token simply never matches, every "pro" row behaves as locked, and the
         first thing that notices is a 30-second timeout waiting for a search
         box that was never going to appear. */
      const dev = await deviceFingerprint(ctx, extId, deviceId);
      const token = mintLct2Token(priv, { licenseKey, dev, ks: b64url(Buffer.from("matrix-stamp-secret")) });
      await setStorage(ctx, extId, "local", { "lct-entitlement-v2": { token, fetchedAt: now } });
      break;
    }
    case "deactivated":
      await setStorage(ctx, extId, "local", {
        license: { key: licenseKey, kind: "dodo", email: "matrix@example.com", instanceId: "matrix-instance-1", activatedAt: now, revokedAt: now }
      });
      break;
    case "offline":
      // Entitlement state itself doesn't matter for "offline" — the row's
      // Host/Render/A11y factors are what's under test while the network is
      // down. Runner applies context.setOffline(true) separately.
      break;
    default:
      throw new Error(`unknown State value: ${state}`);
  }
}

/** Bulk-seed N synthetic chats via recall-import (one message, not N). */
export async function seedArchive(ctx, extId, count) {
  const page = await ctx.newPage();
  try {
    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    // Import in batches — a single 50,000-element array in one sendMessage
    // payload is unnecessarily large; chunk it the way a real sync would.
    const CHUNK = 2000;
    for (let start = 0; start < count; start += CHUNK) {
      const n = Math.min(CHUNK, count - start);
      const chats = Array.from({ length: n }, (_, i) => {
        const idx = start + i;
        return {
          id: `matrix-seed-${idx}`,
          host: "chatgpt.com",
          path: `/c/matrix-seed-${idx}`,
          platform: "chatgpt",
          title: `Seeded matrix chat #${idx}`,
          msgs: [
            { i: `m${idx}-1`, r: "user", t: "Test question " + idx },
            { i: `m${idx}-2`, r: "assistant", t: "Test answer " + idx }
          ]
        };
      });
      await page.evaluate((c) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "recall-import", chats: c }, (r) => { void chrome.runtime.lastError; resolve(r); });
      }), chats);
    }
  } finally { await page.close(); }
}

export async function wipeArchive(ctx, extId) {
  const page = await ctx.newPage();
  try {
    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    await page.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "recall-wipe" }, resolve)));
  } finally { await page.close(); }
}

/** Archive size each archive-scale State value expects, so a runner knows
 *  whether/how much to seed before a group of rows sharing that State. */
export const ARCHIVE_SIZE_FOR_STATE = { "empty-archive": 0, "50k-chat-archive": 50000 };

/** Apply one Render condition. Returns a title override some rows need
 *  (RTL/CJK/emoji, 2000-char) — the caller feeds that into whatever chat
 *  fixture the row's Surface uses; this function only handles the
 *  browser/page-level half of Render, not surface-specific rendering. */
export async function applyRenderCondition(page, render) {
  switch (render) {
    case "zoom":
      // Representative sample across the stated 80-200% range, not every
      // integer percent — this IS the render value's whole cell, exercised
      // at a defensible midpoint plus its two extremes across separate rows
      // would be a finer sub-grid than the approved factor list specifies.
      await page.evaluate(() => { document.body.style.zoom = "1.25"; });
      return {};
    case "320px-window":
      await page.setViewportSize({ width: 320, height: 640 });
      return {};
    case "rtl-cjk-emoji-titles":
      return { title: "مرحبا 你好 🎉 RTL/CJK/emoji title" };
    case "2000-char-title":
      return { title: "A".repeat(2000) };
    case "dark-light-switch-mid-session":
      await page.emulateMedia({ colorScheme: "light" });
      // "mid-session switch" is the point of this value — apply light, let
      // the caller render, then the runner flips to dark and re-checks.
      return { midSessionSwitch: async () => page.emulateMedia({ colorScheme: "dark" }) };
    case "prefers-reduced-motion":
      await page.emulateMedia({ reducedMotion: "reduce" });
      return {};
    case "forced-colors":
      await page.emulateMedia({ forcedColors: "active" });
      return {};
    default:
      throw new Error(`unknown Render value: ${render}`);
  }
}

/** Which host-mapped adapter label a synthetic-hosted row should present as,
 *  when a row's real intent is exercising a specific provider's CSS/quirks
 *  but the runner is pointed at the local synthetic page (see test-matrix.mjs
 *  for when this applies vs. when a row genuinely needs a real provider). */
export const HOST_LABELS = {
  chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini",
  perplexity: "Perplexity", deepseek: "DeepSeek", grok: "Grok", synthetic: "Test Page"
};
