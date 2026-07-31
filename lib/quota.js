/**
 * Long Chat Toolkit — provider quota normalisation.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every percentage the popup draws must
 * trace to a field a provider actually sent us. Nothing here invents a
 * denominator, extrapolates a trend, or falls back to a nominal window.
 *
 * Why it has to work this way. The old usage panel counted user-message DOM
 * nodes and divided by a hand-typed ceiling ("45 messages"). Both halves were
 * wrong: on a virtualising host, scrolling up mounts old turns and inflates the
 * count, and providers do not meter messages at all — Claude weights a rolling
 * multi-hour window by tokens, ChatGPT caps per model. A message count over a
 * guessed limit cannot agree with the provider's own UI even in principle.
 *
 * So we read the provider's own numbers and reduce them to the one quantity
 * they all express and a user can act on: HOW MUCH OF THE ALLOWANCE IS LEFT,
 * as a percentage, and WHEN IT RESETS.
 *
 * The extractor is deliberately shape-agnostic. These are private endpoints
 * with no contract and no version; a build can rename `remaining_percentage`
 * to `pct_remaining` overnight. Matching families of key NAMES over arbitrary
 * JSON survives that, and when it finally does not, extract() returns nothing
 * and the row says "not reported" — which is the honest output, not a stale
 * number presented as current.
 *
 * Every emitted window carries `path` (where in the response it was found) and
 * `basis` (which arithmetic produced the percentage), so the diagnostics panel
 * can show the user the provenance of the exact figure on their dial.
 */
