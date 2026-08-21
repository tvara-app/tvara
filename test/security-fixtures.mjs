/* Shared setup for the Layer-3 security suite.
   Mirrors the repo into a scratch copy and patches lib/license.js +
   lib/entitlement.js to trust a freshly-minted throwaway keypair — the same
   substitution test-extension.mjs uses for its own PUBLIC_KEY_B64 patch, so
   tokens minted here verify against the mirror without ever touching the
   real production private key (which is deliberately not on any dev machine). */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const ROOT = join(import.meta.dirname, "..");
export const SCRATCH = join(ROOT, "test", ".work-security");

export const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const sha16Hex = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 32);

/** PASS/FAIL helper matching the rest of the suite's hand-rolled style. */
export function reporter() {
  let pass = 0, fail = 0;
  const failed = [];
  const t = (name, cond, extra = "") => {
    const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
    cond ? pass++ : (fail++, failed.push(line));
    console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
  };
  const done = () => {
    if (failed.length) {
      console.log(`\n${fail} failing:`);
      for (const line of failed) console.log(`  FAIL  ${line}`);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  };
  return { t, done };
}

/**
 * Mirror the repo and swap in a test-trusted keypair, matching
 * test-extension.mjs's approach exactly. `name` picks the scratch subdir so
 * multiple mirrors (one per test file) don't collide when run in parallel.
 */
export function mirrorExtension(name) {
  const EXT = join(SCRATCH, name);
  rmSync(EXT, { recursive: true, force: true });
  mkdirSync(EXT, { recursive: true });
  const sync = spawnSync("rsync", [
    "-a", "--exclude", ".git", "--exclude", "node_modules", "--exclude", "test/.work*", "--exclude", "dist",
    ROOT + "/", EXT + "/"
  ]);
  if (sync.status !== 0) throw new Error("could not mirror the extension for " + name);

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const TEST_PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const TEST_ISSUER = "https://entitlement.test.invalid";
  const testKeyIntegrity = [...createHash("sha256").update(TEST_PUB).digest().subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const licPath = join(EXT, "lib", "license.js");
  const licPatched = readFileSync(licPath, "utf8")
    .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`);
  if (!licPatched.includes(TEST_PUB)) throw new Error("PUBLIC_KEY_B64 not found in lib/license.js");
  writeFileSync(licPath, licPatched);

  const entPath = join(EXT, "lib", "entitlement.js");
  const entPatched = readFileSync(entPath, "utf8")
    .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${TEST_PUB}";`)
    .replace(/const ISSUER = "[^"]*";/, `const ISSUER = "${TEST_ISSUER}";`)
    .replace(/const _KEY_INTEGRITY = "[^"]*";/, `const _KEY_INTEGRITY = "${testKeyIntegrity}";`);
  if (!entPatched.includes(TEST_PUB) || !entPatched.includes(TEST_ISSUER)) {
    throw new Error("could not patch lib/entitlement.js for tests");
  }
  writeFileSync(entPath, entPatched);

  return { EXT, priv: privateKey, pub: publicKey, TEST_PUB, TEST_ISSUER, testKeyIntegrity };
}

/**
 * A mirror whose entitlement.js keeps the REAL, original _KEY_INTEGRITY
 * value while PUBLIC_KEY_B64 is swapped to the test key — so a test can prove
 * the integrity guard fires on a genuine mismatch, instead of checking the
 * guard against a value it patched to match.
 */
export function mirrorExtensionWithMismatchedIntegrity(name) {
  const built = mirrorExtension(name);
  const original = readFileSync(join(ROOT, "lib", "entitlement.js"), "utf8");
  const originalIntegrity = original.match(/const _KEY_INTEGRITY = "([^"]*)";/)[1];
  const entPath = join(built.EXT, "lib", "entitlement.js");
  const reverted = readFileSync(entPath, "utf8")
    .replace(/const _KEY_INTEGRITY = "[^"]*";/, `const _KEY_INTEGRITY = "${originalIntegrity}";`);
  writeFileSync(entPath, reverted);
  return built;
}

