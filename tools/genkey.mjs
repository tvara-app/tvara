#!/usr/bin/env node
/**
 * Long Chat Toolkit — license key issuer (runs on YOUR machine only).
 *
 *   node tools/genkey.mjs init            # one-time: create keypair, patch lib/license.js
 *   node tools/genkey.mjs issue a@b.com   # issue a Pro key for a customer
 *
 * The private key lives OUTSIDE the extension folder (~/.lct-keys/): Chrome
 * scans any directory loaded unpacked and complains about bundled .pem files,
 * and a signing key has no business inside a folder the browser ingests.
 * NEVER commit or share it.
 * Key format: LCT1.<b64url(payload)>.<b64url(ECDSA-P256-SHA256 signature, P1363)>
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(homedir(), ".lct-keys");
const PRIV_PATH = join(KEYS_DIR, "private.pem");
const PUB_PATH = join(KEYS_DIR, "public.b64");
const LICENSE_JS = join(HERE, "..", "lib", "license.js");
const ENTITLEMENT_JS = join(HERE, "..", "lib", "entitlement.js");

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function init() {
  if (existsSync(PRIV_PATH)) {
    console.error(`Keypair already exists at ${KEYS_DIR} — refusing to overwrite.`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(PRIV_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

  const spkiB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  writeFileSync(PUB_PATH, spkiB64);

  // Same pair verifies LCT1 keys and LCT2 entitlement tokens — patch both.
  for (const path of [LICENSE_JS, ENTITLEMENT_JS]) {
    const src = readFileSync(path, "utf8")
      .replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${spkiB64}";`);
    writeFileSync(path, src);
  }

  console.log("✅ Keypair created. Public key patched into lib/license.js + lib/entitlement.js.");
  console.log(`🔒 Private key: ${PRIV_PATH} — outside the repo. BACK IT UP somewhere safe.`);
}

/**
 * Refuse to sign with a key the extension doesn't trust. Without this the
 * failure is invisible from here: issue() happily signs with whatever sits in
 * ~/.lct-keys, and the customer is the one who finds out. It has happened —
 * see commit 45b71da.
 */
function assertKeyPairMatchesShipped(priv) {
  const local = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  let shipped = null;

  // Both files must agree, or entitlement tokens verify where licences don't.
  for (const path of [LICENSE_JS, ENTITLEMENT_JS]) {
    const found = readFileSync(path, "utf8").match(/const PUBLIC_KEY_B64 = "([^"]*)";/);
    if (!found) {
      console.error(`Could not find PUBLIC_KEY_B64 in ${path} — refusing to issue.`);
      process.exit(1);
    }
    if (shipped && shipped[1] !== found[1]) {
      console.error("\n✋ lib/license.js and lib/entitlement.js ship different public keys. Re-run init.\n");
      process.exit(1);
    }
    shipped = found;
  }

  if (local === shipped[1]) return;
  console.error(
    `\n✋ Refusing to issue: ${PRIV_PATH} does not match the shipped public key.\n` +
    `   Keys signed with it would fail verification in every installed copy.\n\n` +
    `   ships (lib/license.js): ${shipped[1]}\n` +
    `   local  (private.pem)  : ${local}\n\n` +
    `   Restore the private half of the shipped key from backup. Do NOT patch\n` +
    `   lib/license.js to match this pair — that invalidates every licence\n` +
    `   already sold.\n`
  );
  process.exit(1);
}

function issue(email) {
  if (!email || !email.includes("@")) {
    console.error("Usage: node tools/genkey.mjs issue customer@email.com");
    process.exit(1);
  }
  if (!existsSync(PRIV_PATH)) {
    console.error("No keypair. Run: node tools/genkey.mjs init");
    process.exit(1);
  }
  const priv = createPrivateKey(readFileSync(PRIV_PATH));
  assertKeyPairMatchesShipped(priv);
  const payload = Buffer.from(JSON.stringify({ e: email, p: "pro", t: Date.now() }));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  const key = `LCT1.${b64url(payload)}.${b64url(sig)}`;
  console.log("\n💎 Pro license for " + email + ":\n");
  console.log(key + "\n");
}

/**
 * Print the private key as base64 PKCS8 for the entitlement Worker's
 * SIGNING_KEY secret. Same pair the extension already trusts — the Worker
 * cannot mint tokens with anything else.
 */
function workerKey() {
  if (!existsSync(PRIV_PATH)) {
    console.error("No keypair. Run: node tools/genkey.mjs init");
    process.exit(1);
  }
  const priv = createPrivateKey(readFileSync(PRIV_PATH));
  assertKeyPairMatchesShipped(priv);
  const pkcs8 = priv.export({ type: "pkcs8", format: "der" }).toString("base64");
  console.error("\n🔑 Paste into: wrangler secret put SIGNING_KEY\n");
  console.log(pkcs8);
  console.error("\n⚠️  Signing key. Never commit it, never paste it in a browser.\n");
}

const [, , cmd, arg] = process.argv;
if (cmd === "init") init();
else if (cmd === "issue") issue(arg);
else if (cmd === "worker-key") workerKey();
else console.log("Usage:\n  node tools/genkey.mjs init\n  node tools/genkey.mjs issue customer@email.com\n  node tools/genkey.mjs worker-key");
