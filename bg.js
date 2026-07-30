/**
 * Long Chat Toolkit — background service worker: the Total Recall database.
 *
 * One IndexedDB (extension origin) holds a local archive of every AI chat the
 * user has opened, across ALL platforms. Content scripts (isolated per site)
 * cannot share a database, so they send their conversation text here and this
 * worker owns storage + search.
 *
 * Privacy: the worker may make scoped, authenticated requests only to the AI
 * providers declared in manifest host permissions to copy history into this
 * local archive. No telemetry, no chat text ever leaves; everything is
 * deletable in one click from the Recall page. The single non-provider call is
 * licence entitlement (lib/entitlement.js) — licence key + device hash, nothing
 * else, and only when refreshing a token.
 *
 * Enforcement: this worker is the ONLY authority on paid features. Pages hide
 * locked UI as a courtesy; requireEntitlement() below is what actually decides.
 */
"use strict";

// One implementation of the backup envelope, shared with the Recall page.
try { importScripts("lib/backup-crypto.js"); } catch (_) { /* tests load bg.js bare */ }
// Licence verification. Order matters: entitlement.js calls into LCTLicense.
try { importScripts("lib/license.js", "lib/dodo.js", "lib/entitlement.js"); }
catch (_) { /* tests load bg.js bare */ }

const DB_NAME = "lct-recall";
const DB_VERSION = 3;
const MAX_MSG_CHARS = 4000;   // per message — plenty for search, bounds disk
const MAX_MSGS = 6000;        // per chat
const MAX_RESULTS = 60;

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      const s = d.objectStoreNames.contains("chats")
        ? req.transaction.objectStore("chats")
        : (() => {
            const created = d.createObjectStore("chats", { keyPath: "id" }); // id = host+path
            created.createIndex("updatedAt", "updatedAt");
            return created;
          })();
      // Lets the sync build its id→revision map from index keys alone, without
      // deserializing message bodies. On a large archive that is the difference
      // between reading a few hundred KB and the entire database.
      if (!s.indexNames.contains("sourceUpdatedAt")) s.createIndex("sourceUpdatedAt", "sourceUpdatedAt");
      // Which account a chat came from, paired with its revision so ONE key walk
      // answers both "what does this account hold" and "at which revision".
      // A record with no `acct` is absent from this index by definition — that
      // is what "not attributed to anybody yet" means, and it is why an
      // unattributed chat can never become another account's deletion candidate.
      if (!s.indexNames.contains("acctRev")) s.createIndex("acctRev", ["acct", "sourceUpdatedAt"]);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const tx = (d, mode) => d.transaction("chats", mode).objectStore("chats");
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/* ---------- write path ---------- */

function clampChat(chat) {
  const src = chat.msgs || [];
  const msgs = src.slice(-MAX_MSGS).map((m) => ({
    // The provider's own message id. On ChatGPT this is the same string the DOM
    // carries as data-message-id, which is what lets a stored record seed the
    // in-page map with no network call at all.
    i: String(m.i || "").slice(0, 80),
    r: m.r === "user" ? "user" : "assistant",
    t: String(m.t || "").slice(0, MAX_MSG_CHARS),
    ts: typeof m.ts === "number" ? m.ts : 0
  }));
  const acct = String(chat.acct || "").slice(0, 32);
  return {
    // mv=1 promises BOTH: every message carries its id, and nothing was dropped
    // by the MAX_MSGS window. Anything less cannot be an index source.
    // (`t` is still clamped to MAX_MSG_CHARS — norm() in minimap.js saturates at
    // 900 chars, so an archive-served tick is pixel-identical to a live one.)
    mv: msgs.length && src.length <= MAX_MSGS && msgs.every((m) => m.i) ? 1 : 0,
    // Deliberately omitted rather than set empty when unknown: "absent from the
    // acctRev index" is the single, uniform meaning of unattributed, whether the
    // record predates attribution or was just written by a page that could not
    // name its account.
    ...(acct ? { acct } : {}),
    id: String(chat.id || "").slice(0, 600),
    host: String(chat.host || "").slice(0, 100),
    path: String(chat.path || "").slice(0, 500),
    platform: String(chat.platform || "").slice(0, 40),
    title: String(chat.title || "").slice(0, 200),
    createdAt: typeof chat.createdAt === "number" ? chat.createdAt : 0,
    updatedAt: Date.now(),
    // Provider-wide sync uses this timestamp as its dedupe contract. Keep it
    // separate from the local write time so opening a chat cannot falsely
    // make an older provider revision look synchronized.
    sourceUpdatedAt: Number.isFinite(Number(chat.sourceUpdatedAt)) && Number(chat.sourceUpdatedAt) > 0
      ? Number(chat.sourceUpdatedAt)
      : ((chat.keepTimes || chat.meta) && Number.isFinite(Number(chat.updatedAt)) && Number(chat.updatedAt) > 0
        ? Number(chat.updatedAt) : 0),
    n: msgs.length,
    msgs
  };
}

async function upsert(chat) {
  if (!chat || !chat.id || !Array.isArray(chat.msgs)) return { ok: false };
  const isMeta = chat.meta === true && chat.msgs.length === 0;
  if (!isMeta && chat.msgs.length < 2) return { ok: false };
  const d = await db();
  const id = String(chat.id).slice(0, 600);
  // A live page only ever sees what the host MOUNTED. On ChatGPT that is the
  // recent tail, and this id is the same one the provider sync writes — so
  // without a guard, opening a chat trades a complete 1,500-message transcript
  // for a 30-message fragment a few seconds later. Only a write that carries a
  // provider revision is allowed to shrink a record.
  const shrinks = !isMeta && !chat.sourceUpdatedAt;
  // A page writing a chat it has open rarely knows which account it belongs to,
  // and a write that dropped the attribution would quietly hand the record back
  // to "unattributed" — undoing a sweep's only safety rail. Read first, carry
  // the stored account forward.
  let existing = null;
  if (isMeta || shrinks || !chat.acct) {
    existing = await reqP(tx(d, "readonly").get(id));
  }
  if (isMeta || shrinks) {
    const keep = existing && existing.n > 0 &&
      (isMeta || existing.n > chat.msgs.length);
    if (keep) {
      if (chat.title && !existing.title) {
        existing.title = String(chat.title).slice(0, 200);
        await reqP(tx(d, "readwrite").put(existing));
      }
      return { ok: true, kept: true };
    }
  }
  const clamped = clampChat(chat.acct ? chat : { ...chat, acct: existing && existing.acct });
  // imports/sync carry the chat's real last-activity time — keep it
  if ((chat.keepTimes || isMeta) && chat.updatedAt) clamped.updatedAt = chat.updatedAt;
  await reqP(tx(d, "readwrite").put(clamped));
  return { ok: true };
}

async function importBatch(chats) {
  const arr = Array.isArray(chats) ? chats : [];
  if (!arr.length) return { ok: 0, skipped: 0, stored: [], failed: [] };
  const d = await db();
  let ok = 0, skipped = 0;
  const stored = [], failed = [];   // sync needs ids, not just counts

  // Phase 1: read existing records in a single readonly transaction
  const store = d.transaction("chats", "readonly").objectStore("chats");
  const existing = new Map();
  for (const c of arr) {
    try {
      const id = String((c && c.id) || "").slice(0, 600);
      if (id) {
        const v = await reqP(store.get(id));
        if (v) existing.set(id, v);
      }
    } catch { /* skip */ }
  }

  // Phase 2: write all upserts in a single readwrite transaction
  const wStore = d.transaction("chats", "readwrite").objectStore("chats");
  for (const c of arr) {
    const cid = String((c && c.id) || "").slice(0, 600);
    try {
      if (!c || !c.id || !Array.isArray(c.msgs)) { skipped++; failed.push(cid); continue; }
      const chat = { ...c, keepTimes: true };
      const isMeta = chat.meta === true && chat.msgs.length === 0;
      if (!isMeta && chat.msgs.length < 2) { skipped++; failed.push(cid); continue; }
      const id = String(chat.id).slice(0, 600);
      if (isMeta) {
        const prev = existing.get(id);
        if (prev && prev.n > 0) {
          if (chat.title && !prev.title) {
            prev.title = String(chat.title).slice(0, 200);
            await reqP(wStore.put(prev));
          }
          ok++; stored.push(id); continue;
        }
      }
      const previous = existing.get(id);
      const candidateSource = Number(chat.sourceUpdatedAt || chat.updatedAt || 0);
      const previousSource = Number(previous && (previous.sourceUpdatedAt || previous.updatedAt) || 0);
      // Restores and retries are merge operations: a stale snapshot must not
      // overwrite a newer local conversation that arrived in the meantime.
      if (previous && previous.n > 0 && candidateSource > 0 && previousSource > candidateSource) {
        ok++;
        stored.push(id);
        continue;
      }
      // Same rule as upsert(): a restore carries no account, and must not strip
      // one that a sync already established.
      const clamped = clampChat(chat.acct ? chat : { ...chat, acct: previous && previous.acct });
      if ((chat.keepTimes || isMeta) && chat.updatedAt) clamped.updatedAt = chat.updatedAt;
      await reqP(wStore.put(clamped));
      ok++;
      stored.push(id);
    } catch { skipped++; failed.push(cid); }
  }
  return { ok, skipped, stored, failed };
}

/* ---------- search ---------- */

function score(chat, words) {
  // every word must appear somewhere; score = total hits, title hits ×3
  let total = 0;
  const title = chat.title.toLowerCase();
  for (const w of words) {
    let hits = 0;
    for (const m of chat.msgs) {
      let i = -1;
      const t = m.t.toLowerCase();
      while ((i = t.indexOf(w, i + 1)) !== -1) hits++;
    }
    if (title.includes(w)) hits += 3;
    if (!hits) return 0; // AND semantics
    total += hits;
    // meta-only chats (synced titles, text not archived yet) rank below
    // full-text matches naturally: they can only ever score title hits
  }
  return total;
}

function snippetFor(chat, words, long) {
  const back = long ? 120 : 60, fwd = long ? 520 : 160;
  for (let i = 0; i < chat.msgs.length; i++) {
    const t = chat.msgs[i].t;
    const low = t.toLowerCase();
    const at = low.indexOf(words[0]);
    if (at !== -1) {
      const start = Math.max(0, at - back);
      return {
        text: (start ? "…" : "") + t.slice(start, at + fwd),
        msgIndex: i,
        role: chat.msgs[i].r
      };
    }
  }
  if (!chat.msgs.length) {
    return { text: "Synced from your history — open once (or run full sync) to archive the text.", msgIndex: 0, role: "user" };
  }
  return { text: chat.msgs[0].t.slice(0, 160), msgIndex: 0, role: "user" };
}

async function search(query, long) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 8);
  if (!words.length) return { results: [], scanned: 0 };
  const d = await db();
  const results = [];
  let scanned = 0;
  await new Promise((resolve, reject) => {
    const cur = tx(d, "readonly").openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      scanned++;
      const chat = c.value;
      const s = score(chat, words);
      if (s > 0) {
        const snip = snippetFor(chat, words, long);
        results.push({
          id: chat.id, host: chat.host, path: chat.path, platform: chat.platform,
          title: chat.title, n: chat.n, createdAt: chat.createdAt,
          updatedAt: chat.updatedAt, score: s, snippet: snip.text, role: snip.role
        });
      }
      c.continue();
    };
  });
  results.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return { results: results.slice(0, MAX_RESULTS), scanned };
}

/* ---------- freshness check (sync skips already-archived chats) ---------- */

async function check(ids) {
  const arr = Array.isArray(ids) ? ids : [];
  if (!arr.length) return {};
  const d = await db();
  const out = {};
  // Single transaction for all lookups — N reads in 1 transaction instead of N
  const store = d.transaction("chats", "readonly").objectStore("chats");
  for (const id of arr) {
    try {
      const v = await reqP(store.get(String(id).slice(0, 600)));
      if (v) out[id] = { n: v.n, updatedAt: v.updatedAt, sourceUpdatedAt: v.sourceUpdatedAt || 0 };
    } catch { /* skip */ }
  }
  return out;
}

/**
 * One cursor pass that returns what this browser already owns for a platform:
 * chat id -> the provider revision that produced the archived copy.
 *
 * This index — not a timestamp — is the ground truth the sync engine diffs
 * against. A watermark can be wrong (restored backup, clock skew, a provider
 * that back-dates edits); the index cannot: a chat is either archived at the
 * provider's current revision or it is not.
 */
/**
 * id → archived provider revision, for one platform.
 *
 * Walks the sourceUpdatedAt index with openKeyCursor, so only index keys and
 * primary keys are read — message bodies are never deserialized. The previous
 * full-record scan pulled the entire archive into memory once per platform per
 * pass, which is what made a multi-thousand-chat sync unusable.
 */
async function archiveIndex(host, prefix) {
  const d = await db();
  const index = new Map();
  const start = host + prefix;
  const range = IDBKeyRange.bound(start, start + "￿");

  const viaIndex = await new Promise((resolve) => {
    let store;
    try { store = tx(d, "readonly"); } catch { return resolve(null); }
    if (!store.indexNames.contains("sourceUpdatedAt")) return resolve(null);
    const cur = store.index("sourceUpdatedAt").openKeyCursor();
    cur.onerror = () => resolve(null);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve(index);
      const id = c.primaryKey;
      if (typeof id === "string" && id.startsWith(start)) index.set(id, Number(c.key) || 0);
      c.continue();
    };
  });
  // Records written before the index existed carry no indexable key, so a
  // shortfall against the true count means the map is incomplete.
  if (viaIndex && viaIndex.size >= await platformCount(host, prefix)) return viaIndex;

  index.clear();
  await new Promise((resolve, reject) => {
    const cur = tx(d, "readonly").openCursor(range);
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      if (v && typeof v.id === "string") index.set(v.id, Number(v.sourceUpdatedAt || v.updatedAt || 0));
      c.continue();
    };
  });
  return index;
}

/** Exact number of archived chats for one platform, via a keyed count — no
 *  record bodies are read, so this stays cheap on a large archive. */
async function platformCount(host, prefix) {
  const d = await db();
  const start = host + prefix;
  return reqP(tx(d, "readonly").count(IDBKeyRange.bound(start, start + "￿")));
}

/* ---------- per-account views of the archive ----------
 *
 * People run several accounts on the same provider precisely because a free
 * tier runs out, so two accounts sharing one hostname is the normal case, not
 * an exotic one. Two questions that look alike have to be answered from
 * DIFFERENT sets, and conflating them is a data-loss bug:
 *
 *   "have I already got this chat?"  — every record under the host, whoever
 *                                      owns it. Ids are provider-global, so an
 *                                      id already held is never re-downloaded.
 *   "what does THIS account hold?"   — only records attributed to it. Deletion
 *                                      and coverage must use this one: a second
 *                                      account's first complete listing would
 *                                      otherwise nominate the first account's
 *                                      entire history as vanished.
 */

/** Range over every `[acct, <revision>]` key. `[]` sorts above every number and
 *  string in IndexedDB's key order, so this covers the account exactly. */
const acctRange = (acct) => IDBKeyRange.bound([acct], [acct, []]);

/** id → archived revision, for ONE account. Key-cursor only: no record bodies. */
async function accountIndex(host, prefix, acct) {
  const index = new Map();
  if (!acct) return index;
  const d = await db();
  const start = host + prefix;
  return new Promise((resolve) => {
    let store;
    try { store = tx(d, "readonly"); } catch { return resolve(index); }
    if (!store.indexNames.contains("acctRev")) return resolve(index);
    let cur;
    try { cur = store.index("acctRev").openKeyCursor(acctRange(acct)); }
    catch { return resolve(index); }
    cur.onerror = () => resolve(index);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve(index);
      const id = c.primaryKey;
      if (typeof id === "string" && id.startsWith(start)) {
        index.set(id, Number(Array.isArray(c.key) ? c.key[1] : 0) || 0);
      }
      c.continue();
    };
  });
}

/** How many chats this account owns — a keyed count, so the fetch loop can
 *  refresh coverage without walking the archive again. */
async function accountCount(acct) {
  if (!acct) return 0;
  const d = await db();
  try {
    const store = tx(d, "readonly");
    if (!store.indexNames.contains("acctRev")) return 0;
    return await reqP(store.index("acctRev").count(acctRange(acct)));
  } catch { return 0; }
}

/**
 * Stamp records with the account whose listing just named them.
 *
 * Appearing in an account's listing is positive proof of ownership — that is
 * the ONLY evidence used here. Records the listing did not mention keep
 * whatever they had (usually nothing), which is what makes the migration safe:
 * an unattributed record is invisible to every account's deletion sweep until
 * some account's listing claims it.
 *
 * Capped per pass because adoption rewrites whole records, and an archive of
 * thousands would otherwise turn one pass into a multi-megabyte rewrite.
 */
async function adoptRecords(recordIds, acct, limit = BG_ADOPT_MAX) {
  const claimed = [];
  if (!acct || !recordIds.length) return { claimed, more: false };
  const d = await db();
  for (const recordId of recordIds) {
    if (claimed.length >= limit) return { claimed, more: true };
    try {
      const rec = await reqP(tx(d, "readonly").get(recordId));
      if (!rec || rec.acct === acct) continue;
      rec.acct = acct;
      await reqP(tx(d, "readwrite").put(rec));
      claimed.push(recordId);
    } catch { /* one row refusing to move must not stop the pass */ }
  }
  return { claimed, more: false };
}

/* ---------- stats / wipe ---------- */

