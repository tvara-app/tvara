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

  function init(a) { adapter = a; }

  function buildCache() {
    try {
      items = adapter.messages().map((el) => ({
        el,
        text: (el.textContent || "").toLowerCase()
      }));
    } catch (_) {
      items = [];
    }
  }

  function ensureBar() {
    if (bar) return;
    bar = document.createElement("div");
    bar.id = "lct-search";
    bar.innerHTML = `
      <span class="lct-s-icon">🔎</span>
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
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? step(-1) : step(1); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
      e.stopPropagation(); // don't let the host app eat our keys
    });
    bar.querySelector(".lct-s-prev").addEventListener("click", () => step(-1));
    bar.querySelector(".lct-s-next").addEventListener("click", () => step(1));
    bar.querySelector(".lct-s-close").addEventListener("click", close);
  }

  function runQuery() {
    const q = input.value.trim().toLowerCase();
    hits = [];
    cur = -1;
    if (q.length >= 2) {
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
    counter.textContent = hits.length ? `${cur + 1}/${hits.length}` : (input.value.trim().length >= 2 ? "0/0" : "");
    counter.classList.toggle("lct-s-none", !hits.length && input.value.trim().length >= 2);
  }

  function jumpTo(el) {
    if (!el || !el.isConnected) return;
    el.scrollIntoView({ behavior: "auto", block: "center" });
    if (lastHit) lastHit.classList.remove("lct-hit");
    el.classList.add("lct-hit");
    lastHit = el;
    setTimeout(() => { if (lastHit === el) { el.classList.remove("lct-hit"); lastHit = null; } }, 1600);
  }

  function open() {
    ensureBar();
    buildCache();
    bar.classList.add("lct-s-open");
    isOpen = true;
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
