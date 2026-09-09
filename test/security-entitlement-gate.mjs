#!/usr/bin/env node
/* The centerpiece of the security suite: bg.js's PAID-feature gate.
   requireEntitlement() re-verifies a full ECDSA-P256 signature on every
   single privileged call — deliberately not a cached boolean, per its own
   comment at bg.js ~4845 ("a cached pro flag in storage is exactly the thing
   a hand-edited record forges"). The message router captures it as `_gate`
   in a closure BEFORE registering the onMessage listener, specifically so
   reassigning the global `requireEntitlement` from the service worker's own
   DevTools console changes nothing.

   Four things must all hold:
     A. a genuinely valid, correctly-bound LCT2 token unlocks a gated action
        (positive control — proves the harness can produce something bg.js
        actually accepts, so a "still locked" result elsewhere in this file
        means something, not just "the harness is broken")
     B. nothing short of that — a hand-forged token, no token, a tampered
        signature, or a token signed by a foreign key — ever unlocks one
     C. reassigning the GLOBAL requireEntitlement from the worker's own
        console has no effect, because the router calls through the
        closure-captured _gate
     D. patching PUBLIC_KEY_B64 without correspondingly updating
        _KEY_INTEGRITY is rejected outright (the guard exists for exactly
        this: a key swap that isn't also a matching integrity-hash swap)

   MV3 service workers suspend after ~30s idle; every check below goes
   through an actual chrome.runtime.sendMessage round trip from an extension
   page, which both exercises the real router and wakes a suspended worker —
   no separate wake step needed, and every assertion reads the RESPONSE
   PAYLOAD, never live worker state (Playwright keeps a stale Worker
   reference across a suspend/wake cycle, so introspecting it directly would
   be testing the wrong thing). */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  SCRATCH, reporter, mirrorExtension, mirrorExtensionWithMismatchedIntegrity,
  mintLct2Token, flipSignatureByte, b64url, sha16Hex, deviceFingerprint,
  launchExtension, sendFromExtensionPage, setStorage
} from "./security-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..");
const { t, done } = reporter();
const DEVICE_ID = "test-device-0001-static";
const LICENSE_KEY = "TESTKEY123456789ABCDEF"; // dodo-shaped: alnum, 8-64 chars, matches lib/dodo.js's looksLikeKey

// recall-search → PAID["recall-search"] = "archive.search" (bg.js's PAID map).
const GATED_MSG = { type: "recall-search", q: "hello", long: false };

async function seedLicenseAndDevice(ctx, extId, licenseKey = LICENSE_KEY) {
  await setStorage(ctx, extId, "sync", {
    "lct-device-id-v1": { id: DEVICE_ID, mintedAt: Date.now() }
  });
  await setStorage(ctx, extId, "local", {
    license: { key: licenseKey, kind: "dodo", email: "test@example.com", instanceId: "test-instance-1", activatedAt: Date.now() }
  });
}

/* ============ A. valid token unlocks (positive control) ============ */
{
  const { EXT, priv } = mirrorExtension("gate-valid");
  const { ctx, id } = await launchExtension(EXT, join(SCRATCH, "gate-valid-profile"));
  try {
    await seedLicenseAndDevice(ctx, id);
    const dev = await deviceFingerprint(ctx, id, DEVICE_ID);
    const token = mintLct2Token(priv, { licenseKey: LICENSE_KEY, dev, ks: b64url(Buffer.from("test-archive-stamp-secret")) });
    await setStorage(ctx, id, "local", { "lct-entitlement-v2": { token, fetchedAt: Date.now() } });

    const res = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("A: a valid, correctly-bound LCT2 token unlocks a PAID-gated action",
      !!res && res.err !== "locked", `response: ${JSON.stringify(res)}`);
  } finally { await ctx.close(); }
}

