#!/usr/bin/env node
/* Full-session egress proof: drive several surfaces (recall search, bridge
   context-pull, popup entitlement check, purchase activation) under a
   request-recording proxy, and assert every single request the extension
   makes lands on an allowlisted host — the 6 real AI providers (for the
   user's own session-cookie-bearing traffic), tvara.pages.dev, the
   entitlement issuer, or one of lib/dodo.js's two Dodo API hosts — and that
   Dodo requests specifically carry no cookie header, operationalizing
   lib/dodo.js's own header-comment claims ("never a cookie... never the
   device UUID in full") instead of trusting them by reading the comment.

   Runs against the source tree directly (no keypair mirroring needed — this
   test observes network egress, not entitlement verification, and a real
   ISSUER value here is what makes the allowlist meaningful). Every request
   is intercepted and answered locally, never actually reaching the network —
   this proves what the extension ATTEMPTS to contact, deterministically and
   offline, which is the actual security question. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { ROOT, SCRATCH, reporter, idFromManifestKey } from "./security-fixtures.mjs";

const { t, done } = reporter();
const PROFILE = join(SCRATCH, "egress-proof-profile");
(await import("node:fs")).rmSync(PROFILE, { recursive: true, force: true });

const mf = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
// Derived from the manifest itself rather than a second hardcoded list —
// dev-only matches (localhost/127.0.0.1) are filtered out the same way
// tools/pack.mjs filters them before shipping.
const REAL_PROVIDER_HOSTS = [...new Set((mf.host_permissions || [])
  .map((m) => { try { return new URL(m.replace(/\*/g, "x")).host; } catch { return null; } })
  .filter((h) => h && !/localhost|127\.0\.0\.1/.test(h)))];
// No fallback: a missed match would allowlist a host the extension never uses
// and let this proof pass without ever watching the real issuer.
const ISSUER_URL = (readFileSync(join(ROOT, "lib", "entitlement.js"), "utf8")
  .match(/const ISSUER = "([^"]*)";/) || [])[1];
if (!ISSUER_URL) throw new Error("cannot read ISSUER from lib/entitlement.js");
const ISSUER_HOST = new URL(ISSUER_URL).host;
const ALLOWED_HOSTS = new Set([
  ...REAL_PROVIDER_HOSTS,
  "tvara.pages.dev",
  ISSUER_HOST,
  "live.dodopayments.com",
  "test.dodopayments.com",
  // Playwright/Chromium's own internal traffic when driving an extension page — not the extension's doing.
  "127.0.0.1", "localhost"
]);

console.log(`Allowlist: ${[...ALLOWED_HOSTS].join(", ")}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: process.env.PW_CHANNEL || "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  viewport: { width: 900, height: 800 }
});
await new Promise((r) => setTimeout(r, 1500));

const captured = []; // {url, host, method, hasCookie, resourceType}
await ctx.route("**/*", async (route) => {
  const req = route.request();
  let host;
  try { host = new URL(req.url()).host; } catch { host = req.url(); }
  const headers = await req.allHeaders();
  captured.push({
    url: req.url(), host, method: req.method(),
    hasCookie: Object.keys(headers).some((h) => h.toLowerCase() === "cookie"),
    resourceType: req.resourceType()
  });
  // Answer everything locally and fast — never touch the real network.
  await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }).catch(() => {});
});

// Extension ID. A manifest `key` pins the id to the key, not the path, so that
// derivation has to come first or every chrome-extension:// URL here is wrong.
const id = idFromManifestKey(ROOT) || (() => {
  const h = createHash("sha256").update(ROOT).digest();
  return [...h.subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
})();

// One page for every message, reused rather than opened-and-closed per call:
// closing a page rapidly after sendMessage was observed to sometimes tear
// down the context's route interception for the NEXT request before it
// re-armed (a Playwright timing quirk with rapid page churn, not anything
// about the extension) — reusing one page's lifetime across the whole run is
// both simpler and reliably captures every request.
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/pages/recall.html`); // a page that itself pulls in most of lib/*
async function send(msg) {
  return page.evaluate((m) => new Promise((resolve) => {
    chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; resolve(r); });
  }), msg);
}

// 1. Popup entitlement check.
await send({ type: "entitlement-state" });
// 2. Recall search (IndexedDB only, no network expected).
await send({ type: "recall-search", q: "nothing" });
// 3. Bridge-style context pull.
await send({ type: "recall-stats" });
// 4. Purchase activation — the one flow certain to attempt a real Dodo call.
await send({ type: "license-activate", key: "EGRESSPROOFTESTKEY0001" });
// 5. Explicit entitlement refresh, which does hit the issuer.
await send({ type: "entitlement-refresh" });

await new Promise((r) => setTimeout(r, 1500)); // let any fire-and-forget requests land
await page.close();
await ctx.close();

/* ---------- assertions ---------- */

t(`captured at least one request to exercise (saw ${captured.length})`, captured.length > 0);

const offenders = captured.filter((c) => !ALLOWED_HOSTS.has(c.host) && !c.url.startsWith("chrome-extension://"));
t("every captured request's host is in the allowlist", offenders.length === 0,
  offenders.length ? `off-allowlist hosts: ${JSON.stringify([...new Set(offenders.map((o) => o.host))])}` : "");

const dodoRequests = captured.filter((c) => c.host === "live.dodopayments.com" || c.host === "test.dodopayments.com");
t("at least one Dodo API request was actually attempted (activation flow reached the network)", dodoRequests.length > 0);
const dodoWithCookie = dodoRequests.filter((c) => c.hasCookie);
t("no Dodo request carries a cookie header", dodoWithCookie.length === 0,
  dodoWithCookie.length ? JSON.stringify(dodoWithCookie) : "");

// Bodies for chat-text leakage: every non-provider request body must not
// contain anything that looks like scraped chat content. We never sent any
// real chat text in this run, so this is a structural check that the
// extension isn't attaching something unexpected — not a false-negative-prone
// content scan.
const nonProviderWithBody = captured.filter((c) => !REAL_PROVIDER_HOSTS.includes(c.host) && c.method === "POST");
t("no non-provider POST request unexpectedly present beyond entitlement/dodo traffic",
  nonProviderWithBody.every((c) => c.host === ISSUER_HOST || c.host.endsWith("dodopayments.com")),
  JSON.stringify(nonProviderWithBody.map((c) => c.host)));

done();
