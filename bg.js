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
const DB_VERSION = 2;
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
  return {
    // mv=1 promises BOTH: every message carries its id, and nothing was dropped
    // by the MAX_MSGS window. Anything less cannot be an index source.
    // (`t` is still clamped to MAX_MSG_CHARS — norm() in minimap.js saturates at
    // 900 chars, so an archive-served tick is pixel-identical to a live one.)
    mv: msgs.length && src.length <= MAX_MSGS && msgs.every((m) => m.i) ? 1 : 0,
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
  if (isMeta || shrinks) {
    const existing = await reqP(tx(d, "readonly").get(id));
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
  const clamped = clampChat(chat);
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
      const clamped = clampChat(chat);
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
  "grok.com":          { concurrency: 3, minIntervalMs: 400, listDelayMs: 500 }
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
const BG_PLATFORM_IDS = new Set(["chatgpt", "claude", "deepseek", "grok"]);
const BG_SYNC_FLAG = (p) => "recall-sync-" + p;     // { lastFull: ms } — chrome.storage.local
const BG_SYNC_PROG = (p) => "recall-sync-progress:" + p;
const BG_SYNC_LEDGER = "lct-recall-sync-ledger-v2";
const BG_SYNC_PROFILE = "lct-recall-sync-profile-v1";
const BG_BACKUP_MARKER = "lct-recall-backup-marker-v1";
const BG_RECOVERY = "lct-recall-recovery-v1";
const BG_INSTALL = "lct-recall-install-v1";
const BG_RUN = "lct-recall-sync-run-v1";
const BG_ACTIVE_ACCOUNT = "lct-recall-active-account-v1";
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
    version: 4,
    platform,
    safeWatermark,
    completedAt,
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
    coverageKnown: value.coverageKnown === true || Number(value.coverage) > 0
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
  // dropped the whole ledger. 8 covers every platform across two accounts.
  const ranked = Object.entries(value.checkpoints)
    .sort((a, b) => (Number(b[1] && b[1].completedAt) || 0) - (Number(a[1] && a[1].completedAt) || 0))
    .slice(0, 8);
  for (const [key, raw] of ranked) {
    const checkpoint = cleanCheckpoint(raw);
    if (checkpoint) checkpoints[String(key).slice(0, 200)] = checkpoint;
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

async function accountCheckpointKey(adapter, ctx) {
  // Never persist raw account identifiers. The provider identity is salted and
  // hashed so a checkpoint cannot leak the user's account value.
  //
  // The identity MUST be stable across sessions. Earlier builds fell back to
  // the raw cookie header when a provider exposed no account id — session
  // cookies rotate, so every rotation minted a new checkpoint key and the whole
  // history was swept again. Providers without an account id now share one
  // per-browser key; a mismatched account is caught by the coverage diff, which
  // compares against the archive itself rather than a timestamp.
  const identity = String(ctx && ctx.account || "").trim() || "device";
  return adapter.id + ":" + await digest((await profileSalt()) + "|" + adapter.id + "|" + identity);
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
    if (r.status === 401 || r.status === 403) throw new BgError("auth", "unauthorized");
    if (r.status === 404 || r.status === 410) throw new BgError("gone", "http " + r.status);
    if (!r.ok) {
      if (r.status >= 500 && attempt < BG_FETCH_ATTEMPTS - 1) { await sleep(backoffDelay(attempt, 0)); continue; }
      throw new BgError("net", "http " + r.status);
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
      const meta = toMeta(it);
      if (!meta || !meta.id || seen.has(meta.id)) continue;
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
  return { metas, complete, paged };
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
  return best || { metas: [], complete: false, paged: false };
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

const BG_ADAPTERS = [
  {
    id: "chatgpt", label: "ChatGPT", base: "https://chatgpt.com",
    host: "chatgpt.com", prefix: "/c/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/auth/session");
      const j = await bgJson(r);
      if (!j || !j.accessToken) throw new BgError("auth", "not signed in");
      return {
        tok: j.accessToken,
        account: j.user?.id || j.user?.email || j.account?.id || ""
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
      const org = Array.isArray(orgs) ? (orgs.find((o) => o && o.uuid) || orgs[0]) : null;
      if (!org || !org.uuid) throw new BgError("auth", "not signed in");
      return { org: org.uuid, account: org.uuid };
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
    async prepare() {
      await bgFetch(this.base + "/api/v0/chat/list?count=1");
      return {};
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
    async prepare() {
      await bgFetch(this.base + "/rest/app-chat/conversations?limit=1");
      return {};
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
          id: it.id || it.conversation_id, title: it.title || it.name || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : 0,
          updatedAt: it.updated_at ? new Date(it.updated_at).getTime() : Date.now()
        })
      });
    },
    async detail(ctx, id) {
      const data = await this.get(ctx, "/rest/app-chat/conversations/" + id);
      const msgs = [];
      for (const m of (data.messages || data.turns || [])) {
        const role = /user|human/i.test(m.role || m.sender || "") ? "user" : "assistant";
        const text = (m.content || m.text || m.message || "").trim();
        if (text) msgs.push({ r: role, t: text, ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0 });
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
    version: 4,
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
async function bgSyncPlatform(adapter, run, opts = {}) {
  const auto = opts.reason === "auto";
  let attempted = 0, succeeded = 0, failed = 0, total = 0;
  try {
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

    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0, msg: "Connecting…" }, { force: true });
    const ctx = await adapter.prepare();
    const { key: checkpointKey, checkpoint } = await readCheckpoint(adapter, ctx);
    const job = await readJob(checkpointKey);
    await setActiveAccount(adapter, checkpointKey);

    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0, msg: "Reading your local archive…" });
    const index = await archiveIndex(adapter.host, adapter.prefix);
    const covered = checkpoint && checkpoint.coverageKnown ? Number(checkpoint.coverage) || 0 : -1;
    // The journal may run AHEAD of pendingCount (it flushes far more often than
    // the sync ledger), never behind. scanStartedAt proves both came from the
    // same pass; a missing journal with work outstanding forces a full listing.
    const pendingOk = !(checkpoint && checkpoint.pendingCount) ||
      !!(job && job.scanStartedAt === checkpoint.safeWatermark &&
         job.pending.length <= checkpoint.pendingCount);
    const trustWatermark = !!(checkpoint && checkpoint.safeWatermark &&
      covered >= 0 && index.size >= covered && pendingOk);
    // A delta listing cannot see a deletion: a chat the user removed simply is
    // not in the window, exactly like a chat that never changed. Once a day the
    // pass lists everything instead, purely so vanished chats can be noticed.
    // It costs listing requests only — rule 1 still downloads nothing already
    // archived.
    const sweeping = trustWatermark && index.size > 0 && await sweepDue(adapter.id) &&
      (await deletionPolicy()) !== "keep";
    const sinceMs = trustWatermark && !sweeping ? Math.max(0, checkpoint.safeWatermark - BG_SYNC_OVERLAP_MS) : 0;
    const mode = sweeping ? "sweep" : trustWatermark ? "delta" : "reconcile";
    const carried = trustWatermark && job ? job.pending : [];
    // Captured BEFORE listing on purpose: a chat that shifts pages mid-listing
    // still has a revision >= this, so the next pass re-lists it.
    const scanStartedAt = Date.now();

    // 3. one request to answer "anything new?" on a routine pass. Skipped while
    //    sweeping — "nothing new" says nothing about what was removed.
    if (trustWatermark && !sweeping && !carried.length && adapter.peek) {
      const { hasNew } = await adapter.peek(ctx, sinceMs);
      if (!hasNew) {
        await finishPlatform(adapter, checkpointKey,
          { ...checkpoint, safeWatermark: scanStartedAt, pendingCount: 0, passState: "clean", runId: run.id },
          "up-to-date", { attempted: 0, total: 0, succeeded: 0, failed: 0 },
          "Everything is already backed up", index.size);
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
    const metas = listed.metas || [];
    const complete = listed.complete !== false;

    // 3b. The listing covered the whole history, so anything archived and not in
    //     it is gone upstream. Never destructive by itself — noteVanished()
    //     honours the user's policy, and the default is to ask.
    if (sinceMs === 0 && complete && metas.length <= BG_PENDING_MAX) {
      const prefix = adapter.host + adapter.prefix;
      const listedIds = new Set(metas.map((m) => prefix + m.id));
      const pendingIds = new Set(carried.map((p) => p.id));
      await sweepVanished(adapter, index, listedIds, scanStartedAt, pendingIds);
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
          pendingCount: 0, passState: complete ? "clean" : "partial", runId: run.id },
        "up-to-date", { attempted: metas.length, total: metas.length, succeeded: 0, failed: 0 },
        "Everything is already backed up", index.size);
      return { ok: true, result: "up-to-date", mode };
    }

    total = work.length;
    const overflow = work.length > BG_PENDING_MAX;

    // 5. Persist the watermark and the FULL outstanding set before fetching
    //    anything. This is what lets a first pass that is rate-limited on every
    //    single chat still leave a resumable checkpoint behind.
    await writeJob(checkpointKey, { platform: adapter.id, scanStartedAt, pending: work,
      tombstones: job ? job.tombstones : [] });
    const baseCoverage = await platformCount(adapter.host, adapter.prefix);
    await saveCheckpoint(checkpointKey, {
      version: 4, platform: adapter.id,
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
            sourceUpdatedAt: item.rev, msgs
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

    const coverage = await platformCount(adapter.host, adapter.prefix);
    const remaining = await readJob(checkpointKey);
    const left = remaining ? remaining.pending.length : 0;

    if (circuitOpen || budgetHit || left) {
      // Watermark and journal already persisted at step 5 — nothing is lost and
      // the next pass picks up exactly what is left.
      const until = hostEntry(adapter.host).cooldownUntil;
      await saveCheckpoint(checkpointKey, {
        ...(checkpoint || {}), version: 4, platform: adapter.id,
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
      { ...(checkpoint || {}),
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
    const reason = String((error && error.message) || error);
    const signedOut = reason.includes("unauthorized") || reason.includes("not signed in") ||
      /unexpected provider response|invalid provider response/i.test(reason);
    const rateLimited = (error && error.kind) === "rate";
    const message = reason.includes("unauthorized") || reason.includes("not signed in")
      ? `Not signed in`
      : /unexpected token\s*['"]?<?|valid json|json\.parse|unexpected provider response|invalid provider response/i.test(reason)
        ? `Needs an active session`
        : rateLimited
          ? `${adapter.label} is rate-limiting — resumes automatically`
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
  const platforms = {};
  for (const adapter of BG_ADAPTERS) {
    // Do not show another signed-in account's checkpoint as this account's
    // state. A platform becomes "ready to check" until this browser has
    // identified the currently active account during a background check.
    const activeKey = String(activeAccounts[adapter.id] || "");
    const checkpoint = activeKey ? ledger.checkpoints[activeKey] || null : null;
    const progress = store[BG_SYNC_PROG(adapter.id)] || null;
    const phase = progress?.phase || (checkpoint ? "up-to-date" : "needs-sync");
    platforms[adapter.id] = {
      label: adapter.label,
      progress,
      flag: store[BG_SYNC_FLAG(adapter.id)] || null,
      checkpoint,
      phase
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

  const connected = entries.filter((p) => !(p.progress && p.progress.signedOut));
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
    BG_DELETIONS, BG_SWEEP_STATE, BG_AUTOBACKUP, BG_AUTOBACKUP_STATE, BG_RESTORE_GUARD]));
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
