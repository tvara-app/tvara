/**
 * Long Chat Toolkit — background service worker: the Total Recall database.
 *
 * One IndexedDB (extension origin) holds a local archive of every AI chat the
 * user has opened, across ALL platforms. Content scripts (isolated per site)
 * cannot share a database, so they send their conversation text here and this
 * worker owns storage + search.
 *
 * Privacy: this file has no network access (the extension holds no network
 * permissions) — the archive physically cannot leave the machine. Everything
 * is deletable in one click from the Recall page.
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
      if (v) out[id] = { n: v.n, updatedAt: v.updatedAt };
    } catch { /* skip */ }
  }
  return out;
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
const BG_SYNC_FLAG = (p) => "recall-sync-" + p;     // { lastFull: ms } — chrome.storage.local
const BG_SYNC_PROG = (p) => "recall-sync-progress:" + p;
const BG_SYNC_WM   = (p) => "recall-wm-" + p;        // { at: ms } — chrome.storage.sync (survives uninstall)
const BG_SYNC_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — don't re-sync unless stale

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => c.name + "=" + c.value).join("; ");
  } catch { return ""; }
}

async function bgFetch(url, opts = {}) {
  const cookieHeader = await getCookieHeader(url);
  const headers = { ...(opts.headers || {}), Cookie: cookieHeader };
  const r = await fetch(url, { ...opts, headers, credentials: "include" });
  if (r.status === 429) throw new Error("rate-limited");
  if (r.status === 401 || r.status === 403) throw new Error("unauthorized");
  if (!r.ok) throw new Error("http " + r.status);
  return r;
}

const BG_ADAPTERS = [
  {
    id: "chatgpt", label: "ChatGPT", base: "https://chatgpt.com",
    host: "chatgpt.com", prefix: "/c/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/auth/session");
      const j = await r.json();
      if (!j || !j.accessToken) throw new Error("not signed in");
      return { tok: j.accessToken };
    },
    async get(ctx, path) {
      const r = await bgFetch(this.base + path, {
        headers: { Authorization: "Bearer " + ctx.tok }
      });
      return r.json();
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
      const orgs = await r.json();
      const org = Array.isArray(orgs) ? (orgs.find((o) => o && o.uuid) || orgs[0]) : null;
      if (!org || !org.uuid) throw new Error("not signed in");
      return { org: org.uuid };
    },
    async get(ctx, path) { return (await bgFetch(this.base + path)).json(); },
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
    async get(ctx, path) { return (await bgFetch(this.base + path)).json(); },
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
    async get(ctx, path) { return (await bgFetch(this.base + path)).json(); },
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

