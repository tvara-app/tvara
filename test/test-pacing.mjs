#!/usr/bin/env node
/* Tvara — does the background pacer learn a provider's limit, or fight it?
 *
 * Found against a real ChatGPT account (2026-09-15): four circuit-breaker trips
 * in one session, each escalating a cooldown (15 min, 30, 60, 120…), and 608
 * chats left with no text. The pacer is supposed to converge — refused once, it
 * should settle just slower than the rate that was refused and stay there.
 *
 * This runs the REAL noteRateLimit, noteOk, intervalFor and intervalFloor, with
 * the REAL constants, extracted from the shipped worker, against a provider that
 * refuses any request made faster than a fixed limit. A pacer that learns stops
 * being refused. One that does not is refused forever, and on a real account
 * that is also how an account gets flagged.
 */
import { join } from "node:path";
import { workerSource } from "../tools/worker-source.mjs";

const ROOT = join(import.meta.dirname, "..");
const src = workerSource(ROOT);
let pass = 0, fail = 0;
const t = (n, ok, got = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok || !got ? "" : "  → " + got}`); };

function extract(name) {
  let at = src.indexOf(`async function ${name}(`);
  if (at < 0) at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  // The body starts after the PARAMETER list closes: a default like `opts = {}`
  // holds a brace of its own, and starting at the first "{" sliced that instead.
  let i = src.indexOf("(", at), pd = 0;
  for (; i < src.length; i++) { if (src[i] === "(") pd++; else if (src[i] === ")" && --pd === 0) break; }
  i = src.indexOf("{", i);
  let depth = 0, q = "", lc = false, bc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lc) { if (c === "\n") lc = false; continue; }
    if (bc) { if (c === "*" && n === "/") { bc = false; i++; } continue; }
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = ""; continue; }
    if (c === "/" && n === "/") { lc = true; continue; }
    if (c === "/" && n === "*") { bc = true; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{") depth++; else if (c === "}" && --depth === 0) return src.slice(at, i + 1);
  }
}

// The real numeric constants, evaluated as written.
const consts = {};
for (const m of src.matchAll(/^const (BG_[A-Z0-9_]+) = ([^;\n]+);/gm)) {
  // Numbers AND strings: BG_HOST_COOLDOWN is the storage key the learned rate is
  // saved under, and a harness that dropped it tested persistence against a key
  // that could never be read back.
  try { const v = Function(`return (${m[2]})`)(); if (typeof v === "number" || typeof v === "string") consts[m[1]] = v; } catch { /* not a literal */ }
}

function pacer(limitMs, storage = new Map(), clock = null) {
  const state = { chain: Promise.resolve(), nextAt: 0, fgNextAt: 0, cooldownUntil: 0, consecutiveRate: 0,
    interval: 0, trip: 0, tabOpen: false, activeAt: 0, trips: 0, windowAt: 0, used: 0, concurrency: 0, streak: 0 };
  const known = {
    ...consts,
    hostEntry: () => state,
    policyFor: () => ({ minIntervalMs: consts.BG_MIN_INTERVAL_MS || 500, concurrency: 2 }),
    trace: async () => {}, sleep: async () => {},
    ...(clock ? { Date: { now: () => clock.value } } : {}),
    BgError: class BgError extends Error { constructor(kind, msg, extra) { super(msg); this.kind = kind; Object.assign(this, extra || {}); } },
    // chrome.storage.local, in memory, shared across "workers" by the caller.
    chrome: { storage: { local: {
      get: async (k) => (storage.has(k) ? { [k]: storage.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) storage.set(k, structuredClone(v)); },
    } } },
    backoffDelay: () => 0,
  };
  const scope = new Proxy(known, {
    has: (o, k) => typeof k === "string" && !(k in globalThis) || k in o,
    get: (o, k) => (k in o ? o[k] : k in globalThis ? globalThis[k] : (() => undefined)),
  });
  const names = ["intervalFloor", "intervalFor", "noteRateLimit", "noteOk", "persistCooldown", "loadCooldown", "hostSlot"];
  const body = names.map(extract).join("\n");
  // hostSlot's once-per-worker load cache lives at module level; a fresh one per
  // worker is exactly what a reclaimed worker gets.
  const cache = (src.match(/^const BG_PACE_LOAD = [^;]+;$/m) || [""])[0] + "\n" + (src.match(/^const BG_PACE_READY = [^;]+;$/m) || [""])[0];
  const make = new Function("scope", `with (scope) { ${cache}\n${body}\n return { ${names.join(", ")} }; }`);
  const fns = make(scope);
  return { ...fns, state, limitMs };
}

async function run(limitMs, cycles = 3000) {
  const p = pacer(limitMs);
  const refusedAt = [];
  for (let i = 0; i < cycles; i++) {
    const gap = p.intervalFor("chatgpt.com");
    if (gap < limitMs) { refusedAt.push(i); await p.noteRateLimit("chatgpt.com", 0, 0); }
    else p.noteOk("chatgpt.com");
  }
  const tail = refusedAt.filter((i) => i >= cycles - 2000).length;
  return { refusals: refusedAt.length, lateRefusals: tail, trips: p.state.trips,
           settled: p.intervalFor("chatgpt.com"), floor: p.intervalFloor("chatgpt.com"), trip: p.state.trip };
}

console.log("constants:", JSON.stringify({ BG_MIN_INTERVAL_MS: consts.BG_MIN_INTERVAL_MS, BG_INTERVAL_MAX_MS: consts.BG_INTERVAL_MAX_MS, BG_RAMP_AFTER: consts.BG_RAMP_AFTER }));
for (const limit of [900, 3000, 8000, 12000, 20000]) {
  const r = await run(limit);
  console.log(`\n— a provider that refuses anything faster than one request per ${limit}ms`);
  console.log("  ", JSON.stringify(r));
  t(`it converges: no refusals once it has learned (${limit}ms)`, r.lateRefusals === 0, `${r.lateRefusals} refusals in the last 2000 requests, ${r.refusals} total`);
  t(`…settled at or just slower than the limit, not far slower (${limit}ms)`, r.settled >= limit && r.settled <= limit * 1.6, `settled at ${r.settled}ms`);
  t(`…the learned floor itself is not faster than a refused rate (${limit}ms)`, r.floor >= r.trip || r.trip === 0, `floor ${r.floor}ms vs refused at ${r.trip}ms`);
}
/* The same, the way Chrome actually runs it: the worker is reclaimed and
   replaced between requests, so all that survives is what was written to
   storage. An in-memory pacer that learns proves nothing about this. */
async function runReclaimed(limitMs, cycles = 600) {
  const storage = new Map();
  let refusals = 0, late = 0, p = null;
  for (let i = 0; i < cycles; i++) {
    p = pacer(limitMs, storage);            // a fresh worker, fresh memory
    /* Through hostSlot(), the gate every real request passes — NOT a manual
       loadCooldown(). The first version called loadCooldown() itself and passed
       while the text download, which never did, overwrote the learned rate. */
    await p.hostSlot("chatgpt.com").catch(() => {});
    p.state.cooldownUntil = 0;               // cooldown timing is not under test
    const gap = p.intervalFor("chatgpt.com");
    if (gap < limitMs) { refusals++; if (i >= cycles - 300) late++; await p.noteRateLimit("chatgpt.com", 0, 0); }
    else p.noteOk("chatgpt.com");
  }
  return { refusals, late, settled: p.intervalFor("chatgpt.com") };
}
for (const limit of [3000, 8000, 12000]) {
  const r = await runReclaimed(limit);
  console.log(`\n— reclaimed between every request, limit ${limit}ms`, JSON.stringify(r));
  t(`the learned rate survives the worker being reclaimed (${limit}ms)`, r.late === 0,
    `${r.late} refusals in the last 300 requests, ${r.refusals} total`);
}

{
  /* A save must never lower a learned rate. A worker that has not yet read the
     saved rate back — or re-learns from full speed — must not overwrite 19s
     with 0.5s. Measured on a real account: 18,964ms saved, then 8,000, then 500. */
  const storage = new Map();
  const a = pacer(20000, storage);
  a.state.trip = 18964; a.state.interval = 8000;
  await a.persistCooldown("chatgpt.com", 0);
  const b = pacer(20000, storage);
  b.state.trip = 500; b.state.interval = 500;           // a fresh worker, refused at full speed
  await b.persistCooldown("chatgpt.com", 0);
  const saved = storage.get(consts.BG_HOST_COOLDOWN)["chatgpt.com"];
  t("a save never lowers the learned rate", saved.t === 18964, `saved t=${saved.t}`);
  const c = pacer(20000, storage);
  await c.hostSlot("chatgpt.com").catch(() => {});
  t("a fresh worker's first request is paced by the SAVED rate", c.intervalFor("chatgpt.com") >= 25000,
    `first gap ${c.intervalFor("chatgpt.com")}ms`);
}

/* A learned rate has to be able to RELAX. It only ever rose, so a provider that
   penalised the account for an hour — measured on a real ChatGPT account: refused
   even at 45s apart, floor pinned at 60s — capped that account for good, long
   after the provider was taking requests normally again. Time is simulated, and
   the worker is reclaimed between requests, because a relaxation that lives only
   in memory would repeat the bug fixed in a9e9605. */
{
  const storage = new Map();
  const clock = { value: 1_800_000_000_000 };
  let limit = 30000, refused = 0, refusedAfterLift = 0, lastGap = 0;
  const HOUR = 3600 * 1000;
  const start = clock.value;
  while (clock.value - start < 9 * HOUR) {
    if (clock.value - start >= 2 * HOUR && limit !== 8000) limit = 8000;   // the penalty lifts
    const p = pacer(limit, storage, clock);
    await p.hostSlot("chatgpt.com").catch(() => {});
    p.state.cooldownUntil = 0;
    const gap = p.intervalFor("chatgpt.com");
    if (gap < limit) { refused++; if (limit === 8000) refusedAfterLift++; await p.noteRateLimit("chatgpt.com", 0, 0); }
    else p.noteOk("chatgpt.com");
    lastGap = gap;
    clock.value += Math.max(gap, 500);
  }
  console.log(`\n— penalty at 30s for 2h, then the normal 8s limit for 7h`, JSON.stringify({ refused, refusedAfterLift, finalGap: lastGap }));
  t("after a penalty lifts, the learned rate relaxes back toward the real limit", lastGap <= 8000 * 1.5,
    `still ${lastGap}ms apart, 7 hours after the provider went back to 8s`);
  t("…without hammering it on the way down (refusals stay rare)", refusedAfterLift <= 20,
    `${refusedAfterLift} refusals after the penalty lifted`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
