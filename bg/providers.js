/**
 * Tvara background worker — everything that knows a provider's wire format, and the adapter table.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

/**
 * The branch of a ChatGPT conversation the page actually renders: current_node
 * walked up the parent chain, root-first.
 *
 * Object.values(mapping) also hands back every dead edit/regenerate branch, and
 * create_time is not an ordering ACROSS branches — so the old flat sort produced
 * a transcript that no reader ever saw, in an order it was never in. That was
 * survivable for search; it is not survivable for a map whose positions have to
 * line up with the DOM.
 */
function chatBranch(conv) {
  const map = (conv && conv.mapping) || null;
  if (!map) return [];
  const out = [];
  const seen = new Set();                 // a malformed parent cycle must not hang the worker
  let id = conv.current_node;
  while (id && map[id] && !seen.has(id)) { seen.add(id); out.push(map[id]); id = map[id].parent; }
  out.reverse();
  // Share links and older payloads carry no current_node — fall back to the
  // flat sort rather than returning nothing.
  return out.length ? out : Object.values(map).sort(
    (a, b) => ((a.message && a.message.create_time) || 0) - ((b.message && b.message.create_time) || 0)
  );
}

/**
 * One ChatGPT conversation as an ordered message list, keeping the provider's
 * message id.
 *
 * Where a node kind is ambiguous, INCLUDE it: a surplus entry only draws a tick
 * that never binds to an element, which the map already tolerates. A missing
 * entry shifts every position after it.
 */
function chatgptMsgs(conv) {
  const msgs = [];
  for (const node of chatBranch(conv)) {
    const m = node && node.message;
    if (!m || !m.author) continue;
    const role = m.author.role;
    if (role !== "user" && role !== "assistant") continue;
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
    if (m.recipient && m.recipient !== "all") continue;      // a tool call, not a turn
    const parts = (m.content && m.content.parts) || [];
    const text = parts.filter((p) => typeof p === "string").join("\n").trim();
    /* An image-only turn still occupies a row in the page and the map's
       positions have to match it, so empty text is kept — but ONLY when the
       message actually carries a part that is not text. The mapping also holds
       reasoning summaries, browsing displays and streaming placeholders under
       author "assistant" and recipient "all", every one of them empty and none
       of them a turn: on a two-message conversation the map drew four ticks,
       one previewing as "Image / attachment". */
    const media = parts.some((p) => p && typeof p === "object");
    if (!text && !media) continue;
    msgs.push({
      i: String(m.id || node.id || ""),
      r: role,
      t: text,
      // Says the emptiness is real content, not a placeholder. Read on the way
      // back out, where records written before this cannot be told apart.
      ...(media && !text ? { m: 1 } : {}),
      ts: m.create_time ? Math.floor(m.create_time) : 0
    });
  }
  return msgs;                            // branch order IS reading order — no sort
}

/* ---------- Gemini ----------
 * Gemini has no REST API. Its own web app talks to `batchexecute`, a generic
 * Google RPC transport, and everything about it is positional: the request is
 * JSON nested inside a JSON string, and the reply is a stream of
 * length-prefixed frames whose payloads are also JSON inside a JSON string,
 * read by index rather than by name.
 *
 * That makes it the most fragile adapter here by a wide margin, so the rule for
 * every step below is the same: a shape we do not recognise raises, and never
 * returns a plausible-looking empty result. `unreadable` in walkScheme and
 * BgError("shape") exist for exactly this surface — a silent Gemini would look
 * identical to a signed-out one.
 *
 * Verified against Google's own client behaviour as documented by the
 * gemini_webapi project; the rpc ids and index positions are its findings.
 */
const GEMINI_BATCH_PATH = "/_/BardChatUi/data/batchexecute";
const GEMINI_RPC_LIST = "MaZiqc";     // list conversations
/* Gemini publishes an allowance after all — not over REST (there is none) but
   as one more batchexecute RPC, the same transport the listing uses. The reply
   is positional, like everything else here: [status, [bucket, …]] where a
   bucket is [remaining, usedRatio, type, [[seconds, nanos]]] and type 1 is the
   five-hour window, type 2 the weekly one. */
const GEMINI_RPC_USAGE = "jSf9Qc";    // allowance buckets
const GEMINI_RPC_READ = "hNvQHb";     // read one conversation
const GEMINI_LIST_MAX = 400;          // conversations asked for per shelf
const GEMINI_TURN_MAX = 2000;         // turns asked for per conversation
/* Gemini keeps pinned and unpinned conversations on separate shelves and one
   call returns only one of them. Both, or half a history goes unarchived —
   and, worse, a listing missing half the account would look complete to the
   sweep. The trailing triple is [pinned, cursor, unknown]. */
const GEMINI_SHELVES = [1, 0];

let geminiReqid = 0;

/** End (exclusive) of the JSON array or object starting at `from`.
 *
 *  String- and escape-aware, because a bracket inside somebody's message would
 *  otherwise be read as closing the frame. */
function geminiValueEnd(body, from) {
  let depth = 0, inString = false, escaped = false;
  for (let i = from; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") { if (--depth === 0) return i + 1; }
  }
  return -1;   // unbalanced — a truncated frame
}

/** Strip the `)]}'` guard, then walk Google's length-prefixed frames.
 *
 *  The length markers are SKIPPED rather than trusted. Sources disagree on
 *  whether the count includes one surrounding newline or both, and a
 *  one-character error there does not lose one frame — it desynchronises the
 *  scan and every later frame with it. The JSON value's own extent is
 *  unambiguous, so that is what decides where a frame ends; the digits are
 *  just something to step over. It also means a reply that arrives unframed,
 *  as a single bare array, needs no special case. */
