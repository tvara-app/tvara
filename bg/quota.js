/**
 * Tvara background worker — provider allowances: probe, poll, store, warn.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

const USAGE_PREFIX = "usage:";

/** Every per-account usage tally. Cleared with the archive.
 *
 *  `usage:` keys are the retired DOM-count tally. Nothing writes them any more
 *  (see the quota section below for what replaced them and why); this stays so
 *  that clearing the archive still removes them from installs that have them. */
async function clearUsage() {
  try {
    // key names only — the values are about to be deleted, so reading them back
    // out of the store first was the one cost this could avoid
    const keys = (await listLocalKeys()).filter(
      (k) => k.startsWith(USAGE_PREFIX) || k.startsWith(QUOTA_PREFIX)
    );
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch { /* nothing to clear it from */ }
}

/* ============================ provider quota ==============================
 *
 * What is left of the user's allowance, according to the provider.
 *
 * This replaced a DOM-node counter, and the reason is worth keeping written
 * down, because the counter looked like it worked. It counted user-message
 * elements each tick and treated any increase as messages sent. On the four
 * hosts that mount only a conversation's tail (ChatGPT, Claude, Gemini, Grok)
 * scrolling up mounts old turns, so reading an old chat registered as sending
 * dozens of messages. And even with a perfect count it could not have been
 * right: these providers meter a rolling window weighted by TOKENS, not
 * messages, so no message count converts into an allowance. The old panel then
 * divided that count by a ceiling typed into a table by hand.
 *
 * So we ask the provider. Two mechanisms, one store:
 *
 *   OBSERVED — content/inject/quota-probe.js reads the quota headers and limit
 *   payloads the host app already receives. Free, and exact at the instant the
 *   allowance moves, because it is the app's own data.
 *
 *   POLLED — the endpoints below, called with the user's session the same way
 *   the history sync does. This is what catches messages sent on a phone or in
 *   another browser, which no in-page mechanism can ever see.
 *
 * The endpoint list is CANDIDATES, not knowledge. These are private, unversioned
 * endpoints; nobody outside the provider knows their shape and it changes. So
 * discovery is empirical: probe the candidates, keep the ones that actually
 * return something quota-shaped for this account, and poll only those. A
 * provider that answers nothing reports nothing, and the popup says so — the
 * one outcome we will not produce is a plausible number with no source.
 */

const QUOTA_PREFIX = "quota:";
const QUOTA_PROBE_KEY = "lct-quota-probe-v1";   // learned endpoints, per platform
const QUOTA_POLL_MIN_MS = 60 * 1000;            // never hit a provider oftener
const QUOTA_CTX_TTL = 5 * 60 * 1000;
const QUOTA_STALE_MS = 12 * 60 * 60 * 1000;
const QUOTA_PROBE_TTL = 24 * 60 * 60 * 1000;    // re-discover once a day
/* A probe that never got to ASK is not a day-old fact about the provider.
   "This account publishes no allowance" is worth caching for a day; "the
   handshake failed" is worth caching for minutes, or a rate limit at the wrong
   moment switches a platform off until tomorrow. Re-asking costs one
   handshake, not the whole candidate list — the probe returns before it tries
   an endpoint. */
const QUOTA_PROBE_RETRY_MS = 10 * 60 * 1000;

const quotaKey = (id, acct) => QUOTA_PREFIX + id + "|" + (acct || "");

/* An account can be tagged two ways — the page hint before an adapter can name
 * it, the provider's own id afterwards — and the record written under the old
 * tag used to survive as a second account in the panel forever. An identical
 * window fingerprint with an older reading is that ghost, never a real second
 * account: two live accounts keep diverging.
 */
const quotaFingerprint = (rec) =>
  (rec && Array.isArray(rec.windows) ? rec.windows : [])
    .map((w) => w.key + ":" + w.remaining + ":" + w.limit).join(",");

async function retireStaleQuotaTags(id, acct, fresh) {
  const fp = quotaFingerprint(fresh);
  if (!fp) return;
  const keep = quotaKey(id, acct);
  const prefix = QUOTA_PREFIX + id + "|";
  const all = await getByPrefix(prefix);
  const dead = [];
  for (const [key, rec] of Object.entries(all)) {
    if (!key.startsWith(prefix) || key === keep || !rec || typeof rec !== "object") continue;
    if (quotaFingerprint(rec) !== fp) continue;
    if ((rec.observedAt || 0) >= (fresh.observedAt || 0)) continue;
    dead.push(key);
  }
  if (dead.length) await chrome.storage.local.remove(dead);
}

/* Why a provider could not be read, in the reader's terms.
   Every failure that was not a challenge used to arrive as "not signed in" —
   a verdict about the ACCOUNT produced by a timeout, a rate limit or a dead
   network. It is the same wrong-answer-that-looks-right the 403 classifier was
   fixed for, one layer up. Only `auth` is a statement about the session. */
function quotaWhy(kind) {
  if (kind === "auth") return "not signed in";
  if (kind === "challenge") return "blocked by the provider";
  if (kind === "rate") return "rate-limited";
  if (kind) return "could not reach the provider";
  return "could not reach the provider";
}

const quotaCtx = new Map();        // host -> { ctx, at }
const quotaPolledAt = new Map();   // id -> ms
const quotaInflight = new Map();   // id -> Promise
const QUOTA_POLLED_AT = "lct-quota-polled-at";
/* Why the last refresh produced nothing.

   A reading that cannot be refreshed keeps its old timestamp, so the panel
   showed a figure from half a day ago with no way to tell whether the poller
   was signed out, throttled, refused, or simply told nothing. The number looked
   frozen and the cause was invisible on every surface. This is local, not
   session: the answer outlives the worker and is exactly what a user staring at
   an old figure needs. */
const QUOTA_LAST_TRY = "lct-quota-last-try-v1";

async function noteQuotaTry(id, outcome) {
  try {
    const held = (await chrome.storage.local.get(QUOTA_LAST_TRY))[QUOTA_LAST_TRY] || {};
    held[id] = { at: Date.now(), ...outcome };
    await chrome.storage.local.set({ [QUOTA_LAST_TRY]: held });
  } catch { /* the reading itself still stands */ }
}

/* The same service-worker defect the session heartbeat had, except this Map is
   the only thing keeping us off somebody else's allowance endpoint. It dies with
   the worker every ~30s of idle, so QUOTA_POLL_MIN_MS was a minute on paper and
   a respawn in practice. storage.session survives the respawn and clears on
   browser restart, which is the one moment a fresh poll is wanted anyway. */
async function quotaLastPoll(id) {
  const mem = quotaPolledAt.get(id) || 0;
  const area = sessionArea();
  if (!area) return mem;
  try {
    const got = await area.get(QUOTA_POLLED_AT);
    const map = (got && got[QUOTA_POLLED_AT]) || {};
    return Math.max(mem, Number(map[id]) || 0);
  } catch { return mem; }
}

async function noteQuotaPoll(id, at) {
  quotaPolledAt.set(id, at);
  const area = sessionArea();
  if (!area) return;
  try {
    const got = await area.get(QUOTA_POLLED_AT);
    const map = (got && got[QUOTA_POLLED_AT]) || {};
    map[id] = at;
    await area.set({ [QUOTA_POLLED_AT]: map });
  } catch { /* the memory map stands in */ }
}

/**
 * Candidate allowance endpoints.
 *
 * `needsOrg` paths are templated with the organisation uuid the adapter's
 * prepare() already resolved. `auth: "bearer"` reuses the access token the
 * ChatGPT adapter fetches; everything else rides on cookies, which bgFetch
 * attaches.
 *
 * Gemini has no entry on purpose rather than by omission: its app talks over a
 * batched RPC with no readable allowance endpoint, and Google publishes no
 * message ceiling for it. Observation is the only route there, and if the app
 * never states a remaining share, Gemini honestly has none to show.
 */
const QUOTA_ENDPOINTS = {
  chatgpt: [
    /* The one that actually answers in 2026. conversation_limit is a 404 now,
       and this is where the app itself reads its limits — found by watching
       what chatgpt.com fetches rather than by guessing at endpoint names.
       It returns named counters ("deep_research: 25 left") rather than a
       percentage, which is why lib/quota.js had to learn to carry a count with
       no ceiling: a remaining with no limit is still a true and useful figure,
       and inventing a denominator for it would be the exact dishonesty this
       panel exists to avoid. */
    /* The real allowance, and the one every ChatGPT client reads: two windows
       (primary and secondary) each carrying used_percent, reset_at and
       limit_window_seconds, plus the account's plan_type at the top level.
       Ahead of conversation/init, whose counters are side features — deep
       research, image generation — that rank() already penalises. */
    /* CODEX, not the chat allowance. This was taken for "the real allowance
       every ChatGPT client reads"; its own body says "You're out of Codex
       messages … upgrade to Plus to continue using Codex". On a Go account it
       reads 100% used for the month while chat has hundreds left, and leading
       the row with it told a paying user they had nothing. It stays — Codex is a
       real limit — but as a named side meter (lib/quota.js SIDE_METER). */
    { path: "/backend-api/wham/usage", auth: "bearer", meter: "codex" },
    { path: "/backend-api/conversation/init", method: "POST", body: {}, auth: "bearer" },
    { path: "/backend-api/conversation_limit", auth: "bearer" },
    { path: "/backend-api/models?history_and_training_disabled=false", auth: "bearer" },
    { path: "/backend-api/subscriptions", auth: "bearer", planOnly: true },
    // Where the plan is stated. Numbers here are entitlement flags, not meters.
    { path: "/backend-api/accounts/check/v4-2023-04-27", auth: "bearer", planOnly: true },
    { path: "/backend-api/me", auth: "bearer", planOnly: true },
    { path: "/public-api/conversation_limit", auth: "bearer" }
  ],
  claude: [
    /* The meters first, the grab-bags last. /api/bootstrap carries the whole
       app's start-up state and any remaining/limit pair anywhere inside it is a
       candidate window — including plan entitlements that have nothing to do
       with how much of today's allowance is left. It is still worth asking; it
       is not worth asking FIRST. */
    { path: "/api/organizations/{org}/usage", needsOrg: true },
    { path: "/api/organizations/{org}/rate_limits", needsOrg: true },
    /* This is the Anthropic CONSOLE's monthly API spend cap — a billing
       control for organisations that use the API with a key, unrelated to the
       five-hour/weekly chat limit claude.ai itself enforces. Read generically
       it produced a real-looking "N% left · month" row for a limit Claude does
       not publish to chat users at all. planOnly: its plan field (when it has
       one) is still worth reading; its numbers are not a chat allowance. */
    { path: "/api/organizations/{org}/usage_limits", needsOrg: true, planOnly: true },
    { path: "/api/organizations/{org}", needsOrg: true, planOnly: true },
    { path: "/api/bootstrap", planOnly: true },
    { path: "/api/account", planOnly: true }
  ],
  grok: [
    // Grok's own UI renders "queries remaining" from a POST, so the probe has
    // to be able to send a body to find it at all.
    { path: "/rest/rate-limits", method: "POST", body: { requestKind: "DEFAULT", modelName: "grok-4" } },
    { path: "/rest/rate-limits", method: "POST", body: { requestKind: "DEFAULT", modelName: "grok-3" } },
    { path: "/rest/subscriptions" },
    { path: "/rest/app-chat/rate-limits", method: "POST", body: { requestKind: "DEFAULT" } }
  ],
  perplexity: [
    /* Where its own app reads them. user/settings carries a quota per
       commercial data partner and no user allowance at all — which is how the
       panel came to report "100% left" from ahrefs, then apollo, then bmj. */
    /* The one its own app reads in 2026: named remaining counters —
       remaining_pro, remaining_research, remaining_labs,
       remaining_agentic_research — plus a per-source monthly table. The
       /status spellings below answered before it and are kept as fallbacks. */
    { path: "/rest/rate-limit/all" },
    { path: "/rest/rate-limit/status?version=2.18&source=default" },
    { path: "/rest/rate-limit/status" },
    { path: "/rest/user/settings" },
    { path: "/api/auth/session" },
    { path: "/rest/user/limits" }
  ],
  deepseek: [
    { path: "/api/v0/users/current" },
    { path: "/api/v0/chat/rate_limit" }
  ],
  /* Not a URL. Gemini has no REST API at all — its allowance arrives as one
     more batchexecute RPC, which needs the app-shell tokens and a framed reply,
     so the adapter answers it and this only asks. `native` is what says so. */
  gemini: [
    { path: "batchexecute:jSf9Qc", native: true }
  ]
};

function quotaAdapter(idOrHost) {
  return BG_ADAPTERS.find((a) => a.id === idOrHost || a.host === idOrHost) || null;
}

async function quotaPrepare(adapter) {
  const hit = quotaCtx.get(adapter.host);
  if (hit && Date.now() - hit.at < QUOTA_CTX_TTL) return hit.ctx;
  const ctx = await adapter.prepare();
  quotaCtx.set(adapter.host, { ctx, at: Date.now() });
  return ctx;
}

/** One candidate, called once. Returns what it found and what it cost, because
 *  the probe report has to be able to say "this endpoint is gone" as clearly as
 *  it says "this one works". */
/* Which product an endpoint meters, looked up by path in QUOTA_ENDPOINTS rather
   than carried on the endpoint object: the learned `working` list is rebuilt
   from a field whitelist, and a field added only to the candidate would be
   dropped between the probe and every poll after it. */
function endpointMeter(adapter, endpoint) {
  const list = QUOTA_ENDPOINTS[adapter && adapter.id] || [];
  const spec = list.find((e) => e.path === (endpoint && endpoint.path));
  return (spec && spec.meter) || (endpoint && endpoint.meter) || "";
}

async function quotaTry(adapter, ctx, endpoint) {
  const org = ctx && (ctx.org || ctx.account) ? String(ctx.org || ctx.account) : "";
  if (endpoint.needsOrg && !org) return { path: endpoint.path, skipped: "no organisation" };

  /* A transport this file cannot speak. The adapter hands back plain JSON and
     everything below — the parser, the report, the diagnostics sample — is the
     same as for a REST answer. */
  if (endpoint.native) {
    if (typeof adapter.quotaJson !== "function") {
      return { path: endpoint.path, skipped: "adapter cannot read an allowance" };
    }
    try {
      const json = await adapter.quotaJson(ctx);
      if (!json) return { path: endpoint.path, ok: false, status: 0 };
      /* The PLAN too. The REST branch below has always read it off the body it
         already has, and this one did not — so Gemini's tier code, which is
         the only statement of a plan that host makes anywhere, was decoded
         into `plan_name` by the adapter and then thrown away here. */
      let plan = "";
      try { plan = (typeof adapter.planFrom === "function" && adapter.planFrom(endpoint.path, json)) || ""; }
      catch { plan = ""; }
      if (!plan) { try { plan = planFromAny(json, 0); } catch { plan = ""; } }
      return {
        path: endpoint.path, status: 200, ok: true, native: true,
        method: "RPC", body: null, needsOrg: false, auth: "cookie",
        plan,
        windows: self.LCTQuota.tagMeter(self.LCTQuota.fromJson(json, {}), endpointMeter(adapter, endpoint)),
        sample: self.LCTQuota.redact(json, 0)
      };
    } catch (error) {
      return { path: endpoint.path, ok: false, error: String((error && error.message) || error) };
    }
  }

  const path = endpoint.path.replace("{org}", encodeURIComponent(org));
  const url = adapter.base + path;
  const headers = {};
  if (endpoint.auth === "bearer") {
    if (!ctx || !ctx.tok) return { path, skipped: "no token" };
    headers.Authorization = "Bearer " + ctx.tok;
  }
  // Two tries, eight seconds: an unfilled ring beats a dial that waits.
  const init = { method: endpoint.method || "GET", headers, attempts: 2, timeoutMs: 8000 };
  if (endpoint.body) {
    init.body = JSON.stringify(endpoint.body);
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await bgFetch(url, init);
    if (!response.ok) return { path, status: response.status, ok: false };
    const json = await bgJson(response);
    /* THE HEADERS TOO. lib/quota.js has carried fromHeaders() — and the comment
       naming `anthropic-ratelimit-unified-5h-remaining` and `…-7d-…` — since it
       was written, and this, the only path that polls a provider directly,
       never called it. So Claude's real meters (a five-hour window and a
       seven-day one, both with a reset) were on every response and read by
       nothing, and the panel fell back to whatever remaining/limit pair sat in
       the body: an untouched 30-of-30 counter reported as "100% left" to
       somebody whose session was three-quarters gone.
       Headers first in the list — a flat, named, vendor-documented meter beats
       a pair inferred from the shape of a JSON blob — though rank() decides,
       not this order. */
    let windows = [];
    try { windows = self.LCTQuota.fromHeaders(response.headers, {}) || []; }
    catch { windows = []; }
    windows = self.LCTQuota.tagMeter(windows.concat(self.LCTQuota.fromJson(json, {})), endpointMeter(adapter, endpoint));
    /* A grab-bag answers with the whole app's start-up state, and any
       remaining/limit pair anywhere inside it reads as an allowance — an
       untouched "30 of 30" for something the user never uses outranks the real
       meter, because a computed percentage scores higher than a percentage with
       only a reset beside it. So these endpoints are asked for the PLAN and
       nothing else: a wrong number is worse than no number. */
    if (endpoint.planOnly) windows = [];
    /* The plan, from a body already in hand. A label is not worth a request of
       its own, and the responses that carry the allowance are the same ones
       that carry the tier. */
    let plan = "";
    try { plan = (typeof adapter.planFrom === "function" && adapter.planFrom(path, json)) || ""; }
    catch { plan = ""; }
    /* Every provider states a tier somewhere; only three of them state it
       where we know to look. planName() refuses anything it does not
       recognise, so a scan can add a plan but never invent one. */
    if (!plan) { try { plan = planFromAny(json, 0); } catch { plan = ""; } }
    return {
      path, status: response.status, ok: true, plan, planOnly: !!endpoint.planOnly,
      method: init.method,
      body: endpoint.body || null,
      needsOrg: !!endpoint.needsOrg,
      auth: endpoint.auth || "cookie",
      windows,
      // The redacted shape is what makes a wrong reading diagnosable: it shows
      // which keys the provider sent without carrying any prose.
      sample: self.LCTQuota.redact(json, 0)
    };
  } catch (error) {
    return { path, ok: false, error: String((error && error.message) || error) };
  }
}

/* The signature says "are these the same candidates I learned against". Hashing
   only `path` missed every other way a candidate can change — method, body,
   auth, needsOrg — and Grok already ships two candidates on the identical path
   /rest/rate-limits differing only by body.modelName. Change that body to a new
   model and the stored `working` entry would keep being served for the whole
   24h QUOTA_PROBE_TTL, POSTing the old model, which is exactly the staleness
   the signature exists to prevent. */
function quotaSig(list) {
  return (list || []).map((e) => JSON.stringify([
    // planOnly and native belong here too: both change what an endpoint MEANS.
    // Marking a grab-bag plan-only without them left yesterday's learned list
    // still treating its numbers as an allowance for a whole day.
    e.path, e.method || "", e.body || null, e.auth || "", !!e.needsOrg,
    !!e.planOnly, !!e.native, e.meter || ""
  ])).join("|");
}

/**
 * Discover which candidates work for this account, and remember.
 *
 * Runs at most daily per platform. The stored report is also exactly what the
 * diagnostics panel shows the user, so "what did we learn" and "what can I
 * verify" are the same record rather than two that can disagree.
 */
async function quotaProbe(platformId, opts = {}) {
  const adapter = quotaAdapter(platformId);
  const candidates = QUOTA_ENDPOINTS[platformId] || [];
  const at = Date.now();
  // What this report is an answer ABOUT — see quotaLearned().
  const sig = quotaSig(candidates);
  /* EVERY report is stored, including the ones that found nothing.
     These two returns used to hand a report back without writing it, so a
     platform whose handshake fails was never marked as checked at all — the row
     said "checking…" for the life of the install, and the diagnostics panel,
     which exists to explain exactly this, had nothing to show. A probe that
     failed is a finding; it is the finding a user most needs. */
  const keep = async (report) => {
    if (opts.dryRun) return report;
    try {
      const { [QUOTA_PROBE_KEY]: held } = await chrome.storage.local.get(QUOTA_PROBE_KEY);
      const all = held && typeof held === "object" ? held : {};
      all[platformId] = report;
      await chrome.storage.local.set({ [QUOTA_PROBE_KEY]: all });
    } catch { /* the reading still returns, it just is not remembered */ }
    return report;
  };

  if (!adapter || !candidates.length) {
    return keep({ id: platformId, at, sig, endpoints: [], working: [],
      note: adapter ? "no candidate endpoints, observation only" : "unknown platform" });
  }

  let ctx;
  try {
    ctx = await quotaPrepare(adapter);
  } catch (error) {
    // The KIND travels with the report: the poll below turns it into words, and
    // the diagnostics panel shows the message beside it.
    const kind = (error && error.kind) || "";
    return keep({ id: platformId, at, sig, endpoints: [], working: [],
      note: quotaWhy(kind), errKind: kind,
      error: String((error && error.message) || error) });
  }

  const endpoints = [];
  for (const endpoint of candidates) {
    endpoints.push(await quotaTry(adapter, ctx, endpoint));
    // Probing is a courtesy call on somebody else's server. bgFetch already
    // paces per host; this keeps a six-endpoint sweep from looking like a scan.
    await sleep(250);
  }

  /* An endpoint that states the PLAN and no number is worth keeping too: the
     plan has to be re-read on every poll, or signing in as a different account
     leaves yesterday's tier on today's row until the next daily probe. */
  const working = endpoints
    .filter((e) => e.ok && ((e.windows && e.windows.length) || e.plan))
    .map((e) => ({ path: e.path, method: e.method || "GET", body: e.body || null,
      needsOrg: !!e.needsOrg, auth: e.auth || "cookie", native: !!e.native,
      planOnly: !!e.planOnly }));

  // What the provider said about the plan, over what the handshake guessed.
  const seenPlan = endpoints.map((e) => e && e.plan).find(Boolean) || "";
  const report = {
    id: platformId, at, sig, plan: seenPlan || (ctx && ctx.plan) || "", endpoints, working,
    note: working.length ? "" : "provider published no allowance for this account"
  };

  return keep(report);
}

/** The endpoints we know work here, discovering them first if we never have. */
async function quotaLearned(platformId) {
  let report = null;
  try {
    const { [QUOTA_PROBE_KEY]: held } = await chrome.storage.local.get(QUOTA_PROBE_KEY);
    report = held && held[platformId] ? held[platformId] : null;
  } catch { /* fall through to a fresh probe */ }

  /* The learned list is also invalid when WE change the candidates. These
     endpoints move — ChatGPT's conversation_limit is a 404 now and the figures
     moved to conversation/init — so shipping a new candidate must take effect
     on the next poll, not a day later when the cache happens to expire. The
     signature is the candidate list itself; if it differs from what was learned
     against, what was learned is about a different question. */
  const sig = quotaSig(QUOTA_ENDPOINTS[platformId] || []);
  const ttl = report && report.errKind ? QUOTA_PROBE_RETRY_MS : QUOTA_PROBE_TTL;
  const fresh = report && report.sig === sig && Date.now() - (report.at || 0) < ttl;
  // The plan travels with the list: the endpoint that states it is often not
  // one that also states a NUMBER, so it is not in `working` and a poll would
  // never see it again. Learned once a day, carried until the next probe.
  if (fresh) {
    return { working: report.working || [], plan: report.plan || "",
      note: report.note || "", errKind: report.errKind || "" };
  }

  // Either we have never looked, or what we learned is a day old and these
  // endpoints move. Re-discover — it is a handful of calls, once.
  const next = await quotaProbe(platformId);
  return { working: next.working || [], plan: next.plan || "",
    note: next.note || "", errKind: next.errKind || "" };
}

/**
 * Read the provider's current allowance and store it.
 *
 * Deduplicated per platform: four tabs sending at once must produce one call,
 * not four, and the second caller wants the first call's answer anyway.
 */
async function quotaPoll(platformId, reason = "manual") {
  /* The switch, enforced where the network call is rather than only in the
     page. Every earlier caller was a content script, which checks the setting
     itself; the worker now polls on its own clock too, and "Allowance tracking
     off" has to mean no request leaves this browser for a provider's limits. */
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && settings.quota === false) {
      await noteQuotaTry(platformId, { skipped: "tracking off" });
      return { id: platformId, skipped: "tracking off" };
    }
  } catch { /* no settings — the default is on */ }

  const inflight = quotaInflight.get(platformId);
  if (inflight) return inflight;

  const last = await quotaLastPoll(platformId);
  if (reason !== "manual" && Date.now() - last < QUOTA_POLL_MIN_MS) {
    /* …unless nothing has ever been LEARNED about this platform.
       The floor exists to stop re-asking a provider we already know how to
       read. A platform with no probe report has never been read at all, and
       one poll that set the clock without leaving a report then blocked every
       later attempt — the row sat on "checking…" for the life of the install,
       which is exactly the state a floor should never be able to create. */
    let probed = false;
    try {
      const { [QUOTA_PROBE_KEY]: held } = await chrome.storage.local.get(QUOTA_PROBE_KEY);
      probed = !!(held && held[platformId]);
    } catch { /* unreadable: treat as never probed and go and look */ }
    if (probed) return { id: platformId, skipped: "polled recently" };
  }

  const run = (async () => {
    const adapter = quotaAdapter(platformId);
    if (!adapter) return { id: platformId, skipped: "unknown platform" };

    /* A handshake cached five minutes ago describes whoever was signed in five
       minutes ago. When somebody ASKS for a reading — the popup opening, the
       diagnostics panel — go and look again: signing in as a different account
       is exactly the moment the cached answer is about the wrong person, and it
       is also the moment the user is watching the panel. */
    if (reason === "manual" || reason === "popup") quotaCtx.delete(adapter.host);
    /* "watch" is the open panel ticking, not somebody asking. It goes through
       every floor there is — the cached handshake included — because the point
       of it is a figure that keeps up, not a provider that gets polled. */

    const { working, plan: learnedPlan, errKind: learnedKind } = await quotaLearned(platformId);
    if (!working.length) {
      /* WHICH silence this is. "No working endpoint" is a statement about the
         provider; a handshake that never landed is a statement about the
         session, and telling somebody their provider publishes no allowance
         when they are simply signed out is the wrong answer twice over.
         Read from the KIND the probe recorded, not from matching words in the
         sentence it wrote — that test called a rate limit a sign-out. */
      const skipped = learnedKind ? quotaWhy(learnedKind) : "no working endpoint";
      await noteQuotaTry(platformId, { skipped });
      trace("quota", `${platformId} ${skipped}`);
      return { id: platformId, skipped };
    }

    let ctx;
    try { ctx = await quotaPrepare(adapter); }
    catch (error) {
      /* Signed OUT is a fact about the account; unreachable is a fact about the
         network, and only the first one means the stored rows are about nobody.
         A panel that keeps stating a plan and a percentage for an account that
         is no longer signed in is worse than an empty panel: it is a wrong
         answer that looks like a real one. `kind === "auth"` is what the
         adapters raise when the session is gone — a timeout raises something
         else and the rows stay put until they go stale on their own. */
      if (error && error.kind === "auth") await forgetQuotaFor(platformId);
      /* A bot-protection challenge is the edge refusing the request shape. The
         session is intact and the stored rows are still about the right person,
         so they stay — and the reason says what would actually clear it. */
      const why = quotaWhy(error && error.kind);
      await noteQuotaTry(platformId, { skipped: why });
      trace("quota", `${platformId} ${why}`);
      return { id: platformId, skipped: why };
    }

    /* EVERY account this login owns, not just the first: `prepare()` builds one
       context from `orgs[0]`, and polling only that read a full allowance off an
       org nobody had used. Capped — sweeping every org of a large workspace on
       somebody's own session is a pattern worth not looking like.
       `accounts()` lists every ORGANISATION, because the archive is per
       organisation — a chat lives in one. An allowance is not: one login owns
       one subscription, and listing a personal org beside a workspace put the
       same person in the panel twice, each row claiming the same plan.
       `quotaSeats()` is the adapter saying which of them holds the allowance. */
    const seats = (typeof adapter.quotaSeats === "function"
      ? adapter.quotaSeats(ctx)
      : typeof adapter.accounts === "function" ? adapter.accounts(ctx) : [ctx]
    ).slice(0, QUOTA_MAX_SEATS);
    let stored = 0, total = 0;
    // Every account this pass KNOWS ABOUT, whether or not it had a number to
    // store — the sweep below reads it, and an account that merely answered
    // nothing today is not an account that is gone.
    const live = new Set();
    const read = [];
    for (const seat of (seats.length ? seats : [ctx])) {
      const acct = await quotaAcctFor(adapter, seat);
      live.add(acct);
      const windows = [];
      let saidPlan = "";
      for (const endpoint of working) {
        const result = await quotaTry(adapter, seat, endpoint);
        if (result.ok && result.windows) windows.push(...result.windows);
        if (!saidPlan && result.plan) saidPlan = result.plan;
      }
      if (!windows.length) continue;
      read.push({
        acct,
        // What the provider states beats what the handshake inferred: the
        // handshake reads an org list, and the org it picks is not always the
        // one being paid for.
        id: platformId,
        plan: saidPlan || learnedPlan || (seat && seat.plan) || (ctx && ctx.plan) || "",
        windows, observedAt: Date.now(), source: "polled"
      });
    }

    /* One subscription, one row — decided from the NUMBERS, not before them.
     *
     * A claude.ai login routinely owns several organisations and they all
     * report the same tier, so picking a seat by plan alone was a coin toss
     * settled by whichever the API listed first — usually the personal org
     * nobody uses. That org honestly has 100% left, and it is the row the
     * subscriber saw while the site told them they had spent a quarter of the
     * week. The allowance being consumed is the one they are using, and the
     * only way to know which that is, is to read them and compare.
     *
     * Ties and unknowns keep the first, which is the old behaviour. */
    if (adapter.oneAllowance && read.length > 1) {
      const winner = pickAllowanceSeat(read);
      /* The seats that lost are not accounts that vanished — they are the same
         subscription seen from another organisation, and leaving them stored
         is what put the subscriber in the panel twice. */
      for (const rec of read) if (rec !== winner) live.delete(rec.acct);
      read.length = 0;
      read.push(winner);
    }

    for (const rec of read) {
      await quotaStore(platformId, rec.acct, rec);
      stored++; total += rec.windows.length;
    }
    /* Rows for accounts this login does not have any more. The panel is a list
       of ACCOUNTS, and one that is gone kept its last reading forever: the
       second organisation that is no longer polled, or a free login replaced by
       a paid one, sat there stating a plan and a percentage for somebody who is
       not signed in. Only where the adapter can NAME an account — where it
       cannot (Gemini, DeepSeek, Grok) the tags come from the page and this list
       is not authoritative — and only after a pass that stored something, so a
       provider being unreachable never empties the panel. */
    if (stored && adapter.namesAccount !== false) {
      await retireUnknownQuotaTags(platformId, live);
    }
    await noteQuotaPoll(platformId, Date.now());
    if (!stored) {
      await noteQuotaTry(platformId, { skipped: "provider reported nothing", tried: working.length });
      trace("quota", `${platformId} reported nothing from ${working.length} endpoint(s)`);
      return { id: platformId, skipped: "provider reported nothing" };
    }
    await noteQuotaTry(platformId, { ok: true, windows: total, accounts: stored });
    trace("quota", `${platformId} ${total} window(s) across ${stored} account(s)`);
    return { id: platformId, windows: total, accounts: stored };
  })();

  quotaInflight.set(platformId, run);
  try { return await run; }
  finally { quotaInflight.delete(platformId); }
}

