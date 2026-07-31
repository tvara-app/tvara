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
    // Default on. It is the mechanism that makes the allowance panel truthful
    // rather than decorative, so the panel is meaningless with it off.
    $("toggle-quota").checked = !s || s.quota !== false;
  }

  /* ---------- allowance dial ----------
     One nested dial rather than a row of loose circles: the account with the
     least left takes the outermost ring and the rest fall inward, so the whole
     reading is a single object instead of a scoreboard. Ring weight and spacing
     are derived from how many rings there are, so the dial is always the same
     size on the panel and the hole stays legible.

     WHAT THE RINGS MEAN, AND WHY THIS IS THE ONLY THING THEY CAN MEAN.
     Every arc is a PERCENTAGE OF ALLOWANCE STILL LEFT, as the provider itself
     reports it — see lib/quota.js. It used to be a count of user-message DOM
     nodes over a ceiling typed into a table here, and that could not work:
     these providers meter a rolling window weighted by TOKENS, not messages, so
     "31 of 45 messages" was a number with no referent. A share of the window is
     what they publish and what a user can act on.

     A row with a reported share draws a solid track it can empty out of. A row
     the provider has told us nothing about draws a dotted track and NO arc at
     all — not a nominal one, not an estimate. An empty dotted ring means "not
     reported", and that is the whole point: the panel is allowed to say it does
     not know, and it is never allowed to draw a figure nobody sent us. */

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DIAL_BOX = 120;      // svg viewBox units, square
  const DIAL_PX = 80;        // rendered size — needed to size the centre readout
  const RING_OUTER = 54;     // centreline radius of the outermost ring
  // [stroke, gap] by ring count. The gaps run generous on purpose: the air
  // between arcs is what keeps four of them readable at 110px.
  const RING_GEOM = [null, [10, 0], [10, 5], [9.5, 4.5], [7.5, 3], [6.5, 2.6], [5.6, 2.2]];
  const MAX_RINGS = RING_GEOM.length - 1;
  const ARC_MIN = .035;      // 1% left still leaves something lit to see
  const LOW_PCT = 15;        // at or under this a row reads as running out
  // The figure and its caption stand or fall together: a bare "62" could be a
  // count, a percentage or a countdown. Both scale with the hole and both leave
  // at the same size.
  const CORE_MIN = 26;       // px of hole needed before the centre reads out

  // Ring colour per provider. Each sits a step off its brand hue — near enough
  // that the ring is read as that platform without the legend, far enough that
  // it is our mark and not theirs. Kept in step with --p-* in recall.css.
  const PROVIDERS = {
    chatgpt:    { color: "#19b884" },
    claude:     { color: "#e0805c" },
    gemini:     { color: "#4a8ef6" },
    deepseek:   { color: "#7b82fd" },
    grok:       { color: "#dcdce4" },
    perplexity: { color: "#1fadc6" }
  };

  /* The platform whitelist, and the ONLY source of rows on this panel.
     It is a whitelist because the previous build derived platforms by stripping
     a prefix off any storage key that started with "recall-sync-" and filtering
     a few suffixes by substring — so a leftover key from an older version was
     rendered as a provider called "request". Nothing that is not one of these
     six can reach the dial now. */
  const KNOWN_PLATFORMS = [
    { id: "chatgpt",    label: "ChatGPT" },
    { id: "claude",     label: "Claude" },
    { id: "gemini",     label: "Gemini" },
    { id: "deepseek",   label: "DeepSeek" },
    { id: "grok",       label: "Grok" },
    { id: "perplexity", label: "Perplexity" }
  ];
  const KNOWN_IDS = new Set(KNOWN_PLATFORMS.map((p) => p.id));
  const ID_TO_LABEL = Object.fromEntries(KNOWN_PLATFORMS.map((p) => [p.id, p.label]));

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
   *  only `left` is coloured. A row with no reported share returns nothing to
   *  draw, which is what leaves the dotted track empty. */
  function arcOf(pctLeft) {
    if (pctLeft === null || pctLeft === undefined) return { spent: 0, left: 0 };
    const frac = Math.max(0, Math.min(1, pctLeft / 100));
    // A floor so a nearly-empty allowance still reads as some rather than
    // vanishing — but only above zero. Actually empty must look empty.
    let left = frac;
    if (left > 0 && left < ARC_MIN) left = ARC_MIN;
    return { spent: 1 - left, left };
  }

  /** "4:20 PM" today, "Tue 4:20 PM" beyond it. A reset is only useful as a
   *  wall-clock time, and the day only matters when it is not this one. */
  function resetLabel(resetAt) {
    if (!resetAt) return "";
    const at = new Date(resetAt);
    if (!Number.isFinite(at.getTime())) return "";
    const now = new Date();
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const sameDay = at.getFullYear() === now.getFullYear()
      && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
    if (sameDay) return time;
    const day = at.toLocaleDateString(undefined, { weekday: "short" });
    return `${day} ${time}`;
  }

  /** How long ago we heard, for the provenance tooltip. A percentage from four
   *  hours ago is not wrong, but the user is entitled to know its age. */
  function agoLabel(at) {
    if (!at) return "never";
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 45) return "just now";
    if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
    const hrs = secs / 3600;
    if (hrs < 36) return `${Math.round(hrs)} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }

  /** The tooltip that makes a number auditable: which mechanism read it, which
   *  arithmetic produced it, and when. Every figure on this panel can be traced
   *  to a provider field, and this is where the user sees that. */
  function provenance(item) {
    if (!item.reported) {
      return item.checked
        ? "This provider published no allowance figure for your account."
        : "Not checked yet — open the site, or run Check now in the diagnostics panel.";
    }
    const bits = [];
    bits.push(item.pctLeft === null
      ? "Reset time reported; remaining share not published."
      : `${item.pctLeft}% of the allowance left.`);
    if (item.unit) bits.push(`Metered in ${item.unit}s.`);
    if (item.remaining !== null && item.limit !== null) {
      bits.push(`Provider figure: ${item.remaining} of ${item.limit}.`);
    }
    bits.push(`Source: ${item.source === "observed" ? "read from the site's own response" : "asked the provider directly"}.`);
    if (item.basis) bits.push(`Derived as ${item.basis}.`);
    bits.push(`Read ${agoLabel(item.observedAt)}.`);
    if (item.resetAt) bits.push(`Window resets ${resetLabel(item.resetAt)}.`);
    return bits.join(" ");
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
        class: "usage-track" + (it.reported ? "" : " open") + (it.out ? " spent" : "")
      });
      // Out of allowance: the channel is left dim — it is empty, and that is
      // the point — and only its colour changes.
      track.style.stroke = it.out ? "var(--danger)" : it.color;
      // A reported share gets a full-width channel to empty out of. A row with
      // nothing reported gets a dotted guideline at half weight — a path, not a
      // vessel, and it stays empty.
      track.style.strokeWidth = it.reported ? w : (w * .44).toFixed(2);
      if (!it.reported) track.style.strokeDasharray = `.1 ${(w * .72).toFixed(2)}`;
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
      // The TIGHTEST allowance, not a sum: percentages of different windows do
      // not add up to anything, and the number a user needs is the one that is
      // going to stop them first. With nothing reported there is no figure to
      // show, and an em dash says so rather than a zero that would read as
      // "you are out".
      const reporting = items.filter((it) => it.pctLeft !== null);
      const num = document.createElement("span");
      num.className = "usage-core-num";
      const cap = document.createElement("span");
      cap.className = "usage-core-cap";
      if (reporting.length) {
        const low = reporting.reduce((m, it) => Math.min(m, it.pctLeft), 100);
        num.textContent = low + "%";
        cap.textContent = "left";
      } else {
        num.textContent = "—";
        cap.textContent = "no data";
      }
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
    head.textContent = "Allowance left";
    legend.append(head);

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "usage-row" + (it.hot ? " hot" : "");
      // Every figure is auditable: hovering a row says where it came from.
      row.title = provenance(it);

      // A hollow pip, and a broken one where the track is dotted: the legend
      // repeats the dial's own vocabulary at 9px.
      const pip = document.createElement("span");
      pip.className = "usage-pip" + (it.reported ? "" : " open");
      pip.style.color = it.color;

      const name = document.createElement("span");
      name.className = "usage-name";
      name.textContent = it.label;
      const plan = document.createElement("span");
      plan.className = "usage-plan";
      plan.textContent = it.note;
      name.append(plan);

      /* The value column, in the three states this panel can honestly be in:
           - a reported share            → "62% left" + when it resets
           - a reset but no share        → "resets 4:20 PM"
           - nothing from the provider   → "not reported"
         The third is a real state, not a failure to render, and writing a
         number there is the exact dishonesty this rewrite removes. */
      const val = document.createElement("span");
      val.className = "usage-val";
      if (it.pctLeft !== null) {
        const num = document.createElement("b");
        num.textContent = it.pctLeft + "%";
        const cap = document.createElement("span");
        cap.className = "usage-cap";
        cap.textContent = it.resetAt ? ` left · ${resetLabel(it.resetAt)}` : " left";
        val.append(num, cap);
      } else if (it.resetAt) {
        const cap = document.createElement("span");
        cap.className = "usage-cap";
        cap.textContent = `resets ${resetLabel(it.resetAt)}`;
        val.append(cap);
      } else {
        const cap = document.createElement("span");
        cap.className = "usage-cap muted";
        cap.textContent = it.checked ? "not published" : "not reported";
        val.append(cap);
      }

      row.append(pip, name, val);
      legend.append(row);
    }

    return legend;
  }

  /**
   * Paint the allowance dial and the windowed total.
   *
   * @param {number} windowedTotal — speed-engine figure, unrelated to allowance
   * @param {Object} quota — the worker's quota-state reply
   */
  let dialPainted = false;
  function paintUsage(windowedTotal, quota) {
    $("stat-windowed").textContent = (windowedTotal || 0).toLocaleString();

    const records = (quota && Array.isArray(quota.records) ? quota.records : [])
      // The whitelist gate. A record for anything that is not one of the six
      // known providers is not rendered, whatever wrote it.
      .filter((rec) => rec && KNOWN_IDS.has(rec.id));
    const checked = (quota && quota.checked) || {};

    const rowMap = new Map();
    const seats = new Map();          // platform id -> how many accounts seen
    const seat = (id) => seats.set(id, (seats.get(id) || 0) + 1);

    // 1. A row per ACCOUNT that has a reading. Per account because the
    //    allowance belongs to the account — two logins on one host are two
    //    windows and never a sum.
    for (const rec of records) {
      const win = rec.window || null;
      const key = rec.id + "|" + (rec.acct || "");
      seat(rec.id);
      rowMap.set(key, {
        id: rec.id,
        acct: rec.acct || "",
        label: ID_TO_LABEL[rec.id] || rec.id,
        plan: rec.plan || "",
        account: "",
        ordinal: 0,
        reported: !!win,
        pctLeft: win && win.pctLeft !== null && win.pctLeft !== undefined ? win.pctLeft : null,
        resetAt: (win && win.resetAt) || 0,
        remaining: win && win.remaining !== undefined ? win.remaining : null,
        limit: win && win.limit !== undefined ? win.limit : null,
        unit: (win && win.unit) || "",
        basis: (win && win.basis) || "",
        source: (win && win.source) || rec.source || "",
        observedAt: (win && win.observedAt) || rec.observedAt || 0,
        checked: !!checked[rec.id]
      });
    }

    // 2. A placeholder for every supported provider with no reading, so the
    //    panel says which platforms it covers. These draw an empty dotted ring
    //    and read "not reported" — never a zero.
    for (const p of KNOWN_PLATFORMS) {
      if (seats.has(p.id)) continue;
      seat(p.id);
      rowMap.set(p.id + "|", {
        id: p.id, acct: "", label: p.label, plan: "", account: "", ordinal: 0,
        reported: false, pctLeft: null, resetAt: 0, remaining: null, limit: null,
        unit: "", basis: "", source: "", observedAt: 0,
        checked: !!checked[p.id]
      });
    }

    // Only name the account when there is more than one to confuse: a single
    // ChatGPT does not need to be told apart from anything. Otherwise the plan
    // is the more useful subtitle, and "—" where even that is unknown.
    let ordinals = new Map();
    for (const item of rowMap.values()) {
      const many = (seats.get(item.id) || 0) > 1;
      if (many) {
        const next = (ordinals.get(item.id) || 0) + 1;
        ordinals.set(item.id, next);
        item.ordinal = next;
        item.note = item.plan ? `${item.plan} · ${next}` : `Account ${next}`;
      } else {
        item.note = item.plan || "";
      }
    }

    /* Least left first: the allowance about to run out earns the outermost ring
       and the top legend row, because it is the one that will stop you. Rows
       with nothing reported sort last — they are context, not news. Beyond
       MAX_RINGS the dial stops being readable, so the quietest drop off rather
       than shaving every ring thinner. */
    const items = [...rowMap.values()]
      .sort((a, b) => {
        if (a.reported !== b.reported) return a.reported ? -1 : 1;
        const ap = a.pctLeft === null ? 101 : a.pctLeft;
        const bp = b.pctLeft === null ? 101 : b.pctLeft;
        return ap - bp || a.label.localeCompare(b.label);
      })
      .slice(0, MAX_RINGS)
      .map((b) => ({
        ...b,
        ...arcOf(b.pctLeft),
        color: ringColor(b.id, (seats.get(b.id) || 0) > 1 ? b.ordinal : 0),
        hot: b.pctLeft !== null && b.pctLeft <= LOW_PCT && b.pctLeft > 0,
        out: b.pctLeft === 0
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
  // Always paint the dial — the placeholder rows inside paintUsage cover every
  // supported platform even without data, so the rings are never absent on
  // first open. The cached reading is repainted from the worker a frame later;
  // it is a percentage of a rolling window, so a stale one is shown with its
  // age in the row tooltip rather than presented as current.
  paintUsage(
    (cache && cache.stats && cache.stats.total) || 0,
    (cache && cache.quota) || null
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

    /* The allowance panel. The worker owns this — it is the only place that
       holds the account tag and the provider readings together, and asking it
       rather than reassembling storage keys here is what killed the phantom
       "request" platform: this popup no longer derives providers from key
       names at all. */
    const quota = await send({ type: "quota-state" });
    paintUsage(total, quota);

    /* Opening the popup is exactly when a stale percentage matters, so ask the
       provider for a fresh one — but only for platforms we already have a
       reading or a signed-in session for, and the worker's own one-per-minute
       floor still applies. Fire-and-forget: the reply lands as a storage change
       and repaints, so a slow provider never holds the panel closed. */
    const refreshable = new Set(
      ((quota && quota.records) || []).map((r) => r && r.id).filter(Boolean)
    );
    for (const id of Object.keys((quota && quota.checked) || {})) refreshable.add(id);
    for (const id of refreshable) {
      send({ type: "quota-refresh", platform: id, reason: "popup" });
    }

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
    saveCache({ pro, masked, trialUntil, licenseKind, seatCount, settings: settings || null,
      stats: { total, rows }, quota: quota || null });
  }

  /* ---------- settings ---------- */

  async function saveSettings() {
    const settings = {
      enabled: $("toggle-enabled").checked,
      minimap: $("toggle-minimap").checked,
      time: $("toggle-time").checked,
      history: $("toggle-history").checked,
      quota: $("toggle-quota").checked
    };
    saveCache({ settings });
    await chrome.storage.local.set({ settings });
  }

  for (const id of ["toggle-enabled", "toggle-minimap", "toggle-time", "toggle-history", "toggle-quota"]) {
    $(id).addEventListener("change", saveSettings);
  }

  /* The allowance figures are only worth trusting if they can be checked, so the
     check is one click from the number itself. stopPropagation because the link
     sits inside the toggle's own <label> — without it, opening the page would
     also flip the switch. */
  $("quota-diag-link").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.tabs.create({ url: chrome.runtime.getURL("diag/quota.html") });
  });

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
      // `quota:` is what makes the panel live: a reading landing while the popup
      // is open — from a send in another tab, or the refresh we asked for on
      // open — repaints the dial instead of waiting for the next open.
      if (area === "local" && Object.keys(changes).some((k) =>
        k.startsWith("stats:") || k.startsWith("quota:") || k === "settings" || k === "license" || k === "trial")) {
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
