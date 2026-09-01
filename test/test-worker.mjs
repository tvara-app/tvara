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
import { createHash, createHmac, generateKeyPairSync, verify as nodeVerify } from "node:crypto";
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
    : route === "session" ? [licenseKey]
    : route === "sessions" ? []
    : route === "sessions-terminate" ? [over.op_id, (over.targets || []).join(",")]
    : route === "sessions-terminate-all" ? [over.op_id]
    : route === "devices" ? [licenseKey]
    : route === "devices-revoke" ? [licenseKey, over.target]
    : route === "checkout-claim" ? [over.ref]
    : route === "identity-start" ? [over.email]
    : route === "identity-verify" ? [over.email, over.code]
    : [];
  const sig = await dev.sign(signingInput(route, [...fields, dev.pub, nonce, String(ts)]));

  const body = { v: 3, device_pub: dev.pub, nonce, sig };
  if (route !== "trial" && !route.startsWith("checkout") && !route.startsWith("identity")
      && route !== "restore" && !route.startsWith("sessions")) body.license_key = licenseKey;
  if (route.startsWith("sessions-")) body.op_id = over.op_id;
  if (route === "sessions-terminate") body.targets = over.targets;
  if ("if_version" in over) body.if_version = over.if_version;
  if ("keep_self" in over) body.keep_self = over.keep_self;
  if ("intent" in over) body.intent = over.intent;
  if (route === "identity-start" || route === "identity-verify") body.email = over.email;
  if (route === "identity-verify") body.code = over.code;
  if (route === "identity-google") body.id_token = over.id_token;
  // Not signed: the issuer verifies the token itself, so it needs no proof.
  if (over.idt) body.idt = over.idt;
  if (route === "checkout-claim") body.ref = over.ref;
  if (route === "entitlement") body.instance_id = "inst_1";
  if (route === "devices-revoke") body.target = over.target;
  // Unsigned, like the client sends them: the row is keyed on a proven device.
  if ("plat" in over) body.plat = over.plat;
  if ("label" in over) body.label = over.label;
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
    async delete(k) { if (broken) boom(); map.delete(k); },
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

