#!/usr/bin/env node
/* FIXED, now a regression lock — this used to be a live red-team probe that
   found a real open-redirect (see git history for the original finding and
   the cross-session review that refined its severity, including a second
   unguarded site this same review caught: popup.js's recallResult() had the
   identical pattern and was missed by the first pass). The fix landed at
   the point of use, not the point of write:

   bg.js's shared record normalizer (clampChat) still does
   `host: String(chat.host || "").slice(0, 100)` — a length clamp, not an
   allowlist — deliberately: dropping a malformed-but-honest record at write
   time would silently lose the user's own chat history, and this field also
   flows through sync/export. Both `recall-upsert` (live sync) and
   `recall-import` (bulk/backup) still accept and STORE any host, with no
   entitlement required.

   The allowlist instead lives at EVERY point of use — there are exactly two
   in the whole extension, both gated by an identical `KNOWN_CHAT_HOSTS` set
   (7 host entries — chatgpt.com AND chat.openai.com are both real, distinct
   entries for the one ChatGPT product):
     recall-page.js  — window.open("https://" + res.host + res.path, ...)
     popup/popup.js  — chrome.tabs.create({ url: "https://" + res.host + res.path })
   A non-matching host makes the click a no-op instead of a navigation.
   Exact match, not suffix: "evil-claude.ai" and "claude.ai@evil.com" both
   fail it. Point-of-use enforcement is a real, permanent burden, not a
   one-time fix — see navigationSitesAreGuarded() below, which enumerates
   every navigation call in the extension rather than trusting this comment
   to stay accurate. That's what catches the NEXT surface, not this one.

   This file asserts: the write paths remain permissive (by design — that's
   not the bug), the records remain findable (search is unaffected), the
   click is refused for anything outside the known hosts on both sites, and
   — structurally — that no third site has appeared unguarded. */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import {
  ROOT, SCRATCH, reporter, mirrorExtension, mintLct2Token, b64url,
  launchExtension, sendFromExtensionPage, setStorage, deviceFingerprint
} from "./security-fixtures.mjs";

const { t, done } = reporter();
const DEVICE_ID = "recall-nav-device-0001";
const LICENSE_KEY = "TESTKEY-RECALLNAV-0001";

const { EXT, priv } = mirrorExtension("recall-navigation");
const { ctx, id } = await launchExtension(EXT, join(SCRATCH, "recall-navigation-profile"));

