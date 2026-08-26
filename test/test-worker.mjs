#!/usr/bin/env node
/**
 * Tvara — entitlement Worker tests.
 *
 * This is the file that decides who has paid, and it was the one file in the
 * project with no tests at all: it runs on someone else's machine, so a bug in
 * it is not something a user reports — it is a refund.
 *
 * Runs the real worker module in Node with a fake KV and a stubbed Dodo. The
 * only thing mocked is the outside world; every branch under test is the code
 * that ships.
 */
import { generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const worker = (await import("../server/entitlement-worker.js")).default;

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

/* ---------- fixtures ---------- */

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const PUB = publicKey;

const ORIGIN = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";
const OTHER = "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const KEY = "LCT-TEST-KEY-0001";

/* ---------- protocol v3: every request carries a device proof ----------

   The worker no longer takes the caller's word for which device it is. It takes
   an ECDSA signature over the request and derives the device from the key that
   produced it, so this harness has to hold real keypairs — a hardcoded `DEV`
   string cannot be spoken here any more, which is the entire point of the
   change under test. */

const encoder = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function makeDevice() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pub = b64u(await crypto.subtle.exportKey("spki", pair.publicKey));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(pub));
  return {
    pub,
    fp: [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    async sign(input) {
      return b64u(await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, encoder.encode(input)));
    }
  };
}

// Must equal signingInput() in the worker. Deliberately retyped rather than
// imported: this file's job is to notice if that function ever changes shape.
const signingInput = (route, fields) => ["LCT3", route, ...fields].join("\u001f");

let nonceSeq = 0;
const freshNonce = () => b64u(Buffer.from(String(nonceSeq++).padStart(16, "0")));

const DEVICE = await makeDevice();

/**
 * A signed request body. `over` patches the OUTER body after signing where the
 * field is not part of the signature, and before it where it is — so a test can
 * ask for a stale timestamp or a bad key and still get a well-formed proof over
 * exactly those values.
 */
async function signedBody(over = {}, { route = "entitlement", dev = DEVICE } = {}) {
  const licenseKey = "license_key" in over ? over.license_key : KEY;
  const hasTs = !("ts" in over) || over.ts !== undefined;
  const ts = "ts" in over ? over.ts : Date.now();
  const nonce = over.nonce || freshNonce();

  const fields = route === "entitlement" ? [licenseKey]
    : route === "devices" ? [licenseKey]
    : route === "devices-revoke" ? [licenseKey, over.target]
    : [];
  const sig = await dev.sign(signingInput(route, [...fields, dev.pub, nonce, String(ts)]));

  const body = { v: 3, device_pub: dev.pub, nonce, sig };
  if (route !== "trial") body.license_key = licenseKey;
  if (route === "entitlement") body.instance_id = "inst_1";
  if (route === "devices-revoke") body.target = over.target;
  if (hasTs) body.ts = ts;
  for (const k of ["device_pub", "v", "sig", "nonce"]) if (k in over) body[k] = over[k];
  return body;
}

/** KV double: same surface the worker uses, plus a switch to make it fail. */
function kv({ broken = false } = {}) {
  const map = new Map();
  const boom = () => { throw new Error("KV down"); };
  return {
    map,
    async get(k, type) {
      if (broken) boom();
      const v = map.get(k);
      return v === undefined ? null : (type === "json" ? JSON.parse(v) : v);
    },
    async put(k, v) { if (broken) boom(); map.set(k, v); },
  };
}

/**
 * D1 double: a REAL SQLite database behind the slice of the D1 API the worker
 * uses, loaded from the same schema.sql that deploy.sh applies.
 *
 * Real engine on purpose. The three things this migration is for — the seat
 * PRIMARY KEY refusing a duplicate, ON CONFLICT DO NOTHING reporting zero
 * changes on a replayed nonce, and a batch rolling back as one — are SQLite's
 * behaviour. A hand-written fake would only ever assert my guess at it.
 *
 * `broken` makes every statement throw, which is how the degrade-open paths
 * get proved rather than assumed.
 */