function d1({ broken = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  const boom = () => { throw new Error("D1 down"); };

  const prepare = (sql) => ({
    bind: (...args) => ({
      async all() { if (broken) boom(); const [q, a] = numbered(sql, args); return { results: sqlite.prepare(q).all(...a) }; },
      async first() { if (broken) boom(); const [q, a] = numbered(sql, args); return sqlite.prepare(q).get(...a) ?? null; },
      async run() {
        if (broken) boom();
        const [q, a] = numbered(sql, args);
        return { meta: { changes: Number(sqlite.prepare(q).run(...a).changes) } };
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
    /* OTP ships disabled — verification is Google-only. The code stays behind
       the flag, so the tests keep exercising it rather than rotting. One test
       below flips this off on purpose to prove the gate closes. */
    OTP_ENABLED: "1",
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

/* ---------- identity + /trial ----------
   The trial ledger keys on a VERIFIED EMAIL, not on the device keypair. That
   keypair lives in the extension's own IndexedDB and dies with an uninstall,
   which is what made the free week resettable by removing Tvara and adding it
   back. The reinstall case below is the proof that it no longer is. */
{
  const mailed = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) {
      mailed.push(JSON.parse(opts.body));
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ valid: true, customer: { email: "a@b.c" } }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const e = env({ MAIL_API_KEY: "re_test", MAIL_FROM: "Tvara <t@t.test>" });
  const dev = await makeDevice();
  /* The code never leaves the mail body, so the test reads it the only way
     anyone can: out of the message. */
  const lastCode = () => String(mailed[mailed.length - 1].subject).split(" ")[0];
  /* What the extension signs. lib/entitlement.js folds the address BEFORE
     signing, because the issuer keys the ledger on the folded form and a
     signature over the typed spelling would not match it. Mirrored here rather
     than imported: the point of the check below is that the two agree. */
  const canon = (raw) => {
    const v = String(raw).trim().toLowerCase();
    const at = v.lastIndexOf("@");
    let local = v.slice(0, at);
    let domain = v.slice(at + 1);
    if (domain === "googlemail.com") domain = "gmail.com";
    const plus = local.indexOf("+");
    if (plus > 0) local = local.slice(0, plus);
    if (domain === "gmail.com") local = local.replace(/\./g, "");
    return local + "@" + domain;
  };
  const verify = async (raw, device = dev) => {
    const email = canon(raw);
    await post(await signedBody({ email }, { route: "identity-start", dev: device }),
      { e, path: "/identity/start" });
    const res = await post(
      await signedBody({ email, code: lastCode() }, { route: "identity-verify", dev: device }),
      { e, path: "/identity/verify" });
    return res.json();
  };
  const claim = async (idt, device = dev) =>
    (await post(await signedBody({ idt }, { route: "trial", dev: device }), { e, path: "/trial" })).json();

  const anon = await post(await signedBody({}, { route: "trial", dev }), { e, path: "/trial" });
  const anonBody = await anon.json();
  t("trial: with no identity the issuer keeps no record, and says so",
    anon.status === 200 && anonBody.unverified === true && anonBody.startedAt === undefined);

  const EMAIL = "person@example.com";
  const started = await post(await signedBody({ email: EMAIL }, { route: "identity-start", dev }),
    { e, path: "/identity/start" });
  t("identity: a code is mailed", started.status === 200 && mailed.length === 1);
  t("identity: the code is not in the response body",
    !JSON.stringify(await started.json()).includes(lastCode()));

  /* The resend floor, and the header that makes it usable. A 429 with no wait
     in it leaves a client guessing, and the ones that guess wrong retry
     immediately — which is how a brake becomes the thing being braked. */
  const tooSoon = await post(await signedBody({ email: EMAIL }, { route: "identity-start", dev }),
    { e, path: "/identity/start" });
  t("identity: a second code inside the resend floor is refused",
    tooSoon.status === 429 && (await tooSoon.json()).error === "too soon");
  t("identity: ...and the refusal says how long to wait",
    Number(tooSoon.headers.get("Retry-After")) > 0 &&
    Number(tooSoon.headers.get("Retry-After")) <= 60,
    String(tooSoon.headers.get("Retry-After")));
  t("identity: ...and no second mail was sent", mailed.length === 1);

  t("identity: a wrong code is refused",
    (await post(await signedBody({ email: EMAIL, code: "000000" }, { route: "identity-verify", dev }),
      { e, path: "/identity/verify" })).status === 401);

  const okBody = await verify(EMAIL);
  t("identity: the right code returns an identity token",
    typeof okBody.idt === "string" && okBody.idt.startsWith("LCTID1."));
  t("identity: verifying does not start a trial on its own", !okBody.startedAt);
  const idt = okBody.idt;

  const firstBody = await claim(idt);
  t("trial: a verified identity is granted a start date",
    typeof firstBody.startedAt === "number" && firstBody.already === false);
  t("trial: the archive stamp secret is issued with it",
    typeof firstBody.ks === "string" && firstBody.ks.length > 0);

  /* THE GRANT ITSELF. Every other thing the client keeps about a trial — the
     start date, a `verified` flag — is writable by whoever owns the browser,
     so none of it can be what decides. This can: a signature the client
     verifies and cannot produce. */
  const un64 = (x) => Buffer.from(String(x).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const [ttKind, ttPayload, ttSig] = String(firstBody.tt || "").split(".");
  const ttClaims = ttPayload ? JSON.parse(un64(ttPayload).toString("utf8")) : {};
  t("trial: the week comes back as a signed token", ttKind === "LCTT1");
  t("trial: ...verifying against the paired public key",
    Boolean(ttPayload) && nodeVerify("sha256", un64(ttPayload),
      { key: PUB, dsaEncoding: "ieee-p1363" }, un64(ttSig)));
  t("trial: ...bound to the device that proved itself", ttClaims.dev === dev.fp);
  /* One expiry, not two: the token dies exactly when the week does, so there is
     no second lifetime to get wrong and no window where a spent trial still
     carries a live signature. */
  t("trial: ...expiring exactly when the week does",
    ttClaims.sta === firstBody.startedAt && ttClaims.exp === firstBody.startedAt + 7 * 864e5);
  /* `typ` is inside the signed bytes, so a trial token cannot be re-presented
     where a licence token is expected by editing the label. */
  t("trial: ...and cannot be relabelled into a licence",
    !nodeVerify("sha256", Buffer.from(JSON.stringify({ ...ttClaims, typ: "pro" })),
      { key: PUB, dsaEncoding: "ieee-p1363" }, un64(ttSig)));

  const againBody = await claim(idt);
  t("trial: the same identity gets its original date back, not a fresh week",
    againBody.already === true && againBody.startedAt === firstBody.startedAt);

  /* THE REINSTALL. A brand-new device keypair is exactly what uninstalling and
     reinstalling produces, and it used to buy a whole new week. */
  const reinstalled = await makeDevice();
  const afterBody = await claim(idt, reinstalled);
  t("trial: REINSTALLING does not mint a second week",
    afterBody.already === true && afterBody.startedAt === firstBody.startedAt);

  /* The cheaper hole. The identity anchor closes "uninstall and reinstall"; it
     does NOT close "verify a second address", which needs no uninstall at all
     and costs a spare mailbox. The device-keyed ledger is re-stamped on every
     claim, so the new identity inherits the week this install already spent. */
  const second = await verify("second.mailbox@example.com");
  const secondBody = await claim(second.idt);
  t("trial: a SECOND address on the same install inherits the spent week",
    secondBody.already === true && secondBody.startedAt === firstBody.startedAt);

  /* Gmail folds dots and +tags onto one mailbox. Treating them as separate
     identities would be unlimited free weeks from a single Google account —
     cheaper than the reinstall hole this whole change closes. */
  /* A fresh device, deliberately: on `dev` the carry-over above would make any
     two addresses share a week, and this has to prove the FOLDING. */
  const gDev = await makeDevice();
  const g1 = await verify("trial.farmer@gmail.com", gDev);
  const gTrial = await claim(g1.idt, gDev);
  const g2 = await verify("trialfarmer+week2@googlemail.com", gDev);
  const gTrial2 = await claim(g2.idt, gDev);
  t("trial: gmail dots and +tags are ONE identity, not two free weeks",
    gTrial2.already === true && gTrial2.startedAt === gTrial.startedAt);

  /* The folding has to happen before the signature or it is not enforced: a
     client that signs the typed spelling and lets the issuer fold afterwards
     has signed a different string than the one the ledger keys on. */
  t("identity: a request signed over the unfolded spelling is refused",
    (await post(await signedBody({ email: "trial.farmer@gmail.com" },
      { route: "identity-start", dev }), { e, path: "/identity/start" })).status === 401);

  t("identity: a forged identity token buys nothing",
    (await claim("LCTID1.aaa.bbb")).unverified === true);

  t("identity: Google sign-in is refused when no client id is configured",
    (await post(await signedBody({ id_token: "x".repeat(128) }, { route: "identity-google", dev }),
      { e, path: "/identity/google" })).status === 401);

  // A /trial proof must not be usable at /entitlement, and vice versa.
  t("trial: an entitlement-signed body is refused at /trial",
    (await post(await signedBody({}, { dev }), { e, path: "/trial" })).status === 401);

  globalThis.fetch = savedFetch;
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
  const mailed = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) {
      mailed.push(JSON.parse(opts.body));
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ valid: true }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const e = env({ MAIL_API_KEY: "re_test", MAIL_FROM: "Tvara <t@t.test>" });
  const dev = await makeDevice();
  const started = Date.now() - 3 * 864e5;
  /* The week this DEVICE spent before identity existed. Verifying an identity
     must ADOPT it, not hand out a fresh one — otherwise shipping this change
     would have given every existing user a second free week on the day they
     first signed in. */
  e.RL.map.set(`trial:${dev.fp}`, String(started));

  const EMAIL = "carried@example.com";
  await post(await signedBody({ email: EMAIL }, { route: "identity-start", dev }),
    { e, path: "/identity/start" });
  const verified = await (await post(
    await signedBody({ email: EMAIL, code: String(mailed[mailed.length - 1].subject).split(" ")[0] },
      { route: "identity-verify", dev }), { e, path: "/identity/verify" })).json();

  const res = await post(await signedBody({ idt: verified.idt }, { route: "trial", dev }),
    { e, path: "/trial" });
  const body = await res.json();
  t("migration: a week already spent is not handed out a second time",
    res.status === 200 && body.already === true && body.startedAt === started,
    JSON.stringify(body));
  globalThis.fetch = savedFetch;
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

/* An identity token, minted the way the worker mints one: HMAC-SHA256 under a
   key derived from SIGNING_KEY. The OTP round trip has its own block above; for
   /checkout a verified address is a PRECONDITION, not the subject — the issuer
   refuses to open a session for a device with no identity behind it, because a
   licence bought that way has no owner row and cannot be restored. */
function idtFor(email) {
  const efp = createHash("sha256").update("lct-identity-v1:" + email).digest()
    .subarray(0, 16).toString("hex");
  const payload = Buffer.from(JSON.stringify({
    v: 1, efp, iat: Date.now(), exp: Date.now() + 400 * 864e5 }));
  const material = createHash("sha256").update("lct-identity-mac-v1:" + SIGNING_KEY).digest();
  const mac = createHmac("sha256", material).update(payload).digest();
  return `LCTID1.${b64u(payload)}.${b64u(mac)}`;
}
/* ---------- Google-only verification ----------

   Verification ships as one route with one provider. The OTP code is kept,
   behind OTP_ENABLED, so switching back does not need a deploy of new code —
   which only means anything if the closed gate is actually closed. */
{
  const dev = await makeDevice();
  const e = env({ OTP_ENABLED: "", MAIL_API_KEY: "re_test", MAIL_FROM: "Tvara <t@t.test>" });
  const start = await post(await signedBody({ email: "gate@example.com" },
    { route: "identity-start", dev }), { e, path: "/identity/start" });
  const verify = await post(await signedBody({ email: "gate@example.com", code: "123456" },
    { route: "identity-verify", dev }), { e, path: "/identity/verify" });
  t("otp: disabled by default, and says gone rather than not-found",
    start.status === 410 && verify.status === 410, `${start.status}/${verify.status}`);
  t("otp: a disabled route sends no mail",
    (await start.json()).error === "otp disabled");
}

/* ---------- the address at rest ----------

   email_fp answers "same person" and nothing else. The address itself is kept
   so an access or erasure request can be answered, and it is kept ENCRYPTED:
   the failure this guards is a D1 dump that is a mailing list. */
{
  const mailed = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) {
      mailed.push(JSON.parse(opts.body));
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ valid: true }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const e = env({ MAIL_API_KEY: "re_test", MAIL_FROM: "Tvara <t@t.test>" });
  const dev = await makeDevice();
  const EMAIL = "at-rest@example.com";

  await post(await signedBody({ email: EMAIL }, { route: "identity-start", dev }),
    { e, path: "/identity/start" });
  const code = String(mailed[mailed.length - 1].subject).split(" ")[0];
  const done = await post(await signedBody({ email: EMAIL, code },
    { route: "identity-verify", dev }), { e, path: "/identity/verify" });
  const body = await done.json();

  const row = await e.DB.prepare("SELECT email_enc FROM identity_emails").bind().first();
  const blob = row ? String(row.email_enc || "") : "";
  t("identity: the verified address is filed", done.status === 200 && blob.length > 0);
  t("identity: filed as ciphertext, not as an address",
    !blob.includes(EMAIL) && !blob.includes("at-rest") && !blob.includes("@"), blob.slice(0, 24));
  t("identity: no route hands the address back",
    !JSON.stringify(body).includes(EMAIL) && !JSON.stringify(body).includes("at-rest"));

  /* Round-trips for an operator answering a subject-access request, and for
     nobody else — it is a named export precisely because no handler calls it. */
  const { readEmail } = await import("../server/entitlement-worker.js");
  const emailFp = String((await e.DB.prepare("SELECT email_fp FROM identity_emails").bind().first()).email_fp);
  t("identity: it round-trips under the right key",
    (await readEmail(e, emailFp)) === EMAIL);
  // Same rows, different SIGNING_KEY: a stolen database is not a mailing list.
  t("identity: a dump without the key decrypts to nothing",
    (await readEmail(env({ DB: e.DB, SIGNING_KEY: "a-different-key" }), emailFp)) === "");
  globalThis.fetch = savedFetch;
}

const BUYER_IDT = idtFor("buyer@example.com");

/* ---------- retention ----------

   Three ledgers had no expiry at all: otp_codes lost a row only when somebody
   touched it, webhook_events grew forever, and the trial/identity tables had no
   sweep despite the privacy page naming 400 days out loud. What must NOT be
   swept matters just as much — a swept revocation is a refunded licence coming
   back to life, and a swept owner row is a buyer who cannot restore. */
{
  const e = env();
  const day = 864e5;
  const old = Date.now() - 500 * day;
  const db = e.DB;
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();

  await run("INSERT INTO nonces (id, expires_at) VALUES (?1, ?2)", "n:old", Date.now() - 1000);
  await run("INSERT INTO nonces (id, expires_at) VALUES (?1, ?2)", "n:live", Date.now() + 6e5);
  await run("INSERT INTO otp_codes (email_fp, code_hash, expires_at, tries, sent_at) VALUES (?1,?2,?3,0,?4)",
    "a".repeat(32), "h", Date.now() - 1000, old);
  await run("INSERT INTO webhook_events (id, at) VALUES (?1, ?2)", "wh:old", Date.now() - 90 * day);
  await run("INSERT INTO webhook_events (id, at) VALUES (?1, ?2)", "wh:new", Date.now());
  await run("INSERT INTO seats (key_fp, dev_fp, last_seen) VALUES (?1, ?2, ?3)", "k1", "d1", old);
  await run("INSERT INTO trials (dev_fp, started_at) VALUES (?1, ?2)", "d-old", old);
  await run("INSERT INTO trials_id (email_fp, started_at) VALUES (?1, ?2)", "b".repeat(32), old);
  await run("INSERT INTO identities (email_fp, first_seen, via) VALUES (?1, ?2, 'otp')", "b".repeat(32), old);
  /* An ancient identity that still owns something. It is the only thing between
     that buyer and a purchase they cannot get back, so it stays. */
  await run("INSERT INTO identities (email_fp, first_seen, via) VALUES (?1, ?2, 'otp')", "c".repeat(32), old);
  await run("INSERT INTO owners (key_fp, email_fp, lic_enc, bound_at) VALUES (?1, ?2, 'x', ?3)",
    "k9", "c".repeat(32), old);
  await run("INSERT INTO revocations (key_fp, reason, at) VALUES (?1, 'refund', ?2)", "k9", old);
  /* A settled order is the receipt behind a support mail. It used to be swept
     on ORDER_TTL_MS — the 24 hours an UNPAID order is worth keeping — so the
     record of a real sale was gone the next day. */
  await run("INSERT INTO orders (ref, dev_fp, state, created_at, updated_at) VALUES (?1, 'd', 'claimed', ?2, ?3)",
    "o-yesterday", old, Date.now() - 30 * 3600e3);
  await run("INSERT INTO orders (ref, dev_fp, state, created_at, updated_at) VALUES (?1, 'd', 'claimed', ?2, ?3)",
    "o-ancient", old, Date.now() - 200 * day);
  await run("INSERT INTO orders (ref, dev_fp, state, created_at, updated_at) VALUES (?1, 'd', 'created', ?2, ?3)",
    "o-abandoned", old, old);
  await run("INSERT INTO pending_keys (payment_id, lic_key, key_fp, at) VALUES (?1, 'enc1:x', 'kf', ?2)",
    "pk-recent", Date.now() - 30 * 3600e3);
  await run("INSERT INTO pending_keys (payment_id, lic_key, key_fp, at) VALUES (?1, 'enc1:x', 'kf', ?2)",
    "pk-ancient", Date.now() - 200 * day);

  await worker.scheduled({}, e, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 10));

  const count = async (sql, ...args) =>
    Number((await db.prepare(sql).bind(...args).first()).n);

  t("sweep: expired nonces go, live ones stay",
    (await count("SELECT COUNT(*) AS n FROM nonces WHERE id = ?1", "n:old")) === 0 &&
    (await count("SELECT COUNT(*) AS n FROM nonces WHERE id = ?1", "n:live")) === 1);
  t("sweep: an expired code is not left lying in the table",
    (await count("SELECT COUNT(*) AS n FROM otp_codes")) === 0);
  t("sweep: webhook receipts age out, recent ones do not",
    (await count("SELECT COUNT(*) AS n FROM webhook_events WHERE id = ?1", "wh:old")) === 0 &&
    (await count("SELECT COUNT(*) AS n FROM webhook_events WHERE id = ?1", "wh:new")) === 1);
  t("sweep: a seat nobody has used in 400 days is released",
    (await count("SELECT COUNT(*) AS n FROM seats")) === 0);
  t("sweep: trial rows past the retention the privacy page names are gone",
    (await count("SELECT COUNT(*) AS n FROM trials")) === 0 &&
    (await count("SELECT COUNT(*) AS n FROM trials_id")) === 0);
  t("sweep: an identity that owns nothing ages out",
    (await count("SELECT COUNT(*) AS n FROM identities WHERE email_fp = ?1", "b".repeat(32))) === 0);
  t("sweep: an identity that OWNS a licence is kept, whatever its age",
    (await count("SELECT COUNT(*) AS n FROM identities WHERE email_fp = ?1", "c".repeat(32))) === 1);
  t("sweep: ownership is never swept — it is what makes a reinstall find Pro",
    (await count("SELECT COUNT(*) AS n FROM owners")) === 1);
  t("sweep: a revocation is permanent; a refund does not expire",
    (await count("SELECT COUNT(*) AS n FROM revocations")) === 1);
  t("sweep: yesterday's completed sale is still on file — support has 180 days, not one",
    (await count("SELECT COUNT(*) AS n FROM orders WHERE ref = ?1", "o-yesterday")) === 1);
  t("sweep: a settled order past the support window is gone",
    (await count("SELECT COUNT(*) AS n FROM orders WHERE ref = ?1", "o-ancient")) === 0);
  t("sweep: an order nobody ever paid for is still litter after a day",
    (await count("SELECT COUNT(*) AS n FROM orders WHERE ref = ?1", "o-abandoned")) === 0);
  t("sweep: a key parked yesterday is kept; its order may still arrive",
    (await count("SELECT COUNT(*) AS n FROM pending_keys WHERE payment_id = ?1", "pk-recent")) === 1);
  t("sweep: a key parked 200 days ago is not held forever",
    (await count("SELECT COUNT(*) AS n FROM pending_keys WHERE payment_id = ?1", "pk-ancient")) === 0);
}

/* ---------- one owner per licence ----------

   A licence key is a bearer secret: it leaks through a screenshot, a shared
   machine, a resale. Writing an owner row on EVERY successful check meant the
   stranger who activated a leaked key became an owner of it too — which bought
   them the right to evict the buyer's seats indefinitely, and a /restore that
   hands them the key forever. First identity to present it owns it. */
{
  const e = env();
  stubDodo({ status: 200, body: { valid: true, customer: { email: "buyer@example.com" } } });
  const STRANGER_IDT = idtFor("stranger@example.com");
  const emailFp = (address) => createHash("sha256").update("lct-identity-v1:" + address)
    .digest().subarray(0, 16).toString("hex");

  t("owner: the buyer's check succeeds",
    (await post(await signedBody({ idt: BUYER_IDT }), { e })).status === 200);
  t("owner: a stranger presenting the same key is still served — the key IS valid",
    (await post(await signedBody({ idt: STRANGER_IDT }), { e })).status === 200);

  const owners = (await e.DB.prepare("SELECT email_fp FROM owners").bind().all()).results;
  t("owner: exactly one identity owns the licence", owners.length === 1, JSON.stringify(owners));
  t("owner: and it is the first to present it, not the last",
    owners[0] && owners[0].email_fp === emailFp("buyer@example.com"),
    JSON.stringify(owners));
}

/* ---------- the outermost catch ----------

   Everything in the worker is careful except, until now, the edge of it: an
   unexpected throw became a bare runtime 500 with no CORS headers, which the
   extension cannot read and reports as an outage. A licensing failure that is
   indistinguishable from a network failure is the worst shape it can take. */
{
  /* A deploy whose bindings never arrived. Every property read on `env` throws,
     which is precisely the shape the ladder below cannot anticipate — and the
     one that used to leave the runtime to answer with a bare 500. Called
     through worker.fetch rather than the post() helper, whose default argument
     would quietly substitute a working environment. */
  const bare = new Request("https://issuer.example/trial", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(await signedBody({}, { route: "trial", dev: DEVICE }))
  });
  let res;
  try { res = await worker.fetch(bare, undefined); }
  catch (err) { res = { status: 0, note: String(err && err.message) }; }
  t("handler: a request with no environment at all is answered, not dropped",
    res.status === 403 || res.status === 503, JSON.stringify(res.status || res));

  /* The same, one layer out: the environment is an object but every read on it
     throws. Nothing below can catch that; the wrapper has to. */
  const hostile = new Proxy({}, { get() { throw new Error("binding unavailable"); } });
  let res2;
  try { res2 = await worker.fetch(bare.clone(), hostile); }
  catch (err) { res2 = { status: 0, note: String(err && err.message) }; }
  t("handler: an environment that throws on every read is still an answer",
    res2.status === 403 || res2.status === 503, JSON.stringify(res2.status || res2));
}

/* ---------- checkout ----------

   The route that replaced a payment link pasted into a static web page. What
   these assert, in order: that the extension cannot be handed a URL to send a
   buyer to unless it is the provider's own; that our order ref reaches the
   provider so the webhook can find its way home; that the webhook is what
   delivers rather than a redirect; that a key is handed back ONCE and only to
   the device that opened the order; and that a lost webhook does not strand a
   purchase. Each of those is a way the old design lost money. */

/** Stub for the checkout endpoints. GETs carry no body, which the older stub
    above would have thrown on. */
function stubCheckout({ checkout, keys } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
    if (u.includes("/checkouts")) {
      const a = checkout || { status: 200, body: { session_id: "cks_1", checkout_url: "https://checkout.dodopayments.com/c/cks_1" } };
      if (a.throw) throw new Error("network");
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/license_keys")) {
      const a = keys || { status: 200, body: { items: [] } };
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

const PRODUCT = "pdt_test_0001";
const checkoutEnv = (over = {}) => env({ DODO_PRODUCT_ID: PRODUCT, RETURN_URL: "https://tvara-app.github.io/thanks.html", ...over });

const openCheckout = async (e, dev = DEVICE) =>
  post(await signedBody({ idt: BUYER_IDT }, { route: "checkout", dev }), { e, path: "/checkout" });

{
  const e = checkoutEnv();
  const calls = stubCheckout();
  const res = await openCheckout(e);
  const body = await res.json();
  t("checkout: opens a session and returns a URL and a ref",
    res.status === 200 && /^https:\/\/checkout\.dodopayments\.com\//.test(body.url) &&
    /^[a-f0-9]{32}$/.test(body.ref), JSON.stringify(body));
  const sent = calls.find((c) => c.url.includes("/checkouts"));
  t("checkout: the product is the ISSUER'S, not the client's",
    sent && sent.body.product_cart[0].product_id === PRODUCT, JSON.stringify(sent && sent.body));
  t("checkout: our order ref rides in the provider's metadata",
    sent && sent.body.metadata.tv_ref === body.ref && sent.body.metadata.tv_dev === DEVICE.fp);
  t("checkout: the return URL carries no licence key",
    sent && !/key=/i.test(String(sent.body.return_url || "")), String(sent && sent.body.return_url));
  t("checkout: the same intent is idempotent upstream",
    sent && sent.headers["Idempotency-Key"] === body.ref);

  /* No sale to an anonymous device. A licence bought without an identity gets
     no owner row, and its buyer has nothing to restore from after a reinstall
     except the key in their email — which is the problem the identity anchor
     exists to remove, not one to sell someone. */
  const anon = await post(await signedBody({}, { route: "checkout", dev: DEVICE }),
    { e, path: "/checkout" });
  t("checkout: a device with no verified address is refused",
    anon.status === 401 && (await anon.json()).error === "unverified");
}

{
  // A URL is an instruction to send someone somewhere to type a card number.
  // "The upstream said so" is not a reason to pass one on.
  const e = checkoutEnv();
  stubCheckout({ checkout: { status: 200, body: { session_id: "x", checkout_url: "https://evil.example/pay" } } });
  const res = await openCheckout(e);
  t("checkout: a URL that is not the provider's is refused, not forwarded", res.status === 503);
}

{
  const e = checkoutEnv({ DODO_PRODUCT_ID: "" });
  stubCheckout();
  const res = await openCheckout(e);
  const body = await res.json();
  t("checkout: nothing configured to sell says so, distinctly from an outage",
    res.status === 503 && body.error === "store closed", JSON.stringify(body));
}

{
  const e = checkoutEnv();
  stubCheckout();
  const res = await openCheckout(e, await makeDevice());
  t("checkout: needs no licence — it is the route you take without one", res.status === 200);
}

/* ---------- claim ---------- */

const claim = async (e, ref, dev = DEVICE) =>
  post(await signedBody({ ref }, { route: "checkout-claim", dev }), { e, path: "/checkout/claim" });

{
  const e = checkoutEnv();
  stubCheckout();
  const ref = (await (await openCheckout(e)).json()).ref;

  const before = await (await claim(e, ref)).json();
  t("claim: an unpaid order hands back nothing", before.state === "pending" && !before.key,
    JSON.stringify(before));

  e.DB.sqlite.prepare("UPDATE orders SET state='fulfilled', lic_key='LCT-BOUGHT-0001' WHERE ref=?").run(ref);

  const first = await (await claim(e, ref)).json();
  t("claim: the device that opened the order gets the key",
    first.state === "ready" && first.key === "LCT-BOUGHT-0001", JSON.stringify(first));

  const second = await (await claim(e, ref)).json();
  t("claim: and only once — a second ask carries nothing",
    second.state === "claimed" && !second.key, JSON.stringify(second));

  const row = e.DB.sqlite.prepare("SELECT lic_key FROM orders WHERE ref=?").get(ref);
  t("claim: the key does not stay at rest after it is delivered", row.lic_key === null);
}

{
  /* The SEALED form, which is what a real fulfilment now writes. An order that
     is fulfilled and never claimed used to hold a plaintext bearer secret for
     as long as the row lived; sealing it is worth nothing unless the buyer's
     one claim still hands back something they can actually activate. */
  const e = checkoutEnv();
  stubCheckout();
  const ref = (await (await openCheckout(e)).json()).ref;

  const material = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode("lct-owner-v1:" + SIGNING_KEY));
  const cipher = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" },
    false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cipher,
    new TextEncoder().encode("LCT-SEALED-0002")));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0); blob.set(ct, iv.length);

  e.DB.sqlite.prepare("UPDATE orders SET state='fulfilled', lic_key=? WHERE ref=?")
    .run("enc1:" + b64u(blob), ref);

  const got = await (await claim(e, ref)).json();
  t("claim: a SEALED key is unsealed for the buyer who claims it",
    got.state === "ready" && got.key === "LCT-SEALED-0002", JSON.stringify(got));
  t("claim: ...and the ciphertext never reaches the client",
    !JSON.stringify(got).includes("enc1:"));
}

{
  /* THE ONE THAT MATTERS. A ref is not a secret and is not treated as one: it
     is worthless without the non-extractable device key that opened the order.
     Someone else's order has to read exactly like one that never existed. */
  const e = checkoutEnv();
  stubCheckout();
  const ref = (await (await openCheckout(e)).json()).ref;
  e.DB.sqlite.prepare("UPDATE orders SET state='fulfilled', lic_key='LCT-BOUGHT-0001' WHERE ref=?").run(ref);

  const thief = await makeDevice();
  const res = await (await claim(e, ref, thief)).json();
  t("claim: another device holding the ref gets nothing and learns nothing",
    res.state === "unknown" && !res.key, JSON.stringify(res));

  const mine = await (await claim(e, ref)).json();
  t("claim: …and the real buyer's key is still there afterwards", mine.state === "ready");
}

{
  // A refund taken in the seconds before the first claim must not still deliver.
  const e = checkoutEnv();
  stubCheckout();
  const ref = (await (await openCheckout(e)).json()).ref;
  e.DB.sqlite.prepare("UPDATE orders SET state='fulfilled', lic_key='LCT-BOUGHT-0001' WHERE ref=?").run(ref);
  // …and then the refund webhook lands before the buyer's tab got a claim in.
  e.DB.sqlite.prepare("UPDATE orders SET state='refunded', lic_key=NULL WHERE ref=?").run(ref);
  const res = await (await claim(e, ref)).json();
  t("claim: a refunded order delivers nothing", res.state === "refunded" && !res.key, JSON.stringify(res));
}

{
  /* The webhook was lost. Push-only fulfilment is how a payment system quietly
     stops delivering, so the worker goes and asks. */
  const e = checkoutEnv();
  stubCheckout();
  const ref = (await (await openCheckout(e)).json()).ref;
  const old = Date.now() - 60000;
  e.DB.sqlite.prepare(
    "UPDATE orders SET state='paid', payment_id='pay_9', customer='cus_9', updated_at=? WHERE ref=?"
  ).run(old, ref);

  stubCheckout({ keys: { status: 200, body: { items: [
    { key: "LCT-OTHER-0002", payment_id: "pay_other" },
    { key: "LCT-PULLED-0003", payment_id: "pay_9" }
  ] } } });

  const res = await (await claim(e, ref)).json();
  t("claim: a lost webhook is recovered by asking the provider directly",
    res.state === "ready" && res.key === "LCT-PULLED-0003", JSON.stringify(res));
}

{
  const e = checkoutEnv();
  stubCheckout();
  const res = await post(await signedBody({ ref: "not-a-ref" }, { route: "checkout-claim" }),
    { e, path: "/checkout/claim" });
  t("claim: a malformed ref is refused before any lookup", res.status === 400);
}

/* ORDER_TTL_MS is how long an UNPAID order is worth keeping. Applying it to
   every state told a buyer whose webhook was slow that their purchase had
   expired — while the money had already moved. */
{
  const e = checkoutEnv();
  stubCheckout();
  const REF = "c".repeat(32);
  const stale = Date.now() - 30 * 3600e3;
  await e.DB.prepare(
    "INSERT INTO orders (ref, dev_fp, state, payment_id, created_at, updated_at) " +
    "VALUES (?1, ?2, 'paid', ?3, ?4, ?5)"
  ).bind(REF, DEVICE.fp, "pay_slow_webhook", stale, stale).run();
  const res = await post(await signedBody({ ref: REF }, { route: "checkout-claim" }),
    { e, path: "/checkout/claim" });
  const body = await res.json();
  t("claim: a PAID order older than a day still reports paid, never expired",
    res.status === 200 && body.state === "paid", JSON.stringify(body));
}

/* ---------- sessions: the heartbeat that makes termination mean something ----
 *
 * The bug under test is the one that made the device screen theatre: releasing
 * a seat freed a slot and the released machine kept working for the rest of its
 * 30-day token, because nothing made it ask. Every assertion below is either
 * "it now finds out" or "it must not find out from an outage".
 */

const heartbeat = async (e, over = {}, opts = {}) =>
  post(await signedBody(over, { route: "session", ...opts }), { e, path: "/session" });

{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  const keyFp = await keyFpOf(KEY);

  t("session: an unseated device is not signed in",
    (await (await heartbeat(e)).json()).live === false);

  await post(await signedBody(), { e });      // claim the seat

  const alive = await heartbeat(e);
  t("session: a seated device is live", (await alive.json()).live === true, String(alive.status));

  const row = e.DB.sqlite.prepare("SELECT * FROM sessions WHERE dev_fp = ?").get(DEVICE.fp);
  t("session: activating writes the row the device screen reads", !!row);
  t("session: the session names the licence it is standing on", row && row.key_fp === keyFp);

  // The headline: release the seat, and the released machine finds out.
  e.RL.map.clear();                          // the mirror is a 60s cache, not the answer
  await post(await signedBody({ target: DEVICE.fp }, { route: "devices-revoke" }),
    { e, path: "/devices/revoke" });
  const after = await heartbeat(e);
  const body = await after.json();
  t("session: a released seat signs the device out", body.live === false, JSON.stringify(body));
  t("session: releasing takes the session row with it",
    !e.DB.sqlite.prepare("SELECT 1 FROM sessions WHERE dev_fp = ?").get(DEVICE.fp));
  t("session: the reason is one the popup can print", body.reason === "terminated");

  // ... and can be activated again. A termination is not a ban.
  const back = await post(await signedBody(), { e });
  t("session: the same device may be activated again", back.status === 200);
  t("session: and is live once more", (await (await heartbeat(e)).json()).live === true);
}

/* An outage is not a verdict. This is the assertion the whole design hangs on:
   a ledger we cannot read must never be able to sign a paying customer out. */
{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  await post(await signedBody(), { e });
  e.RL.map.clear();
  e.DB = d1({ broken: true });
  const res = await heartbeat(e);
  t("session: a broken ledger answers 503", res.status === 503, String(res.status));
  t("session: and never says live:false", (await res.json()).live === undefined);
}

{
  const e = env({ DB: null });
  stubDodo({ status: 200, body: { valid: true } });
  const res = await heartbeat(e);
  t("session: no database at all degrades open", (await res.json()).live === true, String(res.status));
}

/* A device whose seat predates this table must not read as signed out on the
   day the feature ships. */
{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  const keyFp = await keyFpOf(KEY);
  const old = Date.now() - 40 * 864e5;
  e.DB.sqlite.prepare("INSERT INTO seats (key_fp, dev_fp, last_seen) VALUES (?, ?, ?)")
    .run(keyFp, DEVICE.fp, old);

  t("session: a seat with no session row is adopted, not evicted",
    (await (await heartbeat(e)).json()).live === true);
  const row = e.DB.sqlite.prepare("SELECT claimed_at FROM sessions WHERE dev_fp = ?").get(DEVICE.fp);
  t("session: the adopted row inherits the seat's age, not today's date",
    row && Number(row.claimed_at) === old, row && String(row.claimed_at));
}

/* The two account-scoped kills the device screen will write. Enforced now so
   that route is a pure addition rather than a second place to get this wrong. */
{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  const keyFp = await keyFpOf(KEY);
  await post(await signedBody(), { e });
  e.RL.map.clear();

  e.DB.sqlite.prepare("INSERT INTO session_kills (scope, dev_fp, at, by) VALUES (?, ?, ?, ?)")
    .run(keyFp, DEVICE.fp, Date.now() + 1000, "owner");
  t("session: a kill newer than the claim signs the device out",
    (await (await heartbeat(e)).json()).live === false);

  // Deliberately re-activated afterwards: a newer claim outranks the old kill,
  // with no tombstone to clean up.
  e.DB.sqlite.prepare("UPDATE sessions SET claimed_at = ? WHERE dev_fp = ?")
    .run(Date.now() + 5000, DEVICE.fp);
  e.RL.map.clear();
  t("session: re-activating after a kill is live again",
    (await (await heartbeat(e)).json()).live === true);
}

{
  const e = env();
  stubDodo({ status: 200, body: { valid: true, customer: { email: "buyer@example.com" } } });
  await post(await signedBody(), { e });
  const emailFp = "f".repeat(32);
  e.DB.sqlite.prepare("UPDATE sessions SET email_fp = ? WHERE dev_fp = ?").run(emailFp, DEVICE.fp);
  e.DB.sqlite.prepare("INSERT INTO account_state (email_fp, epoch, version, updated_at) VALUES (?, ?, 1, ?)")
    .run(emailFp, Date.now() + 1000, Date.now());
  e.RL.map.clear();
  const body = await (await heartbeat(e)).json();
  t("session: sign-out-everywhere reaches a device by epoch alone", body.live === false);
  t("session: and says which of the two happened", body.reason === "signed-out");
}

{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  await post(await signedBody(), { e });
  e.DB.sqlite.prepare("INSERT INTO revocations (key_fp, reason, at) VALUES (?, ?, ?)")
    .run(await keyFpOf(KEY), "refunded", Date.now());
  e.RL.map.clear();
  const body = await (await heartbeat(e)).json();
  t("session: a refunded licence answers the heartbeat rather than erroring",
    body.live === false && body.reason === "revoked", JSON.stringify(body));
}

{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  const res = await heartbeat(e, { sig: "A".repeat(86) });
  t("session: an unsigned heartbeat is refused like every other route", res.status === 401);
}

/* Heartbeats are frequent by design. Sharing RL_MAX would let five devices
   exhaust a licence's hourly budget and then be refused the very call that
   tells them they are still signed in. */
{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  await post(await signedBody(), { e });
  let worst = 200;
  for (let i = 0; i < 25; i++) {
    e.RL.map.delete(`live:${await keyFpOf(KEY)}:${DEVICE.fp}`);
    worst = Math.max(worst, (await heartbeat(e)).status);
  }
  t("session: 25 heartbeats do not exhaust the per-key entitlement budget", worst === 200, String(worst));
}

/* What the device screen will show. `label` is the one field a person picks,
   so it is also the one that must not sit in the ledger in the clear. */
{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  await post(await signedBody({ plat: "macOS · Chrome", label: "Work laptop" }), { e });
  const row = e.DB.sqlite.prepare("SELECT plat, label_enc FROM sessions WHERE dev_fp = ?").get(DEVICE.fp);
  t("session: the platform string is kept for the device screen", row && row.plat === "macOS · Chrome");
  t("session: the label is sealed, not stored in the clear",
    row && row.label_enc && !String(row.label_enc).includes("Work laptop"));
}

{
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  await post(await signedBody({ plat: "<img src=x onerror=alert(1)>" }), { e });
  const row = e.DB.sqlite.prepare("SELECT plat FROM sessions WHERE dev_fp = ?").get(DEVICE.fp);
  t("session: a markup platform string is stripped before it is stored",
    row && !/[<>]/.test(String(row.plat)), row && String(row.plat));
}

/* ---------- the device screen ----------
 *
 * Account-scoped, multi-target, and transactional. The failure this is written
 * against is the one a device manager makes look easy: three devices selected,
 * two signed out, one left running because the third request never landed.
 */

/* The existing idtFor() folds an ADDRESS; these tests need a chosen efp and a
   chosen age, because "sign out everything" turns on how old the token is. */
const idtRaw = (emailFp, iat = Date.now()) => {
  const payload = Buffer.from(JSON.stringify({
    v: 1, efp: emailFp, iat, exp: Date.now() + 400 * 864e5
  }));
  const mac = createHmac("sha256", createHash("sha256")
    .update("lct-identity-mac-v1:" + SIGNING_KEY).digest())
    .update(payload).digest();
  return `LCTID1.${b64u(payload)}.${b64u(mac)}`;
};

const ACCOUNT = "a".repeat(32);
/** Three devices on one licence, all owned by ACCOUNT. */
async function seededAccount() {
  const e = env();
  stubDodo({ status: 200, body: { valid: true } });
  const keyFp = await keyFpOf(KEY);
  const devs = [DEVICE, await makeDevice(), await makeDevice()];
  for (const d of devs) await post(await signedBody({}, { dev: d }), { e });
  e.DB.sqlite.prepare(
    "INSERT INTO owners (key_fp, email_fp, lic_enc, bound_at) VALUES (?, ?, NULL, ?)"
  ).run(keyFp, ACCOUNT, Date.now());
  return { e, keyFp, devs };
}

{
  const { e, devs } = await seededAccount();
  const res = await post(await signedBody({ idt: idtRaw(ACCOUNT) }, { route: "sessions" }),
    { e, path: "/sessions" });
  const body = await res.json();
  t("screen: the list is the account's, not one licence's",
    res.status === 200 && body.devices.length === 3, JSON.stringify(body).slice(0, 160));
  t("screen: the caller's own device is marked",
    body.devices.filter((d) => d.self).length === 1);
  t("screen: a device activated from a pasted key is attached to the account",
    body.devices.every((d) => d.pro === true));
  t("screen: the list carries a version to terminate against",
    typeof body.version === "number");
  t("screen: no licence key is ever handed back",
    !JSON.stringify(body).includes(KEY));

  const anon = await post(await signedBody({}, { route: "sessions" }), { e, path: "/sessions" });
  t("screen: without an identity there is no list", anon.status === 401);
  void devs;
}

/* Multi-select is the feature. One call, one transaction, or two devices are
   signed out and the third is still running. */
{
  const { e, keyFp, devs } = await seededAccount();
  const targets = [devs[1].fp, devs[2].fp];
  const res = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: "1".repeat(32), targets }, { route: "sessions-terminate" }),
    { e, path: "/sessions/terminate" });
  const body = await res.json();
  t("screen: two devices are signed out in one call",
    res.status === 200 && body.terminated.length === 2, JSON.stringify(body).slice(0, 160));
  t("screen: their seats are released with them",
    Number(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM seats WHERE key_fp = ?").get(keyFp).n) === 1);
  t("screen: the version moves so a stale screen cannot act on it", body.version === 1);
  t("screen: the device doing the terminating is untouched",
    body.devices.length === 1 && body.devices[0].self === true);

  // Each terminated device now finds out, which is the whole point.
  e.RL.map.clear();
  const hb = await post(await signedBody({}, { route: "session", dev: devs[1] }),
    { e, path: "/session" });
  t("screen: a signed-out device learns it at its next heartbeat",
    (await hb.json()).live === false);

  // ...and cannot quietly take the seat back on its next renewal.
  const sneak = await post(await signedBody({}, { dev: devs[1] }), { e });
  t("screen: a silent renewal does not undo the sign-out", sneak.status === 403,
    String(sneak.status));
  t("screen: and says so distinctly from a device-limit refusal",
    (await sneak.json()).error === "signed out");

  // An explicit Activate does, because a termination is not a ban.
  const back = await post(await signedBody({ intent: "activate" }, { dev: devs[1] }), { e });
  t("screen: an explicit re-activation is allowed back in", back.status === 200,
    String(back.status));
}

/* A retry of a call that landed and then lost its connection must not sign out
   a second device. */
{
  const { e, devs } = await seededAccount();
  const op = "2".repeat(32);
  const first = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: op, targets: [devs[1].fp] }, { route: "sessions-terminate" }),
    { e, path: "/sessions/terminate" });
  const again = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: op, targets: [devs[2].fp] }, { route: "sessions-terminate" }),
    { e, path: "/sessions/terminate" });
  const a = await first.json(), b = await again.json();
  t("screen: a repeated op_id replays its own answer",
    b.replayed === true && JSON.stringify(b.terminated) === JSON.stringify(a.terminated));
  t("screen: and signs out nothing the second time",
    b.devices.length === 2, JSON.stringify(b.devices.map((d) => d.device)));
}

