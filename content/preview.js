/**
 * Tvara — the message panel.
 *
 * ONE message, in full, beside the map — the one the pointer is on. Read from
 * the copy on this machine, so it costs the provider nothing and works while
 * they are refusing us, while the page holds eighteen turns of a hundred, and
 * while a walk is still crawling its way up.
 *
 * It has been two other things and both were wrong. A single-message preview
 * that CLOSED itself when the page caught up reads as the click having failed:
 * the words appear and the page does not move. A scrolling reader of the whole
 * conversation is the opposite error — pointing at a mark on the map is asking
 * "what is THAT one", and a thousand-message list means finding it again inside
 * the answer. The map is the index; this is the page it opens to. It stays
 * open, and clicking the message still drives the page to it underneath.
 *
 * Everything below builds nodes. The archived text came off the network and is
 * data, never markup; LCTHistoryLoader.renderMarkdown is the only thing that
 * turns it into elements, and it uses createElement and textContent throughout.
 */
(() => {
  "use strict";

  const ID = "lct-history-panel";
  let panel = null, listEl = null, countEl = null;
  let open = false;
  /* Opened by a HOVER, so it goes away when the pointer does.
     A panel that opens on hover and then stays is a panel that eats every
     click aimed at whatever is behind it — the outline, the search bar, the
     export buttons. Clicking a mark makes it stick; pointing at one does not. */
  let transient = false;
  let leaveTimer = null;
  let loadedRoute = "";
  let rows = [];

  const send = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      return p && p.catch ? p.catch(() => null) : Promise.resolve(null);
    } catch (_) { return Promise.resolve(null); }   // context gone
  };

  function build() {
    if (panel && panel.isConnected) return;
    panel = document.createElement("div");
    panel.id = ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Conversation history");
    /* Static chrome only. Every piece of message text below is textContent or
       a node built by the renderer — there is no innerHTML on that path. */
    panel.innerHTML =
      '<div class="lct-hp-head">' +
        '<span class="lct-hp-title"></span>' +
        '<span class="lct-hp-count"></span>' +
        '<button type="button" class="lct-hp-close" aria-label="Close (Esc)">✕</button>' +
      '</div>' +
      '<div class="lct-hp-list" tabindex="0"></div>';
    document.documentElement.appendChild(panel);
    listEl = panel.querySelector(".lct-hp-list");
    countEl = panel.querySelector(".lct-hp-count");
    panel.querySelector(".lct-hp-close").addEventListener("click", close);
    /* Reading it counts as wanting it: moving onto the panel cancels the close
       the map's mouseleave started, and leaving it again closes for good. */
    panel.addEventListener("mouseenter", () => { clearTimeout(leaveTimer); });
    panel.addEventListener("mouseleave", () => { if (transient) close(); });
    window.addEventListener("keydown", (e) => {
      if (open && e.key === "Escape") { e.stopPropagation(); close(); }
    }, true);
    /* A press anywhere else closes it. A click makes the panel stick, and a
       sticky panel that only an ✕ or Esc could close sat over the conversation
       after somebody had plainly moved on to it (reported with a screenshot).
       Pressed, not clicked, so it is gone before the host reacts; capture phase
       and composedPath so a host handler that stops propagation cannot swallow
       it and a press deep inside the panel is still recognised as inside.
       Never prevented: whatever was pressed on the page still happens.
       The map is exempt — pressing another mark SWITCHES the message, and
       closing first would flash the panel shut and open again. */
    document.addEventListener("pointerdown", (e) => {
      if (!open || !panel) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const inside = (el) => !!el && (path.includes(el) || el.contains(e.target));
      if (inside(panel)) return;
      if (inside(document.getElementById("lct-mm-canvas")) || inside(document.getElementById("lct-mm-stage"))) return;
      close();
    }, { capture: true, passive: true });
  }

  /* One row per turn. Clicking it does BOTH things somebody means by clicking a
     message they cannot see: it shows them the text, which is already here, and
     it starts the page moving toward it, which is not. */
  function row(m, index) {
    const el = document.createElement("article");
    el.className = "lct-hp-row";
    el.dataset.lctOld = m.r === "user" ? "user" : "assistant";
    if (m.i) el.dataset.lctTurnId = m.i;
    el.tabIndex = 0;

    const who = document.createElement("div");
    who.className = "lct-hp-who";
    who.textContent = (m.r === "user" ? "You" : "Assistant") + " · #" + (index + 1);

    const body = document.createElement("div");
    body.className = "lct-hp-text";
    try { self.LCTHistoryLoader.renderMarkdown(body, m.t || ""); }
    catch (_) { body.textContent = m.t || ""; }

    el.append(who, body);
    // Clicking the message asks for the page to go there — the panel already
    // showed it, so the only thing left to want is to arrive.
    const go = () => {
      try { self.LCTMinimap.jumpToIndex(index); } catch (_) { /* map not up */ }
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    return el;
  }

  /**
   * Fill from the archive. Local read, so it costs the provider nothing and
   * works when everything else is being refused.
   */
  async function load(force) {
    build();
    const route = location.host + location.pathname;
    /* The archive moves under this panel. content/indexer.js bumps the revision
       every time it writes the open conversation, which on a chat being typed
       into is every few seconds — so a cached copy from the first read is a
       half-written answer, and that is what a brand-new conversation showed
       until the page was reloaded. */
    const rev = self.LCTArchiveRev || 0;
    if (!force && loadedRoute === route && loadedRev === rev && rows.length) return rows.length;
    loadedRev = rev;
    const reply = await send({ type: "chat-mount", host: location.host, path: location.pathname });
    if (!reply || reply.status !== "ok" || !Array.isArray(reply.msgs)) {
      listEl.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "lct-hp-empty";
      /* Say which of the two it is. "Nothing here" and "not archived yet" look
         identical on screen and mean completely different things to do next. */
      empty.textContent = reply && reply.status === "missing"
        ? "This conversation is not archived on this device yet."
        : "The archive could not be read just now.";
      listEl.appendChild(empty);
      countEl.textContent = "";
      loadedRoute = "";
      rows = [];
      return 0;
    }
    // Held, not rendered: show() paints the one that was asked for.
    rows = reply.msgs;
    showing = -1;
    loadedRoute = route;
    return rows.length;
  }

  /**
   * ONE message, not the conversation.
   *
   * This showed every turn in a scrolling list, and that is the wrong object:
   * pointing at a mark on the map is asking "what is THAT one", and answering
   * with a thousand-message reader means finding it again inside the answer.
   * The map is already the index; this is the page it opens to.
   *
   * The message itself still scrolls — some answers are very long — but the
   * panel never scrolls past the end of one into the next.
   */
  let showing = -1;
  let wanted = 0;          // the message asked for, even before one is held
  let loadedRev = -1;
  let watchTimer = null;

  /* While the panel is OPEN, the answer behind it may still be streaming. Re-read
     and repaint only when something actually changed, and keep the reader's
     scroll position — a panel that jumps to the top every two seconds is worse
     than one that is out of date. */
  async function refreshOpen() {
    if (!open) return;
    const wasCount = rows.length;
    const wasLen = (showing >= 0 && rows[showing]) ? String(rows[showing].t || "").length : -1;
    await load(false);
    if (!open) return;
    /* Still nothing in the archive. This is the state a BRAND-NEW conversation
       opens in — the page has not flushed it yet — and the panel used to stop
       here for good: it painted "not archived on this device yet" and never
       asked again, so the first thing anyone ever opened stayed empty until the
       page was reloaded. Keep waiting instead; the tick brings it in. */
    if (!rows.length) return;
    const at = showing < 0
      ? Math.max(0, Math.min(wanted, rows.length - 1))
      : Math.max(0, Math.min(showing, rows.length - 1));
    const nowLen = rows[at] ? String(rows[at].t || "").length : 0;
    if (nowLen === wasLen && rows.length === wasCount && showing >= 0) return;
    const top = listEl.scrollTop;
    const arriving = showing < 0;          // the empty state, filling in at last
    showing = at;
    listEl.replaceChildren(row(rows[at], at));
    listEl.scrollTop = arriving ? 0 : top; // a message arriving starts at ITS top
    countEl.textContent = "#" + (at + 1) + " of " + rows.length;
    const title = panel.querySelector(".lct-hp-title");
    if (title) title.textContent = rows[at].r === "user" ? "You" : "Assistant";
  }

  async function show(index, opts) {
    build();
    clearTimeout(leaveTimer);
    // A click is a commitment; a hover is not. Once sticky, it stays sticky.
    if (!(opts && opts.transient)) transient = false;
    else if (!open) transient = true;
    wanted = Math.max(0, Number(index) || 0);
    const n = await load(false);
    if (!n) {
      panel.classList.add("lct-hp-open");
      open = true;
      showing = -1;
      // Nothing held YET. The watcher keeps asking; see refreshOpen().
      clearInterval(watchTimer);
      watchTimer = setInterval(refreshOpen, 2500);
      return;
    }
    const at = Math.max(0, Math.min(rows.length - 1, Number(index) || 0));
    if (at !== showing || !listEl.firstChild) {
      showing = at;
      listEl.replaceChildren(row(rows[at], at));
      listEl.scrollTop = 0;      // a new message starts at ITS top, not the last one's
    }
    panel.querySelector(".lct-hp-title").textContent = rows[at].r === "user" ? "You" : "Assistant";
    countEl.textContent = "#" + (at + 1) + " of " + rows.length;
    panel.classList.add("lct-hp-open");
    open = true;
    clearInterval(watchTimer);
    watchTimer = setInterval(refreshOpen, 2500);
  }

  /* Kept for callers that used to move a highlight inside a list. Showing one
     message makes "mark" and "show" the same act. */
  const mark = (index) => { show(index); };

  function close() {
    clearTimeout(leaveTimer);
    clearInterval(watchTimer);
    watchTimer = null;
    if (!panel) return;
    panel.classList.remove("lct-hp-open");
    open = false;
    transient = false;
  }

  /* The pointer left the map. Give it a moment to arrive on the panel — the
     gap between the two is real and crossing it must not close what somebody
     is reaching for. */
  function release() {
    if (!transient) return;
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(close, 220);
  }

  function toggle() { return open ? (close(), false) : (show(), true); }

  /* A new conversation invalidates what is loaded, whether or not the panel is
     showing — otherwise reopening it paints the previous chat. */
  function reset() {
    loadedRoute = "";
    rows = [];
    showing = -1;
    if (open) close();
  }

  self.LCTHistoryPanel = {
    show, close, toggle, mark, reset, load, release,
    get isOpen() { return open; }
  };
})();