async function bgSyncPlatform(adapter) {
  const prog = (done, total, msg) =>
    chrome.storage.local.set({ [BG_SYNC_PROG(adapter.id)]: { state: "syncing", done, total, msg, at: Date.now() } });

  try {
    // Phase 0: Check if already fresh — skip entirely if synced recently
    try {
      const { [BG_SYNC_FLAG(adapter.id)]: flag } = await chrome.storage.local.get(BG_SYNC_FLAG(adapter.id));
      if (flag && flag.lastFull && Date.now() - flag.lastFull < BG_SYNC_STALE_MS) {
        await chrome.storage.local.set({
          [BG_SYNC_PROG(adapter.id)]: { state: "done", done: 0, total: 0, msg: "Already synced ✓", at: Date.now() }
        });
        return;
      }
    } catch {}

    await prog(0, 0, "Preparing…");
    const ctx = await adapter.prepare();

    // Phase A: Read watermark from chrome.storage.sync (survives uninstall)
    let sinceMs = 0;
    try {
      const wm = await chrome.storage.sync.get(BG_SYNC_WM(adapter.id));
      const mark = wm[BG_SYNC_WM(adapter.id)];
      if (mark && mark.at) sinceMs = mark.at;
    } catch {}

    // Phase A.1: List conversations (skips anything older than watermark)
    await prog(0, 0, sinceMs ? "Checking for new chats…" : "Listing chats…");
    const metas = await adapter.list(ctx, sinceMs, prog);
    if (!metas.length) {
      await chrome.storage.local.set({
        [BG_SYNC_PROG(adapter.id)]: { state: "done", done: 0, total: 0, msg: "All chats synced ✓", at: Date.now() },
        [BG_SYNC_FLAG(adapter.id)]: { lastFull: Date.now() }
      });
      return;
    }

    // Phase A.5: Deduplicate against IndexedDB (handles re-install + still-fresh local data)
    const allIds = metas.map((m) => adapter.host + adapter.prefix + m.id);
    const existing = await check(allIds);
    const toFetch = metas.filter((m) => {
      const have = existing[adapter.host + adapter.prefix + m.id];
      return !have || have.n === 0 || have.updatedAt < m.updatedAt;
    });

    if (!toFetch.length) {
      await chrome.storage.local.set({
        [BG_SYNC_PROG(adapter.id)]: { state: "done", done: metas.length, total: metas.length, msg: `All ${metas.length} chats synced ✓`, at: Date.now() },
        [BG_SYNC_FLAG(adapter.id)]: { lastFull: Date.now() }
      });
      // Update watermark
      try { await chrome.storage.sync.set({ [BG_SYNC_WM(adapter.id)]: { at: Date.now() } }); } catch {}
      return;
    }

    // Phase B: fetch full text with high concurrency
    let cursor = 0, done = 0, fatal = null, pauseUntil = 0;
    const total = toFetch.length;
    const importQueue = [];

    const flushQueue = async () => {
      if (!importQueue.length) return;
      const batch = importQueue.splice(0);
      await importBatch(batch);
    };

    const worker = async () => {
      while (!fatal) {
        const i = cursor++;
        if (i >= total) return;
        const m = toFetch[i];
        if (pauseUntil > Date.now()) await sleep(pauseUntil - Date.now());
        try {
          const msgs = await adapter.detail(ctx, m.id);
          if (msgs.length >= 2) {
            importQueue.push({
              id: adapter.host + adapter.prefix + m.id,
              host: adapter.host, path: adapter.prefix + m.id,
              platform: adapter.label, title: m.title,
              createdAt: m.createdAt, updatedAt: m.updatedAt, msgs
            });
            if (importQueue.length >= BG_SYNC_BATCH) await flushQueue();
          }
        } catch (e) {
          const em = String(e.message || e);
          if (em.includes("unauthorized")) { fatal = e; return; }
          if (em.includes("rate-limited")) { pauseUntil = Date.now() + 15000; }
        }
        done++;
        await prog(done, total, `Archiving… ${done}/${total}`);
        await sleep(BG_SYNC_DELAY);
      }
    };

    await Promise.all(Array.from({ length: Math.min(BG_SYNC_CONCURRENCY, total) }, worker));
    await flushQueue();

    if (fatal) {
      await chrome.storage.local.set({
        [BG_SYNC_PROG(adapter.id)]: { state: "error", done, total, msg: String(fatal.message || fatal), at: Date.now() }
      });
    } else {
      await chrome.storage.local.set({
        [BG_SYNC_PROG(adapter.id)]: { state: "done", done, total, msg: `${done} new chats synced ✓`, at: Date.now() },
        [BG_SYNC_FLAG(adapter.id)]: { lastFull: Date.now() }
      });
      // Save watermark to chrome.storage.sync — persists across uninstall/reinstall
      try { await chrome.storage.sync.set({ [BG_SYNC_WM(adapter.id)]: { at: Date.now() } }); } catch {}
    }
  } catch (e) {
    await chrome.storage.local.set({
      [BG_SYNC_PROG(adapter.id)]: { state: "error", done: 0, total: 0, msg: String(e.message || e), at: Date.now() }
    });
  }
}

async function bgSyncAll() {
  if (bgSyncRunning) return { status: "already-running" };
  bgSyncRunning = true;
  try {
    // Run all platforms in parallel
    await Promise.all(BG_ADAPTERS.map((a) => bgSyncPlatform(a)));
    return { status: "done" };
  } finally {
    bgSyncRunning = false;
  }
}

async function bgSyncStatus() {
  const keys = BG_ADAPTERS.map((a) => BG_SYNC_PROG(a.id))
    .concat(BG_ADAPTERS.map((a) => BG_SYNC_FLAG(a.id)));
  const store = await chrome.storage.local.get(keys);
  const platforms = {};
  for (const a of BG_ADAPTERS) {
    platforms[a.id] = {
      label: a.label,
      progress: store[BG_SYNC_PROG(a.id)] || null,
      flag: store[BG_SYNC_FLAG(a.id)] || null
    };
  }
  return { platforms, running: bgSyncRunning };
}

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
      case "recall-wipe":        return wipe();
      case "recall-bg-sync":     return bgSyncAll();
      case "recall-sync-status": return bgSyncStatus();
      default: return { err: "unknown" };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ err: String(e && e.message || e) }));
  return true; // async response
});