async function stats() {
  const d = await db();
  let chats = 0, msgs = 0, bytes = 0;
  const byPlatform = {};
  await new Promise((resolve, reject) => {
    const cur = tx(d, "readonly").openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      chats++; msgs += v.n;
      for (const m of v.msgs) bytes += m.t.length;
      byPlatform[v.platform || v.host] = (byPlatform[v.platform || v.host] || 0) + 1;
      c.continue();
    };
  });
  return { chats, msgs, bytes, byPlatform };
}

async function wipe() {
  const d = await db();
  await reqP(tx(d, "readwrite").clear());
  return { ok: true };
}

/* ===================== background sync engine ===================== */
/* Runs entirely in the service worker — no tabs needed. Uses host_permissions
   to make authenticated API requests directly with the user's cookies. */

// Per-host pacing. These are ceilings: concurrency ramps up on a clean streak
// and halves on a 429, so a healthy connection runs fast without ever being
// the reason the provider's own site starts refusing the user.
const BG_HOST_POLICY = {
  "chatgpt.com":       { concurrency: 4, minIntervalMs: 320, listDelayMs: 600 },
  "claude.ai":         { concurrency: 4, minIntervalMs: 300, listDelayMs: 450 },
  "chat.deepseek.com": { concurrency: 3, minIntervalMs: 400, listDelayMs: 500 },
  "grok.com":          { concurrency: 3, minIntervalMs: 400, listDelayMs: 500 },
  // Deliberately the slowest of the set. Perplexity sits behind Cloudflare and
  // its read endpoints publish no limit, so the only signal we would get for
  // going too fast is the user's own session being challenged.
  "www.perplexity.ai": { concurrency: 2, minIntervalMs: 700, listDelayMs: 800 },
  // One batchexecute call per conversation, and Google notices patterns. Paced
  // between the fast hosts and Perplexity's deliberate crawl.
  "gemini.google.com": { concurrency: 3, minIntervalMs: 450, listDelayMs: 600 }
};
const BG_FETCH_ATTEMPTS = 4;
const BG_RATE_TRIP = 3;                          // consecutive 429s → circuit opens
const BG_HOST_COOLDOWN_MS = 15 * 60 * 1000;
const BG_PASS_BUDGET_MS = 4 * 60 * 1000;         // MV3 workers get reclaimed
// Journal entries are ~120B, and the manifest grants unlimitedStorage, so this
// covers a very large first backfill without ever refusing the watermark.
const BG_PENDING_MAX = 50000;
const BG_JOURNAL_FLUSH_MS = 3000;
const BG_PROGRESS_MS = 400;
const BG_LIST_MAX_PAGES = 100;
const BG_SYNC_LIST_PAGE = 100;
const BG_SYNC_BATCH = 15;
const BG_SYNC_OVERLAP_MS = 5 * 60 * 1000;
const BG_RUN_STALE_MS = 90 * 1000;
const BG_PLATFORM_IDS = new Set(["chatgpt", "claude", "deepseek", "grok", "perplexity", "gemini"]);
const BG_SYNC_FLAG = (p) => "recall-sync-" + p;     // { lastFull: ms } — chrome.storage.local
const BG_SYNC_PROG = (p) => "recall-sync-progress:" + p;
const BG_SYNC_LEDGER = "lct-recall-sync-ledger-v2";
const BG_SYNC_PROFILE = "lct-recall-sync-profile-v1";
const BG_BACKUP_MARKER = "lct-recall-backup-marker-v1";
const BG_RECOVERY = "lct-recall-recovery-v1";
const BG_INSTALL = "lct-recall-install-v1";
const BG_RUN = "lct-recall-sync-run-v1";
const BG_ACTIVE_ACCOUNT = "lct-recall-active-account-v1";
// Local-only, never mirrored to storage.sync: the account roster this browser
// has seen, so the UI can say "your second ChatGPT" without the worker ever
// persisting who that is. Labels here are masked before they are written.
const BG_ACCOUNTS = "lct-recall-accounts-v1";
const BG_ACCT_MAX = 8;            // accounts remembered per platform, LRU beyond
const ACCT_LEN = 16;              // hex chars of the account tag stamped on rows
const BG_ADOPT_MAX = 300;         // records re-stamped per pass — see adoptRecords
// A listing whose oldest chat matches the archive this much is the same account
// that simply lost its anchor, not a different one. See resolveAnchor().
const BG_ANCHOR_OVERLAP = 0.5;
const BG_LEDGER_MAX = 32;         // checkpoints kept, newest first
const BG_LEDGER_BYTES = 7000;     // under storage.sync's 8KB-per-item cap
// Outstanding-work journal. Local-only and never roamed: it is meaningful only
// against this browser's archive index, and it is far too large for sync's
// 8KB-per-item cap.
const BG_SYNC_WORK = "lct-recall-sync-work-v1";
const BG_HOST_COOLDOWN = "lct-recall-host-cooldown-v1";
const BG_PAGE_SCHEME = "lct-recall-page-scheme-v1";
// Chats the provider no longer has. Local-only, and deliberately NOT a delete:
// see the deletion-review section below for why the archive keeps them until
// the user says otherwise.
const BG_DELETIONS = "lct-recall-deletions-v1";
const BG_DELETION_MAX = 500;
// Deletion can only be inferred from a listing that covers the whole history,
// and a delta pass never does. So one full listing is forced on this cadence.
const BG_SWEEP_STATE = "lct-recall-sweep-v1";
const BG_SWEEP_MS = 24 * 60 * 60 * 1000;
// Key material for unattended backups. chrome.storage.local ONLY — never
// setDurable, because storage.sync roams to Google's servers and a wrapped
// archive key has no business leaving the device.
const BG_AUTOBACKUP = "lct-recall-autobackup-v1";
const BG_AUTOBACKUP_STATE = "lct-recall-autobackup-state-v1";
const BG_RESTORE_GUARD = "lct-recall-restore-guard-v1";
const BG_SCHEME_RETRY_MS = 7 * 24 * 60 * 60 * 1000;   // re-probe "none" weekly

// Claude documents limit/offset; DeepSeek's and Grok's list endpoints are
// undocumented and change between builds. Rather than hard-code a guess, the
// walk tries these until one actually advances, then remembers the winner.
const BG_PAGE_SCHEMES = [
  { id: "offset", param: (i, size) => `offset=${i * size}` },
  { id: "skip",   param: (i, size) => `skip=${i * size}` },
  { id: "page0",  param: (i) => `page=${i}` },
  { id: "page1",  param: (i) => `page=${i + 1}` }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ledgerWrite = Promise.resolve();
let activeAccountWrite = Promise.resolve();
let profileSaltPromise = null;

const randomId = () => {
  try { return crypto.randomUUID(); }
  catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
};
const thisWorkerId = randomId();

function cleanCheckpoint(value) {
  if (!value || typeof value !== "object") return null;
  const platform = String(value.platform || "");
  const safeWatermark = Number(value.safeWatermark);
  const completedAt = Number(value.completedAt);
  if (!BG_PLATFORM_IDS.has(platform) || !Number.isFinite(safeWatermark) || safeWatermark <= 0 ||
      !Number.isFinite(completedAt) || completedAt <= 0) return null;
  return {
    version: 5,
    platform,
    safeWatermark,
    completedAt,
    // The oldest chat this account's listing showed. Providers that refuse to
    // name the signed-in account are told apart by it — see resolveAnchor().
    anchor: String(value.anchor || "").slice(0, 200),
    // Whether `coverage` counts this ACCOUNT's chats or every chat under the
    // host. v4 and earlier counted the host, and reading that as an account's
    // coverage would either trust a wiped archive or force a pointless rebuild.
    // An unscoped checkpoint therefore declares coverage unknown exactly once;
    // the next pass re-establishes it against the account's own rows.
    acctScoped: value.acctScoped === true,
    lastResult: String(value.lastResult || "delta").slice(0, 32),
    archived: Math.max(0, Math.floor(Number(value.archived) || 0)),
    // v3 and earlier only ever wrote a checkpoint after a fully clean pass, so
    // defaulting these keeps migrated checkpoints trusted.
    pendingCount: Math.max(0, Math.floor(Number(value.pendingCount) || 0)),
    passState: value.passState === "partial" ? "partial" : "clean",
    cooldownUntil: Math.max(0, Number(value.cooldownUntil) || 0),
    runId: String(value.runId || "").slice(0, 8),
    // How many chats this browser held for the platform when the checkpoint was
    // written. A watermark alone cannot tell a resumed browser from a wiped one;
    // coverage can. If the archive now holds fewer chats than the checkpoint
    // promised, the index was lost and the watermark must not be trusted.
    coverage: Math.max(0, Math.floor(Number(value.coverage) || 0)),
    coverageKnown: value.acctScoped === true &&
      (value.coverageKnown === true || Number(value.coverage) > 0)
  };
}

function cleanProfile(value) {
  const salt = String(value && value.salt || "");
  return value && value.version === 1 && /^[a-f0-9]{32}$/i.test(salt)
    ? { version: 1, salt: salt.toLowerCase() } : null;
}

function cleanLedger(value) {
  if (!value || value.version !== 2 || !value.checkpoints || typeof value.checkpoints !== "object" ||
      Array.isArray(value.checkpoints)) return { version: 2, checkpoints: {} };
  const checkpoints = {};
  // 64 checkpoints overflowed storage.sync's 8KB-per-item cap, which silently
  // dropped the whole ledger. A flat count of 8 was the fix, but it was sized
  // for two accounts and someone juggling four free tiers plus a couple of
  // Claude orgs blows through it — losing a checkpoint means re-downloading
  // that account's whole history. Fill to the byte budget instead, newest
  // first, so the cap is the real constraint rather than a guess about it.
  const ranked = Object.entries(value.checkpoints)
    .sort((a, b) => (Number(b[1] && b[1].completedAt) || 0) - (Number(a[1] && a[1].completedAt) || 0))
    .slice(0, BG_LEDGER_MAX);
  let bytes = 2;
  for (const [key, raw] of ranked) {
    const checkpoint = cleanCheckpoint(raw);
    if (!checkpoint) continue;
    const id = String(key).slice(0, 200);
    const cost = JSON.stringify({ [id]: checkpoint }).length;
    if (bytes + cost > BG_LEDGER_BYTES) break;
    checkpoints[id] = checkpoint;
    bytes += cost;
  }
  return { version: 2, checkpoints };
}

// Reads cover both areas and writes mirror: a sync-only read missed values
// that landed in local after a sync write failed, which rotated the profile
// salt and re-synced the whole history.
async function getDurable(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  let data = {}, synced = true;
  try { data = await chrome.storage.sync.get(list); }
  catch { data = {}; synced = false; }
  const missing = list.filter((k) => data[k] === undefined);
  if (missing.length) {
    try {
      const local = await chrome.storage.local.get(missing);
      data = { ...local, ...data };   // sync wins where both hold a value
    } catch { /* local unavailable — return what sync gave us */ }
  }
  return { data, synced };
}

async function setDurable(value) {
  let synced = false;
  try { await chrome.storage.sync.set(value); synced = true; } catch { /* mirrored below */ }
  try { await chrome.storage.local.set(value); } catch { /* sync copy may still hold */ }
  return synced;
}

// setDurable mirrors, so every deletion must clear both areas or a "wipe
// everything" leaves a shadow copy behind — a privacy promise, not a nicety.
async function removeDurable(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  try { await chrome.storage.sync.remove(list); } catch { /* may not exist there */ }
  try { await chrome.storage.local.remove(list); } catch { /* nor there */ }
}

async function readLedger() {
  const { data } = await getDurable(BG_SYNC_LEDGER);
  return cleanLedger(data[BG_SYNC_LEDGER]);
}

async function mutateLedger(mutator) {
  const work = async () => {
    const ledger = await readLedger();
    const next = cleanLedger(await mutator({ ...ledger, checkpoints: { ...ledger.checkpoints } }));
    await setDurable({ [BG_SYNC_LEDGER]: next });
    return next;
  };
  ledgerWrite = ledgerWrite.then(work, work);
  return ledgerWrite;
}

async function profileSalt() {
  if (profileSaltPromise) return profileSaltPromise;
  profileSaltPromise = (async () => {
    const { data } = await getDurable(BG_SYNC_PROFILE);
    const profile = cleanProfile(data[BG_SYNC_PROFILE]);
    if (profile) return profile.salt;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const salt = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await setDurable({ [BG_SYNC_PROFILE]: { version: 1, salt } });
    // An unpersisted salt is worse than none: it rotates on every worker
    // respawn, changing every account key and re-syncing the whole history.
    // Fail loudly instead — the pass retries, the archive stays intact.
    const verify = await getDurable(BG_SYNC_PROFILE);
    if (!cleanProfile(verify.data[BG_SYNC_PROFILE])) throw new BgError("storage", "storage unavailable");
    return salt;
  })();
  try { return await profileSaltPromise; }
  catch (error) { profileSaltPromise = null; throw error; }
}

async function digest(text) {
  const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Never persist raw account identifiers. The provider identity is salted and
// hashed so a checkpoint cannot leak the user's account value.
async function identityCheckpointKey(adapter, identity) {
  return adapter.id + ":" + await digest((await profileSalt()) + "|" + adapter.id + "|" + String(identity));
}

async function accountCheckpointKey(adapter, ctx) {
  // The identity MUST be stable across sessions. Earlier builds fell back to
  // the raw cookie header when a provider exposed no account id — session
  // cookies rotate, so every rotation minted a new checkpoint key and the whole
  // history was swept again. Providers that expose no account id start on one
  // per-browser key and are separated afterwards by resolveAnchor(), which asks
  // the archive rather than the clock.
  const identity = String(ctx && ctx.account || "").trim() || "device";
  return identityCheckpointKey(adapter, identity);
}

/**
 * The short tag stamped on every archived row.
 *
 * Deliberately derived from the SAME hash as the checkpoint key: an upgrade
 * must not orphan a single existing checkpoint, or every user re-downloads
 * their entire history on the release that adds multi-account support.
 * Truncation only shortens what is repeated on every row.
 */
function tagOfKey(checkpointKey) {
  const at = String(checkpointKey).indexOf(":");
  return String(checkpointKey).slice(at + 1, at + 1 + ACCT_LEN);
}

async function accountTag(adapter, ctx) {
  return tagOfKey(await accountCheckpointKey(adapter, ctx));
}

/* ---------- the account roster ----------
 * Enough to label a ring in the popup and no more. An email is masked before it
 * is stored, and anything that is not an email contributes no label at all —
 * an opaque provider uuid tells the user nothing, so the UI counts instead. */

let accountsWrite = Promise.resolve();

function maskHandle(value) {
  const raw = String(value || "").trim();
  const at = raw.indexOf("@");
  if (at <= 0 || at === raw.length - 1) return "";   // not an email: no useful label
  const user = raw.slice(0, at);
  const domain = raw.slice(at + 1).slice(0, 40);
  const head = user.slice(0, 1);
  const tail = user.length > 2 ? user.slice(-1) : "";
  return `${head}••${tail}@${domain}`;
}

async function readAccounts() {
  try {
    const store = await chrome.storage.local.get(BG_ACCOUNTS);
    const all = store[BG_ACCOUNTS];
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}

/** Record that this account exists and was seen just now. Ordinals are assigned
 *  on first sight and never reused, so "Account 2" keeps meaning the same one. */
async function noteAccount(platformId, acct, meta = {}) {
  if (!acct) return null;
  let result = null;
  const work = async () => {
    const all = await readAccounts();
    const platform = all[platformId] && typeof all[platformId] === "object" ? { ...all[platformId] } : {};
    const prev = platform[acct] || {};
    const used = new Set(Object.values(platform).map((a) => Number(a && a.ordinal) || 0));
    let ordinal = Number(prev.ordinal) || 0;
    while (!ordinal || (used.has(ordinal) && !prev.ordinal)) ordinal = ordinal ? ordinal + 1 : 1;
    const label = maskHandle(meta.handle) || String(prev.label || "");
    platform[acct] = {
      ordinal,
      label: label.slice(0, 60),
      plan: String(meta.plan || prev.plan || "").slice(0, 24),
      limit: Number.isFinite(Number(meta.limit)) ? Number(meta.limit) : (Number(prev.limit) || null),
      identified: meta.identified === undefined ? prev.identified !== false : !!meta.identified,
      firstSeen: Number(prev.firstSeen) || Date.now(),
      lastSeen: Date.now()
    };
    // An account the user abandoned should not crowd out the ones in use, but
    // the roster must stay small: it is read on every popup open.
    const kept = Object.entries(platform)
      .sort((a, b) => (Number(b[1].lastSeen) || 0) - (Number(a[1].lastSeen) || 0))
      .slice(0, BG_ACCT_MAX);
    result = platform[acct];
    await chrome.storage.local.set({ [BG_ACCOUNTS]: { ...all, [platformId]: Object.fromEntries(kept) } });
  };
  accountsWrite = accountsWrite.then(work, work);
  await accountsWrite;
  return result;
}

async function readCheckpoint(adapter, ctx) {
  const key = await accountCheckpointKey(adapter, ctx);
  const ledger = await readLedger();
  return { key, checkpoint: ledger.checkpoints[key] || null };
}

async function saveCheckpoint(key, checkpoint) {
  return mutateLedger((ledger) => {
    ledger.checkpoints[key] = checkpoint;
    return ledger;
  });
}

/* ---------- outstanding-work journal (local only) ----------
 * pending is the OUTSTANDING set, not the failure set: it is seeded with every
 * chat the pass intends to fetch and written alongside the advanced watermark
 * BEFORE the first detail request. Ids leave it only once a row lands in the
 * archive. That is what lets a first pass mint a trustworthy checkpoint even
 * when every fetch is rate-limited. */

let journalWrite = Promise.resolve();
// Authoritative copy for the duration of a pass. Without it every drop re-read
// and re-serialized the whole pending array — quadratic once a backfill runs
// into the thousands.
let journalCache = null;

function cleanJob(value) {
  if (!value || typeof value !== "object") return null;
  const scanStartedAt = Number(value.scanStartedAt) || 0;
  if (!scanStartedAt) return null;
  const pending = Array.isArray(value.pending) ? value.pending.slice(0, BG_PENDING_MAX) : [];
  return {
    platform: String(value.platform || "").slice(0, 32),
    scanStartedAt,
    updatedAt: Number(value.updatedAt) || 0,
    pending: pending.filter((p) => p && p.id).map((p) => ({
      id: String(p.id).slice(0, 200),
      rev: Number(p.rev) || 0,
      title: String(p.title || "").slice(0, 200),
      createdAt: Number(p.createdAt) || 0,
      attempts: Math.max(0, Math.floor(Number(p.attempts) || 0)),
      lastKind: String(p.lastKind || "").slice(0, 16)
    })),
    tombstones: (Array.isArray(value.tombstones) ? value.tombstones : [])
      .filter((t) => t && t.id).slice(-500)
      .map((t) => ({ id: String(t.id).slice(0, 200), at: Number(t.at) || 0 }))
  };
}

async function readJournal() {
  if (journalCache) return journalCache;
  try {
    const { [BG_SYNC_WORK]: raw } = await chrome.storage.local.get(BG_SYNC_WORK);
    const jobs = raw && typeof raw.jobs === "object" && raw.jobs ? raw.jobs : {};
    const out = {};
    for (const [key, value] of Object.entries(jobs)) {
      const job = cleanJob(value);
      if (job) out[key] = job;
    }
    journalCache = { version: 1, jobs: out };
  } catch { journalCache = { version: 1, jobs: {} }; }
  return journalCache;
}

async function readJob(key) {
  return (await readJournal()).jobs[key] || null;
}

// `persist: false` mutates the cached copy only. Callers batch several drops and
// then force one write, so a 5,000-chat pass costs a handful of writes instead
// of one per batch.
async function mutateJournal(mutator, persist = true) {
  const work = async () => {
    const journal = await readJournal();
    const next = await mutator(journal);
    journalCache = next;
    if (persist) {
      try { await chrome.storage.local.set({ [BG_SYNC_WORK]: next }); } catch { /* full */ }
    }
    return next;
  };
  journalWrite = journalWrite.then(work, work);
  return journalWrite;
}

async function flushJournal() {
  return mutateJournal((journal) => journal, true);
}

async function writeJob(key, job) {
  return mutateJournal((journal) => {
    journal.jobs[key] = cleanJob({ ...job, updatedAt: Date.now() });
    return journal;
  });
}

async function clearJob(key) {
  return mutateJournal((journal) => { delete journal.jobs[key]; return journal; });
}

async function dropFromJob(key, ids, tombstoned = [], persist = true) {
  if (!ids.length && !tombstoned.length) return;
  const gone = new Set(ids.concat(tombstoned));
  return mutateJournal((journal) => {
    const job = journal.jobs[key];
    if (!job) return journal;
    job.pending = job.pending.filter((p) => !gone.has(p.id));
    if (tombstoned.length) {
      job.tombstones = (job.tombstones || [])
        .concat(tombstoned.map((id) => ({ id, at: Date.now() }))).slice(-500);
    }
    job.updatedAt = Date.now();
    return journal;
  }, persist);
}

async function setActiveAccount(adapter, checkpointKey) {
  const work = async () => {
    const current = await chrome.storage.local.get(BG_ACTIVE_ACCOUNT);
    const active = current[BG_ACTIVE_ACCOUNT] && typeof current[BG_ACTIVE_ACCOUNT] === "object"
      ? current[BG_ACTIVE_ACCOUNT] : {};
    await chrome.storage.local.set({
      [BG_ACTIVE_ACCOUNT]: { ...active, [adapter.id]: String(checkpointKey).slice(0, 200) }
    });
  };
  activeAccountWrite = activeAccountWrite.then(work, work);
  return activeAccountWrite;
}

async function markBackup(meta) {
  const marker = {
    version: 1,
    createdAt: Date.now(),
    chats: Math.max(0, Number(meta && meta.chats) || 0),
    filename: String((meta && meta.filename) || "archive.lctbackup").slice(0, 160)
  };
  await setDurable({ [BG_BACKUP_MARKER]: marker });
  await chrome.storage.local.set({ [BG_RECOVERY]: { state: "ready", backup: marker } });
  return marker;
}

/**
 * Reinstall detection.
 *
 * The install marker lives in storage.local (wiped with the extension); the
 * backup marker is durable (survives via storage.sync). Marker without install
 * marker = this profile had an archive before, and this is a fresh install.
 *
 * This used to HALT syncing until the user restored a file, which meant a
 * reinstall silently archived nothing — possibly forever, since nothing tells
 * an idle user to go and look. It is now an OFFER: syncing resumes immediately
 * and rebuilds from the providers, and restoring the old file afterwards still
 * merges cleanly, because importBatch() refuses to overwrite a newer archived
 * revision. Restoring first is only ever a shortcut, never a prerequisite.
 */
async function ensureRecoveryState() {
  const local = await chrome.storage.local.get([BG_INSTALL, BG_RECOVERY]);
  if (local[BG_INSTALL]) return local[BG_RECOVERY] || { state: "ready" };
  const { data } = await getDurable(BG_BACKUP_MARKER);
  const marker = data[BG_BACKUP_MARKER] || null;
  const recovery = marker
    ? { state: "restore-offered", backup: marker, reinstalledAt: Date.now() }
    : { state: "ready" };
  await chrome.storage.local.set({ [BG_INSTALL]: { at: Date.now() }, [BG_RECOVERY]: recovery });
  return recovery;
}

async function restoreLedger(backupLedger, backupMeta, backupProfile) {
  const incoming = cleanLedger(backupLedger);
  const current = await readLedger();
  const profile = cleanProfile(backupProfile);
  // A fresh install may have generated an empty local salt while the restore
  // page was opening. Reuse the backup's salt before the gap check so its
  // hashed account key resolves to the backed-up checkpoint. Never replace a
  // profile that already owns live checkpoints in this browser.
  if (profile && !Object.keys(current.checkpoints).length) {
    await setDurable({ [BG_SYNC_PROFILE]: profile });
    profileSaltPromise = Promise.resolve(profile.salt);
  }
  await mutateLedger((ledger) => {
    for (const [key, candidate] of Object.entries(incoming.checkpoints)) {
      const current = ledger.checkpoints[key];
      if (!current || (candidate.completedAt || 0) > (current.completedAt || 0)) {
        ledger.checkpoints[key] = candidate;
      }
    }
    return ledger;
  });
  if (backupMeta) await setDurable({ [BG_BACKUP_MARKER]: backupMeta });
  // Pending sets describe a pass against the pre-restore archive; keeping them
  // would carry stale work into the restored one.
  journalCache = null;
  await chrome.storage.local.remove(BG_SYNC_WORK);
  await chrome.storage.local.set({
    [BG_INSTALL]: { at: Date.now() },
    [BG_RECOVERY]: { state: "ready", restoredAt: Date.now(), backup: backupMeta || null }
  });
  await restoreGuardReset();
  return { ok: true };
}

async function skipRecovery() {
  await chrome.storage.local.set({ [BG_RECOVERY]: { state: "skipped", at: Date.now() } });
  return { ok: true };
}

async function workerId() {
  // A service-worker reload creates a new module instance. Keeping the id in
  // memory (rather than storage.session) lets the durable run journal mark a
  // half-finished pass as interrupted immediately, without ever auto-starting
  // another historical sweep.
  return thisWorkerId;
}

async function normalizeRun() {
  const { [BG_RUN]: run } = await chrome.storage.local.get(BG_RUN);
  if (!run || run.state !== "running") return run || null;
  const stale = Date.now() - (run.heartbeatAt || run.startedAt || 0) > BG_RUN_STALE_MS;
  const replaced = run.workerId !== await workerId();
  if (!stale && !replaced) return run;
  const interrupted = { ...run, state: "interrupted", interruptedAt: Date.now() };
  const update = { [BG_RUN]: interrupted };
  // Only platforms that were still mid-flight are marked paused. A platform
  // that already finished keeps its "everything is backed up" state, so
  // reloading the extension never makes a completed archive look unfinished.
  const ids = run.platforms || [];
  const prog = await chrome.storage.local.get(ids.map(BG_SYNC_PROG));
  for (const id of ids) {
    const current = prog[BG_SYNC_PROG(id)];
    if (current && current.state !== "syncing") continue;
    update[BG_SYNC_PROG(id)] = { state: "interrupted", phase: "interrupted", done: 0, total: 0,
      msg: "Paused. Resumes from the last checkpoint — nothing is re-downloaded.", at: Date.now() };
  }
  await chrome.storage.local.set(update);
  return interrupted;
}

async function beginRun() {
  const existing = await normalizeRun();
  if (existing && existing.state === "running") return null;
  const run = { id: randomId(), state: "running", workerId: await workerId(), startedAt: Date.now(),
    heartbeatAt: Date.now(), platforms: BG_ADAPTERS.map((a) => a.id) };
  await chrome.storage.local.set({ [BG_RUN]: run });
  return run;
}

async function beat(run, platformId) {
  if (!run) return;
  await chrome.storage.local.set({ [BG_RUN]: { ...run, heartbeatAt: Date.now(), platform: platformId } });
}

async function getCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => c.name + "=" + c.value).join("; ");
  } catch { return ""; }
}

