/* Long Chat Toolkit — popup logic. Reads/writes chrome.storage; content scripts react live. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  async function load() {
    const { settings, license, stats } = await chrome.storage.local.get([
      "settings",
      "license",
      "stats"
    ]);

    $("toggle-enabled").checked = !settings || settings.enabled !== false;
    $("toggle-minimap").checked = !settings || settings.minimap !== false;
    $("stat-windowed").textContent = (stats && stats.totalWindowed) || 0;

    // per-platform breakdown — proof of work, per site
    const hosts = (stats && stats.perHost) || {};
    const rows = Object.entries(hosts)
      .filter(([, h]) => h.windowed > 0)
      .sort((a, b) => b[1].windowed - a[1].windowed)
      .map(([host, h]) => {
        const row = document.createElement("div");
        row.className = "host-row";
        row.innerHTML = `<span>${h.platform || host}</span><b>💤 ${h.windowed}</b>`;
        return row;
      });
    const box = $("stat-hosts");
    box.replaceChildren(...rows);

    if (license && license.key) {
      const res = await self.LCTLicense.verify(license.key);
      setPlan(res.valid, license.email);
      if (res.valid) {
        $("license-input").value = license.key;
        $("license-status").textContent = `Licensed to ${license.email || "you"} ✓`;
        $("license-status").className = "ok";
      }
    }
  }

  function setPlan(pro, email) {
    const badge = $("plan-badge");
    badge.textContent = pro ? "PRO" : "FREE";
    badge.className = "badge " + (pro ? "pro" : "free");
  }

  async function saveSettings() {
    await chrome.storage.local.set({
      settings: {
        enabled: $("toggle-enabled").checked,
        minimap: $("toggle-minimap").checked
      }
    });
  }

  $("toggle-enabled").addEventListener("change", saveSettings);
  $("toggle-minimap").addEventListener("change", saveSettings);

  $("license-activate").addEventListener("click", async () => {
    const key = $("license-input").value.trim();
    const status = $("license-status");
    const res = await self.LCTLicense.verify(key);
    if (res.valid) {
      await chrome.storage.local.set({ license: { key, email: res.email, plan: res.plan } });
      status.textContent = `Activated — licensed to ${res.email} ✓`;
      status.className = "ok";
      setPlan(true, res.email);
    } else {
      status.textContent =
        res.reason === "no-public-key"
          ? "Dev build: run tools/genkey.mjs init first."
          : "Invalid key. Check for typos or contact support.";
      status.className = "err";
      setPlan(false);
    }
  });

  load();
})();
