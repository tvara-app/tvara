#!/usr/bin/env node
/**
 * Tvara — wire up (and prove) the refund path, in one command.
 *
 *   node tools/refund-setup.mjs <live|test> <DODO_API_KEY> [--issuer <url>] [--e2e]
 *
 * WHAT IT DOES
 *   1. finds or creates the Dodo webhook pointing at <issuer>/webhook/dodo
 *   2. reads its signing secret and stores it as the Worker's DODO_WEBHOOK_SECRET
 *   3. proves the deployed endpoint verifies signatures (tools/webhook-check.mjs)
 *   4. with --e2e, refunds a real test-mode payment and waits for the licence
 *      it bought to stop working
 *
 * WHY A SCRIPT AND NOT A CHECKLIST. Every step here was a dashboard click, and
 * the one that gets skipped is step 2 — after which refunds arrive, fail their
 * signature check, get retried, and the endpoint is quietly disabled. Nothing
 * tells you. This does.
 *
 * The secret is piped straight into wrangler and never printed.
 *
 * --e2e REFUNDS REAL MONEY IN WHATEVER MODE YOU PASS. It refuses to run in live
 * mode. Point --issuer at an issuer whose DODO_MODE matches the key you gave it,
 * or the licence lookup will be made against the wrong environment.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const MODE = argv[0];
const KEY = argv[1];
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : (argv[i + 1] || fallback);
};
const E2E = argv.includes("--e2e");
const ISSUER = (flag("--issuer", "https://tvara.tharuntejandhe.workers.dev")).replace(/\/+$/, "");

if (!["live", "test"].includes(MODE) || !KEY) {
  console.error("usage: node tools/refund-setup.mjs <live|test> <DODO_API_KEY> [--issuer <url>] [--e2e]");
  process.exit(2);
}
if (E2E && MODE === "live") {
  console.error("✋ --e2e issues a real refund. Refusing to do that in live mode.");
  process.exit(2);
}

const BASE = MODE === "test" ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
const HOOK_URL = ISSUER + "/webhook/dodo";
/* Only what the issuer acts on. A narrower subscription is fewer deliveries to
   verify and fewer ways to be surprised. */
const EVENTS = ["refund.succeeded", "dispute.lost", "dispute.accepted"];

const die = (msg) => { console.error("✋ " + msg); process.exit(1); };

