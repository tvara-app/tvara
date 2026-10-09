/**
 * Tvara — in-chat search.
 * Cmd/Ctrl+Shift+F: instant full-text search across EVERY message in the
 * conversation — including messages the speed engine has put to sleep
 * (we search cached text, not the rendered page, so a 2,000-message chat
 * searches in a few milliseconds). Enter = next, Shift+Enter = previous,
 * Esc = close. Jumping wakes the target message and pulses it.
 */
(() => {
  "use strict";

  let adapter = null;
  let bar = null, input = null, counter = null;
  let items = [];      // [{el, text}]
  let hits = [];       // indexes into items
  let cur = -1;
  let isOpen = false;
  let debounceTimer = null;
  let lastHit = null;
  const textCache = new WeakMap(); // el -> lowercased text

  /* ---------- the rest of the conversation ----------
     Measured on a live 1,471-message ChatGPT thread: "isaac" appears in 217
     messages and this bar found 8, because the host had mounted 195 of them.
     Everything about that is technically correct and it is still a search that
     does not work — nobody asks a 1,400-message chat a question and accepts
     eight answers.

     The archive on this machine has every word of it, so the bar asks there
     too, and the minimap's existing seek walks the reader to a hit the page has
     never rendered. Where there is no archived copy the bar behaves exactly as
     it did: what is loaded, honestly counted. */
  let remote = { q: "", hits: [], total: 0, ready: false };
  let remoteToken = 0;

  /* Ask when the page is holding LESS than the conversation — OR when there is
     no reliable way to know that. The minimap's catalog can only prove "there
     is more" on hosts with a stable per-message id (ChatGPT, Gemini): there it
     is seeded from the provider's own index and legitimately outgrows `items`.
     On hosts with neither id shape (Claude, DeepSeek, Grok, Perplexity —
     see adapters.js stableKey()) the catalog itself is just a mirror of
     whatever is currently mounted, so `count > items.length` can be true on
     ChatGPT/Gemini and is close to always FALSE there even on a 1,000-message
     chat — silently skipping the archive on exactly the hosts that need it
     most. A host the adapter already declares `virtualizes: true` is asked
     unconditionally instead of trusting a catalog count that cannot be. */
  const canAskArchive = () =>
    !!(self.LCTMinimap && self.LCTMinimap.count > items.length) ||
    !!(adapter && adapter.virtualizes);

  function askArchive(q) {
    const token = ++remoteToken;
    remote = { q, hits: [], total: 0, ready: false };
    try {
      chrome.runtime.sendMessage({
        type: "chat-search", host: location.hostname, path: location.pathname, q
      }, (res) => {
        void chrome.runtime.lastError;
        if (token !== remoteToken) return;            // a newer query won
        /* "no-index" is not "no matches": the archive holds this conversation
           but its messages carry no provider ids, so the deep search could not
           run. The count that follows is the page's, and says so. */
        remoteBlind = !!(res && res.status === "no-index");
        if (!res || res.status !== "ok") { remote.ready = true; return updateCounter(); }
        remoteBlind = false;
        remote = { q, hits: res.hits || [], total: res.total || 0, ready: true };
        // Re-merge WITHOUT moving the reader: they are already reading a hit.
        mergeRemote();
        updateCounter();
      });
    } catch { remote.ready = true; }
  }

  /**
   * Fold the archive's answer into the hit list, using the provider's own
   * message ids so a message that is both mounted and archived is one hit.
   * Archive order is conversation order, which is the order a reader expects;
   * anything mounted that the archive has never seen is newer than the last
   * sync, so it belongs at the end.
   */
  function mergeRemote() {
    if (!remote.ready || !remote.hits.length) return;
    const byId = new Map();
    for (const idx of hits) {
      const el = items[idx] && items[idx].el;
      const key = el && self.LCTAdapters.stableKey ? self.LCTAdapters.stableKey(el) : "";
      if (key) byId.set(key, idx);
    }
    const merged = [];
    const used = new Set();
    for (const h of remote.hits) {
      const idx = byId.get(h.i);
      if (idx !== undefined) { merged.push({ dom: idx }); used.add(idx); }
      else merged.push({ id: h.i, snippet: h.s, role: h.r });
    }
    for (const idx of hits) if (!used.has(idx)) merged.push({ dom: idx });
    ordered = merged;
  }

  // When the archive has answered, `ordered` is the list the reader steps
  // through; until then it mirrors the mounted hits.
  let ordered = [];

  function init(a) { adapter = a; }

  function buildCache(msgs) {
    try {
      const arr = msgs || adapter.messages();
      // cache per element; only the streaming tail can change content
      items = arr.map((el, i) => {
        let text = textCache.get(el);
        if (text === undefined || i >= arr.length - 5) {
          text = (el.textContent || "").toLowerCase();
          textCache.set(el, text);
        }
        return { el, text };
      });
    } catch (_) {
      items = [];
    }
  }

  function ensureBar() {
    if (bar) return;
    bar = document.createElement("div");
    bar.id = "lct-search";
    bar.innerHTML = `
      <span class="lct-s-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></span>
      <input type="text" placeholder="Search this conversation…" spellcheck="false" />
      <span class="lct-s-count"></span>
      <button class="lct-s-prev" title="Previous (Shift+Enter)">↑</button>
      <button class="lct-s-next" title="Next (Enter)">↓</button>
      <button class="lct-s-close" title="Close (Esc)">✕</button>
    `;
    document.documentElement.appendChild(bar);
    input = bar.querySelector("input");
    counter = bar.querySelector(".lct-s-count");

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runQuery, 140);
    });
    // Key shield at the WINDOW capture phase: host apps register document-level
    // capture handlers ("type anywhere to focus composer", "Esc stops
    // generation") that would fire before any listener on our input. Window
    // capture runs before all of them.
    const shield = (e) => {
      if (!isOpen || !bar || !bar.contains(e.target)) return;
      if (e.type === "keydown") {
        if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? step(-1) : step(1); }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
      }
      e.stopPropagation();
    };
    for (const type of ["keydown", "keypress", "keyup"]) {
      window.addEventListener(type, shield, true);
    }
    bar.querySelector(".lct-s-prev").addEventListener("click", () => step(-1));
    bar.querySelector(".lct-s-next").addEventListener("click", () => step(1));
    bar.querySelector(".lct-s-close").addEventListener("click", close);
  }

  /** 1 char is a real query in CJK scripts; require 2 only for ASCII. */
  function longEnough(q) {
    // Asking the code point directly says what this means — "not ASCII" —
    // without putting a NUL into a character class to express it.
    return q.length >= 2 || (q.length === 1 && q.codePointAt(0) > 0x7f);
  }

  /**
   * @param {Element} [keep] stay on this hit instead of jumping to the first.
   *   A refresh must not move the reader: re-running the query on every engine
   *   tick used to call step(1), which yanked the page back to hit 1 roughly
   *   four times a second while a chat was still streaming.
   */
  function runQuery(keep) {
    const q = input.value.trim().toLowerCase();
    hits = [];
    cur = -1;
    if (longEnough(q)) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].text.includes(q)) hits.push(i);
      }
      if (canAskArchive() && remote.q !== q) askArchive(q);
    } else {
      remoteToken++;                       // cancel any answer still in flight
      remote = { q: "", hits: [], total: 0, ready: false };
    }
    ordered = hits.map((i) => ({ dom: i }));
    if (remote.ready && remote.q === q) mergeRemote();
    if (keep) {
      // The kept hit can have been unmounted out from under us — fall to the
      // first match rather than to "0 of 5", but still never scroll.
      const at = keep && keep.keyId
        ? ordered.findIndex((o) => o.id === keep.keyId)
        : ordered.findIndex((o) => o.dom !== undefined && items[o.dom].el === keep);
      cur = at >= 0 ? at : ordered.length ? 0 : -1;
      return updateCounter();
    }
    if (ordered.length) step(1);
    else updateCounter();
  }

  function step(dir) {
    if (!ordered.length) return updateCounter();
    cur = (cur + dir + ordered.length) % ordered.length;
    updateCounter();
    const at = ordered[cur];
    if (at.dom !== undefined) return jumpTo(items[at.dom].el);
    /* A hit the page has never rendered. The minimap already knows how to walk
       to one of those — it shows the message immediately from the index and
       lets the host catch up behind the preview. */
    const went = self.LCTMinimap.jumpToKey("id:" + at.id);
    if (!went && self.LCTNote) {
      self.LCTNote("That message is further back than this page has loaded.");
    }
  }

  let remoteBlind = false;

  function updateCounter() {
    const active = longEnough(input.value.trim());
    const n = ordered.length;
    counter.textContent = n ? `${cur + 1}/${n}` : (active ? "0/0" : "");
    // Say where the answer came from, because "8" and "217" are different
    // answers to the same question and the reader deserves to know which.
    const beyond = ordered.filter((o) => o.dom === undefined).length;
    counter.title = beyond
      ? `${n - beyond} on this page, ${beyond} further back in this conversation`
      : (remoteBlind && active
        ? `${n} on this page. The rest of this conversation is backed up but not ` +
          `searchable yet: this platform's history does not carry message ids.`
        : "");
    counter.classList.toggle("lct-s-deep", beyond > 0);
    counter.classList.toggle("lct-s-none", !n && active);
  }

  // Delegated to nav.js. The copy that lived here never woke the target, so it
  // landed short across sleeping regions, and re-adding lct-hit to an element
  // that already had it never restarted the pulse — stepping onto the same hit
  // twice showed nothing at all.
  function jumpTo(el) {
    if (!el || !el.isConnected) return;
    if (lastHit && lastHit !== el) lastHit.classList.remove("lct-hit");
    lastHit = el;
    self.LCTNav.jumpTo(el, { block: "center" });
  }

  function open(prefill) {
    ensureBar();
    cacheSig = "";        // whatever the last session saw, re-sync on next tick
    buildCache();
    bar.classList.add("lct-s-open");
    isOpen = true;
    if (typeof prefill === "string" && prefill) {
      input.value = prefill; // Total Recall hands off its query on arrival
      runQuery();
    }
    input.focus();
    input.select();
  }

  function close() {
    if (!bar) return;
    bar.classList.remove("lct-s-open");
    isOpen = false;
    if (lastHit) { lastHit.classList.remove("lct-hit"); lastHit = null; }
    /* A hit further back than the page has loaded opens the message panel to
       show it. Closing search left that panel over half the conversation,
       taking the clicks meant for the chat (found on a real ChatGPT thread).
       Done searching is done with what the search opened. */
    try { if (self.LCTHistoryPanel && self.LCTHistoryPanel.isOpen) self.LCTHistoryPanel.close(); } catch (_) { /* not built */ }
    input.blur();
  }

  function toggle() { isOpen ? close() : open(); }

  // Keep the cache fresh if new messages stream in while the bar is open.
  // Gated on a cheap signature: this fires on every engine tick, and rebuilding
  // the cache plus re-scanning every message's text is real work to do four
  // times a second for a conversation that has not changed.
  let cacheSig = "";

  // `msgs`: the list the engine just scanned. Re-querying the document for a
  // list the caller is already holding cost a full selector sweep per tick for
  // as long as the bar stayed open. Falls back for any caller without one.
  function refresh(msgs) {
    if (!isOpen) return;
    if (!msgs) {
      try { msgs = adapter.messages(); } catch (_) { return; }
    }
    const last = msgs[msgs.length - 1];
    const sig = msgs.length + ":" + (last ? (last.textContent || "").length : 0);
    if (sig === cacheSig) return;
    cacheSig = sig;
    /* `cur` indexes `ordered`, not `hits` — once the archive has answered they
       are different lists and `ordered` is much the longer of the two. Reading
       hits[cur] therefore resolved to an unrelated message, or to nothing at
       all, and runQuery(null) fell through to step(1): the reader was yanked
       back to the first hit several times a second while a reply streamed.
       A hit the page has never mounted has no element, so it is kept by id. */
    const held = cur >= 0 ? ordered[cur] : null;
    const at = !held ? null
      : (held.dom !== undefined ? items[held.dom].el : { keyId: held.id });
    buildCache(msgs);
    runQuery(at);
  }

  self.LCTSearch = { init, open, close, toggle, refresh, get isOpen() { return isOpen; } };
})();
