/**
 * Long Chat Toolkit — Total Recall auto-sync (ChatGPT).
 *
 * Reads the user's OWN conversation history from ChatGPT's same-origin API,
 * with the user's own session — exactly the data the page itself loads. The
 * extension still has zero network permissions: these are page-origin
 * requests to chatgpt.com only, and everything lands in the LOCAL archive.
 *
 * Two phases:
 *  A) META  — one paged listing: every chat's title + real created/updated
 *     times. Instant Chat Card coverage ("Not tracked yet" dies) and every
 *     chat becomes findable by title in Recall.
 *  B) FULL  — per-conversation text, gently rate-limited, newest first,
 *     skipping chats already archived at the same freshness.
 *
 * First run is user-triggered (a button — no silent API sweeps). After that
 * consent, a cheap delta sync keeps the archive current automatically.
 */
(() => {
  "use strict";

  const LIST_PAGE = 100;
  const FULL_DELAY_MS = 400;   // be a polite guest on their API
  const SYNC_FLAG = "recall-sync-chatgpt"; // { lastFull: ms } — consent + cursor

  let active = false; // chatgpt only

  /* ---------- mapping (mirrors the export-file parser) ---------- */

  function mapConversation(conv, id) {
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
    return {
      id: "chatgpt.com/c/" + id,
      host: "chatgpt.com",
      path: "/c/" + id,
      platform: "ChatGPT",
      title: conv.title || "",
      createdAt: conv.create_time ? Math.floor(conv.create_time * 1000) : 0,
      updatedAt: conv.update_time ? Math.floor(conv.update_time * 1000) : Date.now(),
      msgs
    };
  }

  /* ---------- same-origin API ---------- */

  async function token() {
    const r = await fetch("/api/auth/session", { credentials: "include" });
    if (!r.ok) throw new Error("session " + r.status);
    const j = await r.json();
    if (!j || !j.accessToken) throw new Error("not signed in");
    return j.accessToken;
  }

  async function api(path, tok) {
    const r = await fetch(path, {
      credentials: "include",
      headers: { Authorization: "Bearer " + tok }
    });
    if (r.status === 429) throw new Error("rate-limited");
    if (r.status === 401 || r.status === 403) throw new Error("unauthorized");
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }

  async function listAll(tok, sinceMs, progress) {
    const metas = [];
    for (let offset = 0; offset < 5000; offset += LIST_PAGE) {
      const j = await api(
        `/backend-api/conversations?offset=${offset}&limit=${LIST_PAGE}&order=updated`, tok);
      const items = j.items || [];
      for (const it of items) {
        const upd = it.update_time ? new Date(it.update_time).getTime() : 0;
        if (sinceMs && upd && upd <= sinceMs) return metas; // delta: rest is older
        metas.push({
          id: it.id,
          title: it.title || "",
          createdAt: it.create_time ? new Date(it.create_time).getTime() : 0,
          updatedAt: upd || Date.now()
        });
      }
      progress("Listing chats… " + metas.length + (j.total ? " of " + j.total : ""));
      if (items.length < LIST_PAGE) break;
    }
    return metas;
  }

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); }
    catch { res(null); }
  });

  /* ---------- the sync ---------- */

  let running = false;

  async function syncAll(progress, fullText) {
    if (running) return { err: "already running" };
    running = true;
    progress = progress || (() => {});
    try {
      const tok = await token();
      const { [SYNC_FLAG]: flag } = await chrome.storage.local.get(SYNC_FLAG);
      const sinceMs = flag && flag.lastFull ? flag.lastFull : 0;
      const metas = await listAll(tok, sinceMs, progress);

      // Phase A — meta into the archive (title-searchable) + Chat Card records
      for (let i = 0; i < metas.length; i += 50) {
        await send({
          type: "recall-import",
          chats: metas.slice(i, i + 50).map((m) => ({
            id: "chatgpt.com/c/" + m.id, host: "chatgpt.com", path: "/c/" + m.id,
            platform: "ChatGPT", title: m.title,
            createdAt: m.createdAt, updatedAt: m.updatedAt, msgs: [], meta: true
          }))
        });
      }
      const { "chats:chatgpt.com": rec } = await chrome.storage.local.get("chats:chatgpt.com");
      const records = rec || {};
      for (const m of metas) {
        const path = "/c/" + m.id;
        const prev = records[path];
        records[path] = {
          c: prev && prev.c != null ? prev.c : null, // null = size unknown (meta only)
          u: prev && prev.u != null ? prev.u : null,
          f: prev && prev.f ? prev.f : (m.createdAt || Date.now()),
          o: Math.max((prev && prev.o) || 0, m.updatedAt),
          e: Math.floor((m.createdAt || 0) / 1000),
          ti: m.title.slice(0, 120),
          sy: 1
        };
      }
      await chrome.storage.local.set({ "chats:chatgpt.com": records });
      progress(`Synced ${metas.length} chats' titles & dates.`);

      // Phase B — full text, newest first, skip already-fresh
      if (fullText && metas.length) {
        const check = await send({ type: "recall-check", ids: metas.map((m) => "chatgpt.com/c/" + m.id) });
        let done = 0, skipped = 0;
        for (const m of metas) {
          const have = check && check[("chatgpt.com/c/" + m.id)];
          if (have && have.n > 0 && have.updatedAt >= m.updatedAt) { skipped++; continue; }
          try {
            const conv = await api("/backend-api/conversation/" + m.id, tok);
            const chat = mapConversation(conv, m.id);
            if (chat.msgs.length >= 2) await send({ type: "recall-import", chats: [chat] });
            const r2 = records["/c/" + m.id];
            if (r2) {
              r2.c = chat.msgs.length;
              r2.u = chat.msgs.filter((x) => x.r === "user").length;
            }
          } catch (e) {
            if (String(e.message).includes("rate-limited")) {
              progress("Rate-limited — pausing 30s…");
              await new Promise((r) => setTimeout(r, 30000));
            } else if (String(e.message).includes("unauthorized")) {
              throw e; // token expired mid-run — stop honestly
            } // other per-chat failures: skip, keep going
          }
          done++;
          progress(`Archiving full text… ${done + skipped}/${metas.length}`);
          await new Promise((r) => setTimeout(r, FULL_DELAY_MS));
        }
        await chrome.storage.local.set({ "chats:chatgpt.com": records });
      }

      await chrome.storage.local.set({ [SYNC_FLAG]: { lastFull: Date.now() } });
      progress(`Done — ${metas.length} chats synced, all local.`);
      return { ok: true, count: metas.length };
    } catch (e) {
      const msg = String(e && e.message || e);
      progress(msg.includes("not signed in") || msg.includes("unauthorized")
        ? "Sync needs you signed in to ChatGPT."
        : "Sync failed: " + msg);
      return { err: msg };
    } finally {
      running = false;
    }
  }

  // Delta auto-sync: only after the user has run a sync once (consent), keep
  // the archive fresh quietly — one cheap delta pass per page load, delayed.
  async function maybeAutoSync() {
    try {
      const { [SYNC_FLAG]: flag } = await chrome.storage.local.get(SYNC_FLAG);
      if (!flag || !flag.lastFull) return;                    // never consented
      if (Date.now() - flag.lastFull < 30 * 60 * 1000) return; // fresh enough
      syncAll(() => {}, true);
    } catch { /* storage/api unavailable — next visit */ }
  }

  function init(adapter) {
    active = adapter && adapter.id === "chatgpt";
    if (active) setTimeout(maybeAutoSync, 12000); // long after page settle
  }

  self.LCTRecallSync = {
    init,
    get available() { return active; },
    syncAll,
    _map: mapConversation // exposed for tests
  };
})();
