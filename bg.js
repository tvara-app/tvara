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
 * local archive. It has no Long Chat Toolkit server, telemetry, or upload
 * path; everything is deletable in one click from the Recall page.
 */
"use strict";

const DB_NAME = "lct-recall";
const DB_VERSION = 1;
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
      if (!d.objectStoreNames.contains("chats")) {
        const s = d.createObjectStore("chats", { keyPath: "id" }); // id = host+path
        s.createIndex("updatedAt", "updatedAt");
      }
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
  const msgs = (chat.msgs || []).slice(-MAX_MSGS).map((m) => ({
    r: m.r === "user" ? "user" : "assistant",
    t: String(m.t || "").slice(0, MAX_MSG_CHARS),
    ts: typeof m.ts === "number" ? m.ts : 0
  }));
  return {
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
  if (isMeta) {
    // a meta record (title+dates from sync) must never ERASE archived text
    const existing = await reqP(tx(d, "readonly").get(String(chat.id).slice(0, 600)));
    if (existing && existing.n > 0) {
      if (chat.title && !existing.title) {
        existing.title = String(chat.title).slice(0, 200);
        await reqP(tx(d, "readwrite").put(existing));
      }
      return { ok: true };
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
  if (!arr.length) return { ok: 0, skipped: 0 };
  const d = await db();
  let ok = 0, skipped = 0;

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
    try {
      if (!c || !c.id || !Array.isArray(c.msgs)) { skipped++; continue; }
      const chat = { ...c, keepTimes: true };
      const isMeta = chat.meta === true && chat.msgs.length === 0;
      if (!isMeta && chat.msgs.length < 2) { skipped++; continue; }
      const id = String(chat.id).slice(0, 600);
      if (isMeta) {
        const prev = existing.get(id);
        if (prev && prev.n > 0) {
          if (chat.title && !prev.title) {
            prev.title = String(chat.title).slice(0, 200);
            await reqP(wStore.put(prev));
          }
          ok++; continue;
        }
      }
      const previous = existing.get(id);
      const candidateSource = Number(chat.sourceUpdatedAt || chat.updatedAt || 0);
      const previousSource = Number(previous && (previous.sourceUpdatedAt || previous.updatedAt) || 0);
      // Restores and retries are merge operations: a stale snapshot must not
      // overwrite a newer local conversation that arrived in the meantime.
      if (previous && previous.n > 0 && candidateSource > 0 && previousSource > candidateSource) {
        ok++;
        continue;
      }
      const clamped = clampChat(chat);
      if ((chat.keepTimes || isMeta) && chat.updatedAt) clamped.updatedAt = chat.updatedAt;
      await reqP(wStore.put(clamped));
      ok++;
    } catch { skipped++; }
  }
  return { ok, skipped };
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
async function archiveIndex(host, prefix) {
  const d = await db();
  const index = new Map();
  const start = host + prefix;
  await new Promise((resolve, reject) => {
    const cur = tx(d, "readonly").openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      if (v && typeof v.id === "string" && v.id.startsWith(start)) {
        index.set(v.id, Number(v.sourceUpdatedAt || v.updatedAt || 0));
      }
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

const BG_SYNC_CONCURRENCY = 8;
const BG_SYNC_DELAY = 40;
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
    version: 3,
    platform,
    safeWatermark,
    completedAt,
    lastResult: String(value.lastResult || "delta").slice(0, 32),
    archived: Math.max(0, Math.floor(Number(value.archived) || 0)),
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
  for (const [key, raw] of Object.entries(value.checkpoints).slice(0, 64)) {
    const checkpoint = cleanCheckpoint(raw);
    if (checkpoint) checkpoints[String(key).slice(0, 200)] = checkpoint;
  }
  return { version: 2, checkpoints };
}

async function getDurable(keys) {
  try { return { data: await chrome.storage.sync.get(keys), synced: true }; }
  catch { return { data: await chrome.storage.local.get(keys), synced: false }; }
}

async function setDurable(value) {
  try { await chrome.storage.sync.set(value); return true; }
  catch { await chrome.storage.local.set(value); return false; }
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

async function ensureRecoveryState() {
  const local = await chrome.storage.local.get([BG_INSTALL, BG_RECOVERY]);
  if (local[BG_INSTALL]) return local[BG_RECOVERY] || { state: "ready" };
  const { data } = await getDurable(BG_BACKUP_MARKER);
  const marker = data[BG_BACKUP_MARKER] || null;
  const recovery = marker ? { state: "restore-required", backup: marker } : { state: "ready" };
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
  await chrome.storage.local.set({
    [BG_INSTALL]: { at: Date.now() },
    [BG_RECOVERY]: { state: "ready", restoredAt: Date.now(), backup: backupMeta || null }
  });
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

async function bgFetch(url, opts = {}) {
  const cookieHeader = await getCookieHeader(url);
  const headers = {
    Accept: "application/json, text/plain, */*",
    ...(opts.headers || {}),
    Cookie: cookieHeader
  };
  const r = await fetch(url, { ...opts, headers, credentials: "include" });
  if (r.status === 429) throw new Error("rate-limited");
  if (r.status === 401 || r.status === 403) throw new Error("unauthorized");
  if (!r.ok) throw new Error("http " + r.status);
  return r;
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

const BG_ADAPTERS = [
  {
    id: "chatgpt", label: "ChatGPT", base: "https://chatgpt.com",
    host: "chatgpt.com", prefix: "/c/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/auth/session");
      const j = await bgJson(r);
      if (!j || !j.accessToken) throw new Error("not signed in");
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
    async list(ctx, sinceMs, progress) {
      const metas = [];
      let hitOld = false;
      for (let off = 0; off < 50000 && !hitOld; off += BG_SYNC_LIST_PAGE) {
        const j = await this.get(ctx,
          `/backend-api/conversations?offset=${off}&limit=${BG_SYNC_LIST_PAGE}&order=updated`);
        for (const it of j.items || []) {
          const upd = it.update_time ? new Date(it.update_time).getTime() : Date.now();
          if (sinceMs && upd <= sinceMs) { hitOld = true; break; }
          metas.push({
            id: it.id, title: it.title || "",
            createdAt: it.create_time ? new Date(it.create_time).getTime() : 0,
            updatedAt: upd
          });
        }
        progress(metas.length, j.total || 0, `Listing chats… ${metas.length}`);
        if ((j.items || []).length < BG_SYNC_LIST_PAGE) break;
      }
      return metas;
    },
    async detail(ctx, id) {
      const conv = await this.get(ctx, "/backend-api/conversation/" + id);
      const msgs = [];
      for (const node of Object.values(conv.mapping || {})) {
        const m = node && node.message;
        if (!m || !m.author) continue;
        const role = m.author.role;
        if (role !== "user" && role !== "assistant") continue;
        const parts = (m.content && m.content.parts) || [];
        const text = parts.filter((p) => typeof p === "string").join("\n").trim();
        if (!text) continue;
        msgs.push({ r: role, t: text, ts: m.create_time ? Math.floor(m.create_time) : 0 });
      }
      msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      return msgs;
    }
  },
  {
    id: "claude", label: "Claude", base: "https://claude.ai",
    host: "claude.ai", prefix: "/chat/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/organizations");
      const orgs = await bgJson(r);
      const org = Array.isArray(orgs) ? (orgs.find((o) => o && o.uuid) || orgs[0]) : null;
      if (!org || !org.uuid) throw new Error("not signed in");
      return { org: org.uuid, account: org.uuid };
    },
    async get(ctx, path) { return bgJson(await bgFetch(this.base + path)); },
    async list(ctx, sinceMs, progress) {
      const arr = await this.get(ctx, `/api/organizations/${ctx.org}/chat_conversations`);
      const metas = [];
      for (const it of Array.isArray(arr) ? arr : []) {
        const upd = it.updated_at ? new Date(it.updated_at).getTime() : Date.now();
        if (sinceMs && upd <= sinceMs) continue;
        metas.push({
          id: it.uuid, title: it.name || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : 0,
          updatedAt: upd
        });
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      progress(metas.length, metas.length, `Found ${metas.length} chats`);
      return metas;
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
      const data = await this.get(ctx, "/api/v0/chat/list?count=500");
      const items = data.data?.list || data.list || (Array.isArray(data) ? data : []);
      const metas = [];
      for (const it of items) {
        const upd = it.updated_at ? new Date(it.updated_at).getTime() : (it.update_time || Date.now());
        if (sinceMs && upd <= sinceMs) continue;
        metas.push({
          id: it.id || it.session_id, title: it.title || it.topic || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : (it.create_time || 0),
          updatedAt: upd
        });
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      progress(metas.length, metas.length, `Found ${metas.length} chats`);
      return metas;
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
      const data = await this.get(ctx, "/rest/app-chat/conversations?limit=500");
      const items = data.conversations || data.items || (Array.isArray(data) ? data : []);
      const metas = [];
      for (const it of items) {
        const upd = it.updated_at ? new Date(it.updated_at).getTime() : Date.now();
        if (sinceMs && upd <= sinceMs) continue;
        metas.push({
          id: it.id || it.conversation_id, title: it.title || it.name || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : 0,
          updatedAt: upd
        });
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      progress(metas.length, metas.length, `Found ${metas.length} chats`);
      return metas;
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

async function writeProgress(adapter, run, done, total, msg, phase = "syncing") {
  await chrome.storage.local.set({
    [BG_SYNC_PROG(adapter.id)]: { state: "syncing", phase, done, total, msg, at: Date.now(), runId: run.id }
  });
  await beat(run, adapter.id);
}

async function finishPlatform(adapter, checkpointKey, scanStartedAt, result, done, total, archived, message, coverage) {
  const completedAt = Date.now();
  await saveCheckpoint(checkpointKey, {
    version: 3,
    platform: adapter.id,
    safeWatermark: scanStartedAt,
    completedAt,
    lastResult: result,
    archived,
    coverage: Math.max(0, Number(coverage) || 0),
    coverageKnown: true
  });
  await chrome.storage.local.set({
    [BG_SYNC_PROG(adapter.id)]: {
      state: "done", phase: "up-to-date", done, total, result, archived, msg: message, at: completedAt
    },
    [BG_SYNC_FLAG(adapter.id)]: { lastFull: completedAt }
  });
}

/**
 * Reconcile one provider against the local archive.
 *
 * The contract, in order of authority:
 *
 *   1. The archive index (what this browser actually holds) decides what gets
 *      downloaded. A chat is fetched only when it is absent, or when the
 *      provider's revision is newer than the archived one.
 *   2. The checkpoint watermark only decides how much metadata to LIST. It is
 *      an optimisation, never a correctness guarantee.
 *   3. The watermark is trusted only while coverage holds: the archive must
 *      still contain at least as many chats as the checkpoint recorded. A
 *      reinstall, a wipe, or a partial restore breaks coverage, and the pass
 *      silently widens to a full listing — which still downloads nothing that
 *      is already archived, because rule 1 outranks it.
 *
 * That is what makes the uninstall→reinstall gap work. Restore the encrypted
 * backup and the archive holds every chat that existed at backup time; the
 * chats created while the extension was gone are the only ids missing from the
 * index, so they are the only ones fetched. Skip the restore and coverage is
 * zero, so the pass rebuilds from scratch. Either way the answer is derived,
 * never assumed.
 */
async function bgSyncPlatform(adapter, run) {
  let done = 0, total = 0;
  try {
    await writeProgress(adapter, run, 0, 0, "Connecting…", "checking");
    const ctx = await adapter.prepare();
    const { key: checkpointKey, checkpoint } = await readCheckpoint(adapter, ctx);
    await setActiveAccount(adapter, checkpointKey);

    await writeProgress(adapter, run, 0, 0, "Reading your local archive…", "checking");
    const index = await archiveIndex(adapter.host, adapter.prefix);
    const covered = checkpoint && checkpoint.coverageKnown ? Number(checkpoint.coverage) || 0 : -1;
    // covered < 0  → checkpoint predates coverage tracking, so it is unproven
    // index.size < covered → the archive lost chats the checkpoint promised
    const trustWatermark = !!(checkpoint && checkpoint.safeWatermark && covered >= 0 && index.size >= covered);
    const sinceMs = trustWatermark
      ? Math.max(0, checkpoint.safeWatermark - BG_SYNC_OVERLAP_MS)
      : 0;
    const mode = trustWatermark ? "delta" : "reconcile";
    const scanStartedAt = Date.now();
    const progress = (count, listedTotal, msg) =>
      writeProgress(adapter, run, count || 0, listedTotal || 0, msg || "Checking for new chats…", "checking");

    await writeProgress(adapter, run, 0, 0,
      mode === "delta"
        ? "Checking for new chats…"
        : index.size
          ? "Rebuilding the archive index…"
          : "Building the first archive index…",
      "checking");
    const metas = await adapter.list(ctx, sinceMs, progress);
    if (!metas.length) {
      await finishPlatform(adapter, checkpointKey, scanStartedAt, "up-to-date", 0, 0, 0,
        "Everything is already backed up", index.size);
      return { ok: true, result: "up-to-date", mode };
    }

    const toFetch = metas.filter((m) => {
      const archivedRevision = index.get(adapter.host + adapter.prefix + m.id);
      // A chat is a duplicate only when it is the same provider revision. The
      // list overlap can therefore be safely retried after an interrupted
      // worker without requesting its detail text again.
      return archivedRevision === undefined || archivedRevision < m.updatedAt;
    });
    if (!toFetch.length) {
      await finishPlatform(adapter, checkpointKey, scanStartedAt, "up-to-date", metas.length, metas.length, 0,
        "Everything is already backed up", index.size);
      return { ok: true, result: "up-to-date", mode };
    }

    let cursor = 0, archived = 0, retryCount = 0, fatal = null, pauseUntil = 0;
    total = toFetch.length;
    const importQueue = [];
    const flushQueue = async () => {
      if (!importQueue.length) return;
      const batch = importQueue.splice(0);
      const result = await importBatch(batch);
      archived += result.ok;
      retryCount += result.skipped;
    };
    const worker = async () => {
      while (!fatal) {
        const slot = cursor++;
        if (slot >= total) return;
        const meta = toFetch[slot];
        if (pauseUntil > Date.now()) await sleep(pauseUntil - Date.now());
        try {
          const msgs = await adapter.detail(ctx, meta.id);
          const record = {
            id: adapter.host + adapter.prefix + meta.id,
            host: adapter.host, path: adapter.prefix + meta.id,
            platform: adapter.label, title: meta.title,
            createdAt: meta.createdAt, updatedAt: meta.updatedAt,
            sourceUpdatedAt: meta.updatedAt, msgs
          };
          // A conversation with no usable dialogue (empty, or a single opening
          // turn) still has its provider revision fully accounted for. It is
          // archived as a metadata record so it can never keep a checkpoint
          // pinned open and re-fetch itself on every future pass.
          if (msgs.length < 2) { record.msgs = []; record.meta = true; }
          importQueue.push(record);
          if (importQueue.length >= BG_SYNC_BATCH) await flushQueue();
        } catch (error) {
          const reason = String(error && error.message || error);
          if (reason.includes("unauthorized")) { fatal = error; return; }
          if (reason.includes("rate-limited")) pauseUntil = Date.now() + 15000;
          retryCount++;
        }
        done++;
        await writeProgress(adapter, run, done, total,
          `Capturing ${done} of ${total} new chat${total === 1 ? "" : "s"}…`, "syncing");
        await sleep(BG_SYNC_DELAY);
      }
    };

    await Promise.all(Array.from({ length: Math.min(BG_SYNC_CONCURRENCY, total) }, worker));
    await flushQueue();
    if (fatal) throw fatal;
    // Counted from the database, never inferred from `archived`: an update to
    // an already-archived chat adds no row, and an inflated coverage figure
    // would fail its own trust check forever and pin the platform in
    // full-reconcile mode.
    const coverage = await platformCount(adapter.host, adapter.prefix);
    if (retryCount) {
      // Retain the preceding safe watermark: the failed chats must stay inside
      // the next listing window. Coverage is still recorded, so the retry pass
      // re-lists the same range and downloads only what is genuinely missing.
      if (checkpoint) {
        await saveCheckpoint(checkpointKey, { ...checkpoint, coverage, coverageKnown: true });
      }
      await chrome.storage.local.set({
        [BG_SYNC_PROG(adapter.id)]: {
          state: "error", phase: "error", done, total, archived,
          msg: `${archived} saved · ${retryCount} will retry automatically`, at: Date.now()
        }
      });
      return { ok: false, retryCount };
    }
    await finishPlatform(adapter, checkpointKey, scanStartedAt, mode, done, total, archived,
      archived
        ? `${archived} new chat${archived === 1 ? "" : "s"} backed up`
        : "Everything is already backed up",
      coverage);
    return { ok: true, result: mode, archived };
  } catch (error) {
    const reason = String(error && error.message || error);
    const signedOut = reason.includes("unauthorized") || reason.includes("not signed in") ||
      /unexpected provider response|invalid provider response/i.test(reason);
    const message = reason.includes("unauthorized") || reason.includes("not signed in")
      ? `Not signed in`
      : /unexpected token\s*['"]?<?|valid json|json\.parse|unexpected provider response|invalid provider response/i.test(reason)
        ? `Needs an active session`
        : `Couldn't reach ${adapter.label}`;
    await chrome.storage.local.set({
      [BG_SYNC_PROG(adapter.id)]: {
        state: "error", phase: "error", done, total, msg: message, signedOut, at: Date.now()
      }
    });
    return { ok: false, error: reason, signedOut };
  }
}

async function bgSyncAll() {
  const recovery = await ensureRecoveryState();
  if (recovery.state === "restore-required") return { status: "restore-required", recovery };
  if (bgSyncRunning) return { status: "already-running" };
  const run = await beginRun();
  if (!run) return { status: "already-running" };
  bgSyncRunning = true;
  try {
    const results = await Promise.all(BG_ADAPTERS.map((adapter) => bgSyncPlatform(adapter, run)));
    await chrome.storage.local.set({ [BG_RUN]: { ...run, state: "done", finishedAt: Date.now() } });
    return { status: "done", results };
  } finally {
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
  return {
    platforms,
    running: !!(run && run.state === "running"),
    recovery,
    summary: summarize(platforms, !!(run && run.state === "running"), recovery),
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
function summarize(platforms, running, recovery) {
  if (recovery && recovery.state === "restore-required") {
    return { state: "restore", message: "Restore your archive to continue", checkedAt: 0, connected: 0 };
  }
  const entries = Object.values(platforms);
  if (running || entries.some((p) => p.progress && p.progress.state === "syncing")) {
    const live = entries.filter((p) => p.progress && p.progress.state === "syncing");
    // Sum the whole pass. Reporting only the loudest platform's numbers made a
    // four-provider check look like it kept restarting at 0%.
    let done = 0, total = 0;
    for (const p of entries) {
      const pr = p.progress;
      if (!pr || !Number.isFinite(Number(pr.total)) || Number(pr.total) <= 0) continue;
      if (pr.state !== "syncing" && pr.state !== "done") continue;
      done += Math.min(Number(pr.done) || 0, Number(pr.total));
      total += Number(pr.total);
    }
    const message = live.length > 1
      ? `Checking ${live.length} platforms…`
      : (live[0] && live[0].progress.msg) || "Checking for new chats…";
    return { state: "syncing", message, done, total, syncing: live.length, checkedAt: 0, connected: 0 };
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
  const localKeys = [BG_RUN, BG_RECOVERY, BG_ACTIVE_ACCOUNT]
    .concat(BG_ADAPTERS.map((adapter) => BG_SYNC_PROG(adapter.id)))
    .concat(BG_ADAPTERS.map((adapter) => BG_SYNC_FLAG(adapter.id)));
  await chrome.storage.local.remove(localKeys);
  try { await chrome.storage.sync.remove([BG_SYNC_LEDGER, BG_BACKUP_MARKER, BG_SYNC_PROFILE]); }
  catch { await chrome.storage.local.remove([BG_SYNC_LEDGER, BG_BACKUP_MARKER, BG_SYNC_PROFILE]); }
  return { ok: true };
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
const BG_AUTO_STATE = "lct-recall-auto-sync-v1";
const BG_AUTO_FIRST_DELAY_MIN = 10;
const BG_AUTO_PERIOD_MIN = 360;      // every 6 hours

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
    await chrome.alarms.create(BG_AUTO_ALARM, {
      delayInMinutes: BG_AUTO_FIRST_DELAY_MIN,
      periodInMinutes: BG_AUTO_PERIOD_MIN
    });
  } catch { /* alarms unavailable */ }
}

async function autoSyncTick() {
  if (!(await autoSyncEnabled())) return { status: "disabled" };
  const started = Date.now();
  const result = await bgSyncAll();       // owns the recovery gate and overlap guard
  try {
    await chrome.storage.local.set({
      [BG_AUTO_STATE]: { at: started, status: result && result.status }
    });
  } catch { /* dead context */ }
  return result;
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === BG_AUTO_ALARM) autoSyncTick();
  });
  chrome.runtime.onInstalled.addListener(() => { ensureAutoSyncAlarm(); });
  chrome.runtime.onStartup.addListener(() => { ensureAutoSyncAlarm(); });
  ensureAutoSyncAlarm();   // the worker is respawned constantly; keep it alive
} catch (_) { /* alarms API unavailable */ }

/* ---------- message router ---------- */

// Keyboard shortcuts
try {
  chrome.commands.onCommand.addListener((name) => {
    chrome.storage.local.set({ "lct-cmd": { name, at: Date.now() } });
  });
} catch (_) { /* commands API unavailable */ }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    switch (msg && msg.type) {
      case "recall-upsert":      return upsert(msg.chat);
      case "recall-import":      return importBatch(msg.chats);
      case "recall-search":      return search(msg.q, msg.long);
      case "recall-check":       return check(msg.ids);
      case "recall-stats":       return stats();
      case "recall-wipe":        return wipeRecall();
      case "recall-bg-sync":     return bgSyncAll();
      case "recall-auto-tick":   return autoSyncTick();
      case "recall-sync-status": return bgSyncStatus();
      case "recall-backup-state": return backupState();
      case "recall-backup-mark": return markBackup(msg.meta);
      case "recall-restore-ledger": return restoreLedger(msg.ledger, msg.meta, msg.profile);
      case "recall-recovery-skip": return skipRecovery();
      default: return { err: "unknown" };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ err: String(e && e.message || e) }));
  return true; // async response
});
