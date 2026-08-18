#!/usr/bin/env node
/* Long Chat Toolkit — provider allowance parser suite.
 *
 * These parsers decide what percentage the popup draws for somebody's plan, and
 * their failure mode is the dangerous kind: not a crash, but a plausible wrong
 * number. A 5-hour "remaining" divided by a weekly "limit" produces a confident
 * figure that is nonsense, and nothing on screen would look broken.
 *
 * So the cases here are mostly about what the parsers must REFUSE to do:
 * refuse to invent a denominator, refuse to pair fields across windows, refuse
 * to read a bare small integer as a reset time, refuse to keep a percentage
 * whose window has already rolled over. Every one of those refusals is what
 * makes "not reported" appear instead of a made-up number.
 *
 * lib/quota.js is a plain IIFE that assigns self.LCTQuota, so it loads here with
 * nothing but a `self` shim — no browser, no worker, no network.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "lib", "quota.js"), "utf8");
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

const NOW = 1767225600000;                    // fixed clock: 2026-01-01T00:00:00Z
const first = (windows) => (windows && windows.length ? windows[0] : null);
const pctOf = (json) => {
  const w = first(Q.fromJson(json, { now: NOW }));
  return w ? w.pctLeft : undefined;
};

/* ---------- forming a percentage ---------- */

t("remaining/limit becomes a percentage",
  pctOf({ remaining: 31, limit: 45 }) === 69,
  String(pctOf({ remaining: 31, limit: 45 })));

t("used/limit becomes the remainder",
  pctOf({ used: 20, limit: 80 }) === 75,
  String(pctOf({ used: 20, limit: 80 })));

t("a stated remaining-percentage is taken as given",
  pctOf({ remaining_percentage: 62 }) === 62);

t("a stated utilisation is inverted into what is left",
  pctOf({ utilization: 77 }) === 23,
  String(pctOf({ utilization: 77 })));

t("percent_used is inverted too",
  pctOf({ percent_used: 12 }) === 88);

t("a 0..1 fraction scales to a percentage",
  pctOf({ fraction_used: 0.25 }) === 75,
  String(pctOf({ fraction_used: 0.25 })));

t("a stated percentage beats one we could compute",
  // Both present and deliberately inconsistent: the provider's own figure wins.
  pctOf({ remaining_percentage: 40, remaining: 90, limit: 100 }) === 40);

/* ---------- refusing to invent one ---------- */

t("remaining with no denominator yields no percentage",
  (() => {
    const w = first(Q.fromJson({ remaining: 17 }, { now: NOW }));
    return w && w.pctLeft === null && w.remaining === 17;
  })(),
  "a remaining count is not a share of anything");

t("a bare used count with no denominator produces nothing at all",
  // Asymmetric with `remaining` on purpose. "17 remaining" tells a user
  // something even without a ceiling; "300 used" tells them nothing about what
  // is left, so there is no window worth carrying.
  Q.fromJson({ used: 300 }, { now: NOW }).length === 0);

t("a limit of zero is not divided by",
  (() => {
    const w = first(Q.fromJson({ remaining: 0, limit: 0 }, { now: NOW }));
    return w && w.pctLeft === null;
  })());

t("a value over 100 is not a proportion",
  // 4000 tokens remaining is a count that happens to sit under a percent-ish
  // key name; reading it as 4000% would peg every ring full.
  pctOf({ remaining_percentage: 4000 }) === undefined
    || pctOf({ remaining_percentage: 4000 }) === null);

t("a response with nothing quota-shaped yields no windows",
  Q.fromJson({ user: { name: "x" }, items: [1, 2, 3] }, { now: NOW }).length === 0);

t("a nested window does not borrow its parent's limit",
  (() => {
    // Two meters, one nested: the five-hour remaining must not be divided by
    // the weekly ceiling. This is the bug that produces confident nonsense.
    const windows = Q.fromJson({
      weekly: { limit: 1000, used: 100 },
      five_hour: { remaining: 20 }
    }, { now: NOW });
    const five = windows.find((w) => w.path.includes("five_hour"));
    return five && five.pctLeft === null;
  })(),
  "sibling scalars only");

/* ---------- reset times ---------- */

