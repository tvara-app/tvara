(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const names = { claude: "Claude", grok: "Grok", chatgpt: "ChatGPT", perplexity: "Perplexity", deepseek: "DeepSeek", gemini: "Gemini" };
  const send = (message) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(message, (reply) => { void chrome.runtime.lastError; resolve(reply); }); }
    catch { resolve(null); }
  });

  function paintStats(stats) {
    $("chat-count").textContent = Number(stats && stats.chats || 0).toLocaleString();
    $("message-count").textContent = Number(stats && stats.msgs || 0).toLocaleString();
    $("updated").textContent = "Updated just now";
  }

  function paintQuota(state) {
    const records = (state && Array.isArray(state.records) ? state.records : []).filter((record) => record && names[record.id]);
    const best = new Map();
    for (const record of records) {
      const window = record.window;
      if (!best.has(record.id) || (window && window.pctLeft !== null)) best.set(record.id, record);
    }
    const checked = state && state.checked || {};
    // quota-state exposes hostnames for diagnostics. The onboarding is a
    // provider view, so keep this stable six-provider list from first paint.
    const ids = Object.keys(names);
    $("provider-count").textContent = best.size.toLocaleString();
    const list = $("quota-list");
    list.replaceChildren();
    for (const id of ids) {
      const record = best.get(id);
      const row = document.createElement("div");
      row.className = "quota-row";
      const name = document.createElement("span"); name.className = "quota-name"; name.textContent = names[id];
      const value = document.createElement("span"); value.className = "quota-value";
      const pct = record && record.window && record.window.pctLeft;
      if (pct !== null && pct !== undefined) value.textContent = `${Math.round(pct)}% left`;
      else if (record) value.textContent = "Reading available";
      else if (checked[id]) value.textContent = "Not published";
      else value.textContent = "Checking…";
      value.classList.toggle("pending", !record && !checked[id]);
      row.append(name, value); list.appendChild(row);
    }
    $("updated").textContent = best.size
      ? `Live · ${best.size} of ${ids.length} reporting`
      : "Checking your signed-in accounts…";
  }

  async function refreshStats() {
    paintStats(await send({ type: "recall-stats" }) || {});
  }

  async function refreshQuota() {
    paintQuota(await send({ type: "quota-state" }) || {});
  }

  async function checkPin() {
    const result = await send({ type: "toolbar-pinned" });
    const pinned = !!(result && result.pinned);
    /* Firefox has no chrome.action.getUserSettings, so the answer there is
       "cannot tell" — not "not pinned". Blocking Continue on it left every
       Firefox install stuck on this step with a button that never enabled. */
    const known = !!(result && result.known);
    $("pin-status").textContent = pinned
      ? "Pinned. Tvara is ready whenever you need it."
      : known
        ? "Chrome has not confirmed the pin yet. Open the puzzle menu and pin Tvara first."
        : "Pin Tvara from your browser's extensions menu, then carry on — this browser cannot confirm it for us.";
    $("pin-status").classList.toggle("confirmed", pinned);
    $("check-pin").disabled = pinned || !known;
    $("continue").disabled = known && !pinned;
    if ((pinned || !known) && pinTimer) { clearInterval(pinTimer); pinTimer = null; }
  }

  $("check-pin").addEventListener("click", checkPin);
  $("continue").addEventListener("click", () => window.close());
  /* The walkthrough is a content script, so it needs a chat page to run in.
     The install listener has already armed it; this is the shortest path from
     "installed" to seeing it, for a user who has no chat open yet. */
  $("tour-now").addEventListener("click", () => {
    try { window.open("https://chatgpt.com/", "_blank", "noopener"); } catch { /* popup blocked */ }
    window.close();
  });
  refreshStats();
  refreshQuota();
  // The install listener already started this. Calling again joins that run if
  // it is still active, or gives a restored worker a new chance to fetch.
  send({ type: "quota-sweep", reason: "install" });
  let pinTimer = setInterval(checkPin, 1000);
  const statsTimer = setInterval(refreshStats, 5000);
  const quotaTimer = setInterval(refreshQuota, 5000);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((key) => key.startsWith("quota:") || key === "lct-quota-probe-v1")) refreshQuota();
    });
  } catch { /* a context that is closing simply stops polling */ }
  checkPin();
  window.addEventListener("pagehide", () => {
    clearInterval(statsTimer); clearInterval(quotaTimer);
    if (pinTimer) clearInterval(pinTimer);
  }, { once: true });
})();
