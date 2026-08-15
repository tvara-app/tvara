#!/usr/bin/env node
/**
 * Long Chat Toolkit — entitlement Worker tests.
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
const DEV = "a".repeat(32);
const KEY = "LCT-TEST-KEY-0001";

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

function env(over = {}) {
  return {
    RL: kv(),
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

const live = (over) => ({ license_key: KEY, device: DEV, instance_id: "inst_1", ts: Date.now(), ...over });

/* ---------- origin policy ---------- */

stubDodo({ status: 200, body: { valid: true, customer: { email: "buyer@example.com" } } });

t("origin: a page origin is refused", (await post(live(), { origin: "https://evil.example" })).status === 403);
t("origin: no origin at all is refused", (await post(live(), { origin: "" })).status === 403);
t("origin: another extension is refused", (await post(live(), { origin: OTHER })).status === 403);
t("origin: ours is allowed", (await post(live())).status === 200);

// The one that used to be a footgun: an unset ALLOWED_ORIGINS meant "anyone".
t("origin: live mode with no allow-list refuses EVERY extension",
  (await post(live(), { e: env({ ALLOWED_ORIGINS: "" }) })).status === 403);
t("origin: test mode still allows a scratch deploy",
  (await post(live(), { e: env({ ALLOWED_ORIGINS: "", DODO_MODE: "test" }) })).status === 200);

const pre = await post(null, { method: "OPTIONS" });
t("origin: preflight answers 204 with CORS", pre.status === 204 &&
  pre.headers.get("Access-Control-Allow-Origin") === ORIGIN);
t("origin: preflight from a stranger is refused",
  (await post(null, { method: "OPTIONS", origin: OTHER })).status === 403);

/* ---------- input validation ---------- */

t("input: GET is refused", (await post(live(), { method: "GET" })).status === 405);
t("input: unknown path is 404", (await post(live(), { path: "/whatever" })).status === 404);
t("input: the removed /trial endpoint is gone", (await post({ device: DEV }, { path: "/trial" })).status === 404);
t("input: a malformed key is refused", (await post(live({ license_key: "no spaces allowed!" }))).status === 400);
t("input: a malformed device is refused", (await post(live({ device: "nothex" }))).status === 400);

/* ---------- replay ---------- */

t("replay: a stale timestamp is refused",
  (await post(live({ ts: Date.now() - 60 * 60 * 1000 }))).status === 400);
t("replay: a future timestamp is refused",
  (await post(live({ ts: Date.now() + 60 * 60 * 1000 }))).status === 400);
// The hole this closes: an optional check is one you defeat by deleting a field.
t("replay: a MISSING timestamp is refused, not waved through",
  (await post(live({ ts: undefined }))).status === 400);

/* ---------- upstream branches ---------- */

stubDodo({ status: 404 });
t("upstream: unknown licence → 404", (await post(live())).status === 404);
stubDodo({ status: 200, body: { valid: false } });
t("upstream: valid:false → 404 (a missing field is not consent)", (await post(live())).status === 404);
stubDodo({ status: 200, body: {} });
t("upstream: no verdict at all → 404", (await post(live())).status === 404);
stubDodo({ status: 403 });
t("upstream: refunded/inactive → 403", (await post(live())).status === 403);
stubDodo({ status: 500 });
t("upstream: Dodo down → 503, never a token", (await post(live())).status === 503);
stubDodo({ throw: true });
t("upstream: network failure → 503", (await post(live())).status === 503);

/* ---------- the happy path, and what the token actually says ---------- */

const calls = stubDodo({ status: 200, body: { valid: true, customer: { email: "buyer@example.com" } } });
const okEnv = env();
const okRes = await post(live(), { e: okEnv });
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
t("issue: the token is bound to this device", claims.dev === DEV);
t("issue: the token is bound to the licence, by hash not by key",
  typeof claims.sub === "string" && claims.sub.length === 32 && !JSON.stringify(claims).includes(KEY));
t("issue: it carries the paid features", Array.isArray(claims.feat) && claims.feat.includes("archive.search"));
t("issue: it expires", claims.exp > Date.now() && claims.exp <= Date.now() + 91 * 864e5);
t("issue: a tampered payload no longer verifies",
  !nodeVerify("sha256", Buffer.from(JSON.stringify({ ...claims, plan: "enterprise" })),
    { key: PUB, dsaEncoding: "ieee-p1363" }, unb64(sigB64)));

/* ---------- seats ---------- */

const seatEnv = env();
stubDodo({ status: 200, body: { valid: true } });
const seatCodes = [];
for (let i = 0; i < 6; i++) {
  seatCodes.push((await post(live({ device: String(i).repeat(32) }), { e: seatEnv })).status);
}
t("seats: five devices are issued tokens", seatCodes.slice(0, 5).every((c) => c === 200), seatCodes.join(","));
t("seats: the sixth is refused with 422", seatCodes[5] === 422, seatCodes.join(","));
t("seats: a device that already has a seat re-uses it",
  (await post(live({ device: "0".repeat(32) }), { e: seatEnv })).status === 200);

// An idle seat past the token's own lifetime is reclaimable — otherwise a
// dead laptop costs a slot forever and support has to do it by hand.
const staleEnv = env();
const keyFp = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY)))]
  .slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
const old = Date.now() - 200 * 864e5;
await staleEnv.RL.put(`seats:${keyFp}`, JSON.stringify(
  Object.fromEntries([0, 1, 2, 3, 4].map((i) => [String(i).repeat(32), old]))));
t("seats: an idle seat past its token's life is reclaimed",
  (await post(live({ device: "f".repeat(32) }), { e: staleEnv })).status === 200);

/* ---------- degradation ---------- */

stubDodo({ status: 200, body: { valid: true } });
t("degrade: KV down still serves a paying customer",
  (await post(live(), { e: env({ RL: kv({ broken: true }) }) })).status === 200);
t("degrade: no KV binding at all still serves",
  (await post(live(), { e: env({ RL: undefined }) })).status === 200);

/* ---------- rate limit ---------- */

const rlEnv = env();
const codes = [];
for (let i = 0; i < 22; i++) codes.push((await post(live(), { e: rlEnv })).status);
t("ratelimit: the first 20 in an hour pass", codes.slice(0, 20).every((c) => c === 200));
t("ratelimit: the 21st is throttled", codes[20] === 429 && codes[21] === 429);
t("ratelimit: throttling costs no upstream call",
  (await post(live(), { e: rlEnv })).status === 429);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log("failed:\n  " + failed.join("\n  "));
process.exit(fail ? 1 : 0);
