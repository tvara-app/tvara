/* Long Chat Toolkit — popup logic. Reads/writes chrome.storage; content scripts react live.
   Security note: the license key is NEVER rendered back into the DOM after
   activation — a screenshot or screen-share must not leak a paid key. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TRIAL_MS = 7 * 864e5;

  // te•••@gmail.com — enough to recognize yourself, useless to a stranger
  function maskEmail(email) {
    if (!email || !email.includes("@")) return "you";
    const [user, domain] = email.split("@");
    const dots = "•".repeat(Math.min(Math.max(user.length - 2, 1), 5));
    return `${user.slice(0, 2)}${dots}@${domain}`;
  }

  /* ---------- paint helpers (pure: data in, DOM out) ---------- */

  function paintPlan(pro, maskedEmail, trialUntil) {
    const badge = $("plan-badge");
    const trialActive = !pro && trialUntil > Date.now();
    badge.textContent = pro ? "Pro" : trialActive ? "Trial" : "Free";
    badge.className = "badge " + (pro ? "pro" : trialActive ? "trial" : "free");
    $("pro-upsell").hidden = pro;
    $("pro-active").hidden = !pro;
    if (pro) $("licensed-to").textContent = "Licensed to " + (maskedEmail || "you");

    const startBtn = $("trial-start");
    const note = $("trial-note");
    if (pro) return;
    if (trialActive) {
      const days = Math.max(1, Math.ceil((trialUntil - Date.now()) / 864e5));
      startBtn.hidden = true;
      note.hidden = false;
      note.className = "pro-note active";
      note.textContent = `Trial active — ${days} day${days === 1 ? "" : "s"} left, everything unlocked`;
    } else if (trialUntil > 0) {
      startBtn.hidden = true;
      note.hidden = false;
      note.className = "pro-note";
      note.textContent = "Trial ended — $9 once keeps everything forever.";
    } else {
      startBtn.hidden = false;
      note.hidden = true;
    }
  }

  function paintToggles(s) {
    $("toggle-enabled").checked = !s || s.enabled !== false;
    $("toggle-minimap").checked = !s || s.minimap !== false;
    $("toggle-time").checked = !s || s.time !== false;
  }

  function hostRow(label, count, total) {
    const row = document.createElement("div");
    row.className = "host-row";
    const name = document.createElement("span");
    name.textContent = label; // textContent, never innerHTML: storage data is not markup
    const num = document.createElement("b");
    num.textContent = total ? `${count} of ${total}` : String(count);
    row.append(name, num);
    return row;
  }

  function paintStats(total, rows) {
    $("stat-windowed").textContent = String(total || 0);
    $("stat-hosts").replaceChildren(
      ...(rows || []).map(([label, count, t]) => hostRow(label, count, t))
    );
  }

  /* ---------- first-paint cache ----------
     chrome.storage is async: without this the popup opens half-rendered and
     Chrome resizes it a frame later — a visible open-glitch. We mirror the
     last painted UI (plan flag, MASKED email, trial clock, toggles, stat rows
     — never the license key) into localStorage, which is synchronous, and
     restore it before first paint. The async load() below then verifies. */

  const CACHE = "lct-ui-v2";
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE) || "null"); } catch { /* ignore */ }
  function saveCache(patch) {
    cache = { ...(cache || {}), ...patch };
    try { localStorage.setItem(CACHE, JSON.stringify(cache)); } catch { /* quota/private mode */ }
  }

  // Synchronous restore — runs during parse, i.e. before the first paint.
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  paintToggles(cache && cache.settings);
  paintPlan(!!(cache && cache.pro), cache && cache.masked, (cache && cache.trialUntil) || 0);
  if (cache && cache.stats) paintStats(cache.stats.total, cache.stats.rows);

  /* ---------- authoritative async load ---------- */

  async function load() {
    const all = await chrome.storage.local.get(null);
    const { settings, license, trial } = all;

    paintToggles(settings);

    // per-platform breakdown — proof of work, per site (one storage key per
    // host so tabs never clobber each other)
    const rows = Object.entries(all)
      .filter(([k]) => k.startsWith("stats:"))
      .map(([k, h]) => [k.slice(6), h])
      .filter(([, h]) => h.windowed > 0)
      .sort((a, b) => b[1].windowed - a[1].windowed)
      .map(([host, h]) => [String(h.platform || host), h.windowed, h.total || 0]);
    const total = rows.reduce((s, [, n]) => s + n, 0);
    paintStats(total, rows);

    const trialUntil = trial && trial.startedAt ? trial.startedAt + TRIAL_MS : 0;
    let pro = false;
    let masked = null;
    if (license && license.key) {
      const res = await self.LCTLicense.verify(license.key);
      pro = res.valid;
      masked = maskEmail(license.email);
    }
    paintPlan(pro, masked, trialUntil);
    saveCache({ pro, masked, trialUntil, settings: settings || null, stats: { total, rows } });
  }

  /* ---------- settings ---------- */

  async function saveSettings() {
    const settings = {
      enabled: $("toggle-enabled").checked,
      minimap: $("toggle-minimap").checked,
      time: $("toggle-time").checked
    };
    saveCache({ settings });
    await chrome.storage.local.set({ settings });
  }

  for (const id of ["toggle-enabled", "toggle-minimap", "toggle-time"]) {
    $(id).addEventListener("change", saveSettings);
  }

  /* ---------- trial ---------- */

  $("trial-start").addEventListener("click", async () => {
    const startedAt = Date.now();
    await chrome.storage.local.set({ trial: { startedAt } });
    paintPlan(false, null, startedAt + TRIAL_MS);
    saveCache({ trialUntil: startedAt + TRIAL_MS });
  });

  /* ---------- license ---------- */

  async function activate() {
    const input = $("license-input");
    const btn = $("license-activate");
    const status = $("license-status");
    const key = input.value.trim();

    if (!key) {
      status.textContent = "Paste your license key first.";
      status.className = "err";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Verifying…";
    const res = await self.LCTLicense.verify(key);
    btn.disabled = false;
    btn.textContent = "Activate";

    if (res.valid) {
      await chrome.storage.local.set({ license: { key, email: res.email, plan: res.plan } });
      input.value = ""; // the key lives in storage only — never shown again
      status.textContent = "";
      status.className = "";
      const masked = maskEmail(res.email);
      paintPlan(true, masked, (cache && cache.trialUntil) || 0);
      saveCache({ pro: true, masked });
    } else {
      status.textContent =
        res.reason === "no-public-key"
          ? "Dev build: run tools/genkey.mjs init first."
          : "Invalid key. Check for typos or contact support.";
      status.className = "err";
      paintPlan(false, null, (cache && cache.trialUntil) || 0);
      saveCache({ pro: false, masked: null });
    }
  }

  $("open-recall").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("recall.html") });
  });

  // Shortcuts are the browser's (remappable per device/OS/browser) — send the
  // user straight to the page where they can view or change them.
  $("shortcuts-link").addEventListener("click", (e) => {
    e.preventDefault();
    const url = navigator.userAgent.includes("Edg/")
      ? "edge://extensions/shortcuts"
      : "chrome://extensions/shortcuts";
    chrome.tabs.create({ url });
  });

  $("license-activate").addEventListener("click", activate);
  $("license-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") activate();
  });

  $("license-remove").addEventListener("click", async () => {
    await chrome.storage.local.remove("license");
    $("license-status").textContent = "";
    $("license-status").className = "";
    paintPlan(false, null, (cache && cache.trialUntil) || 0);
    saveCache({ pro: false, masked: null });
  });

  /* ---------- Sync History ---------- */

  const PLAT_IDS = ["chatgpt", "claude", "deepseek", "grok"];
  const syncProgKey = (id) => "recall-sync-progress:" + id;
  const syncFlagKey = (id) => "recall-sync-" + id;
  const FRESH_MS = 2 * 60 * 60 * 1000; // 2 hours — matches bg.js stale time
  let isSyncing = false;

  function updateSyncStatus(text, cls) {
    const el = $("sync-status");
    el.textContent = text;
    el.className = "row-sub" + (cls ? " sync-status-" + cls : "");
  }

  function timeAgo(ms) {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return min + " min ago";
    const hr = Math.floor(min / 60);
    return hr + "h ago";
  }

  async function checkFreshness() {
    // Ask bg.js for current sync status
    const status = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "recall-sync-status" }, res));

    if (status && status.running) {
      isSyncing = true;
      $("sync-history").classList.add("syncing");
      updateSyncStatus("Syncing in background…");
      return;
    }

    if (!status || !status.platforms) {
      updateSyncStatus("Click to sync all chats");
      return;
    }

    // Check if all platforms have synced recently
    let allFresh = true, oldestSync = Date.now(), anySync = false;
    let activeMsg = "";
    for (const id of PLAT_IDS) {
      const p = status.platforms[id];
      if (!p) { allFresh = false; continue; }

      // Check if currently syncing
      if (p.progress && p.progress.state === "syncing") {
        isSyncing = true;
        $("sync-history").classList.add("syncing");
        activeMsg = p.progress.msg || "Syncing…";
      }

      const last = p.flag && p.flag.lastFull;
      if (!last || Date.now() - last > FRESH_MS) {
        allFresh = false;
      } else {
        anySync = true;
        if (last < oldestSync) oldestSync = last;
      }
    }

    if (isSyncing) {
      updateSyncStatus(activeMsg || "Syncing in background…");
      return;
    }

    if (allFresh) {
      updateSyncStatus("All chats synced ✓ • " + timeAgo(oldestSync), "ok");
    } else if (anySync) {
      updateSyncStatus("Partially synced • " + timeAgo(oldestSync) + " — click to sync");
    } else {
      updateSyncStatus("Click to sync all chats");
    }
  }

  async function triggerSync() {
    if (isSyncing) return;
    isSyncing = true;
    $("sync-history").classList.add("syncing");
    updateSyncStatus("Starting background sync…");

    // Send to bg.js — runs entirely in the service worker, no tabs needed
    chrome.runtime.sendMessage({ type: "recall-bg-sync" });
  }

  async function refreshSyncUI() {
    const keys = PLAT_IDS.map(syncProgKey);
    const store = await chrome.storage.local.get(keys);
    let doneCount = 0, latestMsg = "";
    for (const id of PLAT_IDS) {
      const p = store[syncProgKey(id)];
      if (!p) continue;
      if (p.state === "done") doneCount++;
      if (p.state === "syncing" && p.msg) latestMsg = p.msg;
    }
    if (doneCount >= PLAT_IDS.length) {
      updateSyncStatus("All chats synced ✓", "ok");
      $("sync-history").classList.remove("syncing");
      isSyncing = false;
    } else if (latestMsg) {
      updateSyncStatus(latestMsg);
    }
  }

  $("sync-history").addEventListener("click", triggerSync);

  // On popup open: check freshness instead of auto-syncing
  checkFreshness();

  load();

  // Live repaint
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((k) =>
        k.startsWith("stats:") || k === "settings" || k === "license" || k === "trial")) {
        load();
      }
      // Track sync progress live
      if (PLAT_IDS.some((id) => changes[syncProgKey(id)])) {
        refreshSyncUI();
      }
    });
  } catch { /* storage unavailable */ }
})();