/* ============ B. nothing short of a valid token unlocks anything ============ */
{
  const { EXT, priv } = mirrorExtension("gate-forged");
  const { ctx, id } = await launchExtension(EXT, join(SCRATCH, "gate-forged-profile"));
  try {
    await seedLicenseAndDevice(ctx, id);

    // B1: no entitlement token at all — just the license record.
    const res1 = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("B1: a license record with no entitlement token stays locked",
      !!res1 && res1.err === "locked", `response: ${JSON.stringify(res1)}`);

    // B2: a validly-shaped, validly-signed token — then one signature bit flipped.
    const devB = await deviceFingerprint(ctx, id, DEVICE_ID);
    const valid = mintLct2Token(priv, { licenseKey: LICENSE_KEY, dev: devB });
    const tampered = flipSignatureByte(valid);
    await setStorage(ctx, id, "local", { "lct-entitlement-v2": { token: tampered, fetchedAt: Date.now() } });
    const res2 = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("B2: a tampered signature (one flipped bit, otherwise well-formed) stays locked",
      !!res2 && res2.err === "locked", `response: ${JSON.stringify(res2)}`);

    // B3: a token signed by a completely foreign, unrelated keypair.
    const foreign = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const foreignPayload = Buffer.from(JSON.stringify({
      v: 2, plan: "pro", sub: sha16Hex(LICENSE_KEY), dev: devB,
      iat: Date.now(), exp: Date.now() + 90 * 864e5
    }));
    const foreignSig = sign("sha256", foreignPayload, { key: foreign.privateKey, dsaEncoding: "ieee-p1363" });
    const foreignToken = `LCT2.${b64url(foreignPayload)}.${b64url(foreignSig)}`;
    await setStorage(ctx, id, "local", { "lct-entitlement-v2": { token: foreignToken, fetchedAt: Date.now() } });
    const res3 = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("B3: a token signed by a foreign, unrelated key stays locked",
      !!res3 && res3.err === "locked", `response: ${JSON.stringify(res3)}`);

    // B4: a valid token bound to a DIFFERENT device — replayed on this one.
    const otherDeviceToken = mintLct2Token(priv, { licenseKey: LICENSE_KEY, deviceId: "someone-elses-device-id" });
    await setStorage(ctx, id, "local", { "lct-entitlement-v2": { token: otherDeviceToken, fetchedAt: Date.now() } });
    const res4 = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("B4: another device's valid token, replayed here, stays locked (device binding holds)",
      !!res4 && res4.err === "locked", `response: ${JSON.stringify(res4)}`);

    // B5: a valid token bound to a DIFFERENT license key than the one stored.
    const otherKeyToken = mintLct2Token(priv, { licenseKey: "SOME-OTHER-LICENSE-KEY-999", deviceId: DEVICE_ID });
    await setStorage(ctx, id, "local", { "lct-entitlement-v2": { token: otherKeyToken, fetchedAt: Date.now() } });
    const res5 = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("B5: a valid token minted for a different licence key stays locked (key binding holds)",
      !!res5 && res5.err === "locked", `response: ${JSON.stringify(res5)}`);
  } finally { await ctx.close(); }
}

/* ============ C. DevTools reassignment of the global is a no-op ============ */
{
  const { EXT } = mirrorExtension("gate-devtools");
  const { ctx, id } = await launchExtension(EXT, join(SCRATCH, "gate-devtools-profile"));
  try {
    // Deliberately NO license/token seeded — this device holds no entitlement.
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");

    const before = await sw.evaluate(() => typeof self.requireEntitlement);
    t("C: sanity check — requireEntitlement is a reachable, reassignable global",
      before === "function", `typeof was ${before}`);

    await sw.evaluate(() => {
      self.requireEntitlement = async () => ({ ok: true, via: "forced-from-devtools" });
    });
    const after = await sw.evaluate(() => self.requireEntitlement.toString().includes("forced-from-devtools"));
    t("C: the global was in fact reassigned (confirms this is a real attempt, not a no-op by accident)", after);

    const res = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("C: reassigning the global requireEntitlement from the worker's own console does not unlock a gated action",
      !!res && res.err === "locked", `response after reassignment: ${JSON.stringify(res)}`);
  } finally { await ctx.close(); }
}

/* ============ D. key swap without a matching integrity-hash update ============ */
{
  const { EXT, priv } = mirrorExtensionWithMismatchedIntegrity("gate-keyintegrity");
  const { ctx, id } = await launchExtension(EXT, join(SCRATCH, "gate-keyintegrity-profile"));
  try {
    await seedLicenseAndDevice(ctx, id);
    // Signed with the key that matches this mirror's PATCHED PUBLIC_KEY_B64 —
    // the signature itself is genuinely valid. Only the integrity guard
    // (comparing sha256(PUBLIC_KEY_B64) against the untouched original
    // _KEY_INTEGRITY) stands between this and a false "entitled".
    const token = mintLct2Token(priv, { licenseKey: LICENSE_KEY, dev: await deviceFingerprint(ctx, id, DEVICE_ID) });
    await setStorage(ctx, id, "local", { "lct-entitlement-v2": { token, fetchedAt: Date.now() } });

    const res = await sendFromExtensionPage(ctx, id, GATED_MSG);
    t("D: a genuinely-valid signature under a swapped key is rejected when _KEY_INTEGRITY wasn't updated to match",
      !!res && res.err === "locked", `response: ${JSON.stringify(res)}`);
  } finally { await ctx.close(); }
}

