#!/usr/bin/env node
/* Tvara — does opening a site you just signed in to actually re-check it?
 *
 * Found against a real account (2026-09-15): Claude, Grok and Perplexity said
 * "Not signed in" after the user had signed in, because the sync those pages
 * ask for on load was throttled. One timestamp covered all six providers, and
 * it ignored what happened last time — so a provider whose last pass failed was
 * held off exactly as long as one that had just succeeded, while the next
 * automatic pass was three hours away.
 *
 * Runs the REAL visitSync() from the shipped worker, with its REAL constants.
 */
import { join } from "node:path";
import { workerSource } from "../tools/worker-source.mjs";
const ROOT = join(import.meta.dirname, "..");
const src = workerSource(ROOT);
let pass = 0, fail = 0;
const t = (n, ok, got = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok || !got ? "" : "  → " + got}`); };

function extract(name) {
  let at = src.indexOf(`async function ${name}(`); if (at < 0) at = src.indexOf(`function ${name}(`);
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
const consts = {};
for (const m of src.matchAll(/^const (BG_[A-Z0-9_]+) = ([^;\n]+);/gm)) {
  try { const v = Function(`return (${m[2]})`)(); if (["number", "string"].includes(typeof v)) consts[m[1]] = v; } catch {}
}

function worker({ now }) {
  const storage = new Map();
  let ticks = 0;
  const known = {
    ...consts,
    BG_PLATFORM_IDS: new Set(["chatgpt", "claude", "grok", "perplexity", "gemini", "deepseek"]),
    BG_SYNC_PROG: (p) => "recall-sync-progress:" + p,
    autoSyncEnabled: async () => true,
    autoSyncTick: async () => { ticks++; return { status: "ok" }; },
    Date: { now: () => now.value },
    chrome: { storage: { local: {
      get: async (k) => { const keys = Array.isArray(k) ? k : [k]; const o = {}; for (const x of keys) if (storage.has(x)) o[x] = storage.get(x); return o; },
      set: async (o) => { for (const [k, v] of Object.entries(o)) storage.set(k, structuredClone(v)); },
    } } },
  };
  const scope = new Proxy(known, {
    has: (o, k) => typeof k === "string" && (!(k in globalThis) || k in o),
    get: (o, k) => (k in o ? o[k] : k in globalThis ? globalThis[k] : (() => undefined)),
  });
  const visitSync = new Function("scope", `with (scope) { ${extract("visitSync")}\n return visitSync; }`)(scope);
  return { visitSync, storage, ticks: () => ticks, setState: (p, state) => storage.set("recall-sync-progress:" + p, { state, phase: state }) };
}

const MIN = 60 * 1000;
console.log("BG_VISIT_MIN_MS =", consts.BG_VISIT_MIN_MS / MIN, "min");

{
  const now = { value: 1_000_000_000_000 };
  const w = worker({ now });
  await w.visitSync("chatgpt");
  now.value += 1 * MIN;
  await w.visitSync("claude");
  t("opening a DIFFERENT provider is not throttled by the first one", w.ticks() === 2, `${w.ticks()} passes started`);
}
{
  const now = { value: 1_000_000_000_000 };
  const w = worker({ now });
  await w.visitSync("claude");
  w.setState("claude", "error");                 // "Not signed in"
  now.value += 2 * MIN;                          // they sign in, the page reloads
  await w.visitSync("claude");
  t("a provider whose last pass FAILED is re-checked the moment its page loads", w.ticks() === 2, `${w.ticks()} passes started`);
}
{
  const now = { value: 1_000_000_000_000 };
  const w = worker({ now });
  await w.visitSync("claude");
  w.setState("claude", "done");
  now.value += 2 * MIN;
  await w.visitSync("claude");
  t("a provider that just succeeded is still throttled (the floor still works)", w.ticks() === 1, `${w.ticks()} passes started`);
  now.value += consts.BG_VISIT_MIN_MS;
  await w.visitSync("claude");
  t("…and is visited again once the floor has passed", w.ticks() === 2, `${w.ticks()} passes started`);
}
{
  const now = { value: 1_000_000_000_000 };
  const w = worker({ now });
  w.storage.set(consts.BG_VISIT_STATE, { at: now.value });   // a record from the old format
  now.value += 1 * MIN;
  await w.visitSync("chatgpt");
  t("an old single-timestamp record does not throw and still throttles", w.ticks() === 0, `${w.ticks()} passes started`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
