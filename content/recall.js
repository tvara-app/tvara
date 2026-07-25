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
  let queryToken = 0;

  const SEARCH_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "lct-recall";
    const head = document.createElement("div");
    head.className = "lct-r-head";
    const icon = document.createElement("span");
    icon.className = "lct-r-icon";
    icon.innerHTML = SEARCH_ICON; // static literal above, never user or archive text
    input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search every chat on every platform…";
    input.autocomplete = "off";
    input.spellcheck = false;
    meta = document.createElement("span");
    meta.className = "lct-r-meta";
    const scan = document.createElement("i");
    scan.className = "lct-r-scan";
    head.append(icon, input, meta, scan);
    list = document.createElement("div");
    list.className = "lct-r-list";
    const foot = document.createElement("div");
    foot.className = "lct-r-foot";
    const keys = document.createElement("span");
    keys.className = "lct-r-keys";
    for (const [k, label] of [["↑↓", "navigate"], ["↵", "open"], ["esc", "close"]]) {
      const hint = document.createElement("span");
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      const txt = document.createElement("i");
      txt.textContent = label;
      hint.append(kbd, txt);
      keys.appendChild(hint);
    }
    const footNote = document.createElement("span");
    footNote.className = "lct-r-note";
    footNote.textContent = "Stored on this device only";
    foot.append(keys, footNote);
    // The worker owns full-history sync. This control only asks it to check
    // the durable delta, so opening or reloading a chat tab cannot duplicate
    // a provider-wide sweep.
    if (["chatgpt", "claude", "deepseek", "grok"].includes(adapter && adapter.id)) {
      const syncBtn = document.createElement("button");
      syncBtn.id = "lct-r-sync";
      syncBtn.textContent = "Check archive";
      syncBtn.addEventListener("click", () => {
        syncBtn.disabled = true;
        footNote.textContent = "Checking for new chats…";
        chrome.runtime.sendMessage({ type: "recall-bg-sync" }, (r) => {
          void chrome.runtime.lastError;
          syncBtn.disabled = false;
          footNote.textContent = r && r.status === "restore-required"
            ? "Restore your encrypted archive in Total Recall before checking the gap."
            : "Archive check is running in the background.";
          runQuery();
        });
      });
      foot.appendChild(syncBtn);
    }
    panel.append(head, list, foot);
    document.documentElement.appendChild(panel);

    input.addEventListener("input", () => {
      // the caret state reacts immediately; the query itself stays debounced
      panel.classList.toggle("lct-r-typing", input.value.trim().length > 0);
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
    // the panel's height is measured, not guessed — re-measure when the
    // viewport does, so the list keeps filling the space it is allowed.
    window.addEventListener("resize", () => { if (isOpen) sizeList(); });
    list.addEventListener("scroll", fadeEdge, { passive: true });
  }

  /* ---------- the list grows to fit what it found ---------- */

  // A fixed max-height showed 2-3 rows on short viewports. Measuring the real
  // content and capping it lets the panel animate open to exactly the size the
  // results need — six-plus rows when there are six-plus results.
  function sizeList() {
    if (!list) return;
    const cap = Math.max(220, Math.min(window.innerHeight * 0.62, 620));
    list.style.maxHeight = Math.min(list.scrollHeight, cap) + "px";
    fadeEdge();
  }

  /** Show the bottom fade only while there is something below the fold. */
  function fadeEdge() {
    if (!panel || !list) return;
    const more = list.scrollHeight - list.scrollTop - list.clientHeight > 2;
    panel.classList.toggle("lct-r-more", more);
  }

  function fill(nodes) {
    list.replaceChildren(...nodes);
    panel.classList.add("lct-r-filled");
    list.scrollTop = 0;
    // measure after the padding class has landed, before paint
    requestAnimationFrame(sizeList);
  }

  function showState(title, detail) {
    // typing the first character must not replay the entrance animation
    const shown = list.firstElementChild;
    if (shown && shown.dataset.state === title + " " + detail) return;
    const box = document.createElement("div");
    box.className = "lct-r-state";
    box.dataset.state = title + " " + detail;
    const h = document.createElement("strong");
    h.textContent = title;
    const p = document.createElement("span");
    p.textContent = detail;
    box.append(h, p);
    fill([box]);
  }

  function fmtWhen(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  const PLATFORMS = ["chatgpt", "claude", "gemini", "perplexity", "deepseek", "grok"];
  function platformKey(res) {
    const raw = (String(res.platform || "") + " " + String(res.host || "")).toLowerCase();
    return PLATFORMS.find((p) => raw.includes(p)) || "other";
  }

  function terms(q) {
    return q.toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 6);
  }

  /** Paint the matched words inside `text` without ever parsing markup: every
   *  piece is appended as a text node, so archive text stays data. */
  function paint(el, text, toks) {
    el.replaceChildren();
    if (!toks.length) { el.textContent = text; return; }
    const hay = text.toLowerCase();
    let i = 0;
    while (i < text.length) {
      let at = -1, len = 0;
      for (const t of toks) {
        const found = hay.indexOf(t, i);
        if (found === -1) continue;
        if (at === -1 || found < at || (found === at && t.length > len)) { at = found; len = t.length; }
      }
      if (at === -1) { el.appendChild(document.createTextNode(text.slice(i))); return; }
      if (at > i) el.appendChild(document.createTextNode(text.slice(i, at)));
      const hit = document.createElement("mark");
      hit.className = "lct-r-hit";
      hit.textContent = text.slice(at, at + len);
      el.appendChild(hit);
      i = at + len;
    }
  }

  function row(res, idx, toks) {
    const div = document.createElement("div");
    div.className = "lct-r-item";
    div.dataset.idx = idx;
    div.dataset.platform = platformKey(res);
    div.style.setProperty("--i", Math.min(idx, 12)); // stagger, capped so long lists don't crawl

    const top = document.createElement("div");
    top.className = "lct-r-top";
    const badge = document.createElement("b");
    badge.className = "lct-r-badge";
    badge.textContent = res.platform || res.host;
    const title = document.createElement("span");
    title.className = "lct-r-name";
    paint(title, res.title || "Untitled chat", toks);
    // messages + dates ride on the title line so a result costs two lines,
    // not three — the difference between 3 visible results and 7.
    const when = document.createElement("span");
    when.className = "lct-r-when";
    when.textContent = `${res.n} messages · ${fmtWhen(res.updatedAt)}`;
    if (res.createdAt) {
      const born = document.createElement("i");
      born.className = "lct-r-born";
      born.textContent = ` · created ${fmtWhen(res.createdAt)}`;
      when.appendChild(born); // revealed on the selected row only — no reflow
    }
    top.append(badge, title, when);

    const snip = document.createElement("div");
    snip.className = "lct-r-snip";
    paint(snip, res.snippet || "", toks);

    div.append(top, snip);
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
    fadeEdge();
  }

  function runQuery() {
    const q = input.value.trim();
    panel.classList.toggle("lct-r-typing", q.length > 0);
    // A stale reply must never repaint a newer query's results.
    const token = ++queryToken;
    if (q.length < 2) {
      lastResults = [];
      selIdx = -1;
      meta.textContent = "";
      panel.classList.remove("lct-r-busy");
      showState("Every chat you've ever had",
        "Type two characters to search ChatGPT, Claude, Gemini, Perplexity, DeepSeek and Grok at once.");
      return;
    }
    panel.classList.add("lct-r-busy");
    try {
      chrome.runtime.sendMessage({ type: "recall-search", q }, (res) => {
        if (token !== queryToken) return;
        panel.classList.remove("lct-r-busy");
        if (chrome.runtime.lastError || !res || res.err) return;
        lastResults = (res.results || []).slice(0, SHOW_LIMIT);
        if (!lastResults.length) {
          meta.textContent = "";
          selIdx = -1;
          showState("No matches",
            `Nothing in ${res.scanned} archived chat${res.scanned === 1 ? "" : "s"} mentions “${q}”.`);
          return;
        }
        const toks = terms(q);
        fill(lastResults.map((r, i) => row(r, i, toks)));
        meta.textContent = `${lastResults.length}${lastResults.length === SHOW_LIMIT ? "+" : ""} chat${lastResults.length === 1 ? "" : "s"}`;
        select(0);
        requestAnimationFrame(sizeList);
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
    runQuery(); // re-runs a kept query, or paints the resting state
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("lct-r-open", "lct-r-busy");
    isOpen = false;
    input.blur();
  }

  function init(theAdapter, isUnlocked) {
    adapter = theAdapter;
    unlocked = isUnlocked;
    // opening is driven by the browser commands API (see main.js)
    completeJump();
  }

  self.LCTRecall = { init, update, open, close, get isOpen() { return isOpen; } };
})();