// kind drives retry policy; message strings stay verbatim because the outer
// catch and the signedOut flag still match on them.
class BgError extends Error {
  constructor(kind, message, meta = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, meta);
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs, 3600) * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, Math.min(when - Date.now(), 3600000)) : 0;
}

// Full jitter: without it every worker retries on the same tick and the burst
// that caused the 429 repeats exactly.
function backoffDelay(attempt, retryAfterMs) {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return Math.max(retryAfterMs, Math.round(base * (0.5 + Math.random() * 0.5)));
}

const hostState = new Map();
function hostEntry(host) {
  let s = hostState.get(host);
  if (!s) {
    s = { chain: Promise.resolve(), nextAt: 0, cooldownUntil: 0, consecutiveRate: 0,
          concurrency: 0, streak: 0 };
    hostState.set(host, s);
  }
  return s;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function policyFor(host) {
  return BG_HOST_POLICY[host] || { concurrency: 2, minIntervalMs: 700, listDelayMs: 800 };
}

// Serializes request starts per host so minIntervalMs holds across all workers.
function hostSlot(host) {
  const s = hostEntry(host);
  const policy = policyFor(host);
  const work = async () => {
    const wait = Math.max(s.cooldownUntil - Date.now(), s.nextAt - Date.now(), 0);
    if (wait > 0) await sleep(wait);
    s.nextAt = Date.now() + policy.minIntervalMs;
  };
  s.chain = s.chain.then(work, work);
  return s.chain;
}

async function noteRateLimit(host, retryAfterMs, attempt) {
  const s = hostEntry(host);
  s.consecutiveRate++;
  s.streak = 0;
  const delay = backoffDelay(attempt, retryAfterMs);
  // Cool the whole host, not the one worker: otherwise the other workers each
  // collect their own 429 before any of them notices.
  s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + delay);
  if (s.consecutiveRate >= BG_RATE_TRIP) {
    s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + BG_HOST_COOLDOWN_MS);
    await persistCooldown(host, s.cooldownUntil);
    return true;   // circuit open
  }
  return false;
}

function noteOk(host) {
  const s = hostEntry(host);
  s.consecutiveRate = 0;
  s.streak++;
}

async function persistCooldown(host, until) {
  try {
    const { [BG_HOST_COOLDOWN]: raw } = await chrome.storage.local.get(BG_HOST_COOLDOWN);
    const map = (raw && typeof raw === "object") ? raw : {};
    map[host] = until;
    await chrome.storage.local.set({ [BG_HOST_COOLDOWN]: map });
  } catch { /* best effort */ }
}

// A respawned worker has no in-memory cooldown; without this it re-hammers a
// host it was just throttled by.
async function loadCooldown(host) {
  try {
    const { [BG_HOST_COOLDOWN]: raw } = await chrome.storage.local.get(BG_HOST_COOLDOWN);
    const until = raw && typeof raw === "object" ? Number(raw[host]) || 0 : 0;
    if (until > Date.now()) hostEntry(host).cooldownUntil = Math.max(hostEntry(host).cooldownUntil, until);
    return until;
  } catch { return 0; }
}

async function bgFetch(url, opts = {}) {
  const host = hostOf(url);
  const cookieHeader = await getCookieHeader(url);
  const headers = {
    Accept: "application/json, text/plain, */*",
    ...(opts.headers || {}),
    Cookie: cookieHeader
  };
  let lastRate = null;
  for (let attempt = 0; attempt < BG_FETCH_ATTEMPTS; attempt++) {
    await hostSlot(host);
    let r;
    try {
      r = await fetch(url, { ...opts, headers, credentials: "include" });
    } catch (error) {
      if (attempt === BG_FETCH_ATTEMPTS - 1) throw new BgError("net", "network unavailable");
      await sleep(backoffDelay(attempt, 0));
      continue;
    }
    if (r.status === 429 || (r.status === 503 && r.headers.get("Retry-After"))) {
      const retryAfterMs = parseRetryAfter(r.headers.get("Retry-After"));
      const circuitOpen = await noteRateLimit(host, retryAfterMs, attempt);
      lastRate = new BgError("rate", "rate-limited", { retryAfterMs, circuitOpen });
      if (circuitOpen) throw lastRate;
      continue;   // retry in place so the caller's slot isn't burned
    }
    if (r.status === 401 || r.status === 403) throw new BgError("auth", "unauthorized", { status: r.status });
    if (r.status === 404 || r.status === 410) throw new BgError("gone", "http " + r.status, { status: r.status });
    if (!r.ok) {
      if (r.status >= 500 && attempt < BG_FETCH_ATTEMPTS - 1) { await sleep(backoffDelay(attempt, 0)); continue; }
      // The status rides along because not every provider spells "this
      // conversation is gone" as a 404 — Perplexity says 400 — and an adapter
      // can only reclassify what it can see.
      throw new BgError("net", "http " + r.status, { status: r.status });
    }
    noteOk(host);
    return r;
  }
  throw lastRate || new BgError("net", "request failed");
}

async function bgJson(response) {
  // Providers occasionally return their HTML application shell or sign-in
  // page from an otherwise successful request. Parse the body ourselves so
  // the sync UI receives a useful provider error, never a raw JSON exception.
  const text = await response.text();
  try { return JSON.parse(text); }
  catch {
    throw new Error(/^\s*</.test(text) ? "unexpected provider response" : "invalid provider response");
  }
}

/**
 * Walk a provider's conversation list page by page.
 *
 * Pagination on these endpoints is undocumented and differs between builds, so
 * every exit degrades safely rather than looping or overclaiming:
 *   - server ignored `limit` and returned everything → that IS the full set
 *   - server ignored `offset` and repeated a page → stop, report incomplete
 *   - short page → genuine end
 * `complete` is only ever true when the walk actually reached the end, because
 * the caller uses it to decide whether the watermark may advance.
 */