function d1({ broken = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  const boom = () => { throw new Error("D1 down"); };

  const prepare = (sql) => ({
    bind: (...args) => ({
      async all() { if (broken) boom(); return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { if (broken) boom(); return sqlite.prepare(sql).get(...args) ?? null; },
      async run() {
        if (broken) boom();
        return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
      }
    })
  });

  return {
    sqlite,
    prepare,
    async batch(stmts) {
      if (broken) boom();
      const out = [];
      sqlite.exec("BEGIN");
      try {
        for (const s of stmts) out.push(await s.run());
        sqlite.exec("COMMIT");
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
      return out;
    }
  };
}

function env(over = {}) {
  return {
    RL: kv(),
    DB: d1(),
    SIGNING_KEY,
    DODO_API_KEY: "sk_test",
    DODO_MODE: "live",
    ALLOWED_ORIGINS: ORIGIN,
    ...over
  };
}

/** Stub Dodo. `queue` lets one test walk several upstream answers in order. */
function stubDodo(answers) {
  const queue = Array.isArray(answers) ? [...answers] : null;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    const a = queue ? (queue.shift() || { status: 200, body: { valid: true } }) : answers;
    if (a.throw) throw new Error("network");
    return new Response(JSON.stringify(a.body ?? {}), {
      status: a.status,
      headers: { "Content-Type": "application/json" }
    });
  };
  return calls;
}

const post = (body, { origin = ORIGIN, e = env(), method = "POST", path = "/entitlement" } = {}) =>
  worker.fetch(new Request("https://issuer.example" + path, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined
  }), e);


/* ---------- origin policy ---------- */

stubDodo({ status: 200, body: { valid: true, customer: { email: "buyer@example.com" } } });

t("origin: a page origin is refused", (await post(await signedBody(), { origin: "https://evil.example" })).status === 403);
t("origin: no origin at all is refused", (await post(await signedBody(), { origin: "" })).status === 403);
t("origin: another extension is refused", (await post(await signedBody(), { origin: OTHER })).status === 403);
t("origin: ours is allowed", (await post(await signedBody())).status === 200);

// The one that used to be a footgun: an unset ALLOWED_ORIGINS meant "anyone".
t("origin: live mode with no allow-list refuses EVERY extension",
  (await post(await signedBody(), { e: env({ ALLOWED_ORIGINS: "" }) })).status === 403);
t("origin: test mode still allows a scratch deploy",
  (await post(await signedBody(), { e: env({ ALLOWED_ORIGINS: "", DODO_MODE: "test" }) })).status === 200);

/* Firefox: the moz-extension:// UUID is per-install, so ALLOWED_ORIGINS can
   never name it. Without ALLOW_FIREFOX every Firefox user is a 403. */
const MOZ = "moz-extension://d0e1f2a3-4b5c-6d7e-8f90-a1b2c3d4e5f6";
t("origin: firefox is refused while ALLOW_FIREFOX is off",
  (await post(await signedBody(), { origin: MOZ })).status === 403);
t("origin: firefox is allowed with ALLOW_FIREFOX = 1",
  (await post(await signedBody(), { origin: MOZ, e: env({ ALLOW_FIREFOX: "1" }) })).status === 200);
t("origin: ALLOW_FIREFOX does not open the chrome allow-list",
  (await post(await signedBody(), { origin: OTHER, e: env({ ALLOW_FIREFOX: "1" }) })).status === 403);
t("origin: ALLOW_FIREFOX does not admit a page origin",
  (await post(await signedBody(), { origin: "https://evil.example", e: env({ ALLOW_FIREFOX: "1" }) })).status === 403);
t("origin: firefox preflight answers 204 with its own origin echoed", await (async () => {
  const r = await post(null, { method: "OPTIONS", origin: MOZ, e: env({ ALLOW_FIREFOX: "1" }) });
  return r.status === 204 && r.headers.get("Access-Control-Allow-Origin") === MOZ;
})());

const pre = await post(null, { method: "OPTIONS" });
t("origin: preflight answers 204 with CORS", pre.status === 204 &&
  pre.headers.get("Access-Control-Allow-Origin") === ORIGIN);
t("origin: preflight from a stranger is refused",
  (await post(null, { method: "OPTIONS", origin: OTHER })).status === 403);

/* ---------- input validation ---------- */

t("input: GET is refused", (await post(await signedBody(), { method: "GET" })).status === 405);
t("input: unknown path is 404", (await post(await signedBody(), { path: "/whatever" })).status === 404);
t("input: a malformed key is refused", (await post(await signedBody({ license_key: "no spaces allowed!" }))).status === 400);
t("input: a malformed device key is refused", (await post(await signedBody({ device_pub: "nothex" }))).status === 400);
t("input: an unsigned request is refused", (await post(await signedBody({ sig: b64u(Buffer.alloc(64)) }))).status === 401);
t("input: a v2 client is told to update, not merely refused",
  (await post(await signedBody({ v: 2 }))).status === 426);

/* ---------- /trial ----------
   Deleted once on the reasoning that nothing called it, while bg.js was calling
   it on every first run. Its absence is now a test failure rather than a
   comment nobody re-reads. */
{
  const trialEnv = env();
  const fresh = await makeDevice();
  const first = await post(await signedBody({}, { route: "trial", dev: fresh }), { e: trialEnv, path: "/trial" });
  const firstBody = await first.json();
  t("trial: a fresh device is granted a start date",
    first.status === 200 && typeof firstBody.startedAt === "number" && firstBody.already === false);

  const again = await post(await signedBody({}, { route: "trial", dev: fresh }), { e: trialEnv, path: "/trial" });
  const againBody = await again.json();
  t("trial: the SAME device gets its original date back, not a fresh week",
    again.status === 200 && againBody.already === true && againBody.startedAt === firstBody.startedAt);

  t("trial: the archive stamp secret is issued with it",
    typeof firstBody.ks === "string" && firstBody.ks.length > 0);

  const other = await makeDevice();
  const otherRes = await post(await signedBody({}, { route: "trial", dev: other }), { e: trialEnv, path: "/trial" });
  t("trial: a genuinely different device gets its own trial", otherRes.status === 200);

  // A /trial proof must not be usable at /entitlement, and vice versa.
  t("trial: an entitlement-signed body is refused at /trial",
    (await post(await signedBody({}, { dev: fresh }), { e: trialEnv, path: "/trial" })).status === 401);
}

/* ---------- replay ---------- */

t("replay: a stale timestamp is refused",
  (await post(await signedBody({ ts: Date.now() - 60 * 60 * 1000 }))).status === 400);
t("replay: a future timestamp is refused",
  (await post(await signedBody({ ts: Date.now() + 60 * 60 * 1000 }))).status === 400);
// The hole this closes: an optional check is one you defeat by deleting a field.
t("replay: a MISSING timestamp is refused, not waved through",
  (await post(await signedBody({ ts: undefined }))).status === 400);

/* ---------- upstream branches ---------- */

stubDodo({ status: 404 });
t("upstream: unknown licence → 404", (await post(await signedBody())).status === 404);
stubDodo({ status: 200, body: { valid: false } });
t("upstream: valid:false → 404 (a missing field is not consent)", (await post(await signedBody())).status === 404);
stubDodo({ status: 200, body: {} });
t("upstream: no verdict at all → 404", (await post(await signedBody())).status === 404);
stubDodo({ status: 403 });
t("upstream: refunded/inactive → 403", (await post(await signedBody())).status === 403);
stubDodo({ status: 500 });
t("upstream: Dodo down → 503, never a token", (await post(await signedBody())).status === 503);
stubDodo({ throw: true });
t("upstream: network failure → 503", (await post(await signedBody())).status === 503);

/* ---------- the happy path, and what the token actually says ---------- */

const calls = stubDodo({ status: 200, body: { valid: true, customer: { email: "buyer@example.com" } } });
const okEnv = env();
const okRes = await post(await signedBody(), { e: okEnv });
const okBody = await okRes.json();
t("issue: 200 with a token", okRes.status === 200 && typeof okBody.token === "string");
t("issue: the token is an LCT2 triple", /^LCT2\.[\w-]+\.[\w-]+$/.test(okBody.token || ""));
t("issue: the secret key never leaves the worker",
  !JSON.stringify(okBody).includes(SIGNING_KEY.slice(0, 24)));
t("issue: the licence key is sent to Dodo and nowhere else",
  calls.length === 1 && calls[0].url.includes("dodopayments.com") &&
  calls[0].body.license_key === KEY && calls[0].auth === "Bearer sk_test");

// The claim that matters: the extension must be able to verify this offline.
const [, payloadB64, sigB64] = (okBody.token || "").split(".");
const unb64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const claims = JSON.parse(unb64(payloadB64).toString("utf8"));
t("issue: the signature verifies against the paired public key",
  nodeVerify("sha256", unb64(payloadB64), { key: PUB, dsaEncoding: "ieee-p1363" }, unb64(sigB64)));
/* The binding is to the DERIVED fingerprint of the proven key, not to anything
   the request asked for — the difference between a seat you hold and a seat you
   named. */
t("issue: the token is bound to the device that proved itself", claims.dev === DEVICE.fp);
t("issue: ...and the request never contained that fingerprint",
  !JSON.stringify(await signedBody()).includes(DEVICE.fp));
t("issue: the token is bound to the licence, by hash not by key",
  typeof claims.sub === "string" && claims.sub.length === 32 && !JSON.stringify(claims).includes(KEY));
t("issue: it carries the paid features", Array.isArray(claims.feat) && claims.feat.includes("archive.search"));
/* 30 days, not 90. The bound is tight on purpose: a token that quietly went
   back to a season long would take the kill list's whole reason with it. */
t("issue: it expires in 30 days",
  claims.exp > Date.now() + 29 * 864e5 && claims.exp <= Date.now() + 31 * 864e5);
t("issue: a tampered payload no longer verifies",
  !nodeVerify("sha256", Buffer.from(JSON.stringify({ ...claims, plan: "enterprise" })),
    { key: PUB, dsaEncoding: "ieee-p1363" }, unb64(sigB64)));

/* ---------- seats ---------- */

const seatEnv = env();
stubDodo({ status: 200, body: { valid: true } });
/* Seven genuine keypairs. Under v3 a "device" cannot be conjured from a string
   any more — claiming a sixth seat means actually holding a sixth key. */
const seatDevices = [];
for (let i = 0; i < 7; i++) seatDevices.push(await makeDevice());

const seatCodes = [];
for (let i = 0; i < 6; i++) {
  seatCodes.push((await post(await signedBody({}, { dev: seatDevices[i] }), { e: seatEnv })).status);
}
t("seats: five devices are issued tokens", seatCodes.slice(0, 5).every((c) => c === 200), seatCodes.join(","));
t("seats: the sixth is refused with 422", seatCodes[5] === 422, seatCodes.join(","));
t("seats: a device that already has a seat re-uses it",
  (await post(await signedBody({}, { dev: seatDevices[0] }), { e: seatEnv })).status === 200);

// An idle seat past the token's own lifetime is reclaimable — otherwise a
// dead laptop costs a slot forever and support has to do it by hand.
const staleEnv = env();
const keyFp = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY)))]
  .slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
