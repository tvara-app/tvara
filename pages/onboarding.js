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
    /* A SETTING, true the moment it is read. Everything below this line is a
       verdict about a provider, and those have to be earned. */
    if (why === "tracking off") {
      return { text: "Tracking is off", figure: false, pending: false,
        why: "Turn Allowance tracking on in the Tvara popup to read this." };
    }
    /* NOTHING FINAL BEFORE THE FIRST COMPLETE CHECK.

       This is the page somebody sees in the first minute of owning the thing,
       and it was answering before it had asked: "No limit to read" and
       "nothing published" appeared on providers that a moment later showed a
       real percentage. A reader cannot tell a settled answer from a half-built
       one, so the first thing this panel ever said about their account was
       wrong — and the whole promise here is that it does not do that.

       `checked` is a stored probe report, and a probe that FAILED writes one
       too, so a row cannot be stranded on "Checking…" by a provider that
       refuses: it says so as soon as there is something to say. */
    if (!wasChecked) {
      return { text: "Checking…", figure: false, pending: true, why: "" };
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
    // Asked, answered, and the answer carried no figure. Reaching here at all
    // means wasChecked, so there is no unchecked case left to fall through to.
    return { text: "Nothing published yet", figure: false, pending: false,
      why: `${label} has been asked and has not published a figure yet.` };
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
      if (said.why) value.setAttribute("aria-label", said.text + " \u2014 " + said.why);
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
    /* Plain words for a plain fact. "Live · 4 of 6 reporting" reads like a
       server status page; what the reader wants to know is whether the thing
       has finished looking yet. */
    $("updated").textContent = figures
      ? `${figures} of ${ids.length} sites answered`
      : "Checking the sites you're signed in to…";
  }

  async function refreshStats() {
    paintStats(await send({ type: "recall-stats" }) || {});
  }

  async function refreshQuota() {
    paintQuota(await send({ type: "quota-state" }) || {});
  }

  /* ---------- pick a site, and be shown around on it ----------

     The walkthrough is a content script, so it needs a chat page to run in.
     One button used to send everybody to ChatGPT, which is the wrong site for
     most people and a redirect nobody asked for. This asks instead.

     A colour and an initial, not a wordmark: the palette is the one the rest
     of the product already uses for these six — recognisably theirs,
     deliberately not theirs exactly — and shipping somebody else's logo in our
     own UI is a thing to be licensed, not borrowed. */
  const SITES = [
    { id: "chatgpt", url: "https://chatgpt.com/" },
    { id: "claude", url: "https://claude.ai/" },
    { id: "gemini", url: "https://gemini.google.com/app" },
    { id: "grok", url: "https://grok.com/" },
    { id: "perplexity", url: "https://www.perplexity.ai/" },
    { id: "deepseek", url: "https://chat.deepseek.com/" }
  ];

  const picker = $("picker");
  let lastFocus = null;

  /* Built once, on first open. Rebuilding a list under a reader is the thing
     that throws away focus and restarts every animation mid-flight. */
  function buildBubbles() {
    const host = $("bubbles");
    if (host.childElementCount) return;
    const frag = document.createDocumentFragment();
    for (const site of SITES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bubble";
      b.dataset.platform = site.id;
      b.setAttribute("aria-label", `Show me around on ${names[site.id]}`);
      const disc = document.createElement("span");
      disc.className = "bubble-disc";
      disc.setAttribute("aria-hidden", "true");
      disc.textContent = names[site.id].slice(0, 1);
      const label = document.createElement("span");
      label.className = "bubble-name";
      label.textContent = names[site.id];
      b.append(disc, label);
      b.addEventListener("click", () => start(site));
      frag.append(b);
    }
    host.append(frag);
  }

  async function start(site) {
    /* The tour reads these when the content script wakes on the site. DONE is
       cleared as well as ARMED: somebody asking to be shown around has asked,
       whatever a previous run recorded. */
    try {
      await chrome.storage.local.set({ "lct-tour-armed-v1": Date.now() });
      await chrome.storage.local.remove("lct-tour-v1");
    } catch { /* the site still opens; the tour simply may not arm */ }
    picker.classList.add("leaving");
    try { window.open(site.url, "_blank", "noopener"); } catch { /* popup blocked */ }
    window.close();
  }

  function openPicker() {
    buildBubbles();
    lastFocus = document.activeElement;
    picker.hidden = false;
    /* Two frames: one for `hidden` to come off and the layer to be laid out,
       one for the class that animates it. Adding both in the same frame gives
       the browser no "before" to animate from, which is exactly the jump this
       is here to avoid. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      picker.classList.add("open");
      if (M) M.stagger(picker.querySelectorAll(".bubble"), "bubble-in", 34, 6);
      const first = picker.querySelector(".bubble");
      if (first) first.focus({ preventScroll: true });
    }));
  }

  function closePicker() {
    if (picker.hidden) return;
    picker.classList.remove("open");
    for (const b of picker.querySelectorAll(".bubble")) b.classList.remove("bubble-in");
    const done = () => { picker.hidden = true; };
    // Matches --picker-out in the stylesheet. A timer rather than
    // transitionend: a layer the reader closed twice quickly must still end up
    // hidden, and transitionend does not fire for a transition that is
    // interrupted.
    setTimeout(done, M && M.reduced ? 0 : 180);
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  }

  $("use-tvara").addEventListener("click", openPicker);
  $("picker-close").addEventListener("click", closePicker);
  $("picker-scrim").addEventListener("click", closePicker);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePicker();
  });
  refreshStats();
  refreshQuota();
  // The install listener already started this. Calling again joins that run if
  // it is still active, or gives a restored worker a new chance to fetch.
  send({ type: "quota-sweep", reason: "install" });
  const statsTimer = setInterval(refreshStats, 5000);
  const quotaTimer = setInterval(refreshQuota, 5000);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((key) => key.startsWith("quota:") || key === "lct-quota-probe-v1")) refreshQuota();
    });
  } catch { /* a context that is closing simply stops polling */ }
  window.addEventListener("pagehide", () => {
    clearInterval(statsTimer); clearInterval(quotaTimer);
  }, { once: true });
})();