async function walkScheme(adapter, opts, scheme) {
  const { pageSize, sinceMs, progress, fetchPage, toMeta } = opts;
  const delayMs = opts.delayMs != null ? opts.delayMs : policyFor(adapter.host).listDelayMs;
  const metas = [];
  const seen = new Set();
  let complete = false, ordered = true, previous = Infinity, hitOld = false, paged = false;
  /* "The provider listed conversations and we understood none of them" is a
     different fact from "the account is empty", and it is the one that hides.
     An adapter whose id field gets renamed produces metas with no id, every one
     is skipped here, and the walk ends looking exactly like a clean listing of
     an empty account. Counted so the caller can tell the two apart. */
  let sawItems = 0, namedItems = 0;

  for (let page = 0; page < BG_LIST_MAX_PAGES; page++) {
    if (page) await sleep(delayMs);
    let items;
    try { items = await fetchPage(scheme.param(page, pageSize), pageSize); }
    catch (error) {
      if (error && (error.kind === "auth" || error.kind === "rate")) throw error;
      break;   // this scheme's params upset the endpoint — try another
    }
    if (!items.length) { complete = true; break; }

    let fresh = 0;
    for (const it of items) {
      sawItems++;
      const meta = toMeta(it);
      if (!meta || !meta.id) continue;
      namedItems++;
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      fresh++;
      if (meta.updatedAt > previous) ordered = false;
      previous = meta.updatedAt;
      if (sinceMs && meta.updatedAt <= sinceMs) { hitOld = true; continue; }
      metas.push(meta);
    }
    progress(metas.length, 0, `Listing chats… ${metas.length}`);

    // Server ignored `limit` and handed back the whole list — that IS the end.
    if (page === 0 && items.length > pageSize) { complete = true; break; }
    if (!fresh) break;                                   // paging param ignored
    if (page > 0) paged = true;                          // it genuinely advanced
    if (items.length < pageSize) { complete = true; break; }
    if (hitOld && ordered) { complete = true; break; }    // newest-first, past the watermark
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return { metas, complete, paged, unreadable: sawItems > 0 && namedItems === 0 };
}

async function readScheme(host) {
  try {
    const { [BG_PAGE_SCHEME]: raw } = await chrome.storage.local.get(BG_PAGE_SCHEME);
    const entry = raw && typeof raw === "object" ? raw[host] : null;
    if (!entry) return null;
    if (!entry.id && Date.now() - (entry.at || 0) > BG_SCHEME_RETRY_MS) return null;
    return entry;
  } catch { return null; }
}

async function rememberScheme(host, id) {
  try {
    const { [BG_PAGE_SCHEME]: raw } = await chrome.storage.local.get(BG_PAGE_SCHEME);
    const map = raw && typeof raw === "object" ? raw : {};
    map[host] = { id: id || null, at: Date.now() };
    await chrome.storage.local.set({ [BG_PAGE_SCHEME]: map });
  } catch { /* best effort */ }
}

/**
 * Walk a provider's conversation list, discovering how it paginates.
 *
 * Only Claude documents its scheme (limit/offset). For the others the walk
 * tries each candidate until one actually advances past page one, then caches
 * the winner per host so later passes go straight to it. Every exit degrades
 * safely: a scheme that is ignored, rejected, or unsupported yields at most one
 * page and `complete: false`, so the caller never advances the watermark past
 * chats it did not see.
 */
async function pageThrough(adapter, opts) {
  const schemes = opts.schemes || BG_PAGE_SCHEMES;
  const known = opts.noCache ? null : await readScheme(adapter.host);

  // Already established that this endpoint cannot page: take one page and stop
  // rather than re-probing every pass.
  if (known && !known.id) return walkScheme(adapter, opts, schemes[0]);

  const order = known
    ? schemes.filter((s) => s.id === known.id).concat(schemes.filter((s) => s.id !== known.id))
    : schemes;

  let best = null;
  for (const scheme of order) {
    const attempt = await walkScheme(adapter, opts, scheme);
    if (!best || attempt.metas.length > best.metas.length) best = attempt;
    if (attempt.paged) {
      // Includes re-discovery: a cached scheme that stopped working falls
      // through to the remaining candidates rather than giving up.
      if (!opts.noCache && (!known || known.id !== scheme.id)) await rememberScheme(adapter.host, scheme.id);
      return attempt;
    }
    if (attempt.complete) return attempt;   // one page held the whole history
  }
  if (!opts.noCache) await rememberScheme(adapter.host, null);
  return best || { metas: [], complete: false, paged: false, unreadable: false };
}

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
    // Empty text is KEPT, unlike the other adapters: an image-only turn still
    // occupies a row in the page, and the map's positions have to match.
    msgs.push({
      i: String(m.id || node.id || ""),
      r: role,
      t: text,
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
function pplxAnswer(entry) {
  const plain = String(entry.text || "").trim();
  if (plain) return plain;

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

/** Claude states the tier in the org's capabilities, so the plan costs no extra
 *  request — and a plan is what decides the usage ceiling the popup draws. */
function claudeOrgCtx(org) {
  const caps = Array.isArray(org && org.capabilities) ? org.capabilities.map(String) : [];
  const plan = caps.includes("claude_max") ? "Max"
    : caps.includes("claude_pro") ? "Pro"
    : caps.includes("raven") || caps.includes("claude_team") ? "Team" : "Free";
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
    async get(ctx, path) {
      const r = await bgFetch(this.base + path, {
        headers: { Authorization: "Bearer " + ctx.tok }
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
    async detailFull(ctx, id) {
      const conv = await this.get(ctx, "/backend-api/conversation/" + id);
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
      return { ...claudeOrgCtx(org), orgs: list };
    },
    // One Claude login can own several organisations, and chats live in exactly
    // one of them. Syncing only the first quietly archived nothing from the
    // others — from the user's side, indistinguishable from a backup that lost
    // their work. Each org is its own account here, with its own checkpoint.
    accounts(ctx) {
      const list = Array.isArray(ctx.orgs) && ctx.orgs.length ? ctx.orgs : [{ uuid: ctx.org }];
      return list.map((org) => ({ ...ctx, ...claudeOrgCtx(org) }));
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
    async rpc(ctx, rpcid, payload) {
      geminiReqid = (geminiReqid || Math.floor(Math.random() * 90000) + 10000) + 100000;
      const params = new URLSearchParams({
        rpcids: rpcid, "source-path": "/app", hl: "en",
        _reqid: String(geminiReqid), rt: "c"
      });
      if (ctx.bl) params.set("bl", ctx.bl);
      if (ctx.sid) params.set("f.sid", ctx.sid);
      const r = await bgFetch(this.base + GEMINI_BATCH_PATH + "?" + params.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Same-Domain": "1"
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
        const reply = String(geminiAt(best, [1, 0]) || geminiAt(best, [22, 0]) || "").trim();
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
  }
];

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

/** The map only needs shape and a label — never the full transcript. */
function indexFromMsgs(msgs) {
  const out = [];
  for (const m of msgs || []) {
    if (!m || !m.i) continue;
    const t = m.t || "";
    out.push({ i: m.i, r: m.r === "user" ? "user" : "assistant", n: t.length, c: IDX_CODE.test(t) ? 1 : 0, s: t.slice(0, IDX_SNIP) });
  }
  return out;
}

async function idxPrepare(adapter) {
  const hit = idxCtx.get(adapter.host);
  if (hit && Date.now() - hit.at < IDX_CTX_TTL) return hit.ctx;
  const ctx = await adapter.prepare();
  idxCtx.set(adapter.host, { ctx, at: Date.now() });
  return ctx;
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
  const id = String(host || "") + String(path || "");
  try {
    const d = await db();
    const rec = await reqP(tx(d, "readonly").get(id.slice(0, 600)));
    if (!rec || !rec.msgs) return { status: "missing" };
    const m = rec.msgs.find((x) => x.i === messageId);
    if (!m) return { status: "missing" };
    return { status: "ok", role: m.r, text: m.t, ts: m.ts || 0 };
  } catch { return { status: "missing" }; }
}

/** Forget a conversation. The only path that removes archived text. */
async function dropChat(id) {
  try {
    const d = await db();
    await reqP(tx(d, "readwrite").delete(String(id).slice(0, 600)));
  } catch { /* archive unavailable — nothing to forget */ }
}

/* ===================== deletion review =====================
 *
 * A chat vanishing upstream used to delete the archived copy on sight. That
 * makes the backup strictly weaker than the provider: one wrong click on
 * chatgpt.com, or a provider retention sweep, and the local copy — the whole
 * reason this archive exists — is gone with it, silently.
 *
 * So deletion is now a QUESTION, not an event. A vanished chat is quarantined:
 * still archived, still searchable, flagged, and queued for the user. Only an
 * explicit answer (or an explicit standing policy) removes anything.
 *
 * settings.deletionPolicy:
 *   "ask"    — default. Quarantine and prompt.
 *   "keep"   — the archive outlives the provider. Never prompt, never delete.
 *   "mirror" — the archive tracks the provider exactly. Delete on sight.
 */

const DELETION_REASONS = new Set(["opened", "sync", "sweep"]);

async function deletionPolicy() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    const value = settings && settings.deletionPolicy;
    return value === "keep" || value === "mirror" ? value : "ask";
  } catch { return "ask"; }
}

async function readDeletions() {
  try {
    const { [BG_DELETIONS]: raw } = await chrome.storage.local.get(BG_DELETIONS);
    const items = raw && typeof raw.items === "object" && raw.items ? raw.items : {};
    const out = {};
    for (const [id, value] of Object.entries(items)) {
      if (!value || typeof value !== "object") continue;
      out[String(id).slice(0, 600)] = {
        id: String(id).slice(0, 600),
        platform: String(value.platform || "").slice(0, 32),
        host: String(value.host || "").slice(0, 120),
        path: String(value.path || "").slice(0, 400),
        title: String(value.title || "").slice(0, 200),
        messages: Math.max(0, Math.floor(Number(value.messages) || 0)),
        updatedAt: Number(value.updatedAt) || 0,
        detectedAt: Number(value.detectedAt) || 0,
        reason: DELETION_REASONS.has(value.reason) ? value.reason : "sync"
      };
    }
    return { version: 1, items: out };
  } catch { return { version: 1, items: {} }; }
}

let deletionWrite = Promise.resolve();

async function mutateDeletions(mutator) {
  const work = async () => {
    const current = await readDeletions();
    const next = (await mutator(current)) || current;
    const entries = Object.entries(next.items);
    if (entries.length > BG_DELETION_MAX) {
      // Oldest detections go first: the newest surprise is the one the user
      // still has context for.
      entries.sort((a, b) => (b[1].detectedAt || 0) - (a[1].detectedAt || 0));
      next.items = Object.fromEntries(entries.slice(0, BG_DELETION_MAX));
    }
    try { await chrome.storage.local.set({ [BG_DELETIONS]: next }); } catch { /* full */ }
    await paintDeletionBadge(Object.keys(next.items).length);
    return next;
  };
  deletionWrite = deletionWrite.then(work, work);
  return deletionWrite;
}

async function paintDeletionBadge(count) {
  try {
    if (!chrome.action || !chrome.action.setBadgeText) return;
    await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : "" });
    if (count && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
    }
  } catch { /* action API unavailable */ }
}

/** Enough of the archived record to let the user recognise what they are about to lose. */
async function chatSummary(id) {
  try {
    const d = await db();
    const rec = await reqP(tx(d, "readonly").get(String(id).slice(0, 600)));
    if (!rec) return null;
    return { title: rec.title || "", messages: (rec.msgs || []).length,
      updatedAt: rec.updatedAt || 0, platform: rec.platform || "", host: rec.host || "", path: rec.path || "" };
  } catch { return null; }
}

let deletionNoticePending = null;

/**
 * The provider says this chat is gone. Decide what that means for the archive.
 * Returns whether the archived copy was actually removed.
 */
async function noteVanished(id, hint = {}, reason = "sync") {
  const recordId = String(id).slice(0, 600);
  const policy = await deletionPolicy();
  if (policy === "mirror") { await dropChat(recordId); return { removed: true, policy }; }
  if (policy === "keep") return { removed: false, policy };

  const existing = (await readDeletions()).items[recordId];
  if (existing) return { removed: false, policy, queued: true };
  const summary = await chatSummary(recordId);
  // Nothing archived under that id — there is no decision to put to anyone.
  if (!summary) return { removed: false, policy, unknown: true };

  await mutateDeletions((state) => {
    state.items[recordId] = {
      id: recordId,
      platform: summary.platform || hint.platform || "",
      host: summary.host || hint.host || "",
      path: summary.path || hint.path || "",
      title: summary.title,
      messages: summary.messages,
      updatedAt: summary.updatedAt,
      detectedAt: Date.now(),
      reason: DELETION_REASONS.has(reason) ? reason : "sync"
    };
    return state;
  });
  scheduleDeletionNotice();
  return { removed: false, policy, queued: true };
}

/* One notification per burst, not one per chat: a sweep can find forty at once
   and forty toasts is an attack on the user, not a prompt. */
function scheduleDeletionNotice() {
  if (deletionNoticePending) return;
  deletionNoticePending = setTimeout(() => {
    deletionNoticePending = null;
    showDeletionNotice();
  }, 2500);
}

async function showDeletionNotice() {
  const count = Object.keys((await readDeletions()).items).length;
  if (!count) return;
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    await chrome.notifications.create("lct-deletions", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: count === 1 ? "A chat was deleted where you use it" : `${count} chats were deleted where you use them`,
      message: count === 1
        ? "Your backup still has it. Keep the backup copy, or delete it here too?"
        : "Your backup still has them. Choose which copies to keep.",
      priority: 1,
      requireInteraction: false
    });
  } catch { /* notifications unavailable — the badge and the panel still carry it */ }
}

/** The user answered. `action` is "delete" (remove from the backup too) or "keep". */
async function resolveDeletions(ids, action) {
  const wanted = Array.isArray(ids) ? ids.map((id) => String(id).slice(0, 600)) : [];
  const state = await readDeletions();
  const targets = wanted.length ? wanted.filter((id) => state.items[id]) : Object.keys(state.items);
  if (action === "delete") {
    for (const id of targets) await dropChat(id);
  } else if (action !== "keep") {
    return { err: "unknown action" };
  }
  await mutateDeletions((current) => {
    for (const id of targets) delete current.items[id];
    return current;
  });
  try { if (chrome.notifications) await chrome.notifications.clear("lct-deletions"); } catch { /* fine */ }
  return { ok: true, action, count: targets.length };
}

async function deletionsList() {
  const state = await readDeletions();
  const items = Object.values(state.items).sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0));
  return { items, policy: await deletionPolicy() };
}

/**
 * Reconcile a FULL provider listing against the archive. Only safe when the
 * listing genuinely covered everything — a delta pass lists a window, and every
 * chat outside it would look deleted.
 */
async function sweepVanished(adapter, index, listedIds, scanStartedAt, pendingIds) {
  const candidates = [];
  for (const [recordId, revision] of index) {
    if (listedIds.has(recordId)) continue;
    // Written during this very pass, or still outstanding in the journal —
    // either way the listing is not evidence it is gone.
    if (Number(revision) >= scanStartedAt) continue;
    if (pendingIds.has(recordId.slice((adapter.host + adapter.prefix).length))) continue;
    candidates.push(recordId);
  }
  if (!candidates.length) return { vanished: 0 };
  // Nothing at all came back, yet the account demonstrably holds chats. That is
  // a session that expired between the handshake and the listing, or a provider
  // having a bad minute — never a user who deleted their entire history in the
  // gap between two passes. The proportional guard below cannot catch this on a
  // small archive, where "everything" is fewer chats than its floor.
  if (!listedIds.size) {
    await noteSweepAnomaly(adapter.id, candidates.length, index.size);
    return { vanished: 0, skipped: candidates.length, reason: "empty-listing" };
  }
  // A signed-out session, a changed response shape or a half-finished walk can
  // all produce a short listing, and every chat outside it then looks deleted.
  // Anything past a quarter of the archive is treated as a broken listing
  // rather than a very busy afternoon of deleting. The small floor keeps this
  // workable on a four-chat archive, where a quarter is one chat.
  //
  // The trade is deliberate: a genuine mass deletion goes unnoticed (the copies
  // simply stay, which is this feature's default anyway) instead of a glitch
  // putting the whole archive up for deletion in one dialog.
  const ceiling = Math.max(5, Math.floor(index.size * 0.25));
  if (candidates.length > ceiling) {
    await noteSweepAnomaly(adapter.id, candidates.length, index.size);
    return { vanished: 0, skipped: candidates.length, reason: "implausible" };
  }
  let removed = 0, queued = 0;
  for (const recordId of candidates) {
    const result = await noteVanished(recordId, { platform: adapter.id, host: adapter.host }, "sweep");
    if (result.removed) removed++;
    else if (result.queued) queued++;
  }
  return { vanished: candidates.length, removed, queued };
}

/* ===================== telling accounts apart without being told ============
 *
 * DeepSeek and Grok expose no endpoint that names the signed-in user, so every
 * account on them started out sharing one checkpoint key. That was survivable
 * while the archive was one undifferentiated pile per host. It is not
 * survivable now: sign into a second account, and its complete listing would
 * present the first account's entire history as vanished.
 *
 * Session cookies rotate, so they cannot be the identity (an earlier build
 * tried; every rotation re-swept the whole history). What does not rotate is
 * what the account HOLDS. The oldest conversation in a complete listing is a
 * stable, provider-assigned anchor for that account — and it is an id the
 * archive already stores anyway, so it introduces no new class of data.
 *
 * Three outcomes, and the ambiguous one always resolves toward keeping data:
 *   anchor matches, or none recorded  → same account.
 *   anchor differs but the listing still overlaps what this account holds
 *                                     → same account that deleted its oldest
 *                                       chat. Move the anchor, keep the tag.
 *   anchor differs and the listing is
 *   a stranger to the archive         → a DIFFERENT account. Re-key onto its
 *                                       own checkpoint and suppress the sweep
 *                                       for this pass: a listing from an
 *                                       account we have never seen is no
 *                                       evidence about anybody else's chats.
 */

/** The oldest chat in a listing. Ties break on id so the anchor is stable. */
function listingAnchor(metas) {
  let best = null;
  for (const meta of metas || []) {
    if (!meta || !meta.id) continue;
    const at = Number(meta.createdAt) || Number(meta.updatedAt) || 0;
    const id = String(meta.id);
    if (!best || at < best.at || (at === best.at && id < best.id)) best = { id, at };
  }
  return best ? best.id : "";
}

async function resolveAnchor(adapter, provisionalKey, checkpoint, metas, complete) {
  const anchor = listingAnchor(metas);
  // A delta lists a window, so its oldest entry says nothing about the account.
  // An empty listing says even less.
  if (!complete || !anchor) {
    return { key: provisionalKey, anchor: (checkpoint && checkpoint.anchor) || "", switched: false };
  }

  // Every account this browser has already separated on this platform, plus the
  // key we opened with. Matching against ALL of them is what lets an account be
  // recognised again on a later pass: the provisional key is the same one for
  // everybody here, so asking only "is this the account the provisional key
  // describes?" can discover a second account but never re-find it.
  const ledger = await readLedger();
  const known = Object.entries(ledger.checkpoints)
    .filter(([, c]) => c && c.platform === adapter.id)
    .map(([key, c]) => ({ key, anchor: String(c.anchor || "") }));
  if (!known.some((k) => k.key === provisionalKey)) {
    known.push({ key: provisionalKey, anchor: (checkpoint && checkpoint.anchor) || "" });
  }

  // 1. An exact anchor match is the account, full stop.
  const exact = known.find((k) => k.anchor && k.anchor === anchor);
  if (exact) return { key: exact.key, anchor, switched: exact.key !== provisionalKey };

  // 2. Otherwise the account whose archived chats this listing actually
  //    overlaps. That survives the anchor moving — which is what happens the
  //    day somebody deletes their oldest conversation.
  const prefix = adapter.host + adapter.prefix;
  let best = null, attributed = 0;
  for (const candidate of known) {
    const index = await accountIndex(adapter.host, adapter.prefix, tagOfKey(candidate.key));
    attributed += index.size;
    if (!index.size) continue;
    let overlap = 0;
    for (const meta of metas) if (index.has(prefix + meta.id)) overlap++;
    const floor = Math.max(1, Math.min(metas.length, index.size) * BG_ANCHOR_OVERLAP);
    if (overlap >= floor && (!best || overlap > best.overlap)) best = { key: candidate.key, overlap };
  }
  if (best) return { key: best.key, anchor, switched: best.key !== provisionalKey };

  // 3. Nothing on this platform is attributed yet, so there is nobody to be
  //    mistaken for: keep the key we already had. This is the first pass after
  //    an upgrade, and re-keying here would abandon a good checkpoint and
  //    re-download a history that is already on disk.
  if (!attributed) return { key: provisionalKey, anchor, switched: false };

  // 4. A listing that no account here recognises. Its own checkpoint, and no
  //    opinion about anybody else's chats this pass.
  return { key: await identityCheckpointKey(adapter, "anchor:" + anchor), anchor, switched: true };
}

/* ===================== who is signed in, for a content script ===============
 *
 * Usage counting is per ACCOUNT because the limit is per account — that is the
 * whole reason people keep a second one. A page therefore has to know which
 * account it is looking at before it can count anything, and it must not pay a
 * provider round trip to find out on every message sent.
 *
 * So the worker answers, and caches: one handshake per host per TTL, shared by
 * every tab. A page on a provider we do not sync (no adapter — Gemini) supplies
 * its own hint from the URL or the page chrome, which is salted and hashed here
 * exactly like a provider id, so the same rule holds everywhere: raw account
 * identifiers are never stored.
 *
 * The two paths are alternatives, never a fallback for one another: they salt
 * different identities, so the same person would tag as two accounts depending
 * on which one answered. A host with an adapter is therefore identified by the
 * adapter or not at all — a failed handshake yields an empty tag and the page
 * counts per host, which is what it did before accounts existed.
 */

const ACCT_CACHE_TTL = 5 * 60 * 1000;
const acctCache = new Map();      // host -> { at, value }

async function accountForHost(host, hint = "") {
  const key = host + "|" + hint;
  const hit = acctCache.get(key);
  if (hit && Date.now() - hit.at < ACCT_CACHE_TTL) return hit.value;

  const adapter = BG_ADAPTERS.find((a) => a.host === host);
  let value = { acct: "", label: "", ordinal: 0, plan: "", identified: false };

  /* Prefer whichever source can actually name the account, not whichever is
     nearer. An adapter flagged `namesAccount: false` has no endpoint that says
     who is signed in, so every account on that host collapses to one
     device-level tag — while the page, looking at the account switcher or the
     /u/N seat, can tell two of them apart. Gemini is the case that makes this
     matter: two Google accounts really are open side by side in one profile,
     and a shared tag counts both against one limit. It also saves the prepare()
     round trip we would only discard. */
  const preferHint = !!hint && (!adapter || adapter.namesAccount === false);

  /* Nothing to check the hint against here — but a hint is still stable per
     account, which is all a usage tally needs. */
  const fromHint = async () => {
    const platformId = PAGE_PLATFORMS[host] || host;
    const acct = tagOfKey(await identityCheckpointKey({ id: platformId }, "hint:" + hint));
    const meta = await noteAccount(platformId, acct, { handle: hint, identified: false });
    return {
      acct, label: (meta && meta.label) || "", ordinal: (meta && meta.ordinal) || 1,
      plan: "", identified: false
    };
  };

  try {
    if (preferHint) {
      value = await fromHint();
    } else if (adapter) {
      try {
        const ctx = await adapter.prepare();
        const acct = await accountTag(adapter, ctx);
        const meta = await noteAccount(adapter.id, acct, {
          handle: ctx.handle, plan: ctx.plan, identified: ctx.identified !== false
        });
        value = {
          acct, label: (meta && meta.label) || "", ordinal: (meta && meta.ordinal) || 1,
          plan: (meta && meta.plan) || "", identified: ctx.identified !== false
        };
      } catch (error) {
        /* The adapter could not answer — the host permission was declined, the
           session lapsed, the provider changed shape. The two paths salt
           different identities, so this is a FALLBACK and never an alternative:
           preferring the hint while the adapter still works would tag the same
           person twice. Here the choice is the hint or nothing, and Gemini is
           the case that makes it matter — two Google accounts really are open
           side by side, and per-host counting cannot tell them apart. */
        if (!hint) throw error;
        value = await fromHint();
      }
    } else if (hint) {
      value = await fromHint();
    }
  } catch {
    // Signed out, offline, or the provider changed shape. An empty tag is a
    // valid answer: the page falls back to counting per host, which is what it
    // did before accounts existed.
    value = { acct: "", label: "", ordinal: 0, plan: "", identified: false };
  }
  acctCache.set(key, { at: Date.now(), value });
  return value;
}

// Hosts we count usage on but do not sync from. Keyed here so a usage tally and
// a sync checkpoint can never disagree about what a platform is called.
const PAGE_PLATFORMS = {
  "gemini.google.com": "gemini",
  "www.perplexity.ai": "perplexity",
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "claude.ai": "claude",
  "chat.deepseek.com": "deepseek",
  "grok.com": "grok"
};

const USAGE_PREFIX = "usage:";

/** Every per-account usage tally. Cleared with the archive. */
async function clearUsage() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(USAGE_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch { /* nothing to clear it from */ }
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
    const { [BG_SWEEP_STATE]: state } = await chrome.storage.local.get(BG_SWEEP_STATE);
    const next = state && typeof state === "object" ? state : {};
    next.anomaly = { platform: platformId, missing, archived, at: Date.now() };
    await chrome.storage.local.set({ [BG_SWEEP_STATE]: next });
  } catch { /* nothing to record it in */ }
}

