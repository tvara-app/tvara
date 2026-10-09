/**
 * Tvara — message timeline (the time feature).
 *
 * No AI chat platform renders message times in its DOM, so we source them
 * two honest ways and always label which one you're seeing:
 *
 *  1. EXACT (ChatGPT): a tiny read-only script in the page's own JS world
 *     (content/inject/fiber-times.js) reads each message's real create_time
 *     from the app's internal state and hands it over via a DOM event.
 *     Covers the entire history, including messages sent before install.
 *  2. FIRST-SEEN (everywhere): we record locally when this device first saw
 *     each message. New messages are accurate; pre-install history honestly
 *     shows "time unknown". A first-seen time is NEVER presented as a send
 *     time — that's the mistake that got competitors bug reports.
 *
 * The hard part is the lazy-mount trap: these apps virtualize long chats, so
 * an OLD message scrolling into view "appears" in the DOM exactly like a NEW
 * one. Rule: a genuinely new message can only appear AFTER the last already-
 * known message in document order; anything mounting above that boundary is
 * history and stays unstamped.
 *
 * All data stays in chrome.storage.local. Nothing is transmitted, ever.
 */
(() => {
  "use strict";

  const TIMES_KEY = "times"; // { convId: { _t: ms, m: { msgKey: unixSeconds } } }
  const MAX_CONVS = 60;      // LRU cap on remembered conversations

  let adapter = null;
  let display = false;       // whether hover labels are shown (gated by main.js)
  let convId = null;
  let baseline = new Set();  // keys that were already present when the chat opened
  let seen = {};             // msgKey -> unixSeconds (first-seen, this conversation)
  let exact = {};            // msgKey -> unixSeconds (ChatGPT internal create_time)
  let settled = false;       // baseline snapshot is final
  let settleTimer = null;
  let saveTimer = null;
  let reqTimer = null;
  let exactListenerOn = false;
  let msgSet = new WeakSet();   // current message elements (for hover delegation)
  let keyCache = new WeakMap(); // el -> { k, len }
  let indexMap = new WeakMap(); // el -> message index (for the "#n" ID)
  let tag = null;               // the floating hover label

  const now = () => Math.floor(Date.now() / 1000);

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /**
   * Stable-ish key for a message element. ChatGPT has server UUIDs in the
   * DOM; Gemini responses carry r_<hex> ids; elsewhere we content-hash.
   *
   * The id probe runs BEFORE any text is read, and an id-derived key is cached
   * for good — an id cannot change. `el.textContent` serializes a whole answer
   * subtree, and this used to run it on every call — once per message per
   * engine tick, four times a second, plus again for the outline's star sweep.
   * It scales with the conversation's total text, so it is the read that gets
   * worse the longer someone's chat gets.
   *
   * Content hashes DO move while a message streams, so `fresh` re-measures.
   * Callers pass it for the tail only — the same "only the tail changes" rule
   * search.js and the minimap's meta cache already run on.
   */
  const TAIL = 5;

  function keyOf(el, fresh) {
    const cached = keyCache.get(el);
    if (cached && (cached.fixed || !fresh)) return cached.k;

    const idEl =
      el.hasAttribute && (el.hasAttribute("data-message-id") || el.hasAttribute("data-lct-mid"))
        ? el
        : el.querySelector && el.querySelector("[data-message-id], [data-lct-mid]");
    const id = idEl
      ? idEl.getAttribute("data-message-id") || idEl.getAttribute("data-lct-mid")
      : el.id && /^r_[0-9a-f]+$/i.test(el.id) ? el.id : "";
    if (id) {
      const k = "id:" + id;
      keyCache.set(el, { k, fixed: true, len: -1 });
      return k;
    }

    const text = el.textContent || "";
    if (cached && cached.len === text.length) return cached.k;
    const k = "h:" + hash(text.slice(0, 200)) + ":" + text.length;
    keyCache.set(el, { k, fixed: false, len: text.length });
    return k;
  }

  /* ---------- persistence (per conversation, LRU-capped) ---------- */

  async function loadSeen() {
    const { [TIMES_KEY]: all } = await self.LCTStore.get(TIMES_KEY);
    seen = (all && all[convId] && all[convId].m) || {};
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { [TIMES_KEY]: all } = await self.LCTStore.get(TIMES_KEY);
      const map = all || {};
      map[convId] = {
        _t: Date.now(),
        m: Object.assign((map[convId] && map[convId].m) || {}, seen)
      };
      const ids = Object.keys(map);
      if (ids.length > MAX_CONVS) {
        ids
          .sort((a, b) => map[a]._t - map[b]._t)
          .slice(0, ids.length - MAX_CONVS)
          .forEach((k) => delete map[k]);
      }
      self.LCTStore.set({ [TIMES_KEY]: map });
    }, 2000);
  }

  /* ---------- exact times from ChatGPT (MAIN-world reader) ---------- */

  function requestExact() {
    if (!adapter || adapter.id !== "chatgpt") return;
    if (!exactListenerOn) {
      exactListenerOn = true;
      document.addEventListener("lct-times-response", (e) => {
        try {
          const map = JSON.parse(e.detail);
          for (const [id, t] of Object.entries(map)) exact["id:" + id] = t;
        } catch (_) {}
      });
    }
    clearTimeout(reqTimer);
    reqTimer = setTimeout(
      () => document.dispatchEvent(new CustomEvent("lct-times-request")),
      300
    );
  }

  /* ---------- the stamping engine ---------- */

  function resetConversation(id) {
    convId = id;
    baseline = new Set();
    seen = {};
    exact = {};
    settled = false;
    clearTimeout(settleTimer);
  }

  async function update(messages) {
    const n = messages.length;
    const tailFrom = n - TAIL;   // only these can still be changing
    indexMap = new WeakMap(); // el -> position in conversation (1-based via +1)
    for (let i = 0; i < n; i++) indexMap.set(messages[i], i);
    const id = location.hostname + location.pathname;
    if (id !== convId) {
      resetConversation(id);
      await loadSeen();
    }

    msgSet = new WeakSet();
    if (!n) return;

    // Keyed once, not twice: the boundary scan and the stamping pass below both
    // want every key, and on an id-less host keyOf(fresh) re-serialises the
    // whole answer subtree — paid twice on the longest, still-growing messages.
    // Membership rides along in the same pass rather than walking the list
    // again; this runs on every engine tick, over the whole conversation.
    const keys = new Array(n);
    for (let i = 0; i < n; i++) {
      const el = messages[i];
      msgSet.add(el);
      keys[i] = keyOf(el, i >= tailFrom);
    }

    if (!settled) {
      // First scans of a conversation: everything already present is history,
      // not new. Snapshot it; only stamp what appears after we settle.
      for (let i = 0; i < n; i++) baseline.add(keys[i]);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settled = true;
      }, 2500);
      requestExact();
      return;
    }

    // messages is in document order. Find the LAST already-known message;
    // unknown messages after it are new, unknown ones before it are history
    // that the app just lazy-mounted.
    let lastKnown = -1;
    for (let i = n - 1; i >= 0; i--) {
      const k = keys[i];
      if (seen[k] || baseline.has(k) || exact[k]) {
        lastKnown = i;
        break;
      }
    }

    let dirty = false;
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      if (seen[k] || baseline.has(k)) continue;
      if (lastKnown === -1) {
        // no anchors at all: brand-new chat → stamp; lost anchors → be honest
        if (baseline.size === 0 && Object.keys(seen).length === 0) {
          seen[k] = now();
          dirty = true;
        } else {
          baseline.add(k);
        }
        continue;
      }
      if (i < lastKnown) {
        baseline.add(k); // mounted above the boundary → historical
        continue;
      }
      seen[k] = now();
      dirty = true;
    }

    if (dirty) scheduleSave();
    requestExact();
  }

  /* ---------- reading times back ---------- */

  /* The archive's copy of this message, by provider id: the true send time and
     the true position. Without it the label said "#3 · Time unknown (sent
     before install)" on message 104 of a chat whose every time ChatGPT had
     published. */
  function archived(el) {
    const k = keyOf(el);
    if (!k || !k.startsWith("id:") || !self.LCTChatIndex || !self.LCTChatIndex.lookup) return null;
    try { return self.LCTChatIndex.lookup(k.slice(3)); } catch (_) { return null; }
  }

  function info(el) {
    const k = keyOf(el);
    if (exact[k]) return { t: exact[k], kind: "exact" };
    const a = archived(el);
    if (a && a.ts) return { t: a.ts, kind: "exact" };
    if (seen[k]) return { t: seen[k], kind: "seen" };
    return null;
  }

  function fmt(sec) {
    const d = new Date(sec * 1000);
    const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleString(undefined, opts);
  }

  /** Human label for a message's time — "" when display is off. */
  function label(el) {
    if (!display) return "";
    // "#n" — the message's stable position in the conversation, so users can
    // reference "my #57" and find it again in the outline
    // The position among MOUNTED messages is only the true one when the whole
    // chat is mounted; the archive knows the real one, and no number beats a
    // wrong one.
    const a = archived(el);
    const ix = a ? a.at : (adapter && adapter.virtualizes ? undefined : indexMap.get(el));
    const id = ix === undefined ? "" : "#" + (ix + 1) + " · ";
    const inf = info(el);
    if (!inf) return id + "Time not recorded";
    return inf.kind === "exact"
      ? id + "Sent " + fmt(inf.t)
      : id + "First seen " + fmt(inf.t) + " · this device";
  }

  /* ---------- hover label UI ---------- */

  function ensureTag() {
    if (tag) return;
    tag = document.createElement("div");
    tag.id = "lct-time-tag";
    document.documentElement.appendChild(tag);
  }

  function hideTag() {
    if (tag) tag.style.display = "none";
  }

  function messageOf(node) {
    let n = node;
    for (let i = 0; n && i < 25; i++, n = n.parentElement) {
      if (msgSet.has(n)) return n;
    }
    return null;
  }

  let placed = null;   // message + geometry + text the label was last placed for

  function onHover(e) {
    if (!display) return;
    const m = messageOf(e.target);
    if (!m) return hideTag();
    const text = label(m);
    if (!text) return hideTag();
    ensureTag();
    const r = m.getBoundingClientRect();
    const sig = [r.top, r.left, r.right, innerWidth, innerHeight, text].join();
    if (placed && placed.m === m && placed.sig === sig && tag.style.display === "block") return;
    placed = { m, sig };
    tag.textContent = text;
    tag.style.visibility = "hidden";
    tag.style.display = "block";
    const w = tag.offsetWidth, h = tag.offsetHeight;
    // Above the message, else at the top of what shows of it — right, then
    // left — and never over a host control: a label on a code block's Copy
    // hid it. No clear spot means no label.
    const vt = self.LCTPlace.visibleTop(m, r, r.right - 12);
    const floor = vt > Math.max(0, r.top) ? vt : 4;
    const above = r.top - h - 4;
    const at = self.LCTPlace.pick([
      above >= floor && [r.right - w - 4, above],
      above >= floor && [r.left + 4, above],
      [r.right - w - 4, vt + 4],
      [r.left + 4, vt + 4],
    ], w, h);
    if (!at) { tag.style.display = "none"; tag.style.visibility = ""; return; }
    tag.style.right = "auto";
    tag.style.left = at[0] + "px";
    tag.style.top = at[1] + "px";
    tag.style.visibility = "";
  }

  function init(a) {
    adapter = a;
    document.addEventListener("mouseover", onHover, { passive: true });
    window.addEventListener("scroll", hideTag, { passive: true, capture: true });
  }

  function setDisplay(on) {
    display = !!on;
    if (!display) hideTag();
  }

  /** Earliest EXACT (platform-recorded) time in this conversation, unix
   *  seconds — on ChatGPT this is the real creation time. null elsewhere:
   *  a first-seen time must never be passed off as a creation time. */
  function earliest() {
    let min = null;
    for (const k in exact) if (min === null || exact[k] < min) min = exact[k];
    return min;
  }

  self.LCTTimeline = { init, update, keyOf, info, label, setDisplay, earliest };
})();