const resetOf = (obj) => {
  const w = first(Q.fromJson(obj, { now: NOW }));
  return w ? w.resetAt : 0;
};

t("an ISO reset parses",
  resetOf({ remaining: 1, limit: 2, resets_at: "2026-01-01T05:00:00Z" }) === NOW + 5 * 3600e3);

t("a zoneless ISO reset is read as UTC-ish rather than dropped",
  resetOf({ remaining: 1, limit: 2, resets_at: "2026-01-01T05:00:00" }) > 0);

t("epoch seconds are scaled to milliseconds",
  resetOf({ remaining: 1, limit: 2, reset: (NOW + 3600e3) / 1000 }) === NOW + 3600e3);

t("epoch milliseconds pass through",
  resetOf({ remaining: 1, limit: 2, reset: NOW + 3600e3 }) === NOW + 3600e3);

t("an explicitly relative reset is offset from now",
  resetOf({ remaining: 1, limit: 2, resets_in_seconds: 600 }) === NOW + 600e3,
  String(resetOf({ remaining: 1, limit: 2, resets_in_seconds: 600 })));

t("a bare small number is not read as a reset time",
  // 300 is neither epoch nor declared relative. Reading it either way gives a
  // date in 1970 or a fabricated window; reporting none is correct.
  resetOf({ remaining: 1, limit: 2, reset: 300 }) === 0);

t("the furthest reset wins over a short retry hint",
  resetOf({
    remaining: 1, limit: 2,
    retry_after: 30, window_end: NOW + 7200e3
  }) === NOW + 7200e3);

/* ---------- headers ---------- */

t("header remaining/limit pair forms a percentage",
  (() => {
    const w = first(Q.fromHeaders({
      "anthropic-ratelimit-unified-remaining": "18",
      "anthropic-ratelimit-unified-limit": "45"
    }, { now: NOW }));
    return w && w.pctLeft === 40;
  })());

t("headers for different windows are not cross-paired",
  (() => {
    // The five-hour meter and the weekly meter arrive in one header block. If
    // the grouping fails, 10/700 renders as 1% left on a window that is 80% full.
    const windows = Q.fromHeaders({
      "anthropic-ratelimit-unified-5h-remaining": "10",
      "anthropic-ratelimit-unified-5h-limit": "50",
      "anthropic-ratelimit-unified-7d-remaining": "600",
      "anthropic-ratelimit-unified-7d-limit": "700"
    }, { now: NOW });
    const five = windows.find((w) => w.key.includes("5h"));
    const week = windows.find((w) => w.key.includes("7d"));
    return windows.length === 2 && five && week
      && five.pctLeft === 20 && week.pctLeft === 86;
  })(),
  JSON.stringify(Q.fromHeaders({
    "anthropic-ratelimit-unified-5h-remaining": "10",
    "anthropic-ratelimit-unified-5h-limit": "50",
    "anthropic-ratelimit-unified-7d-remaining": "600",
    "anthropic-ratelimit-unified-7d-limit": "700"
  }, { now: NOW }).map((w) => [w.key, w.pctLeft])));

t("x-ratelimit spelling is read the same way",
  (() => {
    const w = first(Q.fromHeaders({
      "x-ratelimit-remaining": "5", "x-ratelimit-limit": "20"
    }, { now: NOW }));
    return w && w.pctLeft === 25;
  })());

t("a Headers-like object with forEach is accepted",
  (() => {
    const map = new Map([["ratelimit-remaining", "1"], ["ratelimit-limit", "4"]]);
    const w = first(Q.fromHeaders({ forEach: (fn) => map.forEach((v, k) => fn(v, k)), get: () => null }, { now: NOW }));
    return w && w.pctLeft === 25;
  })());

t("unrelated headers are ignored",
  Q.fromHeaders({ "content-type": "application/json", "x-request-id": "abc" }, { now: NOW }).length === 0);

/* ---------- ranking ---------- */

t("a window with a percentage outranks a bare count",
  (() => {
    const windows = Q.fromJson({
      loose: { remaining: 9 },
      metered: { remaining: 9, limit: 10, resets_at: "2026-01-01T02:00:00Z" }
    }, { now: NOW });
    return windows.length >= 2 && windows[0].pctLeft === 90;
  })());

/* ---------- merging readings ---------- */

