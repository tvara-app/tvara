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

  /* ---------- stars persistence ----------
     Stars follow the person, not the browser: they live in chrome.storage.sync
     with a local mirror. Sync caps an item at 8KB, so the synced copy is the
     most recent SYNC_MAX with short snippets while local keeps everything —
     a chat with 300 stars degrades to "the recent ones travel", never to a
     failed write that loses the lot. */

  const SYNC_MAX = 60;
  const SYNC_SNIPPET = 44;

  function mergeStars(a, b) {
    const out = { ...(a || {}) };
    for (const k in (b || {})) {
      const mine = out[k], theirs = b[k];
      if (!mine || (theirs && theirs.t > mine.t)) out[k] = theirs;
    }
    return out;
  }

  function syncCopy(all) {
    const keys = Object.keys(all).sort((x, y) => (all[y].t || 0) - (all[x].t || 0)).slice(0, SYNC_MAX);
    const out = {};
    for (const k of keys) out[k] = { t: all[k].t, s: String(all[k].s || "").slice(0, SYNC_SNIPPET) };
    return out;
  }

  async function loadStars() {
    const conv = convId();
    starsConv = conv;
    const { synced, local } = await self.LCTStore.getBoth("stars:" + conv);
    // A deletion on another device is indistinguishable from "not synced yet",
    // so the merge is additive. Unstarring on THIS device writes both copies.
    const merged = mergeStars(local, synced);
    if (starsConv === conv) stars = merged;
    return merged;
  }

  function saveStars() {
    self.LCTStore.setBoth(storeKey(), stars, syncCopy(stars));
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
      toggleStar(hoverMsg);
      positionStarBtn(hoverMsg); // repaint fill state
    });
  }

  /** The one place a star is set or cleared — hover button and outline rows. */
  function toggleStar(el) {
    const k = keyOf(el);
    if (!k) return false;
    const on = !stars[k];
    if (on) stars[k] = { t: Date.now(), s: snippetOrMedia(el) };
    else delete stars[k];
    saveStars();
    paintStar(el, on);
    if (isOpen) render();
    return on;
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

  /**
   * One outline row: the entry itself plus its own star toggle, so starring is
   * something you can SEE and click, not a hover affordance you have to know
   * about. `key` is the message the star belongs to (a heading stars the answer
   * it lives in); omit it and the row carries no toggle.
   */
  function entryRow({ text, cls, i, onClick, key, el }) {
    const row = document.createElement("div");
    row.className = "lct-o-row";

    const item = document.createElement("button");
    item.className = "lct-o-item " + cls;
    item.textContent = text; // storage/DOM data is not markup
    item.style.setProperty("--i", i);
    item.addEventListener("click", onClick);
    row.appendChild(item);

    if (key) {
      const on = !!stars[key];
      const fav = document.createElement("button");
      fav.type = "button";
      fav.className = "lct-o-fav" + (on ? " lct-o-fav-on" : "");
      fav.textContent = on ? "★" : "☆";
      fav.title = on ? "Remove star" : "Star this message";
      fav.setAttribute("aria-label", fav.title);
      fav.setAttribute("aria-pressed", String(on));
      fav.addEventListener("click", (e) => {
        e.stopPropagation();
        starByKey(key, el);
      });
      row.appendChild(fav);
    }
    return row;
  }

  /** Unstarring must work even when the host has unmounted the message. */
  function starByKey(key, el) {
    if (el && el.isConnected) return toggleStar(el);
    if (!stars[key]) return;
    delete stars[key];
    saveStars();
    if (isOpen) render();
  }

  const jumpTo = (el) => self.LCTNav.jumpTo(el, { block: "center" });

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
        const key = keyOf(el);
        let role = "assistant";
        try { role = adapter.role(el); } catch (_) {}
        if (role === "user") {
          // "#n" = the message's position in the whole conversation — a stable
          // ID users can reference ("see my #57"). Media-only prompts (image/
          // file, no text) get a typed label instead of a blank row.
          rows.push(entryRow({
            text: "#" + (mi + 1) + " · " + snippetOrMedia(el),
            cls: "lct-o-user", i: rows.length, key, el, onClick: () => jumpTo(el)
          }));
        } else {
          const heads = el.querySelectorAll("h1, h2, h3");
          for (let i = 0; i < heads.length && i < 10; i++) {
            if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
            const h = heads[i];
            const lvl = h.tagName === "H1" ? 1 : h.tagName === "H2" ? 2 : 3;
            // Jump to the HEADING, not to the message that contains it. A long
            // answer holds a dozen of these; sending all twelve rows to the top
            // of the same answer is why the outline felt like it ignored clicks.
            rows.push(entryRow({
              text: snippet(h), cls: "lct-o-h lct-o-h" + lvl, i: rows.length,
              key, el, onClick: () => jumpTo(h)
            }));
          }
        }
      }
      noteEl.textContent = truncated
        ? `Showing first ${MAX_ENTRIES} entries`
        : rows.length ? "" : "No prompts or headings found yet";
    } else {
      const entries = Object.entries(stars).sort((a, b) => a[1].t - b[1].t);
      for (const [k, v] of entries) {
        rows.push(entryRow({
          text: v.s || "(starred message)", cls: "lct-o-star", i: rows.length,
          key: k, el: findByKey(k),
          onClick: () => {
            const el = findByKey(k);
            if (el) return jumpTo(el);
            // Unmounted: the minimap's catalog still knows where this message
            // sits, so let it seek the host back to that region.
            if (self.LCTMinimap && self.LCTMinimap.jumpToKey(k)) {
              noteEl.textContent = "Finding that message…";
            } else {
              noteEl.textContent = "That message isn't loaded on this page yet";
            }
          }
        }));
      }
      noteEl.textContent = rows.length ? "" : "Star any message — hover it, or use the ☆ on an outline row";
    }
    const at = listEl.scrollTop;   // starring must not throw away your place
    listEl.replaceChildren(...rows);
    listEl.scrollTop = at;
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
    // Hiding the star on every scroll event made it unusable: these hosts
    // auto-scroll on open, while streaming, and on every jump, so the button
    // was gone more often than not. Follow the message instead, and only give
    // up once it has actually left the viewport.
    window.addEventListener(
      "scroll",
      () => {
        if (!starBtn || !hoverMsg) return;
        if (!hoverMsg.isConnected) { hoverMsg = null; starBtn.style.display = "none"; return; }
        const r = hoverMsg.getBoundingClientRect();
        if (r.bottom < 40 || r.top > innerHeight - 20) { starBtn.style.display = "none"; return; }
        positionStarBtn(hoverMsg);
      },
      { passive: true, capture: true }
    );
  }

  self.LCTOutline = { init, update, toggle, open, close, setEnabled, get isOpen() { return isOpen; } };
})();