async function markSwept(platformId) {
  try {
    const { [BG_SWEEP_STATE]: state } = await chrome.storage.local.get(BG_SWEEP_STATE);
    const next = state && typeof state === "object" ? state : {};
    next[platformId] = Date.now();
    await chrome.storage.local.set({ [BG_SWEEP_STATE]: next });
  } catch { /* next pass sweeps instead */ }
}

/**
 * The whole conversation as a per-message index, for ONE chat.
 *
 * Stale-while-revalidate: an archived copy that carries message ids is served
 * with zero network so the map is complete before the first paint; the caller
 * re-asks with force once it has painted, and only then do we pay the round
 * trip. Every failure is a status, never a throw — no index just means the map
 * falls back to what the host has mounted, which is where it started.
 */
async function chatIndex(host, path, opts = {}) {
  const adapter = BG_ADAPTERS.find((a) => a.host === host && String(path || "").startsWith(a.prefix));
  // Gemini and Perplexity have no history endpoint here at all — answer before
  // touching the network rather than failing somewhere deeper.
  if (!adapter || adapter.id !== "chatgpt" || !adapter.detailFull) return { status: "unsupported" };
  const convId = String(path).slice(adapter.prefix.length).split(/[?#/]/)[0];
  if (!convId) return { status: "unsupported" };
  const recordId = adapter.host + adapter.prefix + convId;

  if (!opts.force) {
    try {
      const d = await db();
      const rec = await reqP(tx(d, "readonly").get(recordId));
      if (rec && rec.mv === 1 && rec.n >= 2) {
        return { status: "ok", source: "archive", stale: true, entries: indexFromMsgs(rec.msgs), title: rec.title || "" };
      }
    } catch { /* fall through to the provider */ }
  }

  const inflight = idxInflight.get(recordId);
  if (inflight) return inflight;
  if (opts.force && Date.now() - (idxFetchedAt.get(recordId) || 0) < IDX_FRESH_MS) {
    return { status: "fresh" };
  }

  const run = (async () => {
    try {
      const ctx = await idxPrepare(adapter);
      const full = await adapter.detailFull(ctx, convId);
      idxFetchedAt.set(recordId, Date.now());
      if (full.msgs.length >= 2) {
        // importBatch, not upsert: it already refuses to overwrite a newer
        // archived revision, and reading a chat should never lose one.
        await importBatch([{
          id: recordId, host: adapter.host, path: adapter.prefix + convId,
          platform: adapter.label, title: full.title,
          createdAt: full.createdAt, updatedAt: full.updatedAt || Date.now(),
          sourceUpdatedAt: full.updatedAt, msgs: full.msgs
        }]);
      }
      return { status: "ok", source: "provider", stale: false, entries: indexFromMsgs(full.msgs), title: full.title };
    } catch (error) {
      const kind = (error && error.kind) || "net";
      // Deleted upstream. Quarantine it and ask — deleting on sight would make
      // the archive lose exactly what the user may have opened it to recover.
      if (kind === "gone") {
        idxCtx.delete(adapter.host);
        await noteVanished(recordId, { platform: adapter.id, host: adapter.host, path: adapter.prefix + convId }, "opened");
      }
      if (kind === "auth") idxCtx.delete(adapter.host);
      return { status: kind };
    } finally {
      idxInflight.delete(recordId);
    }
  })();
  idxInflight.set(recordId, run);
  return run;
}

/* ---------- progress (coalesced) ----------
 * One write per BG_PROGRESS_MS instead of two per chat: a 256-chat pass used to
 * fire ~512 storage writes and as many full UI repaints. */

let progressPending = null;
let progressTimer = null;
let progressAt = 0;

async function flushProgress() {
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  const p = progressPending;
  if (!p) return;
  progressPending = null;
  progressAt = Date.now();
  try {
    await chrome.storage.local.set({
      [BG_SYNC_PROG(p.platform)]: p.record,
      ...(p.run ? { [BG_RUN]: { ...p.run, heartbeatAt: Date.now(), platform: p.platform } } : {})
    });
  } catch { /* dead context */ }
}

function writeProgress(adapter, run, fields, opts = {}) {
  const record = {
    state: "syncing", phase: "syncing", runId: run && run.id, platform: adapter.id,
    at: Date.now(), ...fields
  };
  // `done` stays an alias of `attempted` for the popup and Recall page.
  if (record.attempted != null && record.done == null) record.done = record.attempted;
  progressPending = { platform: adapter.id, record, run };
  const due = progressAt + BG_PROGRESS_MS - Date.now();
  if (opts.force || due <= 0) return flushProgress();
  if (!progressTimer) progressTimer = setTimeout(() => { flushProgress(); }, due);
  return Promise.resolve();
}

async function finishPlatform(adapter, checkpointKey, checkpoint, result, fields, message, coverage) {
  const completedAt = Date.now();
  await saveCheckpoint(checkpointKey, {
    ...checkpoint,
    version: 5,
    platform: adapter.id,
    completedAt,
    lastResult: result,
    coverage: Math.max(0, Number(coverage) || 0),
    coverageKnown: true
  });
  await clearJob(checkpointKey);
  progressPending = null;
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  await chrome.storage.local.set({
    [BG_SYNC_PROG(adapter.id)]: {
      state: "done", phase: "up-to-date", result, msg: message, at: completedAt,
      runId: checkpoint.runId, platform: adapter.id,
      done: fields.attempted || 0, ...fields
    },
    [BG_SYNC_FLAG(adapter.id)]: { lastFull: completedAt }
  });
}

// Is the user on this site right now? An auto pass defers rather than compete
// with their own browsing for the provider's rate limit. Needs no "tabs"
// permission — tab.url is populated for hosts we already hold permission for.
async function tabPresence(host) {
  try {
    if (typeof chrome.tabs === "undefined") return { open: false, active: false };
    const tabs = await chrome.tabs.query({});
    let open = false, active = false;
    for (const t of tabs) {
      let h = "";
      try { h = new URL(t.url || "").hostname; } catch { /* opaque tab */ }
      if (h !== host) continue;
      open = true;
      if (t.active) active = true;
    }
    return { open, active };
  } catch { return { open: false, active: false }; }
}

/**
 * Reconcile one provider against the local archive.
 *
 * Authority order:
 *
 *   1. The archive index (what this browser actually holds) decides what gets
 *      downloaded. A chat is fetched only when it is absent, or when the
 *      provider's revision is newer than the archived one.
 *   2. The outstanding-work journal holds everything this pass still intends to
 *      fetch. It is written WITH the advanced watermark before the first detail
 *      request, so an interrupted or fully rate-limited pass still leaves a
 *      trustworthy checkpoint behind and the next pass resumes instead of
 *      re-listing the whole history.
 *   3. The checkpoint watermark only decides how much metadata to LIST, and is
 *      trusted only while coverage holds AND the journal matches it. A
 *      reinstall, a wipe, or a lost journal widens the pass to a full listing —
 *      which still downloads nothing already archived, because rule 1 outranks
 *      it.
 */
/**
 * One platform, however many accounts are signed into it.
 *
 * The gates that belong to the HOST — rate-limit cooldown, and staying out of
 * the way while the user is on the site — are answered once here. Everything
 * downstream of a session belongs to an ACCOUNT, and each gets its own pass:
 * its own checkpoint, its own outstanding-work journal, its own view of the
 * archive. A Claude login with three organisations is three passes.
 */
async function bgSyncPlatform(adapter, run, opts = {}) {
  const auto = opts.reason === "auto";

  // 1. host cooling down from an earlier 429 — say so, don't grind
  const cooldownUntil = await loadCooldown(adapter.host);
  if (cooldownUntil > Date.now()) {
    await chrome.storage.local.set({
      [BG_SYNC_PROG(adapter.id)]: {
        state: "paused", phase: "paused", runId: run.id, platform: adapter.id,
        done: 0, total: 0, cooldownUntil,
        msg: `${adapter.label} is rate-limiting — resumes automatically`, at: Date.now()
      }
    });
    return { ok: true, result: "cooling-down" };
  }

  // 2. never compete with the user's own browsing on an unattended pass
  const tabs = await tabPresence(adapter.host);
  if (auto && tabs.active) {
    await chrome.storage.local.set({
      [BG_SYNC_PROG(adapter.id)]: {
        state: "deferred", phase: "deferred", runId: run.id, platform: adapter.id,
        done: 0, total: 0, msg: `Waiting until you're done on ${adapter.label}`, at: Date.now()
      }
    });
    return { ok: true, result: "deferred" };
  }

  let contexts;
  try {
    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0, msg: "Connecting…" }, { force: true });
    const primary = await adapter.prepare();
    contexts = (adapter.accounts ? await adapter.accounts(primary) : [primary]).filter(Boolean);
    if (!contexts.length) contexts = [primary];
  } catch (error) {
    return reportPlatformError(adapter, run, error, { attempted: 0, total: 0, succeeded: 0, failed: 0 });
  }

  const results = [];
  for (let seat = 0; seat < contexts.length; seat++) {
    results.push(await bgSyncAccount(adapter, run, opts, contexts[seat], tabs,
      { seat, seats: contexts.length }));
    // Two accounts on one host back to back is still one host being asked
    // twice; pace them like any other pair of listing requests.
    if (seat + 1 < contexts.length) await sleep(policyFor(adapter.host).listDelayMs);
  }
  return mergeAccountResults(results);
}

/** One verdict for a platform from one verdict per account. The most
 *  "unfinished" outcome wins, because that is what schedules a resume. */
function mergeAccountResults(results) {
  if (results.length === 1) return results[0];
  const failure = results.find((r) => r && !r.ok);
  if (failure) {
    return { ok: false, error: failure.error, signedOut: !!failure.signedOut, accounts: results.length };
  }
  const rank = ["rate-limited", "partial", "reconcile", "sweep", "delta", "up-to-date"];
  return {
    ok: true,
    result: rank.find((name) => results.some((r) => r && r.result === name)) || "up-to-date",
    archived: results.reduce((sum, r) => sum + (Number(r && r.archived) || 0), 0),
    left: results.reduce((sum, r) => sum + (Number(r && r.left) || 0), 0),
    accounts: results.length
  };
}