const old = Date.now() - 200 * 864e5;
await staleEnv.RL.put(`seats:${keyFp}`, JSON.stringify(
  Object.fromEntries([0, 1, 2, 3, 4].map((i) => [String(i).repeat(32), old]))));
t("seats: an idle seat past its token's life is reclaimed",
  (await post(await signedBody({}, { dev: seatDevices[6] }), { e: staleEnv })).status === 200);

/* ---------- replay ---------- */

{
  const rEnv = env();
  stubDodo({ status: 200, body: { valid: true } });
  const once = await signedBody();
  t("replay: a valid request works once", (await post(once, { e: rEnv })).status === 200);
  t("replay: the SAME body a second time is refused",
    (await post(once, { e: rEnv })).status === 409);
  // The window step 2 leaves open is exactly what step 3 has to close.
  t("replay: a fresh nonce from the same device still works",
    (await post(await signedBody(), { e: rEnv })).status === 200);
}

/* ---------- device management ----------

   THE BUG THIS FIXES. Releasing a device used to update the payment provider
   and the client's own registry, and never touched the issuer's ledger — so a
   user who sold a laptop, released it, and activated a new one was refused by a
   server that had just watched them free a slot. The last assertion in this
   block is that exact sequence, and before the release endpoint existed it
   returned 422. */
{
  const dEnv = env();
  stubDodo({ status: 200, body: { valid: true } });

  const fleet = [];
  for (let i = 0; i < 5; i++) fleet.push(await makeDevice());
  for (const d of fleet) await post(await signedBody({}, { dev: d }), { e: dEnv });

  const sixth = await makeDevice();
  t("devices: the sixth device is refused, as before",
    (await post(await signedBody({}, { dev: sixth }), { e: dEnv })).status === 422);

  // Listing
  const listed = await post(await signedBody({}, { route: "devices", dev: fleet[0] }),
    { e: dEnv, path: "/devices" });
  const listBody = await listed.json();
  t("devices: an enrolled device can list the seats",
    listed.status === 200 && listBody.seats.length === 5 && listBody.limit === 5);
  t("devices: the caller can tell which seat is its own",
    listBody.seats.filter((x) => x.self).length === 1 &&
    listBody.seats.find((x) => x.self).device === fleet[0].fp);
  t("devices: the list carries no IP, agent or location",
    Object.keys(listBody.seats[0]).sort().join(",") === "device,lastSeen,self");

  // Authorisation: holding the KEY is not enough, you must hold a SEAT.
  const outsider = await makeDevice();
  t("devices: a device with no seat cannot list them, even with the right key",
    (await post(await signedBody({}, { route: "devices", dev: outsider }),
      { e: dEnv, path: "/devices" })).status === 403);
  t("devices: ...nor revoke anyone",
    (await post(await signedBody({ target: fleet[0].fp }, { route: "devices-revoke", dev: outsider }),
      { e: dEnv, path: "/devices/revoke" })).status === 403);

  // Release, then the thing that used to fail.
  const revoked = await post(await signedBody({ target: fleet[4].fp }, { route: "devices-revoke", dev: fleet[0] }),
    { e: dEnv, path: "/devices/revoke" });
  const revBody = await revoked.json();
  t("devices: an enrolled device can release another seat",
    revoked.status === 200 && revBody.ok === true && revBody.seats === 4);

  t("devices: THE FIX — a new device can take the freed seat immediately",
    (await post(await signedBody({}, { dev: sixth }), { e: dEnv })).status === 200);

  t("devices: releasing an already-released seat is a success, not an error",
    (await post(await signedBody({ target: fleet[4].fp }, { route: "devices-revoke", dev: fleet[0] }),
      { e: dEnv, path: "/devices/revoke" })).status === 200);
}