const win = (key, pctLeft, resetAt) => ({ key, pctLeft, resetAt, label: key, basis: "remaining/limit" });

t("a fresher reading of the same window replaces the older one",
  (() => {
    const prev = { id: "claude", windows: [{ ...win("5h", 80, NOW + 3600e3), observedAt: NOW - 60e3 }] };
    const merged = Q.merge(prev, {
      id: "claude", windows: [win("5h", 55, NOW + 3600e3)], observedAt: NOW, source: "observed"
    }, { now: NOW });
    return merged.windows.length === 1 && merged.windows[0].pctLeft === 55;
  })());

t("a poll returning one window does not erase another",
  (() => {
    // The five-hour meter came off the send response seconds ago; a poll that
    // only knows about the weekly meter must not drop it.
    const prev = { id: "claude", windows: [{ ...win("5h", 40, NOW + 3600e3), observedAt: NOW - 30e3 }] };
    const merged = Q.merge(prev, {
      id: "claude", windows: [win("7d", 90, NOW + 6 * 86400e3)], observedAt: NOW, source: "polled"
    }, { now: NOW });
    const keys = merged.windows.map((w) => w.key).sort();
    return keys.length === 2 && keys[0] === "5h" && keys[1] === "7d";
  })());

t("a reading older than the stale horizon is dropped, not shown as current",
  (() => {
    const prev = { id: "claude", windows: [{ ...win("5h", 40, NOW + 3600e3), observedAt: NOW - 20 * 3600e3 }] };
    const merged = Q.merge(prev, { id: "claude", windows: [], observedAt: NOW, source: "polled" },
      { now: NOW, staleMs: 12 * 3600e3 });
    return merged.windows.length === 0;
  })());

t("merging records the mechanism that produced the number",
  (() => {
    const merged = Q.merge(null, {
      id: "grok", windows: [win("default", 50, 0)], observedAt: NOW, source: "observed"
    }, { now: NOW });
    return merged.windows[0].source === "observed" && merged.source === "observed";
  })());

/* ---------- choosing what to display ---------- */

t("the primary window is the best-ranked live one",
  (() => {
    const record = { id: "claude", windows: [
      { ...win("5h", 20, NOW + 3600e3), observedAt: NOW },
      { ...win("7d", 90, NOW + 86400e3), observedAt: NOW }
    ] };
    const p = Q.primary(record, { now: NOW });
    return p && p.key === "5h";
  })());

t("a window past its reset is not shown as a percentage",
  (() => {
    // The allowance rolled over and nobody has told us the new figure. "0% left"
    // would be a lie in the most consequential direction.
    const record = { id: "claude", windows: [{ ...win("5h", 0, NOW - 60 * 60e3), observedAt: NOW - 2 * 3600e3 }] };
    return Q.primary(record, { now: NOW }) === null;
  })());

t("a window with no reset time is still displayable",
  (() => {
    const record = { id: "grok", windows: [{ ...win("default", 60, 0), observedAt: NOW }] };
    const p = Q.primary(record, { now: NOW });
    return p && p.pctLeft === 60;
  })());

t("a figure about something else is not presented as your allowance",
  (() => {
    /* Live on a real account, the panel read "Perplexity 100% left" from a
       field called ahrefs-premium-data, 3 of 3. Correctly parsed, and nothing
       to do with the user's chat allowance. */
    const record = { id: "perplexity", windows: [
      { key: "ahrefs-premium-data", pctLeft: 100, resetAt: 0, label: "", unit: "",
        basis: "remaining/limit", path: "$.limits.ahrefs_premium_data", observedAt: NOW }
    ] };
    return Q.primary(record, { now: NOW }) === null;
  })());

t("a reading with no reset goes stale instead of living forever",
  (() => {
    /* Live, the panel showed "Grok 100% left" from a reading five days old,
       drawn exactly like the one taken a minute ago. A window that states no
       reset cannot expire on its own, so it expires on age. */
    const fresh = { id: "grok", windows: [{ ...win("query", 100, 0), observedAt: NOW - 5 * 60e3 }] };
    const old = { id: "grok", windows: [{ ...win("query", 100, 0), observedAt: NOW - 5 * 864e5 }] };
    const p = Q.primary(fresh, { now: NOW });
    return p && p.pctLeft === 100 && Q.primary(old, { now: NOW }) === null;
  })());