/* ---------- asking every provider at once ----------
   Every caller of quotaPoll used to be a page, so a reading only ever existed
   for a platform whose site had been opened: a fresh install held no allowance, no
   plan for any account, and drew an empty panel until the user happened to
   visit a chat site. The worker holds the cookies and needs no tab, so it asks
   on its own. Sequential and paced — six providers at once on the user's own
   session is a pattern worth not looking like. */
/* One login, several accounts — but a probe of every org of a 40-seat workspace
   on the user's own cookies is a scan. Four covers a personal org plus the
   workspaces anyone actually chats in. */
const QUOTA_MAX_SEATS = 4;

const BG_QUOTA_SWEEP = "lct-quota-sweep-v1";
const BG_QUOTA_SWEEP_MIN_MS = 15 * 60 * 1000;
let sweepRunning = null;

async function quotaSweep(reason = "manual") {
  // One sweep at a time, and the second caller wants the first one's answer.
  if (sweepRunning) return sweepRunning;
  if (reason !== "manual" && reason !== "install") {
    let last = 0;
    try {
      const held = (await chrome.storage.local.get(BG_QUOTA_SWEEP))[BG_QUOTA_SWEEP];
      last = (held && held.at) || 0;
    } catch { /* no prior sweep */ }
    if (Date.now() - last < BG_QUOTA_SWEEP_MIN_MS) return { status: "throttled", last };
  }
  const run = (async () => {
    /* All six at once. Sequential-with-a-pause was borrowed from the history
       pass, where it stops eight concurrent requests landing on ONE host; these
       are six different hosts, one or two small requests each, and each host's
       own slot still paces it. Serialised, a single signed-out provider's
       timeout delayed every ring behind it — which is the whole first minute
       after install, the one minute the panel is being looked at. */
    const results = await Promise.all([...BG_PLATFORM_IDS].map((id) =>
      // A first sweep must not be silently dropped by the per-platform poll
      // floor, which a page visit seconds earlier would otherwise have armed.
      quotaPoll(id, reason === "install" ? "manual" : reason)));
    try { await chrome.storage.local.set({ [BG_QUOTA_SWEEP]: { at: Date.now(), reason } }); }
    catch { /* dead context */ }
    return { status: "done", results };
  })();
  sweepRunning = run;
  try { return await run; }
  finally { sweepRunning = null; }
}

