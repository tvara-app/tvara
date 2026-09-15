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
  let depth = 0, i = src.indexOf("{", at), q = "", lc = false, bc = false;
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
  try { const v = Function(`return (${m[2]})`)(); if (typeof v === "number") consts[m[1]] = v; } catch { /* not numeric */ }
}

function pacer(limitMs) {
  const state = { chain: Promise.resolve(), nextAt: 0, fgNextAt: 0, cooldownUntil: 0, consecutiveRate: 0,
    interval: 0, trip: 0, tabOpen: false, activeAt: 0, trips: 0, windowAt: 0, used: 0, concurrency: 0, streak: 0 };
  const known = {
    ...consts,
    hostEntry: () => state,
    policyFor: () => ({ minIntervalMs: consts.BG_MIN_INTERVAL_MS || 500, concurrency: 2 }),
    persistCooldown: async () => {}, persistPace: async () => {}, trace: async () => {}, sleep: async () => {},
    backoffDelay: () => 0,
  };
  const scope = new Proxy(known, {
    has: (o, k) => typeof k === "string" && !(k in globalThis) || k in o,
    get: (o, k) => (k in o ? o[k] : k in globalThis ? globalThis[k] : (() => undefined)),
  });
  const body = ["intervalFloor", "intervalFor", "noteRateLimit", "noteOk"].map(extract).join("\n");
  const make = new Function("scope", `with (scope) { ${body}\n return { intervalFloor, intervalFor, noteRateLimit, noteOk }; }`);
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
