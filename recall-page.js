/* Total Recall page — search the archive, import official exports, wipe.
   Runs as an extension page: talks to the background worker's IndexedDB via
   messages. No network anywhere (the extension has no network permissions). */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  const TRIAL_MS = 7 * 864e5;

  /* ---------- plan gating (search is Pro/trial; archive + import are not) */

  let unlocked = false;

  async function loadPlan() {
    const { license, trial } = await chrome.storage.local.get(["license", "trial"]);
    let pro = false;
    if (license && license.key) pro = (await self.LCTLicense.verify(license.key)).valid;
    const trialOn = !pro && trial && trial.startedAt && Date.now() < trial.startedAt + TRIAL_MS;
    unlocked = pro || trialOn;
    const badge = $("plan-badge");
    badge.textContent = pro ? "Pro" : trialOn ? "Trial" : "Free";
    badge.className = "badge " + (pro ? "pro" : trialOn ? "trial" : "");
    $("locked").hidden = unlocked;
    $("searchbox").hidden = !unlocked;
  }

  /* ---------- search ---------- */

  let queryTimer = null;

  function fmtWhen(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function row(res) {
    const div = document.createElement("div");
    div.className = "r-item";
    const top = document.createElement("div");
    top.className = "r-title";
    const badge = document.createElement("b");
    badge.textContent = res.platform || res.host;
    const title = document.createElement("span");
    title.textContent = res.title || "Untitled chat"; // data, never markup
    top.append(badge, title);
    const snip = document.createElement("div");
    snip.className = "r-snip";
    snip.textContent = res.snippet;
    const info = document.createElement("div");
    info.className = "r-info";
    info.textContent = `${res.n} messages · ${fmtWhen(res.updatedAt)}` +
      (res.createdAt ? ` · created ${fmtWhen(res.createdAt)}` : "");
    div.append(top, snip, info);
    div.addEventListener("click", async () => {
      // stash the query so the destination chat opens its in-chat search on it
      await chrome.storage.local.set({
        "recall-jump": { host: res.host, path: res.path, q: $("q").value.trim(), at: Date.now() }
      });
      window.open("https://" + res.host + res.path, "_blank", "noopener");
    });
    return div;
  }

  async function runQuery() {
    const q = $("q").value.trim();
    if (q.length < 2) { $("results").replaceChildren(); $("q-meta").textContent = ""; return; }
    const res = await send({ type: "recall-search", q });
    if (!res || res.err) return;
    $("results").replaceChildren(...res.results.map(row));
    $("q-meta").textContent = res.results.length
      ? `${res.results.length} chat${res.results.length === 1 ? "" : "s"}`
      : `no matches in ${res.scanned} chats`;
  }

  $("q").addEventListener("input", () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(runQuery, 200);
  });

  /* ---------- stats ---------- */

  async function loadStats() {
    const s = await send({ type: "recall-stats" });
    if (!s || s.err) return;
    const wrap = $("stats");
    wrap.replaceChildren();
    const mk = (num, label) => {
      const d = document.createElement("div");
      d.className = "stat";
      const b = document.createElement("b");
      b.textContent = num;
      const sp = document.createElement("span");
      sp.textContent = label;
      d.append(b, sp);
      return d;
    };
    wrap.append(
      mk(s.chats.toLocaleString(), "chats archived"),
      mk(s.msgs.toLocaleString(), "messages"),
      mk((s.bytes / 1048576).toFixed(1) + " MB", "on disk (text)")
    );
    for (const [p, n] of Object.entries(s.byPlatform).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      wrap.append(mk(String(n), p));
    }
  }

  /* ---------- import: official data exports, parsed 100% locally --------- */

  // Minimal zip reader — enough for export zips, using the browser's native
  // DecompressionStream. No libraries, no network.
  async function unzipEntry(buf, wantName) {
    const dv = new DataView(buf);
    // find End Of Central Directory (scan back for signature 0x06054b50)
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    let off = dv.getUint32(eocd + 16, true);
    const count = dv.getUint16(eocd + 10, true);
    const td = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = td.decode(new Uint8Array(buf, off + 46, nameLen));
      if (name.endsWith(wantName)) {
        // local header: its own name/extra lengths decide where data starts
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const data = new Uint8Array(buf, localOff + 30 + lNameLen + lExtraLen, csize);
        if (method === 0) return td.decode(data);
        if (method === 8) {
          const ds = new DecompressionStream("deflate-raw");
          const stream = new Blob([data]).stream().pipeThrough(ds);
          return await new Response(stream).text();
        }
        throw new Error("unsupported compression");
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(wantName + " not found in zip");
  }

  // ChatGPT export: conversations.json = [{title, create_time, update_time,
  // mapping: {id: {message: {author:{role}, create_time, content:{parts}}}}, id}]
  function parseChatGPT(arr) {
    const chats = [];
    for (const conv of arr) {
      try {
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
        const id = conv.conversation_id || conv.id;
        if (!id || msgs.length < 2) continue;
        chats.push({
          id: "chatgpt.com/c/" + id,
          host: "chatgpt.com",
          path: "/c/" + id,
          platform: "ChatGPT",
          title: conv.title || "",
          createdAt: conv.create_time ? Math.floor(conv.create_time * 1000) : 0,
          updatedAt: conv.update_time ? Math.floor(conv.update_time * 1000) : Date.now(),
          msgs
        });
      } catch { /* one bad conversation must not sink the import */ }
    }
    return chats;
  }

  // Claude export: conversations.json = [{uuid, name, created_at, updated_at,
  // chat_messages: [{sender: "human"|"assistant", text, created_at}]}]
  function parseClaude(arr) {
    const chats = [];
    for (const conv of arr) {
      try {
        const msgs = (conv.chat_messages || [])
          .map((m) => ({
            r: m.sender === "human" ? "user" : "assistant",
            t: String(m.text || "").trim(),
            ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0
          }))
          .filter((m) => m.t);
        if (!conv.uuid || msgs.length < 2) continue;
        chats.push({
          id: "claude.ai/chat/" + conv.uuid,
          host: "claude.ai",
          path: "/chat/" + conv.uuid,
          platform: "Claude",
          title: conv.name || "",
          createdAt: conv.created_at ? new Date(conv.created_at).getTime() : 0,
          updatedAt: conv.updated_at ? new Date(conv.updated_at).getTime() : Date.now(),
          msgs
        });
      } catch { /* skip bad conversation */ }
    }
    return chats;
  }

  function detectAndParse(text) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("unexpected format");
    if (!arr.length) return [];
    if (arr[0] && arr[0].mapping) return parseChatGPT(arr);
    if (arr[0] && arr[0].chat_messages) return parseClaude(arr);
    throw new Error("unrecognized export format");
  }

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const status = $("import-status");
    status.className = "";
    status.textContent = "Reading " + file.name + "…";
    try {
      let text;
      if (file.name.endsWith(".zip")) {
        text = await unzipEntry(await file.arrayBuffer(), "conversations.json");
      } else {
        text = await file.text();
      }
      const chats = detectAndParse(text);
      if (!chats.length) throw new Error("no conversations found in the file");
      status.textContent = `Importing ${chats.length} chats…`;
      let ok = 0, skipped = 0;
      for (let i = 0; i < chats.length; i += 25) { // chunk: keep messages small
        const r = await send({ type: "recall-import", chats: chats.slice(i, i + 25) });
        ok += (r && r.ok) || 0;
        skipped += (r && r.skipped) || 0;
      }
      status.className = "ok";
      status.textContent = `Imported ${ok} chats${skipped ? ` (${skipped} skipped)` : ""}. All local.`;
      loadStats();
    } catch (err) {
      status.className = "err";
      status.textContent = "Import failed: " + err.message +
        " — expected a ChatGPT or Claude data export (.zip or conversations.json).";
    }
    e.target.value = "";
  });

  /* ---------- sync all history (storage-bus orchestration) ----------
     This page can't fetch chatgpt.com / claude.ai (wrong origin), so it asks
     the open app tabs to do it: writes a request to storage, each app's
     content script runs its same-origin sync and streams progress back
     through storage. Apps with no open tab get an "Open & sync" link. */

  const APPS = [
    { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/" },
    { id: "claude", label: "Claude", url: "https://claude.ai/" }
  ];
  const progKey = (id) => "recall-sync-progress:" + id;
  const respondedAt = {}; // id -> ms of last progress update this run
  let syncRunAt = 0;

  function pct(p) {
    if (!p || !p.total) return "";
    return " (" + Math.min(100, Math.round((p.done / p.total) * 100)) + "%)";
  }

  function renderRow(app) {
    let row = document.getElementById("sync-row-" + app.id);
    if (!row) {
      row = document.createElement("div");
      row.id = "sync-row-" + app.id;
      row.className = "sync-row";
      $("sync-rows").appendChild(row);
    }
    return row;
  }

  function paintRow(app, p, waiting) {
    const row = renderRow(app);
    row.replaceChildren();
    const name = document.createElement("b");
    name.textContent = app.label;
    const status = document.createElement("span");
    status.className = "sync-status";
    if (p && p.state === "error") { status.textContent = p.msg; status.classList.add("err"); }
    else if (p && p.state === "locked") { status.textContent = p.msg; }
    else if (p && p.state === "done") { status.textContent = p.msg; status.classList.add("ok"); }
    else if (p) { status.textContent = (p.msg || "Syncing…") + pct(p); }
    else if (waiting) { status.textContent = "Waiting for the app…"; }
    row.append(name, status);
    // no live tab responded → offer to open it (it auto-syncs on load)
    if (waiting && (!p || Date.now() - (p.at || 0) > 3500)) {
      const open = document.createElement("button");
      open.className = "sync-open";
      open.textContent = "Open & sync";
      open.addEventListener("click", () => window.open(app.url, "_blank", "noopener"));
      row.appendChild(open);
    }
  }

  async function refreshSyncRows() {
    const keys = APPS.map((a) => progKey(a.id));
    const store = await chrome.storage.local.get(keys);
    for (const app of APPS) {
      const p = store[progKey(app.id)];
      const fresh = p && p.at >= syncRunAt;
      paintRow(app, fresh ? p : null, true);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !syncRunAt) return;
    if (APPS.some((a) => changes[progKey(a.id)])) {
      refreshSyncRows();
      loadStats(); // numbers climb live as chats land
    }
  });

  $("sync-all").addEventListener("click", async () => {
    syncRunAt = Date.now();
    await chrome.storage.local.set({
      "recall-sync-request": { at: syncRunAt, apps: ["all"], full: true }
    });
    $("sync-rows").replaceChildren();
    for (const app of APPS) paintRow(app, null, true);
    // re-check after the grace window so "Open & sync" appears for closed apps
    setTimeout(refreshSyncRows, 3800);
    setTimeout(loadStats, 4000);
  });

  /* ---------- wipe (two clicks — no confirm() popups) ---------- */

  let armed = false;
  $("wipe").addEventListener("click", async () => {
    const btn = $("wipe");
    if (!armed) {
      armed = true;
      btn.classList.add("armed");
      btn.textContent = "Click again to permanently delete";
      setTimeout(() => {
        armed = false;
        btn.classList.remove("armed");
        btn.textContent = "Delete my archive";
      }, 4000);
      return;
    }
    await send({ type: "recall-wipe" });
    armed = false;
    btn.classList.remove("armed");
    btn.textContent = "Delete my archive";
    loadStats();
    $("results").replaceChildren();
    $("q-meta").textContent = "";
  });

  loadPlan().then(() => { loadStats(); $("q").focus(); });
})();
