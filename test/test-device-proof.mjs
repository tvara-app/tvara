#!/usr/bin/env node
/* Tvara — the device proof, checked against the REAL worker code.
 *
 * lib/entitlement.js builds a signing string and server/entitlement-worker.js
 * rebuilds it. They are two files, in two languages' worth of context, that
 * must agree byte for byte forever — and if they ever stop agreeing, nothing
 * crashes: every activation and every trial simply returns 401 and the
 * extension reports it as a licence problem. That is the worst shape a bug can
 * have, so neither side is copied into this file. Both are loaded from disk.
 */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { reporter } from "./security-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..");
const { t, done } = reporter();

/* ---------- load the client ---------- */

const clientSrc = readFileSync(join(ROOT, "lib", "entitlement.js"), "utf8");
const clientBox = {
  self: undefined, chrome: { storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } } },
  crypto: globalThis.crypto, indexedDB: globalThis.indexedDB,
  IDBKeyRange: globalThis.IDBKeyRange,
  TextEncoder, TextDecoder, btoa, atob, console, URL, AbortSignal,
  fetch: async () => { throw new Error("network disabled"); }
};
clientBox.self = clientBox;
vm.runInContext(clientSrc, vm.createContext(clientBox), { filename: "lib/entitlement.js" });
const client = clientBox.self.LCTEntitlement;
t("client exposes the device-proof surface",
  !!client && typeof client.signRequest === "function" && typeof client.deviceFpFor === "function");

/* ---------- load the worker ---------- */

/* `export default` cannot run in a vm script, and rewriting it is the only
   edit made to the file — the helpers under test are the shipped ones. */
const workerSrc = readFileSync(join(ROOT, "server", "entitlement-worker.js"), "utf8")
  .replace("export default {", "globalThis.__handler = {")
  + "\n;globalThis.__probe = { verifyDeviceProof, signingInput, sha256Hex, PROTOCOL };\n";
const workerBox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, console, URL, AbortSignal, fetch: async () => { throw new Error("no upstream"); } };
workerBox.globalThis = workerBox;
vm.runInContext(workerSrc, vm.createContext(workerBox), { filename: "server/entitlement-worker.js" });
const worker = workerBox.__probe;
t("worker exposes its verifier", !!worker && typeof worker.verifyDeviceProof === "function");

t("both sides agree on the protocol version", client.PROTOCOL === worker.PROTOCOL);

/* ---------- the seam ---------- */

const KEY = "DODO-TEST-KEY-0001";

const proof = await client.signRequest("entitlement", [KEY]);
t("client produced a signed request",
  !!proof && typeof proof.sig === "string" && typeof proof.device_pub === "string" && !!proof.nonce);

// Rebuilt exactly as the handler rebuilds it.
const input = worker.signingInput("entitlement", [KEY, proof.device_pub, proof.nonce, String(proof.ts)]);
t("the worker accepts the client's signature",
  !!(await worker.verifyDeviceProof(proof.device_pub, proof.sig, input)));

/* ---------- and rejects everything else ---------- */

const tampered = worker.signingInput("entitlement", ["DODO-SOMEONE-ELSES-KEY", proof.device_pub, proof.nonce, String(proof.ts)]);
t("a swapped licence key breaks the proof",
  (await worker.verifyDeviceProof(proof.device_pub, proof.sig, tampered)) === null);

const reNonce = worker.signingInput("entitlement", [KEY, proof.device_pub, "AAAAAAAAAAAAAAAAAAAAAA", String(proof.ts)]);
t("a swapped nonce breaks the proof",
  (await worker.verifyDeviceProof(proof.device_pub, proof.sig, reNonce)) === null);

const reTime = worker.signingInput("entitlement", [KEY, proof.device_pub, proof.nonce, String(proof.ts + 1)]);
t("a swapped timestamp breaks the proof",
  (await worker.verifyDeviceProof(proof.device_pub, proof.sig, reTime)) === null);

/* A trial proof presented at /entitlement. The route is inside the signed
   string precisely so this cannot work. */