try {
  // recall-search (used by the results UI) IS pro-gated — seed a valid
  // entitlement so the search itself isn't what's locked; the write paths
  // under test are checked independently of this.
  await setStorage(ctx, id, "sync", { "lct-device-id-v1": { id: DEVICE_ID, mintedAt: Date.now() } });
  await setStorage(ctx, id, "local", {
    license: { key: LICENSE_KEY, kind: "dodo", email: "test@example.com", instanceId: "test-instance-1", activatedAt: Date.now() }
  });
  /* Bound to the fingerprint the extension actually derives from its device
     key, not to the stored device id — see mintLct2Token. Getting this wrong
     does not fail loudly: the token simply never matches, the page stays
     locked, and the test times out waiting for a search box that was never
     going to appear. */
  const dev = await deviceFingerprint(ctx, id, DEVICE_ID);
  const token = mintLct2Token(priv, { licenseKey: LICENSE_KEY, dev, ks: b64url(Buffer.from("recall-nav-stamp")) });
  await setStorage(ctx, id, "local", { "lct-entitlement-v2": { token, fetchedAt: Date.now() } });

  const mkChat = (id2, msgOverrides = {}) => ({
    id: id2,
    host: "evil.com",
    path: "/hijack?" + id2,
    title: id2, // the query the test searches for — id2 is unique per case, so this is an exact-match handle
    platform: "chatgpt",
    msgs: [
      { i: "m1", r: "user", t: "What's my account balance?" },
      { i: "m2", r: "assistant", t: "Here is your balance." }
    ],
    ...msgOverrides
  });

  /* ---------- path 1: recall-upsert (live per-chat sync) ---------- */
  const upsertChat = mkChat("XSSNAV-UPSERT-" + Math.random().toString(36).slice(2, 8));
  const upsertRes = await sendFromExtensionPage(ctx, id, { type: "recall-upsert", chat: upsertChat });
  t("recall-upsert accepts a chat with host=evil.com with no entitlement at all",
    !!upsertRes && upsertRes.ok === true, `response: ${JSON.stringify(upsertRes)}`);

  /* ---------- path 2: recall-import (bulk/backup-restore-style) ---------- */
  const importChat = mkChat("XSSNAV-IMPORT-" + Math.random().toString(36).slice(2, 8));
  const importRes = await sendFromExtensionPage(ctx, id, { type: "recall-import", chats: [importChat] });
  t("recall-import accepts a batch containing host=evil.com with no entitlement at all",
    !!importRes && (importRes.ok > 0 || (Array.isArray(importRes.stored) && importRes.stored.length > 0)),
    `response: ${JSON.stringify(importRes)}`);

  /* ---------- click through: what does the UI actually navigate to? ---------- */
  async function clickAndCapture(searchTitle) {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__openedUrls = [];
      const origOpen = window.open;
      window.open = (...args) => { window.__openedUrls.push(args[0]); return origOpen ? null : null; };
    });
    await page.goto(`chrome-extension://${id}/recall.html`);
    await page.waitForSelector("#q", { timeout: 10000 });
    await page.fill("#q", searchTitle);
    // #q's "input" listener debounces 180ms before firing recall-search, plus
    // the round trip to the service worker and back.
    await page.waitForFunction(
      () => document.getElementById("q-meta") && document.getElementById("q-meta").textContent.trim().length > 0,
      null, { timeout: 5000 }
    ).catch(() => {});
    await page.waitForTimeout(400);

    const rowCount = await page.evaluate(() => document.getElementById("results").children.length);
    if (rowCount === 0) { await page.close(); return { rowCount, opened: [] }; }

    await page.locator("#results > *").first().click();
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => window.__openedUrls || []);
    await page.close();
    return { rowCount, opened };
  }

  const upsertClick = await clickAndCapture(upsertChat.title);
  t(`recall-upsert record ("${upsertChat.title}") is findable via the search UI (write path is still permissive, by design)`,
    upsertClick.rowCount > 0, `rowCount: ${upsertClick.rowCount}`);
  if (upsertClick.rowCount > 0) {
    t("clicking the recall-upsert result does NOT navigate anywhere — host fails KNOWN_CHAT_HOSTS",
      upsertClick.opened.length === 0,
      `window.open was called with: ${JSON.stringify(upsertClick.opened)}`);
  }

  const importClick = await clickAndCapture(importChat.title);
  t(`recall-import record ("${importChat.title}") is findable via the search UI (write path is still permissive, by design)`,
    importClick.rowCount > 0, `rowCount: ${importClick.rowCount}`);
  if (importClick.rowCount > 0) {
    t("clicking the recall-import result does NOT navigate anywhere — host fails KNOWN_CHAT_HOSTS",
      importClick.opened.length === 0,
      `window.open was called with: ${JSON.stringify(importClick.opened)}`);
  }

  /* ---------- the classic userinfo-confusable variant ---------- */
  const confusableChat = mkChat("XSSNAV-CONFUSABLE-" + Math.random().toString(36).slice(2, 8),
    { host: "chatgpt.com@evil.com" });
  await sendFromExtensionPage(ctx, id, { type: "recall-upsert", chat: confusableChat });
  const confusableClick = await clickAndCapture(confusableChat.title);
  if (confusableClick.rowCount > 0) {
    t('a "trusted-looking" host (chatgpt.com@evil.com) is rejected — exact match, not a contains/startsWith check',
      confusableClick.opened.length === 0,
      `window.open was called with: ${JSON.stringify(confusableClick.opened)}`);
  }

  /* ---------- positive control: a REAL host must still work ---------- */
  const realChat = mkChat("XSSNAV-REALHOST-" + Math.random().toString(36).slice(2, 8), { host: "claude.ai" });
  await sendFromExtensionPage(ctx, id, { type: "recall-upsert", chat: realChat });
  const realClick = await clickAndCapture(realChat.title);
  t(`real-host record ("${realChat.title}") is findable via the search UI`, realClick.rowCount > 0);
  if (realClick.rowCount > 0) {
    t("clicking a real-provider-host result still navigates normally (the fix isn't overbroad)",
      realClick.opened[0] === `https://claude.ai${realChat.path}`,
      `window.open was called with: ${JSON.stringify(realClick.opened)}`);
  }
} finally {
  await ctx.close();
}

