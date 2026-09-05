/**
 * The background worker is bg.js PLUS bg/*.js, sharing one global scope.
 *
 * Anything that reads the worker as text — a parser test lifting a function out
 * of it, preflight checking a constant, a fixture rewriting a provider base —
 * must read all of it. Reading bg.js alone after the split checks the router and
 * nothing else, and passes while it does so.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Worker files, relative to `root`, in the order bg.js loads them. */
export function workerFiles(root) {
  const entry = readFileSync(join(root, "bg.js"), "utf8");
  const listed = [];
  const push = (p) => { if (!listed.includes(p)) listed.push(p); };
  for (const call of entry.matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const arg of call[1].matchAll(/["'`](bg\/[^"'`]+)["'`]/g)) push(arg[1]);
  }
  // The list bg.js spreads into importScripts — where bg/ is actually spelled out.
  const block = entry.match(/BG_MODULES\s*=\s*\[([^\]]*)\]/);
  if (block) for (const arg of block[1].matchAll(/["'`](bg\/[^"'`]+)["'`]/g)) push(arg[1]);
  // A module on disk that bg.js never loads is a bug, not something to hide.
  let present = [];
  try { present = readdirSync(join(root, "bg")).filter((f) => f.endsWith(".js")).map((f) => "bg/" + f); }
  catch { /* no bg/ yet */ }
  const missed = present.filter((f) => !listed.includes(f));
  return ["bg.js", ...listed, ...missed];
}

/** Every worker file concatenated, for tests that search the worker as one text. */
export function workerSource(root) {
  return workerFiles(root).map((rel) => readFileSync(join(root, rel), "utf8")).join("\n");
}