/* ---------- degradation ---------- */

stubDodo({ status: 200, body: { valid: true } });
t("degrade: KV down still serves a paying customer",
  (await post(await signedBody(), { e: env({ RL: kv({ broken: true }) }) })).status === 200);
t("degrade: no KV binding at all still serves",
  (await post(await signedBody(), { e: env({ RL: undefined }) })).status === 200);
/* The same promise, now that the ledgers moved. A database we cannot reach must
   not be able to unsell a licence somebody paid for. */
t("degrade: D1 down still serves a paying customer",
  (await post(await signedBody(), { e: env({ DB: d1({ broken: true }) }) })).status === 200);
t("degrade: no D1 binding at all still serves",
  (await post(await signedBody(), { e: env({ DB: undefined }) })).status === 200);
t("degrade: neither binding still serves",
  (await post(await signedBody(), { e: env({ DB: undefined, RL: undefined }) })).status === 200);

/* A worker deployed without its secret must not sign anything. /licenses/validate
   is the same public endpoint the client can reach, so without the key the
   worker used to issue perfectly valid 90-day tokens carrying no customer —
   `email` empty everywhere downstream, and no way to tell a paying customer
   from anyone who guessed a key format. */
{
  const calls = stubDodo([{ status: 200, body: { valid: true } }]);
  const res = await post(await signedBody(), { e: env({ DODO_API_KEY: undefined }) });
  t("misconfigured: no DODO_API_KEY mints no token", res.status !== 200, String(res.status));
  t("misconfigured: …and never reaches Dodo without it", calls.length === 0, String(calls.length));
}

