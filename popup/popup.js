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

  function setPlan(pro, email) {
    const badge = $("plan-badge");
    badge.textContent = pro ? "Pro" : "Free";
    badge.className = "badge " + (pro ? "pro" : "free");
    $("pro-upsell").hidden = pro;
    $("pro-active").hidden = !pro;
    if (pro) $("licensed-to").textContent = "Licensed to " + maskEmail(email);
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

  async function load() {
    $("version").textContent = "v" + chrome.runtime.getManifest().version;

    const all = await chrome.storage.local.get(null);
    const { settings, license } = all;

    $("toggle-enabled").checked = !settings || settings.enabled !== false;
    $("toggle-minimap").checked = !settings || settings.minimap !== false;
    $("toggle-time").checked = !settings || settings.time !== false;

    // per-platform breakdown — proof of work, per site (one storage key per
    // host so tabs never clobber each other)
    const hosts = Object.entries(all)
      .filter(([k]) => k.startsWith("stats:"))
      .map(([k, h]) => [k.slice(6), h]);
    $("stat-windowed").textContent = hosts.reduce((s, [, h]) => s + (h.windowed || 0), 0);
    $("stat-hosts").replaceChildren(
      ...hosts
        .filter(([, h]) => h.windowed > 0)
        .sort((a, b) => b[1].windowed - a[1].windowed)
        .map(([host, h]) => hostRow(h.platform || host, h.windowed))
    );

    let pro = false;
    let email;
    if (license && license.key) {
      const res = await self.LCTLicense.verify(license.key);
      pro = res.valid;
      email = license.email;
    }
    setPlan(pro, email);
  }

  async function saveSettings() {
    await chrome.storage.local.set({
      settings: {
        enabled: $("toggle-enabled").checked,
        minimap: $("toggle-minimap").checked,
        time: $("toggle-time").checked
      }
    });
  }

  $("toggle-enabled").addEventListener("change", saveSettings);
  $("toggle-minimap").addEventListener("change", saveSettings);
  $("toggle-time").addEventListener("change", saveSettings);

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
      setPlan(true, res.email);
    } else {
      status.textContent =
        res.reason === "no-public-key"
          ? "Dev build: run tools/genkey.mjs init first."
          : "Invalid key. Check for typos or contact support.";
      status.className = "err";
      setPlan(false);
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
    setPlan(false);
  });

  load();
})();