function geminiFrames(text) {
  let body = String(text || "");
  if (body.startsWith(")]}'")) body = body.slice(4);

  const frames = [];
  const space = /\s/;
  let at = 0;
  while (at < body.length) {
    while (at < body.length && space.test(body[at])) at++;
    while (at < body.length && body[at] >= "0" && body[at] <= "9") at++;
    while (at < body.length && space.test(body[at])) at++;
    if (body[at] !== "[") break;
    const end = geminiValueEnd(body, at);
    if (end <= at) break;
    try { frames.push(JSON.parse(body.slice(at, end))); } catch { /* skip this frame */ }
    at = end;
  }
  return frames;
}

/** Every `wrb.fr` payload for one rpc id, already un-nested from its JSON
 *  string. Index 2 is the payload; index 1 names the rpc that produced it, and
 *  it is checked, because a batch reply carries other envelopes too. */
function geminiPayloads(text, rpcid) {
  const out = [];
  for (const frame of geminiFrames(text)) {
    for (const part of (Array.isArray(frame) ? frame : [])) {
      if (!Array.isArray(part) || part[0] !== "wrb.fr" || part[1] !== rpcid) continue;
      if (typeof part[2] !== "string" || !part[2]) continue;
      try { out.push(JSON.parse(part[2])); } catch { /* not this envelope */ }
    }
  }
  return out;
}

/** Gemini timestamps arrive as [seconds, nanos]. */
function geminiTime(value) {
  if (!Array.isArray(value) || !value.length) return 0;
  const secs = Number(value[0]) || 0;
  if (secs <= 0) return 0;
  return Math.round(secs * 1000 + (Number(value[1]) || 0) / 1e6);
}

/** Read a positional path out of a batchexecute payload. Everything in these
 *  replies is addressed by index, and any hop can legitimately be absent, so a
 *  miss is undefined rather than a throw. */
/**
 * The ANSWER out of a candidate's text list.
 *
 * A thinking model puts its working in that same list, ahead of the reply —
 * so taking element 0 archived "Drafting the Formulas (Mental Check & LaTeX
 * formatting)… Writing the Final Response: start with a polite overview" as
 * though it were the answer, and the answer itself was never stored at all.
 * This is the same rule as THINK_SEL in the page, applied where the page's
 * rules cannot reach: Gemini is archived from the RPC, not the DOM.
 *
 * Structure only, never the words: the reply is the LAST text the candidate
 * carries, because the working is written before the answer and never after
 * it. One entry is unchanged behaviour — nothing to tell apart.
 */
function geminiText(list) {
  if (typeof list === "string") return list.trim();
  if (!Array.isArray(list)) return "";
  const parts = [];
  for (const part of list) {
    const text = typeof part === "string" ? part
      : (Array.isArray(part) && typeof part[0] === "string") ? part[0] : "";
    if (text && text.trim()) parts.push(text.trim());
  }
  return parts.length ? parts[parts.length - 1] : "";
}

function geminiAt(node, path) {
  let at = node;
  for (const step of path) {
    if (!Array.isArray(at)) return undefined;
    at = at[step];
  }
  return at;
}

const GEMINI_AT_RE = /"SNlM0e":\s*"(.*?)"/;
const GEMINI_BL_RE = /"cfb2h":\s*"(.*?)"/;
const GEMINI_SID_RE = /"FdrFJe":\s*"(.*?)"/;

/* ---------- Grok ---------- */
const GROK_RESPONSE_BATCH = 50;    // the batch size grok.com's own client uses

/**
 * A Grok timestamp. ISO 8601 with a zone is what it sends today.
 *
 * Numbers are tolerated deliberately: this is an undocumented endpoint, and a
 * build that switched to epoch millis — or seconds — would otherwise zero every
 * date silently, which reads downstream as "this chat was never updated" and
 * quietly freezes it out of every future delta.
 */
function xaiTime(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

/* ---------- Perplexity ----------
   Every Perplexity request the app makes carries these, and it costs nothing
   to look like the app rather than like something else. */
const PPLX_Q = "?version=2.18&source=default";
const PPLX_HEADERS = { "x-app-apiclient": "default", "x-app-apiversion": "2.18" };

/**
 * Perplexity stamps naive ISO with no zone: "2026-02-17T08:02:14.816554".
 *
 * Date.parse reads that as LOCAL time, so the same thread would carry a
 * different updatedAt in every timezone — and it is compared against a
 * watermark that is a Date.now(), i.e. UTC. West of Greenwich that skew reads
 * as "updated in the future" and the chat is re-fetched every pass; east of it
 * the chat falls behind the watermark and is never fetched again. Pin it.
 */
function pplxTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + "Z");
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The assistant's half of one Perplexity turn.
 *
 * Three spellings, and they are not interchangeable: `text` is the answer as a
 * plain string, `answer` is the SAME answer wrapped in a JSON-encoded string
 * (so reading it raw archives `{"answer":"…"}` as the message body), and a
 * schematized reply has neither and carries it in a block instead. Read them
 * in that order and never fall back to the raw wrapper.
 */
/* A FOURTH spelling, and the one that reached the archive as a wall of JSON:
   `text` is sometimes not the answer at all but the whole reasoning TRACE — a
   JSON array of steps, INITIAL_QUERY then SEARCH_WEB then SEARCH_RESULTS then
   FINAL, with the actual answer buried in the last one and JSON-encoded a
   second time inside it. Reading `text` raw archived every search result, every
   url and every internal flag as the message body.

   Walk the steps backwards: FINAL is what the reader saw, and anything after it
   is not an answer. */
function pplxFromTrace(raw) {
  if (!/^\s*\[/.test(raw)) return "";
  let steps;
  try { steps = JSON.parse(raw); } catch { return ""; }
  if (!Array.isArray(steps)) return "";
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const answer = step && step.content && step.content.answer;
    if (typeof answer !== "string" || !answer) continue;
    try {
      const inner = JSON.parse(answer);
      const text = String((inner && inner.answer) || "").trim();
      if (text) return text;
    } catch { /* not doubly encoded — the string itself is the answer */ }
    const text = answer.trim();
    if (text) return text;
  }
  return "";
}