/* ============ E. the whole map, not one entry of it ============

   Section A proved ONE gated message refuses on a locked install. That is a
   spot check: a feature added to PAID and spelled slightly wrong gates nothing
   and looks exactly like a feature that is gated. So every key in the map is
   asserted against a locked install, and every key is asserted to be a message
   the router actually answers — a PAID entry for a type nothing handles is a
   lock on a door that is not there. */
{
  const { EXT } = mirrorExtension("gate-everykey");
  const { ctx, id } = await launchExtension(EXT, join(SCRATCH, "gate-everykey-profile"));
  try {
    const src = readFileSync(join(ROOT, "bg", "paywall.js"), "utf8");
    const router = readFileSync(join(ROOT, "bg.js"), "utf8");
    const paid = [...src.matchAll(/^\s*"([a-z-]+)":\s*"archive\./gm)].map((m) => m[1]);
    t("E: the PAID map was read, and it is not empty", paid.length >= 10, `${paid.length} entries`);

    const handled = new Set([...router.matchAll(/case "([a-z-]+)"/g)].map((m) => m[1]));
    const orphans = paid.filter((k) => !handled.has(k));
    t("E: every gated feature is a message the router answers",
      orphans.length === 0, `unhandled: ${orphans.join(", ")}`);

    /* Nothing is seeded: no licence, no trial. This is the address typed into
       the bar by somebody who has not paid. */
    const leaked = [];
    for (const type of paid) {
      const res = await sendFromExtensionPage(ctx, id, { type, q: "x", long: false,
        host: "chatgpt.com", path: "/c/x" }, "pages/recall.html");
      if (!(res && res.err === "locked")) leaked.push(`${type} → ${JSON.stringify(res)}`);
    }
    t("E: every gated feature refuses a locked install, asked from the Recall page",
      leaked.length === 0, leaked.join(" | ").slice(0, 300));
  } finally { await ctx.close(); }
}

/* ============ F. reach a provider tab must not have ============

   The sender allowlist admits six provider origins so our content script can
   reach the worker. Page script in those tabs cannot — an isolated world has
   no chrome.runtime — so this is depth rather than a patched hole: a bug in
   our own content script must not be able to read another provider's records
   or the archive as a whole, and a handler added later must not inherit six
   origins of reach because nobody thought about it.

   Asserted structurally, because the sender cannot be forged from a test: the
   two sets must name real router cases, and every archive-wide handler must be
   in PAGE_ONLY. That last one is what fails when somebody adds the next
   `recall-dump`. */
{
  const router = readFileSync(join(ROOT, "bg.js"), "utf8");
  const setOf = (name) => {
    const m = new RegExp(`const ${name} = Object.freeze\\(new Set\\(\\[([^\\]]*)\\]`).exec(router);
    return m ? [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]) : [];
  };
  const pageOnly = setOf("PAGE_ONLY");
  const ownHost = setOf("OWN_HOST_ONLY");
  const handled = new Set([...router.matchAll(/case "([a-z-]+)"/g)].map((m) => m[1]));

  t("F: PAGE_ONLY was read, and it is not empty", pageOnly.length >= 10, `${pageOnly.length} entries`);
  t("F: OWN_HOST_ONLY was read, and it is not empty", ownHost.length >= 4, `${ownHost.length} entries`);
  t("F: every restricted type is a message the router answers",
    [...pageOnly, ...ownHost].every((k) => handled.has(k)),
    [...pageOnly, ...ownHost].filter((k) => !handled.has(k)).join(", "));

  /* The archive as a whole: export it, wipe it, sign it, count it, back it up,
     restore it. None of these is ever sent by a content script — grep content/
     — and each one either hands back every chat or changes every chat. */
  const ARCHIVE_WIDE = ["recall-export", "recall-snapshot", "recall-wipe", "recall-stats",
    "chat-message", "archive-stamp", "recall-backup-mark", "recall-restore-ledger",
    "recall-autobackup-run", "chat-drop"];
  const missing = ARCHIVE_WIDE.filter((k) => !pageOnly.includes(k));
  t("F: every archive-wide handler is reachable only from our own pages",
    missing.length === 0, `not in PAGE_ONLY: ${missing.join(", ")}`);

  /* Per-chat reads are scoped to the asking tab's own host. chat-mount does it
     inline — it is the one that was written first and the reason the rest are
     here — so it is allowed to be absent from the set. */
  const PER_CHAT = ["chat-archive", "chat-search", "chat-stats", "chat-index"];
  const unscoped = PER_CHAT.filter((k) => !ownHost.includes(k));
  t("F: every per-chat read is scoped to the tab's own host",
    unscoped.length === 0, `not in OWN_HOST_ONLY: ${unscoped.join(", ")}`);
  t("F: chat-mount still carries its own host check",
    /case "chat-mount"[\s\S]{0,1400}fromHost !== wantHost/.test(router));
}

done();
