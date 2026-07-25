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
    $("pro-upsell").hidden = pro || trialActive;
    $("pro-active").hidden = !pro;
    $("trial-active").hidden = !trialActive;
    if (pro) $("licensed-to").textContent = "Licensed to " + (maskedEmail || "you");
    paintRecallAccess(pro || trialActive);

    const startBtn = $("trial-start");
    const note = $("trial-note");
    if (pro) return;
    if (trialActive) {
      const days = Math.max(1, Math.ceil((trialUntil - Date.now()) / 864e5));
      startBtn.hidden = true;
      note.hidden = false;
      note.className = "pro-note active";
      note.textContent = `Trial active: ${days} day${days === 1 ? "" : "s"} left, everything unlocked`;
      $("trial-status").textContent = `${days} day${days === 1 ? "" : "s"} left in your free trial`;
    } else if (trialUntil > 0) {
      startBtn.hidden = true;
      note.hidden = false;
      note.className = "pro-note";
      note.textContent = "Trial ended. $9 once keeps everything forever.";
    } else {
      startBtn.hidden = false;
      note.hidden = true;
    }
  }

  function paintRecallAccess(unlocked) {
    $("recall-searchbox").hidden = !unlocked;
    $("recall-locked").hidden = unlocked;
    if (!unlocked) {
      $("recall-query").value = "";
      $("recall-query-meta").textContent = "";
      $("recall-results").replaceChildren();
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

  /* ---------- Total Recall in the popup ---------- */

  let recallQueryTimer = null;

  function recallWhen(ms) {
    if (!ms) return "";
    const date = new Date(ms);
    const opts = { month: "short", day: "numeric" };
    if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return date.toLocaleDateString(undefined, opts);
  }

  function recallResult(res) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recall-result";
    const title = document.createElement("div");
    title.className = "recall-result-title";
    const platform = document.createElement("span");
    platform.className = "recall-result-platform";
    platform.textContent = res.platform || res.host;
    const name = document.createElement("span");
    name.textContent = res.title || "Untitled chat";
    title.append(platform, name);
    const snippet = document.createElement("div");
    snippet.className = "recall-result-snippet";
    snippet.textContent = res.snippet || "Synced from your history";
    const info = document.createElement("div");
    info.className = "recall-result-info";
    info.textContent = `${res.n} messages${res.updatedAt ? ` · ${recallWhen(res.updatedAt)}` : ""}`;
    button.append(title, snippet, info);
    button.addEventListener("click", async () => {
      const q = $("recall-query").value.trim();
      await chrome.storage.local.set({
        "recall-jump": { host: res.host, path: res.path, q, at: Date.now() }
      });
      chrome.tabs.create({ url: "https://" + res.host + res.path });
    });
    return button;
  }

  async function runRecallQuery() {
    const q = $("recall-query").value.trim();
    if (q.length < 2) {
      $("recall-results").replaceChildren();
      $("recall-results").removeAttribute("aria-busy");
      $("recall-query-meta").textContent = "";
      return;
    }
    $("recall-query-meta").textContent = "Searching…";
    $("recall-results").setAttribute("aria-busy", "true");
    const res = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "recall-search", q }, resolve));
    $("recall-results").removeAttribute("aria-busy");
    if (!res || res.err || q !== $("recall-query").value.trim()) return;
    const results = res.results || [];
    // The popup is a fixed-size command surface. It previews the strongest
    // matches; the adjacent open button leads to the full archive workspace.
    $("recall-results").replaceChildren(...results.slice(0, 1).map(recallResult));
    $("recall-query-meta").textContent = results.length
      ? `${results.length} chat${results.length === 1 ? "" : "s"}`
      : `no matches`;
  }

  $("recall-query").addEventListener("input", () => {
    clearTimeout(recallQueryTimer);
    recallQueryTimer = setTimeout(runRecallQuery, 180);
  });
  $("recall-query").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    $("recall-query").value = "";
    $("recall-query-meta").textContent = "";
    $("recall-results").replaceChildren();
    $("recall-query").blur();
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
  const activeAccountKey = "lct-recall-active-account-v1";
  let isSyncing = false;

  function readableSyncMessage(text) {
    const value = String(text || "");
    return /unexpected token\s*['"]?<?|doctype|valid json|unexpected provider response|invalid provider response/i.test(value)
      ? "A chat provider returned an unexpected page. Open it, then try again."
      : value;
  }

  function updateSyncStatus(text, cls) {
    const el = $("sync-status");
    el.textContent = readableSyncMessage(text);
    el.className = "row-sub" + (cls ? " sync-status-" + cls : "");
  }

  function setSyncBusy(busy) {
    const button = $("sync-history");
    button.disabled = busy;
    button.classList.toggle("syncing", busy);
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
    const status = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "recall-sync-status" }, res));
    isSyncing = false;
    if (!status || !status.platforms) {
      setSyncBusy(false);
      updateSyncStatus("Open Total Recall to check your archive");
      return;
    }
    if (status.recovery && status.recovery.state === "restore-required") {
      setSyncBusy(false);
      updateSyncStatus("Restore your archive before checking the gap", "err");
      return;
    }
    if (status.running) {
      isSyncing = true;
      setSyncBusy(true);
      updateSyncStatus("Checking archive in background…");
      return;
    }
    let allCurrent = true, oldest = Date.now(), anyCheckpoint = false, error = "";
    for (const id of PLAT_IDS) {
      const p = status.platforms[id];
      if (!p) { allCurrent = false; continue; }
      if (p.progress && p.progress.state === "syncing") {
        isSyncing = true;
        setSyncBusy(true);
        updateSyncStatus(p.progress.msg || "Checking archive…");
        return;
      }
      if (p.progress && (p.progress.state === "error" || p.progress.state === "interrupted")) {
        error = p.progress.msg || "One archive check needs attention";
      }
      if (p.phase !== "up-to-date") allCurrent = false;
      const completed = p.checkpoint && p.checkpoint.completedAt;
      if (completed) { anyCheckpoint = true; oldest = Math.min(oldest, completed); }
    }
    setSyncBusy(false);
    if (error) {
      updateSyncStatus(error, "err");
    } else if (allCurrent && anyCheckpoint) {
      updateSyncStatus("Everything is already backed up · " + timeAgo(oldest), "ok");
    } else if (anyCheckpoint) {
      updateSyncStatus("Archive checkpoint ready. Check for new chats.");
    } else {
      updateSyncStatus("Check your chat history for the first time");
    }
  }

  async function triggerSync() {
    if (isSyncing) return;
    const status = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "recall-sync-status" }, res));
    if (status && status.recovery && status.recovery.state === "restore-required") {
      updateSyncStatus("Restore your archive in Total Recall first", "err");
      return;
    }
    isSyncing = true;
    setSyncBusy(true);
    updateSyncStatus("Checking archive in background…");
    chrome.runtime.sendMessage({ type: "recall-bg-sync" }, () => checkFreshness());
  }

  async function refreshSyncUI() {
    await checkFreshness();
  }

  $("sync-history").addEventListener("click", triggerSync);

  // On popup open: check freshness instead of auto-syncing
  checkFreshness();

  load();

  // Live repaint
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && Object.keys(changes).some((k) =>
        k.startsWith("stats:") || k === "settings" || k === "license" || k === "trial")) {
        load();
      }
      if ((area === "local" && PLAT_IDS.some((id) => changes[syncProgKey(id)])) ||
          (area === "local" && changes[activeAccountKey]) ||
          (area === "sync" && changes["lct-recall-sync-ledger-v2"])) {
        refreshSyncUI();
      }
    });
  } catch { /* storage unavailable */ }
})();
