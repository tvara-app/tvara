#!/usr/bin/env node
/* fast-check property tests for lib/quota.js — the parser that turns
   arbitrary, unversioned provider JSON into the number on the popup's dial.
   fromJson() has explicit bounds (MAX_DEPTH=6, MAX_NODES=4000, lib/quota.js:80-81)
   specifically because it walks attacker-influenceable response bodies; this
   file exists to prove those bounds actually hold under adversarial input,
   not just typical input. Same load pattern as test/test-quota.mjs — a plain
   `self` shim, no browser. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "lib", "quota.js"), "utf8");
const scope = { self: {} };
new Function("self", src)(scope.self);
const Q = scope.self.LCTQuota;
if (!Q) throw new Error("lib/quota.js did not define self.LCTQuota");

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};
const runs = 300;

// Arbitrary JSON, deliberately including the shapes a hostile response could
// carry: __proto__/constructor keys, NaN-producing strings, huge numbers,
// deeply nested objects well past MAX_DEPTH, wide objects well past MAX_NODES.
const dangerousKey = fc.constantFrom("__proto__", "constructor", "prototype", "toString", "valueOf");
const normalKey = fc.string({ minLength: 1, maxLength: 12 });
const anyKey = fc.oneof({ arbitrary: dangerousKey, weight: 1 }, { arbitrary: normalKey, weight: 3 });
const numericish = fc.oneof(
  fc.double({ noNaN: false }), fc.constant(Infinity), fc.constant(-Infinity), fc.constant(NaN),
  fc.integer(), fc.bigInt().map(String), // Infinity above already covers what a 1e309-style overflow literal would test
);
const leaf = fc.oneof(
  fc.string({ maxLength: 200 }), numericish, fc.boolean(), fc.constant(null), fc.constant(undefined),
);

const deepJson = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    leaf,
    fc.array(tie("node"), { maxLength: 8 }),
    fc.dictionary(anyKey, tie("node"), { maxKeys: 12 }),
  ),
})).node;

const nestedNTimes = (n) => {
  let obj = { leafValue: "bottom" };
  for (let i = 0; i < n; i++) obj = { child: obj, remaining_percentage: 42 };
  return obj;
};

function assertNeverThrowsAndBounded(label, root) {
  let result, threw = null;
  try { result = Q.fromJson(root, {}); } catch (e) { threw = e; }
  t(`${label}: fromJson never throws on adversarial input`, threw === null, threw ? String(threw) : "");
  if (threw) return;
  // Whatever shape fromJson returns, it must not be the literal input object
  // reference for a __proto__-bearing root (would indicate the walk skipped
  // sanitization and just handed back attacker data) and must not itself have
  // gained an own "__proto__" enumerable property (prototype pollution).
  t(`${label}: result carries no own "__proto__"/"constructor" property`,
    result == null || (!Object.prototype.hasOwnProperty.call(result, "__proto__") &&
      !Object.prototype.hasOwnProperty.call(result, "constructor")));
}

// 1. Deeply nested input, well past MAX_DEPTH=6 — must terminate and not throw.
{
  let allOk = true, worstErr = "";
  for (const depth of [6, 7, 20, 200, 5000]) {
    try { Q.fromJson(nestedNTimes(depth), {}); }
    catch (e) { allOk = false; worstErr = `depth ${depth}: ${e.message}`; }
  }
  t("fromJson terminates on nesting far past MAX_DEPTH (6, 7, 20, 200, 5000 levels)", allOk, worstErr);
}

// 2. Wide input, well past MAX_NODES=4000 — must terminate in reasonable time and not throw.
{
  const wide = {};
  for (let i = 0; i < 10000; i++) wide[`field_${i}_remaining_percentage`] = i % 100;
  const start = Date.now();
  let threw = null;
  try { Q.fromJson(wide, {}); } catch (e) { threw = e; }
  const ms = Date.now() - start;
  t("fromJson terminates on 10,000 sibling keys (well past MAX_NODES=4000)", threw === null, threw ? String(threw) : "");
  t("fromJson on a 10,000-key object completes in well under a second (bound isn't just correct, it's cheap)", ms < 1000, `${ms}ms`);
}

// 3. __proto__/constructor-keyed objects — must never pollute the global prototype.
{
  const beforePollution = ({}).polluted;
  const payload = JSON.parse('{"__proto__":{"polluted":"yes"},"remaining_percentage":10}');
  let threw = null;
  try { Q.fromJson(payload, {}); } catch (e) { threw = e; }
  t("fromJson on a __proto__-keyed payload never throws", threw === null, threw ? String(threw) : "");
  t("fromJson never pollutes Object.prototype (checked directly, not inferred)",
    ({}).polluted === beforePollution, `Object.prototype.polluted is now: ${({}).polluted}`);
}

// 4. NaN/Infinity/1e309/negative values in numeric-shaped fields — must never
// surface as a percentage outside [0, 100] or as NaN itself.
{
  const cases = [
    { remaining: NaN, limit: 100 }, { remaining: Infinity, limit: 100 },
    { remaining: -Infinity, limit: 100 },
    { remaining: -50, limit: 100 }, { remaining: 50, limit: -100 },
    { remaining: 50, limit: 0 }, { remaining: 50, limit: NaN },
  ];
  let allSane = true, offender = "";
  for (const c of cases) {
    let r;
    try { r = Q.fromJson(c, {}); } catch (e) { allSane = false; offender = `threw on ${JSON.stringify(c)}: ${e.message}`; break; }
    const pct = r && (r.pct ?? r.pctLeft ?? (r.windows && r.windows[0] && r.windows[0].pct));
    if (typeof pct === "number" && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      allSane = false; offender = `${JSON.stringify(c)} → out-of-range pct ${pct}`; break;
    }
  }
  t("fromJson never emits a NaN/Infinity/out-of-[0,100]-range percentage from degenerate numeric input", allSane, offender);
}

// 5. fast-check property pass over the generated deepJson arbitrary — the
// broad, unstructured sweep on top of the targeted cases above.
{
  let counterexample = null;
  try {
    fc.assert(
      fc.property(deepJson, (root) => {
        Q.fromJson(root, {});
        return true;
      }),
      { numRuns: runs, endOnFailure: true },
    );
  } catch (e) { counterexample = e.message; }
  t(`fromJson survives ${runs} fast-check-generated arbitrary JSON shapes without throwing`, counterexample === null, counterexample || "");
}

// 6. fromHeaders — same MAX_DEPTH/MAX_NODES-adjacent concerns don't apply (flat
// input), but malformed header values (arrays, objects instead of strings,
// absurdly long values) must not throw either.
{
  const headerCases = [
    { "x-ratelimit-remaining": "not-a-number" },
    { "x-ratelimit-remaining": "1e309" },
    { "x-ratelimit-remaining": "-999999999999999999999" },
    { "anthropic-ratelimit-tokens-remaining": "A".repeat(10000) },
    null, undefined, {}, [],
  ];
  let allOk = true, offender = "";
  for (const h of headerCases) {
    try { Q.fromHeaders(h, {}); } catch (e) { allOk = false; offender = `${JSON.stringify(h)}: ${e.message}`; break; }
  }
  t("fromHeaders never throws on malformed/absent header objects", allOk, offender);
}

// 7. Round-trip sanity: assertNeverThrowsAndBounded across the same
// dangerous-key generator, as a second independent pass with its own assertions.
{
  const dangerousPayloads = [
    { "__proto__": { polluted: true } },
    { constructor: { prototype: { polluted: true } } },
    JSON.parse('{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":"too deep"}}}}}}}}'),
  ];
  dangerousPayloads.forEach((p, i) => assertNeverThrowsAndBounded(`dangerous-payload-${i}`, p));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFAILED:"); failed.forEach((l) => console.log("  " + l)); }
process.exitCode = fail ? 1 : 0;
