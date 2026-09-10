#!/usr/bin/env node
/**
 * Tvara — the refund webhook.
 *
 * A refund that does not revoke is a customer who got their money back and kept
 * Pro. A refund that revokes the wrong licence is a paying customer locked out.
 * Both are silent, and both are only ever found by the person they happen to,
 * so every branch here is exercised against the real worker module: real
 * signature verification, real SQLite standing in for D1, only Dodo stubbed.
 */
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const worker = (await import("../server/entitlement-worker.js")).default;

let pass = 0, fail = 0;
const t = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  → " + extra}`);
};

/* ---------- fixtures ---------- */

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const ORIGIN = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";

const SECRET_RAW = randomBytes(24).toString("base64");
const SECRET = "whsec_" + SECRET_RAW;

const LICENCE = "TVARA-REFUNDED-0001";
const OTHER_LICENCE = "TVARA-STILL-PAID-0002";
const CUSTOMER = "cus_test_1";
const PAYMENT = "pay_test_1";
const OTHER_PAYMENT = "pay_test_2";

function kv() {
  const m = new Map();
  return {
    async get(k) { const v = m.get(k); return v === undefined ? null : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; }
  };
}

/* node:sqlite binds positionally and rejects ?N outright ("column index out of
   range"); D1 accepts it, and every statement the Worker ships is written that
   way. Rewrite into bare ? and reorder the arguments to match, so this double
   runs the same SQL production does instead of silently sending the Worker
   down its KV fallback. */
function numbered(sql, args) {
  const order = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_, n) => { order.push(Number(n) - 1); return "?"; });
  return order.length ? [rewritten, order.map((i) => args[i])] : [sql, args];
}

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  const prepare = (sql) => ({
    bind: (...a) => ({
      async all() { const [q, b] = numbered(sql, a); return { results: sqlite.prepare(q).all(...b) }; },
      async first() { const [q, b] = numbered(sql, a); return sqlite.prepare(q).get(...b) ?? null; },
      async run() { const [q, b] = numbered(sql, a); return { meta: { changes: Number(sqlite.prepare(q).run(...b).changes) } }; }
    })
  });
  return {
    sqlite, prepare,
    async batch(stmts) {
      const out = [];
      sqlite.exec("BEGIN");
      try { for (const s of stmts) out.push(await s.run()); sqlite.exec("COMMIT"); }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
      return out;
    }
  };
}

const env = (over = {}) => ({
  RL: kv(), DB: d1(), SIGNING_KEY,
  DODO_API_KEY: "sk_test", DODO_MODE: "live",
  DODO_WEBHOOK_SECRET: SECRET,
  ALLOWED_ORIGINS: ORIGIN,
  ...over
});

/* Dodo, stubbed. `licenceMode` steers the one call the webhook makes. */
let licenceMode = "ok";
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/license_keys")) {
    if (licenceMode === "down") throw new Error("network");
    if (licenceMode === "5xx") return new Response("nope", { status: 502 });
    if (licenceMode === "empty") return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (licenceMode === "garbage") return new Response("<html>not json</html>", { status: 200 });
    if (licenceMode === "single") {
      return new Response(JSON.stringify({
        items: [{ id: "lk_1", key: LICENCE, payment_id: PAYMENT, customer_id: CUSTOMER }]
      }), { status: 200 });
    }
    if (licenceMode === "emptykey") {
      return new Response(JSON.stringify({
        items: [{ id: "lk_0", key: "", payment_id: PAYMENT, customer_id: CUSTOMER }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      items: [
        { id: "lk_1", key: LICENCE, payment_id: PAYMENT, customer_id: CUSTOMER },
        { id: "lk_2", key: OTHER_LICENCE, payment_id: OTHER_PAYMENT, customer_id: CUSTOMER }
      ]
    }), { status: 200 });
  }
  if (u.includes("/licenses/validate")) {
    return new Response(JSON.stringify({ valid: true, customer: { email: "a@b.c" } }), { status: 200 });
  }
  throw new Error("unexpected fetch: " + u);
};