/** LCT1.<payload>.<sig> — same shape and signing path as tools/genkey.mjs. */
export function mintLct1Key(priv, claims = {}) {
  const payload = Buffer.from(JSON.stringify({ e: "test@example.com", p: "pro", t: Date.now(), ...claims }));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  return `LCT1.${b64url(payload)}.${b64url(sig)}`;
}

/**
 * LCT2.<payload>.<sig> — matches lib/entitlement.js's verifyToken()/evaluate()
 * shape: v:2, plan:"pro", sub=sha256(licenseKey)[:16B], dev=sha256(deviceId)[:16B].
 * `corrupt` lets a caller hand back a deliberately-broken token (bad segment
 * count, garbage base64, flipped signature byte, wrong version) for the
 * "must fail closed" side of the entitlement-gate test.
 */
export function mintLct2Token(priv, { licenseKey, deviceId, ks = "", exp, iat, feat, email = "" } = {}) {
  const now = iat ?? Date.now();
  const payload = Buffer.from(JSON.stringify({
    v: 2, plan: "pro",
    sub: sha16Hex(licenseKey), dev: sha16Hex(deviceId),
    iat: now, exp: exp ?? now + 90 * 864e5,
    ...(ks ? { ks } : {}), ...(feat ? { feat } : {}), ...(email ? { email } : {})
  }));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  return `LCT2.${b64url(payload)}.${b64url(sig)}`;
}

/** Flip one bit in the signature segment of an otherwise well-formed token —
 *  a tampered-but-plausible-looking forgery, not just garbage. */
export function flipSignatureByte(token) {
  const parts = token.split(".");
  const bytes = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  bytes[0] ^= 0xff;
  parts[2] = b64url(bytes);
  return parts.join(".");
}

export function cleanupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
}

/* ---------- launching + talking to the mirrored extension ---------- */

function computedExtensionId(EXT) {
  // Unpacked extension ID = sha256(absolute path) first 16 bytes, nibbles
  // mapped a..p — same derivation Chrome itself uses.
  return [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join("");
}

/** Authoritative fallback: read the ID Chrome actually registered. */
function idFromProfile(profileDir, EXT) {
  for (const f of ["Preferences", "Secure Preferences"]) {
    try {
      const prefs = JSON.parse(readFileSync(join(profileDir, "Default", f), "utf8"));
      for (const [id, v] of Object.entries(prefs.extensions?.settings || {})) {
        if (v.path === EXT) return id;
      }
    } catch { /* not written yet, or this profile has no such file */ }
  }
  return null;
}

/** Launch a mirrored extension in an isolated persistent profile. */
export async function launchExtension(EXT, profileDir, opts = {}) {
  const { chromium } = await import("playwright");
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 900, height: 800 },
    ...opts
  });
  await new Promise((r) => setTimeout(r, 1500)); // let Chrome register the extension
  const id = idFromProfile(profileDir, EXT) || computedExtensionId(EXT);
  return { ctx, id };
}

/** Send a runtime message the way an extension page would, and return the
 *  response. Any page under chrome-extension://<id>/ passes _senderAllowed's
 *  own-origin check, so this also naturally wakes a suspended MV3 service
 *  worker — no separate wake step needed before each assertion. */
export async function sendFromExtensionPage(ctx, extId, msg, path = "popup/popup.html") {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/${path}`);
  const res = await page.evaluate((m) => new Promise((resolve) => {
    chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; resolve(r); });
  }), msg);
  await page.close();
  return res;
}

/** Write directly into chrome.storage.local/sync from Node, via any
 *  extension-context page (storage isn't reachable from outside the browser). */
export async function setStorage(ctx, extId, area, obj) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup/popup.html`);
  await page.evaluate(([a, o]) => chrome.storage[a].set(o), [area, obj]);
  await page.close();
}