async function bgSyncAccount(adapter, run, opts, ctx, tabs, seat = { seat: 0, seats: 1 }) {
  let attempted = 0, succeeded = 0, failed = 0, total = 0;
  try {
    const { key: provisionalKey, checkpoint: provisionalCheckpoint } = await readCheckpoint(adapter, ctx);
    let checkpointKey = provisionalKey;
    let checkpoint = provisionalCheckpoint;
    let job = await readJob(checkpointKey);
    let acct = tagOfKey(checkpointKey);
    await setActiveAccount(adapter, checkpointKey);
    await noteAccount(adapter.id, acct, {
      handle: ctx.handle, plan: ctx.plan, identified: ctx.identified !== false
    });

    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0,
      msg: seat.seats > 1
        ? `Reading your local archive… (account ${seat.seat + 1} of ${seat.seats})`
        : "Reading your local archive…" });
    // Two views, two jobs. `index` answers "already held?" across every account
    // on the host so nothing is downloaded twice; `acctIndex` answers "held by
    // THIS account?", and only it may drive deletion and coverage.
    const index = await archiveIndex(adapter.host, adapter.prefix);
    let acctIndex = await accountIndex(adapter.host, adapter.prefix, acct);
    const covered = checkpoint && checkpoint.coverageKnown ? Number(checkpoint.coverage) || 0 : -1;
    // The journal may run AHEAD of pendingCount (it flushes far more often than
    // the sync ledger), never behind. scanStartedAt proves both came from the
    // same pass; a missing journal with work outstanding forces a full listing.
    const pendingOk = !(checkpoint && checkpoint.pendingCount) ||
      !!(job && job.scanStartedAt === checkpoint.safeWatermark &&
         job.pending.length <= checkpoint.pendingCount);
    // Coverage is compared against what THIS account holds. Against the whole
    // host it was worse than useless once a second account existed: the second
    // account's rows padded the count, so the check that exists to notice a
    // wiped archive could no longer notice one.
    const trustWatermark = !!(checkpoint && checkpoint.safeWatermark &&
      covered >= 0 && acctIndex.size >= covered && pendingOk);
    // A delta listing cannot see a deletion: a chat the user removed simply is
    // not in the window, exactly like a chat that never changed. Once a day the
    // pass lists everything instead, purely so vanished chats can be noticed.
    // It costs listing requests only — rule 1 still downloads nothing already
    // archived.
    const sweeping = trustWatermark && acctIndex.size > 0 && await sweepDue(adapter.id) &&
      (await deletionPolicy()) !== "keep";
    // A provider that will not name the signed-in account is re-identified from
    // its listing every pass, so the listing has to be a complete one. Listing
    // is cheap — rule 1 still downloads nothing already archived — and the
    // alternative is writing one account's chats under another's name.
    const mustIdentify = ctx.identified === false;
    const sinceMs = trustWatermark && !sweeping && !mustIdentify
      ? Math.max(0, checkpoint.safeWatermark - BG_SYNC_OVERLAP_MS) : 0;
    const mode = sweeping ? "sweep" : trustWatermark ? "delta" : "reconcile";
    let carried = trustWatermark && job ? job.pending : [];
    // Captured BEFORE listing on purpose: a chat that shifts pages mid-listing
    // still has a revision >= this, so the next pass re-lists it.
    const scanStartedAt = Date.now();

    // 3. one request to answer "anything new?" on a routine pass. Skipped while
    //    sweeping — "nothing new" says nothing about what was removed.
    if (trustWatermark && !sweeping && !mustIdentify && !carried.length && adapter.peek) {
      const { hasNew } = await adapter.peek(ctx, sinceMs);
      if (!hasNew) {
        await finishPlatform(adapter, checkpointKey,
          { ...checkpoint, safeWatermark: scanStartedAt, pendingCount: 0, passState: "clean",
            runId: run.id, acctScoped: true },
          "up-to-date", { attempted: 0, total: 0, succeeded: 0, failed: 0 },
          "Everything is already backed up", acctIndex.size);
        return { ok: true, result: "up-to-date", mode };
      }
    }

    const progress = (count, listedTotal, msg) =>
      writeProgress(adapter, run, { phase: "checking", attempted: count || 0, total: listedTotal || 0,
        msg: msg || "Checking for new chats…" });
    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0,
      msg: mode === "delta" ? "Checking for new chats…"
        : mode === "sweep" ? "Checking which chats still exist…"
        : index.size ? "Rebuilding the archive index…" : "Building the first archive index…" });

    const listed = await adapter.list(ctx, sinceMs, progress);
    // The provider named conversations and this adapter recognised none of
    // them — a field it reads has been renamed upstream. That is not an empty
    // account, and reporting it as a clean pass is how Grok came to archive
    // nothing at all while every check came back green. Fail loudly, before
    // anything is written and before the watermark can move past chats that
    // were never actually seen.
    if (listed.unreadable) throw new BgError("shape", "provider listing not understood");
    const metas = listed.metas || [];
    const complete = listed.complete !== false;
    const prefix = adapter.host + adapter.prefix;

    // 3a. Whose listing was that? Providers that name the account answered this
    //     before the first request; the rest are identified by what they hold.
    let anchor = (checkpoint && checkpoint.anchor) || "";
    let strangerAccount = false;
    if (mustIdentify) {
      const resolved = await resolveAnchor(adapter, checkpointKey, checkpoint, metas, complete);
      anchor = resolved.anchor;
      if (resolved.switched) {
        // A different account than the checkpoint we opened with. Everything
        // account-shaped has to be re-read under its own key before a single
        // byte is written, and its pending set is not ours to carry.
        checkpointKey = resolved.key;
        checkpoint = (await readLedger()).checkpoints[checkpointKey] || null;
        job = await readJob(checkpointKey);
        acct = tagOfKey(checkpointKey);
        acctIndex = await accountIndex(adapter.host, adapter.prefix, acct);
        carried = [];
        strangerAccount = true;
        await setActiveAccount(adapter, checkpointKey);
        await noteAccount(adapter.id, acct, { identified: false });
      }
    }

    const listedIds = new Set(metas.map((m) => prefix + m.id));

    // 3b. Appearing in this account's listing is proof of ownership, and the
    //     only proof used. It is also what migrates an archive built before
    //     chats were attributed at all: whatever the listing names, the account
    //     claims. Anything it does not name keeps whatever it had — which for a
    //     legacy row is nothing, and an unattributed row is invisible to every
    //     account's sweep. That is the property that makes this safe to ship.
    if (metas.length) {
      const orphans = [];
      for (const id of listedIds) {
        if (index.has(id) && acctIndex.get(id) === undefined) orphans.push(id);
      }
      if (orphans.length) {
        const { claimed, more } = await adoptRecords(orphans, acct);
        for (const id of claimed) acctIndex.set(id, index.get(id) || 0);
        if (more) {
          await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0,
            msg: "Matching archived chats to this account…" });
        }
      }
    }

    // 3c. The listing covered the whole history, so anything THIS ACCOUNT holds
    //     and the listing does not name is gone upstream. Never destructive by
    //     itself — noteVanished() honours the user's policy, and the default is
    //     to ask.
    //
    //     Scoped to the account for a blunt reason: on a complete listing the
    //     host-wide archive index put every other account's chats up for
    //     deletion, and a first sync of a second account is always a complete
    //     listing. A stranger account is skipped outright — a listing from an
    //     account we have never seen before is evidence about nobody.
    const sweepAllowed = (sweeping || !trustWatermark) && !strangerAccount;
    if (sinceMs === 0 && complete && sweepAllowed && metas.length <= BG_PENDING_MAX) {
      const pendingIds = new Set(carried.map((p) => p.id));
      await sweepVanished(adapter, acctIndex, listedIds, scanStartedAt, pendingIds);
      await markSwept(adapter.id);
    }

    // 4. work = carried-over pending ∪ freshly listed, fresh meta winning,
    //    minus anything the archive already holds at that revision or newer.
    const byId = new Map();
    for (const p of carried) byId.set(p.id, { id: p.id, rev: p.rev, title: p.title, createdAt: p.createdAt, attempts: p.attempts || 0 });
    for (const m of metas) byId.set(m.id, { id: m.id, rev: m.updatedAt, title: m.title, createdAt: m.createdAt, attempts: 0 });
    const work = Array.from(byId.values()).filter((w) => {
      const archivedRevision = index.get(adapter.host + adapter.prefix + w.id);
      return archivedRevision === undefined || archivedRevision < w.rev;
    });

    if (!work.length) {
      await finishPlatform(adapter, checkpointKey,
        { ...checkpoint, safeWatermark: complete ? scanStartedAt : (checkpoint?.safeWatermark || 0),
          pendingCount: 0, passState: complete ? "clean" : "partial", runId: run.id,
          anchor, acctScoped: true },
        "up-to-date", { attempted: metas.length, total: metas.length, succeeded: 0, failed: 0 },
        "Everything is already backed up", await accountCount(acct));
      return { ok: true, result: "up-to-date", mode };
    }

    total = work.length;
    const overflow = work.length > BG_PENDING_MAX;

    // 5. Persist the watermark and the FULL outstanding set before fetching
    //    anything. This is what lets a first pass that is rate-limited on every
    //    single chat still leave a resumable checkpoint behind.
    await writeJob(checkpointKey, { platform: adapter.id, scanStartedAt, pending: work,
      tombstones: job ? job.tombstones : [] });
    const baseCoverage = await accountCount(acct);
    await saveCheckpoint(checkpointKey, {
      version: 5, platform: adapter.id, anchor, acctScoped: true,
      safeWatermark: complete && !overflow ? scanStartedAt : (checkpoint?.safeWatermark || 0),
      completedAt: Date.now(), lastResult: mode,
      archived: checkpoint?.archived || 0,
      coverage: baseCoverage, coverageKnown: true,
      pendingCount: work.length,
      passState: complete && !overflow ? "clean" : "partial",
      cooldownUntil: 0, runId: String(run.id).slice(0, 8)
    });

    // 6. fetch loop
    const concurrency = Math.max(1, tabs.open
      ? 1                                     // user is here, just not focused
      : policyFor(adapter.host).concurrency);
    const passStart = Date.now();
    let cursor = 0, archived = 0, fatal = null, circuitOpen = false, budgetHit = false;
    const importQueue = [];
    const settled = [], gone = [];
    let journalAt = Date.now();

    const flushQueue = async (force) => {
      if (importQueue.length) {
        const batch = importQueue.splice(0);
        const result = await importBatch(batch);
        archived += result.ok;
        succeeded += result.ok;
        failed += result.failed.length;
        for (const id of result.stored) settled.push(id.slice((adapter.host + adapter.prefix).length));
      }
      const due = force || Date.now() - journalAt > BG_JOURNAL_FLUSH_MS;
      if (settled.length || gone.length) {
        // Always update the in-memory set; only pay for a storage write when
        // the debounce is due.
        await dropFromJob(checkpointKey, settled.splice(0), gone.splice(0), due);
      } else if (due) {
        await flushJournal();
      }
      if (due) journalAt = Date.now();
    };

    const worker = async () => {
      while (!fatal && !circuitOpen && !budgetHit) {
        const slot = cursor++;
        if (slot >= total) return;
        if (Date.now() - passStart > BG_PASS_BUDGET_MS) { budgetHit = true; return; }
        const item = work[slot];
        try {
          const msgs = await adapter.detail(ctx, item.id);
          const record = {
            id: adapter.host + adapter.prefix + item.id,
            host: adapter.host, path: adapter.prefix + item.id,
            platform: adapter.label, title: item.title,
            createdAt: item.createdAt, updatedAt: item.rev,
            // Always the LISTED revision: stamping the fetch time would claim a
            // revision we never verified and mask the next real update.
            sourceUpdatedAt: item.rev,
            // The account whose listing produced this chat. Written at the same
            // moment as the chat itself, so a row is never in the archive
            // without knowing who it belongs to.
            acct, msgs
          };
          if (msgs.length < 2) { record.msgs = []; record.meta = true; }
          importQueue.push(record);
          if (importQueue.length >= BG_SYNC_BATCH) await flushQueue();
        } catch (error) {
          const kind = error && error.kind;
          const reason = String((error && error.message) || error);
          if (kind === "auth" || reason.includes("unauthorized")) { fatal = error; return; }
          // Deleted upstream: it leaves the journal either way (there is nothing
          // left to fetch), but whether the ARCHIVED copy goes is the user's
          // call, not the provider's.
          if (kind === "gone") {
            gone.push(item.id);
            await noteVanished(adapter.host + adapter.prefix + item.id,
              { platform: adapter.id, host: adapter.host, path: adapter.prefix + item.id }, "sync");
          }
          // Anything not archived stays in the journal, so an abandoned slot is
          // simply retried next pass — no cursor rewind needed.
          else if (error && error.circuitOpen) { circuitOpen = true; return; }
          else failed++;
        }
        attempted++;
        await writeProgress(adapter, run, {
          attempted, total, succeeded, failed,
          msg: `Capturing ${attempted} of ${total} new chat${total === 1 ? "" : "s"}…`
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    await flushQueue(true);
    if (fatal) throw fatal;

    const coverage = await accountCount(acct);
    const remaining = await readJob(checkpointKey);
    const left = remaining ? remaining.pending.length : 0;

    if (circuitOpen || budgetHit || left) {
      // Watermark and journal already persisted at step 5 — nothing is lost and
      // the next pass picks up exactly what is left.
      const until = hostEntry(adapter.host).cooldownUntil;
      await saveCheckpoint(checkpointKey, {
        ...(checkpoint || {}), version: 5, platform: adapter.id, anchor, acctScoped: true,
        safeWatermark: complete && !overflow ? scanStartedAt : (checkpoint?.safeWatermark || 0),
        completedAt: Date.now(),
        lastResult: circuitOpen ? "rate-limited" : budgetHit ? "budget" : "partial",
        archived, coverage, coverageKnown: true, pendingCount: left,
        passState: complete && !overflow ? "clean" : "partial",
        cooldownUntil: circuitOpen ? until : 0, runId: String(run.id).slice(0, 8)
      });
      progressPending = null;
      await chrome.storage.local.set({
        [BG_SYNC_PROG(adapter.id)]: {
          state: circuitOpen ? "paused" : "syncing", phase: circuitOpen ? "paused" : "syncing",
          runId: run.id, platform: adapter.id, done: attempted, attempted, total, succeeded, failed,
          msg: circuitOpen
            ? `${archived} saved · ${adapter.label} is rate-limiting, ${opts.canResume === false ? "check again shortly" : "resumes automatically"}`
            : `${archived} saved · ${left} left${opts.canResume === false ? " — check again to continue" : ", resumes automatically"}`,
          at: Date.now()
        }
      });
      return { ok: true, result: circuitOpen ? "rate-limited" : "partial", archived, left };
    }

    await finishPlatform(adapter, checkpointKey,
      { ...(checkpoint || {}), anchor, acctScoped: true,
        safeWatermark: complete && !overflow ? scanStartedAt : (checkpoint?.safeWatermark || 0),
        archived, pendingCount: 0,
        passState: complete && !overflow ? "clean" : "partial",
        cooldownUntil: 0, runId: String(run.id).slice(0, 8) },
      mode, { attempted, total, succeeded, failed },
      archived ? `${archived} new chat${archived === 1 ? "" : "s"} backed up`
               : "Everything is already backed up",
      coverage);
    return { ok: true, result: mode, archived };
  } catch (error) {
    return reportPlatformError(adapter, run, error, { attempted, total, succeeded, failed });
  }
}

/** One place that turns a thrown pass into something the UI can say out loud —
 *  shared by the session handshake and by each account's own pass. */
async function reportPlatformError(adapter, run, error, fields) {
  const { attempted = 0, total = 0, succeeded = 0, failed = 0 } = fields || {};
  const reason = String((error && error.message) || error);
  const signedOut = reason.includes("unauthorized") || reason.includes("not signed in") ||
    /unexpected provider response|invalid provider response/i.test(reason);
  const rateLimited = (error && error.kind) === "rate";
  // A reachable provider that answered in a shape we no longer parse. Saying
  // "couldn't reach" there sends the user to check their connection about
  // something only a new build can fix.
  const shapeChanged = (error && error.kind) === "shape";
  const message = reason.includes("unauthorized") || reason.includes("not signed in")
    ? `Not signed in`
    : /unexpected token\s*['"]?<?|valid json|json\.parse|unexpected provider response|invalid provider response/i.test(reason)
      ? `Needs an active session`
      : rateLimited
        ? `${adapter.label} is rate-limiting — resumes automatically`
        : shapeChanged
          ? `${adapter.label} changed its API — this needs a toolkit update`
          : `Couldn't reach ${adapter.label}`;
  progressPending = null;
  await chrome.storage.local.set({
    [BG_SYNC_PROG(adapter.id)]: {
      state: rateLimited ? "paused" : "error", phase: rateLimited ? "paused" : "error",
      runId: run.id, platform: adapter.id,
      done: attempted, attempted, total, succeeded, failed, msg: message, signedOut, at: Date.now()
    }
  });
  return { ok: false, error: reason, signedOut };
}

async function bgSyncAll(opts = {}) {
  // Records the reinstall so the page can offer the old backup. It no longer
  // gates the pass: a reinstalled browser starts re-archiving straight away and
  // a later restore merges into it.
  await ensureRecoveryState();
  if (bgSyncRunning) return { status: "already-running" };
  const run = await beginRun();
  if (!run) return { status: "already-running" };
  bgSyncRunning = true;
  // writeProgress is no longer the only heartbeat: a cooldown or paced listing
  // can outlast BG_RUN_STALE_MS and the run would declare itself interrupted.
  const pulse = setInterval(() => { beat(run, null); }, 20000);
  try {
    // With auto-sync off nothing will pick a partial pass back up, so the UI
    // must not promise that it will.
    const canResume = await autoSyncEnabled();
    opts = { ...opts, canResume };
    const results = [];
    // Sequential, not Promise.all: four platforms at once meant up to 32
    // concurrent authenticated requests on the user's own cookies.
    for (const adapter of BG_ADAPTERS) {
      results.push(await bgSyncPlatform(adapter, run, opts));
      await sleep(2000);
    }
    await flushProgress();
    await chrome.storage.local.set({ [BG_RUN]: { ...run, state: "done", finishedAt: Date.now() } });
    if (canResume && results.some((r) => r && (r.left || r.result === "deferred" || r.result === "partial"))) {
      await scheduleResume();
    }
    // New chats just landed; if the portable copy is due, write it now rather
    // than waiting out the clock.
    await maybeAutoBackup("sync");
    return { status: "done", results };
  } finally {
    clearInterval(pulse);
    bgSyncRunning = false;
  }
}

async function bgSyncStatus() {
  const recovery = await ensureRecoveryState();
  const run = await normalizeRun();
  const ledger = await readLedger();
  const keys = BG_ADAPTERS.map((a) => BG_SYNC_PROG(a.id))
    .concat(BG_ADAPTERS.map((a) => BG_SYNC_FLAG(a.id)), BG_ACTIVE_ACCOUNT);
  const store = await chrome.storage.local.get(keys);
  const activeAccounts = store[BG_ACTIVE_ACCOUNT] && typeof store[BG_ACTIVE_ACCOUNT] === "object"
    ? store[BG_ACTIVE_ACCOUNT] : {};
  const roster = await readAccounts();
  const platforms = {};
  for (const adapter of BG_ADAPTERS) {
    // Do not show another signed-in account's checkpoint as this account's
    // state. A platform becomes "ready to check" until this browser has
    // identified the currently active account during a background check.
    const activeKey = String(activeAccounts[adapter.id] || "");
    const checkpoint = activeKey ? ledger.checkpoints[activeKey] || null : null;
    const progress = store[BG_SYNC_PROG(adapter.id)] || null;
    const phase = progress?.phase || (checkpoint ? "up-to-date" : "needs-sync");
    // Every account this browser has synced on the platform, so a row can say
    // "two accounts" instead of silently describing whichever one went last.
    // Matched by tag because the roster stores the short form of the same hash.
    const seen = roster[adapter.id] && typeof roster[adapter.id] === "object" ? roster[adapter.id] : {};
    const byTag = new Map(Object.entries(ledger.checkpoints)
      .filter(([, c]) => c && c.platform === adapter.id)
      .map(([key, c]) => [tagOfKey(key), c]));
    const accounts = Object.entries(seen)
      .sort((a, b) => (Number(a[1].ordinal) || 0) - (Number(b[1].ordinal) || 0))
      .map(([acct, meta]) => ({
        acct,
        ordinal: Number(meta.ordinal) || 0,
        label: String(meta.label || ""),
        plan: String(meta.plan || ""),
        active: acct === tagOfKey(activeKey),
        archived: Number(byTag.get(acct)?.coverage) || 0,
        completedAt: Number(byTag.get(acct)?.completedAt) || 0,
        synced: byTag.has(acct)
      }));
    platforms[adapter.id] = {
      label: adapter.label,
      progress,
      flag: store[BG_SYNC_FLAG(adapter.id)] || null,
      checkpoint,
      phase,
      accounts,
      archivedAll: accounts.reduce((sum, a) => sum + a.archived, 0)
    };
  }
  const deletions = await deletionsList();
  return {
    platforms,
    running: !!(run && run.state === "running"),
    recovery,
    deletions: { count: deletions.items.length, policy: deletions.policy },
    autoBackup: await autoBackupState(),
    summary: summarize(platforms, !!(run && run.state === "running"), recovery, run && run.id),
    run: run ? { state: run.state, startedAt: run.startedAt, interruptedAt: run.interruptedAt || 0 } : null
  };
}

/**
 * One verdict for the whole archive, computed here so the popup and the Recall
 * page can never disagree.
 *
 * Signed-out providers are deliberately excluded. Most people use two or three
 * of the four; requiring all four to report "up to date" meant the reassuring
 * message a fully-synced archive has earned could never appear.
 */
function summarize(platforms, running, recovery, runId) {
  const entries = Object.values(platforms);
  if (running || entries.some((p) => p.progress && p.progress.state === "syncing")) {
    const live = entries.filter((p) => p.progress && p.progress.state === "syncing");
    // Only this run counts. finishPlatform leaves a "done" record behind
    // indefinitely, and summing those inflated the denominator so the
    // percentage never matched the message.
    const current = runId || entries.reduce((newest, p) => {
      const pr = p.progress;
      return pr && pr.runId && (!newest || (Number(pr.at) || 0) > newest.at)
        ? { id: pr.runId, at: Number(pr.at) || 0 } : newest;
    }, null)?.id;
    let done = 0, total = 0, succeeded = 0;
    for (const p of entries) {
      const pr = p.progress;
      if (!pr || !Number.isFinite(Number(pr.total)) || Number(pr.total) <= 0) continue;
      if (pr.state !== "syncing" && pr.state !== "done") continue;
      if (current && pr.runId && pr.runId !== current) continue;
      done += Math.min(Number(pr.done) || 0, Number(pr.total));
      total += Number(pr.total);
      succeeded += Number(pr.succeeded) || 0;
    }
    const message = live.length > 1
      ? `Checking ${live.length} platforms…`
      : (live[0] && live[0].progress.msg) || "Checking for new chats…";
    return { state: "syncing", message, done, total, succeeded, syncing: live.length, checkedAt: 0, connected: 0 };
  }

  // A rate limit is not user-actionable and must not paint the error state.
  const cooling = entries.filter((p) => p.progress && p.progress.state === "paused");
  if (cooling.length) {
    return { state: "paused", message: cooling[0].progress.msg || "Paused — resumes automatically",
      checkedAt: 0, connected: entries.filter((p) => !(p.progress && p.progress.signedOut)).length };
  }

  /* A platform this browser has never checked is UNKNOWN, not connected —
     there is no evidence yet that the user has an account there at all.
     Counting one as a provider still "left to check" is what turned adding a
     fifth adapter into every existing user being told, on update, that the
     finished archive they had was suddenly incomplete. The window is short by
     construction: one sync pass gives every platform a progress record either
     way — archived, or signed out — and it rejoins the count on its own
     evidence rather than on our having shipped it. */
  const known = entries.filter((p) => p.progress || p.checkpoint);
  const connected = known.filter((p) => !(p.progress && p.progress.signedOut));
  const failing = connected.filter((p) => p.progress && p.progress.state === "error");
  if (failing.length) {
    return {
      state: "error",
      message: `${failing[0].label}: ${failing[0].progress.msg}`,
      checkedAt: 0,
      connected: connected.length
    };
  }
  const paused = connected.filter((p) => p.progress && p.progress.state === "interrupted");
  if (paused.length) {
    return { state: "pending", message: "Paused — pick up where it stopped", checkedAt: 0, connected: connected.length };
  }

  const current = connected.filter((p) => p.phase === "up-to-date" && p.checkpoint);
  if (current.length && current.length === connected.length) {
    const oldest = current.reduce((min, p) => Math.min(min, p.checkpoint.completedAt || 0), Infinity);
    const archived = current.reduce((sum, p) => sum + (p.checkpoint.coverage || 0), 0);
    return { state: "current", message: "Everything is already backed up", checkedAt: oldest, archived, connected: connected.length };
  }
  if (current.length) {
    return { state: "pending", message: `${connected.length - current.length} provider${connected.length - current.length === 1 ? "" : "s"} left to check`, checkedAt: 0, connected: connected.length };
  }
  return { state: "never", message: "Check your history for the first time", checkedAt: 0, connected: connected.length };
}

async function backupState() {
  const ledger = await readLedger();
  const { data } = await getDurable([BG_BACKUP_MARKER, BG_SYNC_PROFILE]);
  return {
    ledger,
    marker: data[BG_BACKUP_MARKER] || null,
    profile: cleanProfile(data[BG_SYNC_PROFILE])
  };
}

async function wipeRecall() {
  await wipe();
  profileSaltPromise = null;
  journalCache = null;
  const localKeys = [BG_RUN, BG_RECOVERY, BG_ACTIVE_ACCOUNT]
    .concat(BG_ADAPTERS.map((adapter) => BG_SYNC_PROG(adapter.id)))
    .concat(BG_ADAPTERS.map((adapter) => BG_SYNC_FLAG(adapter.id)));
  // "Delete everything" has to mean the backup key material too, or a wiped
  // browser would keep writing readable archives of whatever comes next.
  await chrome.storage.local.remove(localKeys.concat([BG_SYNC_WORK, BG_HOST_COOLDOWN, BG_PAGE_SCHEME,
    BG_DELETIONS, BG_SWEEP_STATE, BG_AUTOBACKUP, BG_AUTOBACKUP_STATE, BG_RESTORE_GUARD,
    // The account roster and every per-account usage tally are part of
    // "delete everything" — they describe who was signed in, which is exactly
    // what a wipe is meant to remove.
    BG_ACCOUNTS]));
  await clearUsage();
  await removeDurable([BG_SYNC_LEDGER, BG_BACKUP_MARKER, BG_SYNC_PROFILE]);
  await paintDeletionBadge(0);
  try { await chrome.alarms.clear(BG_AUTOBACKUP_ALARM); } catch { /* alarms unavailable */ }
  return { ok: true };
}

/* ===================== automatic encrypted backup =====================
 *
 * The manual backup was the only portable copy, and it existed only if the user
 * remembered to make one before uninstalling — which is the one moment nobody
 * remembers. This writes the same encrypted envelope on a schedule.
 *
 * Set-up is the only time the passphrase exists: the page derives a key from
 * it, wraps a random file key under that, and hands the worker the wrapped blob
 * plus the raw file key. The worker can then seal a backup at any hour with no
 * passphrase anywhere. The FILE still opens only with the passphrase, which is
 * never stored, never synced, and not recoverable.
 */

const BG_AUTOBACKUP_ALARM = "lct-auto-backup";
const BG_AUTOBACKUP_MIN_HOURS = 1;
const BG_AUTOBACKUP_MAX_HOURS = 24 * 30;
// base64 inflates by a third and the whole envelope is held in memory as a data
// URL; past this the worker would be gambling with an OOM every night.
const BG_AUTOBACKUP_MAX_BYTES = 96 * 1024 * 1024;
const BG_AUTOBACKUP_FOLDER = "Long Chat Toolkit";

async function readAutoBackup() {
  try {
    const { [BG_AUTOBACKUP]: raw } = await chrome.storage.local.get(BG_AUTOBACKUP);
    if (!raw || raw.enabled !== true) return null;
    if (!self.LCTBackupCrypto || !self.LCTBackupCrypto.validKeyring(raw.keyring)) return null;
    return {
      enabled: true,
      keyring: raw.keyring,
      everyHours: Math.min(BG_AUTOBACKUP_MAX_HOURS, Math.max(BG_AUTOBACKUP_MIN_HOURS,
        Math.floor(Number(raw.everyHours) || 24))),
      filename: String(raw.filename || "long-chat-toolkit-auto.lctbackup").slice(0, 120)
    };
  } catch { return null; }
}

async function readAutoBackupRun() {
  try {
    const { [BG_AUTOBACKUP_STATE]: raw } = await chrome.storage.local.get(BG_AUTOBACKUP_STATE);
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

/** Everything the UI is allowed to know. The keyring never crosses this line. */
async function autoBackupState() {
  const config = await readAutoBackup();
  const run = await readAutoBackupRun();
  return {
    enabled: !!config,
    everyHours: config ? config.everyHours : 24,
    filename: config ? config.filename : "",
    folder: BG_AUTOBACKUP_FOLDER,
    lastAt: Number(run.lastAt) || 0,
    lastChats: Math.max(0, Number(run.lastChats) || 0),
    lastError: String(run.lastError || "").slice(0, 200),
    nextAt: config && run.lastAt ? Number(run.lastAt) + config.everyHours * 3600000 : 0
  };
}

async function autoBackupConfigure(config) {
  const crypt = self.LCTBackupCrypto;
  if (!crypt || !crypt.validKeyring(config && config.keyring)) {
    return { err: "That backup key could not be verified" };
  }
  const everyHours = Math.min(BG_AUTOBACKUP_MAX_HOURS, Math.max(BG_AUTOBACKUP_MIN_HOURS,
    Math.floor(Number(config.everyHours) || 24)));
  await chrome.storage.local.set({
    [BG_AUTOBACKUP]: { version: 1, enabled: true, keyring: config.keyring, everyHours,
      filename: "long-chat-toolkit-auto.lctbackup", setUpAt: Date.now() }
  });
  await chrome.storage.local.set({ [BG_AUTOBACKUP_STATE]: { lastAt: 0, lastChats: 0, lastError: "" } });
  await ensureAutoBackupAlarm(true);
  const first = await runAutoBackup("setup");
  return { ok: true, state: await autoBackupState(), first };
}

async function autoBackupDisable() {
  await chrome.storage.local.remove([BG_AUTOBACKUP, BG_AUTOBACKUP_STATE]);
  try { await chrome.alarms.clear(BG_AUTOBACKUP_ALARM); } catch { /* alarms unavailable */ }
  return { ok: true, state: await autoBackupState() };
}

/** Every archived chat, straight out of IndexedDB. */
async function archiveSnapshot() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = tx(d, "readonly").openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
  });
}

let autoBackupRunning = false;

async function runAutoBackup(reason) {
  const config = await readAutoBackup();
  if (!config) return { status: "disabled" };
  if (autoBackupRunning) return { status: "already-running" };
  // A snapshot taken mid-pass would be a torn read of a moving archive, and the
  // next scheduled one is minutes away.
  if (bgSyncRunning && reason !== "manual") return { status: "busy" };
  autoBackupRunning = true;
  const note = async (fields) => {
    const run = await readAutoBackupRun();
    try { await chrome.storage.local.set({ [BG_AUTOBACKUP_STATE]: { ...run, ...fields } }); }
    catch { /* dead context */ }
  };
  try {
    const [chats, durable] = await Promise.all([archiveSnapshot(), backupState()]);
    if (!chats.length) {
      await note({ lastError: "", lastCheckedAt: Date.now() });
      return { status: "empty" };
    }
    const sealed = await self.LCTBackupCrypto.seal({
      format: self.LCTBackupCrypto.PAYLOAD_FORMAT,
      version: 1,
      createdAt: Date.now(),
      chats,
      ledger: durable.ledger || { version: 2, checkpoints: {} },
      profile: durable.profile || null
    }, { keyring: config.keyring });

    if (sealed.json.length > BG_AUTOBACKUP_MAX_BYTES) {
      await note({ lastError: "This archive is too large for automatic backup — export it from the Recall page.", lastCheckedAt: Date.now() });
      return { status: "too-large" };
    }
    // MV3 service workers have no URL.createObjectURL, so the envelope travels
    // to the downloads API as a data URL.
    const url = "data:application/octet-stream;base64," +
      self.LCTBackupCrypto.bytesToBase64(new TextEncoder().encode(sealed.json));
    await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url,
        filename: `${BG_AUTOBACKUP_FOLDER}/${config.filename}`,
        conflictAction: "overwrite",
        saveAs: false
      }, (id) => {
        const error = chrome.runtime.lastError;
        if (error || id === undefined) reject(new Error(error ? error.message : "the download was refused"));
        else resolve(id);
      });
    });
    await markBackup({ chats: chats.length, filename: config.filename, automatic: true });
    await note({ lastAt: Date.now(), lastChats: chats.length, lastError: "", lastCheckedAt: Date.now() });
    return { status: "ok", chats: chats.length };
  } catch (error) {
    await note({ lastError: String((error && error.message) || error).slice(0, 200), lastCheckedAt: Date.now() });
    return { status: "error", error: String((error && error.message) || error) };
  } finally {
    autoBackupRunning = false;
  }
}