(() => {
  "use strict";

  /* ---------- key families ----------
     Ordered most specific first: `remaining_percentage` must be read as a
     percentage, not caught by the bare `remaining` count family. */

  // Values that already express a proportion. `used: true` means the number
  // counts consumption, so the remainder is 100 - value.
  const PCT_KEYS = [
    { re: /(remaining|left|available)_?(pct|percent|percentage|fraction|ratio)/, used: false },
    { re: /(pct|percent|percentage|fraction|ratio)_?(remaining|left|available)/, used: false },
    { re: /(used|consumed|spent)_?(pct|percent|percentage|fraction|ratio)/, used: true },
    { re: /(pct|percent|percentage|fraction|ratio)_?(used|consumed|spent)/, used: true },
    { re: /^utili[sz]ation$/, used: true },
    { re: /utili[sz]ation/, used: true }
  ];

  // Counts of what is left. Paired with a limit sibling to make a percentage.
  const REMAINING_KEYS = /^(remaining|remaining_\w+|\w+_remaining|left|available|allowance_remaining)$/;
  // Counts of what has been spent.
  const USED_KEYS = /^(used|used_\w+|\w+_used|consumed|spent|count|usage_count|current)$/;
  /* The denominator. Spelled out generously on both sides because providers put
     the noun on either end — `total_queries` and `query_limit` are the same
     field, and missing one of them is the difference between a real percentage
     and "not reported". */
  const LIMIT_KEYS = /^(limit|\w+_limit|limit_\w+|total|total_\w+|\w+_total|cap|\w+_cap|quota|quota_\w+|\w+_quota|max|max_\w+|\w+_max|maximum|allowance|\w+_allowance|allowed|size)$/;
  // When the window rolls over.
  const RESET_KEYS = /(reset|resets|expires|window_end|ends_at|next_\w*reset|refresh_at)/;
  // Relative rather than absolute reset ("in 4200 seconds").
  const RELATIVE_RESET = /(in_?seconds|seconds_?(until|to|remaining)|_in$|retry_after|after_seconds)/;
  // A human label the provider already wrote for this window.
  const LABEL_KEYS = /^(name|label|title|type|kind|window|window_name|period|unit|display_name)$/;

  /* Response headers that carry quota. Providers spell these three ways and
     the values are plain scalars, so headers are the cheapest exact source we
     have — and the only one guaranteed to arrive on the send request itself. */
  const HEADER_PATTERNS = [
    /^anthropic-ratelimit-/,
    /^x-ratelimit-/,
    /^ratelimit-/,
    /^x-quota-/,
    /^openai-ratelimit-/,
    /^x-rate-limit-/
  ];

  const MAX_DEPTH = 6;
  const MAX_NODES = 4000;

  /* ---------- scalar coercion ---------- */

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * Normalise a reset marker to epoch milliseconds.
   *
   * The same field can arrive as ISO text, epoch seconds, epoch milliseconds,
   * or a relative offset, and guessing wrong turns "resets at 4pm" into
   * "resets in 1970". Magnitude decides between the epochs; only an explicitly
   * relative key name is allowed to be read as an offset, because a small
   * absolute number is far more likely to be a truncated value we should
   * discard than a genuine 30-second window.
   */
  function resetMs(key, value, now) {
    const at = typeof now === "number" ? now : Date.now();
    if (typeof value === "string" && !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const n = num(value);
    if (n === null || n < 0) return 0;
    const relative = RELATIVE_RESET.test(key);
    if (relative) return at + n * 1000;
    if (n > 1e12) return n;              // epoch ms
    if (n > 1e9) return n * 1000;        // epoch s
    // Neither epoch nor declared relative: unusable. Report no reset rather
    // than a time that would render as a date in 1970.
    return 0;
  }

  /**
   * A proportion expressed 0..100.
   *
   * Providers write proportions as either 0..1 or 0..100 and never say which.
   * A value at or below 1 is ambiguous — 1 could be "100%" or "1%". We read
   * `<= 1` as a fraction, because that is what a field named `ratio` or
   * `fraction` overwhelmingly means, and because the 1-vs-100% confusion is
   * bounded: it can only ever mis-state a full or nearly-empty window, both of
   * which the reset time disambiguates on screen.
   */
  function pct(value) {
    const n = num(value);
    if (n === null || n < 0) return null;
    const scaled = n <= 1 ? n * 100 : n;
    if (scaled > 100.5) return null;     // not a proportion after all
    return Math.max(0, Math.min(100, scaled));
  }

  function pctKeyKind(key) {
    for (const entry of PCT_KEYS) if (entry.re.test(key)) return entry;
    return null;
  }

  /**
   * One spelling for every key, so the families above only have to be written
   * once.
   *
   * These providers mix conventions freely — `remaining_tokens` on one endpoint,
   * `remainingQueries` on the next, `RemainingQueries` in a third — and a
   * snake_case-only matcher silently misses the camelCase ones. Silently is the
   * problem: the field is there, we do not read it, and the row says "not
   * reported" as though the provider published nothing. Insert a boundary
   * wherever the case steps up or a digit begins, then lowercase.
   */
  function normKey(key) {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Za-z])(\d)/g, "$1_$2")
      .replace(/[-\s.]+/g, "_")
      .replace(/_+/g, "_")
      .toLowerCase();
  }

  /* ---------- window assembly ---------- */

  /**
   * One metered window, reduced to what we are willing to show.
   *
   * `pctLeft` is null when the provider reported activity but not enough to
   * form a proportion — a `remaining` with no denominator anywhere. That is a
   * real and common case, and it must stay distinguishable from "nothing
   * reported": the row can still show a reset time and say the share is
   * unpublished, which is true, where a fabricated percentage would not be.
   */
  function makeWindow(fields, path) {
    const { pctLeft, basis } = proportion(fields);
    if (pctLeft === null && !fields.resetAt && fields.remaining === null) return null;
    return {
      key: windowKey(fields, path),
      label: fields.label || "",
      pctLeft: pctLeft === null ? null : Math.round(pctLeft),
      // Kept unrounded for the diagnostics panel, where a 0.4% disagreement
      // with the provider's UI is the difference between a rounding artefact
      // and the wrong field.
      pctLeftExact: pctLeft,
      basis,
      resetAt: fields.resetAt || 0,
      remaining: fields.remaining,
      limit: fields.limit,
      used: fields.used,
      unit: fields.unit || "",
      path
    };
  }

  /**
   * The percentage still available, and the arithmetic that produced it.
   *
   * Order is precedence: a proportion the provider stated itself beats one we
   * compute, and a remaining/limit pair beats used/limit, because that is the
   * order in which the numbers were meant to be read. A `used` count with no
   * limit yields nothing — there is no denominator to divide by, and inventing
   * one is exactly the failure this file exists to prevent.
   */
  function proportion(fields) {
    if (fields.pctLeft !== null && fields.pctLeft !== undefined) {
      return { pctLeft: fields.pctLeft, basis: fields.pctBasis || "provider-percentage" };
    }
    if (fields.remaining !== null && fields.limit !== null && fields.limit > 0) {
      return {
        pctLeft: Math.max(0, Math.min(100, (fields.remaining / fields.limit) * 100)),
        basis: "remaining/limit"
      };
    }
    if (fields.used !== null && fields.limit !== null && fields.limit > 0) {
      return {
        pctLeft: Math.max(0, Math.min(100, (1 - fields.used / fields.limit) * 100)),
        basis: "1-used/limit"
      };
    }
    return { pctLeft: null, basis: "" };
  }

  /** A stable identity for a window, so repeat reads update rather than pile up. */
  function windowKey(fields, path) {
    const label = String(fields.label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (label) return label.replace(/^-|-$/g, "").slice(0, 40);
    if (fields.unit) return String(fields.unit).toLowerCase().slice(0, 40);
    const leaf = String(path || "").split(".").filter(Boolean).pop() || "window";
    return leaf.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "window";
  }

  /**
   * Read one object as a candidate window.
   *
   * Only sibling scalars count. Reaching into children to find a limit is how
   * you pair one window's remaining with another window's ceiling and produce
   * a confident, wrong percentage — the nesting is the provider telling us
   * these are different meters.
   */
  function readFields(obj, now) {
    const fields = {
      pctLeft: null, pctBasis: "", remaining: null, limit: null,
      used: null, resetAt: 0, label: "", unit: ""
    };
    let signal = false;

    for (const [rawKey, value] of Object.entries(obj)) {
      const key = normKey(rawKey);

      if (typeof value === "string" && LABEL_KEYS.test(key)) {
        if (!fields.label) fields.label = value.slice(0, 60);
        continue;
      }
      if (value !== null && typeof value === "object") continue;

      const kind = pctKeyKind(key);
      if (kind) {
        const p = pct(value);
        if (p !== null) {
          fields.pctLeft = kind.used ? 100 - p : p;
          fields.pctBasis = kind.used ? "provider-percentage(used)" : "provider-percentage";
          signal = true;
        }
        continue;
      }
      if (RESET_KEYS.test(key) || RELATIVE_RESET.test(key)) {
        const ms = resetMs(key, value, now);
        // Furthest-out reset wins: when a provider states both the window end
        // and a shorter retry hint, the window end is the one a user plans
        // around.
        if (ms > fields.resetAt) fields.resetAt = ms;
        continue;
      }
      if (REMAINING_KEYS.test(key)) {
        const n = num(value);
        if (n !== null) { fields.remaining = n; signal = true; if (!fields.unit) fields.unit = unitOf(key); }
        continue;
      }
      if (LIMIT_KEYS.test(key)) {
        const n = num(value);
        if (n !== null && n > 0) { fields.limit = n; if (!fields.unit) fields.unit = unitOf(key); }
        continue;
      }
      if (USED_KEYS.test(key)) {
        const n = num(value);
        if (n !== null) { fields.used = n; signal = true; if (!fields.unit) fields.unit = unitOf(key); }
      }
    }

    return signal || fields.resetAt ? fields : null;
  }

  /** "remaining_tokens" → "token": what the meter counts, when it says so.
   *  Spelled out rather than de-pluralised by stripping an "s", which turns
   *  "queries" into "querie" and puts that in front of the user. */
  const UNITS = {
    token: /tokens?/, message: /messages?/, query: /quer(y|ies)/,
    request: /requests?/, credit: /credits?/, search: /searches|search/,
    prompt: /prompts?/
  };
  function unitOf(key) {
    for (const [unit, re] of Object.entries(UNITS)) if (re.test(key)) return unit;
    return "";
  }

  /* ---------- public: JSON extraction ---------- */

  /**
   * Find every quota-shaped window in an arbitrary JSON response.
   *
   * @param {*} root      parsed JSON body
   * @param {Object} opts  { now }
   * @returns {Array} windows, richest first
   */
  function fromJson(root, opts) {
    const now = (opts && opts.now) || Date.now();
    const out = [];
    let nodes = 0;

    const walk = (node, path, depth) => {
      if (!node || typeof node !== "object" || depth > MAX_DEPTH || nodes > MAX_NODES) return;
      nodes++;

      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`, depth + 1));
        return;
      }

      const fields = readFields(node, now);
      if (fields) {
        const win = makeWindow(fields, path || "$");
        if (win) out.push(win);
      }

      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === "object") {
          walk(value, path ? `${path}.${key}` : key, depth + 1);
        }
      }
    };

    walk(root, "", 0);
    return rank(out);
  }

  /**
   * Best window first.
   *
   * "Best" means most trustworthy to display, not largest: a computed or stated
   * percentage outranks a bare remaining count, and a known reset outranks an
   * unknown one. The popup shows the first; the rest stay available for the
   * diagnostics panel and for providers that genuinely meter several windows.
   */
  function rank(windows) {
    const score = (w) => (w.pctLeft !== null ? 4 : 0) + (w.resetAt ? 2 : 0) + (w.limit !== null ? 1 : 0);
    return windows
      .map((w, i) => ({ w, i }))
      .sort((a, b) => score(b.w) - score(a.w) || a.i - b.i)
      .map((entry) => entry.w);
  }

  /* ---------- public: header extraction ---------- */

  /**
   * Quota from response headers.
   *
   * Headers are flat, so the window they belong to is encoded in the name:
   * `anthropic-ratelimit-unified-5h-remaining` and `…-5h-limit` are one meter,
   * `…-7d-…` another. Group by that infix before pairing, or a five-hour
   * remaining gets divided by a weekly ceiling.
   *
   * @param {Object|Headers} headers
   * @returns {Array} windows
   */
  function fromHeaders(headers, opts) {
    const now = (opts && opts.now) || Date.now();
    const entries = headerEntries(headers);
    const groups = new Map();

    for (const [rawName, value] of entries) {
      const name = String(rawName).toLowerCase();
      if (!HEADER_PATTERNS.some((re) => re.test(name))) continue;

      // Strip the vendor prefix, then split the remainder into the window's
      // name and the field's name. The LAST segment is the field.
      const tail = name
        .replace(/^anthropic-ratelimit-?/, "")
        .replace(/^openai-ratelimit-?/, "")
        .replace(/^x-rate-?limit-?/, "")
        .replace(/^x-ratelimit-?/, "")
        .replace(/^ratelimit-?/, "")
        .replace(/^x-quota-?/, "");
      const parts = tail.split(/[-_]/).filter(Boolean);
      if (!parts.length) continue;
      const field = parts[parts.length - 1];
      const group = parts.slice(0, -1).join("-") || "default";

      if (!groups.has(group)) groups.set(group, {});
      groups.get(group)[field] = value;
    }

    const out = [];
    for (const [group, fields] of groups) {
      // Re-use the JSON reader so headers and bodies cannot disagree about what
      // a field name means.
      const read = readFields(fields, now);
      if (!read) continue;
      if (!read.label) read.label = group === "default" ? "" : group;
      const win = makeWindow(read, "header:" + group);
      if (win) out.push(win);
    }
    return rank(out);
  }

  function headerEntries(headers) {
    if (!headers) return [];
    if (typeof headers.forEach === "function" && typeof headers.get === "function") {
      const out = [];
      headers.forEach((value, name) => out.push([name, value]));
      return out;
    }
    if (typeof headers.entries === "function") return Array.from(headers.entries());
    return Object.entries(headers);
  }

  /* ---------- public: record merge ---------- */

  /**
   * Fold a fresh reading into the stored record for one account.
   *
   * Per window, not per record: a poll that returns only the weekly meter must
   * not erase a five-hour meter observed thirty seconds ago on the send path.
   * Freshest reading per window wins, and a window nobody has mentioned inside
   * `staleMs` is dropped rather than shown as current — an expired reset is
   * exactly when a stale percentage is most misleading.
   */
  function merge(prev, reading, opts) {
    const now = (opts && opts.now) || Date.now();
    const staleMs = (opts && opts.staleMs) || 12 * 60 * 60 * 1000;
    const byKey = new Map();

    for (const win of (prev && Array.isArray(prev.windows) ? prev.windows : [])) {
      if (!win || !win.key) continue;
      if (now - (win.observedAt || 0) > staleMs) continue;
      byKey.set(win.key, win);
    }

    for (const win of (reading && Array.isArray(reading.windows) ? reading.windows : [])) {
      if (!win || !win.key) continue;
      const stamped = {
        ...win,
        observedAt: reading.observedAt || now,
        source: reading.source || "unknown"
      };
      const held = byKey.get(win.key);
      if (!held || (stamped.observedAt >= (held.observedAt || 0))) byKey.set(win.key, stamped);
    }

    const windows = rank(Array.from(byKey.values()));
    return {
      id: (reading && reading.id) || (prev && prev.id) || "",
      acct: (reading && reading.acct) || (prev && prev.acct) || "",
      plan: (reading && reading.plan) || (prev && prev.plan) || "",
      windows,
      observedAt: Math.max(
        (reading && reading.observedAt) || 0,
        (prev && prev.observedAt) || 0
      ) || now,
      // Which mechanism last produced a number, for the diagnostics panel.
      source: (reading && reading.source) || (prev && prev.source) || ""
    };
  }

  /**
   * The window a row should display, or null.
   *
   * A record whose every window has passed its reset is not "0% left", it is
   * unknown: the allowance has rolled over and nobody has told us the new
   * figure yet. Returning null there is what makes the row say so.
   */
  function primary(record, opts) {
    const now = (opts && opts.now) || Date.now();
    const graceMs = (opts && opts.graceMs) || 60 * 1000;
    const windows = (record && Array.isArray(record.windows) ? record.windows : [])
      .filter((w) => w && (!w.resetAt || w.resetAt + graceMs > now));
    return windows.length ? windows[0] : null;
  }

  /* ---------- public: diagnostics ---------- */

  /**
   * A structurally faithful, content-free sample of a response.
   *
   * The diagnostics panel has to show what a provider actually returned so a
   * wrong field can be spotted, but this extension archives conversations —
   * anything that dumps a raw body risks putting chat text in a report the
   * user may paste somewhere. Keys and numbers are kept because those are what
   * we read; every string is replaced by its shape.
   */
  function redact(node, depth) {
    const d = depth || 0;
    if (node === null || node === undefined) return null;
    if (typeof node === "number" || typeof node === "boolean") return node;
    if (typeof node === "string") {
      // Short scalars that look like labels or timestamps are the ones we
      // parse, so they survive; anything long enough to be prose does not.
      if (node.length <= 40 && !/\s{2,}/.test(node)) return node;
      return `«string:${node.length}»`;
    }
    if (d >= MAX_DEPTH) return "«deep»";
    if (Array.isArray(node)) return node.slice(0, 5).map((v) => redact(v, d + 1));
    if (typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node).slice(0, 40)) out[k] = redact(v, d + 1);
      return out;
    }
    return null;
  }

  /** True when a response is worth recording as a quota source at all. */
  function looksQuotaish(json) {
    return fromJson(json, {}).length > 0;
  }

  self.LCTQuota = {
    fromJson, fromHeaders, merge, primary, redact, looksQuotaish,
    // Exported for the test page: these are the parsers whose silent
    // regression turns a real number into a plausible wrong one.
    _internals: { resetMs, pct, readFields, rank, unitOf, normKey }
  };
})();
