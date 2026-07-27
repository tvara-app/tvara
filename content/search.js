/**
 * Long Chat Toolkit — in-chat search.
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
    return q.length >= 2 || (q.length === 1 && /[^\u0000-\u007f]/.test(q));
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
    }
    if (keep) {
      // The kept hit can have been unmounted out from under us — fall to the
      // first match rather than to "0 of 5", but still never scroll.
      const at = hits.findIndex((i) => items[i].el === keep);
      cur = at >= 0 ? at : hits.length ? 0 : -1;
      return updateCounter();
    }
    if (hits.length) step(1);
    else updateCounter();
  }

  function step(dir) {
    if (!hits.length) return updateCounter();
    cur = (cur + dir + hits.length) % hits.length;
    updateCounter();
    jumpTo(items[hits[cur]].el);
  }

  function updateCounter() {
    const active = longEnough(input.value.trim());
    counter.textContent = hits.length ? `${cur + 1}/${hits.length}` : (active ? "0/0" : "");
    counter.classList.toggle("lct-s-none", !hits.length && active);
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
    input.blur();
  }

  function toggle() { isOpen ? close() : open(); }

  // Keep the cache fresh if new messages stream in while the bar is open.
  // Gated on a cheap signature: this fires on every engine tick, and rebuilding
  // the cache plus re-scanning every message's text is real work to do four
  // times a second for a conversation that has not changed.
  let cacheSig = "";

  function refresh() {
    if (!isOpen) return;
    let msgs;
    try { msgs = adapter.messages(); } catch (_) { return; }
    const last = msgs[msgs.length - 1];
    const sig = msgs.length + ":" + (last ? (last.textContent || "").length : 0);
    if (sig === cacheSig) return;
    cacheSig = sig;
    const at = cur >= 0 && hits[cur] !== undefined ? items[hits[cur]].el : null;
    buildCache(msgs);
    runQuery(at);
  }

  self.LCTSearch = { init, open, close, toggle, refresh, get isOpen() { return isOpen; } };
})();