t("a partner's quota is not the user's allowance, whichever partner it is",
  (() => {
    // Perplexity's settings response carries one of these per partner, so the
    // panel read ahrefs one minute and apollo the next. Both real, neither ours.
    const one = { id: "perplexity", windows: [
      { key: "apollo-premium-data", pctLeft: 100, resetAt: 0, path: "$.limits.apollo_premium_data", observedAt: NOW }] };
    const two = { id: "perplexity", windows: [
      { key: "ahrefs-premium-data", pctLeft: 100, resetAt: 0, path: "$.limits.ahrefs_premium_data", observedAt: NOW }] };
    // …while a real one still comes through.
    const real = { id: "perplexity", windows: [
      { key: "gpt4-limit", pctLeft: 40, resetAt: 0, path: "$.gpt4_limit", observedAt: NOW }] };
    return Q.primary(one, { now: NOW }) === null && Q.primary(two, { now: NOW }) === null
      && (Q.primary(real, { now: NOW }) || {}).pctLeft === 40;
  })());

t("a partner cannot borrow its parent's name",
  (() => {
    /* Every quota in that response lives under `rate_limits`, so matching the
       PATH let an impostor inherit the word "limit" from its container. */
    const impostor = { id: "perplexity", windows: [
      { key: "bmj", pctLeft: 100, resetAt: 0, path: "$.rate_limits.bmj", observedAt: NOW }] };
    return Q.primary(impostor, { now: NOW }) === null;
  })());

t("a platform we have not characterised is not silenced",
  (() => {
    // The fallback is where every platform started: show it unless it is
    // obviously something else.
    const record = { id: "newcomer", windows: [{ ...win("whatever", 70, 0), observedAt: NOW }] };
    return (Q.primary(record, { now: NOW }) || {}).pctLeft === 70;
  })());

t("a figure outranks a deadline",
  (() => {
    /* Live, ChatGPT's own response carried both: a blocked feature with a reset
       and no number, and "deep_research: 25 remaining". The row showed the
       deadline and called the count nothing. */
    const wins = Q.fromJson({
      blocked_features: [{ name: "reason", resets_after: new Date(NOW + 4 * 864e5).toISOString(), limit: 15 }],
      limits_progress: [{ feature_name: "deep_research", remaining: 25,
        reset_after: new Date(NOW + 36e5).toISOString() }]
    }, { now: NOW });
    const p = Q.primary({ id: "chatgpt", windows: wins, observedAt: NOW }, { now: NOW });
    return p && p.remaining === 25 && p.label === "deep_research";
  })());

t("the best window wins whatever order it arrived in",
  (() => {
    // Windows accumulate from several endpoints and merging appends, so the
    // array order is "who answered first", not "what matters".
    const record = { id: "chatgpt", observedAt: NOW, windows: [
      { key: "entitlement", pctLeft: null, remaining: null, resetAt: NOW + 4 * 864e5, observedAt: NOW },
      { key: "deep-research", label: "deep_research", pctLeft: null, remaining: 25,
        resetAt: NOW + 36e5, observedAt: NOW }
    ] };
    const p = Q.primary(record, { now: NOW });
    return p && p.remaining === 25;
  })());

t("the counter closest to running out leads, and a bare zero does not",
  (() => {
    /* Perplexity states four at once. "pro_search: 3 left" is the one that
       matters; "research: 0" with no ceiling cannot be told apart from a
       feature the plan never included. */
    const wins = Q.fromJson({
      free_queries: { remaining_detail: { remaining: 10 } },
      modes: {
        pro_search: { remaining_detail: { remaining: 3 } },
        research: { remaining_detail: { remaining: 0 } }
      }
    }, { now: NOW });
    const p = Q.primary({ id: "perplexity", windows: wins, observedAt: NOW }, { now: NOW });
    return p && p.key === "pro-search" && p.remaining === 3;
  })());

t("a partner's quota is still rejected from the same response",
  (() => {
    const wins = Q.fromJson({ sources: { bmj: { remaining_detail: { remaining: 3 } } } }, { now: NOW });
    return Q.primary({ id: "perplexity", windows: wins, observedAt: NOW }, { now: NOW }) === null;
  })());

