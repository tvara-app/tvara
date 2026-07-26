/**
 * Long Chat Toolkit — orchestrator.
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
    history: false,    // walk the host's scroller on open — off, it moves the page
    pro: false,
    trialUntil: 0      // ms epoch; 0 = no trial started
  };

  // Pricing slice: the speed engine is FREE everywhere (our gift + reputation).
  // Tools (minimap, search, outline, timestamps, backup) are free on ChatGPT;
  // Pro ($9 once) or the 7-day trial unlocks them on Claude & Gemini.
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
  const routeId = () => location.hostname + location.pathname;
  let currentRoute = routeId();
  let statsTimer = null;

  /* ---------- theme ----------
     Our surfaces follow the SITE's theme, not the OS's: a white minimap on a
     dark ChatGPT is the mismatch people actually notice. Stamped on <html>,
     where styles.css picks it up (data-lct-theme outranks the media query). */
  function syncTheme() {
    let dark = null;
    for (const el of [document.body, document.documentElement]) {
      const m = el && getComputedStyle(el).backgroundColor
        .match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?/);
      if (!m || (m[4] !== undefined && +m[4] < 0.5)) continue; // see-through: keep looking
      dark = (+m[1] * 299 + +m[2] * 587 + +m[3] * 114) / 1000 < 128;
      break;
    }
    if (dark === null) dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "dark" : "light";
    if (document.documentElement.dataset.lctTheme !== next) {
      document.documentElement.dataset.lctTheme = next;
    }
  }
  syncTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);

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

  // Every module here self-throttles internally (minimap caches per-element
  // meta + rAF-batches its draw; chatcard/recall/stats debounce their writes;
  // outline only re-renders while open). So we call them every tick — crucially
  // the minimap MUST run each time to RE-INJECT itself when the host app tears
  // our node out during its own re-renders. (A prior "only-on-content-change"
  // gate here made the minimap vanish on some chats — never again.)
  function onEngineUpdate(messages, windowedCount) {
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
    self.LCTSearch.refresh();
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
  function seedFromProvider() {
    if (!state.enabled || !state.minimap || !toolsUnlocked()) return;
    const route = routeId();
    self.LCTChatIndex.load(adapter, (entries) => {
      if (routeId() === route) self.LCTMinimap.seed(entries, route);
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
      pill.title = "Messages the speed engine has put to sleep — they wake instantly when you scroll to them.";
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
      `This chat has ${total} messages — your browser is now rendering only ` +
      `${total - windowedCount} of them. Long Chat Toolkit keeps it fast.`;
    if (!toolsUnlocked() && !upsoldThisSession) {
      upsoldThisSession = true; // don't nag: one upsell line per session
      msg += " Unlock minimap, search, timestamps & backup — $9 once, in the extension popup.";
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

  function currentAnchor() {
    // topmost message still visible in the viewport
    for (let i = 0; i < lastMessages.length; i++) {
      const r = lastMessages[i].getBoundingClientRect();
      if (r.height > 0 && r.bottom > 90) {
        return {
          key: self.LCTTimeline.keyOf(lastMessages[i]),
          index: i,
          total: lastMessages.length
        };
      }
    }
    return null;
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
    let bar = document.getElementById("lct-export-bar");
    if (bar) {
      // re-dock into the minimap if one (re)appeared
      if (mm && bar.parentElement !== mm) {
        bar.classList.remove("lct-floating");
        mm.appendChild(bar);
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
      <button data-act="history" title="Mount every older message in the page itself — for the site's own Ctrl+F and a full backup. The map is already complete without this." aria-label="Mount every older message in the page">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5"/><path d="m6 11 6-6 6 6"/><path d="M4 3h16"/></svg>
      </button>
      <button data-fmt="md" title="Backup chat as Markdown" aria-label="Backup chat as Markdown">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>
      </button>
      <button data-fmt="json" title="Backup chat as JSON" aria-label="Backup chat as JSON">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>
      </button>
    `;
    if (mm) {
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
        if (act.dataset.act === "history") {
          const began = self.LCTHistoryLoader.start(adapter);
          flashNote(began
            ? "Mounting every older message — the page scrolls while it runs. Scroll or press a key to stop."
            : "Already mounting older messages.");
          return;
        }
        return self.LCTOutline.toggle();
      }
      const btn = e.target.closest("button[data-fmt]");
      if (!btn) return;
      if (!toolsUnlocked()) return showUpgradeNote();
      const res = self.LCTExporter.exportChat(adapter, btn.dataset.fmt, timeFn());
      if (res.ok) {
        flashNote(`Backed up the ${res.count} loaded messages`);
      }
    });
  }

  function showUpgradeNote() {
    flashNote("Tools on this site are Pro — $9 once, forever. Open the extension popup to unlock.");
  }

  let noteTimer = null;
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
    const { settings, license, trial } = await store.get(["settings", "license", "trial"]);
    if (settings) {
      state.enabled = settings.enabled !== false;
      state.minimap = settings.minimap !== false;
      state.time = settings.time !== false;
      state.history = settings.history === true;   // opt-in: it moves the page
    }
    state.trialUntil = trial && trial.startedAt ? trial.startedAt + 7 * 864e5 : 0;
    state.pro = (await self.LCTLicense.evaluate(license)).pro;
  }

  function applyState() {
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
      if (changes.settings || changes.license || changes.trial) {
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
      if (!toolsUnlocked()) { flashNote("In-chat search is Pro here — " + TRIAL_NUDGE); return; }
      self.LCTSearch.toggle();
    } else if (name === "open-recall") {
      if (!recallUnlocked()) { flashNote("Total Recall is a Pro feature — " + TRIAL_NUDGE); return; }
      self.LCTRecall.isOpen ? self.LCTRecall.close() : self.LCTRecall.open();
    } else if (name === "open-bridge") {
      if (!recallUnlocked()) { flashNote("Context Bridge is a Pro feature — " + TRIAL_NUDGE); return; }
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

  loadState().then(() => {
    applyState();
    seedFromProvider();
    if (state.enabled) kickVisitSync();
  });
})();