/* ---------- rate limit ---------- */

const rlEnv = env();
const codes = [];
for (let i = 0; i < 22; i++) codes.push((await post(await signedBody(), { e: rlEnv })).status);
t("ratelimit: the first 20 in an hour pass", codes.slice(0, 20).every((c) => c === 200));
t("ratelimit: the 21st is throttled", codes[20] === 429 && codes[21] === 429);
t("ratelimit: throttling costs no upstream call",
  (await post(await signedBody(), { e: rlEnv })).status === 429);

/* ---------- kill list ----------
   The gap this closes: revocation used to mean waiting out the token. At 90
   days that was a leaked or charged-back key we could do nothing about for a
   season. The row is what makes the TTL a comfort rather than a commitment. */

// Same derivation as the worker's — retyped, like signingInput() above, so this
// file notices if the fingerprint ever changes shape.
const keyFpOf = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

{
  const e = env();
  const keyFp = await keyFpOf(KEY);
  const calls = stubDodo({ status: 200, body: { valid: true } });

  t("killlist: a licence with no row is served as normal",
    (await post(await signedBody(), { e })).status === 200);

  e.DB.sqlite.prepare("INSERT INTO revocations (key_fp, reason, at) VALUES (?, ?, ?)")
    .run(keyFp, "refunded", Date.now());

  const before = calls.length;
  const res = await post(await signedBody(), { e });
  const body = await res.json();
  t("killlist: the very next call is refused", res.status === 403, String(res.status));
  t("killlist: the reason travels with it", body.reason === "refunded");
  t("killlist: a revoked licence never reaches Dodo", calls.length === before);
  t("killlist: /devices is refused too — a revoked licence cannot manage seats",
    await (async () => {
      const r = await post(await signedBody({}, { route: "devices" }), { e, path: "/devices" });
      return r.status === 403 && (await r.json()).error === "licence revoked";
    })());
  t("killlist: an unrevoked licence on the same worker is unaffected",
    (await post(await signedBody({ license_key: "LCT-TEST-KEY-0002" },
      { route: "entitlement" }), { e })).status === 200);
}