function pplxAnswer(entry) {
  const plain = String(entry.text || "").trim();
  const fromTrace = pplxFromTrace(plain);
  if (fromTrace) return fromTrace;
  /* Character codes, not a literal brace: test/test-parsers.mjs lifts these
     functions out of this file by counting braces, and a "{" inside a regex or
     a string is an unbalanced open to a counter that does not parse. It reads
     the function as truncated and the whole suite dies on a SyntaxError two
     files later. 91 is "[", 123 is "{". */
  const head = plain.charCodeAt(0);
  if (plain && head !== 91 && head !== 123) return plain;

  if (typeof entry.answer === "string" && entry.answer) {
    try {
      const parsed = JSON.parse(entry.answer);
      const text = String((parsed && parsed.answer) || "").trim();
      if (text) return text;
    } catch { /* not the wrapper shape — fall through to blocks */ }
  }

  for (const block of (Array.isArray(entry.blocks) ? entry.blocks : [])) {
    if (!block || block.intended_usage !== "ask_text") continue;
    const text = String((block.markdown_block && block.markdown_block.answer) || "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * A plan name a provider states about itself, normalised.
 *
 * Every provider spells its own tiers differently and changes the spelling
 * without notice — Anthropic moved from a `claude_pro` capability to a
 * `rate_limit_tier` of `default_claude_max_20x`, OpenAI says
 * `chatgptplusplan`. Matching on SUBSTRINGS rather than on a table of exact
 * strings is what keeps a renamed tier from silently reading as Free, which is
 * the one wrong answer that looks like a real answer.
 */
function planName(raw) {
  const v = String(raw || "").toLowerCase();
  if (!v) return "";
  /* OpenAI spells a tier as ONE word — chatgptgoplan, chatgptprolite — so the
     product word and the "plan" suffix have to come off before a short tier can
     be matched as a token at all. Both of these were wrong: Go matched nothing
     and reported no plan, and Pro Lite matched "pro" and reported the tier
     above it. A cheaper plan named as the expensive one is exactly the wrong
     answer that looks like a real one. */
  const tier = v.replace(/chatgpt|openai/g, "").replace(/plan/g, "");
  if (v.includes("enterprise")) return "Enterprise";
  if (v.includes("team") || v.includes("raven")) return "Team";
  if (v.includes("max")) {
    return v.includes("20x") ? "Max (20x)" : v.includes("5x") ? "Max (5x)" : "Max";
  }
  // Before Pro, which it contains.
  if (/pro[\s_-]?lite/.test(tier)) return "Pro Lite";
  // "chatgptproplan" and "claude pro" are both Pro; "chatgptplusplan" is Plus.
  if (v.includes("plus")) return "Plus";
  if (v.includes("pro")) return "Pro";
  /* "go" ONLY as a whole token. As a substring it is inside google, cargo and
     django, and a tier badge invented out of one of those is worse than none. */
  if (/(^|[^a-z])go([^a-z]|$)/.test(tier)) return "Go";
  if (v.includes("free")) return "Free";
  return "";
}

/**
 * A plan named anywhere in a response, for providers whose adapter does not
 * say where to look.
 *
 * Grok, DeepSeek and Gemini publish a tier somewhere in the bodies the
 * allowance probe already reads, under a name nobody documents. Scanning for a
 * plan-shaped KEY and running its value through planName() is safe precisely
 * because planName refuses anything it does not recognise: a stray "tier": "b2"
 * yields nothing rather than a wrong badge.
 */
function planFromAny(json, depth) {
  // Inlined, not hoisted to a const: test/test-parsers.mjs lifts this function
  // on its own and a module-level constant would be missing from the lift.
  const planKey = /(^|_)(plan|tier|subscription|membership|product)(_|$)|planname|producttype/i;
  if (!json || typeof json !== "object" || (depth || 0) > 4) return "";
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === "string" && planKey.test(key)) {
      const named = planName(value);
      if (named) return named;
    }
  }
  for (const value of Object.values(json)) {
    if (value && typeof value === "object") {
      const named = planFromAny(value, (depth || 0) + 1);
      if (named) return named;
    }
  }
  return "";
}

/* Which of two plans is the one to report when a login owns several. A
   function, not a table, so the same ordering is liftable into the tests. */
function planRank(plan) {
  switch (String(plan || "")) {
    case "Free": return 1;
    case "Go": return 2;
    case "Plus": return 3;
    case "Pro Lite": return 4;
    case "Pro": return 5;
    case "Team": return 6;
    case "Max": case "Max (5x)": return 7;
    case "Max (20x)": return 8;
    case "Enterprise": return 9;
    default: return 0;
  }
}

/**
 * Of several seats one login owns, the one whose plan IS the login's plan.
 *
 * A claude.ai login routinely owns several organisations — a personal one, one
 * an invite created, one an app made — and the allowance belongs to the
 * subscription, not to whichever org the API happens to list first. Reading the
 * first one called a paying account Free, and polling all of them put the same
 * person in the panel twice, at whatever percentage the unused org reported.
 */
function bestPlanSeat(seats) {
  const list = Array.isArray(seats) ? seats : [];
  let best = list[0];
  for (const seat of list) {
    if (planRank(seat && seat.plan) > planRank(best && best.plan)) best = seat;
  }
  return best;
}

/** Claude states the tier on the organisation, so the plan costs no extra
 *  request — and a plan is what decides the usage ceiling the popup draws. */
function claudeOrgCtx(org) {
  const caps = Array.isArray(org && org.capabilities) ? org.capabilities.map(String) : [];
  /* `rate_limit_tier` is where Anthropic states it now ("default_claude_max_20x",
     "default_claude_pro"). Capabilities came first and are still sent, so they
     stay as the fallback — but read alone they called a Max account "Pro" and,
     on an org that lists neither, a paying account "Free". */
  const plan = planName(org && org.rate_limit_tier)
    || (org && org.raven_type ? "Team" : "")
    || (caps.includes("claude_max")
      ? planName(String((org && org.rate_limit_tier) || "") + " max") : "")
    || (caps.includes("claude_pro") ? "Pro" : "")
    || (caps.includes("raven") || caps.includes("claude_team") ? "Team" : "")
    || "Free";
  return {
    org: org.uuid,
    account: org.uuid,
    identified: true,
    // Personal orgs are named after the account's email; masked before storage.
    handle: String((org && org.name) || ""),
    plan
  };
}

const BG_ADAPTERS = [
  {
    id: "chatgpt", label: "ChatGPT", base: "https://chatgpt.com",
    host: "chatgpt.com", prefix: "/c/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/auth/session");
      const j = await bgJson(r);
      if (!j || !j.accessToken) throw new BgError("auth", "not signed in");
      const account = j.user?.id || j.user?.email || j.account?.id || "";
      return {
        tok: j.accessToken,
        account,
        // The session names the signed-in user, so two accounts are told apart
        // outright and never have to be inferred from what they hold.
        identified: !!account,
        handle: String(j.user?.email || ""),
        plan: String(j.user?.plan || j.account?.plan_type || "")
      };
    },
    /* The plan, out of a response the allowance probe was already fetching.
       /api/auth/session does NOT carry it — the field prepare() used to read
       has never existed there, so every ChatGPT account showed as no plan at
       all. accounts/check is where the app itself reads its entitlement. */
    planFrom(path, json) {
      if (!json || typeof json !== "object") return "";
      if (path.startsWith("/backend-api/accounts/check")) {
        const accounts = json.accounts || {};
        const order = Array.isArray(json.account_ordering) ? json.account_ordering : Object.keys(accounts);
        for (const id of order) {
          const acct = accounts[id];
          if (!acct) continue;
          const named = planName(acct.entitlement && acct.entitlement.subscription_plan);
          if (named) return named;
          if (acct.is_paid === false) return "Free";
        }
      }
      return planName(json.plan_type || json.subscription_plan
        || (json.entitlement && json.entitlement.subscription_plan));
    },
    async get(ctx, path, opts) {
      const r = await bgFetch(this.base + path, {
        headers: { Authorization: "Bearer " + ctx.tok },
        ...(opts || {})
      });
      return bgJson(r);
    },
    // One request: is anything newer than the watermark? Turns a routine
    // "nothing changed" pass into a single call instead of a full listing.
    async peek(ctx, sinceMs) {
      const j = await this.get(ctx, "/backend-api/conversations?offset=0&limit=1&order=updated");
      const it = (j.items || [])[0];
      if (!it) return { hasNew: false, newestMs: 0 };
      const upd = it.update_time ? new Date(it.update_time).getTime() : Date.now();
      return { hasNew: upd > sinceMs, newestMs: upd };
    },
    async list(ctx, sinceMs, progress) {
      const metas = [];
      let hitOld = false, complete = false, page = 0;
      for (; page < BG_LIST_MAX_PAGES && !hitOld; page++) {
        if (page) await sleep(policyFor(this.host).listDelayMs);
        const j = await this.get(ctx,
          `/backend-api/conversations?offset=${page * BG_SYNC_LIST_PAGE}&limit=${BG_SYNC_LIST_PAGE}&order=updated`);
        const items = j.items || [];
        for (const it of items) {
          const upd = it.update_time ? new Date(it.update_time).getTime() : Date.now();
          if (sinceMs && upd <= sinceMs) { hitOld = true; break; }
          metas.push({
            id: it.id, title: it.title || "",
            createdAt: it.create_time ? new Date(it.create_time).getTime() : 0,
            updatedAt: upd
          });
        }
        progress(metas.length, j.total || 0, `Listing chats… ${metas.length}`);
        if (items.length < BG_SYNC_LIST_PAGE) { complete = true; break; }
      }
      return { metas, complete: complete || hitOld };
    },
    // One request returns the whole conversation. detailFull keeps the title and
    // revision too, so a single-chat index fetch can archive what it read.
    async detailFull(ctx, id, opts) {
      const conv = await this.get(ctx, "/backend-api/conversation/" + id, opts);
      return {
        msgs: chatgptMsgs(conv),
        title: String(conv.title || ""),
        createdAt: conv.create_time ? Math.round(conv.create_time * 1000) : 0,
        updatedAt: conv.update_time ? Math.round(conv.update_time * 1000) : 0
      };
    },
    async detail(ctx, id) {
      return (await this.detailFull(ctx, id)).msgs;
    }
  },
  {
    id: "claude", label: "Claude", base: "https://claude.ai",
    host: "claude.ai", prefix: "/chat/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/organizations");
      const orgs = await bgJson(r);
      const list = (Array.isArray(orgs) ? orgs : []).filter((o) => o && o.uuid);
      const org = list[0];
      if (!org) throw new BgError("auth", "not signed in");
      /* The org stays the first one — it is what every checkpoint and archived
         row is keyed to, and re-keying it would re-download the world. The PLAN
         does not: a login owns one subscription, and reading it off whichever
         org happens to be listed first called a paying account Free whenever
         the paid org was not that one. */
      const paid = bestPlanSeat(list.map(claudeOrgCtx));
      return { ...claudeOrgCtx(org), plan: (paid && paid.plan) || "", orgs: list };
    },
    // One Claude login can own several organisations, and chats live in exactly
    // one of them. Syncing only the first quietly archived nothing from the
    // others — from the user's side, indistinguishable from a backup that lost
    // their work. Each org is its own account here, with its own checkpoint.
    accounts(ctx) {
      const list = Array.isArray(ctx.orgs) && ctx.orgs.length ? ctx.orgs : [{ uuid: ctx.org }];
      return list.map((org) => ({ ...ctx, ...claudeOrgCtx(org) }));
    },
    /**
     * The one organisation whose allowance is the account's allowance.
     *
     * A claude.ai login routinely owns several — a personal one, one an invite
     * created, one the apps make — and every one of them was polled and stored
     * as its own account, so a single subscriber saw "Claude Pro" twice and the
     * row that won was whichever org answered last, usually the unused one at
     * 100% left. There is one session cookie and one subscription here: pick
     * the org that holds the plan, and report it once.
     */
    /* One login, one allowance — but WHICH organisation holds it cannot be
       settled here. Every org this login owns reports the same tier, so
       bestPlanSeat() was choosing between equals and the tie fell to whichever
       the API listed first: usually the personal org nobody uses, reporting
       100% left while the site said a quarter of the week was gone. Narrow to
       the seats that tie at the best plan and let the READINGS decide — see
       `oneAllowance` in bg/quota.js. */
    oneAllowance: true,
    quotaSeats(ctx) {
      const seats = this.accounts(ctx);
      if (seats.length < 2) return seats;
      const best = bestPlanSeat(seats);
      if (!best) return seats;
      const top = planRank(best.plan);
      const tied = seats.filter((s) => planRank(s && s.plan) === top);
      return tied.length ? tied : [best];
    },
    /* The usage endpoint states the plan outright (`plan_name`), and bootstrap
       carries the membership the tier lives on. Both are already fetched for
       the allowance, so the label costs no request of its own. */
    planFrom(path, json) {
      if (!json || typeof json !== "object") return "";
      const direct = planName(json.plan_name);
      if (direct) return direct;
      const account = json.account || null;
      const memberships = (account && Array.isArray(account.memberships)) ? account.memberships : [];
      let best = "";
      for (const m of memberships) {
        const org = (m && m.organization) || null;
        if (!org) continue;
        const named = claudeOrgCtx(org).plan;
        // The strongest plan this login owns: a personal free org sits beside a
        // paid one constantly, and the paid one is the one being asked about.
        if (planRank(named) > planRank(best)) best = named;
      }
      return best;
    },
    async get(ctx, path) { return bgJson(await bgFetch(this.base + path)); },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 100, sinceMs, progress,
        fetchPage: async (page, limit) => {
          const arr = await this.get(ctx,
            `/api/organizations/${ctx.org}/chat_conversations?limit=${limit}&${page}`);
          return Array.isArray(arr) ? arr : (arr && Array.isArray(arr.data) ? arr.data : []);
        },
        toMeta: (it) => ({
          id: it.uuid, title: it.name || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : 0,
          updatedAt: it.updated_at ? new Date(it.updated_at).getTime() : Date.now()
        })
      });
    },
    async detail(ctx, id) {
      const conv = await this.get(ctx, `/api/organizations/${ctx.org}/chat_conversations/${id}`);
      const msgs = [];
      for (const m of (conv.chat_messages || [])) {
        const role = m.sender === "human" ? "user" : "assistant";
        let text = String(m.text || "").trim();
        if (!text && Array.isArray(m.content)) {
          text = m.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n").trim();
        }
        if (text) msgs.push({ r: role, t: text, ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0 });
      }
      return msgs;
    }
  },
  {
    id: "deepseek", label: "DeepSeek", base: "https://chat.deepseek.com",
    host: "chat.deepseek.com", prefix: "/chat/",
    // No endpoint here names the signed-in account, so every account on this
    // host would share one device-level tag; the page's hint can do better.
    namesAccount: false,
    async prepare() {
      await bgFetch(this.base + "/api/v0/chat/list?count=1");
      // No endpoint here names the signed-in user, so accounts are separated
      // after the listing instead — see resolveAnchor().
      return { identified: false };
    },
    async get(ctx, path) { return bgJson(await bgFetch(this.base + path)); },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 100, sinceMs, progress,
        fetchPage: async (page, limit) => {
          const data = await this.get(ctx, `/api/v0/chat/list?count=${limit}&${page}`);
          return data.data?.list || data.list || (Array.isArray(data) ? data : []);
        },
        toMeta: (it) => ({
          id: it.id || it.session_id, title: it.title || it.topic || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : (it.create_time || 0),
          updatedAt: it.updated_at ? new Date(it.updated_at).getTime() : (it.update_time || Date.now())
        })
      });
    },
    async detail(ctx, id) {
      const data = await this.get(ctx, "/api/v0/chat/history/" + id);
      const msgs = [];
      for (const m of (data.data?.messages || data.messages || [])) {
        const role = /user|human/i.test(m.role) ? "user" : "assistant";
        const text = (m.content || m.text || "").trim();
        if (text) msgs.push({ r: role, t: text, ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0 });
      }
      return msgs;
    }
  },
  {
    id: "grok", label: "Grok", base: "https://grok.com",
    host: "grok.com", prefix: "/chat/",
    // No endpoint here names the signed-in account, so every account on this
    // host would share one device-level tag; the page's hint can do better.
    namesAccount: false,
    async prepare() {
      await bgFetch(this.base + "/rest/app-chat/conversations?limit=1");
      return { identified: false };   // as DeepSeek — resolveAnchor() separates them
    },
    async get(ctx, path) { return bgJson(await bgFetch(this.base + path)); },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 100, sinceMs, progress,
        fetchPage: async (page, limit) => {
          const data = await this.get(ctx, `/rest/app-chat/conversations?limit=${limit}&${page}`);
          return data.conversations || data.items || (Array.isArray(data) ? data : []);
        },
        toMeta: (it) => ({
          // Grok spells every one of these in camelCase, and nothing else in
          // this file does. An earlier build read it.id / created_at /
          // updated_at — all three absent — so every meta came back without an
          // id, walkScheme dropped the entire listing as unusable, and the
          // platform archived nothing while reporting no error at all. The
          // snake_case spellings are kept only as a fallback.
          id: String(it.conversationId || it.id || it.conversation_id || ""),
          title: String(it.title || it.name || ""),
          createdAt: xaiTime(it.createTime || it.created_at),
          updatedAt: xaiTime(it.modifyTime || it.updated_at) || Date.now()
        })
      });
    },
    /**
     * Grok never hands over a conversation's messages with the conversation.
     * Two steps: the ids of its response nodes, then their bodies in batches.
     * The single GET an earlier build made returns metadata with no messages
     * in it whatsoever, so `data.messages || data.turns` was always empty and
     * every Grok chat archived as a title with nothing under it.
     */
    async detail(ctx, id) {
      const conv = "/rest/app-chat/conversations/" + encodeURIComponent(id);
      const nodes = await this.get(ctx, conv + "/response-node?includeThreads=true");
      const ids = (nodes.responseNodes || nodes.response_nodes || [])
        .map((n) => n && String(n.responseId || n.response_id || ""))
        .filter(Boolean);

      const msgs = [];
      for (let at = 0; at < ids.length; at += GROK_RESPONSE_BATCH) {
        if (at) await sleep(policyFor(this.host).listDelayMs);
        const batch = ids.slice(at, at + GROK_RESPONSE_BATCH);
        const data = await bgJson(await bgFetch(this.base + conv + "/load-responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ responseIds: batch })
        }));
        const responses = Array.isArray(data.responses) ? data.responses.slice() : [];

        // The node listing IS the reading order, so the requested order is the
        // one to keep — but only reorder when every item can actually be
        // placed. A partial match would interleave a conversation worse than
        // leaving it exactly as the server sent it.
        const rank = new Map(batch.map((rid, i) => [rid, i]));
        const placed = responses.map((m) => rank.get(String(
          (m && (m.responseId || m.response_id)) || "")));
        if (placed.every((p) => p !== undefined)) {
          responses.sort((a, b) =>
            rank.get(String(a.responseId || a.response_id)) -
            rank.get(String(b.responseId || b.response_id)));
        }

        for (const m of responses) {
          const text = String((m && (m.message || m.content || m.text)) || "").trim();
          if (!text) continue;
          msgs.push({
            r: /user|human/i.test(String((m.sender || m.role) || "")) ? "user" : "assistant",
            t: text,
            ts: Math.floor(xaiTime(m.createTime || m.created_at) / 1000)
          });
        }
      }
      return msgs;
    }
  },
  {
    id: "gemini", label: "Gemini", base: "https://gemini.google.com",
    // The record id is the /app/<cid> URL, which is also what the Google Takeout
    // importer on the recall page builds — so a synced chat and an imported one
    // are the same row rather than two copies of the same conversation.
    host: "gemini.google.com", prefix: "/app/",
    // No endpoint here names the signed-in account, so every account on this
    // host would share one device-level tag; the page's hint can do better.
    namesAccount: false,
    async prepare() {
      // batchexecute's tokens live only in the app shell's HTML — no JSON
      // endpoint carries them — so this one request is deliberately not JSON.
      const r = await bgFetch(this.base + "/app", {
        headers: { Accept: "text/html,application/xhtml+xml,*/*" }
      });
      const html = await r.text();
      const at = (GEMINI_AT_RE.exec(html) || [])[1] || "";
      // No token means the shell rendered signed-out. An auth failure, not a
      // shape change — the two want different remedies from the user.
      if (!at) throw new BgError("auth", "not signed in");
      return {
        at,
        bl: (GEMINI_BL_RE.exec(html) || [])[1] || "",
        sid: (GEMINI_SID_RE.exec(html) || [])[1] || "",
        // Nothing in the shell names the account dependably, so accounts here
        // are told apart afterwards by what they hold — as DeepSeek and Grok are.
        identified: false
      };
    },
    /* `opts.sourcePath` and `opts.ext` are not decoration: batchexecute routes
       on the page the call claims to come from, and the usage RPC is served to
       /usage with the extension header its own page sends. Asked from /app with
       no header — which is right for the listing, and was hardcoded for every
       call — it answers nothing at all, and the panel said Gemini published no
       allowance while gemini.google.com/usage was showing one. */
    async rpc(ctx, rpcid, payload, opts) {
      geminiReqid = (geminiReqid || Math.floor(Math.random() * 90000) + 10000) + 100000;
      const params = new URLSearchParams({
        rpcids: rpcid, "source-path": (opts && opts.sourcePath) || "/app", hl: "en",
        _reqid: String(geminiReqid), rt: "c"
      });
      if (ctx.bl) params.set("bl", ctx.bl);
      if (ctx.sid) params.set("f.sid", ctx.sid);
      const r = await bgFetch(this.base + GEMINI_BATCH_PATH + "?" + params.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Same-Domain": "1",
          ...(opts && opts.ext ? { "x-goog-ext-73010989-jspb": opts.ext } : {})
        },
        // Three levels of nesting, the innermost one a JSON string: the batch,
        // the envelope list, then the envelope. "generic" is the ordering slot a
        // single-rpc batch uses.
        body: new URLSearchParams({
          "f.req": JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]),
          at: ctx.at
        }).toString()
      });
      return r.text();
    },
    /**
     * The allowance, shaped as JSON so the shared parser can read it.
     *
     * Everything else on this host answers over REST and lib/quota.js reads the
     * body; here the body is a positional array inside a framed string, so this
     * translates rather than parses. Names the two windows the way Anthropic's
     * usage endpoint does, because the parser already understands that shape.
     *
     * Silent on anything unexpected: an account Google publishes no buckets for
     * must read as "no limit published", never as a limit of zero.
     */
    async quotaJson(ctx) {
      let payloads;
      try {
        payloads = geminiPayloads(
          await this.rpc(ctx, GEMINI_RPC_USAGE, [], { sourcePath: "/usage", ext: "[0]" }),
          GEMINI_RPC_USAGE);
      } catch { return null; }
      const buckets = payloads.map((p) => (Array.isArray(p) ? p[1] : null)).find(Array.isArray);
      if (!Array.isArray(buckets) || !buckets.length) return null;
      const out = {};
      for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue;
        const remaining = Number(bucket[0]);
        const ratio = Number(bucket[1]);          // the share already SPENT, 0..1
        const type = Number(bucket[2]);
        if (!Number.isFinite(remaining) || !Number.isFinite(ratio)) continue;
        const window = {
          remaining,
          // The parser reads `utilization` as a used percentage — the same
          // field name Anthropic sends, and the same meaning.
          utilization: Math.max(0, Math.min(100, ratio * 100))
        };
        const resetAt = geminiTime(Array.isArray(bucket[3]) ? bucket[3][0] : null);
        if (resetAt) window.resets_at = resetAt;
        out[type === 1 ? "five_hour" : type === 2 ? "seven_day" : "bucket_" + type] = window;
      }
      return Object.keys(out).length ? out : null;
    },
    async list(ctx, sinceMs, progress) {
      const metas = [];
      const seen = new Set();
      let sawRows = 0, named = 0, truncated = false, shelf = 0;

      for (const pinned of GEMINI_SHELVES) {
        if (shelf++) await sleep(policyFor(this.host).listDelayMs);
        const payloads = geminiPayloads(
          await this.rpc(ctx, GEMINI_RPC_LIST, [GEMINI_LIST_MAX, null, [pinned, null, 1]]),
          GEMINI_RPC_LIST);
        // No envelope for the rpc we asked for is not an empty account — it is a
        // transport or a shape this build no longer speaks.
        if (!payloads.length) throw new BgError("shape", "provider listing not understood");

        let rowsHere = 0;
        for (const payload of payloads) {
          const rows = Array.isArray(payload) && Array.isArray(payload[2]) ? payload[2] : [];
          for (const row of rows) {
            if (!Array.isArray(row)) continue;
            rowsHere++; sawRows++;
            const cid = String(row[0] || "");
            if (!cid) continue;
            named++;
            if (seen.has(cid)) continue;
            seen.add(cid);
            const updatedAt = geminiTime(row[5]) || Date.now();
            if (sinceMs && updatedAt <= sinceMs) continue;
            metas.push({ id: cid, title: String(row[1] || ""), createdAt: 0, updatedAt });
          }
        }
        // LIST_CHATS takes a COUNT, not a cursor. A shelf that returns exactly
        // as many rows as it was asked for may have more behind it, and a
        // listing that might be partial must never be called complete — the
        // sweep would read everything it omitted as deleted upstream.
        if (rowsHere >= GEMINI_LIST_MAX) truncated = true;
        progress(metas.length, 0, `Listing chats… ${metas.length}`);
      }

      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      return { metas, complete: !truncated, unreadable: sawRows > 0 && named === 0 };
    },
    async detail(ctx, id) {
      const payloads = geminiPayloads(
        await this.rpc(ctx, GEMINI_RPC_READ, [id, GEMINI_TURN_MAX, null, 1, [1], [4], null, 1]),
        GEMINI_RPC_READ);
      if (!payloads.length) throw new BgError("shape", "provider conversation not understood");

      const turns = payloads.map((p) => geminiAt(p, [0])).find(Array.isArray);
      // A conversation holding no turns is legitimate — one opened and
      // abandoned. An envelope with no turns ARRAY at all is not, but it is
      // also indistinguishable here from the former, so treat it as empty and
      // let the listing's own checks be the ones that raise.
      if (!turns) return [];

      const msgs = [];
      // Gemini answers newest-turn-first. Walk it backwards so the archive
      // reads in the order the conversation actually happened.
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (!Array.isArray(turn)) continue;
        const ask = String(geminiAt(turn, [2, 0, 0]) || "").trim();
        if (ask) msgs.push({ r: "user", t: ask, ts: 0 });
        // The first candidate is the one the page shows; the rest are alternate
        // drafts the reader never saw.
        const best = geminiAt(turn, [3, 0, 0]);
        // Index 22 is where a "card" answer keeps its text instead of index 1.
        const reply = geminiText(geminiAt(best, [1])) || geminiText(geminiAt(best, [22]));
        if (reply) msgs.push({ r: "assistant", t: reply, ts: 0 });
      }
      return msgs;
    }
  },
  {
    id: "perplexity", label: "Perplexity", base: "https://www.perplexity.ai",
    // The thread slug IS the /search/ URL segment, so a record id here is the
    // address of the page it came from — same rule as every other adapter.
    host: "www.perplexity.ai", prefix: "/search/",
    async prepare() {
      const j = await bgJson(await bgFetch(this.base + "/api/auth/session" + PPLX_Q,
        { headers: PPLX_HEADERS }));
      const user = (j && j.user) || null;
      if (!user || !user.id) throw new BgError("auth", "not signed in");
      // Unlike DeepSeek and Grok, Perplexity names the signed-in user, so two
      // accounts are told apart outright and never inferred from what they hold.
      return { account: String(user.id), identified: true, handle: String(user.email || "") };
    },
    /* /rest/user/settings names the tier and whether it is actually active.
       A cancelled Pro still reports `subscription_tier: "pro"`, so the status
       decides: without it the panel would keep calling a lapsed account Pro. */
    planFrom(path, json) {
      if (!json || typeof json !== "object") return "";
      const status = String(json.subscription_status || "").toLowerCase();
      if (status && status !== "active" && status !== "trialing") return "Free";
      return planName(json.subscription_tier || json.subscription_plan);
    },
    /** One page of the thread list. POST, with a JSON body — the same endpoint
     *  answers 400 to a bare GET. */
    async listPage(offset, limit) {
      const j = await bgJson(await bgFetch(this.base + "/rest/thread/list_ask_threads" + PPLX_Q, {
        method: "POST",
        headers: { ...PPLX_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ limit, offset, ascending: false, search_term: "" })
      }));
      return Array.isArray(j) ? j : (j && Array.isArray(j.entries) ? j.entries : []);
    },
    async peek(ctx, sinceMs) {
      const [newest] = await this.listPage(0, 1);
      if (!newest) return { hasNew: false, newestMs: 0 };
      const upd = pplxTime(newest.last_query_datetime) || Date.now();
      return { hasNew: upd > sinceMs, newestMs: upd };
    },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 50, sinceMs, progress,
        // Perplexity pages by an offset in the POST BODY, not a query param, so
        // none of the shared query-string schemes can describe it. One scheme,
        // whose "param" is the offset itself — walkScheme still owns every exit
        // condition, so the watermark is as safe here as anywhere else.
        schemes: [{ id: "pplx-body-offset", param: (page, size) => String(page * size) }],
        fetchPage: (param, limit) => this.listPage(Number(param) || 0, limit),
        toMeta: (it) => ({
          id: String(it.slug || it.uuid || ""),
          title: String(it.title || ""),
          // The listing carries no creation time at all — only the last query.
          createdAt: 0,
          updatedAt: pplxTime(it.last_query_datetime) || Date.now()
        })
      });
    },
    async detail(ctx, id) {
      const msgs = [];
      let cursor = "";
      for (let page = 0; page < BG_LIST_MAX_PAGES; page++) {
        if (page) await sleep(policyFor(this.host).listDelayMs);
        let j;
        try {
          j = await bgJson(await bgFetch(
            this.base + "/rest/thread/" + encodeURIComponent(id) + PPLX_Q +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
            { headers: PPLX_HEADERS }));
        } catch (error) {
          // Perplexity purges threads after roughly three months, and says so
          // with a 400 (ENTRY_EXPIRED / ENTRY_DELETED) rather than a 404. Left
          // as a network error this would be retried every pass forever, on a
          // thread that is never coming back. It is gone; say so, and let the
          // sweep tombstone it like any other vanished chat.
          if (error && error.status === 400) throw new BgError("gone", "http 400", { status: 400 });
          throw error;
        }
        // One entry is a whole turn — the question AND the answer — so it
        // yields two messages, not one.
        for (const entry of (j.entries || [])) {
          const secs = Math.floor((pplxTime(entry.updated_datetime) || 0) / 1000);
          const query = String(entry.query_str || "").trim();
          if (query) msgs.push({ r: "user", t: query, ts: secs });
          const answer = pplxAnswer(entry);
          if (answer) msgs.push({ r: "assistant", t: answer, ts: secs });
        }
        // has_next_page here is the THREAD's, not the listing's — the two use
        // the same field name for different things.
        cursor = (j.has_next_page && j.next_cursor) ? String(j.next_cursor) : "";
        if (!cursor) break;
      }
      return msgs;
    }
  },
  /* ---------- Claude Code (claude.ai/code) ----------
     A different resource from chat_conversations, so none of it was archived.
     No documented endpoint — the Compliance API is Enterprise-only — so this
     uses the path claude.ai was seen calling, and stays dormant until it has
     one. content/main.js records sessions off the page meanwhile. */
  {
    id: "claude-code", label: "Claude Code", base: "https://claude.ai",
    host: "claude.ai", prefix: "/code/",
    async available() { return !!(await claudeCodeListPath()); },
    async prepare() {
      const listPath = await claudeCodeListPath();
      if (!listPath) throw new BgError("net", "no code listing endpoint seen yet");
      const orgs = await bgJson(await bgFetch(this.base + "/api/organizations"));
      const list = (Array.isArray(orgs) ? orgs : []).filter((o) => o && o.uuid);
      const org = list[0];
      if (!org) throw new BgError("auth", "not signed in");
      return { ...claudeOrgCtx(org), orgs: list, listPath };
    },
    accounts(ctx) {
      const list = Array.isArray(ctx.orgs) && ctx.orgs.length ? ctx.orgs : [{ uuid: ctx.org }];
      return list.map((org) => ({ ...ctx, ...claudeOrgCtx(org) }));
    },
    async list(ctx, sinceMs, progress) {
      const path = claudeFillOrg(ctx.listPath, ctx.org);
      return pageThrough(this, {
        pageSize: 50, sinceMs, progress,
        fetchPage: async (page, limit) => {
          const body = await bgJson(await bgFetch(`${this.base}${path}?limit=${limit}&${page}`));
          for (const v of [body, body && body.data, body && body.sessions, body && body.results]) {
            if (Array.isArray(v)) return v;
          }
          return [];
        },
        // Field names undocumented; a half-parsed listing is still a title and
        // a date, which is the difference between findable and absent.
        toMeta: (it) => {
          const at = (v) => (v ? new Date(v).getTime() || 0 : 0);
          return {
            id: String(it.uuid || it.id || it.session_id || ""),
            title: String(it.name || it.title || it.summary || it.description || ""),
            createdAt: at(it.created_at || it.createdAt || it.started_at),
            updatedAt: at(it.updated_at || it.updatedAt || it.last_active_at) || Date.now()
          };
        }
      });
    },
    async detail(ctx, id) {
      const path = claudeFillOrg(ctx.listPath, ctx.org);
      const body = await bgJson(await bgFetch(`${this.base}${path}/${encodeURIComponent(id)}`));
      const turns = [body && body.chat_messages, body && body.messages, body && body.events,
                     body && body.transcript, body && body.turns].find(Array.isArray) || [];
      const msgs = [];
      for (const m of turns) {
        if (!m || typeof m !== "object") continue;
        const who = String(m.sender || m.role || m.type || "").toLowerCase();
        if (who.includes("tool") || who.includes("system")) continue;   // not a turn anybody wrote
        const role = who.includes("human") || who.includes("user") ? "user" : "assistant";
        let text = String(m.text || m.content || "").trim();
        if (!text && Array.isArray(m.content)) {
          text = m.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n").trim();
        }
        if (!text) continue;
        const ts = m.created_at || m.createdAt || m.timestamp;
        msgs.push({ r: role, t: text, ts: ts ? Math.floor(new Date(ts).getTime() / 1000) || 0 : 0 });
      }
      return msgs;
    }
  }
];

/** Put the real organisation back into a learned path template. */
const claudeFillOrg = (template, org) =>
  String(template || "").replace(/\/organizations\/\*/, "/organizations/" + org);

/* Learned listing path. A trailing "*" is one session, not the list. */
async function claudeCodeListPath() {
  const seen = await readApiSeen("claude.ai");
  return seen
    .filter((p) => /session/i.test(p) && !p.endsWith("/*"))
    .filter((p) => !/(message|event|permission|setting|feature|usage)/i.test(p))
    .sort((a, b) => b.length - a.length)[0] || "";
}
