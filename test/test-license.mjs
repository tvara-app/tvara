#!/usr/bin/env node
/* License crypto unit tests — runs lib/license.js in Node with a `self` shim.
   Node 18+ exposes WebCrypto as globalThis.crypto, same API the browser uses. */
import { readFileSync, existsSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(homedir(), "long-chat-toolkit");
const PRIV = join(homedir(), ".lct-keys", "private.pem");
if (!existsSync(PRIV)) { console.error("FATAL: no private key at ~/.lct-keys"); process.exit(1); }

// Load lib/license.js exactly as shipped
const sandbox = { self: {}, crypto: globalThis.crypto, atob: globalThis.atob, TextDecoder, JSON, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "lib", "license.js"), "utf8"), sandbox);
const { verify } = sandbox.self.LCTLicense;

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const priv = createPrivateKey(readFileSync(PRIV));
const issue = (payloadObj) => {
  const payload = Buffer.from(JSON.stringify(payloadObj));
  const sig = sign("sha256", payload, { key: priv, dsaEncoding: "ieee-p1363" });
  return `LCT1.${b64url(payload)}.${b64url(sig)}`;
};

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

const good = issue({ e: "buyer@example.com", p: "pro", t: 1753100000000 });

// 1. Valid key verifies, carries email + plan
let r = await verify(good);
t("valid key accepted", r.valid === true && r.email === "buyer@example.com" && r.plan === "pro");

// 2. Tampered payload (email swapped after signing) must fail on signature
{
  const parts = good.split(".");
  const forged = b64url(Buffer.from(JSON.stringify({ e: "thief@example.com", p: "pro", t: 1753100000000 })));
  r = await verify(`LCT1.${forged}.${parts[2]}`);
  t("tampered payload rejected (signature)", r.valid === false && r.reason === "signature");
}

// 3. Tampered signature must fail
{
  const parts = good.split(".");
  const badSig = parts[2].slice(0, -4) + (parts[2].endsWith("AAAA") ? "BBBB" : "AAAA");
  r = await verify(`LCT1.${parts[1]}.${badSig}`);
  t("tampered signature rejected", r.valid === false);
}

// 4. Correctly signed key for a NON-pro plan must be rejected on plan
r = await verify(issue({ e: "buyer@example.com", p: "free", t: 1753100000000 }));
t("signed non-pro plan rejected", r.valid === false && r.reason === "plan");

// 5. Wrong prefix
r = await verify("LCT9." + good.split(".").slice(1).join("."));
t("wrong prefix rejected (format)", r.valid === false && r.reason === "format");

// 6. Garbage inputs never throw
for (const junk of ["", null, undefined, "hello", "LCT1.a.b", "LCT1..", "LCT1.%%%.%%%", 42]) {
  r = await verify(junk);
  if (r.valid !== false) { t(`garbage "${String(junk)}" rejected`, false); }
}
t("all garbage inputs rejected without throwing", true);

// 7. Whitespace-padded valid key still accepted (users paste with spaces)
r = await verify("  " + good + "  ");
t("whitespace-padded key accepted", r.valid === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
