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
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(homedir(), ".lct-keys");
const PRIV_PATH = join(KEYS_DIR, "private.pem");
const PUB_PATH = join(KEYS_DIR, "public.b64");
const LICENSE_JS = join(HERE, "..", "lib", "license.js");

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

  // Patch the public key into lib/license.js
  let src = readFileSync(LICENSE_JS, "utf8");
  src = src.replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${spkiB64}";`);
  writeFileSync(LICENSE_JS, src);

  console.log("✅ Keypair created. Public key patched into lib/license.js.");
  console.log(`🔒 Private key: ${PRIV_PATH} — outside the repo. BACK IT UP somewhere safe.`);
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
  const payload = Buffer.from(JSON.stringify({ e: email, p: "pro", t: Date.now() }));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  const key = `LCT1.${b64url(payload)}.${b64url(sig)}`;
  console.log("\n💎 Pro license for " + email + ":\n");
  console.log(key + "\n");
}

const [, , cmd, arg] = process.argv;
if (cmd === "init") init();
else if (cmd === "issue") issue(arg);
else console.log("Usage:\n  node tools/genkey.mjs init\n  node tools/genkey.mjs issue customer@email.com");
