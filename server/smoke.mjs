#!/usr/bin/env node
/**
 * Tvara — prove a deployed issuer actually works, the way the extension does.
 *
 *   node server/smoke.mjs <url> <chrome-extension-origin>
 *
 * Called by deploy.sh as its final step. Exits non-zero if any check fails.
 *
 * WHY THIS IS NOT SHELL. The issuer is on protocol 3, and every route now
 * requires a live ECDSA P-256 signature over the route, the licence key, the
 * device public key, a nonce and a timestamp. curl cannot produce one. The old
 * in-script curl smoke test sent a protocol-2 body, so a perfectly healthy
 * deploy answered 426 "outdated client" to all three probes and deploy.sh
 * reported ❌. A verification step that fails on a good deploy is worse than
 * none: it trains you to ignore it, and then it cannot warn you.
 *
 * This mirrors lib/entitlement.js signRequest() exactly. If the two ever drift,
 * this file starts failing — which is the point, because so would the shipped
 * extension.
 *
 * WHAT EACH CHECK ISOLATES. Every one of them can only be produced by a worker
 * that got further than the previous one, so the first ✗ names the broken link:
 *
 *   1. our origin, /trial       200  origin accepted and the device proof
 *                                    verified. This script carries no identity
 *                                    token, so the answer is {unverified:true}
 *                                    and NOTHING is written — see check 1's
 *                                    note under COST.
 *   2. stranger origin          403  ALLOWED_ORIGINS is actually in force
 *   3. /entitlement, junk key   404  DODO_API_KEY authenticated and Dodo gave a
 *                                    real verdict. A missing or wrong key is
 *                                    503 "upstream" — dodoValidate() refuses to
 *                                    sign anything without a working key.
 *   4. replayed nonce           409  the nonce ledger (D1) is live. Without a
 *                                    DB this degrades open and answers 200,
 *                                    which is the binding deploy.sh must catch.
 *   5. protocol-2 body          426  the version gate holds, so an old client
 *                                    is told to update rather than let through
 *                                    with no device proof.
 *
 * COST. None in the ledgers. The trial is keyed on a verified identity now, and
 * this script has none, so check 1 exercises origin, proof and version and then
 * gets an answer that writes nothing. Only the nonce rows (check 4) are left
 * behind, and those expire on their own.
 */

const URL_BASE = (process.argv[2] || "").replace(/\/+$/, "");
const ORIGIN = process.argv[3] || "";
const STRANGER = "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

if (!URL_BASE || !ORIGIN) {
  console.error("usage: node server/smoke.mjs <url> <chrome-extension-origin>");
  process.exit(2);
}

/* The field separator in the signing input. Written as a char code rather than
   a literal, because a raw 0x1F in a source file is invisible in every diff and
   every review, and getting it wrong fails as "bad signature" — the one error
   this file exists to distinguish from a real one. */
const US = String.fromCharCode(31);
const PROTOCOL = 3;

const b64url = (buf) => Buffer.from(buf).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* One keypair for the whole run, as an install has one. Non-extractable is not
   available here and buys nothing — this key lives for a few seconds. */
const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pubB64 = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));

/** The worker's SIGN_FIELDS table, from this side. */
const SIGN_ROUTE = {
  "/trial": "trial", "/entitlement": "entitlement", "/checkout": "checkout"
};

async function build(route, fields = [], extra = {}) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const ts = Date.now();
  const input = ["LCT3", SIGN_ROUTE[route], ...fields, pubB64, nonce, String(ts)].join(US);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    pair.privateKey, new TextEncoder().encode(input));
  return JSON.stringify({ v: PROTOCOL, device_pub: pubB64, nonce, ts, sig: b64url(sig), ...extra });
}