async function maybeAutoBackup(reason) {
  const config = await readAutoBackup();
  if (!config) return { status: "disabled" };
  const run = await readAutoBackupRun();
  const due = Date.now() - (Number(run.lastAt) || 0) >= config.everyHours * 3600000;
  return due ? runAutoBackup(reason) : { status: "not-due" };
}

async function ensureAutoBackupAlarm(force) {
  const config = await readAutoBackup();
  try {
    if (!config) { await chrome.alarms.clear(BG_AUTOBACKUP_ALARM); return; }
    const existing = await chrome.alarms.get(BG_AUTOBACKUP_ALARM);
    if (existing && !force) return;
    // Deliberately more frequent than everyHours: the alarm only asks "is it
    // due yet", and a browser that is closed at the exact hour would otherwise
    // skip a whole cycle.
    const period = Math.max(30, Math.min(config.everyHours * 60, 6 * 60));
    await chrome.alarms.create(BG_AUTOBACKUP_ALARM, { delayInMinutes: force ? period : 5, periodInMinutes: period });
  } catch { /* alarms unavailable */ }
}

/* ---------- restore brute-force guard ----------
 * PBKDF2 at a million rounds already makes offline guessing expensive. This
 * covers the other direction: someone at an unlocked machine feeding the
 * restore box a wordlist. Kept in the worker so reloading the page — or opening
 * a second one — does not reset the count. */

const BG_RESTORE_FREE_TRIES = 3;
const BG_RESTORE_MAX_WAIT_MS = 60 * 60 * 1000;

async function restoreGuard() {
  try {
    const { [BG_RESTORE_GUARD]: raw } = await chrome.storage.local.get(BG_RESTORE_GUARD);
    const fails = Math.max(0, Math.floor(Number(raw && raw.fails) || 0));
    const until = Math.max(0, Number(raw && raw.until) || 0);
    return { fails, until, allowed: Date.now() >= until, waitMs: Math.max(0, until - Date.now()) };
  } catch { return { fails: 0, until: 0, allowed: true, waitMs: 0 }; }
}

