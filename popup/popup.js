/* Long Chat Toolkit — popup logic. Reads/writes chrome.storage; content scripts react live.
   Security note: the license key is NEVER rendered back into the DOM after
   activation — a screenshot or screen-share must not leak a paid key. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

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
      sizeRecallResults(false);
    }
  }

  function paintToggles(s) {
    $("toggle-enabled").checked = !s || s.enabled !== false;
    $("toggle-minimap").checked = !s || s.minimap !== false;
    $("toggle-time").checked = !s || s.time !== false;
    $("toggle-history").checked = !!(s && s.history === true);
  }

  /* ---------- usage dial ----------
     One nested dial rather than a row of loose circles: the platform used
     most recently takes the outermost ring and the rest fall inward, so the
     whole reading is a single object instead of a scoreboard. Ring weight and
     spacing are derived from how many platforms there are, so the dial is
     always the same size on the panel and the hole stays legible.

     Each ring reads as WHAT IS LEFT, not what has been spent: the lit arc is
     the allowance still in hand, and the bead is the head of the count,
     travelling clockwise from twelve as messages go out. So a full ring means
     an untouched window and a dark one means you are out — the direction a
     user cares about, in the direction they can act on.

     A published cap (ChatGPT, Claude) draws against its real ceiling on a
     solid track. A platform with no published cap draws on a dotted track and
     never closes the loop: its allowance is unpublished, so the ring counts
     down against a nominal busy window and the legend beside it reports what
     was sent rather than inventing a remainder. */

  /** Milliseconds since midnight local time — the "Today" window. */
  function msSinceMidnight() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return now - midnight;
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DIAL_BOX = 120;      // svg viewBox units, square
  const DIAL_PX = 80;        // rendered size — needed to size the centre readout
  const RING_OUTER = 54;     // centreline radius of the outermost ring
  // [stroke, gap] by ring count. The gaps run generous on purpose: the air
  // between arcs is what keeps four of them readable at 110px.
  const RING_GEOM = [null, [10, 0], [10, 5], [9.5, 4.5], [7.5, 3], [6.5, 2.6], [5.6, 2.2]];
  const MAX_RINGS = RING_GEOM.length - 1;
  const UNCAPPED_REF = 100;  // messages that read as a busy window
  const UNCAPPED_MAX = .8;   // span of an uncapped ring — it never closes
  const ARC_MIN = .035;      // a last message still leaves something lit
  // The figure and its caption stand or fall together: "125" alone was legible
  // back when a number could only ever mean messages sent, but it now means
  // whichever of left/sent the dial is counting, and an unlabelled one would be
  // a guess. Both scale with the hole instead, and both leave at the same size.
  const CORE_MIN = 26;       // px of hole needed before the centre reads out

  // Provider configuration: ring colour, default limit, default plan label.
  // Each colour sits a step off its brand hue — near enough that the ring is
  // read as that platform without the legend, far enough that it is our mark
  // and not theirs. Kept in step with --p-* in recall.css.
  const PROVIDERS = {
    chatgpt:    { color: "#19b884", limit: null,  plan: "Free" },
    claude:     { color: "#e0805c", limit: null,  plan: "Free" },
    gemini:     { color: "#4a8ef6", limit: null,  plan: "Free" },
    deepseek:   { color: "#7b82fd", limit: null,  plan: "Free" },
    grok:       { color: "#dcdce4", limit: null,  plan: "Free" },
    perplexity: { color: "#1fadc6", limit: null,  plan: "Free" }
  };

  const HOST_TO_ID = {
    "chatgpt.com": "chatgpt", "chat.openai.com": "chatgpt",
    "claude.ai": "claude", "gemini.google.com": "gemini",
    "chat.deepseek.com": "deepseek", "grok.com": "grok",
    "www.perplexity.ai": "perplexity"
  };

  const ID_TO_LABEL = {
    chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini",
    deepseek: "DeepSeek", grok: "Grok", perplexity: "Perplexity"
  };

  const KNOWN_PLATFORMS = [
    { id: "chatgpt",    label: "ChatGPT" },
    { id: "claude",     label: "Claude" },
    { id: "gemini",     label: "Gemini" },
    { id: "deepseek",   label: "DeepSeek" },
    { id: "grok",       label: "Grok" },
    { id: "perplexity", label: "Perplexity" }
  ];

  /* Published ceilings, by plan. A paid tier states its allowance, so the ring
     can draw against a real edge. A free tier's is dynamic and undocumented —
     drawing a made-up ceiling there would be worse than drawing none, so free
     accounts get the open, uncapped ring and an honest count instead. An
     unknown plan keeps the platform default, which is what shipped before. */
  const PLAN_LIMITS = {
    chatgpt: { plus: 80, pro: 200 },
    claude:  { pro: 45, max: 225, team: 45 }
  };

  function limitFor(id, plan) {
    const key = String(plan || "").toLowerCase();
    const table = PLAN_LIMITS[id] || {};
    if (table[key]) return table[key];
    // Unknown or free plan: no published cap. Never assume a paid limit.
    return null;
  }

  /* Two accounts on one platform share a hue and separate on lightness: the
     ring still reads as "that platform" at a glance, and the legend beside it
     is what tells them apart. */
  function ringColor(id, ordinal) {
    const base = (PROVIDERS[id] || PROVIDERS.chatgpt).color;
    if (!ordinal || ordinal <= 1) return base;
    const step = (ordinal - 1) % 4;
    if (step === 1) return `color-mix(in oklab, ${base}, #fff 30%)`;
    // The darkening step stays shallow: these bases carry the brands' own
    // saturation now, and a deeper cut drops the third ring off a dark field.
    if (step === 2) return `color-mix(in oklab, ${base}, #000 18%)`;
    if (step === 3) return `color-mix(in oklab, ${base}, #fff 52%)`;
    return base;
  }

  /** Where a ring stands. `spent` is how far round the head has travelled and
   *  `left` is the arc still lit ahead of it — the two are what get drawn, and
   *  only `left` is coloured. A capped plan measures both against its real
   *  ceiling and can run the whole loop; an uncapped one travels against a
   *  nominal busy window over a span that stops short of closing, so a ring
   *  right round always means "untouched cap" and nothing else. */
  function arcOf(sent, limit) {
    const span = limit ? 1 : UNCAPPED_MAX;
    const used = Math.min((sent || 0) / (limit || UNCAPPED_REF), 1);
    // A floor on the remainder so the last few of a large allowance still read
    // as some — 1 of 225 left is a third of a degree otherwise. Only a capped
    // plan is allowed to reach nothing, because only there is nothing true; an
    // uncapped one that runs past the reference window has not hit a wall, so
    // it keeps a residue lit rather than going dark on a guess.
    let left = span * (1 - used);
    if (left < ARC_MIN && (left > 0 || !limit)) left = ARC_MIN;
    return { spent: span - left, left };
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  /** The nested dial. `items` are already ordered outermost-first. */
  function usageDialEl(items) {
    const n = items.length;
    const [w, gap] = RING_GEOM[n];
    const c = DIAL_BOX / 2;
    const innerEdge = RING_OUTER - (n - 1) * (w + gap) - w / 2;
    const holePx = innerEdge * 2 * (DIAL_PX / DIAL_BOX);

    const dial = document.createElement("div");
    // Past four rings the dotted guidelines start stacking into moiré, so a
    // crowded dial holds them further back.
    dial.className = "usage-dial" + (n >= 5 ? " dense" : "");
    dial.style.setProperty("--hole", holePx.toFixed(1) + "px");

    // The legend beside the dial carries every number in text, so the drawing
    // itself is decorative to a screen reader.
    const svg = svgEl("svg", { viewBox: `0 0 ${DIAL_BOX} ${DIAL_BOX}`, "aria-hidden": "true" });

    items.forEach((it, i) => {
      const r = RING_OUTER - i * (w + gap);
      const circ = 2 * Math.PI * r;

      // Rotated so every ring starts at twelve o'clock and counts clockwise.
      const g = svgEl("g", { transform: `rotate(-90 ${c} ${c})` });

      const track = svgEl("circle", {
        cx: c, cy: c, r: r.toFixed(2),
        class: "usage-track" + (it.limit ? "" : " open") + (it.out ? " spent" : "")
      });
      // Out of allowance: the channel is left dim — it is empty, and that is
      // the point — and only its colour changes.
      track.style.stroke = it.out ? "var(--danger)" : it.color;
      // A capped plan gets a full-width channel to empty out of. An uncapped
      // one gets a dotted guideline at half weight — a path, not a vessel.
      track.style.strokeWidth = it.limit ? w : (w * .44).toFixed(2);
      if (!it.limit) track.style.strokeDasharray = `.1 ${(w * .72).toFixed(2)}`;
      g.append(track);

      if (it.left > 0) {
        // The lit arc is what is LEFT: it begins where the head has reached and
        // runs forward, so spending eats it from twelve o'clock round.
        const len = circ * it.left;
        const arc = svgEl("circle", { cx: c, cy: c, r: r.toFixed(2), class: "usage-arc" });
        arc.style.stroke = it.color;
        arc.style.strokeWidth = w;
        arc.style.strokeDasharray = `${len.toFixed(2)} ${(circ - len).toFixed(2)}`;
        arc.style.strokeDashoffset = (-circ * it.spent).toFixed(2);
        arc.style.setProperty("--circ", circ.toFixed(2));   // the sweep-in's start
        arc.style.setProperty("--i", i);                    // stagger, outermost first
        g.append(arc);
      }

      if (it.spent > 0 && it.left > 0) {
        // A bead marks the head of the count — the one highlight in the dial,
        // and what tells you at a glance which ring moved last.
        const a = 2 * Math.PI * it.spent;
        const bead = svgEl("circle", {
          cx: (c + r * Math.cos(a)).toFixed(2),
          cy: (c + r * Math.sin(a)).toFixed(2),
          r: (w * .19).toFixed(2),
          class: "usage-bead" + (it.hot ? " hot" : "")
        });
        bead.style.setProperty("--i", i);
        g.append(bead);
      }

      svg.append(g);
    });

    dial.append(svg);

    // The hole reads out while it can hold the figure; past that the arcs are
    // the whole story and the core stays quiet.
    if (holePx >= CORE_MIN) {
      dial.classList.add("has-core");
      const core = document.createElement("div");
      core.className = "usage-core";
      // The figure shows total messages used today across all platforms.
      const total = items.reduce((s, it) => s + it.sent, 0);
      const num = document.createElement("span");
      num.className = "usage-core-num";
      num.textContent = total.toLocaleString();
      const cap = document.createElement("span");
      cap.className = "usage-core-cap";
      cap.textContent = "used";
      core.append(num, cap);
      dial.append(core);
    }

    return dial;
  }

  /** The named list beside the dial — same order as the rings, outermost first. */
  function usageLegendEl(items) {
    const legend = document.createElement("div");
    legend.className = "usage-legend";

    const head = document.createElement("span");
    head.className = "usage-legend-head";
    head.textContent = "Today";
    legend.append(head);

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "usage-row" + (it.hot ? " hot" : "");

      // A hollow pip, and a broken one where the track is dotted: the legend
      // repeats the dial's own vocabulary at 9px.
      const pip = document.createElement("span");
      pip.className = "usage-pip" + (it.limit ? "" : " open");
      pip.style.color = it.color;

      const name = document.createElement("span");
      name.className = "usage-name";
      name.textContent = it.label;
      const plan = document.createElement("span");
      plan.className = "usage-plan";
      plan.textContent = it.note || it.plan || "Free";
      name.append(plan);

      // The number shows how many messages were used today. If there is a
      // published limit, the denominator is shown so the user knows the ceiling.
      const val = document.createElement("span");
      val.className = "usage-val";
      const num = document.createElement("b");
      num.textContent = String(it.sent);
      const cap = document.createElement("span");
      cap.className = "usage-cap";
      cap.textContent = it.limit ? ` / ${it.limit} used` : " used";
      val.append(num, cap);

      row.append(pip, name, val);
      legend.append(row);
    }

    return legend;
  }

  /**
   * Paint the usage dial and the windowed total.
   * @param {number} windowedTotal
   * @param {Array} statRows — [[platform, windowed, total], ...]
   * @param {Object} usageMap — { hostname: { sent, platform, id } }
   * @param {string[]} syncedPlatforms — platform ids from recall-sync checkpoints
   */
  let dialPainted = false;
  function paintUsage(windowedTotal, statRows, usageMap, syncedPlatforms) {
    $("stat-windowed").textContent = (windowedTotal || 0).toLocaleString();

    const cutoff = Date.now() - msSinceMidnight();
    const barMap = new Map();

    // A ring is one ACCOUNT, not one platform: the ceiling being counted
    // against belongs to the account, so two free tiers on one host are two
    // readings and never a sum.
    const seats = new Map();          // platform id -> how many accounts seen
    const seat = (id) => seats.set(id, (seats.get(id) || 0) + 1);

    // 1. Seed from usage data (sent timestamps), keyed host|account
    if (usageMap) {
      for (const [scope, rec] of Object.entries(usageMap)) {
        const cut = String(scope).indexOf("|");
        const host = cut < 0 ? String(scope) : String(scope).slice(0, cut);
        const acct = cut < 0 ? "" : String(scope).slice(cut + 1);
        const id = rec.id || HOST_TO_ID[host] || host;
        const label = rec.platform || ID_TO_LABEL[id] || id;
        const sent = Array.isArray(rec.sent) ? rec.sent.filter((ts) => ts >= cutoff).length : 0;
        const info = PROVIDERS[id] || {};
        seat(id);
        barMap.set(id + "|" + acct, {
          id, acct, label, sent,
          limit: limitFor(id, rec.plan),
          plan: rec.plan || info.plan || "Free",
          account: String(rec.label || ""),
          ordinal: Number(rec.ordinal) || 0,
          lastSent: sent > 0 ? Math.max(...rec.sent) : 0
        });
      }
    }

    // A platform that has an account on it needs no bare placeholder beside it.
    const covered = (id) => seats.has(id);

    // 2. Merge stats-only platforms
    for (const [label] of (statRows || [])) {
      const entry = Object.entries(HOST_TO_ID).find(([, v]) =>
        v === label.toLowerCase() || label.toLowerCase().startsWith(v));
      const pid = entry ? entry[1] : label.toLowerCase();
      if (covered(pid)) continue;
      const info = PROVIDERS[pid] || {};
      seat(pid);
      barMap.set(pid + "|", { id: pid, acct: "", label, sent: 0, limit: info.limit ?? null,
        plan: info.plan || "Free", account: "", ordinal: 0, lastSent: 0 });
    }

    // 3. Seed from synced platforms
    for (const pid of (syncedPlatforms || [])) {
      if (covered(pid)) continue;
      const info = PROVIDERS[pid] || {};
      seat(pid);
      barMap.set(pid + "|", { id: pid, acct: "", label: ID_TO_LABEL[pid] || pid, sent: 0,
        limit: info.limit ?? null, plan: info.plan || "Free", account: "", ordinal: 0, lastSent: 0 });
    }

    // 4. Always show known platforms — Gemini, ChatGPT, Claude etc. appear
    //    even without data so the user knows they are supported and tracked.
    for (const p of KNOWN_PLATFORMS) {
      if (covered(p.id)) continue;
      const info = PROVIDERS[p.id] || {};
      seat(p.id);
      barMap.set(p.id + "|", { id: p.id, acct: "", label: p.label, sent: 0,
        limit: info.limit ?? null, plan: info.plan || "Free", account: "", ordinal: 0, lastSent: 0 });
    }

    // Only say which account when there is more than one to confuse: a single
    // ChatGPT does not need to be told apart from anything.
    for (const item of barMap.values()) {
      const many = (seats.get(item.id) || 0) > 1;
      item.note = many
        ? (item.account || `Account ${item.ordinal || 1}`)
        : (item.plan || "Free");
    }

    // Most recently used first: that platform gets the outermost ring and the
    // top legend row. Beyond MAX_RINGS the dial stops being readable, so the
    // quietest platforms drop off rather than shaving every ring thinner.
    const items = [...barMap.values()]
      .sort((a, b) => b.lastSent - a.lastSent || a.label.localeCompare(b.label))
      .slice(0, MAX_RINGS)
      .map((b) => ({
        ...b,
        ...arcOf(b.sent, b.limit),
        color: ringColor(b.id, (seats.get(b.id) || 0) > 1 ? b.ordinal : 0),
        hot: !!(b.limit && b.sent / b.limit >= .9),
        out: !!(b.limit && b.sent >= b.limit)
      }));

    const panel = document.createElement("div");
    panel.className = "usage-panel";
    // After the first paint the arcs are already in place — replaying the
    // sweep animation on every storage-change repaint is the visible
    // "multiple refresh" glitch. Suppress it from the second paint on.
    if (dialPainted) panel.classList.add("no-intro");
    dialPainted = true;
    panel.append(usageDialEl(items), usageLegendEl(items));
    $("usage-bars").replaceChildren(panel);
  }

  /* ---------- first-paint cache ----------
     chrome.storage is async: without this the popup opens half-rendered and
     Chrome resizes it a frame later — a visible open-glitch. We mirror the
     last painted UI (plan flag, MASKED email, trial clock, toggles, stat rows
     — never the license key) into localStorage, which is synchronous, and
     restore it before first paint. The async load() below then verifies. */

  const CACHE = "lct-ui-v3";
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
  // Always paint the dial — the fallback inside paintUsage shows default
  // platforms even without data, so the rings are never absent on first open.
  paintUsage(
    (cache && cache.stats && cache.stats.total) || 0,
    (cache && cache.stats && cache.stats.rows) || [],
    (cache && cache.stats && cache.stats.usage) || {},
    (cache && cache.stats && cache.stats.synced) || []
  );
  if (cache && cache.licenseNote) paintLicenseState({ ...cache.licenseNote, sticky: true });

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

    // usage tracking: messages sent per platform in the rolling window
    const usageMap = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("usage:") && v && Array.isArray(v.sent)) {
        usageMap[k.slice(6)] = v;
      }
    }

    // Detect which platforms the user has synced (recall-sync checkpoint keys)
    const syncedPlatforms = Object.keys(all)
      .filter((k) => k.startsWith("recall-sync-") && !k.includes("progress") && !k.includes("ledger") && !k.includes("work") && !k.includes("run") && !k.includes("profile"))
      .map((k) => k.replace("recall-sync-", ""));

    paintUsage(total, rows, usageMap, syncedPlatforms);

    // The worker decides; the popup only renders. Asking it here rather than
    // recomputing locally means one verdict, and the one that gates the data.
    const verdict = await send({ type: "entitlement-state" });
    const trialUntil = (verdict && verdict.trial && verdict.trial.until) || 0;
    const pro = !!(verdict && verdict.entitled && verdict.via !== "trial");
    const licenseKind = (verdict && verdict.kind) || null;
    const masked = license && license.key ? maskEmail(license.email) : null;

    if (license && license.key) {
      // Two independent revocation paths, both fire-and-forget, neither blocks
      // paint. The token is the gate; maybeRevalidate is the second signal —
      // it sets revokedAt, which evaluate() treats as an immediate hard stop,
      // and it still lands a refund or chargeback if the issuer is unreachable.
      send({ type: "entitlement-refresh" });
      self.LCTDodo.maybeRevalidate(license);

      // One cause, one explanation. "Invalid" is never the word — the licence
      // is real, something about this install stopped matching it.
      const DEAD = {
        revoked: { text: "This licence was deactivated on your account." },
        expired: {
          text: "This licence needs to check in.",
          note: "It has been offline too long. Connect once and Pro comes straight back."
        },
        "device-mismatch": {
          text: "This licence is registered to another device.",
          note: "Re-activate here from the popup — you have 5 device slots."
        },
        "key-mismatch": { text: "This licence was deactivated on your account." },
        "no-token": {
          text: "Activation didn't finish.",
          note: "Paste your key again — the seat is already yours, nothing was lost."
        }
      };
      const dead = !pro && verdict && DEAD[verdict.reason];
      if (dead) {
        paintLicenseState({
          note: "If that's a surprise, reply to your purchase email and we'll sort it out.",
          ...dead, cls: "err", sticky: true
        });
      }
    }
    $("license-devices").hidden = !(pro && licenseKind === "dodo");
    const seatCount = licenseKind === "dodo"
      ? Object.keys((await self.LCTDodo.readSeats()).seats).length : 0;
    paintPlan(pro, masked, trialUntil);
    saveCache({ pro, masked, trialUntil, licenseKind, seatCount, settings: settings || null, stats: { total, rows, usage: usageMap, synced: syncedPlatforms } });
  }

  /* ---------- settings ---------- */

  async function saveSettings() {
    const settings = {
      enabled: $("toggle-enabled").checked,
      minimap: $("toggle-minimap").checked,
      time: $("toggle-time").checked,
      history: $("toggle-history").checked
    };
    saveCache({ settings });
    await chrome.storage.local.set({ settings });
  }

  for (const id of ["toggle-enabled", "toggle-minimap", "toggle-time", "toggle-history"]) {
    $(id).addEventListener("change", saveSettings);
  }

  /* ---------- trial ---------- */

  // The worker owns the clock and refuses a second trial per profile.
  $("trial-start").addEventListener("click", async () => {
    const t = await send({ type: "trial-start" });
    const until = (t && t.until) || 0;
    paintPlan(false, null, until);
    saveCache({ trialUntil: until });
  });

  /* ---------- license ---------- */

  /** The single writer for the two licence message lines. `sticky` states
   *  survive into the first-paint cache; transient ones (verifying, offline)
   *  deliberately do not — nobody wants last week's outage flashing at them. */
  function paintLicenseState(view) {
    const status = $("license-status");
    const note = $("license-note");
    status.textContent = (view && view.text) || "";
    status.className = (view && view.cls) || "";
    note.textContent = (view && view.note) || "";
    note.hidden = !(view && view.note);
    if (!view || !view.sticky) {
      if (!cache || cache.licenseNote) saveCache({ licenseNote: null });
      return;
    }
    saveCache({ licenseNote: { text: view.text, cls: view.cls, note: view.note } });
  }

  // Copy per failure branch. Only a key that fails its own signature check is
  // ever called invalid; an outage or a full licence is not the user's fault,
  // so three of these are grey (.warn), not red.
  const BRANCH_COPY = {
    inactive: {
      text: "This key is no longer active.", cls: "err", sticky: true,
      note: "If you refunded, or support deactivated it, reply to your purchase email and we'll sort it out."
    },
    notfound: {
      text: "We couldn't find that key.", cls: "err",
      note: "Check for a typo, or copy it again from your purchase email."
    },
    service: {
      text: "The licence server is having trouble right now.", cls: "warn",
      note: "Your key is fine — try again in a minute."
    },
    badrequest: {
      text: "The licence server refused that request.", cls: "warn",
      note: "Your key is fine — try again, and contact support if it persists."
    },
    network: {
      text: "Couldn't reach the licence server.", cls: "warn",
      note: "Nothing is wrong with your key — try again when you're back online."
    }
  };

  let pendingKey = null;   // the key mid-activation. Never in the DOM, never cached.

  /** Offline ECDSA path — byte-for-byte the behaviour every existing customer
   *  bought. No network, no registry, no device screen. */
  async function activateOffline(key, input, btn) {
    btn.disabled = true;
    btn.textContent = "Verifying…";
    const res = await self.LCTLicense.verify(key);
    btn.disabled = false;
    btn.textContent = "Activate";

    if (res.valid) {
      await chrome.storage.local.set({ license: { key, email: res.email, plan: res.plan } });
      input.value = ""; // the key lives in storage only — never shown again
      paintLicenseState(null);
      const masked = maskEmail(res.email);
      paintPlan(true, masked, (cache && cache.trialUntil) || 0);
      saveCache({ pro: true, masked, licenseKind: "lct1", seatCount: 0 });
    } else {
      paintLicenseState({
        text: res.reason === "no-public-key"
          ? "Dev build: run tools/genkey.mjs init first."
          : "Invalid key. Check for typos or contact support.",
        cls: "err"
      });
      paintPlan(false, null, (cache && cache.trialUntil) || 0);
      saveCache({ pro: false, masked: null, licenseKind: null, seatCount: 0 });
    }
  }

  async function activate() {
    const input = $("license-input");
    const btn = $("license-activate");
    const key = input.value.trim();

    if (!key) {
      paintLicenseState({ text: "Paste your licence key first.", cls: "err" });
      return;
    }
    if (self.LCTLicense.kindOf(key) === "lct1") return activateOffline(key, input, btn);
    if (!self.LCTDodo.looksLikeKey(key)) {
      paintLicenseState({
        text: "That doesn't look like a licence key.", cls: "err",
        note: "Copy it again from your purchase email — nothing was sent anywhere."
      });
      return;
    }

    pendingKey = key;
    btn.disabled = true;
    btn.textContent = "Activating…";
    paintLicenseState({ text: "Contacting the licence server…", cls: "ok" });

    const res = await self.LCTDodo.activateWithSeats(key, {
      onState: (phase) => {
        if (phase === "evicting") {
          paintLicenseState({ text: "Making room on your oldest device…", cls: "ok" });
        }
      }
    });

    btn.disabled = false;
    btn.textContent = "Activate";

    if (res.ok) {
      const now = Date.now();
      const record = {
        key, email: res.email || "", plan: "pro", kind: "dodo",
        instanceId: res.instanceId, licenseKeyId: res.licenseKeyId || "", activatedAt: now
      };
      // The registry was written first (inside activateWithSeats); this is the
      // write that flips every open tab to Pro via the onChanged listeners.
      await chrome.storage.local.set({
        license: record,
        "lct-license-state-v1": { lastValidatedAt: now, lastAttemptAt: now, strikes: [] }
      });

      // The seat exists; now mint the signed entitlement that actually unlocks
      // paid features. Awaited, not fired off: without a token the user paid
      // and got nothing, and they need to see why while the popup is still open.
      btn.textContent = "Finishing…";
      const ent = await self.LCTEntitlement.refresh(record, res.deviceId, { force: true });
      if (!ent.ok) {
        paintLicenseState(ent.revoked
          ? { text: "That licence is not active.", cls: "err",
              note: "The payment provider does not recognise it. Contact support with your order id." }
          : { text: "Activated, but the entitlement server didn't answer.", cls: "warn",
              note: "Pro unlocks by itself once you're back online — nothing to redo." });
      }

      pendingKey = null;
      input.value = "";
      if (ent.ok) {
        paintLicenseState(res.evicted
          ? { text: `Activated. Freed ${res.evicted} to make room.`, cls: "warn" }
          : null);
      }
      const masked = maskEmail(record.email);
      paintPlan(!!ent.ok, masked, (cache && cache.trialUntil) || 0);
      const seatCount = Object.keys((await self.LCTDodo.readSeats()).seats).length;
      saveCache({ pro: !!ent.ok, masked, licenseKind: "dodo", seatCount });
      return;
    }

    if (res.branch === "limit") {
      await openDeviceManager("limit", res.unknownDevices);
      return;
    }
    paintLicenseState(BRANCH_COPY[res.branch] || BRANCH_COPY.service);
  }

  /* ---------- device manager ---------- */

  async function currentKey() {
    if (pendingKey) return pendingKey;
    const { license } = await chrome.storage.local.get("license");
    return (license && license.key) || null;
  }

  function deviceRow(id, seat, selfId, mode) {
    const row = document.createElement("div");
    row.className = "device-row" + (id === selfId ? " is-self" : "");
    const text = document.createElement("span");
    text.className = "device-text";
    const name = document.createElement("span");
    name.className = "device-name";
    // textContent only: the registry is synced data, i.e. untrusted input.
    name.textContent = id === selfId ? seat.label + " (this device)" : seat.label;
    const meta = document.createElement("span");
    meta.className = "device-meta";
    const when = seat.activatedAt ? new Date(seat.activatedAt).toLocaleDateString() : "unknown date";
    meta.textContent = seat.orphan ? "slot still held · contact support" : "activated " + when;
    text.append(name, meta);
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = id === selfId ? "Release" : "Terminate";
    btn.addEventListener("click", () => terminate(id, btn, selfId, mode));
    row.append(text, btn);
    return row;
  }

  function renderDevices(reg, selfId, mode, unknownDevices) {
    const ids = Object.keys(reg.seats)
      .sort((a, b) => (reg.seats[a].activatedAt || 0) - (reg.seats[b].activatedAt || 0));
    $("device-list").replaceChildren(...ids.map((id) => deviceRow(id, reg.seats[id], selfId, mode)));
    $("device-count").textContent = `${ids.length} of ${self.LCTDodo.SEAT_LIMIT}`;
    $("device-manager-title").textContent = mode === "limit" ? "All slots are in use" : "Your devices";
    $("device-manager-note").textContent = mode === "limit"
      ? (unknownDevices || !ids.length
        ? `All ${self.LCTDodo.SEAT_LIMIT} slots are held by devices this browser doesn't know about. Release one from that device, or contact support.`
        : "Free a slot to finish activating here.")
      : `This licence works on ${self.LCTDodo.SEAT_LIMIT} devices. Release one any time — you can always activate it again.`;
    $("license-retry-activate").hidden = mode !== "limit";
  }

  async function openDeviceManager(mode, unknownDevices) {
    const [reg, selfId] = await Promise.all([
      self.LCTDodo.readSeats(), self.LCTDodo.ensureDeviceId()
    ]);
    renderDevices(reg, selfId, mode, unknownDevices);
    document.body.classList.add("dm-open");
    $("device-manager").hidden = false;
  }

  function closeDeviceManager() {
    document.body.classList.remove("dm-open");
    $("device-manager").hidden = true;
  }

  async function terminate(targetId, btn, selfId, mode) {
    const key = await currentKey();
    if (!key) return;
    btn.disabled = true;
    btn.textContent = "Releasing…";
    const r = await self.LCTDodo.terminateSeat(key, targetId);
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = targetId === selfId ? "Release" : "Terminate";
      $("device-manager-note").textContent =
        "Couldn't reach the licence server. Nothing changed — try again when you're back online.";
      return;
    }
    // Releasing the device you are standing on gives up Pro here.
    if (targetId === selfId) {
      await chrome.storage.local.remove(["license", "lct-license-state-v1"]);
      paintPlan(false, null, (cache && cache.trialUntil) || 0);
      saveCache({ pro: false, masked: null, licenseKind: null, seatCount: 0 });
    }
    const reg = await self.LCTDodo.readSeats();
    renderDevices(reg, selfId, mode);
    saveCache({ seatCount: Object.keys(reg.seats).length });
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

  /* How much height the list gets.

     Chrome hands a popup one fixed pane, sizes it to the document and clips
     whatever runs past it — html and body are overflow:hidden, so a list that
     overshoots is not scrolled, it is gone. The list therefore cannot simply
     grow: while a query is live the rows below it stand down (see body.searching
     in popup.css) and it takes exactly the room they gave up, scrolling inside
     it for the rest. Nothing above the query row moves, so the field the user is
     typing into stays where they put the cursor.

     What is left over has to be measured rather than written down: the panel's
     height moves with plan, sync state, account count and dial size. CSS reads
     the answer back as --recall-room. */

  /* Chrome caps a popup at 600px tall and sizes the pane to the document under
     that — so the allowance is 600, NOT the pane we happen to have on open,
     which is only as tall as the content that was in it. Measuring the live pane
     would hand back the room the list is trying to claim. A few pixels stay in
     hand because the pane comes off a fractional layout and rounding either way
     must not tip it over the cap. */
  const POPUP_CEILING = 596;
  const RECALL_MIN_ROOM = 126;   // three rows — under that the list is a peephole

  function sizeRecallResults(live) {
    const box = $("recall-results");
    if (!live) {
      document.body.classList.remove("searching");
      box.style.removeProperty("--recall-room");
      box.classList.remove("more-above", "more-below");
      return;
    }
    // Flattened, and with nothing standing down, so what gets measured is the
    // surface as it is and the list at its natural height.
    box.style.setProperty("--recall-room", "0px");
    document.body.classList.remove("searching");
    const want = box.scrollHeight;
    const asIs = POPUP_CEILING - document.body.getBoundingClientRect().height;
    // The rows below only give up their room when the list actually needs it. A
    // single hit asking the whole panel to clear out would shrink the popup for
    // nothing, so a list that already fits is simply left where it is.
    const borrow = want > asIs;
    document.body.classList.toggle("searching", borrow);
    const room = borrow ? POPUP_CEILING - document.body.getBoundingClientRect().height : asIs;
    box.style.setProperty("--recall-room", `${Math.max(RECALL_MIN_ROOM, Math.floor(room))}px`);
    markRecallEdges();
  }

  /* The scrollbar is hidden on purpose, which leaves the edges as the only thing
     that can say there is more — so whichever way the list can still travel
     fades out, and stops fading once that end is reached. */
  function markRecallEdges() {
    const box = $("recall-results");
    const hidden = box.scrollHeight - box.clientHeight;
    box.classList.toggle("more-above", box.scrollTop > 2);
    box.classList.toggle("more-below", hidden - box.scrollTop > 2);
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
      sizeRecallResults(false);
      return;
    }
    $("recall-query-meta").textContent = "Searching…";
    $("recall-results").setAttribute("aria-busy", "true");
    const res = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "recall-search", q }, resolve));
    $("recall-results").removeAttribute("aria-busy");
    if (!res || res.err || q !== $("recall-query").value.trim()) return;
    const results = res.results || [];
    // Every match the archive returned, not a preview of the top two: the count
    // beside the box and the list under it now say the same thing, and anything
    // past the visible edge is a scroll away. Back to the top on each new query
    // — a refined search that lands you halfway down its own results is a bug.
    $("recall-results").replaceChildren(...results.map(recallResult));
    $("recall-results").scrollTop = 0;
    sizeRecallResults(results.length > 0);
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
    sizeRecallResults(false);
    $("recall-query").blur();
  });
  $("recall-results").addEventListener("scroll", markRecallEdges, { passive: true });

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

  $("license-devices").addEventListener("click", () => openDeviceManager("manage"));
  $("device-manager-back").addEventListener("click", closeDeviceManager);
  $("license-retry-activate").addEventListener("click", async () => {
    closeDeviceManager();
    const key = await currentKey();
    if (!key) return;
    $("license-input").value = key;   // cleared again the moment activation lands
    await activate();
  });

  $("license-remove").addEventListener("click", async () => {
    const { license } = await chrome.storage.local.get("license");
    // Hand the seat back first. If we can't reach the server, still remove it
    // locally but flag the slot, so the device screen can explain the shortfall
    // instead of the user silently losing one of five.
    if (license && license.key && self.LCTLicense.kindOf(license.key) === "dodo" && license.instanceId) {
      const released = await self.LCTDodo.releaseThisDevice(license.key);
      if (!released.ok) await self.LCTDodo.markOrphan(await self.LCTDodo.ensureDeviceId());
    }
    await chrome.storage.local.remove(["license", "lct-license-state-v1"]);
    await self.LCTEntitlement.clearToken();   // a token outliving its key would still unlock
    paintLicenseState(null);
    closeDeviceManager();
    paintPlan(false, null, (cache && cache.trialUntil) || 0);
    saveCache({ pro: false, masked: null, licenseKind: null, seatCount: 0 });
  });

  /* ---------- Sync History ---------- */

  const PLAT_IDS = ["chatgpt", "claude", "deepseek", "grok"];
  const syncProgKey = (id) => "recall-sync-progress:" + id;
  const activeAccountKey = "lct-recall-active-account-v1";
  let isSyncing = false;

  function readableSyncMessage(text) {
    const value = String(text || "");
    return /unexpected token\s*['"]?<?|doctype|valid json|unexpected provider response|invalid provider response/i.test(value)
      ? "A provider returned an unexpected page. Open it, then retry."
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
    if (!ms) return "";
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 45) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return min + " min ago";
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + "h ago";
    return Math.round(hr / 24) + "d ago";
  }

  // The background worker owns the verdict so this surface and the Recall page
  // can never disagree about whether the archive is current.
  function paintSummary(summary) {
    if (!summary) {
      // The worker was still waking. Say what the button does rather than
      // sending the user somewhere else; checkFreshness retries behind this.
      setSyncBusy(false);
      updateSyncStatus("Check your history for new chats");
      return;
    }
    isSyncing = summary.state === "syncing";
    setSyncBusy(isSyncing);
    switch (summary.state) {
      case "syncing": {
        const pct = summary.total ? ` · ${Math.min(100, Math.round((summary.done / summary.total) * 100))}%` : "";
        updateSyncStatus((summary.message || "Checking…") + pct);
        break;
      }
      case "current":
        updateSyncStatus(summary.message + " · " + timeAgo(summary.checkedAt), "ok");
        saveCache({ sync: { text: summary.message + " · checked " + timeAgo(summary.checkedAt), cls: "ok" } });
        break;
      case "error":
        updateSyncStatus(summary.message, "err");
        break;
      default:
        updateSyncStatus(summary.message);
    }
  }

  // Chats the provider dropped are held, not deleted, until the user decides.
  // The popup is where most people will first notice.
  function paintDeletionAlert(deletions) {
    const count = (deletions && deletions.count) || 0;
    $("deletion-alert").hidden = !count;
    if (!count) return;
    $("deletion-alert-title").textContent = count === 1
      ? "1 chat was deleted on the site" : `${count} chats were deleted on the site`;
  }

  $("deletion-alert").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("recall.html#deletions") });
    window.close();
  });

  async function checkFreshness(retry = true) {
    const status = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "recall-sync-status" }, res));
    // A cold service worker can drop the very first message of a session.
    if (!status && retry) return setTimeout(() => checkFreshness(false), 350);
    paintSummary(status && status.summary);
    paintDeletionAlert(status && status.deletions);
  }

  async function triggerSync() {
    if (isSyncing) return;
    const status = await new Promise((res) =>
      chrome.runtime.sendMessage({ type: "recall-sync-status" }, res));
    isSyncing = true;
    setSyncBusy(true);
    updateSyncStatus("Checking for new chats…");
    chrome.runtime.sendMessage({ type: "recall-bg-sync" }, () => checkFreshness());
  }

  async function refreshSyncUI() {
    await checkFreshness();
  }

  $("sync-history").addEventListener("click", triggerSync);

  // Paint the last known verdict synchronously, then verify. Opening the popup
  // must never look like the archive lost its state while the worker wakes up.
  if (cache && cache.sync) updateSyncStatus(cache.sync.text, cache.sync.cls);
  checkFreshness();

  load();

  // Live repaint
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && Object.keys(changes).some((k) =>
        k.startsWith("stats:") || k.startsWith("usage:") || k === "settings" || k === "license" || k === "trial")) {
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
