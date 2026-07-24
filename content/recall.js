/**
 * Long Chat Toolkit — Total Recall (content side).
 *
 * 1) INDEXER: mirrors the current conversation's text to the extension's
 *    local archive (background IndexedDB) — throttled, hash-guarded, always on
 *    (so a user who upgrades later doesn't start with an empty archive; the
 *    data never leaves the machine and is one-click deletable).
 * 2) OVERLAY: ⌘⇧K / Ctrl+Shift+K — search EVERY archived chat from every
 *    platform, jump straight to the one you meant. Pro/trial feature.
 */
(() => {
  "use strict";

  const WRITE_EVERY = 3000;
  const SHOW_LIMIT = 40;

  let adapter = null;
  let unlocked = () => false;
  let latest = null;
  let writeTimer = null;
  let lastSig = "";
  let lastPreSig = "";

  /* ---------- indexer ---------- */

  function titleOf(messages) {
    const t = (document.title || "")
      .replace(/ [-–—|•·] (ChatGPT|Claude|Gemini|Perplexity|DeepSeek|Grok).*$/i, "")
      .replace(/^(ChatGPT|Claude|Gemini|Perplexity|DeepSeek|Grok)\s*[-–—|•·]?\s*/i, "")
      .trim();
    if (t && t.length > 2) return t;
    for (const el of messages) {
      try {
        if (adapter.role(el) === "user") {
          const txt = (el.textContent || "").trim();
          if (txt) return txt.slice(0, 80);
        }
      } catch { /* adapter guard */ }
    }
    return "Untitled chat";
  }

  // Prefer real content blocks over raw textContent: chat sites embed role
  // labels ("You said:", sr-only headers) that would pollute every snippet.
  // Falls back to full text when a message has no block structure.
  const BLOCK_SEL = "p, h1, h2, h3, h4, li, pre, blockquote";
  function textOf(el) {
    const blocks = el.querySelectorAll(BLOCK_SEL);
    if (!blocks.length) return (el.textContent || "").trim();
    const parts = [];
    for (const b of blocks) {
      const anc = b.parentElement && b.parentElement.closest(BLOCK_SEL);
      if (anc && el.contains(anc)) continue; // nested — its parent block covers it
      const t = (b.textContent || "").trim();
      if (t) parts.push(t);
    }
    return parts.join("\n") || (el.textContent || "").trim();
  }

  function update(messages) {
    latest = messages;
    if (writeTimer) return;
    writeTimer = setTimeout(flush, WRITE_EVERY);
  }

  function flush() {
    writeTimer = null;
    const msgs = latest;
    if (!msgs || msgs.length < 2) return;
    // cheap pre-check BEFORE the expensive full-text extraction
    const preSig = msgs.length + ":" + ((msgs[msgs.length - 1].textContent || "").length);
    if (preSig === lastPreSig) return;
    lastPreSig = preSig;
    if (!adapter.convPath || !adapter.convPath.test(location.pathname)) {
      // not a conversation URL (home page, settings…) — index nothing
      if (adapter.id !== "synthetic") return;
    }

    const out = [];
    for (const el of msgs) {
      let role = "assistant";
      try { role = adapter.role(el) === "user" ? "user" : "assistant"; } catch { /* guard */ }
      const inf = self.LCTTimeline.info(el);
      out.push({
        r: role,
        t: textOf(el),
        ts: inf && inf.kind === "exact" ? inf.t : 0
      });
    }

    // cheap change signature — skip the (serialize + IPC + IDB) cost when idle
    const sig = out.length + ":" + (out[out.length - 1].t.length) + ":" + (out[0].t.length);
    if (sig === lastSig) return;
    lastSig = sig;

    try {
      chrome.runtime.sendMessage({
        type: "recall-upsert",
        chat: {
          id: location.hostname + location.pathname,
          host: location.hostname,
          path: location.pathname,
          platform: adapter.label,
          title: titleOf(msgs),
          createdAt: (self.LCTTimeline.earliest() || 0) * 1000,
          msgs: out
        }
      }, () => void chrome.runtime.lastError); // SW asleep/reloading — next flush catches up
    } catch { /* extension reloading — never break the host page */ }
  }

  /* ---------- overlay ---------- */

  let panel = null, input = null, list = null, meta = null;
  let isOpen = false;
  let selIdx = -1;
  let lastResults = [];
  let queryTimer = null;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "lct-recall";
    const head = document.createElement("div");
    head.className = "lct-r-head";
    input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search every chat on every platform…";
    input.autocomplete = "off";
    input.spellcheck = false;
    meta = document.createElement("span");
    meta.className = "lct-r-meta";
    head.append(input, meta);
    list = document.createElement("div");
    list.className = "lct-r-list";
    const foot = document.createElement("div");
    foot.className = "lct-r-foot";
    const footNote = document.createElement("span");
    footNote.textContent = "Total Recall searches chats you've opened (or imported) — all stored on this device only.";
    foot.appendChild(footNote);
    // On a supported app page: sync THIS app's full history from its own
    // same-origin API (the user's data, landing only in the local archive).
    if (self.LCTRecallSync && self.LCTRecallSync.available) {
      const syncBtn = document.createElement("button");
      syncBtn.id = "lct-r-sync";
      const label = self.LCTRecallSync.platformId === "claude" ? "Claude" : "ChatGPT";
      syncBtn.textContent = "Sync full " + label + " history";
      syncBtn.addEventListener("click", () => {
        syncBtn.disabled = true;
        footNote.textContent = "Syncing… you can keep working.";
        self.LCTRecallSync.syncNow(true).then((r) => {
          syncBtn.disabled = false;
          footNote.textContent = r && r.ok ? `Synced ${r.count} chats — all local.` : (r && r.err) || "Sync finished.";
          runQuery();
        });
      });
      foot.appendChild(syncBtn);
    }
    panel.append(head, list, foot);
    document.documentElement.appendChild(panel);

    input.addEventListener("input", () => {
      clearTimeout(queryTimer);
      queryTimer = setTimeout(runQuery, 200);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter" && selIdx >= 0) { e.preventDefault(); go(lastResults[selIdx]); }
    });
    panel.addEventListener("mousedown", (e) => e.stopPropagation());
    document.addEventListener("mousedown", () => { if (isOpen) close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) { e.stopPropagation(); close(); }
    }, true);
  }

  function fmtWhen(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function row(res, idx) {
    const div = document.createElement("div");
    div.className = "lct-r-item";
    div.dataset.idx = idx;
    const top = document.createElement("div");
    top.className = "lct-r-title";
    const title = document.createElement("span");
    title.textContent = res.title || "Untitled chat";
    const badge = document.createElement("b");
    badge.textContent = res.platform || res.host;
    top.append(badge, title);
    const snip = document.createElement("div");
    snip.className = "lct-r-snip";
    snip.textContent = res.snippet; // archive text is data, never markup
    const info = document.createElement("div");
    info.className = "lct-r-info";
    info.textContent =
      `${res.n} messages · ${fmtWhen(res.updatedAt)}` +
      (res.createdAt ? ` · created ${fmtWhen(res.createdAt)}` : "");
    div.append(top, snip, info);
    div.addEventListener("click", () => go(res));
    div.addEventListener("mouseenter", () => select(idx));
    return div;
  }

  function select(i) {
    selIdx = i;
    for (const el of list.children) el.classList.toggle("lct-r-sel", +el.dataset.idx === i);
  }

  function move(d) {
    if (!lastResults.length) return;
    select((selIdx + d + lastResults.length) % lastResults.length);
    const el = list.children[selIdx];
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function runQuery() {
    const q = input.value.trim();
    if (q.length < 2) {
      list.replaceChildren();
      meta.textContent = "";
      lastResults = [];
      selIdx = -1;
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "recall-search", q }, (res) => {
        if (chrome.runtime.lastError || !res || res.err) return;
        lastResults = (res.results || []).slice(0, SHOW_LIMIT);
        list.replaceChildren(...lastResults.map(row));
        meta.textContent = lastResults.length
          ? `${lastResults.length} chat${lastResults.length === 1 ? "" : "s"}`
          : `no matches in ${res.scanned} archived chats`;
        select(lastResults.length ? 0 : -1);
      });
    } catch { /* extension reloading */ }
  }

  function go(res) {
    if (!res) return;
    const q = input.value.trim();
    close();
    if (res.host === location.hostname && res.path === location.pathname) {
      self.LCTSearch.open(q); // already here — drop into in-chat search
      return;
    }
    // other chat (possibly other platform): stash the query, then navigate.
    // The destination tab's content script finds the stash and opens in-chat
    // search there — landing you on the exact text, not just the chat.
    try {
      chrome.storage.local.set({
        "recall-jump": { host: res.host, path: res.path, q, at: Date.now() }
      }, () => {
        location.href = "https://" + res.host + res.path;
      });
    } catch {
      location.href = "https://" + res.host + res.path;
    }
  }

  async function completeJump() {
    // arriving side of go(): same-tab navigation or a fresh tab on the target
    try {
      const { "recall-jump": j } = await chrome.storage.local.get("recall-jump");
      if (!j || j.host !== location.hostname || j.path !== location.pathname) return;
      if (Date.now() - j.at > 90000) { chrome.storage.local.remove("recall-jump"); return; }
      chrome.storage.local.remove("recall-jump");
      setTimeout(() => self.LCTSearch.open(j.q), 1200); // let the chat mount
    } catch { /* storage unavailable */ }
  }

  function open() {
    ensurePanel();
    panel.classList.add("lct-r-open");
    isOpen = true;
    input.focus();
    input.select();
    if (input.value) runQuery();
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("lct-r-open");
    isOpen = false;
    input.blur();
  }

  function onKey(e) {
    const k = (e.key || "").toLowerCase();
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "k") {
      if (!unlocked()) return; // locked: the popup explains Total Recall
      e.preventDefault();
      e.stopPropagation();
      isOpen ? close() : open();
    }
  }

  function init(theAdapter, isUnlocked) {
    adapter = theAdapter;
    unlocked = isUnlocked;
    addEventListener("keydown", onKey, true);
    completeJump();
  }

  self.LCTRecall = { init, update, open, close, get isOpen() { return isOpen; } };
})();