async function restoreGuardFail() {
  const current = await restoreGuard();
  const fails = current.fails + 1;
  const over = fails - BG_RESTORE_FREE_TRIES;
  const wait = over <= 0 ? 0 : Math.min(BG_RESTORE_MAX_WAIT_MS, 30000 * Math.pow(2, over - 1));
  const until = wait ? Date.now() + wait : 0;
  try { await chrome.storage.local.set({ [BG_RESTORE_GUARD]: { fails, until } }); } catch { /* full */ }
  return { fails, until, allowed: !wait, waitMs: wait };
}

async function restoreGuardReset() {
  try { await chrome.storage.local.remove(BG_RESTORE_GUARD); } catch { /* fine */ }
  return { fails: 0, until: 0, allowed: true, waitMs: 0 };
}

/* ---------- automatic background sync ----------
 * bgSyncAll() was always safe to call repeatedly: it refuses to overlap, it
 * only fetches the delta past each account's checkpoint, and an interrupted
 * pass keeps its previous watermark. So "run it on a schedule" needs no new
 * sync logic — only a clock, which in MV3 means chrome.alarms (a terminated
 * worker cannot hold a timer).
 *
 * The first tick is deliberately late: waking a browser with four
 * authenticated history checks the instant it starts is rude, and it would
 * race a user who is still signing in.
 */
const BG_AUTO_ALARM = "lct-auto-sync";
const BG_RESUME_ALARM = "lct-auto-sync-resume";
const BG_AUTO_STATE = "lct-recall-auto-sync-v1";
const BG_AUTO_FIRST_DELAY_MIN = 10;
const BG_AUTO_PERIOD_MIN = 180;      // every 3 hours

async function autoSyncEnabled() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    return !settings || settings.autoSync !== false;   // on unless turned off
  } catch { return false; }
}

async function ensureAutoSyncAlarm() {
  try {
    const existing = await chrome.alarms.get(BG_AUTO_ALARM);
    // Re-creating would reset the schedule on every worker wake, so a browser
    // that restarts often would never actually reach a tick.
    if (existing) return;
    // Reloading the extension clears alarms. Carrying the last tick forward
    // stops a reload from buying another full interval — or, worse, from
    // starting a fresh pass every time the worker respawns.
    let delay = BG_AUTO_FIRST_DELAY_MIN;
    try {
      const { [BG_AUTO_STATE]: state } = await chrome.storage.local.get(BG_AUTO_STATE);
      const since = state && state.at ? (Date.now() - state.at) / 60000 : Infinity;
      if (Number.isFinite(since)) {
        delay = Math.min(BG_AUTO_PERIOD_MIN, Math.max(BG_AUTO_FIRST_DELAY_MIN, BG_AUTO_PERIOD_MIN - since));
      }
    } catch { /* no prior tick */ }
    await chrome.alarms.create(BG_AUTO_ALARM, {
      delayInMinutes: delay,
      periodInMinutes: BG_AUTO_PERIOD_MIN
    });
  } catch { /* alarms unavailable */ }
}

// A pass that ended with work outstanding comes back promptly rather than
// waiting out the full period. 1 minute is the platform floor.
async function scheduleResume() {
  try { await chrome.alarms.create(BG_RESUME_ALARM, { delayInMinutes: 1 }); }
  catch { /* alarms unavailable */ }
}

/* A tab just opened one of the providers. That is a better sync trigger than
 * any clock — the session is live, the cookies are warm, and it is the moment
 * the user expects "everything I've ever written" to already be searchable.
 * Throttled here rather than in the page so ten tabs cost one pass. */
const BG_VISIT_STATE = "lct-recall-visit-sync-v1";
const BG_VISIT_MIN_MS = 20 * 60 * 1000;

async function visitSync(platform) {
  // Only the providers the sync engine can actually read. A visit to a host we
  // have no history endpoint for is not a reason to go poll the other four.
  if (!BG_PLATFORM_IDS.has(platform)) return { status: "unsupported" };
  if (!(await autoSyncEnabled())) return { status: "disabled" };
  let last = 0;
  try {
    const { [BG_VISIT_STATE]: state } = await chrome.storage.local.get(BG_VISIT_STATE);
    last = (state && state.at) || 0;
  } catch { /* no prior visit */ }
  if (Date.now() - last < BG_VISIT_MIN_MS) return { status: "throttled", last };
  try { await chrome.storage.local.set({ [BG_VISIT_STATE]: { at: Date.now() } }); }
  catch { /* dead context */ }
  return autoSyncTick();
}

async function autoSyncTick() {
  if (!(await autoSyncEnabled())) return { status: "disabled" };
  const started = Date.now();
  const result = await bgSyncAll({ reason: "auto" });   // owns recovery + overlap guards
  try {
    await chrome.storage.local.set({
      [BG_AUTO_STATE]: { at: started, status: result && result.status }
    });
  } catch { /* dead context */ }
  return result;
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name === BG_AUTO_ALARM || alarm.name === BG_RESUME_ALARM) autoSyncTick();
    else if (alarm.name === BG_AUTOBACKUP_ALARM) maybeAutoBackup("alarm");
  });
  const wake = () => {
    ensureAutoSyncAlarm();
    ensureAutoBackupAlarm();
    // A reinstall wipes storage.local, so the badge has to be repainted from
    // whatever survived rather than assumed to be still on screen.
    readDeletions().then((state) => paintDeletionBadge(Object.keys(state.items).length));
  };
  chrome.runtime.onInstalled.addListener(wake);
  chrome.runtime.onStartup.addListener(wake);
  wake();   // the worker is respawned constantly; keep it alive
} catch (_) { /* alarms API unavailable */ }

// Clicking the "a chat was deleted" toast has to land on the decision itself,
// not on a page where the user has to go hunting for it.
try {
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== "lct-deletions") return;
    chrome.notifications.clear(id);
    chrome.tabs.create({ url: chrome.runtime.getURL("recall.html#deletions") });
  });
} catch (_) { /* notifications API unavailable */ }

/* ---------- entitlement gate ---------- */

/**
 * The paywall. Every gated handler goes through here and nowhere else.
 *
 * Deliberately NOT a cached boolean: a cached `pro` flag in storage is exactly
 * the thing a hand-edited record forges. Each call re-verifies the LCT2
 * signature (cheap — one ECDSA verify, no network).
 *
 * Trial is time-boxed and pinned to first-seen, checked here rather than in the
 * page so wiping local storage does not mint a second one (see trialState).
 */
// Frozen: nobody can delete an entry from the paywall map at runtime to
// route a gated handler around the gate.
const PAID = Object.freeze({
  "recall-search": "archive.search",
  "recall-backup-state": "archive.backup",
  "recall-backup-mark": "archive.backup",
  "recall-autobackup-state": "archive.backup",
  "recall-autobackup-enable": "archive.backup",
  "recall-autobackup-disable": "archive.backup",
  "recall-autobackup-run": "archive.backup",
  "recall-snapshot": "archive.backup",
  "recall-restore-ledger": "archive.restore",
  "recall-restore-guard": "archive.restore",
  "recall-restore-guard-fail": "archive.restore",
  "recall-restore-guard-reset": "archive.restore"
});

const TRIAL_MS = 7 * 864e5;
const TRIAL_KEY = "lct-trial-v2";

/**
 * Trial clock, worker-owned and sync-backed. storage.sync survives a local
 * wipe and a reinstall on the same profile, so "clear data, trial again" costs
 * a whole new browser profile instead of one click.
 */
async function trialState() {
  let rec = null;
  try {
    const got = await chrome.storage.sync.get(TRIAL_KEY);
    rec = got && got[TRIAL_KEY];
  } catch { /* sync unavailable */ }
  if (!rec) {
    try {
      const got = await chrome.storage.local.get(TRIAL_KEY);
      rec = got && got[TRIAL_KEY];
    } catch { /* dead context */ }
  }
  const startedAt = Number(rec && rec.startedAt) || 0;
  if (!startedAt) return { started: false, active: false, spent: false, until: 0 };
  const until = startedAt + TRIAL_MS;
  return { started: true, active: Date.now() < until, spent: Date.now() >= until, until };
}

async function startTrial() {
  const cur = await trialState();
  if (cur.started) return cur;                       // one per profile, ever
  const rec = { startedAt: Date.now(), v: 2 };
  // Both stores: sync is the durable record, local is the offline fallback.
  try { await chrome.storage.sync.set({ [TRIAL_KEY]: rec }); } catch { /* quota/offline */ }
  try { await chrome.storage.local.set({ [TRIAL_KEY]: rec }); } catch { /* dead context */ }
  return trialState();
}

/** Cached only within a single wake of the worker, never persisted. */
async function entitlementVerdict() {
  let license = null;
  try {
    const got = await chrome.storage.local.get("license");
    license = got && got.license;
  } catch { /* dead context */ }

  const trial = await trialState();
  if (!license || !license.key) {
    return { entitled: trial.active, via: trial.active ? "trial" : "none", trial, features: trial.active ? (self.LCTEntitlement?.FEATURES || []) : [] };
  }

  let deviceId = "";
  try { deviceId = await self.LCTDodo.ensureDeviceId(); } catch { /* pre-activation */ }

  const res = await self.LCTEntitlement.evaluate(license, deviceId);
  if (res.entitled) return { ...res, via: res.kind, trial };
  // A dead licence still leaves an unspent trial usable.
  if (trial.active) return { entitled: true, via: "trial", trial, features: self.LCTEntitlement.FEATURES.slice(), reason: res.reason };
  return { ...res, via: "none", trial };
}

async function requireEntitlement(feature) {
  const v = await entitlementVerdict();
  if (!v.entitled) return { ok: false, reason: v.reason || "locked" };
  if (v.via !== "trial" && Array.isArray(v.features) && !v.features.includes(feature)) {
    return { ok: false, reason: "feature" };
  }
  return { ok: true, via: v.via, stale: !!v.stale };
}

/* ---------- message router ---------- */

// Keyboard shortcuts
try {
  chrome.commands.onCommand.addListener((name) => {
    chrome.storage.local.set({ "lct-cmd": { name, at: Date.now() } });
  });
} catch (_) { /* commands API unavailable */ }

/* ---------- rapid-query detection ---------- */
// A normal popup opens once; an automated bypass tool hammers entitlement-state
// dozens of times per second. Flagging this does not block the user — it rate-
// limits the response so scripted brute-force cannot converge on a working
// payload in practical time.
const _queryLog = [];      // circular buffer of timestamps
const _QUERY_WINDOW = 60000;
const _QUERY_MAX = 50;

function _queryThrottle() {
  const now = Date.now();
  _queryLog.push(now);
  // Evict entries outside the window
  while (_queryLog.length > 0 && _queryLog[0] < now - _QUERY_WINDOW) _queryLog.shift();
  return _queryLog.length > _QUERY_MAX;
}

// ---------- sender validation ----------
// Content scripts and extension pages originate from a chrome-extension:// URL.
// An externally_connectable page or injected context would carry the web page's
// URL. The id check (below) already blocks other extensions; the URL guard
// catches any message arriving from a web page context.
function _senderAllowed(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  // Service worker self-messages have no url/tab.
  if (!sender.url && !sender.tab) return true;
  const url = sender.url || (sender.tab && sender.tab.url) || "";
  // Accept: chrome-extension://<own-id>/*, moz-extension://<uuid>/*
  if (/^(chrome|moz)-extension:\/\//i.test(url)) return true;
  // Accept: AI sites the content script runs on (matches manifest host_permissions)
  if (/^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|www\.perplexity\.ai|chat\.deepseek\.com|grok\.com)/i.test(url)) return true;
  // Accept: localhost and 127.0.0.1 (dev/test, http or https — matches manifest)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) return true;
  return false;
}

// ---------- closure-captured gate ----------
// The message handler captures this reference at definition time. Reassigning
// the global `requireEntitlement` from DevTools changes nothing — the router
// calls through _gate, which is unreachable from outside this scope.
const _gate = requireEntitlement;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!_senderAllowed(sender)) return false;

  const run = async () => {
    // Rate-limit entitlement probes
    if ((msg && msg.type) === "entitlement-state" && _queryThrottle()) {
      await new Promise((r) => setTimeout(r, 2000)); // throttle, not block
    }

    const feature = PAID[msg && msg.type];
    if (feature) {
      // Use the closure-captured _gate, not the global requireEntitlement.
      const gate = await _gate(feature);
      if (!gate.ok) return { err: "locked", feature, reason: gate.reason };
    }

    switch (msg && msg.type) {
      case "entitlement-state": return entitlementVerdict();
      case "entitlement-refresh": {
        const got = await chrome.storage.local.get("license");
        const lic = got && got.license;
        if (!lic || !lic.key) return { ok: false, branch: "none" };
        const deviceId = await self.LCTDodo.ensureDeviceId();
        return self.LCTEntitlement.refresh(lic, deviceId, { force: !!(msg && msg.force) });
      }
      case "trial-state":  return trialState();
      case "trial-start":  return startTrial();
      case "recall-upsert":      return upsert(msg.chat);
      case "recall-import":      return importBatch(msg.chats);
      case "recall-search":      return search(msg.q, msg.long);
      case "recall-check":       return check(msg.ids);
      case "recall-stats":       return stats();
      // Export reads the archive HERE, behind the gate — not from the page's
      // own IndexedDB handle, which no paywall could sit in front of.
      case "recall-snapshot":    return { chats: await archiveSnapshot(), durable: await backupState() };
      case "recall-wipe":        return wipeRecall();
      case "recall-bg-sync":     return bgSyncAll({ reason: "manual" });
      case "recall-auto-tick":   return autoSyncTick();
      case "recall-visit-sync":  return visitSync(msg.platform);
      case "chat-index":         return chatIndex(msg.host, msg.path, { force: msg.force });
      case "chat-message":       return chatMessage(msg.host, msg.path, msg.id);
      // "the page found this chat gone", not "delete this". Nothing outside
      // resolveDeletions() gets to remove archived text on request.
      case "chat-drop":          return noteVanished(msg.id, {}, "opened");
      // The branch walk decides whether the map's positions line up with the
      // page at all, and the worker's network cannot be routed from a test —
      // so the parse is reachable directly, same as the pacing selftest below.
      case "chat-index-selftest": return {
        msgs: chatgptMsgs(msg.conv || {}),
        entries: indexFromMsgs(chatgptMsgs(msg.conv || {}))
      };
      case "account-for":        return accountForHost(String(msg.host || ""), String(msg.hint || "").slice(0, 120));
      case "account-roster":     return { accounts: await readAccounts() };
      case "recall-sync-status": return bgSyncStatus();
      case "recall-backup-state": return backupState();
      case "recall-backup-mark": return markBackup(msg.meta);
      case "recall-restore-ledger": return restoreLedger(msg.ledger, msg.meta, msg.profile);
      case "recall-recovery-skip": return skipRecovery();
      case "recall-deletions":        return deletionsList();
      case "recall-deletions-resolve": return resolveDeletions(msg.ids, msg.action);
      case "recall-autobackup-state": return autoBackupState();
      case "recall-autobackup-enable": return autoBackupConfigure(msg.config);
      case "recall-autobackup-disable": return autoBackupDisable();
      case "recall-autobackup-run":   return runAutoBackup("manual");
      // Counting failed restore attempts in the page would reset on reload.
      case "recall-restore-guard":       return restoreGuard();
      case "recall-restore-guard-fail":  return restoreGuardFail();
      case "recall-restore-guard-reset": return restoreGuardReset();
      // The sweep's safety ceiling is the difference between "the user deleted
      // one chat" and "a signed-out listing wiped the archive". It only ever
      // runs behind a live provider walk, so it is reachable here directly.
      case "recall-sweep-selftest": {
        const index = new Map((msg.index || []).map((entry) => [entry.id, entry.rev]));
        return sweepVanished({ id: "selftest", host: "selftest", prefix: "/" },
          index, new Set(msg.listed || []), Number(msg.scanStartedAt) || Date.now(),
          new Set(msg.pending || []));
      }
      // Pacing logic is pure but unreachable from a test page otherwise, and a
      // silent regression here is what lets the sync 429 the provider again.
      case "recall-sync-selftest": return {
        retryAfter: (msg.values || []).map(parseRetryAfter),
        backoff: backoffDelay(Number(msg.attempt) || 0, Number(msg.retryAfterMs) || 0)
      };
      // Drives pageThrough over a scripted server so the safe-degradation exits
      // (offset ignored, limit ignored, short page) are assertable.
      case "recall-page-selftest": {
        // `pages` is keyed by the query fragment a scheme produces, so a test
        // can model a server that honours one spelling and ignores the rest.
        const pages = msg.pages || {};
        const calls = [];
        const out = await pageThrough({ host: "selftest" }, {
          pageSize: Number(msg.pageSize) || 2, sinceMs: Number(msg.sinceMs) || 0,
          delayMs: 0, noCache: true, progress: () => {},
          fetchPage: (page) => {
            calls.push(page);
            // "<param>=*" models a server that accepts the param but ignores
            // it, always returning the same page — distinct from one that has
            // genuinely run out of results.
            const hit = pages[page] !== undefined ? pages[page] : pages[page.split("=")[0] + "=*"];
            if (hit === "error") throw new BgError("net", "http 400");
            return hit || [];
          },
          toMeta: (it) => ({ id: it.id, title: "", createdAt: 0, updatedAt: it.updatedAt })
        });
        return { ids: out.metas.map((m) => m.id), complete: out.complete, paged: out.paged, calls };
      }
      default: return { err: "unknown" };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ err: String(e && e.message || e) }));
  return true; // async response
});
