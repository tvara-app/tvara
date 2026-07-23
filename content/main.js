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
    fold: false,       // collapse code blocks (off by default — opt-in)
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
  let currentHref = location.href;
  let statsTimer = null;

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

  function onEngineUpdate(messages, windowedCount) {
    lastMessages = messages;
    if (location.href !== currentHref) onChatSwitch();
    if (state.minimap && toolsUnlocked()) self.LCTMinimap.update(messages, adapter);
    else self.LCTMinimap.destroy();
    self.LCTTimeline.update(messages);
    self.LCTOutline.update(messages);
    self.LCTChatCard.update(messages);
    self.LCTRecall.update(messages);
    pushStats(windowedCount, messages.length);
    injectExportButtons();
    updateCountPill(windowedCount);
    maybeShowAha(messages.length, windowedCount);
    maybeOfferResume(messages);
    self.LCTSearch.refresh();
  }

  function onChatSwitch() {
    currentHref = location.href;
    loadedAt = Date.now(); // suppress save/offer while the host auto-scrolls
    resumeOffered = false;
    removeChip();
  }

  /* ---------- make the invisible visible ---------- */

  function updateCountPill(windowedCount) {
    const mm = document.getElementById("lct-minimap");
    if (!mm) return;
    let pill = document.getElementById("lct-mm-count");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "lct-mm-count";
      pill.title = "Messages the speed engine has put to sleep — they wake instantly when you scroll to them.";
      mm.insertBefore(pill, mm.querySelector("#lct-mm-canvas"));
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
    bar.addEventListener("click", (e) => {
      const act = e.target.closest("button[data-act]");
      if (act) {
        if (!toolsUnlocked()) return showUpgradeNote();
        return self.LCTOutline.toggle();
      }
      const btn = e.target.closest("button[data-fmt]");
      if (!btn) return;
      if (!toolsUnlocked()) return showUpgradeNote();
      const res = self.LCTExporter.exportChat(adapter, btn.dataset.fmt, timeFn());
      if (res.ok) {
        let msg = `Backed up the ${res.count} loaded messages`;
        if (adapter.id === "chatgpt") {
          msg += " — for a huge chat, scroll to the top first (ChatGPT unloads old messages)";
        }
        flashNote(msg);
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
      state.fold = settings.fold === true;
    }
    state.trialUntil = trial && trial.startedAt ? trial.startedAt + 7 * 864e5 : 0;
    state.pro = false;
    if (license && license.key) {
      const res = await self.LCTLicense.verify(license.key);
      state.pro = res.valid;
    }
  }

  function applyState() {
    self.LCTTimeline.setDisplay(state.enabled && state.time && toolsUnlocked());
    self.LCTOutline.setEnabled(state.enabled && toolsUnlocked());
    self.LCTChatCard.setEnabled(state.enabled && toolsUnlocked());
    document.documentElement.classList.toggle("lct-fold-code", state.enabled && state.fold);
    if (state.enabled) {
      if (!self.LCTEngine.enabled) self.LCTEngine.start(adapter, onEngineUpdate);
      else self.LCTEngine.rescan();
    } else {
      self.LCTEngine.stop();
      self.LCTMinimap.destroy();
      const bar = document.getElementById("lct-export-bar");
      if (bar) bar.remove();
      removeChip();
    }
  }

  /* collapsed code blocks: click a folded block to expand it,
     double-click an expanded one to fold it back */
  document.addEventListener("click", (e) => {
    if (!state.fold || !state.enabled) return;
    const pre = e.target.closest("pre");
    if (!pre || pre.classList.contains("lct-pre-open")) return;
    if (pre.closest('[id^="lct-"]')) return;
    pre.classList.add("lct-pre-open");
  });
  document.addEventListener("dblclick", (e) => {
    if (!state.fold || !state.enabled) return;
    const pre = e.target.closest("pre.lct-pre-open");
    if (pre) pre.classList.remove("lct-pre-open");
  });

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
  // Total Recall is Pro/trial on EVERY platform (the golden feature) — but
  // indexing always runs: a user who upgrades later gets their history, and
  // the data never leaves the machine either way.
  self.LCTRecall.init(adapter, () => state.enabled && (state.pro || trialActive()));
  document.addEventListener(
    "keydown",
    (e) => {
      // e.code, not e.key: keeps working on non-Latin keyboard layouts
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyF") {
        if (!toolsUnlocked()) return; // never eat a keystroke we won't serve
        e.preventDefault();
        e.stopPropagation();
        self.LCTSearch.toggle();
      }
    },
    true
  );

  loadState().then(applyState);
})();