/* ---------- structural: every navigation-of-a-stored-host site is guarded ----------
   A behavioural test only covers the surfaces someone thought to click through —
   that is exactly how popup.js's copy of this bug went unnoticed by the first
   pass. This enumerates every real navigation call in the shipped extension
   (window.open, location.href/assign/replace, chrome.tabs.create/update) across
   every .js/.html file, and for each one that concatenates a `.host`-shaped
   value into a URL, requires a `KNOWN_CHAT_HOSTS.has(...)` guard within the
   preceding few lines. A future surface that lists chats and forgets the
   guard fails this test, not just a manual audit. */
function walkFiles(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "test", ".git", ".stryker-tmp", "docs", "icons"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, exts, out);
    else if (exts.includes(extname(entry.name))) out.push(full);
  }
  return out;
}

function navigationSitesAreGuarded() {
  const files = walkFiles(ROOT, [".js", ".html"]);
  const NAV_PATTERN = /window\.open\(|location\.(href\s*=|assign\(|replace\()|chrome\.tabs\.(create|update)\(/;
  const HOST_PATTERN = /\.host\b/;
  const GUARD_PATTERN = /KNOWN_CHAT_HOSTS\.has\(/;
  const findings = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!NAV_PATTERN.test(lines[i])) continue;
      // Does this specific navigation call consume a stored host? Check the
      // matched line and a couple lines around it for a `.host` reference —
      // both known sites build the URL string inline on the same call.
      const window_ = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
      if (!HOST_PATTERN.test(window_)) continue;
      // Search backward for the guard, but stop at the enclosing function's
      // own start (a fresh `function ...(` / `... => {` at low indent) —
      // a guard belonging to a DIFFERENT function shouldn't count, but one
      // early-returning inside the SAME function should, no matter how many
      // lines separate an early guard from a later nested navigation call.
      const FUNCTION_START = /^\s{0,4}(function\s+\w+\(|(?:async\s+)?function\s*\(|\w+\s*\([^)]*\)\s*{)/;
      let start = i;
      for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
        start = j;
        if (FUNCTION_START.test(lines[j])) break;
      }
      const precedingWindow = lines.slice(start, i + 1).join("\n");
      const guarded = GUARD_PATTERN.test(precedingWindow);
      findings.push({ file: file.replace(ROOT + "/", ""), line: i + 1, guarded, text: lines[i].trim() });
    }
  }
  return findings;
}

{
  const findings = navigationSitesAreGuarded();
  t("at least the 2 known navigation-of-stored-host sites were found by the enumeration",
    findings.length >= 2, `found ${findings.length}: ${JSON.stringify(findings.map((f) => `${f.file}:${f.line}`))}`);
  const unguarded = findings.filter((f) => !f.guarded);
  t("every navigation site that consumes a stored .host is guarded by KNOWN_CHAT_HOSTS — no third unguarded site exists",
    unguarded.length === 0,
    unguarded.length ? `UNGUARDED: ${JSON.stringify(unguarded)}` : "");
}

done();
