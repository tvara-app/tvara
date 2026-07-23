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

  function buildCache() {
    try {
      // cache per element; only the streaming tail can change content
      items = adapter.messages().map((el, i, arr) => {
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

  function runQuery() {
    const q = input.value.trim().toLowerCase();
    hits = [];
    cur = -1;
    if (longEnough(q)) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].text.includes(q)) hits.push(i);
      }
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

  function jumpTo(el) {
    if (!el || !el.isConnected) return;
    // settle loop: first scroll estimate lands short across sleeping regions
    let tries = 0;
    const step = () => {
      el.scrollIntoView({ behavior: "auto", block: "center" });
      const r = el.getBoundingClientRect();
      const centered =
        r.height > 0 &&
        Math.abs(r.top + r.height / 2 - innerHeight / 2) <= Math.max(80, r.height / 2);
      if (!centered && ++tries < 8) requestAnimationFrame(step);
    };
    step();
    if (lastHit) lastHit.classList.remove("lct-hit");
    el.classList.add("lct-hit");
    lastHit = el;
    setTimeout(() => { if (lastHit === el) { el.classList.remove("lct-hit"); lastHit = null; } }, 1600);
  }

  function open(prefill) {
    ensureBar();
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

  // keep the cache fresh if new messages stream in while the bar is open
  function refresh() { if (isOpen) { buildCache(); runQuery(); } }

  self.LCTSearch = { init, open, close, toggle, refresh, get isOpen() { return isOpen; } };
})();