/** The account tag a reading belongs to. Same tag the archive uses, so a
 *  quota row and a synced account are the same account. */
/* A reading is a key under the platform's prefix, and NOTHING ELSE is.
   Both removers read with `getByPrefix(prefix, [QUOTA_PROBE_KEY])` and then
   deleted every key that came back — so the learned-endpoint report was wiped
   by every successful poll (retire) and every sign-out (forget). It was never
   on disk: every poll re-probed all six candidates, the per-platform poll floor
   never applied because "no report" means "never read at all", and the probe's
   own error — the record that says WHY a provider could not be read — was
   destroyed before anyone could look at it. Worse where storage.local has no
   getKeys() (Firefox): getByPrefix falls back to get(null), so one 401 deleted
   the entire extension store.
   `keysUnder()` is the whole rule: never remove a key the prefix does not own. */
function keysUnder(all, prefix) {
  return Object.keys(all || {}).filter((key) => key.startsWith(prefix));
}

/** Forget every stored reading for a platform nobody is signed in to. */
async function forgetQuotaFor(id) {
  try {
    const prefix = QUOTA_PREFIX + id + "|";
    const keys = keysUnder(await getByPrefix(prefix), prefix);
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch { /* the rows go stale on their own */ }
}

/** Forget every stored reading for an account this login no longer has. */
async function retireUnknownQuotaTags(id, live) {
  if (!live || !live.size) return;
  try {
    const prefix = QUOTA_PREFIX + id + "|";
    const all = await getByPrefix(prefix);
    const dead = keysUnder(all, prefix).filter((key) => !live.has(key.slice(prefix.length)));
    if (dead.length) await chrome.storage.local.remove(dead);
  } catch { /* the panel keeps the extra row until the next pass */ }
}

async function quotaAcctFor(adapter, ctx) {
  try { return await accountTag(adapter, ctx); }
  catch { return ""; }
}

/** Merge a reading into the stored record. The single writer — see
 *  content/quota.js for why this is not done in the content script. */
/* ---------- running out ----------
   The whole reason to read an allowance at all. Every account of this feature
   from the people who live with it says the same thing: there is no meter, no
   countdown and no warning — the first signal is "usage limit reached", by
   which point the session is over and the context you had built is gone.

   A panel showing "100% left" answers a question nobody asks. Being told at
   20% is the product. So this fires at most twice per window, per account, and
   only downward:

     · once under 20%, once under 10%
     · keyed to the window's own reset time, so a rollover re-arms it and a
       re-read of the same window does not fire twice
     · never when allowance tracking is off, and never when the user has said
       they do not want warnings

   No notification is worth a wrong one, so a reading with no percentage or no
   reset produces silence rather than a guess. */
const QUOTA_WARN_KEY = "lct-quota-warned-v1";
const QUOTA_WARN_STEPS = [20, 10];

let quotaWarnWrite = Promise.resolve();

async function quotaMaybeWarn(platformId, acct, record) {
  const work = () => quotaMaybeWarnNow(platformId, acct, record);
  quotaWarnWrite = quotaWarnWrite.then(work, work);
  return quotaWarnWrite;
}

// Read-modify-write over one storage key: two platforms polling at once lost
// one another's ledger entry and both warned again on the next read.
async function quotaMaybeWarnNow(platformId, acct, record) {
  let settings;
  try { settings = (await chrome.storage.local.get("settings")).settings; } catch { return; }
  if (settings && settings.quota === false) return;
  if (settings && settings.quotaWarn === false) return;

  const win = self.LCTQuota.primary(record);
  const pct = win && typeof win.pctLeft === "number" ? win.pctLeft : null;
  if (pct === null) return;

  /* The MOST SEVERE level crossed, not the first one listed. `find` returned 20
     for a reading of 7% — so falling from 15% to 7% looked like the same level
     already warned about, and the one warning that matters most never fired. */
  const crossed = QUOTA_WARN_STEPS.filter((s) => pct <= s);
  if (!crossed.length) return;
  const step = Math.min(...crossed);

  /* The window's own reset is the identity of "this window". Without one we
     cannot tell a fresh drop from the same drop re-read, so we stay quiet.

     Bucketed to five minutes rather than used to the millisecond: providers
     re-state the same deadline with a little drift — a rolling "in 3600
     seconds" resolves to a different absolute time on every read — and an
     identity that moves is an identity that re-arms the warning every time
     anyone looks. That is a notification every minute, which is how a useful
     warning becomes one people turn off. */
  const windowId = win.resetAt ? Math.round(win.resetAt / 3e5) : 0;
  if (!windowId) return;

  const id = `${platformId}|${acct || ""}`;
  let seen = {};
  try { seen = (await chrome.storage.local.get(QUOTA_WARN_KEY))[QUOTA_WARN_KEY] || {}; } catch { /* first time */ }
  const already = seen[id];
  // Same window, and we have already said something at this level or lower.
  if (already && already.windowId === windowId && already.step <= step) return;

  /* A different window winning primary() is not a new thing to say. primary()
     ranks by informativeness and then by the LOWEST pctLeft, and merge() pools
     windows from several endpoints — so on Perplexity the winner flips between
     meters with different reset times, each flip minting a new windowId and
     another notification, three of them inside a minute. The same happens
     across the acct tag: quotaObserved stores under "" before the handshake
     completes while quotaPoll stores under the real account, so one person got
     two ledger entries and two notifications for one allowance.
     Both are answered by the same rule: having just said something about this
     platform at this level or lower, say nothing more for a while. */
  const QUIET_MS = 30 * 60 * 1000;
  const spokeRecently = Object.entries(seen).some(([k, v]) =>
    v && v.at && k.split("|")[0] === platformId &&
    v.at + QUIET_MS > Date.now() && v.step <= step);
  if (spokeRecently) return;

  seen[id] = { windowId, step, at: Date.now() };
  /* Prune by WHEN WE WARNED, not by the window id — the id is a five-minute
     bucket, not a timestamp, and treating it as one made every record look
     ancient the instant it was written. Which meant the ledger was always
     empty, and every re-read of the same low number warned again. */
  for (const [k, v] of Object.entries(seen)) {
    if (!v || !v.at || v.at + 7 * 864e5 < Date.now()) delete seen[k];
  }
  try { await chrome.storage.local.set({ [QUOTA_WARN_KEY]: seen }); } catch { /* dead context */ }

  const label = (BG_ADAPTERS.find((a) => a.id === platformId) || {}).label || platformId;
  const when = win.resetAt ? new Date(win.resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    await chrome.notifications.create(`lct-quota-${id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `${label}: ${Math.round(pct)}% of your allowance left`,
      message: when
        ? `Wrap up or switch models. It resets at ${when}.`
        : "Wrap up or switch models before it runs out.",
      priority: pct <= 10 ? 2 : 1
    });
  } catch { /* notifications unavailable — the popup still shows it */ }
}

async function quotaStore(platformId, acct, reading) {
  const key = quotaKey(platformId, acct);
  try {
    const held = await chrome.storage.local.get(key);
    const merged = self.LCTQuota.merge(held[key] || null, reading, { staleMs: QUOTA_STALE_MS });
    // An unchanged reading must not be written. chrome.storage fires onChanged
    // on every set, the popup repaints on quota keys, and the popup asks for a
    // refresh when it opens — writing a byte-identical record would make those
    // three into a repaint loop. A re-read that says the same thing is not news.
    if (held[key] && JSON.stringify(held[key]) === JSON.stringify(merged)) return merged;
    await chrome.storage.local.set({ [key]: merged });
    retireStaleQuotaTags(platformId, acct, merged).catch(() => { /* best effort */ });
    quotaMaybeWarn(platformId, acct, merged).catch(() => { /* never block a write */ });
    return merged;
  } catch {
    return null;
  }
}

/**
 * Fold in what a content script saw the host app receive.
 *
 * The account is resolved here from the host, which means an observation made
 * before the account handshake completes lands on the host-wide tag and a later
 * one lands on the account — the same fallback the archive uses. Both describe
 * the same person; only the label differs.
 */
async function quotaObserved(host, observations, hint = "") {
  const platformId = PAGE_PLATFORMS[host] || "";
  if (!platformId || !Array.isArray(observations) || !observations.length) return { ok: false };

  const windows = [];
  let at = 0;
  for (const item of observations.slice(0, 24)) {
    if (!item || typeof item !== "object") continue;
    at = Math.max(at, Number(item.at) || 0);
    try {
      if (item.kind === "headers" && item.headers) {
        windows.push(...self.LCTQuota.fromHeaders(item.headers, {}));
      } else if (item.kind === "body" && item.json) {
        windows.push(...self.LCTQuota.fromJson(item.json, {}));
      }
    } catch { /* one malformed observation must not drop the batch */ }
  }
  if (!windows.length) return { ok: true, windows: 0 };

  // The observation already happened; resolving the account must not be allowed
  // to lose it, so a failed handshake stores against the host-wide tag.
  let acct = "";
  let plan = "";
  try {
    const who = await accountForHost(host, hint);
    acct = who.acct || "";
    plan = who.plan || "";
  } catch { /* host-wide tag it is */ }

  await quotaStore(platformId, acct, {
    id: platformId, acct, plan,
    windows, observedAt: at || Date.now(), source: "observed"
  });
  return { ok: true, windows: windows.length };
}

/** Every stored reading, for the popup. Shaped for rendering, not for storage:
 *  the popup gets the one window it should draw plus the provenance it needs to
 *  be honest about where the figure came from. */
async function quotaState() {
  const out = [];
  let probes = {};
  try {
    const all = await getByPrefix(QUOTA_PREFIX, [QUOTA_PROBE_KEY]);
    probes = all[QUOTA_PROBE_KEY] || {};
    for (const [key, record] of Object.entries(all)) {
      if (!key.startsWith(QUOTA_PREFIX) || !record || typeof record !== "object") continue;
      const all = self.LCTQuota.ranked(record, {});
      const win = all[0] || null;
      const shape = (w) => ({
        key: w.key, label: w.label, pctLeft: w.pctLeft, resetAt: w.resetAt,
        span: w.span || "", spanSec: w.spanSec || 0,
        basis: w.basis, unit: w.unit, remaining: w.remaining, limit: w.limit,
        observedAt: w.observedAt || 0, source: w.source || ""
      });
      const blockers = all.filter((w) => self.LCTQuota.blocksProvider(w));
      const blocker = blockers.reduce((latest, w) =>
        !latest || (w.resetAt || 0) > (latest.resetAt || 0) ? w : latest, null);
      out.push({
        id: record.id || key.slice(QUOTA_PREFIX.length).split("|")[0],
        acct: record.acct || "",
        plan: record.plan || "",
        observedAt: record.observedAt || 0,
        source: record.source || "",
        blocked: !!blocker,
        blocker: blocker ? shape(blocker) : null,
        // Which window this is — "5h", "week". Claude publishes both and the
        // panel has to say which one the number belongs to.
        window: win ? shape(win) : null,
        /* …and ALL of them, best first, so the row can be stepped through.
           A provider that publishes a session limit AND a weekly one is
           answering two different questions; the row leads with the one that
           stops you soonest and the reader can ask for the other. Capped: past
           a few this stops being a switch and becomes a list. */
        windows: all.slice(0, 4).map(shape)
      });
    }
  } catch { /* an empty state renders as "not reported", which is true */ }

  // Which platforms have been asked at all, so the popup can distinguish
  // "nothing published" from "never checked".
  const checked = {};
  for (const [id, report] of Object.entries(probes)) {
    checked[id] = { at: report.at || 0, working: (report.working || []).length,
      note: report.note || "" };
  }
  // Why each platform's figure is as old as it is. See QUOTA_LAST_TRY.
  let lastTry = {};
  try { lastTry = (await chrome.storage.local.get(QUOTA_LAST_TRY))[QUOTA_LAST_TRY] || {}; }
  catch { /* the readings still render */ }
  return { records: out, checked, lastTry, observable: Object.keys(PAGE_PLATFORMS) };
}

/** The comparison report the diagnostics panel renders. Runs a live probe so
 *  the user is checking what the provider says right now against what we show
 *  right now — a stale probe would make a disagreement unattributable. */
async function quotaDiagnose(platformId) {
  /* Every supported platform, not only the ones with candidate endpoints. A
     provider we cannot poll still belongs on this page: Gemini reports nothing
     readable, and the user is entitled to see that stated rather than to find
     it missing and wonder whether it was forgotten. */
  const ids = platformId
    ? [platformId]
    : Array.from(new Set(Object.values(PAGE_PLATFORMS))).filter((id) => quotaAdapter(id));
  const out = [];
  for (const id of ids) {
    const probe = await quotaProbe(id);
    const acct = await (async () => {
      const adapter = quotaAdapter(id);
      if (!adapter) return "";
      try { return await quotaAcctFor(adapter, await quotaPrepare(adapter)); }
      catch { return ""; }
    })();
    let stored = null;
    try {
      const key = quotaKey(id, acct);
      stored = (await chrome.storage.local.get(key))[key] || null;
    } catch { /* nothing stored yet */ }
    out.push({ id, acct, probe, stored, shown: stored ? self.LCTQuota.primary(stored, {}) : null });
  }
  return { at: Date.now(), platforms: out };
}

/**
 * Of several seats on ONE subscription, the seat whose allowance is being spent.
 *
 * Self-contained on purpose: test/test-parsers.mjs lifts this function on its
 * own, and anything it referenced from module scope would be missing from the
 * lift.
 */
function pickAllowanceSeat(read) {
  const list = Array.isArray(read) ? read : [];
  if (list.length < 2) return list[0];
  const spent = (rec) => {
    let low = Infinity;
    for (const w of (rec && rec.windows) || []) {
      if (w && typeof w.pctLeft === "number") low = Math.min(low, w.pctLeft);
    }
    return low;
  };
  let winner = list[0];
  for (const rec of list) if (spent(rec) < spent(winner)) winner = rec;
  return winner;
}

async function sweepDue(platformId) {
  try {
    const { [BG_SWEEP_STATE]: state } = await chrome.storage.local.get(BG_SWEEP_STATE);
    const at = (state && state[platformId]) || 0;
    return Date.now() - at > BG_SWEEP_MS;
  } catch { return false; }
}

/* Kept so the UI can explain a silence: "we saw most of your history vanish
   from the listing and did not believe it" is information the user wants. */
async function noteSweepAnomaly(platformId, missing, archived) {
  try {
    // Serialised: markSwept() edits the same record, six platforms at a time.
    await editLocal(BG_SWEEP_STATE, (state) => ({
      ...(state && typeof state === "object" ? state : {}),
      anomaly: { platform: platformId, missing, archived, at: Date.now() }
    }));
  } catch { /* nothing to record it in */ }
}

async function markSwept(platformId) {
  try {
    await editLocal(BG_SWEEP_STATE, (state) => ({
      ...(state && typeof state === "object" ? state : {}),
      [platformId]: Date.now()
    }));
  } catch { /* next pass sweeps instead */ }
}
