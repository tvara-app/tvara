/**
 * Long Chat Toolkit — message timeline (the time feature).
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
   * Streaming messages change length, so hashes are recomputed until the
   * text settles — stale intermediate stamps are harmless (same minute).
   */
  function keyOf(el) {
    const text = el.textContent || "";
    const cached = keyCache.get(el);
    if (cached && cached.len === text.length) return cached.k;

    let k;
    const idEl =
      el.hasAttribute && el.hasAttribute("data-message-id")
        ? el
        : el.querySelector && el.querySelector("[data-message-id]");
    if (idEl) k = "id:" + idEl.getAttribute("data-message-id");
    else if (el.id && /^r_[0-9a-f]+$/i.test(el.id)) k = "id:" + el.id;
    else k = "h:" + hash(text.slice(0, 200)) + ":" + text.length;

    keyCache.set(el, { k, len: text.length });
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
    const id = location.hostname + location.pathname;
    if (id !== convId) {
      resetConversation(id);
      await loadSeen();
    }

    msgSet = new WeakSet();
    for (const el of messages) msgSet.add(el);
    if (!messages.length) return;

    if (!settled) {
      // First scans of a conversation: everything already present is history,
      // not new. Snapshot it; only stamp what appears after we settle.
      for (const el of messages) baseline.add(keyOf(el));
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
    for (let i = messages.length - 1; i >= 0; i--) {
      const k = keyOf(messages[i]);
      if (seen[k] || baseline.has(k) || exact[k]) {
        lastKnown = i;
        break;
      }
    }

    let dirty = false;
    for (let i = 0; i < messages.length; i++) {
      const k = keyOf(messages[i]);
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

  function info(el) {
    const k = keyOf(el);
    if (exact[k]) return { t: exact[k], kind: "exact" };
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
    const inf = info(el);
    if (!inf) return "🕒 time unknown (sent before install)";
    return inf.kind === "exact"
      ? "🕒 " + fmt(inf.t)
      : "🕒 first seen " + fmt(inf.t) + " · this device";
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

  function onHover(e) {
    if (!display) return;
    const m = messageOf(e.target);
    if (!m) return hideTag();
    const text = label(m);
    if (!text) return hideTag();
    ensureTag();
    const r = m.getBoundingClientRect();
    tag.textContent = text;
    tag.style.display = "block";
    tag.style.top = Math.max(4, r.top - 24) + "px";
    tag.style.right = Math.max(8, innerWidth - r.right + 4) + "px";
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

  self.LCTTimeline = { init, update, keyOf, info, label, setDisplay };
})();