/** Never throws: a dead host must arrive as a status, not a stack trace. */
async function post(route, payload, origin = ORIGIN) {
  try {
    const res = await fetch(URL_BASE + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: payload,
      signal: AbortSignal.timeout(20000)
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch {
    return { status: 0, body: "no answer" };
  }
}

let failed = 0;
/* `warn` lists statuses that are not what we want but are not a broken deploy
   either — a feature awaiting a secret, say. They print and do not fail, so the
   ✗ column keeps meaning "this deploy is not safe to sell against". */
function check(label, got, want, notes, warn = []) {
  const ok = got.status === want;
  const soft = !ok && warn.includes(got.status);
  if (!ok && !soft) failed = 1;
  const why = notes[got.status] || `unexpected — inspect with: wrangler tail`;
  const mark = ok ? "✓" : soft ? "!" : "✗";
  console.log(`   ${mark} ${label.padEnd(24)} ${String(got.status).padStart(3)}  ${why}`);
}

console.log(`\n→ smoke test against ${URL_BASE}`);
console.log(`   as ${ORIGIN}\n`);

check("/trial", await post("/trial", await build("/trial")), 200, {
  200: "origin, device proof and protocol all accepted",
  401: "device proof rejected — this script and lib/entitlement.js have drifted",
  403: "our own origin was REFUSED — ALLOWED_ORIGINS names a different extension",
  426: "the worker wants a protocol this script does not speak",
  429: "rate-limited; this run proves nothing, wait and retry",
  503: "no ledger to remember with — check the DB and RL bindings",
  0: "nothing answered — the deploy did not take"
});

check("stranger origin", await post("/trial", await build("/trial"), STRANGER), 403, {
  200: "another extension was NOT refused — ALLOWED_ORIGINS is not in force",
  403: "a stranger's extension is refused"
});

/* Can anyone actually buy this?

   The one question a deploy used to have no way of answering. Checkout lived on
   a static web page, so a worker could deploy perfectly, answer every check
   here, and still be attached to a store nobody could pay at.

   This opens a real session upstream, which is the only honest way to ask. No
   money moves and the session expires unused; the cost is one abandoned
   checkout object per deploy, which is the correct price for knowing.

   503 is a warning rather than a failure: a worker deployed before its product
   id exists is mid-setup, not broken. tools/preflight.mjs blocks the RELEASE on
   the same condition, which is where it stops being mid-setup. */
/* /checkout now refuses a sale to a device with no verified identity — see
   entitlement-worker.js. This script proves a device key but carries no
   identity token, so 401 is the CORRECT answer here, not a failure: it is the
   same 401 a real anonymous purchase attempt would get. The body is what
   tells the two 401s apart — "unverified" is the gate working; anything else
   in that bucket is the device proof itself being refused. */
const coRes = await post("/checkout", await build("/checkout"));
const coUnverified = coRes.status === 401 && /unverified/.test(coRes.body);
/* The expectation is 401, flat. Passing the observed status back in as the
   expected one compared a value with itself, so this line printed green for
   every deploy — including a dead one and a wide-open one. */
check("/checkout", coRes, 401, {
  200: "a checkout session opened — this deploy can take money, WITHOUT the identity gate",
  401: "no sale to a device with no verified identity — the gate is working, as designed",
  403: "our own origin was REFUSED — ALLOWED_ORIGINS names a different extension",
  429: "rate-limited; this run proves nothing, wait and retry",
  503: "nothing to sell — set DODO_PRODUCT_ID in wrangler.toml, or DODO_API_KEY is missing",
  0: "nothing answered — the deploy did not take"
}, [503]);

/* A 401 alone is not the gate: the body is what tells "no verified identity"
   apart from "your device proof was refused". The second is a real failure. */
if (coRes.status === 401 && !coUnverified) {
  failed = 1;
  console.log("   ✗ " + "/checkout body".padEnd(24) + " 401  device proof rejected — this script and lib/entitlement.js have drifted");
}

const junk = "SMOKE-" + b64url(crypto.getRandomValues(new Uint8Array(9)));
check("/entitlement junk key",
  await post("/entitlement", await build("/entitlement", [junk], { license_key: junk })), 404, {
    404: "Dodo answered — junk key correctly unknown, so DODO_API_KEY works",
    403: "licence refused before Dodo — check the revocations table",
    429: "rate-limited; this run proves nothing, wait and retry",
    503: "Dodo did not answer — check DODO_API_KEY and DODO_MODE",
    0: "nothing answered — the deploy did not take"
  });

/* Same signed body twice. The first send is expected to pass; only the second
   is the assertion, so a 429 on the first would be a false green — check it. */
const replay = await build("/trial");
const first = await post("/trial", replay);
if (first.status !== 200) {
  console.log(`   ✗ ${"nonce replay".padEnd(24)} ${String(first.status).padStart(3)}  ` +
    `the setup call failed, so replay was never tested`);
  failed = 1;
} else {
  check("nonce replay", await post("/trial", replay), 409, {
    200: "a spent nonce was accepted — the nonce ledger is degrading open, check DB",
    409: "a replayed request is refused",
    429: "rate-limited; this run proves nothing, wait and retry"
  });
}

/* The webhook is server-to-server, so it is deliberately outside the origin
   gate — which makes "is it still refusing unsigned callers" worth asserting on
   every deploy. 503 means reachable but no secret set: refunds stay manual. */
const hook = await (async () => {
  try {
    const res = await fetch(URL_BASE + "/webhook/dodo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "refund.succeeded", data: {} }),
      signal: AbortSignal.timeout(20000)
    });
    return { status: res.status, body: "" };
  } catch { return { status: 0, body: "" }; }
})();
check("refund webhook", hook, 401, {
  200: "an UNSIGNED refund was accepted — anyone can revoke any licence",
  401: "unsigned deliveries are refused (does NOT prove Dodo holds the same secret — run tools/refund-setup.mjs)",
  404: "the webhook route is missing — refunds stay manual",
  405: "the route rejects POST — refunds stay manual",
  503: "reachable, but DODO_WEBHOOK_SECRET is unset — refunds stay manual",
  0: "nothing answered — the deploy did not take"
}, [503]);

check("protocol gate",
  await post("/trial", JSON.stringify({ v: 2, license_key: "x", device: "y", ts: Date.now() })), 426, {
    200: "a protocol-2 body was ACCEPTED — device proof is effectively optional",
    400: "rejected, but as a bare 400 the popup cannot turn into 'update Tvara'",
    426: "an outdated client is told to update"
  });

console.log("");
process.exit(failed);