{
  const { e, devs } = await seededAccount();
  const res = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: "3".repeat(32), targets: [devs[1].fp], if_version: 7 },
    { route: "sessions-terminate" }), { e, path: "/sessions/terminate" });
  const body = await res.json();
  t("screen: a stale screen is refused, not obeyed", res.status === 412);
  t("screen: and is handed the list it should have been looking at",
    body.version === 0 && body.devices.length === 3);
}

{
  const { e, devs } = await seededAccount();
  const res = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: "4".repeat(32), targets: ["b".repeat(32)] },
    { route: "sessions-terminate" }), { e, path: "/sessions/terminate" });
  const body = await res.json();
  t("screen: a device on somebody else's account is a no-op, not an error",
    res.status === 200 && body.terminated.length === 0);
  t("screen: and nothing on this account moved", body.devices.length === 3);
  void devs;
}

/* Sign out of all devices. The irreversible button, so it wants a person at
   the keyboard rather than a 400-day token found in a copied profile. */
{
  const { e } = await seededAccount();
  const stale = await post(await signedBody(
    { idt: idtRaw(ACCOUNT, Date.now() - 60 * 60e3), op_id: "5".repeat(32) },
    { route: "sessions-terminate-all" }), { e, path: "/sessions/terminate-all" });
  t("screen: an hour-old identity cannot sign out every device", stale.status === 401);
  t("screen: and is told to verify again rather than that it failed",
    (await stale.json()).error === "reauth");

  const res = await post(await signedBody({ idt: idtRaw(ACCOUNT), op_id: "6".repeat(32) },
    { route: "sessions-terminate-all" }), { e, path: "/sessions/terminate-all" });
  const body = await res.json();
  t("screen: a fresh identity signs out everything but this device",
    res.status === 200 && body.terminated.length === 2, JSON.stringify(body).slice(0, 140));
  t("screen: the device doing it keeps working", body.devices.length === 1);
  const epoch = e.DB.sqlite.prepare("SELECT epoch FROM account_state WHERE email_fp = ?").get(ACCOUNT);
  t("screen: and the account epoch moves with it", Number(epoch.epoch) > 0);

  /* The epoch says "anything claimed before now is signed out", and the device
     that pressed the button was claimed long before now — so keeping yourself
     signed in has to survive your own sweep. It did not: the five-device run
     against wrangler dev signed the pressing device out of its own account. */
  e.RL.map.clear();
  const mine = await post(await signedBody({}, { route: "session" }), { e, path: "/session" });
  t("screen: signing out every OTHER device does not sign out this one",
    (await mine.json()).live === true, "the survivor's claim must be re-stamped past the new epoch");
  const kept = e.DB.sqlite.prepare("SELECT claimed_at FROM sessions WHERE dev_fp = ?").get(DEVICE.fp);
  t("screen: the surviving device is re-stamped, not just spared",
    Number(kept.claimed_at) >= Number(epoch.epoch));
}

