/**
 * Tvara — provider quota normalisation.
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
  /* `whole: true` means the number is already out of 100 and must NEVER be
     rescaled. Anthropic documents `utilization` as 0..100, so a session 0.4%
     spent arrived as 0.4, was read as "40% used" by the 0-to-1 rule below, and
     the panel said 60% left to somebody who had barely started. Under 1% —
     which is most of a fresh five-hour window — the figure was not merely
     imprecise, it was inverted. Ratios and fractions say so in their names and
     keep the scaling. */
  const PCT_KEYS = [
    { re: /(remaining|left|available)_?(fraction|ratio)/, used: false },
    { re: /(fraction|ratio)_?(remaining|left|available)/, used: false },
    { re: /(used|consumed|spent)_?(fraction|ratio)/, used: true },
    { re: /(fraction|ratio)_?(used|consumed|spent)/, used: true },
    { re: /(remaining|left|available)_?(pct|percent|percentage)/, used: false, whole: true },
    { re: /(pct|percent|percentage)_?(remaining|left|available)/, used: false, whole: true },
    { re: /(used|consumed|spent)_?(pct|percent|percentage)/, used: true, whole: true },
    { re: /(pct|percent|percentage)_?(used|consumed|spent)/, used: true, whole: true },
    { re: /^utili[sz]ation$/, used: true, whole: true },
    { re: /utili[sz]ation/, used: true, whole: true }
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
  /* How long the window IS, stated as a number of seconds instead of in its
     name. ChatGPT's /backend-api/wham/usage calls its two windows "primary" and
     "secondary" and says nothing else about them, so `limit_window_seconds` is
     the ONLY thing separating the five-hour session limit from the weekly one —
     and without it both rank alike and the panel can lead with the wrong one.
     Read before the ceiling on purpose: `limit_window_seconds` also matches
     LIMIT_KEYS, and taken as a ceiling it becomes a limit of 18000 of nothing. */
  const SPAN_SEC_KEYS = /^(limit_|rate_|usage_|quota_|reset_)?window_(seconds|secs|length)$|^(period|interval|window)_seconds$/;
  // A human label the provider already wrote for this window.
  /* `feature_name` is how ChatGPT names its counters ("deep_research"), and a
     window called "limits-progress-0" tells the reader nothing about what is
     running out. Any *_name / *_label pairs the same way. */
  const LABEL_KEYS = /^(name|label|title|type|kind|window|window_name|period|unit|display_name|\w+_name|\w+_label)$/;
  const GENERIC_LABEL = /^(exact|approximate|approx|estimate[d]?|unlimited|unknown|none|null|standard|default|normal|ok)$/i;

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
  const BARE_NUMBER = /^-?\d{1,20}$|^-?\d{1,20}\.\d{1,20}$/;

  function resetMs(key, value, now) {
    const at = typeof now === "number" ? now : Date.now();
    /* "Is this string just a number?" — written as two flat alternatives and a
       trim, rather than one pattern with an optional fraction nested inside it.
       Same answer, no quantifier inside a quantifier, and bounded lengths: a
       reset value is a timestamp or a seconds count, never forty digits. */
    if (typeof value === "string" && !BARE_NUMBER.test(value.trim())) {
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
  function pct(value, whole) {
    const n = num(value);
    if (n === null || n < 0) return null;
    // A key that names itself a percentage is one; only a ratio scales.
    const scaled = (!whole && n <= 1) ? n * 100 : n;
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
  /* How long the window IS, in seconds, from what the provider calls it.
     Anthropic's own names — five_hour, seven_day — and the shorthands the rest
     use. This is what tells a SESSION limit from a weekly one, and the session
     limit is the one that stops you mid-answer. */
  const SPANS = [
    [/\b(five[_-]?hour|5h|5_hour|5 hour|5 hours|session)\b/i, 5 * 3600],
    [/\b(three[_-]?hour|3h|3 hour|3 hours)\b/i, 3 * 3600],
    [/\b(hourly|1h|per hour)\b/i, 3600],
    [/\b(seven[_-]?day|weekly|week|7d|7 day|7 days)\b/i, 7 * 86400],
    [/\b(daily|day|24h|1d|24 hour|24 hours)\b/i, 86400],
    [/\b(monthly|month|30d|30 day|30 days)\b/i, 30 * 86400]
  ];

  function spanOf(fields, path) {
    if (fields.spanSec) return fields.spanSec;
    const text = String(fields.label || "") + " " + String(path || "");
    for (const [re, secs] of SPANS) if (re.test(text)) return secs;
    return 0;
  }

  /** "5h", "week" — what to call the window in one word. */
  function spanLabel(secs) {
    if (!secs) return "";
    if (secs <= 3600) return "1h";
    if (secs <= 5 * 3600) return Math.round(secs / 3600) + "h";
    if (secs <= 86400) return "day";
    if (secs <= 7 * 86400) return "week";
    return "month";
  }

  function makeWindow(fields, path) {
    const { pctLeft, basis } = proportion(fields);
    if (pctLeft === null && !fields.resetAt && fields.remaining === null) return null;
    const spanSec = spanOf(fields, path);
    return {
      spanSec,
      span: spanLabel(spanSec),
      /* A provider that states the window's LENGTH but not its end still knows
         when it turns over, and the reader asked for the date. Grok answers
         with a wait; Perplexity with a monthly quota and no clock. */
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
    /* Walk back past wrapper segments. Perplexity states its allowances as
       `modes.pro_search.remaining_detail.remaining`, so the leaf names the box
       the number came in rather than what it measures — and a window called
       "remaining detail" tells the reader nothing, on every provider that
       nests. The last segment that is a NAME is the one that means something. */
    const WRAPPER = /^(remaining_?detail|detail|details|value|values|data|info|status|meta|current|limits?|usage|quota|rate_?limits?)$/;
    const parts = String(path || "").split(".").filter(Boolean)
      .map((seg) => seg.replace(/\[\d+\]$/, ""));
    while (parts.length > 1 && WRAPPER.test(parts[parts.length - 1].toLowerCase())) parts.pop();
    const leaf = parts.pop() || "window";
    /* Trim the dashes the substitution leaves behind. A root-level window has
       the path "$", which became the key "-" — truthy, so the fallback below
       never fired, and a window whose real name is "there wasn't one" ended up
       named after a punctuation mark. */
    return leaf.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
      || "window";
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
      used: null, resetAt: 0, spanSec: 0, label: "", unit: ""
    };
    let signal = false;

    for (const [rawKey, value] of Object.entries(obj)) {
      const key = normKey(rawKey);

      if (typeof value === "string" && LABEL_KEYS.test(key)) {
        /* Some of these describe the MEASUREMENT rather than the thing
           measured. Perplexity states {kind: "exact", remaining: 3}, and taking
           "exact" as the name produced four windows all called "exact" — a
           panel row reading "3 left · exact". A descriptor is not a name; drop
           it and let the path say what this counts. */
        if (!GENERIC_LABEL.test(value.trim())) {
          if (!fields.label) fields.label = value.slice(0, 60);
        }
        continue;
      }
      if (value !== null && typeof value === "object") continue;

      const kind = pctKeyKind(key);
      if (kind) {
        const p = pct(value, kind.whole);
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
      if (SPAN_SEC_KEYS.test(key)) {
        const n = num(value);
        // A window runs from minutes to a month. Outside that it is not a span,
        // and a span is never a signal on its own — it describes the window,
        // it does not report anything about what is left in it.
        if (n !== null && n >= 60 && n <= 60 * 86400) fields.spanSec = n;
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
  /* An endpoint can meter one product in particular, and say nothing in its
     numbers about which. ChatGPT's /backend-api/wham/usage is Codex — its own
     response reads "You're out of Codex messages" — and its windows arrive
     labelled "" at rate_limit.primary_window, so nothing downstream could tell
     them from the chat allowance: a Go account with 300 reasoning messages left
     was shown as "0 left · month". The endpoint names its meter; this carries
     that name onto every window it produced. */
  const METER_LABELS = { codex: "Codex" };
  function tagMeter(windows, meter) {
    if (!meter) return windows;
    for (const w of windows || []) {
      if (!w) continue;
      w.meter = meter;
      if (!w.label) w.label = METER_LABELS[meter] || meter;
    }
    return windows;
  }

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
    /* Informativeness first, and a reset is NOT information about how much is
       left. Scored the old way, a window carrying only a deadline (2) beat one
       carrying a real count (1), so ChatGPT's row read "not reported · resets
       Sat 9:46 PM" while "deep_research: 25 remaining" sat behind it in the
       same response. What the reader wants to know is how much is left; when
       it comes back is the footnote. */
    /* A SIDE feature is not the allowance. ChatGPT meters deep research, image
       generation and voice separately from the plan itself, and a row that
       leads with "4 left · deep research" answers a question the reader did not
       ask while the figure they did ask about sits behind it. Only ever a
       tie-break: where the side meter is the only thing the provider published,
       it is still the truth and it is still shown. */
    const niche = (w) => isSideMeter(w);
    const score = (w) =>
      (w.pctLeft !== null ? 8 : 0) +
      (w.remaining !== null && w.remaining !== undefined ? 4 : 0) +
      (w.limit !== null && w.limit !== undefined ? 2 : 0) +
      (w.resetAt ? 1 : 0) +
      (niche(w) ? -3 : 0);
    /* Between two windows that say the same amount, the SHORTER one is the
       answer. Claude publishes a five-hour session limit and a seven-day one;
       the weekly figure is usually the lower of the two, so ranking by urgency
       alone showed the week and hid the session — and the session limit is the
       one that stops you in the middle of an answer, which is the whole reason
       anybody looks at this panel. */
    const hasFigure = (w) => (w.pctLeft !== null && w.pctLeft !== undefined) ||
      typeof w.remaining === "number" || (w.limit !== null && w.limit !== undefined);
    const tier = (w) => (hasFigure(w) ? (niche(w) ? 1 : 0) : 2);
    const spanRank = (w) => (w.spanSec ? w.spanSec : Number.MAX_SAFE_INTEGER);
    /* Between two equally informative windows, the one closest to running out
       is the one worth showing: Perplexity states four at once and "pro search:
       3 left" matters where "free queries: 10 left" does not yet.
       A zero with no ceiling sorts LAST, deliberately — without a limit we
       cannot tell "you have used it all" from "your plan does not include it",
       and leading with "0 left" for something the user never had is a worse
       error than leading with a number that is merely less urgent. */
    const urgency = (w) => {
      if (w.pctLeft !== null && w.pctLeft !== undefined) return w.pctLeft;
      if (typeof w.remaining === "number") return w.remaining > 0 ? 100 + w.remaining : Infinity;
      return Infinity;
    };
    return windows
      .map((w, i) => ({ w, i }))
      .sort((a, b) => {
        const aBlocks = blocksProvider(a.w);
        const bBlocks = blocksProvider(b.w);
        if (aBlocks !== bBlocks) return bBlocks ? 1 : -1;
        if (aBlocks && bBlocks && a.w.resetAt !== b.w.resetAt) {
          return (b.w.resetAt || 0) - (a.w.resetAt || 0);
        }
        /* The side-meter rule as its comment states it: a tie-break against the
           allowance, and never a reason to lead while the allowance published
           a figure. As a -3 on an additive score it could not do that — a
           percentage is worth 8 and a count 4, so a side meter carrying a
           percentage always beat the real allowance carrying a count, and a Go
           account read "Codex: 0 left" as its ChatGPT headline. Figure-less
           windows still come last, so "deep_research: 25 left" still beats a
           bare reset. */
        return tier(a.w) - tier(b.w) ||
        score(b.w) - score(a.w) ||
        spanRank(a.w) - spanRank(b.w) ||
        urgency(a.w) - urgency(b.w) || a.i - b.i;
      })
      .map((entry) => entry.w);
  }

  const SIDE_METER = /(deep[_-]?research|image|dall|voice|video|sora|canvas|memory|connector|project|agent|browse|search[_-]?result|codex)/i;

  function isSideMeter(w) {
    return SIDE_METER.test(`${w && w.label || ""} ${w && w.meter || ""} ${w && w.path || ""}`);
  }

  function blocksProvider(w) {
    return !!w && w.pctLeft !== null && w.pctLeft !== undefined && w.pctLeft <= 0 && !isSideMeter(w);
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

    /* One window per span, where the window is a SHARE of the plan.
       Claude states the same five-hour limit twice — as a percentage in
       /usage, and as remaining/limit headers on the send path — under two
       different keys, so both survived and rank() picked between them by
       score. They disagree (the headers count tokens, the page counts a
       weighted allowance), so the row flipped between them as each was
       refreshed: right one minute, wrong the next.
       Counts are untouched: a provider can legitimately meter several
       different THINGS on the same clock — Perplexity does — but it never
       states two different shares of one allowance. */
    const bySpan = new Map();
    for (const win of byKey.values()) {
      if (!win.spanSec || win.pctLeft === null || win.pctLeft === undefined) continue;
      const held = bySpan.get(win.spanSec);
      if (!held) { bySpan.set(win.spanSec, win); continue; }
      const fresher = (win.observedAt || 0) - (held.observedAt || 0);
      /* Same freshness: the share the provider STATED beats one computed from
         a remaining/limit pair — it is the number its own page shows. */
      const stated = (w) => (/provider-percentage/.test(String(w.basis || "")) ? 1 : 0);
      if (fresher > 0 || (fresher === 0 && stated(win) > stated(held))) bySpan.set(win.spanSec, win);
    }
    for (const [spanSec, keep] of bySpan) {
      for (const [key, win] of byKey) {
        if (win !== keep && win.spanSec === spanSec &&
            win.pctLeft !== null && win.pctLeft !== undefined) byKey.delete(key);
      }
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
  /* ---------- is this figure ABOUT the thing we claim? ----------
     The extractor is deliberately shape-agnostic, which is what makes it
     survive a provider renaming its fields. The cost is that it will read any
     remaining/limit pair it finds — and on a live account it did: the panel
     showed "Perplexity 100% left" from a field called `ahrefs-premium-data`,
     3 of 3. A real number, correctly parsed, and nothing whatsoever to do with
     the user's chat allowance.

     So a window has to look like an allowance before it is presented as one.
     Anything else is a number we read and will not put a name to. */
  /* A brand denylist was tried first and is whack-a-mole: Perplexity's settings
     response carries a third-party quota per partner, so the panel read
     "100% left" from `ahrefs-premium-data` one minute and `apollo-premium-data`
     the next. Both were real numbers, correctly parsed, and neither was the
     user's chat allowance.

     What we actually have is per-platform knowledge — we already curate which
     ENDPOINT to ask on each host, and which field means "your allowance" is the
     same kind of knowledge. So each platform names what its allowance looks
     like, and a figure that does not match is a number we read and will not put
     a name to. A platform we have not characterised falls back to the denylist
     alone, which is where every platform started. */
  const GENERIC = "default|window|general|primary|main|overall";
  const ALLOWANCE_BY_PLATFORM = {
    // Claude meters a rolling multi-hour window, weighted by tokens.
    claude: new RegExp(`(${GENERIC}|five|seven|hour|day|week|month|5h|7d|usage|rate|limit|quota|message|token|credit)`),
    // ChatGPT caps per model, and publishes an entitlement/limit shape.
    // Its counters are named after the feature they meter: deep_research,
    // image_gen, and whatever it adds next.
    chatgpt: new RegExp(`(${GENERIC}|conversation|message|model|entitlement|usage|rate|limit|quota|cap|hour|day|week|month|research|image|video|voice|audio|file|deep|gen|agent|task|project)`),
    // Grok publishes a query counter per window.
    grok: new RegExp(`(${GENERIC}|query|queries|request|rate|limit|quota|hour|day|week|month)`),
    // Perplexity: searches/copilot uses, NOT the partner data quotas that share
    // the same response.
    perplexity: new RegExp(`(${GENERIC}|query|queries|search|copilot|pro|gpt4|opus|sonnet|thread|rate|limit|quota|hour|day|week|month)`),
    deepseek: new RegExp(`(${GENERIC}|chat|message|rate|limit|quota)`),
    /* Gemini publishes a rolling five-hour window and a week, and the adapter
       hands them over under those names — `five_hour`, `seven_day`, and
       `credits` for the AI-credit balance. This list did not contain a single
       one of those words, so looksLikeAllowance() rejected both windows, the
       ranked list came back empty, and the panel reported "none published"
       about an account whose usage page was showing the numbers. The words a
       platform's own adapter emits belong in that platform's list. */
    gemini: new RegExp(`(${GENERIC}|five|seven|hour|day|week|month|5h|7d|message|rate|limit|quota|credit|usage)`)
  };
  const NOT_ALLOWANCE =
    /(premium[-_]?data|ahrefs|semrush|majestic|clearbit|apollo|storage|disk|bandwidth|seat|member|invoice|billing|payment|card|coupon|referral|discount|upload|attachment|avatar|domain|webhook|api[-_]?key|retention|subscription[-_]?id)/;

  function looksLikeAllowance(w, platformId) {
    /* Two different questions, so two different haystacks.
       "Is this obviously something else?" gets the path too — that is where
       `…limits.ahrefs_premium_data` gives itself away.
       "Is this THE allowance?" must NOT: the path is the container these things
       share, so `$.rate_limits.bmj` matches "limit" as readily as the real
       figure does, and every impostor in the same response inherits the alibi
       of its parent. Only the field's own name can answer that. */
    const full = `${w.key || ""} ${w.unit || ""} ${w.label || ""} ${w.path || ""}`.toLowerCase();
    const own = `${w.key || ""} ${w.unit || ""} ${w.label || ""}`.toLowerCase();
    if (NOT_ALLOWANCE.test(full)) return false;
    const key = String(w.key || "").trim();
    const known = ALLOWANCE_BY_PLATFORM[String(platformId || "").toLowerCase()];
    /* An UNNAMED window — a bare {remaining, limit} at the root of a response
       about limits — is the provider stating one figure and not qualifying it.
       That is the allowance, and there is nothing else it could be.
       Unless it names its UNIT, in which case it is not unnamed. Live, Claude
       reported "100% left · 30 of 30 querys" while the account's five-hour
       window was three-quarters spent: a root-level remaining/limit pair, no
       reset, metered in something Claude does not meter chat in. The key was
       empty so the per-platform allowlist was skipped entirely, and the one
       word the figure DID carry about itself was never read. */
    if (!key || key === "window") {
      const unit = String(w.unit || "").trim().toLowerCase();
      if (unit && known && !known.test(unit)) return false;
      return true;
    }
    return known ? known.test(own) : true;
  }

  /* ---------- and is it still TRUE? ----------
     A window that states when it resets expires on its own. One that does not
     can only expire on age — and without that rule it never expires at all.
     Live, the panel was showing "Grok 100% left" from a reading taken five days
     earlier, presented exactly like the one taken a minute ago. A stale figure
     shown as current is the failure this whole panel was rewritten to avoid. */
  const FRESH_MS = 45 * 60 * 1000;

  /* Every window worth showing, best first. A provider that publishes both a
     session limit and a weekly one is answering two different questions, and
     only one of them fits on a row — so the panel leads with the head of this
     list and lets the reader step through the rest. */
  function ranked(record, opts) {
    const now = (opts && opts.now) || Date.now();
    const graceMs = (opts && opts.graceMs) || 60 * 1000;
    const freshMs = (opts && opts.freshMs) || FRESH_MS;
    const windows = (record && Array.isArray(record.windows) ? record.windows : [])
      .filter((w) => {
        if (!w) return false;
        if (w.resetAt) { if (w.resetAt + graceMs <= now) return false; }
        else {
          const at = Number(w.observedAt || (record && record.observedAt) || 0);
          if (!at || now - at > freshMs) return false;
        }
        /* A window that states NO figure is not a reading — it is a deadline
           with nothing attached, and it outlives every real one because a
           future reset never goes stale. Live, Perplexity's rate-limit response
           carried one beside "3 pro searches left": after 45 minutes the real
           counters aged out, the empty one did not, and the row degraded from a
           number to "not reported" out of the same response. With none left the
           row says the provider answered and reported nothing, which is true. */
        if (w.pctLeft === null || w.pctLeft === undefined) {
          const hasCount = (w.remaining !== null && w.remaining !== undefined)
            || (w.limit !== null && w.limit !== undefined);
          if (!hasCount) return false;
        }
        return looksLikeAllowance(w, record && record.id);
      });
    /* Ranked HERE, not trusted from storage order. A record accumulates windows
       from several endpoints and a merge appends rather than re-sorts, so
       "first in the array" meant "whichever endpoint answered first" — which is
       how a bare `entitlement` reset outranked "deep_research: 25 remaining"
       from a different call. Choosing is this function's job; do it here and
       the order things arrived in stops mattering. */
    return rank(windows);
  }

  /** The one window a row leads with: the head of the ranked list. */
  function primary(record, opts) {
    const list = ranked(record, opts);
    return list.length ? list[0] : null;
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

  self.LCTQuota = { tagMeter,
    fromJson, fromHeaders, merge, primary, ranked, blocksProvider, redact, looksQuotaish, looksLikeAllowance,
    // Exported for the test page: these are the parsers whose silent
    // regression turns a real number into a plausible wrong one.
    _internals: { resetMs, pct, readFields, rank, unitOf, normKey }
  };
})();
