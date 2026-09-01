#!/usr/bin/env node
/**
 * Tvara — prove the DEPLOYED session monitoring routes actually work.
 *
 *   node server/session-smoke.mjs <url> <chrome-extension-origin>
 *
 * server/smoke.mjs proves the issuer is alive and that /trial, /entitlement and
 * /checkout answer. It says nothing about the four routes the device screen is
 * built on, and those are the ones where a mistake is silent: a /sessions that
 * forgot its identity gate answers 200 to anybody, and nothing on the happy
 * path would ever notice.
 *
 * Every check here is adversarial — it asserts a REFUSAL. That is deliberate.
 * A monitoring system is only worth the things it says no to, and each of these
 * is a specific way the seat economy could be taken apart:
 *
 *   1. an unseated device gets an ANSWER (live:false), never an error, so the
 *      client can tell "signed out" from "issuer down" — the whole fail-open
 *      contract rests on that distinction
 *   2. …and the reason is one the popup already knows how to print
 *   3. /sessions without an identity token is 401 — the list is a sentence
 *      about a person, and a licence key is not an account
 *   4. terminating one device needs that identity too
 *   5. so does terminate-all, the one irreversible button
 *   6. a signature built for /sessions cannot be presented at
 *      /sessions/terminate — the route is inside the signed input
 *   7. swapping the target list after signing is refused — which devices get
 *      signed out is not a field anything between here and the popup may edit
 *   8. a stranger's extension origin is refused
 *
 * It needs no licence and no identity: it only ever asks the issuer to say no,
 * and a fresh keypair is enough to be told. Safe against production.
 *
 * WHAT IT CANNOT SEE, stated plainly so nobody reads 8/8 as more than it is:
 * holding no seat, this probe can only confirm live:false is reachable. A worker
 * regression that answered live:false to EVERYONE — a seat lookup that always
 * misses — passes every check here, and would sign every paying customer out,
 * because the client drops its 30-day token on that answer. Proving the YES
 * needs a real seated device, which is test/verify-live.mjs's job.
 */
// Trailing slash trimmed, as smoke.mjs does: deploy.sh now feeds both scripts
// the same $URL, and "https://host/" + "/session" is a 404 that reads like a
// broken route.
const URL_BASE = (process.argv[2] || "").replace(/\/+$/, "");
const ORIGIN = process.argv[3] || "";
if (!URL_BASE || !ORIGIN) {
  console.error("usage: node server/session-smoke.mjs <url> <chrome-extension-origin>");
  process.exit(2);
}
const US = String.fromCharCode(31), PROTOCOL = 3;
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const pair = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"}, true, ["sign","verify"]);
const pubB64 = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b=>b.toString(16).padStart(2,"0")).join("");

async function build(signRoute, fields = [], extra = {}) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16))), ts = Date.now();
  const input = ["LCT3", signRoute, ...fields, pubB64, nonce, String(ts)].join(US);
  const sig = await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"}, pair.privateKey, new TextEncoder().encode(input));
  return JSON.stringify({ v: PROTOCOL, device_pub: pubB64, nonce, ts, sig: b64url(sig), ...extra });
}
async function post(route, payload, origin = ORIGIN) {
  try {
    const r = await fetch(URL_BASE + route, { method:"POST",
      headers:{"Content-Type":"application/json", Origin:origin}, body:payload, signal:AbortSignal.timeout(20000) });
    return { status: r.status, body: (await r.text()).slice(0,220) };
  } catch (e) { return { status: 0, body: "no answer "+e.message }; }
}
let pass=0, fail=0;
const t = (name, ok, got) => { console.log(`   ${ok?"✓":"✗"} ${name.padEnd(52)} ${got}`); ok?pass++:fail++; };

const KEY = "smoke-" + hex(8);
console.log(`→ session monitoring probe against ${URL_BASE}\n`);

// 1. /session for a device holding no seat: an ANSWER, not an error.
let r = await post("/session", await build("session", [KEY], { license_key: KEY }));
let j = (()=>{try{return JSON.parse(r.body)}catch{return{}}})();
t("/session unseated device -> live:false", r.status===200 && j.live===false, `${r.status} ${r.body}`);

// 2. The reason is one the popup can print.
t("/session reason is printable", ["terminated","signed-out","revoked"].includes(j.reason), JSON.stringify(j.reason));

// 3. /sessions with no identity token must refuse — the account gate.
r = await post("/sessions", await build("sessions", []));
t("/sessions without identity -> 401 unverified", r.status===401 && /unverified/.test(r.body), `${r.status} ${r.body}`);

// 4. terminate without identity must refuse.
const op = hex(16), tgt = hex(16);
r = await post("/sessions/terminate", await build("sessions-terminate", [op, tgt], { op_id: op, targets: [tgt] }));
t("/sessions/terminate without identity -> 401 unverified", r.status===401 && /unverified/.test(r.body), `${r.status} ${r.body}`);

// 5. terminate-all without identity must refuse (the irreversible one).
const op2 = hex(16);
r = await post("/sessions/terminate-all", await build("sessions-terminate-all", [op2], { op_id: op2 }));
t("/sessions/terminate-all without identity -> 401 unverified", r.status===401 && /unverified/.test(r.body), `${r.status} ${r.body}`);

// 6. A signature for one route must not be presentable at another.
const crossOp = hex(16);
r = await post("/sessions/terminate", await build("sessions", [], { op_id: crossOp, targets: [tgt] }));
t("cross-route signature replay refused", r.status===401 && /device proof/.test(r.body), `${r.status} ${r.body}`);

// 7. A tampered target after signing must be refused.
const op3 = hex(16), realT = hex(16), swapped = hex(16);
let body = JSON.parse(await build("sessions-terminate", [op3, realT], { op_id: op3, targets: [realT] }));
body.targets = [swapped];
r = await post("/sessions/terminate", JSON.stringify(body));
// Must be the PROOF that refuses, not the identity gate behind it: a bare
// status check passes even if targets were dropped from the signed input, which
// is the one regression this check exists to catch.
t("target swapped after signing refused by proof", r.status===401 && /device proof/.test(r.body), `${r.status} ${r.body}`);

// 8. A stranger's extension origin is refused on a session route.
r = await post("/session", await build("session", [KEY], { license_key: KEY }), "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
t("stranger origin refused on /session", r.status===403, `${r.status} ${r.body}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