{
  const { e } = await seededAccount();
  const res = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: "7".repeat(32), keep_self: false },
    { route: "sessions-terminate-all" }), { e, path: "/sessions/terminate-all" });
  const body = await res.json();
  t("screen: keep_self:false signs this device out too", body.terminated.length === 3);
  t("screen: leaving nothing on the account", body.devices.length === 0);
}

/* The ledger is the answer; an outage is not. */
{
  const { e } = await seededAccount();
  e.DB = d1({ broken: true });
  const res = await post(await signedBody({ idt: idtRaw(ACCOUNT) }, { route: "sessions" }),
    { e, path: "/sessions" });
  t("screen: a broken ledger answers 503 rather than an empty device list",
    res.status === 503, String(res.status));
}

{
  const { e, devs } = await seededAccount();
  const res = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: "not-hex", targets: [devs[1].fp] },
    { route: "sessions-terminate" }), { e, path: "/sessions/terminate" });
  t("screen: a malformed op id is refused before anything is deleted",
    res.status === 400 && Number(
      e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n) === 3);
}

{
  const { e, devs } = await seededAccount();
  const many = Array.from({ length: 21 }, (_, i) => String(i).padStart(32, "0"));
  const res = await post(await signedBody(
    { idt: idtRaw(ACCOUNT), op_id: "8".repeat(32), targets: many },
    { route: "sessions-terminate" }), { e, path: "/sessions/terminate" });
  t("screen: an oversized target list is refused", res.status === 400);
  void devs;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log("failed:\n  " + failed.join("\n  "));
process.exit(fail ? 1 : 0);
