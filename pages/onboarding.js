(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const M = self.LCTMotion;
  const names = { claude: "Claude", grok: "Grok", chatgpt: "ChatGPT", perplexity: "Perplexity", deepseek: "DeepSeek", gemini: "Gemini" };
  const send = (message) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(message, (reply) => { void chrome.runtime.lastError; resolve(reply); }); }
    catch { resolve(null); }
  });

  /* These land while the reader is looking at them — the archive fills in the
     background from the moment the extension is installed, so this page counts
     up as it happens. A number that jumps reads as a glitch; the same number
     arriving over a few hundred milliseconds reads as the thing working. */
  const setCount = (id, n) => {
    const el = $(id);
    if (!el) return;
    if (M) M.number(el, "onb:" + id, n);
    else el.textContent = n.toLocaleString();
  };

  function paintStats(stats) {
    setCount("chat-count", Number(stats && stats.chats || 0));
    setCount("message-count", Number(stats && stats.msgs || 0));
    $("updated").textContent = "Updated just now";
  }

  /* What one row says, in words somebody who has never read an API doc can act
     on. This used to be "Reading available" / "Not published" — the first is
     not a state a reader can do anything with, and the second sounds like the
     extension is broken when the usual cause is simply not being signed in to
     that site in this browser. Every branch now either gives a number or names
     the thing to go and do. */
  function reading(record, tried, wasChecked, label) {
    const win = record && record.window;
    const pct = win && win.pctLeft;
    if (pct !== null && pct !== undefined) {
      return { text: `${Math.round(pct)}% left`, figure: true, pending: false,
        why: win.resetAt ? "Resets " + new Date(win.resetAt).toLocaleString() : "" };
    }
    /* A count is a reading too. "3 pro searches left" is the most useful thing
       this panel can say, and calling it "reading available" threw it away. */
    if (win && win.remaining !== null && win.remaining !== undefined) {
      const what = String(win.label || win.key || "").replace(/[_-]+/g, " ").trim();
      return { text: `${win.remaining.toLocaleString()}${what ? " " + what : ""} left`,
        figure: true, pending: false, why: "" };
    }
    const why = tried && tried.skipped ? String(tried.skipped) : "";
    if (why === "tracking off") {
      return { text: "Tracking is off", figure: false, pending: false,
        why: "Turn Allowance tracking on in the Tvara popup to read this." };
    }
    if (why === "not signed in") {
      return { text: `Not signed in to ${label}`, figure: false, pending: false,
        why: `Sign in to ${label} in this browser and this fills in on its own.` };
    }
    if (why === "no working endpoint") {
      return { text: "No limit to read", figure: false, pending: false,
        why: `${label} does not publish an allowance figure this browser can read.` };
    }
    if (record || why === "provider reported nothing") {
      return { text: "Signed in · nothing published", figure: false, pending: false,
        why: `${label} answered, but told us nothing about your remaining allowance.` };
    }
    if (wasChecked) {
      return { text: "Nothing published yet", figure: false, pending: false,
        why: `${label} has been asked and has not published a figure yet.` };
    }
    return { text: "Checking…", figure: false, pending: true, why: "" };
  }

  function paintQuota(state) {
    const records = (state && Array.isArray(state.records) ? state.records : []).filter((record) => record && names[record.id]);
    const best = new Map();
    for (const record of records) {
      const window = record.window;
      if (!best.has(record.id) || (window && window.pctLeft !== null)) best.set(record.id, record);
    }
    const checked = state && state.checked || {};
    const lastTry = state && state.lastTry || {};
    // quota-state exposes hostnames for diagnostics. The onboarding is a
    // provider view, so keep this stable six-provider list from first paint.
    const ids = Object.keys(names);
    let figures = 0;                 // rows that carry an actual number
    const list = $("quota-list");
    /* Rebuilt every time a provider answers. Each rebuild is a different set of
       words in the value column and the footer moved with it, so the rows are
       measured first and the difference animated away. */
    const movers = [...document.querySelectorAll(".quota-row"), $("updated"), document.querySelector("footer")];
    const rows = [];
    const build = () => { list.replaceChildren(...rows); };
    for (const id of ids) {
      const record = best.get(id);
      const row = document.createElement("div");
      row.className = "quota-row";
      const name = document.createElement("span"); name.className = "quota-name"; name.textContent = names[id];
      const value = document.createElement("span"); value.className = "quota-value";
      const said = reading(record, lastTry[id], checked[id], names[id]);
      value.textContent = said.text;
      if (said.why) value.title = said.why;
      value.classList.toggle("pending", said.pending);
      if (said.figure) figures++;
      row.append(name, value); rows.push(row);
    }
    if (M) M.flip(movers, build); else build();
    /* Counted from rows that carry a NUMBER, not from rows that exist. It read
       `best.size` before, so a provider that had answered with nothing usable
       still went into "4 providers reporting" — and the four rows underneath
       plainly reported nothing. */
    setCount("provider-count", figures);
    $("updated").textContent = figures
      ? `Live · ${figures} of ${ids.length} reporting`
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
