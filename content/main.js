/**
 * Tvara — orchestrator.
 * Wires adapter → engine → minimap → search → timeline → exporter, reads
 * settings/license from chrome.storage, and reacts live to popup changes.
 */
(() => {
  "use strict";

  const adapter = self.LCTAdapters.detect();
  if (!adapter) return; // unknown host — do nothing, break nothing

  const store = self.LCTStore;

  const state = {
    enabled: true,
    minimap: true,
    time: true,
    tempArchive: false,  // opt-in: the host was told not to keep these

    history: false,    // walk the host's scroller on open — off, it moves the page
    pro: false,
    trialUntil: 0      // ms epoch; 0 = no trial started
  };

  // Pricing slice: the speed engine is FREE everywhere (our gift + reputation).
  // Tools (minimap, search, outline, timestamps, backup) are free on ChatGPT;
  // Pro (one payment, see lib/product.js) or the 7-day trial unlocks them on
  // Claude & Gemini.
  // Perplexity/DeepSeek/Grok support is experimental, so tools stay free there
  // until each is proven on the live site.
  const FREE_TOOL_PLATFORMS = new Set(["chatgpt", "perplexity", "deepseek", "grok", "synthetic"]);
  const trialActive = () => Date.now() < state.trialUntil;
  const toolsUnlocked = () => state.pro || trialActive() || FREE_TOOL_PLATFORMS.has(adapter.id);
  const timeFn = () =>
    state.time && toolsUnlocked() ? (el) => self.LCTTimeline.info(el) : null;

  let lastMessages = [];
  // The CONVERSATION, not location.href: these hosts rewrite their own query
  // string and hash while you sit still, and treating that as a chat switch
  // reset every per-chat cache several times a minute.
  const routeId = () => {
    // Same URL for every temporary chat, so per-chat caches would survive the
    // switch from one to the next.
    const eph = self.LCTAdapters.ephemeral(adapter, lastMessages);
    return eph ? eph.id : location.hostname + location.pathname;
  };
  let currentRoute = routeId();
  let statsTimer = null;

  /* ---------- theme ----------
     Our surfaces follow the SITE's theme, not the OS's: a white minimap on a
     dark ChatGPT is the mismatch people actually notice. Stamped on <html>,
     where styles.css picks it up (data-lct-theme outranks the media query).

     Throttled like the rail below: two getComputedStyle reads on every engine
     tick, for a value that changes when someone flips a setting. A theme
     landing a second late is invisible; the style recalcs were not free. */
  let themeAt = 0;
  function syncTheme(force) {
    if (!force && Date.now() - themeAt < 1000) return;
    themeAt = Date.now();
    let dark = null;
    for (const el of [document.body, document.documentElement]) {
      const m = el && getComputedStyle(el).backgroundColor
        /* One flat capture of the argument list, split in code.
           Picking the components apart in the pattern needs an optional group
           around a quantified one, which is the nested shape that backtracks —
           and getComputedStyle hands back a normalised "rgb(0, 0, 0)" or
           "rgba(0, 0, 0, 0.5)" that a split reads just as reliably. */
        .match(/rgba?\(([^)]{1,64})\)/);
      if (!m) continue;
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) continue;
      const alpha = parts.length > 3 ? parts[3] : 1;
      if (Number.isFinite(alpha) && alpha < 0.5) continue; // see-through: keep looking
      dark = (parts[0] * 299 + parts[1] * 587 + parts[2] * 114) / 1000 < 128;
      break;
    }
    if (dark === null) dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "dark" : "light";
    if (document.documentElement.dataset.lctTheme !== next) {
      document.documentElement.dataset.lctTheme = next;
    }
  }
  syncTheme(true);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => syncTheme(true));

  /* ---------- right-edge clearance ----------
     ChatGPT grows its own message-navigator rail on the right edge, and our
     strip docked on top of it — two navigators, one covering the other. Measure
     whatever the host parked there and step aside, so they sit side by side.

     Measured rather than a per-platform constant: the rail only appears on long
     chats, and reserving space it isn't using would be its own kind of wrong. */
  const RAIL_MAX = 96;       // wider than this is content, not a rail
  let railAt = 0;
  function syncRail(force) {
    // 9 hit-tests per pass, and the caller runs on every engine tick — a rail
    // appearing 2s late is invisible; the layout cost of checking wouldn't be.
    if (!force && Date.now() - railAt < 2000) return;
    railAt = Date.now();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let inset = 0;
    // Probe down the right edge: three heights so a short rail isn't missed,
    // three depths so we see past our own strip.
    for (const fy of [0.32, 0.5, 0.68]) {
      for (const dx of [6, 18, 30]) {
        for (const el of document.elementsFromPoint(vw - dx, Math.round(vh * fy))) {
          if (el.id?.startsWith("lct-") || el.closest?.("[id^='lct-']")) continue;
          const r = el.getBoundingClientRect();
          // a rail: narrow, tall, and hugging the right edge
          if (r.width < 4 || r.width > RAIL_MAX) continue;
          if (r.right < vw - RAIL_MAX) continue;
          if (r.height < vh * 0.2) continue;
          inset = Math.max(inset, Math.min(RAIL_MAX, Math.ceil(vw - r.left)));
          break;                 // deepest match at this point wins
        }
      }
    }
    const next = inset ? inset + 4 + "px" : "0px";   // 4px breathing room
    if (document.documentElement.style.getPropertyValue("--lct-rail-inset") !== next) {
      document.documentElement.style.setProperty("--lct-rail-inset", next);
    }
  }
  syncRail(true);
  addEventListener("resize", () => syncRail(true), { passive: true });

  let statsLatest = null;
  function pushStats(windowed, total) {
    // THROTTLE, not debounce: engine updates fire on every DOM change, and a
    // debounce would starve the write during continuous activity. This writes
    // the freshest numbers at most once per 1.5s — but always writes.
    statsLatest = { windowed, total };
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      // one key per host — no cross-tab read-modify-write races
      store.set({
        ["stats:" + location.hostname]: {
          windowed: statsLatest.windowed,
          total: statsLatest.total, // honest denominator: "1,494 of 1,500 asleep"
          platform: adapter.label,
          updatedAt: Date.now()
        }
      });
    }, 1500);
  }

  /* ---------- allowance tracking lives elsewhere now ----------
     There used to be a usage tally here: it counted user-message elements each
     tick and treated any increase as messages sent. It is gone, and it is worth
     saying why so it does not come back.

     It could not be made correct. On every host that mounts only a
     conversation's tail — ChatGPT, Claude, Gemini and Grok all set
     `virtualizes` — scrolling up mounts older turns, the count rises, and
     reading an old chat registered as sending dozens of messages. Regenerating,
     editing and switching branches moved it too. And even a perfect count would
     not have converted into an allowance, because these providers meter a
     rolling window weighted by tokens rather than a number of messages.

     What replaced it reads the provider's own figure instead:
     content/inject/quota-probe.js observes the quota data the host app already
     receives, content/quota.js forwards it, and the worker stores it. Nothing
     about the allowance is inferred from the DOM any more. */

  // Every module here self-throttles internally (minimap caches per-element
  // meta + rAF-batches its draw; chatcard/recall/stats debounce their writes;
  // outline only re-renders while open). So we call them every tick — crucially
  // the minimap MUST run each time to RE-INJECT itself when the host app tears
  // our node out during its own re-renders. (A prior "only-on-content-change"
  // gate here made the minimap vanish on some chats — never again.)
  function onEngineUpdate(messages, windowedCount) {
    if (!contextAlive()) { showStaleNotice(); return; }
    lastMessages = messages;
    syncTheme(); // hosts flip theme without reloading
    syncRail();  // the host's rail shows up once the chat gets long (throttled)
    if (routeId() !== currentRoute) onChatSwitch();
    self.LCTHistoryLoader.maybeStart(adapter, messages);
    if (state.minimap && toolsUnlocked()) self.LCTMinimap.update(messages, adapter);
    else self.LCTMinimap.destroy();
    self.LCTTimeline.update(messages);
    self.LCTOutline.update(messages);
    if (!document.documentElement.hasAttribute("data-lct-virtual-history")) {
      self.LCTChatCard.update(messages);
    }
    // The virtual-history fixture exercises host paging in isolation. It is
    // intentionally not an archive source for the end-to-end test profile.
    if (!document.documentElement.hasAttribute("data-lct-virtual-history")) {
      self.LCTRecall.update(messages);
    }
    pushStats(windowedCount, messages.length);
    injectExportButtons();
    updateCountPill(windowedCount);
    maybeShowAha(messages.length, windowedCount);
    maybeOfferResume(messages);
    self.LCTSearch.refresh(messages);
  }

  function onChatSwitch() {
    currentRoute = routeId();
    loadedAt = Date.now(); // suppress save/offer while the host auto-scrolls
    resumeOffered = false;
    removeChip();
    seedFromProvider();
  }

  /* ---------- the complete map, without moving the page ----------
     The host mounts only its recent tail, and walking its scroller to the top
     to find the rest is what made opening a long chat feel like a page that
     could not sit still. The provider hands the whole conversation over in one
     request the background already makes — so the map arrives complete and the
     viewport never moves. */
  /* The provider's own count for the open conversation, kept for the health
     check. It is the only GROUND TRUTH available about how many messages this
     chat really has — everything else we report is a reading of a DOM that the
     host is free to fill with whatever it likes. When the two disagree, the
     DOM is the one that is wrong. */
  let providerCount = null;

  function seedFromProvider() {
    if (!state.enabled || !state.minimap || !toolsUnlocked()) return;
    const route = routeId();
    self.LCTChatIndex.load(adapter, (entries) => {
      if (routeId() !== route) return;
      providerCount = Array.isArray(entries) ? entries.length : null;
      self.LCTMinimap.seed(entries, route);
    });
  }

  // A branch switch (an edit or a regenerate) means the seed describes a
  // conversation that is no longer on screen. Re-ask, debounced — the host
  // remounts in bursts and each burst would otherwise be its own request.
  let staleTimer = null;
  self.LCTMinimap.setStaleHandler(() => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      const route = routeId();
      self.LCTChatIndex.refresh(adapter, (entries) => {
        if (routeId() === route) self.LCTMinimap.seed(entries, route);
      });
    }, 800);
  });

  /* ---------- make the invisible visible ---------- */

  function updateCountPill(windowedCount) {
    const mm = document.getElementById("lct-minimap");
    if (!mm) return;
    let pill = document.getElementById("lct-mm-count");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "lct-mm-count";
      pill.title = "Messages the speed engine has put to sleep. They wake instantly when you scroll to them.";
      mm.insertBefore(pill, mm.querySelector("#lct-mm-stage") || mm.querySelector("#lct-mm-canvas"));
    }
    if (windowedCount > 0) {
      pill.textContent = String(windowedCount);
      pill.style.display = "block";
    } else {
      pill.style.display = "none";
    }
  }

  // One-time "aha" per chat: quantify what the engine is doing.
  const ahaShown = new Set(); // pathnames, this tab session
  let upsoldThisSession = false;

  function maybeShowAha(total, windowedCount) {
    if (windowedCount < 50 || ahaShown.has(location.pathname)) return;
    ahaShown.add(location.pathname);
    let msg =
      `This chat has ${total} messages, and your browser is now rendering only ` +
      `${total - windowedCount} of them. Tvara keeps it fast.`;
    if (!toolsUnlocked() && !upsoldThisSession) {
      upsoldThisSession = true; // don't nag: one upsell line per session
      msg += ` Unlock minimap, search, timestamps & backup for ${self.LCTProduct.PRICE} once, in the extension popup.`;
    }
    flashNote(msg);
  }

  /* ---------- resume where you left off ----------
     Saved as a semantic anchor (message key + index), never pixels: our own
     speed engine changes the page's pixel height between sessions, and the
     host apps virtualize/reflow. Saves happen only after USER-initiated
     scrolls — ChatGPT/Claude auto-scroll on open and while streaming, and
     those must not clobber the reading position. */

  const POS_KEY = "positions";
  const posId = () => location.hostname + location.pathname;
  let resumeOffered = false;
  let loadedAt = Date.now();
  let lastUserInput = 0;
  let posScroller = null;
  let posSaveTimer = null;
  let chipTimer = null;

  for (const t of ["wheel", "touchmove", "mousedown"]) {
    window.addEventListener(t, () => (lastUserInput = Date.now()), {
      passive: true,
      capture: true
    });
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
        lastUserInput = Date.now();
      }
    },
    { passive: true, capture: true }
  );

  // Topmost message still visible in the viewport, by binary search: rects rise
  // monotonically in document order, so this costs ~log2(n) layout reads. The
  // scan it replaces read a rect for every message above the fold — at the
  // bottom of a 1,500-turn chat, that was all of them.
  function currentAnchor() {
    const n = lastMessages.length;
    if (!n) return null;
    let lo = 0, hi = n - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lastMessages[mid].getBoundingClientRect().bottom > 90) { at = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    // A collapsed (zero-height) row is a position nothing can be restored to.
    while (at >= 0 && at < n && lastMessages[at].getBoundingClientRect().height <= 0) at++;
    if (at < 0 || at >= n) return null;
    return { key: self.LCTTimeline.keyOf(lastMessages[at]), index: at, total: n };
  }

  function findSavedIndex(saved, messages) {
    if (!messages.length || !saved) return -1;
    if (saved.key) {
      for (let i = 0; i < messages.length; i++) {
        if (self.LCTTimeline.keyOf(messages[i]) === saved.key) return i;
      }
    }
    if (typeof saved.index === "number") {
      return Math.min(messages.length - 1, Math.max(0, saved.index));
    }
    return -1;
  }

  function trackScrollPosition(messages) {
    if (!messages.length) return;
    const s = self.LCTAdapters.findScroller(messages[0]);
    if (s === posScroller) return;
    posScroller = s;
    const target =
      s === document.scrollingElement || s === document.documentElement ? window : s;
    target.addEventListener("scroll", onScrollMaybeSave, { passive: true });
  }

  function onScrollMaybeSave() {
    if (Date.now() - loadedAt < 5000) return;        // host settling after open/nav
    if (Date.now() - lastUserInput > 3000) return;   // not user-initiated (auto-scroll)
    clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(async () => {
      const anchor = currentAnchor();
      if (!anchor) return;
      const { [POS_KEY]: positions } = await store.get(POS_KEY);
      const map = positions || {};
      map[posId()] = { ...anchor, t: Date.now() };
      const keys = Object.keys(map); // keep the 40 most recent chats
      if (keys.length > 40) {
        keys
          .sort((a, b) => map[a].t - map[b].t)
          .slice(0, keys.length - 40)
          .forEach((k) => delete map[k]);
      }
      store.set({ [POS_KEY]: map });
    }, 1200);
  }

  function removeChip() {
    clearTimeout(chipTimer);
    const chip = document.getElementById("lct-resume");
    if (chip) chip.remove();
  }

  async function maybeOfferResume(messages) {
    trackScrollPosition(messages);
    if (resumeOffered || messages.length < 20) return;
    resumeOffered = true;
    const { [POS_KEY]: positions } = await store.get(POS_KEY);
    const saved = positions && positions[posId()];
    const idx = findSavedIndex(saved, messages);
    if (idx < 0) return;
    const r = messages[idx].getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) return; // already on screen

    removeChip();
    const chip = document.createElement("button");
    chip.id = "lct-resume";
    chip.textContent = "↓ Resume where you left off";
    document.documentElement.appendChild(chip);
    chip.addEventListener("click", () => {
      removeChip();
      scrollToSaved(saved);
    });

    // a deliberate user scroll dismisses it; otherwise stay up a while
    const bornAt = Date.now();
    const onUserScroll = () => {
      if (Date.now() - bornAt < 1500) return;            // host settle scrolls
      if (Date.now() - lastUserInput > 400) return;      // not user-initiated
      window.removeEventListener("scroll", onUserScroll, true);
      removeChip();
    };
    window.addEventListener("scroll", onUserScroll, { capture: true, passive: true });
    chipTimer = setTimeout(() => {
      window.removeEventListener("scroll", onUserScroll, true);
      removeChip();
    }, 45000);
  }

  function scrollToSaved(saved) {
    let attempts = 0;
    const go = () => {
      const idx = findSavedIndex(saved, lastMessages);
      if (idx < 0) return;
      const el = lastMessages[idx];
      if (!el.isConnected) return;
      el.scrollIntoView({ block: "start" });
      // waking messages reflow the page — verify we landed, re-aim if not
      if (++attempts < 4) {
        setTimeout(() => {
          const r = el.getBoundingClientRect();
          if (Math.abs(r.top) > 60) go();
        }, 450);
      }
    };
    go();
  }

  /* ---------- export buttons ---------- */

  function injectExportButtons() {
    const mm = document.getElementById("lct-minimap");
    // The minimap hides itself (display:none) under 4 messages, under a host
    // modal, or in a cramped window — see minimap.js. A bar docked inside it
    // at that point collapses to 0x0 with it and stops being clickable, even
    // though the toolbar's own features have nothing to do with that rule.
    const mmVisible = !!mm && mm.style.display !== "none";
    let bar = document.getElementById("lct-export-bar");
    if (bar) {
      if (mmVisible && bar.parentElement !== mm) {
        bar.classList.remove("lct-floating");
        mm.appendChild(bar);
      } else if (!mmVisible && !bar.classList.contains("lct-floating")) {
        bar.classList.add("lct-floating");
        document.documentElement.appendChild(bar);
      }
      return;
    }
    bar = document.createElement("div");
    bar.id = "lct-export-bar";
    // static markup only — no user/storage data goes through innerHTML
    bar.innerHTML = `
      <button data-act="outline" title="Outline &amp; starred messages" aria-label="Outline and starred messages">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
      </button>
      <button data-act="search" title="Search this conversation" aria-label="Search this conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/></svg>
      </button>
      <button data-act="bridge" title="Context Bridge: pull a past answer from any AI into this prompt" aria-label="Context Bridge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17V9a3 3 0 0 1 3-3h10"/><path d="m14 3 3 3-3 3"/><path d="M20 7v8a3 3 0 0 1-3 3H7"/><path d="m10 21-3-3 3-3"/></svg>
      </button>
      <button data-act="carry" title="Continue in a new chat: carry the goal, your starred messages and the last few turns into a fresh conversation" aria-label="Continue in a new chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h13"/><path d="m13 6 6 6-6 6"/><path d="M20 4v16" opacity=".45"/></svg>
      </button>
      <button data-act="history" title="Mount every older message in the page itself, so the site's own Ctrl+F can find it too. Tvara's own search and backups already cover the full conversation without this." aria-label="Mount every older message in the page">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5"/><path d="m6 11 6-6 6 6"/><path d="M4 3h16"/></svg>
      </button>
      <button data-fmt="md" title="Backup chat as Markdown" aria-label="Backup chat as Markdown">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>
      </button>
      <button data-fmt="json" title="Backup chat as JSON" aria-label="Backup chat as JSON">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>
      </button>
    `;
    if (mmVisible) {
      mm.appendChild(bar);
    } else {
      bar.classList.add("lct-floating");
      document.documentElement.appendChild(bar);
    }
    // Only offered where the host actually pages its transcript; everywhere
    // else the whole conversation is already mounted and the button would be a
    // lie. Placed here, once, because the bar is built once.
    if (!self.LCTHistoryLoader.supported(adapter)) {
      bar.querySelector('[data-act="history"]').remove();
    }
    bar.addEventListener("click", (e) => {
      const act = e.target.closest("button[data-act]");
      if (act) {
        if (!toolsUnlocked()) return showUpgradeNote();
        /* Every feature needs a path that is not a keystroke. Chrome drops a
           suggested shortcut whenever another extension already holds it — on
           the machine this was written on, ⌘⇧F was taken and in-chat search
           had no way in at all. A toolbar button cannot be taken by anyone. */
        if (act.dataset.act === "search") return self.LCTSearch.toggle();
        if (act.dataset.act === "bridge") {
          if (!recallUnlocked()) { flashNote("Context Bridge is a Pro feature. " + TRIAL_NUDGE); return; }
          return self.LCTBridge.isOpen ? self.LCTBridge.close() : self.LCTBridge.open();
        }
        if (act.dataset.act === "carry") {
          if (!lastMessages.length) return flashNote("Nothing to carry over yet. Open a conversation first.");
          return self.LCTCarry.open(lastMessages);
        }
        if (act.dataset.act === "history") {
          const began = self.LCTHistoryLoader.start(adapter);
          flashNote(began
            ? "Mounting every older message. The page scrolls while it runs. Scroll or press a key to stop."
            : "Already mounting older messages.");
          return;
        }
        return self.LCTOutline.toggle();
      }
      const btn = e.target.closest("button[data-fmt]");
      if (!btn) return;
      if (!toolsUnlocked()) return showUpgradeNote();
      /* Say which backup they got. "the 197 loaded messages" was honest and
         quietly disappointing on a 1,471-message conversation; when the archive
         completes it, the sentence should say so. */
      self.LCTExporter.exportChat(adapter, btn.dataset.fmt, timeFn()).then((res) => {
        if (!res || !res.ok) return;
        flashNote(res.whole
          ? `Backed up the whole conversation: ${res.count.toLocaleString()} messages, ` +
            `including ${(res.count - res.loaded).toLocaleString()} this page had not loaded`
          : `Backed up the ${res.count.toLocaleString()} loaded messages`);
      }).catch(() => { /* the download either happened or it did not */ });
    });
  }

  function showUpgradeNote() {
    flashNote(`Tools on this site are Pro: ${self.LCTProduct.PRICE} once, forever. Open the extension popup to unlock.`);
  }

  /* ---------- stale context ----------
     Reloading or removing-then-reinstalling the extension (chrome://extensions,
     or Chrome updating it) does not touch tabs that were already open — their
     content script keeps running, but chrome.runtime is disconnected from
     anything. Every message call in this file would then silently go nowhere:
     search opens with nothing to ask, Bridge and Recall find no worker to
     answer, and it reads as "broken" with zero errors anywhere, because
     nothing threw — the calls just never had anywhere to land. There is no
     way to reconnect a content script to a new extension instance short of
     the browser mounting a fresh one, so the only honest fix is telling the
     reader plainly and giving them the one click that actually works. */
  let staleShown = false;
  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }
  function showStaleNotice() {
    if (staleShown) return;
    staleShown = true;
    const n = document.createElement("div");
    n.id = "lct-stale";
    const msg = document.createElement("span");
    msg.textContent = "Tvara was updated. Refresh this tab to keep using it.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Refresh";
    btn.addEventListener("click", () => location.reload());
    n.append(msg, btn);
    document.documentElement.appendChild(n);
    requestAnimationFrame(() => n.classList.add("lct-stale-show"));
  }

  let noteTimer = null;
  // Shared, so a module loaded before this one can still speak in the same
  // voice instead of inventing a second toast.
  self.LCTNote = (text) => flashNote(text);
  function flashNote(text) {
    let n = document.getElementById("lct-note");
    if (!n) {
      n = document.createElement("div");
      n.id = "lct-note";
      document.documentElement.appendChild(n);
    }
    n.textContent = text;
    n.classList.add("lct-note-show");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => n.classList.remove("lct-note-show"), 4500);
  }

  /* ---------- settings / license ---------- */

  async function loadState() {
    const { settings } = await store.get(["settings"]);
    if (settings) {
      state.enabled = settings.enabled !== false;
      state.minimap = settings.minimap !== false;
      state.time = settings.time !== false;
      state.history = settings.history === true;   // opt-in: it moves the page
      state.tempArchive = settings.tempArchive === true;
    }
    // The worker holds the signed entitlement; content scripts only ask.
    // A hostile page shares this DOM but not this message channel.
    const verdict = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "entitlement-state" }, res));
    state.pro = !!(verdict && verdict.entitled && verdict.via !== "trial");
    state.trialUntil = (verdict && verdict.trial && verdict.trial.until) || 0;
  }

  function applyState() {
    self.LCTRecall.setTempArchive(state.enabled && state.tempArchive);
    self.LCTHistoryLoader.setAuto(state.enabled && state.history && toolsUnlocked());
    self.LCTTimeline.setDisplay(state.enabled && state.time && toolsUnlocked());
    self.LCTOutline.setEnabled(state.enabled && toolsUnlocked());
    self.LCTChatCard.setEnabled(state.enabled && toolsUnlocked());
    if (state.enabled) {
      if (!self.LCTEngine.enabled) self.LCTEngine.start(adapter, onEngineUpdate);
      else self.LCTEngine.rescan();
    } else {
      self.LCTEngine.stop();
      self.LCTHistoryLoader.stop();
      self.LCTMinimap.destroy();
      const bar = document.getElementById("lct-export-bar");
      if (bar) bar.remove();
      removeChip();
    }
  }

  try {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      if (changes.settings || changes.license || changes["lct-entitlement-v2"] || changes["lct-trial-v2"]) {
        await loadState();
        applyState();
      }
    });
  } catch (_) {
    /* extension context already gone — run with defaults */
  }

  /* ---------- in-chat search hotkey ---------- */

  self.LCTTimeline.init(adapter);
  self.LCTSearch.init(adapter);
  self.LCTOutline.init(adapter);
  self.LCTChatCard.init(adapter, store);
  // Total Recall search + Context Bridge are Pro/trial features. Full-history
  // sync is intentionally owned by the background worker so page reloads
  // cannot start a competing archive sweep.
  const recallUnlocked = () => state.enabled && (state.pro || trialActive());
  self.LCTRecall.init(adapter, recallUnlocked);
  self.LCTBridge.init(adapter, recallUnlocked);

  // Keyboard shortcuts come from the browser's commands API (remappable at
  // chrome://extensions/shortcuts — the only cross-OS/cross-browser-safe way).
  // The background relays the pressed command through storage; the ACTIVE tab
  // (the one the user is looking at) handles it. Gating + locked-feedback here.
  const TRIAL_NUDGE = "start the free 7-day trial in the extension popup.";
  function dispatchCommand(name) {
    if (!state.enabled) return;
    if (name === "in-chat-search") {
      if (!toolsUnlocked()) { flashNote("In-chat search is Pro here. " + TRIAL_NUDGE); return; }
      self.LCTSearch.toggle();
    } else if (name === "open-recall") {
      if (!recallUnlocked()) { flashNote("Total Recall is a Pro feature. " + TRIAL_NUDGE); return; }
      self.LCTRecall.isOpen ? self.LCTRecall.close() : self.LCTRecall.open();
    } else if (name === "open-bridge") {
      if (!recallUnlocked()) { flashNote("Context Bridge is a Pro feature. " + TRIAL_NUDGE); return; }
      self.LCTBridge.isOpen ? self.LCTBridge.close() : self.LCTBridge.open();
    }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes["lct-cmd"] || !changes["lct-cmd"].newValue) return;
      const sig = changes["lct-cmd"].newValue;
      if (Date.now() - sig.at > 4000) return;              // stale
      if (document.visibilityState !== "visible") return;  // only the active tab
      dispatchCommand(sig.name);
    });
  } catch (_) { /* storage API unavailable */ }

  /* ---------- sync every past chat, just by showing up ----------
     Opening the site is the one moment we know the provider session is alive
     and authenticated, so it is the right moment to catch the archive up on
     everything this browser has never seen. The background worker owns the
     work AND the throttle — this only says "a tab is here now". */
  function kickVisitSync() {
    try {
      chrome.runtime.sendMessage({ type: "recall-visit-sync", platform: adapter.id }, () => {
        void chrome.runtime.lastError;   // worker asleep / context gone: fine
      });
    } catch (_) { /* extension context already invalidated */ }
  }

  /* ---------- health check ----------
     These sites redesign without telling anyone, and our adapters are built to
     degrade quietly rather than break the page — which means the day ChatGPT
     renames an attribute, everything still "works" on a heuristic fallback and
     nobody finds out until the minimap looks wrong.

     This answers, in one call, the only question that matters after a
     redesign: are we still matching what this platform actually ships, or are
     we limping? It reads the page; it changes nothing. */
  const probe = (fn) => { try { return fn(); } catch { return "threw"; } };

  function health() {
    let messages = [];
    try { messages = adapter.messages() || []; } catch (_) { /* adapter threw */ }
    // What the selectors matched before the empty-turn filter ran, so the gap
    // between "elements on the page" and "messages" is visible rather than
    // quietly absorbed.
    let matched = messages.length;
    try { matched = (adapter.rawMessages ? adapter.rawMessages() : messages).length; } catch { /* keep */ }

    let canonical = 0;
    if (adapter.canon) {
      for (const el of messages) {
        try {
          if (el.matches?.(adapter.canon) || el.querySelector?.(adapter.canon) ||
              el.closest?.(adapter.canon)) canonical++;
        } catch { /* a selector this browser dislikes counts as no match */ }
      }
    }

    const roles = { user: 0, assistant: 0 };
    for (const el of messages) {
      try { roles[adapter.role(el) === "user" ? "user" : "assistant"]++; } catch { /* skip */ }
    }

    /* A role split of 188 mine to 12 the model's is not a conversation — it is
       a guess. The message selector can keep matching (so the check says
       "primary") while the ROLE marker moves somewhere the resolver does not
       look, and every turn quietly falls through to the heuristics. So count
       how many roles were actually READ, and say so. */
    let roleRead = null;
    // WHERE the role came from, not just whether it came. A live chat reported
    // 195 of 195 roles read and a split of 185 to 10 — both cannot be true of a
    // conversation, so the next question is which node answered.
    const roleFrom = { self: 0, ancestor: 0, descendant: 0, none: 0 };
    if (adapter.roleCanon) {
      roleRead = 0;
      for (const el of messages) {
        try {
          if (el.matches?.(adapter.roleCanon)) { roleFrom.self++; roleRead++; }
          else if (el.closest?.(adapter.roleCanon)) { roleFrom.ancestor++; roleRead++; }
          else if (el.querySelector?.(adapter.roleCanon)) { roleFrom.descendant++; roleRead++; }
          else roleFrom.none++;
        } catch { roleFrom.none++; }
      }
    }

    /* Two matched nodes reporting the same provider id are the same message
       counted twice — and unlike the nested case, they can be siblings, which
       is why a containment check alone said everything was fine. */
    let distinctIds = null;
    if (self.LCTAdapters.stableKey) {
      const ids = new Set();
      let withId = 0;
      for (const el of messages) {
        try {
          const k = self.LCTAdapters.stableKey(el);
          if (k) { ids.add(k); withId++; }
        } catch { /* skip */ }
      }
      distinctIds = withId ? { distinct: ids.size, of: withId } : null;
    }

    /* A handful of shapes, so a redesign can be READ rather than guessed at.
       Structural attributes only — a role, a turn marker, a testid, and the
       mere PRESENCE of an id. No text, no ids, nothing that identifies a
       conversation. */
    const SHAPE_ATTRS = ["data-message-author-role", "data-turn", "data-testid"];
    const shapeOf = (el) => {
      let s = (el.tagName || "?").toLowerCase();
      for (const a of SHAPE_ATTRS) {
        if (el.hasAttribute?.(a)) s += `[${a}=${String(el.getAttribute(a) || "").slice(0, 24)}]`;
      }
      if (el.hasAttribute?.("data-message-id")) s += "[data-message-id]";
      if (el.classList?.contains("sr-only") || el.getAttribute?.("aria-hidden") === "true") s += "[hidden]";
      // The question the counts raised: are these nodes MESSAGES, or the empty
      // placeholders a virtualizing host leaves behind for turns it has not
      // mounted? An element with no text is not a message anyone can read.
      if (!(el.textContent || "").trim()) {
        s += el.querySelector("img[src],img[srcset],video,canvas") ? "[image-only]" : "[empty]";
        /* An element with no text that is still being treated as a message got
           there by matching the media test — a message whose whole content is
           an image has no text either. Which media, and what is actually
           inside these things, is the difference between a filter that works
           and one that reports 121 placeholders as messages. Tag names only:
           structure, never content. */
        const kids = new Set();
        for (const k of el.querySelectorAll("*")) {
          kids.add(k.tagName.toLowerCase());
          if (kids.size >= 4) break;
        }
        s += kids.size ? `[has:${[...kids].join(",")}]` : "[hollow]";
      } else if ((el.textContent || "").trim().length < 8) s += "[tiny]";
      return s;
    };
    const shapes = {};
    for (const el of messages.slice(0, 400)) {
      try {
        const k = shapeOf(el);
        shapes[k] = (shapes[k] || 0) + 1;
      } catch { /* skip */ }
    }
    const shapeList = Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 8);

    /* Substance, per side. A count of elements is not a count of messages, and
       the difference between them is where a phantom lives. The rect read costs
       a layout, so it is capped and only paid on demand — this whole report is
       something a person clicked a button to get. */
    const SAMPLE = 400;
    /* "empty" was doing two jobs and getting one of them wrong. A message that
       is a pasted screenshot with no caption has no TEXT, but it is not empty
       and it is certainly not a placeholder — on a live 591-message chat, 122
       of the user's turns were exactly that, and the report called every one of
       them scaffolding. Media and nothing are different states now. */
    const substance = { empty: 0, tiny: 0, real: 0, image: 0, unrendered: 0,
                        emptyUser: 0, emptyAssistant: 0,
                        // Both this and the shape list read the first SAMPLE
                        // elements. A capped number presented as a total is the
                        // kind of tidy lie this whole page exists to catch.
                        sampled: Math.min(messages.length, SAMPLE) };
    for (const el of messages.slice(0, SAMPLE)) {
      try {
        const text = (el.textContent || "").trim();
        if (!text) {
          const hasMedia = el.querySelector("img[src],img[srcset],video,canvas,[data-testid*='attachment' i]");
          if (hasMedia) substance.image++;
          else {
            substance.empty++;
            adapter.role(el) === "user" ? substance.emptyUser++ : substance.emptyAssistant++;
          }
        } else if (text.length < 8) substance.tiny++;
        else substance.real++;
        // An asleep message keeps its frozen height, so zero here means the
        // host is not rendering it at all — not that we put it to sleep.
        const r = el.getBoundingClientRect?.();
        if (r && r.height === 0) substance.unrendered++;
      } catch { /* skip */ }
    }

    /* The other way a count goes wrong: an outer and an inner node both match,
       so one turn is counted twice. Cheap to detect — a message that sits
       inside another message. */
    let nested = 0;
    if (messages.length && messages.length < 4000) {
      const set = new Set(messages);
      for (const el of messages) {
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (set.has(p)) { nested++; break; }
        }
      }
    }

    // The engine's own marker class — counted from the DOM rather than from a
    // number we keep, so the report cannot agree with a stale counter.
    const sleeping = document.getElementsByClassName("lct-cv").length;

    return {
      at: Date.now(),
      version: chrome.runtime.getManifest().version,
      host: location.hostname,
      path: location.pathname.replace(/[^/]{12,}/g, "…"),   // never the chat id
      adapter: adapter.id,
      platform: adapter.label,     // "ChatGPT", not a capitalised hostname
      inConversation: adapter.convPath ? adapter.convPath.test(location.pathname) : null,
      messages: messages.length,
      // What the provider itself says this conversation contains. Null where a
      // platform publishes no index (Gemini, Perplexity) — absent, not zero.
      providerCount,
      matched,
      dropped: Math.max(0, matched - messages.length),
      canonical,
      // The headline. "degraded" is not an error — it is the early warning that
      // used to arrive as a support email six weeks late.
      selectors: !messages.length ? "no messages found"
        : !adapter.canon ? "unknown"
        : canonical === messages.length ? "primary"
        : canonical === 0 ? "DEGRADED · running on a fallback layer"
        : `mixed (${canonical}/${messages.length} canonical)`,
      roles,
      // null = this platform has no positive marker for both sides, so roles
      // are inferred by design and a lopsided split means nothing.
      roleRead,
      roleFrom,
      distinctIds,
      substance,
      shapes: shapeList,
      nested,
      sleeping,
      // Each probe is guarded on its own: a report that dies because one lookup
      // threw is a report that tells you nothing about the other nine.
      composer: probe(() => !!(adapter.composer && adapter.composer())),
      // findScroller walks up from a MESSAGE, not from the adapter — with no
      // messages there is nothing to walk from, and that is not a failure.
      scroller: messages.length ? probe(() => !!self.LCTAdapters.findScroller(messages[0])) : null,
      engine: !!self.LCTEngine.enabled,
      minimap: !!document.getElementById("lct-minimap"),
      settings: { enabled: state.enabled, minimap: state.minimap, time: state.time },
      plan: state.pro ? "pro" : trialActive() ? "trial" : "free"
    };
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (!msg || msg.type !== "lct-health") return;
      try { respond(health()); } catch (e) { respond({ error: String(e && e.message || e) }); }
      return true;
    });
  } catch (_) { /* extension context gone */ }

  /* ---------- first-run hint ----------
     The welcome tab teaches the shortcuts once, in a tab most people close in
     four seconds. This is the same lesson delivered where it is used, on the
     first real conversation — once ever, dismissible, and printing the keys
     the browser actually bound rather than the ones we asked for.

     Docked left of the minimap rather than bottom-centre: that lane already
     holds the resume chip and the note toast, and a hint that lands on top of
     "resume where you left off" teaches one thing by hiding another. */
  const HINT_KEY = "lct-hint-v1";

  function hintKeys(commands) {
    const mac = (() => {
      /* navigator.platform is deprecated and userAgentData is not on every
         browser this runs in, so both are asked, in that order, and the answer
         is only ever used to choose a symbol. */
      const d = (typeof navigator !== "undefined" && navigator.userAgentData) || null;
      if (d && typeof d.platform === "string") return /mac/i.test(d.platform);
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      return /Mac|iPhone|iPad/i.test(ua);
    })();
    const pretty = (s) => !s ? null : s
      .replace(/Command/g, "⌘")
      .replace(/Shift/g, mac ? "⇧" : "Shift")
      .replace(/Alt/g, mac ? "⌥" : "Alt")
      .replace(/\+/g, mac ? "" : "+");
    const by = new Map((commands || []).map((c) => [c.name, pretty(c.shortcut)]));
    return [
      [by.get("in-chat-search"), "search this conversation"],
      [by.get("open-recall"), "search every chat, everywhere"]
    ].filter(([k]) => k);   // an unbound command is not worth teaching
  }

  function showHint(rows) {
    if (!rows.length || document.getElementById("lct-hint")) return;
    const card = document.createElement("div");
    card.id = "lct-hint";
    card.setAttribute("role", "status");

    const title = document.createElement("div");
    title.className = "lct-hint-title";
    title.textContent = "Tvara is on";
    card.appendChild(title);

    for (const [key, what] of rows) {
      const row = document.createElement("div");
      row.className = "lct-hint-row";
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      const span = document.createElement("span");
      span.textContent = what;
      row.append(kbd, span);
      card.appendChild(row);
    }

    /* Point at the strip, not just at the keyboard. Everything this extension
       can do on the page lives in a navigator that only appears on hover — so a
       hint that lists three keystrokes and never mentions it leaves search, the
       outline, Context Bridge and the carry-over undiscovered. And a shortcut
       can be missing entirely: Chrome drops one another extension already
       holds, which is exactly what happened to search on the machine this was
       written on. */
    const where = document.createElement("div");
    where.className = "lct-hint-row lct-hint-where";
    const arrow = document.createElement("kbd");
    arrow.textContent = "→";
    const wtext = document.createElement("span");
    wtext.textContent = "hover the strip on the right for search, outline and more";
    where.append(arrow, wtext);
    card.appendChild(where);

    const close = document.createElement("button");
    close.className = "lct-hint-ok";
    close.type = "button";
    close.textContent = "Got it";
    const dismiss = () => { clearTimeout(timer); card.remove(); };
    close.addEventListener("click", dismiss);
    card.appendChild(close);

    document.documentElement.appendChild(card);
    requestAnimationFrame(() => card.classList.add("lct-hint-show"));

    /* Show the navigator its full width for a moment while the hint is up.
       "Hover the strip on the right" means nothing if the strip is a 13px
       hairline the reader has not noticed yet. It returns to rest on its own,
       and a hover in the meantime just keeps it open. */
    const map = document.getElementById("lct-minimap");
    if (map) {
      map.classList.remove("lct-mm-rest");
      setTimeout(() => {
        if (!map.matches(":hover")) map.classList.add("lct-mm-rest");
      }, 4000);
    }
    const timer = setTimeout(dismiss, 14000);
  }

  async function maybeHint() {
    if (!state.enabled) return;
    const got = await store.get([HINT_KEY]);
    // An orphaned content script reads {} from a dead context — which looks
    // exactly like a first run. Say nothing rather than repeat the lesson on
    // every page load until the tab is reloaded.
    if (!store.alive || (got && got[HINT_KEY])) return;
    // Written BEFORE the card is drawn, so two tabs opening at once cannot both
    // decide they are the first.
    await store.set({ [HINT_KEY]: Date.now() });
    if (!store.alive) return;
    const commands = await new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: "commands" }, (r) => {
          void chrome.runtime.lastError; res(r);
        });
      } catch { res(null); }
    });
    showHint(hintKeys(commands));
  }

  loadState().then(() => {
    applyState();
    seedFromProvider();
    if (state.enabled) kickVisitSync();
    maybeHint();
    // A handover staged by "Continue in a new chat" is waiting on the other
    // side of window.open. Only ever into an empty conversation, and only for
    // a few minutes — see carry.js.
    if (state.enabled && toolsUnlocked()) self.LCTCarry.deliver();
  });

  // The onEngineUpdate check above only runs when the host mutates the page —
  // a tab left open on a chat nobody is typing in can sit invalidated for a
  // long time with no tick to catch it. This runs regardless of page activity.
  setInterval(() => { if (!contextAlive()) showStaleNotice(); }, 4000);
})();