const trialProof = await client.signRequest("trial", []);
const asEntitlement = worker.signingInput("entitlement", [KEY, trialProof.device_pub, trialProof.nonce, String(trialProof.ts)]);
t("a /trial proof cannot be replayed at /entitlement",
  (await worker.verifyDeviceProof(trialProof.device_pub, trialProof.sig, asEntitlement)) === null);

const trialInput = worker.signingInput("trial", [trialProof.device_pub, trialProof.nonce, String(trialProof.ts)]);
t("...but is accepted at /trial", !!(await worker.verifyDeviceProof(trialProof.device_pub, trialProof.sig, trialInput)));

/* ---------- the device-management routes ----------
   Same seam, two more places to get it wrong. /devices/revoke signs the TARGET
   as well, so a captured "show me my devices" request cannot be edited into
   "kick that device off". */

const listProof = await client.signRequest("devices", [KEY]);
const listInput = worker.signingInput("devices", [KEY, listProof.device_pub, listProof.nonce, String(listProof.ts)]);
t("/devices proof verifies", !!(await worker.verifyDeviceProof(listProof.device_pub, listProof.sig, listInput)));

const TARGET = "a".repeat(32);
const revProof = await client.signRequest("devices-revoke", [KEY, TARGET]);
const revInput = worker.signingInput("devices-revoke", [KEY, TARGET, revProof.device_pub, revProof.nonce, String(revProof.ts)]);
t("/devices/revoke proof verifies", !!(await worker.verifyDeviceProof(revProof.device_pub, revProof.sig, revInput)));

const otherTarget = worker.signingInput("devices-revoke", [KEY, "b".repeat(32), revProof.device_pub, revProof.nonce, String(revProof.ts)]);
t("the revoke target cannot be swapped after signing",
  (await worker.verifyDeviceProof(revProof.device_pub, revProof.sig, otherTarget)) === null);

const listAsRevoke = worker.signingInput("devices-revoke", [KEY, TARGET, listProof.device_pub, listProof.nonce, String(listProof.ts)]);
t("a /devices proof cannot be upgraded into a revoke",
  (await worker.verifyDeviceProof(listProof.device_pub, listProof.sig, listAsRevoke)) === null);

/* Every route the worker will accept must have a signing recipe, or a request
   to it throws on a missing map entry instead of being refused. */
const workerRoutes = (readFileSync(join(ROOT, "server", "entitlement-worker.js"), "utf8")
  .match(/const ROUTES = \[([^\]]+)\]/) || [])[1] || "";
const declared = workerRoutes.split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean);
const recipes = (readFileSync(join(ROOT, "server", "entitlement-worker.js"), "utf8")
  .match(/const SIGN_FIELDS = \{([\s\S]*?)\n {4}\};/) || [])[1] || "";
t("every accepted route has a signing recipe",
  declared.length > 0 && declared.every((r) => recipes.includes(`"${r}"`)));

/* ---------- identity ---------- */

t("both sides derive the same device fingerprint",
  (await client.deviceFpFor("ignored")) === (await worker.sha256Hex(proof.device_pub, 16)));

t("the device key is stable across calls",
  (await client.signRequest("trial", [])).device_pub === proof.device_pub);

t("every request carries a fresh nonce",
  (await client.signRequest("trial", [])).nonce !== trialProof.nonce);

/* The whole point of the design: the private key must not be exportable, or
   a seat is a file someone can email. */
const dk = await client.deviceKey();
t("the device private key is non-extractable", dk && dk.priv.extractable === false);
let exported = null;
try { exported = await globalThis.crypto.subtle.exportKey("pkcs8", dk.priv); } catch { /* expected */ }
t("exporting the device private key is refused by WebCrypto", exported === null);

/* A forged public key with a real signature from a different key: the pairing
   is what is checked, not either half alone. */
const other = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const otherPub = Buffer.from(await globalThis.crypto.subtle.exportKey("spki", other.publicKey))
  .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
t("someone else's public key does not validate our signature",
  (await worker.verifyDeviceProof(otherPub, proof.sig, input)) === null);

t("a malformed public key is refused without throwing",
  (await worker.verifyDeviceProof("not-a-key", proof.sig, input)) === null);
t("a malformed signature is refused without throwing",
  (await worker.verifyDeviceProof(proof.device_pub, "@@@@", input)) === null);

done();
