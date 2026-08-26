#!/usr/bin/env node
/**
 * Tvara — prove a DEPLOYED refund webhook actually verifies signatures.
 *
 *   node tools/webhook-check.mjs <issuer-url> <whsec_…>
 *
 * test/test-refund-webhook.mjs proves the logic; this proves the deployment —
 * that the route is reachable, that the secret Cloudflare holds is the one Dodo
 * signs with, and that a forgery is refused by the copy that is actually
 * running. Those are different failures and only one of them is a code bug.
 *
 * Deliveries carry a nonexistent customer on purpose, so the worker resolves
 * zero licences and revokes nothing. It exercises signature, freshness,
 * idempotency and the upstream call without touching a real purchase.
 *
 * Exits non-zero if any check fails.
 */
import { createHmac, randomUUID } from "node:crypto";

const URL_BASE = (process.argv[2] || "").replace(/\/+$/, "");
const SECRET = process.argv[3] || process.env.DODO_WEBHOOK_SECRET || "";

if (!URL_BASE || !SECRET) {
  console.error("usage: node tools/webhook-check.mjs <issuer-url> <whsec_…>");
  process.exit(2);
}

const raw = SECRET.startsWith("whsec_") ? SECRET.slice(6) : SECRET;
const sign = (id, ts, body, key = raw) =>
  createHmac("sha256", Buffer.from(key, "base64")).update(`${id}.${ts}.${body}`).digest("base64");

/** A refund for a customer that does not exist: resolves to no licence. */
const event = (type) => JSON.stringify({
  type,
  data: {
    payload_type: "Refund",
    refund_id: "ref_check_" + randomUUID().slice(0, 8),
    payment_id: "pay_check_" + randomUUID().slice(0, 8),
    status: "succeeded",
    customer: { customer_id: "cus_nonexistent_" + randomUUID().slice(0, 8) }
  }
});

async function deliver({ type = "refund.succeeded", id, at, body, badSig } = {}) {
  const payload = body ?? event(type);
  const wid = id || "msg_check_" + randomUUID();
  const ts = String(Math.floor((at ?? Date.now()) / 1000));
  const sig = badSig ? "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" : `v1,${sign(wid, ts, payload)}`;
  try {
    const res = await fetch(URL_BASE + "/webhook/dodo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": wid, "webhook-timestamp": ts, "webhook-signature": sig
      },
      body: payload,
      signal: AbortSignal.timeout(25000)
    });
    return { status: res.status, text: (await res.text()).slice(0, 200) };
  } catch (e) {
    return { status: 0, text: String(e.message || e) };
  }
}

let failed = 0;
const check = (label, got, want, why) => {
  const ok = got.status === want;
  if (!ok) failed = 1;
  console.log(`   ${ok ? "✓" : "✗"} ${label.padEnd(30)} ${String(got.status).padStart(3)}  ${ok ? why : got.text}`);
};

console.log(`\n→ refund webhook at ${URL_BASE}/webhook/dodo\n`);

check("a correctly signed delivery", await deliver(), 200,
  "accepted — the deployed secret matches the signer");
check("a forged signature", await deliver({ badSig: true }), 401,
  "refused");
check("a delivery signed 20 min ago", await deliver({ at: Date.now() - 20 * 60000 }), 401,
  "refused — replays expire");
check("an unsigned delivery", await (async () => {
  try {
    const res = await fetch(URL_BASE + "/webhook/dodo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: event("refund.succeeded"), signal: AbortSignal.timeout(25000)
    });
    return { status: res.status, text: (await res.text()).slice(0, 200) };
  } catch { return { status: 0, text: "no answer" }; }
})(), 401, "refused");

/* Same id twice: the second must be recognised, not re-applied. */
const dupId = "msg_check_dup_" + randomUUID();
const dupBody = event("refund.succeeded");
const firstSend = await deliver({ id: dupId, body: dupBody });
check("a first delivery", firstSend, 200, "accepted");
const second = await deliver({ id: dupId, body: dupBody });
check("the same delivery retried", second, 200,
  second.text.includes("duplicate") ? "recognised as a duplicate" : "accepted");
if (!second.text.includes("duplicate")) {
  console.log("   ✗ retry was NOT deduplicated — a retried refund would apply twice");
  failed = 1;
}

check("an event we do not act on", await deliver({ type: "payment.succeeded" }), 200,
  "ignored without a retry storm");

console.log("");
process.exit(failed);