/* ---------- the ledger written before D1 existed ---------- */

stubDodo({ status: 200, body: { valid: true } });
{
  const e = env();
  const keyFp = await keyFpOf(KEY);
  const legacy = [];
  for (let i = 0; i < 5; i++) legacy.push(await makeDevice());
  const ledger = {};
  for (const d of legacy) ledger[d.fp] = Date.now();
  e.RL.map.set(`seats:${keyFp}`, JSON.stringify(ledger));

  /* Without the import, moving to D1 would silently hand every licence five
     fresh seats — the seat limit would reset for everybody who ever paid. */
  const sixth = await makeDevice();
  t("migration: seats already spent in KV are carried into D1, not released",
    (await post(await signedBody({}, { dev: sixth }), { e })).status === 422);
  t("migration: the carry-over stops at the seat limit",
    Number(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM seats WHERE key_fp = ?").get(keyFp).n) === 5);
  t("migration: a device that already held a seat still holds it",
    (await post(await signedBody({}, { dev: legacy[0] }), { e })).status === 200);
}

{
  const e = env();
  const dev = await makeDevice();
  const started = Date.now() - 3 * 864e5;
  e.RL.map.set(`trial:${dev.fp}`, String(started));
  const res = await post(await signedBody({}, { route: "trial", dev }), { e, path: "/trial" });
  const body = await res.json();
  t("migration: a week already spent is not handed out a second time",
    res.status === 200 && body.already === true && body.startedAt === started,
    JSON.stringify(body));
}

/* ---------- the nonce, on the storage that can actually promise it ---------- */

{
  // No KV at all, so D1 is the only thing that could be refusing the replay.
  const e = env({ RL: undefined });
  const body = await signedBody();
  const first = await post(body, { e });
  const second = await post(body, { e });
  t("nonce: D1 alone refuses a replay", first.status === 200 && second.status === 409,
    `${first.status}/${second.status}`);
}

/* ---------- edge rate limit ---------- */

{
  const seen = [];
  const e = env({ EDGE_RL: { async limit(arg) { seen.push(arg); return { success: seen.length <= 2 }; } } });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await post(await signedBody(), { e })).status);
  t("edge limit: the binding's verdict is enforced",
    codes[0] === 200 && codes[1] === 200 && codes[2] === 429, codes.join("/"));
  t("edge limit: keyed on the caller, not on the licence",
    seen.length === 3 && seen.every((x) => x && typeof x.key === "string"));
  t("edge limit: a limiter that throws does not close the door",
    (await post(await signedBody(), {
      e: env({ EDGE_RL: { async limit() { throw new Error("limiter down"); } } })
    })).status === 200);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log("failed:\n  " + failed.join("\n  "));
process.exit(fail ? 1 : 0);