/* ---------- Standard Webhooks signing, from the sender's side ---------- */

const sign = (id, ts, body, secret = SECRET_RAW) =>
  createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${ts}.${body}`).digest("base64");

let seq = 0;
function delivery(type, data, opts = {}) {
  const body = JSON.stringify({ type, data });
  const id = opts.id || `msg_${++seq}`;
  const ts = String(Math.floor((opts.at || Date.now()) / 1000));
  const sig = opts.sig || `v1,${sign(id, ts, body, opts.secret)}`;
  return new Request("https://issuer.test/webhook/dodo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig
    },
    body
  });
}

const refund = (payment = PAYMENT) => ({
  payload_type: "Refund", refund_id: "ref_1", payment_id: payment,
  status: "succeeded", customer: { customer_id: CUSTOMER, email: "a@b.c" }
});

/* A held licence key is stored ENCRYPTED now: an order that is fulfilled and
   never claimed used to hold a plaintext bearer secret indefinitely, which is
   the one case schema.sql's "a liability with a shelf life" did not cover.
   These assertions check both halves — that the row is not the key, and that
   the key is still in there. */
const heldIsSealed = (row) =>
  typeof row.lic_key === "string" && row.lic_key.startsWith("enc1:") &&
  !row.lic_key.includes(BOUGHT);

const keyFp = async (key) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(d).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const rows = (e, sql) => e.DB.sqlite.prepare(sql).all();

/* ---------- signature ---------- */

{
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund()), e);
  const body = await res.json();
  t("a signed refund is accepted", res.status === 200, `got ${res.status}`);
  t("…and revokes exactly one licence", body.revoked === 1, JSON.stringify(body));

  const rev = rows(e, "SELECT * FROM revocations");
  t("a revocation row is written", rev.length === 1, JSON.stringify(rev));
  t("…for the refunded licence", rev[0] && rev[0].key_fp === await keyFp(LICENCE));
  t("…with the reason recorded", rev[0] && rev[0].reason === "refunded");
  t("the licence the customer still holds is untouched",
    !rev.some((r) => r.key_fp === undefined) && rev.length === 1);
}

{
  const res = await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_no_ledger" }),
    env({ DB: undefined }));
  t("a webhook without its ledger is retryable", res.status === 503, `got ${res.status}`);
}

{
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund(), { sig: "v1,AAAA" }), e);
  t("a forged signature is refused", res.status === 401, `got ${res.status}`);
  t("…and nothing is revoked", rows(e, "SELECT * FROM revocations").length === 0);
}

{
  const e = env();
  const res = await worker.fetch(
    delivery("refund.succeeded", refund(), { secret: randomBytes(24).toString("base64") }), e);
  t("a signature from the wrong secret is refused", res.status === 401, `got ${res.status}`);
}

{
  const e = env();
  const old = Date.now() - 20 * 60 * 1000;
  const res = await worker.fetch(delivery("refund.succeeded", refund(), { at: old }), e);
  t("a replayed delivery from 20 minutes ago is refused", res.status === 401, `got ${res.status}`);
  t("…and nothing is revoked", rows(e, "SELECT * FROM revocations").length === 0);
}

{
  const e = env({ DODO_WEBHOOK_SECRET: "" });
  const res = await worker.fetch(delivery("refund.succeeded", refund()), e);
  t("an unconfigured secret answers 503, not 200", res.status === 503, `got ${res.status}`);
  t("…and revokes nothing rather than trusting the body",
    rows(e, "SELECT * FROM revocations").length === 0);
}

/* ---------- which events act ---------- */

for (const [type, acts] of [
  ["refund.succeeded", true], ["dispute.lost", true], ["dispute.accepted", true],
  ["refund.failed", false], ["dispute.opened", false], ["payment.succeeded", false],
  ["payment.failed", false], ["license_key.created", false]
]) {
  const e = env();
  const res = await worker.fetch(delivery(type, refund()), e);
  const n = rows(e, "SELECT * FROM revocations").length;
  t(`${type} ${acts ? "revokes" : "is ignored"}`, res.status === 200 && (n === 1) === acts,
    `status ${res.status}, ${n} revocations`);
}

/* ---------- idempotency ---------- */

{
  const e = env();
  const req = () => delivery("refund.succeeded", refund(), { id: "msg_same" });
  const a = await worker.fetch(req(), e);
  const b = await worker.fetch(req(), e);
  t("a retried delivery is accepted", a.status === 200 && b.status === 200);
  t("…and reported as a duplicate", (await b.json()).duplicate === true);
  t("…and applied exactly once", rows(e, "SELECT * FROM revocations").length === 1);
}

/* ---------- blast radius ---------- */

{
  const e = env();
  await worker.fetch(delivery("refund.succeeded", refund(OTHER_PAYMENT)), e);
  const rev = rows(e, "SELECT * FROM revocations");
  t("refunding one payment revokes only that payment's licence", rev.length === 1);
  t("…and it is the other licence, not the first",
    rev[0] && rev[0].key_fp === await keyFp(OTHER_LICENCE));
}

/* ---------- seats ---------- */

{
  const e = env();
  const fp = await keyFp(LICENCE);
  e.DB.sqlite.prepare("INSERT INTO seats (key_fp, dev_fp, last_seen) VALUES (?, ?, ?)")
    .run(fp, "dev1", Date.now());
  e.DB.sqlite.prepare("INSERT INTO seats (key_fp, dev_fp, last_seen) VALUES (?, ?, ?)")
    .run("someone_else", "dev2", Date.now());
  await worker.fetch(delivery("refund.succeeded", refund()), e);
  const seats = rows(e, "SELECT * FROM seats");
  t("a refund frees the licence's seats", !seats.some((s) => s.key_fp === fp));
  t("…and leaves other licences' seats alone",
    seats.some((s) => s.key_fp === "someone_else"));
}

/* ---------- failure is retryable, never silently swallowed ---------- */

for (const mode of ["down", "5xx"]) {
  licenceMode = mode;
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_retry" }), e);
  t(`Dodo ${mode}: answers 5xx so the delivery is retried`, res.status >= 500, `got ${res.status}`);
  t(`Dodo ${mode}: the delivery id is released for the retry`,
    rows(e, "SELECT * FROM webhook_events").length === 0);
  licenceMode = "ok";
}

{
  licenceMode = "empty";
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund()), e);
  t("a customer with no licence is settled, not retried forever", res.status === 200,
    `got ${res.status}`);
  licenceMode = "ok";
}

/* ---------- the point of all of it ----------
   The kill list only matters if /entitlement honours it. */

{
  const e = env();
  await worker.fetch(delivery("refund.succeeded", refund()), e);

  const US = String.fromCharCode(31);
  const b64url = (b) => Buffer.from(b).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
  const nonce = b64url(randomBytes(16));
  const ts = Date.now();
  const input = ["LCT3", "entitlement", LICENCE, pub, nonce, String(ts)].join(US);
  const sig = b64url(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input)));

  const res = await worker.fetch(new Request("https://issuer.test/entitlement", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ v: 3, license_key: LICENCE, device_pub: pub, nonce, ts, sig })
  }), e);
  const body = await res.json().catch(() => ({}));
  t("a refunded licence is refused at the next entitlement check",
    res.status === 403, `got ${res.status} ${JSON.stringify(body)}`);
  t("…and told why", body.error === "licence revoked" && body.reason === "refunded",
    JSON.stringify(body));
}

/* ---------- shape ---------- */

{
  const e = env();
  const res = await worker.fetch(
    new Request("https://issuer.test/webhook/dodo", { method: "GET" }), e);
  t("GET is refused", res.status === 405, `got ${res.status}`);
}

{
  const e = env();
  const id = "msg_badjson", ts = String(Math.floor(Date.now() / 1000)), body = "{not json";
  const res = await worker.fetch(new Request("https://issuer.test/webhook/dodo", {
    method: "POST",
    headers: {
      "webhook-id": id, "webhook-timestamp": ts,
      "webhook-signature": `v1,${sign(id, ts, body)}`
    },
    body
  }), e);
  t("a signed but unparseable body is a 400, not a crash", res.status === 400, `got ${res.status}`);
}


/* ---------- bodies that are not what the header promised ----------
   All of these are correctly SIGNED. Dodo would not send them, but a signing
   key that ever leaks turns the parser into the attack surface, and "it threw"
   is a 500 that Dodo retries forever. */

function rawDelivery(body, opts = {}) {
  const id = opts.id || `msg_raw_${++seq}`;
  const ts = String(Math.floor((opts.at || Date.now()) / 1000));
  return new Request("https://issuer.test/webhook/dodo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id, "webhook-timestamp": ts,
      "webhook-signature": opts.sig || `v1,${sign(id, ts, body)}`
    },
    body
  });
}

for (const [label, body] of [
  ["a bare JSON string", '"refund.succeeded"'],
  ["a JSON array", "[]"],
  ["JSON null", "null"],
  ["a bare number", "42"],
  ["true", "true"],
  ["an object with no type", '{"data":{}}'],
  ["a type that is a number", '{"type":123,"data":{}}'],
  ["a type that is an object", '{"type":{},"data":{}}'],
  ["a refund with no data at all", '{"type":"refund.succeeded"}'],
  ["a refund with null data", '{"type":"refund.succeeded","data":null}'],
  ["a refund with data as a string", '{"type":"refund.succeeded","data":"nope"}'],
  ["a refund with no customer", '{"type":"refund.succeeded","data":{"payment_id":"pay_x"}}'],
  ["a refund with a null customer", '{"type":"refund.succeeded","data":{"customer":null}}'],
  ["a refund with a numeric customer id", '{"type":"refund.succeeded","data":{"customer":{"customer_id":7}}}'],
  ["deeply nested rubbish", '{"type":"refund.succeeded","data":' + "[".repeat(40) + "]".repeat(40) + "}"]
]) {
  const e = env();
  const res = await worker.fetch(rawDelivery(body), e);
  const revs = rows(e, "SELECT * FROM revocations").length;
  t(`${label} neither revokes nor 5xxs`,
    res.status < 500 && revs === 0, `status ${res.status}, ${revs} revocations`);
}

/* ---------- a refund nobody can attribute ---------- */

{
  // No payment_id, and this customer holds two licences. Revoking both would
  // take Pro from a purchase that was never refunded.
  const e = env();
  const body = JSON.stringify({ type: "refund.succeeded", data: { customer: { customer_id: CUSTOMER } } });
  const res = await worker.fetch(rawDelivery(body), e);
  const out = await res.json();
  t("an unattributable refund revokes nothing", rows(e, "SELECT * FROM revocations").length === 0,
    JSON.stringify(out));
  t("…and says how many licences it could not choose between", out.ambiguous === 2, JSON.stringify(out));
  t("…and settles rather than retrying forever", res.status === 200, `got ${res.status}`);
}

{
  // One licence and no payment_id is not ambiguous at all.
  licenceMode = "single";
  const e = env();
  const body = JSON.stringify({ type: "refund.succeeded", data: { customer: { customer_id: CUSTOMER } } });
  const res = await worker.fetch(rawDelivery(body), e);
  t("a customer with exactly one licence is still revoked",
    res.status === 200 && rows(e, "SELECT * FROM revocations").length === 1,
    `${res.status}, ${rows(e, "SELECT * FROM revocations").length} rows`);
  licenceMode = "ok";
}

/* ---------- freshness in the other direction ---------- */

{
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund(), { at: Date.now() + 20 * 60000 }), e);
  t("a delivery timestamped 20 minutes in the FUTURE is refused", res.status === 401, `got ${res.status}`);
}
{
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund(), { at: Date.now() + 60000 }), e);
  t("a minute of clock skew is tolerated", res.status === 200, `got ${res.status}`);
}

/* ---------- headers ---------- */

for (const [label, headers] of [
  ["no webhook-id", { "webhook-timestamp": "1", "webhook-signature": "v1,x" }],
  ["no timestamp", { "webhook-id": "a", "webhook-signature": "v1,x" }],
  ["no signature", { "webhook-id": "a", "webhook-timestamp": "1" }],
  ["a non-numeric timestamp", { "webhook-id": "a", "webhook-timestamp": "soon", "webhook-signature": "v1,x" }],
  ["a signature with no version", { "webhook-id": "a", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "abcdef" }],
  ["an unknown signature version", { "webhook-id": "a", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v9,abcdef" }]
]) {
  const e = env();
  const res = await worker.fetch(new Request("https://issuer.test/webhook/dodo", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ type: "refund.succeeded", data: refund() })
  }), e);
  t(`${label} is refused`, res.status === 401, `got ${res.status}`);
}

{
  /* Standard Webhooks allows several space-separated signatures so a secret can
     be rotated without dropping deliveries. Ours must be found among them. */
  const e = env();
  const id = "msg_rotate", ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: "refund.succeeded", data: refund() });
  const req = new Request("https://issuer.test/webhook/dodo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id, "webhook-timestamp": ts,
      "webhook-signature": `v1,AAAA v1,${sign(id, ts, body)} v1,BBBB`
    },
    body
  });
  t("a valid signature among several is accepted",
    (await worker.fetch(req, e)).status === 200);
}

/* ---------- what Dodo hands back ---------- */

{
  licenceMode = "garbage";
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund()), e);
  t("an unparseable licence lookup is retried, not treated as 'no licence'",
    res.status >= 500, `got ${res.status}`);
  licenceMode = "ok";
}
{
  licenceMode = "emptykey";
  const e = env();
  const res = await worker.fetch(delivery("refund.succeeded", refund()), e);
  t("a licence with a blank key revokes nothing and settles", res.status === 200, `got ${res.status}`);
  t("…and writes no revocation for the empty string",
    rows(e, "SELECT * FROM revocations").length === 0);
  licenceMode = "ok";
}

/* ---------- refunding the same thing twice ---------- */

{
  const e = env();
  await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_r1" }), e);
  const second = await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_r2" }), e);
  t("a second refund for the same licence is accepted", second.status === 200);
  t("…and leaves exactly one revocation row",
    rows(e, "SELECT * FROM revocations").length === 1);
}

{
  /* A dispute after a refund: still one row, and the newer reason wins so the
     support answer matches what actually happened. */
  const e = env();
  await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_a" }), e);
  await worker.fetch(delivery("dispute.lost", refund(), { id: "msg_b" }), e);
  const rev = rows(e, "SELECT * FROM revocations");
  t("a chargeback after a refund updates the reason rather than duplicating",
    rev.length === 1 && rev[0].reason === "chargeback", JSON.stringify(rev));
}

/* ---------- delivery ----------

   The webhook is not only how a purchase is taken away — it is now the ONLY
   thing that says a purchase happened. A redirect cannot: it is a client
   telling us it paid.

   `payment.succeeded` and `license_key.created` are independent and arrive in
   whichever order they arrive, so both orderings are walked. */

const REF = "a".repeat(32);
const DEV = "b".repeat(32);
const BOUGHT = "TVARA-DELIVERED-0003";

const paid = (ref = REF, dev = DEV) => ({
  payload_type: "Payment", payment_id: PAYMENT, status: "succeeded",
  customer: { customer_id: CUSTOMER, email: "a@b.c" },
  metadata: { tv_ref: ref, tv_dev: dev }
});

const issued = (payment = PAYMENT) => ({
  payload_type: "LicenseKey", id: "lk_new", key: BOUGHT,
  payment_id: payment, customer_id: CUSTOMER
});

const order = (e) => e.DB.sqlite.prepare("SELECT * FROM orders WHERE ref = ?").get(REF);

{
  // Payment first, then the licence — the ordinary order.
  const e = env();
  e.DB.sqlite.prepare(
    "INSERT INTO orders (ref, dev_fp, state, created_at, updated_at) VALUES (?, ?, 'created', ?, ?)"
  ).run(REF, DEV, Date.now(), Date.now());

  await worker.fetch(delivery("payment.succeeded", paid(), { id: "msg_p1" }), e);
  t("payment.succeeded marks the order paid", order(e).state === "paid", JSON.stringify(order(e)));
  t("…and records who to ask about it later", order(e).payment_id === PAYMENT);

  await worker.fetch(delivery("license_key.created", issued(), { id: "msg_k1" }), e);
  const row = order(e);
  t("license_key.created attaches the key by payment",
    row.state === "fulfilled" && heldIsSealed(row), JSON.stringify(row));
}

{
  /* The licence beats the payment here. Nothing may be lost by that: the key
     lands on an order that is still 'created', and the retried payment event
     must not knock a fulfilled order backwards. */
  const e = env();
  e.DB.sqlite.prepare(
    "INSERT INTO orders (ref, dev_fp, state, payment_id, created_at, updated_at) VALUES (?, ?, 'created', ?, ?, ?)"
  ).run(REF, DEV, PAYMENT, Date.now(), Date.now());

  await worker.fetch(delivery("license_key.created", issued(), { id: "msg_k2" }), e);
  t("a licence arriving before its payment still lands", order(e).state === "fulfilled");

  await worker.fetch(delivery("payment.succeeded", paid(), { id: "msg_p2" }), e);
  t("…and the payment event does not move it backwards",
    order(e).state === "fulfilled" && heldIsSealed(order(e)), JSON.stringify(order(e)));
}

{
  // The order row never got written — the ledger was down when the session
  // opened. The provider's own metadata is the durable link, so the webhook
  // creates it rather than dropping a purchase on the floor.
  const e = env();
  await worker.fetch(delivery("payment.succeeded", paid(), { id: "msg_p3" }), e);
  const row = order(e);
  t("a payment with no order row writes one from the metadata",
    row && row.state === "paid" && row.dev_fp === DEV, JSON.stringify(row));
}

{
  // Bought some other way — an invoice, a support-issued key, a purchase from
  // before this endpoint existed. Nothing to attribute, and not an error.
  const e = env();
  const res = await worker.fetch(delivery("payment.succeeded",
    { payload_type: "Payment", payment_id: PAYMENT, customer: { customer_id: CUSTOMER } },
    { id: "msg_p4" }), e);
  const body = await res.json();
  t("a payment carrying none of our metadata is accepted and attributed to nothing",
    res.status === 200 && body.unattributed === true, JSON.stringify(body));
  t("…and invents no order", !order(e));
}

{
  /* Metadata we cannot use is not a reason to retry forever. A 5xx here is
     Dodo's instruction to redeliver, and it keeps redelivering until it
     disables the endpoint — taking the events that DO work with it. */
  const e = env();
  const res = await worker.fetch(delivery("payment.succeeded",
    paid(REF, "not-a-device-fingerprint"), { id: "msg_bad" }), e);
  const body = await res.json();
  t("a payment with unusable metadata settles instead of retrying forever",
    res.status === 200 && body.unattributed === true, `${res.status} ${JSON.stringify(body)}`);
  t("…and writes no order from it", !order(e));
}

{
  // Standard Webhooks retries. A retried delivery must not re-run anything.
  const e = env();
  await worker.fetch(delivery("payment.succeeded", paid(), { id: "msg_dup" }), e);
  const again = await worker.fetch(delivery("payment.succeeded", paid(), { id: "msg_dup" }), e);
  const body = await again.json();
  t("a retried delivery is a no-op", again.status === 200 && body.duplicate === true, JSON.stringify(body));
}

{
  /* A refund landing in the seconds between fulfilment and the buyer's first
     claim. The kill list is not enough on its own here: the order is still
     holding a live key, and claiming it would hand Pro to a refunded purchase. */
  const e = env();
  e.DB.sqlite.prepare(
    "INSERT INTO orders (ref, dev_fp, state, payment_id, lic_key, key_fp, created_at, updated_at) " +
    "VALUES (?, ?, 'fulfilled', ?, ?, ?, ?, ?)"
  ).run(REF, DEV, PAYMENT, LICENCE, await keyFp(LICENCE), Date.now(), Date.now());

  licenceMode = "single";
  await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_rf" }), e);
  licenceMode = "ok";
  const row = order(e);
  t("a refund closes the order and drops the key it was holding",
    row.state === "refunded" && row.lic_key === null, JSON.stringify(row));
}

{
  /* A THROW between claiming the receipt and finishing the work.
     Every failure RETURN in the handler releases the claim before asking Dodo
     to retry. A throw skipped all of them, and the retry then read as a
     duplicate and was answered 200 — the refund lost, silently, forever. This
     injects a fault into the ledger after the claim has been taken and asks
     for the two things that make "please retry" true: a 5xx, and a second
     delivery that is actually acted on rather than deduped away. */
  const e = env();
  const realPrepare = e.DB.prepare.bind(e.DB);
  let armed = true;
  e.DB.prepare = (sql) => {
    // Let the receipt be claimed, then break the very next statement.
    if (armed && !/webhook_events/.test(sql)) { armed = false; throw new Error("ledger exploded"); }
    return realPrepare(sql);
  };

  licenceMode = "single";
  const boom = await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_throw" }), e);
  t("a webhook that throws mid-flight asks Dodo to retry", boom.status === 500,
    String(boom.status));

  e.DB.prepare = realPrepare;
  const retry = await worker.fetch(delivery("refund.succeeded", refund(), { id: "msg_throw" }), e);
  const retryBody = await retry.json();
  t("...and the retry is ACTED ON, not swallowed as a duplicate",
    retry.status === 200 && retryBody.duplicate !== true, JSON.stringify(retryBody));
  licenceMode = "ok";
}

/* ---------- a licence key that arrives before its payment ----------

   Dodo delivers license_key.created and payment.succeeded in either order. The
   key event carries no metadata of ours, so it is matched on payment_id — and
   when the payment has not landed yet there is no order to match. That used to
   be answered 200 with the key discarded, which means it is never redelivered:
   the buyer's claim then waits forever on a key nobody holds. */
{
  const e = env();
  const REF = "a".repeat(32);
  const DEV = "b".repeat(32);
  const PAY = "pay_early_1";
  const EARLY_KEY = "TVARA-EARLY-0001";

  const first = await worker.fetch(delivery("license_key.created", { key: EARLY_KEY, payment_id: PAY }), e);
  t("an early license_key.created is accepted", first.status === 200, String(first.status));
  t("...no order is fulfilled by it — there is none yet",
    rows(e, "SELECT * FROM orders").length === 0);

  const parked = rows(e, "SELECT * FROM pending_keys");
  t("...the key is PARKED rather than dropped", parked.length === 1 && parked[0].payment_id === PAY,
    JSON.stringify(parked));
  t("...and parked sealed, never in the clear",
    parked[0] && String(parked[0].lic_key).startsWith("enc1:") &&
    !String(parked[0].lic_key).includes(EARLY_KEY), JSON.stringify(parked[0]));

  const second = await worker.fetch(delivery("payment.succeeded", {
    metadata: { tv_ref: REF, tv_dev: DEV }, payment_id: PAY,
    customer: { customer_id: CUSTOMER }
  }), e);
  t("the payment.succeeded that follows is accepted", second.status === 200, String(second.status));

  const order = rows(e, "SELECT * FROM orders")[0];
  t("...and the parked key is adopted: the order is fulfilled",
    order && order.state === "fulfilled" && order.payment_id === PAY, JSON.stringify(order));
  t("...with the key attached, still sealed",
    order && String(order.lic_key || "").startsWith("enc1:"), JSON.stringify(order && order.lic_key));
  t("...and the parking bay is emptied", rows(e, "SELECT * FROM pending_keys").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
