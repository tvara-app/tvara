/**
 * Tvara background worker — one chat, read from the archive: index, stats, in-chat search, roles.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

let bgSyncRunning = false;

/* ===================== one conversation's index =====================
 * The map used to be assembled by walking the host's own scroller to the top —
 * sixty round trips of the page yanking itself around while somebody was trying
 * to read it. The provider hands over the entire conversation in ONE request we
 * already know how to make, and every message in it carries the same id ChatGPT
 * stamps on the DOM. So the map can be complete before the first paint, and the
 * page never has to move at all. */

const IDX_SNIP = 80;                    // matches metaFor()'s slice in minimap.js
const IDX_CODE = /```|\n {4}\S/;        // a hint; the DOM's own <pre> wins on mount
const IDX_CTX_TTL = 5 * 60 * 1000;      // clicking through 20 chats = one prepare()
const IDX_FRESH_MS = 60 * 1000;         // an SPA route bounce must not refetch

const idxCtx = new Map();               // host -> { ctx, at }
const idxInflight = new Map();          // recordId -> Promise
const idxFetchedAt = new Map();         // recordId -> ms

/**
 * Who said each message, for records that do not say.
 *
 * Roles reach the archive from two places. A provider fetch states every one of
 * them and needs nothing here. A page flush states only what the host painted a
 * marker for, and older builds wrote every unmarked turn down as the model's —
 * so an archive holds records whose split is 200 assistant, 0 user for a
 * conversation that plainly had two speakers.
 *
 * Alternation from the nearest stated role is the only inference that holds:
 * nothing about a message's TEXT says who typed it, and the heuristics that
 * claimed otherwise are what put these records here. With no stated role
 * anywhere, a transcript starts with the person — that is what a prompt is.
 * Mirrors resolveRoles() in content/adapters.js.
 */
function resolveMsgRoles(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  const out = list.map((m) => (m && (m.r === "user" || m.r === "assistant") ? m.r : ""));
  /* Every message stated, all of them the same speaker, and enough of them that
     it cannot be a fragment: that is not a transcript, it is the old coercion
     preserved. Re-derive rather than repeat it. Kept deliberately narrow — a
     provider fetch that drops an empty turn can leave two assistant messages
     adjacent, and that is a real record, not a broken one. */
  const stated = out.filter(Boolean);
  const degenerate = stated.length === out.length && out.length >= 4 &&
    new Set(stated).size === 1;
  const anchor = degenerate ? -1 : out.findIndex(Boolean);
  if (anchor === -1) {
    for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? "user" : "assistant";
    return out;
  }
  for (let i = anchor - 1; i >= 0; i--) out[i] = out[i + 1] === "user" ? "assistant" : "user";
  for (let i = anchor + 1; i < out.length; i++) {
    if (!out[i]) out[i] = out[i - 1] === "user" ? "assistant" : "user";
  }
  return out;
}

/**
 * The messages that are TURNS.
 *
 * Not everything a provider's transcript holds is one. ChatGPT's mapping also
 * carries reasoning summaries, browsing displays and streaming placeholders
 * under author "assistant" and recipient "all" — text empty, no content — and
 * they were stored. On a two-message conversation the map drew four ticks, one
 * of them previewing as "Image / attachment": parts of one long answer, as far
 * as anyone reading the map could tell. The fetch drops them now; records
 * written before it still hold them, so every read drops them too.
 *
 * A turn that IS a picture carries m:1 and stays. A record written before that
 * flag existed cannot prove it, and an empty row is worth nothing to any
 * feature here — no tick text, no search hit, no export line.
 */
function turnMsgs(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  const kept = list.filter((m) => m && (String(m.t || "").trim() || m.m === 1));
  return kept.length === list.length ? list : kept;   // same array when nothing went
}

/** The map only needs shape and a label — never the full transcript. */
function indexFromMsgs(msgs) {
  const out = [];
  const list = turnMsgs(msgs);
  const roles = resolveMsgRoles(list);
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || !m.i) continue;
    const t = m.t || "";
    out.push({ i: m.i, r: roles[i] === "user" ? "user" : "assistant", n: t.length, c: IDX_CODE.test(t) ? 1 : 0, s: t.slice(0, IDX_SNIP) });
  }
  return out;
}

/** Drop a cached context so the next prepare() really talks to the provider.
 *  A bearer token can expire inside IDX_CTX_TTL, and the only way to tell that
 *  from a signed-out user is to go and ask again. */
function idxForget(adapter) {
  idxCtx.delete(adapter.host);
}

async function idxPrepare(adapter) {
  const hit = idxCtx.get(adapter.host);
  if (hit && Date.now() - hit.at < IDX_CTX_TTL) return hit.ctx;
  const ctx = await adapter.prepare();
  idxCtx.set(adapter.host, { ctx, at: Date.now() });
  return ctx;
}

/**
 * How big a chat is and who did the talking, from the archive.
 *
 * The chat card used to know only what THIS browser had watched happen: a map
 * of chats opened while the extension was installed, counted off the DOM. So a
 * chat the archive holds in full — every message, every role, straight from the
 * provider — hovered as "Not tracked yet", and one that had been opened was
 * counted from whatever the host had chosen to mount, which on these sites is a
 * tail. Both are answered here, from the record that actually knows.
 *
 * Ships no message text and is deliberately NOT in the PAID map: it returns
 * four integers about the user's own conversation, which is not the archive's
 * content and not something to sell back to them. `chat-archive` and
 * `chat-search`, which do return text, stay gated.
 */
/**
 * The record ids that could hold one conversation.
 *
 * The page and the sync do not always agree on a chat's id. A page writes
 * `location.hostname + location.pathname`; the sync writes
 * `adapter.host + adapter.prefix + convId`. On three of the six hosts those are
 * different strings for the same conversation — DeepSeek serves `/a/chat/s/<id>`
 * against a `/chat/` prefix, Perplexity serves both `/search/` and `/thread/`,
 * Grok both `/c/` and `/chat/`. So a chat the archive holds in full answered
 * "not in the archive" whenever the reader arrived by the other spelling.
 *
 * Read-side only, deliberately. Canonicalising the WRITE would be the real fix
 * and would also have to migrate every record already written under the other
 * spelling; this makes the lookup find them either way in the meantime.
 */
function chatIdCandidates(host, path) {
  const h = String(host || "");
  const p = String(path || "");
  const out = [h + p];
  const seg = p.split("/").filter(Boolean).pop() || "";
  if (seg) {
    for (const a of BG_ADAPTERS) {
      if (a.host !== h) continue;
      const alt = a.host + a.prefix + seg;
      if (!out.includes(alt)) out.push(alt);
    }
  }
  return out.map((x) => x.slice(0, 600));
}

/* The largest chat on one host, so the card's "longest" badge is a claim about
   the archive rather than about whatever this browser happened to watch.
   Records are keyed `host + path`, so one key range covers a host and the scan
   never touches another provider's chats. Cached briefly: the badge is drawn on
   every hover and this must not become a scan per mouseover. */
const hostMax = new Map();              // host -> { n, at }
const HOST_MAX_TTL = 60e3;

async function hostLargest(host) {
  const h = String(host || "");
  const hit = hostMax.get(h);
  if (hit && Date.now() - hit.at < HOST_MAX_TTL) return hit;
  let top = 0, chats = 0;
  try {
    const d = await db();
    const range = IDBKeyRange.bound(h, h + "\uffff");
    await new Promise((resolve, reject) => {
      const req = tx(d, "readonly").openCursor(range);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const n = Number(cur.value && cur.value.n) || 0;
        // A title with no body is not a chat that can be the longest one.
        if (n > 0) { chats++; if (n > top) top = n; }
        cur.continue();
      };
    });
  } catch { return { n: 0, chats: 0, at: Date.now() }; }
  const out = { n: top, chats, at: Date.now() };
  hostMax.set(h, out);
  return out;
}

async function chatStats(host, path) {
  try {
    const d = await db();
    let rec = null;
    for (const cand of chatIdCandidates(host, path)) {
      const hit = await reqP(tx(d, "readonly").get(cand));
      if (!hit) continue;
      // A meta-only record is a title with no body. Keep it — it still carries
      // a name and dates — but keep looking for the one holding the messages,
      // and never let a later miss discard what an earlier candidate found.
      if (!rec || Number(hit.n) > Number(rec.n || 0)) rec = hit;
      if (Number(rec.n) > 0) break;
    }
    if (!rec) return { found: false };
    const stored = Array.isArray(rec.msgs) ? rec.msgs : [];
    const msgs = turnMsgs(stored);
    const dropped = stored.length - msgs.length;
    /* Counted straight off `m.r === "user"`, this reported 3 of 20 for a chat
       whose every unmarked turn an older flush had stamped "assistant". The
       split has to be resolved before it is counted, or the card repeats the
       archive's mistake with more confidence than the archive had. */
    const roles = resolveMsgRoles(msgs);
    let users = 0;
    for (const r of roles) if (r === "user") users++;
    /* `n` can exceed what the record HOLDS: a record capped at MAX_MSGS, or one
       whose count came from the provider's listing before the body landed. The
       split is only ever of the messages actually here, so ship both and let
       the reader say "of N counted" rather than implying it split all of them. */
    const held = msgs.length;
    return {
      found: true,
      // `n` is what the record itself claims; msgs.length is what it holds.
      // They agree unless a meta write left a title with no body.
      // Whatever the record claims, less the placeholders this read just took
      // out of it — a count and a split that disagree is the bug the card is
      // most often reported for.
      n: Math.max(held, (Number(rec.n) || held) - dropped),
      held,
      users,
      assistants: held - users,
      createdAt: Number(rec.createdAt) || 0,
      updatedAt: Number(rec.updatedAt) || 0,
      title: String(rec.title || ""),
      /* What "longest" is measured against. The card used to compare the chat
         it was drawing to the handful of chats THIS BROWSER had watched, whose
         counts are what the host had mounted at the time — so a seven-message
         reading won a superlative over a conversation of two hundred sitting in
         the archive beside it. */
      ...(await (async () => {
        const big = await hostLargest(host);
        // `hostChats` is what makes "longest of 1" answerable: a superlative
        // over a single chat is not one.
        return { topN: big.n, hostChats: big.chats };
      })())
    };
  } catch { return { found: false }; }
}

/**
 * One message's full text, straight out of the archive.
 *
 * The index deliberately carries only an 80-char snippet — shipping every
 * message's body would be megabytes on chat open for something the reader looks
 * at one of. This is the other half: an IndexedDB read, so the preview fills in
 * within a frame or two of the click.
 */
async function chatMessage(host, path, messageId) {
  try {
    const rec = await recordFor(host, path);
    if (!rec || !rec.msgs) return { status: "missing" };
    const m = rec.msgs.find((x) => x.i === messageId);
    if (!m) return { status: "missing" };
    return { status: "ok", role: m.r, text: m.t, ts: m.ts || 0 };
  } catch { return { status: "missing" }; }
}

/**
 * Search ONE conversation, in the archive rather than in the page.
 *
 * Measured on a live 1,471-message ChatGPT thread: the word "isaac" appears in
 * 217 messages, and in-chat search found 8 of them. Not a bug in the search —
 * it reads what the page has mounted, and the host had mounted 195 of 1,471.
 * From the reader's side that is a search that does not work, and no amount of
 * "it only searches the loaded conversation" in a tooltip fixes the feeling of
 * asking a 1,400-message chat a question and being told there are eight
 * answers.
 *
 * The archive already holds every word of that conversation on this machine.
 * So it answers here, with the provider's own message ids, and the minimap's
 * existing seek walks the reader to a hit the page has never rendered.
 *
 * Returns ids and short excerpts only — never the whole conversation back into
 * a page.
 */
const CHAT_SEARCH_MAX = 300;
const CHAT_SEARCH_PAD = 70;      // characters of context on each side of a hit

/** The archived record for a chat, under either spelling of its id.
 *  DeepSeek serves /a/chat/s/<id> against a /chat/ prefix, Perplexity /search/
 *  and /thread/, Grok /c/ and /chat/ — chatStats already resolves both, and a
 *  reader that does not answers "missing" for a chat the card just counted. */
/** Fold the candidate spellings of one chat down to the fullest record found.
 *  Order matters on a tie: the first spelling asked for wins, which is the
 *  page's own `host + path`. */
function bestCandidate(cands, lookup) {
  let best = null;
  for (const cand of cands) {
    const hit = lookup(cand);
    if (!hit) continue;
    if (!best || Number(hit.n || 0) > Number(best.n || 0)) best = hit;
    if (Number(best.n || 0) > 0) break;
  }
  return best;
}

async function recordFor(host, path) {
  try {
    // Both spellings on one transaction. It was one transaction each, which on
    // the three hosts that serve a chat under two paths meant opening two.
    const cands = chatIdCandidates(host, path);
    const found = await recordsByIds(cands);
    return bestCandidate(cands, (id) => found.get(id));
  } catch { return undefined; }        // undefined = could not read, not "absent"
}

async function chatSearch(host, path, query) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { status: "short" };
  const rec = await recordFor(host, path);
  if (rec === undefined) return { status: "unavailable" };
  if (!rec || !Array.isArray(rec.msgs)) return { status: "missing" };

  /* Every hit is returned as a provider message id, because that id is what
     the minimap seeks on — so a record whose messages carry no ids cannot be
     answered from here at all. Only the ChatGPT adapter emits `i`; Claude,
     DeepSeek, Grok, Gemini and Perplexity push {r,t,ts}. Reporting "ok" with
     zero hits for those told the reader the archive held no matches, when what
     actually happened is that the deep search never ran. That is the one thing
     this project must not do, so it is a distinct status the page can see. */
  const searchable = rec.msgs.filter((m) => m && m.i && m.t).length;
  if (!searchable) return { status: "no-index", total: 0, scanned: 0, hits: [] };

  const hits = [];
  let scanned = 0;
  for (const m of rec.msgs) {
    if (!m || !m.i || !m.t) continue;
    scanned++;
    const text = String(m.t);
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    if (hits.length < CHAT_SEARCH_MAX) {
      const from = Math.max(0, at - CHAT_SEARCH_PAD);
      hits.push({
        i: m.i,
        r: m.r === "user" ? "user" : "assistant",
        // The excerpt is what the reader recognises the hit by; the ellipses
        // are honest about it being an excerpt.
        s: (from ? "…" : "") + text.slice(from, at + q.length + CHAT_SEARCH_PAD).trim() +
           (at + q.length + CHAT_SEARCH_PAD < text.length ? "…" : ""),
        at
      });
    } else hits.push(null);        // counted, not carried
  }
  return {
    status: "ok",
    total: hits.length,
    scanned,
    truncated: hits.length > CHAT_SEARCH_MAX,
    hits: hits.filter(Boolean)
  };
}

/**
 * One conversation, whole, for the export button.
 *
 * Exporting reads the page, and the page holds what the host mounted — 197 of
 * 1,471 messages on a live thread. "Backed up the 197 loaded messages" is an
 * honest sentence about a backup that is 13% of the conversation, which is not
 * what anyone pressing a backup button believes they are getting.
 *
 * The archive on this machine has the rest. Same conversation, same machine,
 * no network: this hands it back so the file on disk is the whole thing.
 */
async function chatArchive(host, path) {
  try {
    const rec = await recordFor(host, path);
    if (!rec || !Array.isArray(rec.msgs) || !rec.msgs.length) return { status: "missing" };
    const msgs = turnMsgs(rec.msgs);
    return {
      status: "ok",
      title: rec.title || "",
      n: Math.max(msgs.length, (Number(rec.n) || msgs.length) - (rec.msgs.length - msgs.length)),
      msgs: msgs.map((m) => ({
        i: m.i || "", r: m.r, t: m.t || "", ts: m.ts || 0,
        // Records written before the flag existed are recognised by length.
        ...(m.c || (m.t || "").length >= MAX_MSG_CHARS ? { c: 1 } : {})
      }))
    };
  } catch { return { status: "unavailable" }; }
}

/** Forget a conversation. The only path that removes archived text. */
async function dropChat(id) {
  try {
    const d = await db();
    await reqP(tx(d, "readwrite").delete(String(id).slice(0, 600)));
    archiveChanged();          // the headline count is watching
  } catch { /* archive unavailable — nothing to forget */ }
}

/* Some hosts (Gemini) render history rows with no link and no id in the DOM,
   so the card has no path to ask about. Title is then the only handle. Answers
   ONLY when exactly one archived chat on that host carries that title — an
   ambiguous match would attribute one chat's numbers to another. */
async function chatPathByTitle(host, title) {
  const h = String(host || "");
  const want = String(title || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!h || want.length < 3) return "";
  let found = "", hits = 0;
  try {
    const d = await db();
    const range = IDBKeyRange.bound(h, h + "￿");
    await new Promise((resolve, reject) => {
      const req = tx(d, "readonly").openCursor(range);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const rec = cur.value;
        const t = String((rec && rec.title) || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (t && t === want) { hits++; found = String((rec && rec.path) || ""); }
        if (hits > 1) { resolve(); return; }
        cur.continue();
      };
    });
  } catch { return ""; }
  return hits === 1 ? found : "";
}