async function dodo(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + KEY,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the text for the error */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

console.log(`\n→ Dodo ${MODE} mode, issuer ${ISSUER}\n`);

/* ---------- 1. the key works at all ---------- */
const who = await dodo("/products?page_size=1");
if (who.status === 401) die(`that key is not a ${MODE}-mode key (401 from ${BASE}).`);
if (who.status !== 200) die(`Dodo answered ${who.status}: ${who.text}`);
console.log("  ✓ API key accepted");

/* ---------- 2. find or create the webhook ---------- */
const list = await dodo("/webhooks");
if (list.status !== 200) die(`could not list webhooks: ${list.status} ${list.text}`);
const existing = (list.json?.data || list.json?.items || []).find((w) => w.url === HOOK_URL);

let hookId;
if (existing) {
  hookId = existing.id;
  console.log(`  ✓ webhook already registered (${hookId})`);
} else {
  const made = await dodo("/webhooks", {
    method: "POST",
    body: JSON.stringify({
      url: HOOK_URL,
      description: "Tvara issuer — revoke a licence on refund or chargeback",
      filter_types: EVENTS
    })
  });
  if (made.status >= 300) die(`could not create the webhook: ${made.status} ${made.text}`);
  hookId = made.json?.id;
  if (!hookId) die(`webhook created but no id came back: ${made.text}`);
  console.log(`  ✓ webhook created (${hookId}) for ${EVENTS.join(", ")}`);
}

/* ---------- 3. secret → Cloudflare ---------- */
const sec = await dodo(`/webhooks/${encodeURIComponent(hookId)}/secret`);
if (sec.status !== 200 || !sec.json?.secret) {
  die(`could not read the signing secret: ${sec.status} ${sec.text}\n` +
      `   Copy it from Developer → Webhooks and run:\n` +
      `   cd server && wrangler secret put DODO_WEBHOOK_SECRET`);
}
const put = spawnSync("npx", ["wrangler", "secret", "put", "DODO_WEBHOOK_SECRET"], {
  cwd: join(ROOT, "server"),
  input: sec.json.secret,          // piped, never printed and never written to disk
  encoding: "utf8"
});
if (put.status !== 0) die("wrangler could not store the secret:\n" + (put.stderr || put.stdout));
console.log("  ✓ DODO_WEBHOOK_SECRET stored on the Worker");

/* ---------- 4. prove the deployed endpoint ---------- */
console.log("");
const check = spawnSync("node", [join(ROOT, "tools", "webhook-check.mjs"), ISSUER, sec.json.secret],
  { encoding: "utf8" });
process.stdout.write(check.stdout || "");
if (check.status !== 0) {
  process.stderr.write(check.stderr || "");
  die("the deployed webhook did not verify. Refunds would not revoke.");
}

if (!E2E) {
  console.log(`✅ refunds are wired: a ${EVENTS[0]} now revokes the licence it paid for.`);
  console.log("   Add --e2e (test mode only) to prove it against a real refund.\n");
  process.exit(0);
}

/* ---------- 5. end to end, on a real test-mode purchase ---------- */
console.log("→ end-to-end: refund a test purchase and watch the licence die\n");

const keys = await dodo("/license_keys?page_size=100&status=active");
if (keys.status !== 200) die(`could not list licence keys: ${keys.status} ${keys.text}`);
const target = (keys.json?.items || []).find((k) => k.key && k.payment_id);
if (!target) {
  console.log("  ! no active test licence with a payment behind it.");
  console.log("    Make one first: open your product's test checkout and pay with");
  console.log("    Dodo's test card, then re-run this with --e2e.\n");
  process.exit(1);
}
console.log(`  · licence ${target.id} from payment ${target.payment_id}`);

/* Ask the issuer the way the extension does, so the verdict is the user's. */
const US = String.fromCharCode(31);
const b64url = (b) => Buffer.from(b).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));

async function askIssuer(licenceKey) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const ts = Date.now();
  const input = ["LCT3", "entitlement", licenceKey, pub, nonce, String(ts)].join(US);
  const sig = b64url(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input)));
  try {
    const res = await fetch(ISSUER + "/entitlement", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: flag("--origin", "chrome-extension://" + "a".repeat(32)) },
      body: JSON.stringify({ v: 3, license_key: licenceKey, device_pub: pub, nonce, ts, sig }),
      signal: AbortSignal.timeout(25000)
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch { return { status: 0, body: "no answer" }; }
}

const before = await askIssuer(target.key);
if (before.status !== 200) {
  console.log(`  ! the issuer answers ${before.status} for this licence already: ${before.body}`);
  console.log("    Nothing to prove — it was not working before the refund either.\n");
  process.exit(1);
}
console.log("  ✓ before the refund, the issuer grants Pro (200)");

const ref = await dodo("/refunds", {
  method: "POST",
  body: JSON.stringify({ payment_id: target.payment_id, reason: "tvara refund end-to-end test" })
});
if (ref.status >= 300) die(`refund refused: ${ref.status} ${ref.text}`);
console.log(`  ✓ refund issued (${ref.json?.refund_id || "accepted"})`);

/* Dodo delivers asynchronously; the issuer also rate-limits per licence, so
   this waits in seconds rather than hammering. */
let revoked = false;
for (let i = 1; i <= 20 && !revoked; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const after = await askIssuer(target.key);
  if (after.status === 403 && /revoked/.test(after.body)) {
    revoked = true;
    console.log(`  ✓ after ${i * 3}s the issuer refuses it: ${after.body}`);
  } else if (i % 4 === 0) {
    console.log(`    …still ${after.status} after ${i * 3}s`);
  }
}

console.log("");
if (!revoked) {
  die("the refund went through but the licence still works.\n" +
      "   Check delivery attempts in Dodo → Developer → Webhooks, and `wrangler tail`.");
}
console.log("✅ refund → webhook → revocation → the licence stops working. End to end.\n");
