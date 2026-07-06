/**
 * Long Chat Toolkit — orchestrator.
 * Wires adapter → engine → minimap → exporter, reads settings/license from
 * chrome.storage, and reacts live to changes made in the popup.
 */
(() => {
  "use strict";

  const adapter = self.LCTAdapters.detect();
  if (!adapter) return; // unknown host — do nothing, break nothing

  const state = {
    enabled: true,
    minimap: true,
    pro: false
  };

  // Pricing slice: the speed engine is FREE everywhere (our gift + reputation).
  // Tools (minimap, search, backup) are free on ChatGPT and the test page;
  // Pro ($9 once) unlocks them on Claude, Gemini & Perplexity.
  const FREE_TOOL_PLATFORMS = new Set(["chatgpt", "synthetic"]);
  const toolsUnlocked = () => state.pro || FREE_TOOL_PLATFORMS.has(adapter.id);

  let statsTimer = null;

  function pushStats(windowed) {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      chrome.storage.local.get("stats").then(({ stats }) => {
        stats = stats || { totalWindowed: 0, perHost: {} };
        stats.perHost[location.hostname] = {
          windowed,
          platform: adapter.label,
          updatedAt: Date.now()
        };
        stats.totalWindowed = Object.values(stats.perHost).reduce((s, h) => s + (h.windowed || 0), 0);
        chrome.storage.local.set({ stats });
      });
    }, 1500);
  }

  function onEngineUpdate(messages, windowedCount) {
    if (state.minimap && toolsUnlocked()) self.LCTMinimap.update(messages, adapter);
    else self.LCTMinimap.destroy();
    pushStats(windowedCount);
    injectExportButtons();
    updateCountPill(windowedCount);
    maybeShowAha(messages.length, windowedCount);
    maybeOfferResume(messages);
    self.LCTSearch.refresh();
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
      pill.textContent = "💤" + windowedCount;
      pill.style.display = "block";
    } else {
      pill.style.display = "none";
    }
  }

  // One-time "aha" per chat: quantify what the engine is doing.
  function maybeShowAha(total, windowedCount) {
    if (windowedCount < 50) return;
    const key = "lct-aha-" + location.pathname;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch (_) { return; }
    let msg =
      `⚡ This chat has ${total} messages — your browser is now rendering only ` +
      `${total - windowedCount} of them. Long Chat Toolkit keeps it fast.`;
    if (!toolsUnlocked()) {
      msg += " 💎 Unlock minimap, search & backup here — $9 once, in the extension popup.";
    }
    flashNote(msg);
  }

  /* ---------- resume where you left off ---------- */

  const POS_KEY = "positions";
  const posId = () => location.hostname + location.pathname;
  let resumeOffered = false;
  let posScroller = null;
  let posSaveTimer = null;

  function trackScrollPosition(messages) {
    if (!messages.length) return;
    const s = self.LCTAdapters.findScroller(messages[0]);
    if (s === posScroller) return;
    posScroller = s;
    const target = s === document.scrollingElement || s === document.documentElement ? window : s;
    target.addEventListener(
      "scroll",
      () => {
        clearTimeout(posSaveTimer);
        posSaveTimer = setTimeout(async () => {
          if (!posScroller || !posScroller.isConnected) return;
          const { [POS_KEY]: positions } = await chrome.storage.local.get(POS_KEY);
          const map = positions || {};
          map[posId()] = { top: posScroller.scrollTop, t: Date.now() };
          // keep the map small: 40 most recent chats
          const keys = Object.keys(map);
          if (keys.length > 40) {
            keys.sort((a, b) => map[a].t - map[b].t)
              .slice(0, keys.length - 40)
              .forEach((k) => delete map[k]);
          }
          chrome.storage.local.set({ [POS_KEY]: map });
        }, 2500);
      },
      { passive: true }
    );
  }

  async function maybeOfferResume(messages) {
    trackScrollPosition(messages);
    if (resumeOffered || messages.length < 20) return;
    resumeOffered = true;
    const { [POS_KEY]: positions } = await chrome.storage.local.get(POS_KEY);
    const saved = positions && positions[posId()];
    if (!saved || !posScroller || !posScroller.isConnected) return;
    if (Math.abs(posScroller.scrollTop - saved.top) < 1500) return;

    const chip = document.createElement("button");
    chip.id = "lct-resume";
    chip.textContent = "⤵ Resume where you left off";
    document.documentElement.appendChild(chip);
    chip.addEventListener("click", () => {
      if (posScroller && posScroller.isConnected) posScroller.scrollTo({ top: saved.top });
      chip.remove();
    });
    setTimeout(() => chip.remove(), 10000);
  }

  /* ---------- export buttons (in minimap header area) ---------- */

  function injectExportButtons() {
    const mm = document.getElementById("lct-minimap");
    if (!mm || document.getElementById("lct-export-bar")) return;
    const bar = document.createElement("div");
    bar.id = "lct-export-bar";
    bar.innerHTML = `
      <button data-fmt="md" title="Backup chat as Markdown (Pro)">💾</button>
    `;
    mm.appendChild(bar);
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-fmt]");
      if (!btn) return;
      if (!toolsUnlocked()) return showUpgradeNote();
      const res = self.LCTExporter.exportChat(adapter, btn.dataset.fmt);
      if (res.ok) flashNote(`✅ Backed up ${res.count} messages`);
    });
  }

  function showUpgradeNote() {
    flashNote("💎 Tools on this site are Pro — $9 once, forever. Open the extension popup to unlock.");
  }

  function flashNote(text) {
    let n = document.getElementById("lct-note");
    if (!n) {
      n = document.createElement("div");
      n.id = "lct-note";
      document.documentElement.appendChild(n);
    }
    n.textContent = text;
    n.classList.add("lct-note-show");
    setTimeout(() => n.classList.remove("lct-note-show"), 3500);
  }

  /* ---------- settings / license ---------- */

  async function loadState() {
    const { settings, license } = await chrome.storage.local.get(["settings", "license"]);
    if (settings) {
      state.enabled = settings.enabled !== false;
      state.minimap = settings.minimap !== false;
    }
    if (license && license.key) {
      const res = await self.LCTLicense.verify(license.key);
      state.pro = res.valid;
    }
  }

  function applyState() {
    if (state.enabled) {
      if (!self.LCTEngine.enabled) self.LCTEngine.start(adapter, onEngineUpdate);
      else self.LCTEngine.rescan();
    } else {
      self.LCTEngine.stop();
      self.LCTMinimap.destroy();
      const bar = document.getElementById("lct-export-bar");
      if (bar) bar.remove();
    }
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.settings || changes.license) {
      await loadState();
      applyState();
    }
  });

  /* ---------- in-chat search hotkey ---------- */

  self.LCTSearch.init(adapter);
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        e.stopPropagation();
        if (!toolsUnlocked()) return showUpgradeNote();
        self.LCTSearch.toggle();
      }
    },
    true
  );

  loadState().then(applyState);
})();
