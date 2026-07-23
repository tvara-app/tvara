/**
 * Long Chat Toolkit — outline panel + starred messages (Pro tools).
 *
 * Outline: auto-extracted table of contents for the conversation — every user
 * prompt plus every heading in assistant answers. Click an entry to jump.
 * Stars: hover any message → star it. Starred messages get an accent marker
 * and their own tab in the panel. Stored per conversation, locally only.
 */
(() => {
  "use strict";

  const MAX_ENTRIES = 400; // a 2,000-prompt outline helps nobody — cap and say so
  const SNIPPET_LEN = 70;

  let adapter = null;
  let enabled = false;      // gated by main.js (Pro / trial / free platform)
  let panel = null, listEl = null, noteEl = null, tabAll = null, tabStar = null;
  let isOpen = false;
  let mode = "all";         // "all" | "star"
  let messages = [];
  let msgSet = new WeakSet();
  let stars = {};           // msgKey -> { t: ms, s: snippet }
  let starsConv = null;     // conversation the loaded stars belong to
  let starBtn = null, hoverMsg = null;

  const convId = () => location.hostname + location.pathname;
  const storeKey = () => "stars:" + convId();
  const keyOf = (el) => self.LCTTimeline.keyOf(el);
  // First real content block beats raw textContent: chat sites prepend
  // hidden/role labels ("You said:", sr-only headers) that would otherwise
  // pollute every entry ("YouCan you help me…").
  function snippet(el) {
    const block = el.querySelector("p, h1, h2, h3, li");
    const text = (block ? block.textContent : el.textContent) || "";
    return text.trim().slice(0, SNIPPET_LEN);
  }

  // A prompt with no text still deserves a real row: say WHAT it was.
  function snippetOrMedia(el) {
    const s = snippet(el);
    if (s) return s;
    if (el.querySelector("img, canvas, video")) return "[Image]";
    if (el.querySelector("audio")) return "[Audio]";
    return "[Attachment]";
  }

  /* ---------- stars persistence ---------- */

  async function loadStars() {
    starsConv = convId();
    const o = await self.LCTStore.get(storeKey());
    stars = o[storeKey()] || {};
  }

  function saveStars() {
    self.LCTStore.set({ [storeKey()]: stars });
  }

  /* ---------- star hover button ---------- */

  function ensureStarBtn() {
    if (starBtn) return;
    starBtn = document.createElement("button");
    starBtn.id = "lct-star";
    starBtn.title = "Star this message (Long Chat Toolkit)";
    starBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z"/></svg>';
    document.documentElement.appendChild(starBtn);
    starBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hoverMsg) return;
      const k = keyOf(hoverMsg);
      if (stars[k]) delete stars[k];
      else stars[k] = { t: Date.now(), s: snippetOrMedia(hoverMsg) };
      saveStars();
      paintStar(hoverMsg, !!stars[k]);
      positionStarBtn(hoverMsg); // repaint fill state
      if (isOpen && mode === "star") render();
    });
  }

  function paintStar(el, on) {
    el.classList.toggle("lct-starred", on);
  }

  function positionStarBtn(m) {
    ensureStarBtn();
    const r = m.getBoundingClientRect();
    starBtn.style.display = "flex";
    starBtn.style.top = Math.max(4, r.top + 6) + "px";
    // OUTSIDE the message's right edge — floating it inside covers the text
    // (real bug seen on ChatGPT: the button sat on the last words of a line).
    // Falls back to just-inside only when the layout leaves no room.
    const outside = innerWidth - r.right - 34;
    starBtn.style.right = (outside >= 8 ? outside : Math.max(2, innerWidth - r.right + 4)) + "px";
    starBtn.classList.toggle("lct-star-on", !!stars[keyOf(m)]);
  }

  let starHideTimer = null;

  function onHover(e) {
    if (!enabled) return;
    if (starBtn && (e.target === starBtn || starBtn.contains(e.target))) {
      clearTimeout(starHideTimer); // resting on the button keeps it alive
      return;
    }
    let n = e.target;
    for (let i = 0; n && i < 25; i++, n = n.parentElement) {
      if (msgSet.has(n)) {
        clearTimeout(starHideTimer);
        hoverMsg = n;
        positionStarBtn(n);
        return;
      }
    }
    // The cursor is in the corridor between the message and the button (the
    // button sits OUTSIDE the text column). Hiding instantly here made the
    // star unreachable — grace-delay instead; reaching the button cancels.
    clearTimeout(starHideTimer);
    starHideTimer = setTimeout(() => {
      hoverMsg = null;
      if (starBtn) starBtn.style.display = "none";
    }, 450);
  }

  /* ---------- panel ---------- */

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "lct-outline";
    panel.innerHTML = `
      <div class="lct-o-head">
        <button class="lct-o-tab lct-o-on" data-mode="all">Outline</button>
        <button class="lct-o-tab" data-mode="star">Starred</button>
        <button class="lct-o-close" title="Close (Esc)">✕</button>
      </div>
      <div class="lct-o-list"></div>
      <div class="lct-o-note"></div>
    `;
    document.documentElement.appendChild(panel);
    listEl = panel.querySelector(".lct-o-list");
    noteEl = panel.querySelector(".lct-o-note");
    tabAll = panel.querySelector('[data-mode="all"]');
    tabStar = panel.querySelector('[data-mode="star"]');

    panel.querySelector(".lct-o-close").addEventListener("click", close);
    for (const tab of [tabAll, tabStar]) {
      tab.addEventListener("click", () => {
        mode = tab.dataset.mode;
        tabAll.classList.toggle("lct-o-on", mode === "all");
        tabStar.classList.toggle("lct-o-on", mode === "star");
        render();
      });
    }
    window.addEventListener(
      "keydown",
      (e) => {
        if (isOpen && e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      },
      true
    );
  }

  function entryRow(text, cls, onClick) {
    const row = document.createElement("button");
    row.className = "lct-o-item " + cls;
    row.textContent = text; // storage/DOM data is not markup
    row.addEventListener("click", onClick);
    return row;
  }

  function jumpTo(el) {
    if (!el || !el.isConnected) return;
    // settle loop: content-visibility regions materialize while scrolling, so
    // the first estimate lands short — re-aim until the target is centered
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
    el.classList.add("lct-hit");
    setTimeout(() => el.classList.remove("lct-hit"), 1600);
  }

  function findByKey(k) {
    for (const el of messages) if (keyOf(el) === k) return el;
    return null;
  }

  function render() {
    if (!panel) return;
    const rows = [];
    let truncated = false;

    if (mode === "all") {
      for (let mi = 0; mi < messages.length; mi++) {
        const el = messages[mi];
        if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
        let role = "assistant";
        try { role = adapter.role(el); } catch (_) {}
        if (role === "user") {
          // "#n" = the message's position in the whole conversation — a stable
          // ID users can reference ("see my #57"). Media-only prompts (image/
          // file, no text) get a typed label instead of a blank row.
          rows.push(entryRow("#" + (mi + 1) + " · " + snippetOrMedia(el), "lct-o-user", () => jumpTo(el)));
        } else {
          const heads = el.querySelectorAll("h1, h2, h3");
          for (let i = 0; i < heads.length && i < 10; i++) {
            if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
            const h = heads[i];
            const lvl = h.tagName === "H1" ? 1 : h.tagName === "H2" ? 2 : 3;
            rows.push(entryRow(snippet(h), "lct-o-h lct-o-h" + lvl, () => jumpTo(el)));
          }
        }
      }
      noteEl.textContent = truncated
        ? `Showing first ${MAX_ENTRIES} entries`
        : rows.length ? "" : "No prompts or headings found yet";
    } else {
      const entries = Object.entries(stars).sort((a, b) => a[1].t - b[1].t);
      for (const [k, v] of entries) {
        rows.push(
          entryRow(v.s || "(starred message)", "lct-o-star", () => {
            const el = findByKey(k);
            if (el) jumpTo(el);
            else noteEl.textContent = "Message not loaded on this page right now";
          })
        );
      }
      noteEl.textContent = rows.length ? "" : "Hover any message and hit the star";
    }
    listEl.replaceChildren(...rows);
  }

  function open() {
    ensurePanel();
    panel.classList.add("lct-o-open");
    isOpen = true;
    render();
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("lct-o-open");
    isOpen = false;
  }

  function toggle() { isOpen ? close() : open(); }

  /* ---------- wiring ---------- */

  async function update(msgs) {
    messages = msgs;
    msgSet = new WeakSet();
    for (const el of msgs) msgSet.add(el);
    if (starsConv !== convId()) await loadStars();
    // keyOf hashes message text — skip the whole pass when nothing is starred
    // (the common case) instead of hashing 1,500 messages per update
    if (Object.keys(stars).length) {
      for (const el of msgs) paintStar(el, !!stars[keyOf(el)]);
    }
    if (isOpen) render();
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      close();
      if (starBtn) starBtn.style.display = "none";
    }
  }

  function init(a) {
    adapter = a;
    document.addEventListener("mouseover", onHover, { passive: true });
    window.addEventListener(
      "scroll",
      () => { if (starBtn) starBtn.style.display = "none"; },
      { passive: true, capture: true }
    );
  }

  self.LCTOutline = { init, update, toggle, open, close, setEnabled, get isOpen() { return isOpen; } };
})();