t("a description of the measurement is not the name of the meter",
  (() => {
    /* Perplexity states {kind: "exact", remaining: 3}. Taking "exact" as the
       name produced four windows all called "exact", and a row that read
       "3 left · exact". */
    const w = Q.fromJson({ modes: { pro_search: { remaining_detail: { kind: "exact", remaining: 3 } } } },
      { now: NOW })[0];
    return w && w.key === "pro-search" && w.remaining === 3;
  })());

t("an empty record displays nothing",
  Q.primary({ id: "gemini", windows: [] }, { now: NOW }) === null
    && Q.primary(null, { now: NOW }) === null);

/* ---------- redaction ---------- */

t("prose is replaced by its shape, numbers survive",
  (() => {
    const out = Q.redact({
      remaining: 12,
      answer: "a long assistant reply that must never reach a diagnostics report at all",
      label: "5h"
    }, 0);
    return out.remaining === 12 && out.label === "5h"
      && typeof out.answer === "string" && out.answer.startsWith("«string:");
  })());

t("redaction bounds arrays and object width",
  (() => {
    const out = Q.redact({ items: Array.from({ length: 50 }, (_, i) => i) }, 0);
    return Array.isArray(out.items) && out.items.length === 5;
  })());

t("looksQuotaish separates a limits payload from a chat payload",
  Q.looksQuotaish({ remaining: 3, limit: 10 }) === true
    && Q.looksQuotaish({ messages: [{ role: "user" }] }) === false);

/* ---------- realistic shapes ---------- */

t("a nested rate-limit payload is read end to end",
  (() => {
    const windows = Q.fromJson({
      rate_limits: [
        { name: "five_hour", remaining: 12, limit: 50, resets_at: "2026-01-01T04:30:00Z" },
        { name: "weekly", remaining: 400, limit: 500, resets_at: "2026-01-05T00:00:00Z" }
      ]
    }, { now: NOW });
    const five = windows.find((w) => w.key === "five-hour");
    return windows.length === 2 && five && five.pctLeft === 24
      && five.resetAt === NOW + 4.5 * 3600e3;
  })(),
  JSON.stringify(Q.fromJson({
    rate_limits: [{ name: "five_hour", remaining: 12, limit: 50, resets_at: "2026-01-01T04:30:00Z" }]
  }, { now: NOW })));

/* ---------- key spelling ----------
   These providers mix conventions across their own endpoints, and the failure
   this guards is the quiet one: the field is present, we do not match its name,
   and the row reads "not reported" as though nothing was published. */

t("camelCase keys are matched",
  pctOf({ remainingQueries: 5, totalQueries: 20 }) === 25,
  String(pctOf({ remainingQueries: 5, totalQueries: 20 })));

t("PascalCase keys are matched",
  pctOf({ RemainingTokens: 250, TokenLimit: 1000 }) === 25);

t("kebab-case keys are matched",
  pctOf({ "remaining-messages": 3, "message-limit": 12 }) === 25);

t("a camelCase reset is still read as a reset",
  resetOf({ remainingQueries: 1, totalQueries: 2, resetsAt: "2026-01-01T03:00:00Z" })
    === NOW + 3 * 3600e3);

t("a camelCase relative reset is offset from now",
  resetOf({ remainingQueries: 1, totalQueries: 2, resetsInSeconds: 900 }) === NOW + 900e3);

t("a window-size field is not mistaken for a reset time",
  // windowSizeSeconds describes how long the window is, not when it ends.
  // Reading it as a reset would put the rollover 5 hours from whenever we
  // happened to look.
  resetOf({ remainingQueries: 4, totalQueries: 10, windowSizeSeconds: 18000 }) === 0);

t("a query-count payload keeps its unit",
  (() => {
    const w = first(Q.fromJson({ remainingQueries: 8, totalQueries: 20 }, { now: NOW }));
    return w && w.pctLeft === 40 && w.unit === "query";
  })(),
  JSON.stringify(first(Q.fromJson({ remainingQueries: 8, totalQueries: 20 }, { now: NOW }))));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nfailures:");
  for (const line of failed) console.log("  " + line);
  process.exit(1);
}
