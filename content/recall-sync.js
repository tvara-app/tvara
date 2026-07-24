/**
 * Long Chat Toolkit — Total Recall auto-sync (multi-platform).
 *
 * Reads the user's OWN conversation history from each app's SAME-ORIGIN API,
 * using the user's own session — exactly the data the page itself loads. The
 * extension still holds ZERO network permissions: every request here is a
 * page-origin fetch (chatgpt.com from a chatgpt.com tab, claude.ai from a
 * claude.ai tab), and everything lands only in the LOCAL archive.
 *
 * Orchestration without new permissions: chrome.storage is the message bus.
 * The Recall page writes a "sync-request"; whichever app tabs are open see it,
 * run their same-origin sync, and stream progress back through storage. Apps
 * that aren't open simply don't respond — they sync when next visited (auto).
 *
 * Per platform, two phases:
 *   A) META — list every chat's title + real created/updated times (instant
 *      Chat Card coverage, title-searchable). B) FULL — per-chat text, gently
 *      rate-limited, newest first, skipping chats already archived & fresh.
 */
(() => {
  "use strict";

  const LIST_PAGE = 100;
  const FULL_DELAY_MS = 350;          // polite pacing on their API
  const AUTO_STALE_MS = 30 * 60 * 1000;
  const REQ_KEY = "recall-sync-request";           // { at, apps:[ids|"all"], full }
  const progKey = (p) => "recall-sync-progress:" + p;
  const flagKey = (p) => "recall-sync-" + p;        // { lastFull: ms }

  /* ================= platform adapters ================= */

  const CHATGPT = {
    id: "chatgpt", host: "chatgpt.com", label: "ChatGPT", convPrefix: "/c/",
    async prepare() {
      const r = await fetch("/api/auth/session", { credentials: "include" });
      if (!r.ok) throw new Error("session " + r.status);
      const j = await r.json();
      if (!j || !j.accessToken) throw new Error("not signed in");
      return { tok: j.accessToken };
    },
    async get(ctx, path) {
      const r = await fetch(path, {
        credentials: "include",
        headers: { Authorization: "Bearer " + ctx.tok }
      });
      if (r.status === 429) throw new Error("rate-limited");
      if (r.status === 401 || r.status === 403) throw new Error("unauthorized");
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    },
    async list(ctx, sinceMs, progress) {
      const metas = [];
      for (let off = 0; off < 10000; off += LIST_PAGE) {
        const j = await this.get(ctx,
          `/backend-api/conversations?offset=${off}&limit=${LIST_PAGE}&order=updated`);
        const items = j.items || [];
        for (const it of items) {
          const upd = it.update_time ? new Date(it.update_time).getTime() : 0;
          if (sinceMs && upd && upd <= sinceMs) return { metas, total: j.total };
          metas.push({
            id: it.id, title: it.title || "",
            createdAt: it.create_time ? new Date(it.create_time).getTime() : 0,
            updatedAt: upd || Date.now()
          });
        }
        progress("listing", metas.length, j.total || 0);
        if (items.length < LIST_PAGE) break;
      }
      return { metas, total: metas.length };
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
      return { msgs };
    }
  };

  const CLAUDE = {
    id: "claude", host: "claude.ai", label: "Claude", convPrefix: "/chat/",
    async prepare() {
      // claude.ai uses cookie auth — no bearer. We just need the org id.
      const r = await fetch("/api/organizations", { credentials: "include" });
      if (r.status === 401 || r.status === 403) throw new Error("not signed in");
      if (!r.ok) throw new Error("orgs " + r.status);
      const orgs = await r.json();
      const org = Array.isArray(orgs)
        ? (orgs.find((o) => o && o.uuid) || orgs[0])
        : null;
      if (!org || !org.uuid) throw new Error("no organization");
      return { org: org.uuid };
    },
    async get(ctx, path) {
      const r = await fetch(path, { credentials: "include" });
      if (r.status === 429) throw new Error("rate-limited");
      if (r.status === 401 || r.status === 403) throw new Error("unauthorized");
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    },
    async list(ctx, sinceMs, progress) {
      // Claude's endpoint returns the whole list (no reliable paging) — filter
      // by updated_at for the delta.
      const arr = await this.get(ctx,
        `/api/organizations/${ctx.org}/chat_conversations`);
      const metas = [];
      for (const it of Array.isArray(arr) ? arr : []) {
        const upd = it.updated_at ? new Date(it.updated_at).getTime() : 0;
        if (sinceMs && upd && upd <= sinceMs) continue;
        metas.push({
          id: it.uuid, title: it.name || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : 0,
          updatedAt: upd || Date.now()
        });
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      progress("listing", metas.length, metas.length);
      return { metas, total: metas.length };
    },
    async detail(ctx, id) {
      const conv = await this.get(ctx,
        `/api/organizations/${ctx.org}/chat_conversations/${id}`);
      const msgs = [];
      for (const m of (conv.chat_messages || [])) {
        const role = m.sender === "human" ? "user" : "assistant";
        // text may be a flat string or a content[] of {type:'text',text}
        let text = String(m.text || "").trim();
        if (!text && Array.isArray(m.content)) {
          text = m.content.filter((c) => c && c.type === "text")
            .map((c) => c.text).join("\n").trim();
        }
        if (!text) continue;
        msgs.push({ r: role, t: text, ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0 });
      }
      return { msgs };
    }
  };

  const BY_ID = { chatgpt: CHATGPT, claude: CLAUDE };
  const SUPPORTED = Object.keys(BY_ID);

  /* ================= shared engine ================= */

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); }
    catch { res(null); }
  });

  let plat = null;       // the platform adapter for THIS page (or null)
  let running = false;

  async function writeProgress(state, done, total, msg) {
    try {
      await chrome.storage.local.set({
        [progKey(plat.id)]: { state, done: done || 0, total: total || 0, msg: msg || "", at: Date.now() }
      });
    } catch { /* storage gone */ }
  }

  async function runSync(fullText) {
    if (!plat) return { err: "unsupported" };
    if (running) return { err: "already running" };
    running = true;
    const host = plat.host, id = plat.id, pre = plat.convPrefix;
    const idOf = (cid) => host + pre + cid;
    try {
      await writeProgress("start", 0, 0, "Connecting…");
      const ctx = await plat.prepare();
      const { [flagKey(id)]: flag } = await chrome.storage.local.get(flagKey(id));
      const sinceMs = flag && flag.lastFull ? flag.lastFull : 0;

      const { metas } = await plat.list(ctx, sinceMs, (state, done, total) =>
        writeProgress(state, done, total, `Listing chats… ${done}${total ? " of " + total : ""}`));

      // Phase A — meta records (title + dates), archive + Chat Card
      for (let i = 0; i < metas.length; i += 50) {
        await send({
          type: "recall-import",
          chats: metas.slice(i, i + 50).map((m) => ({
            id: idOf(m.id), host, path: pre + m.id, platform: plat.label,
            title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, msgs: [], meta: true
          }))
        });
      }
      const cardKey = "chats:" + host;
      const { [cardKey]: rec } = await chrome.storage.local.get(cardKey);
      const records = rec || {};
      for (const m of metas) {
        const path = pre + m.id, prev = records[path];
        records[path] = {
          c: prev && prev.c != null ? prev.c : null,
          u: prev && prev.u != null ? prev.u : null,
          f: prev && prev.f ? prev.f : (m.createdAt || Date.now()),
          o: Math.max((prev && prev.o) || 0, m.updatedAt),
          e: Math.floor((m.createdAt || 0) / 1000),
          ti: (m.title || "").slice(0, 120), sy: 1
        };
      }
      await chrome.storage.local.set({ [cardKey]: records });
      await writeProgress("meta", metas.length, metas.length, `${metas.length} chats' titles & dates synced.`);

      // Phase B — full text, newest first, skip already-fresh
      if (fullText && metas.length) {
        const check = await send({ type: "recall-check", ids: metas.map((m) => idOf(m.id)) });
        let done = 0;
        for (const m of metas) {
          const have = check && check[idOf(m.id)];
          if (!(have && have.n > 0 && have.updatedAt >= m.updatedAt)) {
            try {
              const d = await plat.detail(ctx, m.id);
              if (d.msgs.length >= 2) {
                await send({ type: "recall-import", chats: [{
                  id: idOf(m.id), host, path: pre + m.id, platform: plat.label,
                  title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, msgs: d.msgs
                }] });
                const r2 = records[pre + m.id];
                if (r2) { r2.c = d.msgs.length; r2.u = d.msgs.filter((x) => x.r === "user").length; }
              }
            } catch (e) {
              const em = String(e.message || e);
              if (em.includes("rate-limited")) {
                await writeProgress("full", done, metas.length, "Rate-limited — pausing 30s…");
                await new Promise((r) => setTimeout(r, 30000));
              } else if (em.includes("unauthorized")) { throw e; }
              // other per-chat errors: skip and keep going
            }
          }
          done++;
          await writeProgress("full", done, metas.length, `Archiving full text… ${done}/${metas.length}`);
          await new Promise((r) => setTimeout(r, FULL_DELAY_MS));
        }
        await chrome.storage.local.set({ [cardKey]: records });
      }

      await chrome.storage.local.set({ [flagKey(id)]: { lastFull: Date.now() } });
      await writeProgress("done", metas.length, metas.length, `Done — ${metas.length} chats, all on this device.`);
      return { ok: true, count: metas.length };
    } catch (e) {
      const em = String(e && e.message || e);
      const friendly = em.includes("signed in") || em.includes("unauthorized")
        ? `Sign in to ${plat.label} to sync.` : "Sync failed: " + em;
      await writeProgress("error", 0, 0, friendly);
      return { err: em };
    } finally {
      running = false;
    }
  }

  /* ---------- triggers ---------- */

  let lastReqAt = 0;

  async function onRequest(req) {
    if (!plat || !req || req.at <= lastReqAt) return;
    lastReqAt = req.at;
    const apps = req.apps || [];
    if (!(apps.includes("all") || apps.includes(plat.id))) return;
    if (!unlocked()) { await writeProgress("locked", 0, 0, "Total Recall is Pro — start the trial to sync."); return; }
    runSync(req.full !== false);
  }

  // Silent auto-sync on visit: keeps the archive current with no interaction,
  // once Recall is unlocked. First visit does a full pass; later visits delta.
  async function maybeAutoSync() {
    try {
      if (!plat || !unlocked()) return;
      const { [flagKey(plat.id)]: flag } = await chrome.storage.local.get(flagKey(plat.id));
      if (flag && flag.lastFull && Date.now() - flag.lastFull < AUTO_STALE_MS) return;
      runSync(true); // full first time (flag empty), delta after
    } catch { /* next visit */ }
  }

  let unlocked = () => false;

  function init(adapter, isUnlocked) {
    plat = adapter && BY_ID[adapter.id] ? BY_ID[adapter.id] : null;
    unlocked = isUnlocked || (() => false);
    if (!plat) return;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[REQ_KEY] && changes[REQ_KEY].newValue) {
          onRequest(changes[REQ_KEY].newValue);
        }
      });
    } catch { /* storage API unavailable */ }
    setTimeout(maybeAutoSync, 12000); // long after page settle
  }

  self.LCTRecallSync = {
    init,
    get available() { return !!plat; },
    get platformId() { return plat ? plat.id : null; },
    syncNow: (full) => runSync(full !== false), // this-page manual trigger
    SUPPORTED
  };
})();
