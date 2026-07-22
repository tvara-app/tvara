/* Long Chat Toolkit — popup logic. Reads/writes chrome.storage; content scripts react live.
   Security note: the license key is NEVER rendered back into the DOM after
   activation — a screenshot or screen-share must not leak a paid key. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // te•••@gmail.com — enough to recognize yourself, useless to a stranger
  function maskEmail(email) {
    if (!email || !email.includes("@")) return "you";
    const [user, domain] = email.split("@");
    const dots = "•".repeat(Math.min(Math.max(user.length - 2, 1), 5));
    return `${user.slice(0, 2)}${dots}@${domain}`;
  }

  /* ---------- paint helpers (pure: data in, DOM out) ---------- */

  function paintPlan(pro, maskedEmail) {
    const badge = $("plan-badge");
    badge.textContent = pro ? "Pro" : "Free";
    badge.className = "badge " + (pro ? "pro" : "free");
    $("pro-upsell").hidden = pro;
    $("pro-active").hidden = !pro;
    if (pro) $("licensed-to").textContent = "Licensed to " + (maskedEmail || "you");
  }

  function paintToggles(s) {
    $("toggle-enabled").checked = !s || s.enabled !== false;
    $("toggle-minimap").checked = !s || s.minimap !== false;
    $("toggle-time").checked = !s || s.time !== false;
  }

  function hostRow(label, count) {
    const row = document.createElement("div");
    row.className = "host-row";
    const name = document.createElement("span");
    name.textContent = label; // textContent, never innerHTML: storage data is not markup
    const num = document.createElement("b");
    num.textContent = String(count);
    row.append(name, num);
    return row;
  }

  function paintStats(total, rows) {
    $("stat-windowed").textContent = String(total || 0);
    $("stat-hosts").replaceChildren(...(rows || []).map(([label, count]) => hostRow(label, count)));
  }

  /* ---------- first-paint cache ----------
     chrome.storage is async: without this the popup opens half-rendered and
     Chrome resizes it a frame later — a visible open-glitch. We mirror the
     last painted UI (plan flag, MASKED email, toggles, stat rows — never the
     license key) into localStorage, which is synchronous, and restore it
     before first paint. The async load() below then verifies and corrects. */

  const CACHE = "lct-ui-v1";
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE) || "null"); } catch { /* ignore */ }
  function saveCache(patch) {
    cache = { ...(cache || {}), ...patch };
    try { localStorage.setItem(CACHE, JSON.stringify(cache)); } catch { /* quota/private mode */ }
  }

  // Synchronous restore — runs during parse, i.e. before the first paint.
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  paintToggles(cache && cache.settings);
  paintPlan(!!(cache && cache.pro), cache && cache.masked);
  if (cache && cache.stats) paintStats(cache.stats.total, cache.stats.rows);

  /* ---------- authoritative async load ---------- */

  async function load() {
    const all = await chrome.storage.local.get(null);
    const { settings, license } = all;

    paintToggles(settings);

    // per-platform breakdown — proof of work, per site (one storage key per
    // host so tabs never clobber each other)
    const rows = Object.entries(all)
      .filter(([k]) => k.startsWith("stats:"))
      .map(([k, h]) => [k.slice(6), h])
      .filter(([, h]) => h.windowed > 0)
      .sort((a, b) => b[1].windowed - a[1].windowed)
      .map(([host, h]) => [String(h.platform || host), h.windowed]);
    const total = rows.reduce((s, [, n]) => s + n, 0);
    paintStats(total, rows);

    let pro = false;
    let masked = null;
    if (license && license.key) {
      const res = await self.LCTLicense.verify(license.key);
      pro = res.valid;
      masked = maskEmail(license.email);
    }
    paintPlan(pro, masked);
    saveCache({ pro, masked, settings: settings || null, stats: { total, rows } });
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

  $("toggle-enabled").addEventListener("change", saveSettings);
  $("toggle-minimap").addEventListener("change", saveSettings);
  $("toggle-time").addEventListener("change", saveSettings);

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
      paintPlan(true, masked);
      saveCache({ pro: true, masked });
    } else {
      status.textContent =
        res.reason === "no-public-key"
          ? "Dev build: run tools/genkey.mjs init first."
          : "Invalid key. Check for typos or contact support.";
      status.className = "err";
      paintPlan(false);
      saveCache({ pro: false, masked: null });
    }
  }

  $("license-activate").addEventListener("click", activate);
  $("license-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") activate();
  });

  $("license-remove").addEventListener("click", async () => {
    await chrome.storage.local.remove("license");
    $("license-status").textContent = "";
    $("license-status").className = "";
    paintPlan(false);
    saveCache({ pro: false, masked: null });
  });

  load();
})();
