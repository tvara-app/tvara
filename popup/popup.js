/* Tvara — popup logic. Reads/writes chrome.storage; content scripts react live.
   Security note: the license key is NEVER rendered back into the DOM after
   activation — a screenshot or screen-share must not leak a paid key. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  /* lastError is READ, always. A popup or Recall tab left open across an
     extension reload is orphaned: every later message fails, and a lastError
     nobody reads is logged as "Could not establish connection. Receiving end
     does not exist." on the extensions page — an error report for something no
     user can act on and no developer can fix. Reading it marks it handled; the
     caller gets undefined and paints what it already had. */
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (reply) => { void chrome.runtime.lastError; res(reply); }); }
    catch { res(null); }                          // context torn down mid-call
  });

  // Is the tab the user is looking at one of ours? Navigation by a stored
  // record goes through LCTProduct.chatUrl() instead — a host allowlist alone
  // never was enough, because the path is concatenated onto it.
  const KNOWN_CHAT_HOSTS = new Set(self.LCTProduct.CHAT_HOSTS);

  // te•••@gmail.com — enough to recognize yourself, useless to a stranger
  function maskEmail(email) {
    if (!email || !email.includes("@")) return "you";
    const [user, domain] = email.split("@");
    const dots = "•".repeat(Math.min(Math.max(user.length - 2, 1), 5));
    return `${user.slice(0, 2)}${dots}@${domain}`;
  }

  /* ---------- paint helpers (pure: data in, DOM out) ---------- */

  /* The plan chip.

     A purchase and a trial both unlock everything, so these two used to differ
     by pill fill alone — a paying customer and a free week read the same at a
     glance, which is the one distinction this chip exists to make. Pro now
     carries the brand accent and a verified mark, and nothing else on the
     surface is allowed to use that fill.

     Built from nodes rather than a template string so textContent stays exactly
     "Pro" / "Trial" / "Free". An SVG child contributes no text; a stray space
     would, and the store screenshot harness compares without trimming. */
  const paintBadge = (el, pro, trialActive) => self.LCTProduct.paintBadge(el, pro, trialActive);

  /* The face on the header, and the only plan indicator on it.
     `accountProfile` is whatever the last Google sign-in put in local storage —
     picture, display name, address — read here and nowhere else.

     The circle is always drawn. It used to disappear when signed out, on the
     grounds that an empty ring reads as a broken photo; that is true of an
     EMPTY one, so signed out now shows a person glyph instead. The ring around
     it carries free / trial / pro, which is what the pill beside it used to say
     in words — and the pill is still there, visually hidden, because a status
     told only in colour is not told at all. Both come off ONE class on
     `.account`, so they cannot disagree. */
  function paintAccount() {
    const acct = $("account");
    if (!acct) return;
    const ring = $("account-ring");
    const who = String((accountProfile && (accountProfile.name || accountProfile.email)) || "").trim();
    const src = String((accountProfile && accountProfile.picture) || "");
    /* Signed IN with nothing to show is not the same as signed out. A verified
       identity with no stored picture — an OTP sign-in, or a Google one from
       before the profile was kept — drew the anonymous glyph, which says
       "nobody is here" about somebody who is. The monogram below covers it. */
    const anon = !identityVerified && !(who || src);
    acct.className = "account " + currentPlan + (anon ? " anon" : "");
    const plan = currentPlan === "pro" ? "Pro" : currentPlan === "trial" ? "Trial" : "Free";
    /* Named, not tooltipped. A native title is a delayed grey box that covers
       the panel it explains, and this popup is read at a glance — see the
       window switch, which has carried an aria-label and no title for the same
       reason. Everything worth SEEING is on screen; the rest is for a reader. */
    ring.setAttribute("aria-label", anon ? plan + " \u00b7 not signed in"
      : who ? plan + " \u00b7 " + who : plan + " \u00b7 signed in");
    if (anon) { $("account-photo").hidden = true; return; }
    $("account-initial").textContent = who ? who.slice(0, 1) : "\u2022";
    const img = $("account-photo");
    if (!src) { img.hidden = true; img.removeAttribute("src"); return; }
    if (img.getAttribute("src") === src) return;
    /* Hidden until it decodes. A broken-image glyph sitting in the ring reads
       as a fault; the monogram underneath reads as the account. */
    img.hidden = true;
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    img.src = src;
  }

  function paintPlan(pro, maskedEmail, trialUntil) {
    const badge = $("plan-badge");
    const trialActive = !pro && trialUntil > Date.now();
    paintBadge(badge, pro, trialActive);
    /* The ring around the account photo says the same thing the pill says, off
       the same two booleans — so the two can never name different plans. */
    currentPlan = pro ? "pro" : trialActive ? "trial" : "free";
    paintAccount();
    /* How much of the week is left, drawn as the rim. TRIAL_MS is seven days
       in the worker; the fraction is the honest one — a trial two hours old
       shows a nearly full circle, not a full one. */
    const TRIAL_MS = 7 * 864e5;
    const leftMs = trialActive ? Math.max(0, trialUntil - Date.now()) : 0;
    const arc = $("account-arc");
    const live = $("account-arc-live");
    const days = $("plan-days");
    if (trialActive && arc && live) {
      const frac = Math.max(0, Math.min(1, leftMs / TRIAL_MS));
      const circumference = 2 * Math.PI * 14.6;
      live.style.strokeDasharray = String(circumference);
      live.style.strokeDashoffset = String(circumference * (1 - frac));
      arc.hidden = false;
      const whole = Math.max(1, Math.ceil(leftMs / 864e5));
      days.textContent = whole === 1 ? "1 day left" : whole + " days left";
      days.hidden = false;
    } else {
      if (arc) arc.hidden = true;
      if (days) { days.hidden = true; days.textContent = ""; }
    }

    /* One card replaces another as the licence state settles, and each is a
       different height. Travel, not teleport — this fires on the popup's first
       paint, which is exactly when a jump reads as the panel being broken. */
    showRows([[$("pro-upsell"), !!(pro || trialActive)],
              [$("pro-active"), !pro],
              [$("trial-active"), !trialActive]]);
    if (pro) $("licensed-to").textContent =
      "One-time licence · " + (maskedEmail || "this browser");
    paintRecallAccess(pro || trialActive);

    const startBtn = $("trial-start");
    const note = $("trial-note");
    const buy = $("buy-pro");
    // Before the trial, the free week is the better ask and buying is the quiet
    // second option. Once it is spent, buying IS the ask.
    if (buy) buy.classList.toggle("primary", !pro && !trialActive && trialUntil > 0);
    if (pro) return;
    if (trialActive) {
      /* Whole days remaining, and a day only goes when a full 24 hours have
         actually passed — ceil does that: seven days at the moment it starts,
         still seven an hour later, six once the first day is genuinely spent.

         The Math.max(1, ...) that used to wrap this was wrong in the one place
         it mattered: inside the last day it reported "1 day left" from the
         final 24 hours all the way to zero, so the trial appeared to end a day
         after it said it would. The final stretch says what it is instead. */
      const msLeft = trialUntil - Date.now();
      const days = Math.ceil(msLeft / 864e5);
      const left = days >= 1
        ? `${days} day${days === 1 ? "" : "s"} left`
        : msLeft > 36e5 ? `${Math.max(1, Math.round(msLeft / 36e5))} hours left` : "less than an hour left";
      startBtn.hidden = true;
      note.hidden = false;
      note.className = "pro-note active";
      note.textContent = `Trial active: ${left}, everything unlocked`;
      $("trial-status").textContent = `${left} in your free trial`;
      paintTrialBuy();
    } else if (trialUntil > 0) {
      startBtn.hidden = true;
      note.hidden = false;
      note.className = "pro-note";
      note.textContent = `Trial ended. ${self.LCTProduct.PRICE} once keeps everything forever.`;
    } else {
      startBtn.hidden = false;
      note.hidden = true;
    }
  }

  /* Whether the search box is offered at all. A locked install still gets it:
     the worker grants a few real searches over the reader's own archive, and
     watching two thousand of your own messages come back is the entire offer.
     A box you cannot type in sells nothing. `tasteSpent` flips only when the
     worker says the allowance is gone. */
  let tasteSpent = false;

  function paintRecallAccess(unlocked) {
    const offer = !unlocked && !tasteSpent;
    showRows([[$("recall-searchbox"), !(unlocked || offer)], [$("recall-locked"), unlocked || offer]]);
    /* Plain .hidden assignment does not reflect to the content attribute on an
       SVG element the way it does on HTMLElement — the property read back
       correctly but the DOM attribute, and so the CSS and the render, never
       moved. toggleAttribute writes the attribute itself. */
    $("open-recall-arrow").toggleAttribute("hidden", !unlocked);
    $("open-recall-lock").toggleAttribute("hidden", unlocked);
    $("open-recall").closest(".row").classList.toggle("is-pro-locked", !unlocked && !offer);
    $("open-recall").setAttribute("aria-label", unlocked
      ? "Open Total Recall in a new tab"
      : "Locked — start the free trial to search your archive");
    if (!unlocked && !offer) {
      $("recall-query").value = "";
      $("recall-query-meta").textContent = "";
      $("recall-results").replaceChildren();
      sizeRecallResults(false);
    }
  }

  /* The warning is the point of the whole allowance feature — being told
     BEFORE the wall, not after. It is a link rather than a fourth switch
     because the popup has a fixed height and this row already earns its
     space; the copy states the current setting, so one glance says which it
     is and one click flips it. */
  function paintWarnLink(s) {
    const on = !s || s.quotaWarn !== false;
    const link = $("quota-warn-link");
    if (!link) return;
    link.textContent = on ? "warn at 20%" : "warnings off";
    link.classList.toggle("off", !on);
    link.setAttribute("aria-label", on
      ? "Warnings on. One notification per platform under 20%, and again under 10%. Click to turn off."
      : "Warnings off. You will not be told before an allowance runs out. Click to turn back on.");
  }

  function paintToggles(s) {
    $("toggle-enabled").checked = !s || s.enabled !== false;
    $("toggle-minimap").checked = !s || s.minimap !== false;
    $("toggle-time").checked = !s || s.time !== false;
    // Default ON, and a settings object saved before that flip has no key.
    $("toggle-history").checked = !s || s.history !== false;
    $("toggle-temp").checked = !!(s && s.tempArchive === true);
    // Default on. It is the mechanism that makes the allowance panel truthful
    // rather than decorative, so the panel is meaningless with it off.
    $("toggle-quota").checked = !s || s.quota !== false;
    paintWarnLink(s);
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

  /* Which window each row is showing, keyed by platform + account.
     A provider can publish more than one — Claude states a five-hour session
     limit AND a week, ChatGPT a primary and a secondary — and only one fits on
     a row. The row leads with the one that stops you soonest and the reader
     steps through the rest by clicking the figure. Kept out here because the
     panel repaints every few seconds and a choice that reset on every repaint
     would be unusable. */
  const winPick = new Map();
  // The last thing painted, so a click can repaint from it without a round trip.
  let lastPaint = null;

  // Ring colour per provider. Each sits a step off its brand hue — near enough
  // that the ring is read as that platform without the legend, far enough that
  // it is our mark and not theirs. Kept in step with --p-* in pages/pages.css.
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
  /* Platforms that publish no allowance, and are therefore not rows on THIS
     panel. DeepSeek enforces with 429 plus a proof-of-work challenge rather
     than a quota endpoint, so its row could only ever say "no limit published"
     — a permanent line of nothing, sitting among figures. It is still archived
     like every other provider; it just has no allowance to draw.
     A record IS still rendered if one ever appears: this only stops the empty
     placeholder, so the day DeepSeek publishes a number the row comes back. */
  const NO_ALLOWANCE = new Set(["deepseek"]);
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
    /* A weekday alone only means something inside the coming week. ChatGPT's
       deep-research window resets on 17 September and this printed "Thu 5:29
       PM" — the correct weekday, a month early, and read by anyone as the day
       after tomorrow. Past six days, name the date. */
    const days = (at - now) / 864e5;
    if (days > 6 || days < -1) {
      return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
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

  /* When a reading stops being a fair statement about right now.

     A figure is not wrong because it is old — it is wrong because the user has
     been using the platform since, and nothing here saw that. A 7-day window
     read twelve hours ago has had an eighth of its life to move. So the row
     stops presenting the number as current and says how old it is instead.

     Scaled to the window it describes: a quarter of the way to its own reset,
     capped at two hours, floored at ten minutes so a reading is not called
     stale the moment after it lands. A window with no reset falls back to the
     cap. This is a DISPLAY rule — lib/quota.js already discards a window whose
     reset has actually passed. */
  function staleAfterMs(item) {
    const life = item.resetAt && item.observedAt ? item.resetAt - item.observedAt : 0;
    return Math.max(10 * 60e3, Math.min(2 * 3600e3, life > 0 ? life / 4 : 2 * 3600e3));
  }
  const isStale = (item) =>
    !!item.observedAt && Date.now() - item.observedAt > staleAfterMs(item);

  /* Four words for an empty row, chosen so the reader knows whose move it is.
     The column is narrow, so this is the short form; provenance() carries the
     sentence. */
  function whyBlank(item) {
    const why = item.lastTry && item.lastTry.skipped ? String(item.lastTry.skipped) : "";
    if (why === "tracking off") return "tracking off";
    if (why === "not signed in") return "not signed in";
    if (why === "blocked by the provider") return "blocked";
    if (why === "rate-limited") return "checking shortly";
    if (why === "could not reach the provider") return "checking shortly";
    if (why === "no working endpoint") return "no limit published";
    if (why === "provider reported nothing") return "none published";
    return item.checked ? "none published" : "checking\u2026";
  }

  /** The tooltip that makes a number auditable: which mechanism read it, which
   *  arithmetic produced it, and when. Every figure on this panel can be traced
   *  to a provider field, and this is where the user sees that. */
  function provenance(item) {
    if (!item.reported) {
      /* Say whose move it is. "This provider published no allowance figure"
         was true of a signed-out account and of a signed-in one that publishes
         nothing, and those need opposite things from the reader. */
      const why = item.lastTry && item.lastTry.skipped ? String(item.lastTry.skipped) : "";
      if (why === "tracking off") {
        return "Allowance tracking is switched off. Turn it on above to read this.";
      }
      if (why === "not signed in") {
        return `Not signed in to ${item.label} in this browser. Sign in and this fills in on its own.`;
      }
      if (why === "blocked by the provider") {
        return `${item.label} blocked the background check with a bot-protection challenge. ` +
          "Your session is fine — open the site in a tab and this fills in on its own.";
      }
      if (why === "rate-limited") {
        return "Allowance updates automatically.";
      }
      if (why === "could not reach the provider") {
        return `${item.label}'s latest allowance is not available yet. Tvara will check again automatically.`;
      }
      if (why === "no working endpoint") {
        return `${item.label} publishes no allowance figure this browser can read.`;
      }
      if (why === "provider reported nothing") {
        return `${item.label} answered, but said nothing about your remaining allowance.`;
      }
      return item.checked
        ? "This provider published no allowance figure for your account."
        : "Not checked yet. Open the site, or run Check now in the diagnostics panel.";
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
    /* Why it has not been read since. A figure that cannot be refreshed keeps
       its old timestamp, and without this the panel showed a number from half a
       day ago with no way to tell whether the poller was signed out, refused,
       or simply told nothing. */
    const why = item.lastTry;
    if (why && why.at && why.skipped) {
      const said = {
        "tracking off": "Allowance tracking is switched off.",
        "not signed in": "Could not refresh: not signed in to this provider.",
        "blocked by the provider": "Could not refresh: the provider answered a bot-protection challenge. Open its site in a tab.",
        "rate-limited": "Allowance updates automatically.",
        "could not reach the provider": "The latest allowance is not available yet. Tvara will check again automatically.",
        "no working endpoint": "Could not refresh: this provider publishes no allowance endpoint we can read.",
        "provider reported nothing": "Refreshed, but the provider returned no allowance figure."
      }[why.skipped] || `Could not refresh: ${why.skipped}.`;
      bits.push(`${said} Last tried ${agoLabel(why.at)}.`);
    }
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

      /* `reported` is not the same question as "is there a share to draw".
         A count-only window (25 remaining, no limit) reports a real figure but
         no proportion, and drawing it as a solid ring with no lit arc makes it
         pixel-identical to an untouched allowance — while the legend beside it
         says "25 left". So the dotted track belongs to every ring with no
         share, not only to the ones that reported nothing at all: it was keyed
         on `reported` and ChatGPT's count-only ring drew a full solid circle. */
      const open = !(it.reported && it.pctLeft !== null);
      const track = svgEl("circle", {
        cx: c, cy: c, r: r.toFixed(2),
        class: "usage-track" + (open ? " open" : "") + (it.out ? " spent" : "")
      });
      // An empty channel stays identifiable as its provider, just subdued.
      track.style.stroke = it.color;
      /* A share gets a full-width channel to empty out of. Everything else is a
         dotted path, weighted by how much the provider actually said: a real
         count carries more of its colour than a ring still waiting on a reply.
         Both stay thick enough to name their platform — at .44 the dot ring was
         a grey hair and the dial read as one colour with five shadows. */
      track.style.strokeWidth = open ? (w * (it.reported ? .78 : .62)).toFixed(2) : w;
      if (open) track.style.strokeDasharray = `.1 ${(w * .72).toFixed(2)}`;
      g.append(track);

      if (it.left > 0) {
        // The lit arc is what is LEFT: it begins where the head has reached and
        // runs forward, so spending eats it from twelve o'clock round.
        const len = circ * it.left;
        const arc = svgEl("circle", { cx: c, cy: c, r: r.toFixed(2), class: "usage-arc" });
        arc.style.stroke = it.color;
        arc.style.strokeWidth = w;
        /* The dial is rebuilt from scratch on every paint, so a CSS transition
           has nothing to move from: the new node is born at its final size.
           Start it where the user last saw this ring and let the next frame
           carry it — which is the difference between a ring that moved and a
           ring that was replaced. */
        const ringKey = "arc:" + it.id + "|" + (it.acct || "");
        const was = seenArc.get(ringKey);
        seenArc.set(ringKey, { left: it.left, spent: it.spent });
        const to = {
          dash: `${len.toFixed(2)} ${(circ - len).toFixed(2)}`,
          offset: (-circ * it.spent).toFixed(2)
        };
        if (was && smoothOK() && (was.left !== it.left || was.spent !== it.spent)) {
          const wasLen = circ * was.left;
          arc.style.strokeDasharray = `${wasLen.toFixed(2)} ${(circ - wasLen).toFixed(2)}`;
          arc.style.strokeDashoffset = (-circ * was.spent).toFixed(2);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!arc.isConnected) return;
            arc.style.strokeDasharray = to.dash;
            arc.style.strokeDashoffset = to.offset;
          }));
        } else {
          arc.style.strokeDasharray = to.dash;
          arc.style.strokeDashoffset = to.offset;
        }
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
      // A count with no limit is not a percentage, but it is not "no data"
      // either — it is the figure the reader was given, and the dial saying
      // "no data" while the row beside it says "25 left" is the panel
      // contradicting itself about one reading.
      const counted = items.filter((it) => it.pctLeft === null && it.remaining !== null);
      if (reporting.length) {
        const low = reporting.reduce((m, it) => Math.min(m, it.pctLeft), 100);
        num.textContent = low + "%";
        cap.textContent = "left";
      } else if (counted.length) {
        const low = counted.reduce((m, it) => Math.min(m, it.remaining), Infinity);
        num.textContent = String(low);
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

    /* No "ALLOWANCE LEFT" header any more. The verdict line above the dial
       already names what this is and says the one thing worth knowing, and the
       popup has a fixed height — a heading that repeats the sentence above it
       costs a row the trial card needs. */

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "usage-row" + (it.hot ? " hot" : "") + (it.blocked ? " unavailable" : "");
      // Every figure is auditable: hovering a row says where it came from.
      // No hover tooltip: a box of text that covers the panel while you are
      // reading it is not an explanation. The sentence stays where assistive
      // tech can still reach it.
      row.setAttribute("aria-label", provenance(it));

      // A hollow pip, lighter where the track is dotted: the legend repeats the
      // dial's own vocabulary at 9px. Never a broken ring — see popup.css.
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
      /* A provider that publishes more than one window gets a figure the
         reader can step through: Claude states a five-hour session limit AND a
         week, and which one matters depends on what they are about to do. A
         button, not a span, so it is reachable by keyboard and announced as
         something that does something. */
      const many = !it.blocked && it.winCount > 1 && it.winNext;
      const val = document.createElement(many ? "button" : "span");
      val.className = "usage-val" + (many ? " usage-switch" : "");
      if (many) {
        val.type = "button";
        /* No `title`. A native tooltip here sat on top of the row's own
           provenance one and read out the meter's raw name — "Show paste text
           to file" — which is neither a sentence nor a thing anybody asked to
           be told. The dotted caption already says the figure is a control,
           and the row's provenance tooltip is the text worth showing on hover.
           The label stays for screen readers, where nothing else conveys it,
           and names the WINDOW rather than the meter for the same reason. */
        const next = it.winNext;
        val.setAttribute("aria-label",
          it.label + ": show " + (next.span || "the other window"));
        val.addEventListener("click", () => {
          winPick.set(it.key, (winPick.get(it.key) || 0) + 1);
          if (lastPaint) paintUsage(lastPaint.total, lastPaint.quota);
        });
      }
      // Set by the tween below when this row's figure is one the reader has
      // already seen at a different value — see the sweep in popup.css.
      let moved = false;
      if (it.blocked) {
        val.classList.add("usage-reset");
        val.setAttribute("aria-label", `${it.label} unavailable${it.blockedUntil ? ` until ${new Date(it.blockedUntil).toLocaleString()}` : ""}`);
        if (it.blockedUntil) {
          const when = document.createElement("span");
          when.textContent = resetLabel(it.blockedUntil);
          val.append(when);
        }
      } else if (it.pctLeft !== null) {
        const stale = isStale(it);
        const num = document.createElement("b");
        moved = tweenNumber(num, "pct:" + it.id + "|" + (it.acct || ""), it.pctLeft, (n) => n + "%");
        if (stale) num.className = "usage-stale";
        const cap = document.createElement("span");
        cap.className = "usage-cap" + (stale ? " muted" : "");
        /* Stale: the reading's AGE, not the window's reset. Which is the thing
           the reader has to know — a reset two days out says nothing about
           whether this number survived the last twelve hours of use, and
           printing only the reset made a half-day-old figure look live. */
        /* Which window, and when it turns over. Claude publishes a five-hour
           session limit and a seven-day one; a bare percentage with neither
           says nothing about what it is a percentage OF, and the reset is the
           thing people actually plan around. */
        const bits = [];
        // A side meter says what it is: "0% left · Codex", never passed off as the plan.
        if (it.side && it.meter) bits.push(it.meter);
        if (it.span) bits.push(it.span);
        if (it.resetAt) bits.push("resets " + resetLabel(it.resetAt));
        if (stale) bits.push("read " + agoLabel(it.observedAt));
        cap.textContent = " left" + (bits.length ? " · " + bits.join(" · ") : "");
        val.append(num, cap);
      } else if (it.remaining !== null && it.remaining !== undefined) {
        /* A count with no ceiling. ChatGPT meters several features this way —
           "deep_research: 25 remaining" — and there is no honest percentage to
           make of it without inventing the denominator. The count IS the
           figure, so it is shown as one, with what it is counting. */
        const stale = isStale(it);
        const num = document.createElement("b");
        moved = tweenNumber(num, "left:" + it.id + "|" + (it.acct || ""), it.remaining);
        if (stale) num.className = "usage-stale";
        const cap = document.createElement("span");
        cap.className = "usage-cap" + (stale ? " muted" : "");
        const what = (it.meter || "").replace(/[_-]+/g, " ").trim();
        const bits = [];
        if (what) bits.push(what);
        if (it.span) bits.push(it.span);
        if (it.resetAt) bits.push("resets " + resetLabel(it.resetAt));
        if (stale) bits.push("read " + agoLabel(it.observedAt));
        cap.textContent = " left" + (bits.length ? " · " + bits.join(" · ") : "");
        val.append(num, cap);
      } else if (it.resetAt) {
        /* A reset with no figure behind it. Printing the clock alone reads as
           "we are tracking this" — the row looked identical to a measured one
           and said nothing. What is true is that the provider told us WHEN the
           window turns over and not how much of it is left, so the row says
           that, in that order. */
        const cap = document.createElement("span");
        cap.className = "usage-cap muted";
        cap.textContent = `not reported · resets ${resetLabel(it.resetAt)}`;
        val.append(cap);
      } else {
        /* The reason, not the jargon. "not published" and "not reported" are
           the same sentence to a reader and neither says what to do; the usual
           cause is simply not being signed in to that site in this browser,
           which is a thing somebody can go and fix. The full sentence is in the
           row's tooltip — see provenance(). */
        const cap = document.createElement("span");
        cap.className = "usage-cap muted";
        cap.textContent = whyBlank(it);
        val.append(cap);
      }

      row.append(pip, name, val);
      /* A number that changed is the only thing on this panel worth looking
         for, and a repaint looks exactly like one. One sweep across the row
         says which line moved without the reader hunting for it. */
      if (moved) row.classList.add("moved");
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
  /* ---------- numbers that move ----------
     Everything here is read at a glance, and a number that JUMPS reads as a
     glitch: the eye cannot tell a repaint from a change. The same number
     arriving over a few hundred milliseconds reads as the panel working. All
     of it is off under prefers-reduced-motion, where jumping IS the answer. */
  /* One engine for the whole page (lib/motion.js): one frame callback for
     every value in flight, transform and opacity only, and nothing at all
     while the popup is closed. The fallbacks below are what runs if that file
     ever fails to load — a panel that cannot animate must still show numbers. */
  const M = self.LCTMotion;
  /* The engine answers this normally. Without it — the one case where that file
     did not load — ask the browser directly rather than assume motion is
     welcome: the stylesheet would still suppress the animation, but this gate
     also decides whether a class is added at all. */
  const smoothOK = () => {
    if (M) return !M.reduced;
    try { return !matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch { return true; }
  };
  const seenArc = new Map();             // ring key -> the geometry last drawn

  function tweenNumber(el, key, to, format) {
    if (!el) return;
    const fmt = format || ((n) => Math.round(n).toLocaleString());
    if (M) return M.number(el, key, to, fmt);
    el.textContent = fmt(to);
    return false;
  }

  /* ---------- rows that come and go without moving the ones that stay ----------
     The worker keeps learning things while the popup is open: a queue is
     found, a deletion is noticed, a provider finally reports. Each of those
     un-hides a row, and an un-hidden row moves everything beneath it in a
     single frame — which does not read as new information arriving, it reads
     as the panel lurching under the cursor.

     FLIP fixes it properly: measure where everything is, let the layout change,
     then animate the difference away with transforms. Nothing reflows during
     the motion and every row lands exactly where the browser was going to put
     it. Only when a visibility actually changed — two rect reads per row on
     every poll would be a forced layout twice a second for no reason. */
  // Everything a change can push around, in one place: the panel is a single
  // column, so anything below the change moves and nothing above it does.
  const MOVERS = ".pulse, .rows > *, .pro-card, .state-card";
  const movers = () => document.querySelectorAll(MOVERS);

  function showRows(changes) {
    const pending = changes.filter((c) => c[0] && c[0].hidden !== c[1]);
    if (!pending.length) return false;
    const apply = () => { for (const [el, hide] of pending) el.hidden = hide; };
    if (!M) { apply(); return true; }
    M.flip(movers(), apply);
    for (const [el, hide] of pending) if (!hide) M.enter(el, { y: 3 });
    return true;
  }

  /* A line of prose that changed. Not a tween — words do not interpolate — but
     the change is still worth seeing happen rather than finding. */
  function setLine(el, next) {
    if (!el) return;
    const text = String(next == null ? "" : next);
    if (el.textContent === text) return;
    /* Fade the line only when the SENTENCE changed. "33 done, 481 to go"
       becomes "34 done, 480 to go" every 1.2 seconds while a download runs,
       and animating that read as a light blinking on and off under the
       heading — motion where nothing was happening but arithmetic. */
    const skeleton = (v) => String(v).replace(/[\d.,%]+/g, "#");
    const sameSentence = skeleton(el.textContent) === skeleton(text);
    /* A sentence that wraps to a second line — or stops wrapping — changes the
       row's height and moves every row beneath it. By the time the new text is
       in, the layout has already changed, so the neighbours are measured
       first. Nothing moves in the common case and flip() skips them; when one
       does, it travels. This replaces reserving a second line on every live
       sub-line, which cost three rows a line of empty space each. */
    const apply = () => { el.textContent = text; };
    if (M) M.flip(movers(), apply); else apply();
    if (!smoothOK() || sameSentence) return;
    if (M) M.replay(el, "swap");
  }

  /* ---------- the headline ----------
     It used to read "0 messages asleep right now" whenever the popup was
     opened anywhere but inside a huge conversation — which is most of the
     time. Two thirds of what this panel showed at rest was a zero and a row of
     100%s: a dashboard that says nothing is worse than no dashboard.

     So the number falls back to the one that is true even when you are not in
     a long chat: how much of your own history this browser is holding. */
  function paintPulse(windowedTotal, archive) {
    const num = $("stat-windowed");
    const label = $("stat-label");
    num.hidden = false;
    if (windowedTotal > 0) {
      tweenNumber(num, "pulse", windowedTotal);
      label.textContent = "messages asleep right now";
      return;
    }
    if (archive && archive.chats > 0) {
      tweenNumber(num, "pulse", archive.msgs || archive.chats);
      label.textContent = archive.msgs ? "messages" : "chats archived";
      return;
    }
    /* A giant "0" is the first thing in the panel on a fresh install, and zero
       of something is not a statistic. Drop the number and let the sentence
       carry the line: it is the only thing here with anything to say. */
    if (M) M.forget("pulse");
    num.textContent = "";
    num.hidden = true;
    label.textContent = "Open a long chat and watch it work.";
  }

  // Keys that name the response's shape rather than what is being metered.
  const GENERIC_METER = /^(window|default|general|primary|main|overall|entitlement|-)?$/;

  let dialPainted = false;
  // What the dial was last drawn from. See the signature check in paintUsage.
  let lastUsageSig = "";
  function paintUsage(windowedTotal, quota) {
    // Kept so a click on a row can repaint from the same data rather than wait
    // for the next poll — see winPick.
    lastPaint = { total: windowedTotal, quota };

    const records = (quota && Array.isArray(quota.records) ? quota.records : [])
      // The whitelist gate. A record for anything that is not one of the six
      // known providers is not rendered, whatever wrote it.
      .filter((rec) => rec && KNOWN_IDS.has(rec.id));
    const checked = (quota && quota.checked) || {};
    // Why each figure is as old as it is — the worker records every refusal.
    const lastTry = (quota && quota.lastTry) || {};

    const rowMap = new Map();
    const unseen = [];                // supported, but never opened here
    const seats = new Map();          // platform id -> how many accounts seen
    const seat = (id) => seats.set(id, (seats.get(id) || 0) + 1);

    // 1. A row per ACCOUNT that has a reading. Per account because the
    //    allowance belongs to the account — two logins on one host are two
    //    windows and never a sum.
    // A source that did not learn the account id is not a second account. Seat
    // the identified records first, then let an anonymous one fill in only
    // where nothing identified has claimed that platform.
    const identified = new Set(records.filter((r) => r.acct).map((r) => r.id));
    for (const rec of records) {
      if (!rec.acct && identified.has(rec.id)) continue;
      const key = rec.id + "|" + (rec.acct || "");
      /* Older records carry only the chosen window; newer ones carry the whole
         ranked list. Either way the row leads with the head unless the reader
         has stepped it on. */
      const all = Array.isArray(rec.windows) && rec.windows.length
        ? rec.windows
        : (rec.window ? [rec.window] : []);
      /* Only windows that STATE something are worth stepping to. A window with
         a reset and no figure is a real row when it is all a provider gave us —
         it says when the clock turns over and admits it knows no more — but as
         one of two or three options it is a step to nothing: the reader clicks
         a number and lands on "not reported". */
      const figured = all.filter((w) => w &&
        ((w.pctLeft !== null && w.pctLeft !== undefined) ||
         (w.remaining !== null && w.remaining !== undefined)));
      const wins = figured.length ? figured : all;
      const at = wins.length ? ((winPick.get(key) || 0) % wins.length) : 0;
      const blocker = rec.blocked && rec.blocker ? rec.blocker : null;
      const win = blocker || wins[at] || rec.window || null;
      // What the row is RANKED by never changes as the reader steps through it:
      // sorting on the selected window made a row jump up and down the list
      // under the cursor, which reads as the panel losing its place.
      const lead = wins[0] || rec.window || null;
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
        // Which window the figure belongs to: "5h", "week".
        span: (win && win.span) || "",
        remaining: win && win.remaining !== undefined && win.remaining !== null ? win.remaining : null,
        limit: win && win.limit !== undefined ? win.limit : null,
        /* The window's own name ("deep_research"). NOT `label` — that is the
           platform name this row is printed under.
           Falls back to the key, which is derived from where the figure sat in
           the response ("pro-search"): Perplexity names none of its meters, so
           without this the row read "3 left" and never said 3 of what. A
           generic key names nothing, so it stays quiet instead. */
        meter: (win && (win.label || (GENERIC_METER.test(win.key || "") ? "" : win.key))) || "",
        // Codex, deep research, image generation: a meter beside the plan, never the plan itself.
        side: !!(win && win.side),
        unit: (win && win.unit) || "",
        basis: (win && win.basis) || "",
        source: (win && win.source) || rec.source || "",
        observedAt: (win && win.observedAt) || rec.observedAt || 0,
        lastTry: lastTry[rec.id] || null,
        checked: !!checked[rec.id],
        key,
        blocked: !!blocker,
        blockedUntil: blocker ? blocker.resetAt || 0 : 0,
        winCount: blocker ? 1 : wins.length,
        leadPct: lead && lead.pctLeft !== null && lead.pctLeft !== undefined ? lead.pctLeft : null,
        // What clicking would move to, so the row can say so before it is used.
        winNext: blocker ? null : (wins.length > 1 ? (wins[(at + 1) % wins.length] || null) : null)
      });
    }

    // 2. A placeholder for every supported provider with no reading, so the
    //    panel says which platforms it covers. These draw an empty dotted ring
    //    and read "not reported" — never a zero.
    for (const p of KNOWN_PLATFORMS) {
      if (seats.has(p.id) || NO_ALLOWANCE.has(p.id)) continue;
      // A platform never seen on this install is not news, it is a catalogue.
      // Summarised below the legend instead of costing a row each — unless it
      // is all we have, in which case the catalogue IS the panel.
      /* A platform we TRIED and could not read is news, even though it was
         never "checked" in the sense of having answered. "Not signed in to
         Perplexity" is the single most useful line this panel can show a new
         install, and summarising it into "Also covered:" hid the one thing the
         reader could have acted on. */
      if (!checked[p.id] && !lastTry[p.id]) { unseen.push(p); continue; }
      seat(p.id);
      rowMap.set(p.id + "|", {
        id: p.id, acct: "", label: p.label, plan: "", account: "", ordinal: 0,
        reported: false, pctLeft: null, resetAt: 0, span: "", remaining: null, limit: null,
        meter: "", unit: "", basis: "", source: "", observedAt: 0,
        lastTry: lastTry[p.id] || null,
        checked: !!checked[p.id]
      });
    }

    // Nothing has ever reported here: show the catalogue rather than an
    // empty panel, which is what a fresh install and every test profile sees.
    if (!rowMap.size) {
      for (const p of unseen) {
        if (NO_ALLOWANCE.has(p.id)) continue;
        seat(p.id);
        rowMap.set(p.id + "|", {
          id: p.id, acct: "", label: p.label, plan: "", account: "", ordinal: 0,
          reported: false, pctLeft: null, resetAt: 0, span: "", remaining: null, limit: null,
          meter: "", unit: "", basis: "", source: "", observedAt: 0, checked: false
        });
      }
      unseen.length = 0;
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
    const ranked = [...rowMap.values()]
      .sort((a, b) => {
        if (a.reported !== b.reported) return a.reported ? -1 : 1;
        // The row's OWN standing — its leading window — not whichever one the
        // reader is currently looking at. See `lead` above.
        const ap = a.leadPct === null || a.leadPct === undefined ? 101 : a.leadPct;
        const bp = b.leadPct === null || b.leadPct === undefined ? 101 : b.leadPct;
        return ap - bp || a.label.localeCompare(b.label);
      })
      .map((b) => ({
        ...b,
        ...arcOf(b.pctLeft),
        color: ringColor(b.id, (seats.get(b.id) || 0) > 1 ? b.ordinal : 0),
        hot: b.pctLeft !== null && b.pctLeft <= LOW_PCT && b.pctLeft > 0,
        out: b.blocked || b.pctLeft === 0
      }));
    /* The dial has room for MAX_RINGS; the verdict has room for the truth.
       Slicing before the verdict was computed meant a count-only row — which
       sorts last among the reported ones — could be pushed off the dial by six
       percentage rows and take its sentence with it, so a real reading vanished
       from the panel because the drawing was full. */
    const items = ranked.slice(0, MAX_RINGS);

    /* ---------- is this paint going to change anything? ----------
       refreshPulse repaints every five seconds for as long as the popup is
       open, and this function rebuilds the dial from nothing every time: two
       SVGs, six arcs, a legend row per provider, all created, styled and laid
       out to arrive at the picture already on the screen. Nothing about the
       allowance changes on that cadence — a provider is polled minutes apart.

       So sign what the drawing actually depends on, and when the signature is
       the one already on screen, stop before building anything. The window a
       reader stepped to is part of the item, so a click still repaints.

       The items themselves are the signature, not a hand-picked subset of
       their fields: a field left out of the list is a real change that stops
       being drawn, which is the failure this panel exists to avoid. The minute
       bucket is there because two labels are relative to now — "resets 9:46 PM"
       does not move, but "read 3m ago" does, and a signature made only of the
       data would freeze it. */
    const sig = JSON.stringify([items, unseen.map((p) => p.id), Math.floor(Date.now() / 60000)]);
    if (sig === lastUsageSig && $("usage-bars").firstChild) return;
    lastUsageSig = sig;

    /* ---------- the verdict ----------
       The panel used to be six rows of "100% left", which is the answer to a
       question nobody asks. The question people actually have — the one the
       whole category of usage trackers exists for — is "am I about to be cut
       off mid-thought?" So the panel now answers it in a sentence, and the
       rings become the detail behind the answer rather than the answer. */
    // A count is a reading too — "25 deep research left" is as much an answer
    // as "62%", and a panel that ignored it would say "nothing reported" while
    // showing a number.
    /* A side meter never speaks for the provider. An eight-hour-old ChatGPT
       reading kept only its Codex window — the chat counters had reset and aged
       out, the month-long Codex window had not — and the panel headlined
       "ChatGPT is out" to somebody who could chat all day. */
    const reported = ranked.filter((it) => it.pctLeft !== null && !it.side);
    // Ordered by what is closest to running out: with two counts in hand, "3
    // pro searches left" is the sentence worth writing, not "25 deep research".
    const counted = ranked
      .filter((it) => it.pctLeft === null && it.remaining !== null)
      .sort((a, b) => a.remaining - b.remaining);
    const lowest = reported.length
      ? reported.reduce((a, b) => (a.pctLeft <= b.pctLeft ? a : b))
      : null;

    const verdict = document.createElement("p");
    verdict.className = "usage-verdict";
    if (!reported.length && counted.length) {
      // Counts are answers too. "25 deep research left" is as much a reading as
      // "62%", and a panel that only understood percentages called it nothing.
      const c = counted[0];
      const what = (c.meter || "").replace(/[_-]+/g, " ").trim() || "uses";
      verdict.textContent = `${c.label}: ${c.remaining.toLocaleString()} ${what} left` +
        (c.resetAt ? `, resets ${resetLabel(c.resetAt)}` : "");
    } else if (!reported.length) {
      /* Nothing reported yet, and the dial is still drawn. It used to be
         replaced by this one line, which meant the panel a new install opens on
         — the first thing anyone sees of this product — had no dial in it at
         all, and the rings only ever appeared after the user had guessed that
         visiting a chat site was the trigger. The worker now asks every
         provider at install (bg.js firstRunBootstrap), so the honest state here
         is "asking", and six dotted rings are what "asking" looks like. */
      const asked = ranked.some((it) => it.checked);
      verdict.textContent = asked
        ? "No allowance published for these accounts yet."
        : "Reading your accounts…";
    } else if (lowest.pctLeft <= 0) {
      verdict.className += " hot";
      verdict.textContent = `${lowest.label} is out` +
        (lowest.resetAt ? `, back ${resetLabel(lowest.resetAt)}` : "");
    } else if (lowest.pctLeft <= LOW_PCT) {
      verdict.className += " hot";
      verdict.textContent = `${lowest.label} is running low: ${lowest.pctLeft}% left` +
        (lowest.resetAt ? `, resets ${resetLabel(lowest.resetAt)}` : "");
    } else if (counted.length) {
      /* Percentages are all healthy, and a count is the more useful sentence:
         "3 pro searches left" is something to act on, "Claude is the closest at
         100%" is not. */
      const c = counted[0];
      const what = (c.meter || "").replace(/[_-]+/g, " ").trim();
      verdict.textContent = `Nothing is running low. ${c.label}: ${c.remaining.toLocaleString()}` +
        `${what ? " " + what : ""} left.`;
    } else {
      // Naming the lowest keeps this a reading rather than a reassurance.
      verdict.textContent = `Nothing is running low. ${lowest.label} is closest, at ${lowest.pctLeft}%.`;
    }

    const panel = document.createElement("div");
    panel.className = "usage-panel";
    // After the first paint the arcs are already in place — replaying the
    // sweep animation on every storage-change repaint is the visible
    // "multiple refresh" glitch. Suppress it from the second paint on.
    if (dialPainted) panel.classList.add("no-intro");
    dialPainted = true;
    panel.append(usageDialEl(items), usageLegendEl(items));
    // Supported but never opened here: one muted line, not a row each.
    if (unseen.length) {
      const rest = document.createElement("p");
      rest.className = "usage-rest";
      rest.textContent = "Also covered: " + unseen.map((p) => p.label).join(", ");
      panel.append(rest);
    }
    /* The dial and its legend grow and shrink as providers report, and
       everything below them moves when they do. Measure, swap, then animate
       the difference away — see showRows for why this is worth doing. */
    const swap = () => $("usage-bars").replaceChildren(...(ranked.some((it) => it.blocked) ? [panel] : [verdict, panel]));
    if (M && $("usage-bars").firstChild) M.flip(movers(), swap); else swap();
    // The rings arrive outermost first, so the eye follows the drawing rather
    // than finding it already finished.
    if (M && !panel.classList.contains("no-intro")) {
      M.stagger(panel.querySelectorAll(".usage-row"), "usage-row-in", 34, 6);
    }
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

  /* Device screen and Buy are painted by two owners that cannot wait for each
     other: load() settles the licence, refreshIdentity() the account. Separate
     flags so a slow identity call cannot un-paint a licence's button.
     /sessions gates on identity, not licence — a trial device belongs there.
     Declared above every reader; `identityVerified` below would be a TDZ throw
     during the synchronous first paint. */
  /* Painted during parse from the cache, then again from identity-state. The
     photo URL is cached with the rest of the first-paint mirror so a signed-in
     header does not pop a face in one round trip after it opens. */
  let accountProfile = (cache && cache.profile) || null;
  /* Here, not beside paintIdentity() where it is written. paintAccount() reads
     it during the synchronous first paint, and a `let` declared further down
     the module made that read a TDZ throw — which aborted the whole parse, so
     the usage panel never painted at all and the popup opened with an empty
     dial. Seeded from the same cached flag as devicesAccount: a signed-in
     header should not blink through "not signed in" on every open. */
  let identityVerified = !!(cache && cache.identity);
  let currentPlan = "free";
  let devicesPro = !!(cache && cache.pro && cache.licenseKind === "dodo");
  let devicesAccount = !!(cache && cache.identity);
  let googleReady = !(cache && cache.noGoogle);
  let checkoutPending = false;

  function paintDevicesEntries() {
    // One entry per card; only one card is on screen at a time.
    const set = (id, show) => { const el = $(id); if (el) el.hidden = !show; };
    set("license-devices", devicesPro);
    set("trial-devices", devicesAccount);
    set("identity-devices", devicesAccount);
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
  paintPulse((cache && cache.stats && cache.stats.total) || 0,
             (cache && cache.archive) || null);
  paintArchiveCount((cache && cache.archive && cache.archive.chats) || 0);
  paintUsage(
    (cache && cache.stats && cache.stats.total) || 0,
    (cache && cache.quota) || null
  );
  if (cache && cache.licenseNote) paintLicenseState({ ...cache.licenseNote, sticky: true });
  paintDevicesEntries();

  /* ---------- authoritative async load ---------- */

  /* Ask for exactly the keys this panel paints, never the whole store. The
     archive ledger, per-conversation timestamps and saved reading positions
     share local storage, and get(null) deserialized every one of them before
     the popup could show anything — the heavier someone's archive, the slower
     it opened. A stats key is "stats:" + the hostname main.js is running on, so
     the content-script matches are the complete list. Derived from the manifest
     rather than typed out, so it cannot drift when a platform is added. */
  const STATS_KEYS = (() => {
    const out = new Set();
    try {
      for (const cs of chrome.runtime.getManifest().content_scripts || []) {
        for (const m of cs.matches || []) {
          const after = m.split("://")[1];
          if (after) out.add("stats:" + after.split("/")[0]);
        }
      }
    } catch { /* no manifest access: the breakdown renders empty, nothing breaks */ }
    return [...out];
  })();

  /* The headline number, kept live.
     A background pass archives chats while the popup sits open, and this used
     to be read once per open — so the count only moved if you closed the panel
     and opened it again. The worker caches stats() against its own write
     counter, so asking again with nothing written between costs nothing. */
  let lastWindowed = 0;
  let lastQuota = null;
  async function refreshPulse() {
    try {
      const st = await send({ type: "recall-stats" });
      if (!st || st.err) return;
      const archive = { chats: st.chats || 0, msgs: st.msgs || 0 };
      saveCache({ archive });
      paintPulse(lastWindowed, archive);
      paintArchiveCount(archive.chats);
    } catch { /* the panel keeps the number it has */ }
  }

  /* Bumped whenever this popup settles the entitlement itself — activating a
     licence, starting a trial. A load() carries the value it started with, and
     drops its own plan paint if that moved underneath it. See the guard below
     for why a stale paint is not cosmetic. */
  let planGen = 0;

  async function load() {
    let gen = planGen;
    /* Both worker questions go out together. Serialised, opening the popup
       paid a cold service-worker start, then waited for quota-state, then
       waited again for entitlement-state before anything below the toggles
       could paint. They are independent reads; the worker answers them in
       parallel. */
    const quotaAsked = send({ type: "quota-state" });
    const verdictAsked = send({ type: "entitlement-state" });
    // The trial clock is NOT read here: the worker's entitlement verdict below
    // is the only authority on it, and a second copy could disagree.
    const all = await chrome.storage.local.get(["settings", "license", ...STATS_KEYS]);
    const { settings, license } = all;

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
    const quota = await quotaAsked;
    lastQuota = quota;                    // what the open-panel refresher works from
    paintUsage(total, quota);

    /* The headline needs something true to say when you are not sitting in a
       long chat. The archive count is free (not a gated call), local, and the
       one number that is real at rest. */
    /* Keep the cached archive figure. This used to repaint with `null`, which
       dropped the headline to "0 messages asleep" before the async recall-stats
       call put it back — a visible 12,000 → 0 → 12,000 flicker on every open,
       and if that call failed the zero simply stayed. It is also not the free
       call the old comment claimed: stats() cursors every record and sums every
       message length, on most opens. */
    lastWindowed = total;
    paintPulse(total, (cache && cache.archive) || null);
    /* Asked on EVERY load, not only when there is no windowed figure: the
       archive count is the headline most of the time, and it grows the whole
       time a background pass is running. It used to be fetched once, so the
       number only ever changed when the popup was closed and opened again. */
    refreshPulse();

    /* Opening the popup is exactly when a stale percentage matters, so ask the
       provider for a fresh one — but only for platforms we already have a
       reading or a signed-in session for, and the worker's own one-per-minute
       floor still applies. Fire-and-forget: the reply lands as a storage change
       and repaints, so a slow provider never holds the panel closed. */
    const refreshable = new Set(
      ((quota && quota.records) || []).map((r) => r && r.id).filter(Boolean)
    );
    for (const id of Object.keys((quota && quota.checked) || {})) refreshable.add(id);
    if (refreshable.size) {
      /* A platform whose figure is ALREADY old asks as "manual", which skips
         the worker's one-per-minute floor. That floor exists to stop a burst of
         opens hammering a provider; it is the wrong rule for the one case the
         user is complaining about — staring at a figure from twelve hours ago
         while the panel politely declines to ask again. Everything fresh still
         goes through the floor. */
      const oldOnes = new Set(
        ((quota && quota.records) || [])
          .filter((r) => r && r.id && (!r.observedAt || Date.now() - r.observedAt > 10 * 60e3))
          .map((r) => r.id)
      );
      for (const id of refreshable) {
        send({ type: "quota-refresh", platform: id,
          reason: oldOnes.has(id) ? "manual" : "popup" });
      }
    } else {
      /* Nothing has ever been read here — a fresh install whose bootstrap
         sweep has not landed, or one that was interrupted. Refreshing the
         platforms we know about is a no-op in that state, which is exactly how
         the panel used to stay empty forever: the only trigger for a first
         reading was visiting a chat site. Ask for all six instead; the worker
         throttles the sweep and the readings land as a storage change. */
      send({ type: "quota-sweep", reason: "popup" });
    }

    // The worker decides; the popup only renders. Asking it here rather than
    // recomputing locally means one verdict, and the one that gates the data.
    /* Activation writes the licence FIRST and mints the token a round trip
       later — and writing the licence is what woke this load(), through the
       storage.onChanged listener at the bottom of this file. So this verdict
       can predate the token, and painting it flips a just-activated popup back
       to Free, shows "Activation didn't finish", and caches that as the next
       first paint. Ask again rather than paint what is already out of date;
       this repaints everything below, so it cannot just bail out either — the
       Manage-devices button is only ever shown from here. */
    let verdict = await verdictAsked;
    for (let i = 0; i < 3 && gen !== planGen; i++) {
      gen = planGen;
      verdict = await send({ type: "entitlement-state" });
    }
    /* Only a GRANTING trial paints as one. An unverified week runs its clock
       and unlocks nothing, so showing a "Trial — 7 days left" badge over a
       locked Recall would be the popup lying about what the user has. It reads
       as Free, with the upsell and the verify prompt still standing. */
    const trial = verdict && verdict.trial;
    /* `via` rather than `trial.grants`: grants only says a signed week exists,
       and a licensed install can be holding one of those too — which is how a
       paying customer's header came to read TRIAL. The badge names what is
       actually unlocking the extension right now, and nothing else. */
    const trialUntil = (verdict && verdict.via === "trial" && trial && trial.until) || 0;
    const pro = !!(verdict && verdict.entitled && verdict.via !== "trial");
    const licenseKind = (verdict && verdict.kind) || null;
    const masked = license && license.key ? maskEmail(license.email) : null;

    if (license && license.key) {
      // Two independent revocation paths, both fire-and-forget, neither blocks
      // paint. The token is the gate; maybeRevalidate is the second signal —
      // it sets revokedAt, which evaluate() treats as an immediate hard stop,
      // and it still lands a refund or chargeback if the issuer is unreachable.
      send({ type: "entitlement-refresh" });
      /* "Am I still signed in on this device?" — the question the 30-day token
         does not ask on its own. Opening the popup is the moment a person is
         most likely to be looking when the answer is no. */
      send({ type: "session-heartbeat" });
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
          note: "Re-activate here from the popup. You have 5 device slots."
        },
        "key-mismatch": { text: "This licence was deactivated on your account." },
        "no-token": {
          text: "Activation didn't finish.",
          note: "Paste your key again. The seat is already yours, nothing was lost."
        }
      };
      /* A device signed out from somewhere else has no token, so the verdict
         reads "no-token" — the same reason a half-finished activation gives.
         Same symptom, opposite instruction: one says paste your key again, the
         other says you were signed out on purpose. The marker is what tells
         them apart, and without it this popup blames the user for something
         they did deliberately from another machine. */
      const signedOut = await self.LCTEntitlement.readSignOut();
      if (!pro && signedOut) {
        DEAD["no-token"] = DEAD.revoked = DEAD["device-mismatch"] = DEAD["key-mismatch"] = {
          text: signedOut.reason === "revoked"
            ? "This licence was deactivated on your account."
            : "You signed this device out.",
          note: signedOut.reason === "revoked"
            ? "If that's a surprise, reply to your purchase email and we'll sort it out."
            : "Activate again below to use Pro here. Your archive never left this device."
        };
      }
      const dead = !pro && verdict && DEAD[verdict.reason];
      if (dead) {
        paintLicenseState({
          note: "If that's a surprise, reply to your purchase email and we'll sort it out.",
          ...dead, cls: "err", sticky: true
        });
      }
    }
    devicesPro = !!(pro && licenseKind === "dodo");
    paintDevicesEntries();
    const seatCount = licenseKind === "dodo"
      ? Object.keys((await self.LCTDodo.readSeats()).seats).length : 0;
    paintPlan(pro, masked, trialUntil);
    saveCache({ pro, masked, trialUntil, licenseKind, seatCount, settings: settings || null,
      stats: { total, rows }, quota: quota || null });
  }

  /* ---------- settings ---------- */

  // Read back rather than tracked in a variable: the link is the display of
  // this setting, so the display cannot drift from what gets saved.
  const warnOn = () => !$("quota-warn-link").classList.contains("off");

  async function saveSettings() {
    const settings = {
      enabled: $("toggle-enabled").checked,
      minimap: $("toggle-minimap").checked,
      time: $("toggle-time").checked,
      history: $("toggle-history").checked,
      tempArchive: $("toggle-temp").checked,
      quota: $("toggle-quota").checked,
      quotaWarn: warnOn()
    };
    saveCache({ settings });
    await chrome.storage.local.set({ settings });
  }

  for (const id of ["toggle-enabled", "toggle-minimap", "toggle-time", "toggle-history", "toggle-temp", "toggle-quota"]) {
    $(id).addEventListener("change", saveSettings);
  }

  /* ---------- filling in the archive ----------
     The listing gives every chat's title in one call; the text costs one call
     each. So a fresh archive is thousands of titles and almost no words, and
     Total Recall — the thing being paid for — can only match titles. This row
     is the honest version of that: it says how much is missing, fetches it
     while you watch, and stops when you say. */
  let fillTimer = null;

  function savedMessageLabel() {
    const messages = Math.max(0, Number(cache && cache.archive && cache.archive.msgs) || 0);
    return messages ? `${messages.toLocaleString()} messages already saved` : "No message text saved yet";
  }

  /* The bar is mounted only when there is a real proportion to draw. A bar at
     0% of an unknown total is a spinner wearing a progress bar's clothes. */
  /* The rail is always there — see .fill-bar. What changes is how much of it
     is filled, as a transform, and whether it has a proportion to state at
     all. Nothing here toggles a box in or out of the layout. */
  function paintBar(done, total) {
    const bar = $("fill-bar");
    const fill = $("fill-bar-fill");
    if (!bar || !fill) return;
    const known = total > 0;
    bar.classList.toggle("waiting", !known);
    const p = known ? Math.max(0, Math.min(1, done / total)) : 0;
    fill.style.transform = `scaleX(${p.toFixed(4)})`;
  }
  const hideBar = () => {
    const bar = $("fill-bar");
    const fill = $("fill-bar-fill");
    if (bar) bar.classList.remove("waiting");
    if (fill) fill.style.transform = "scaleX(0)";
  };

  function paintFill(state) {
    /* The ROW carries the state classes (.busy draws the rail on its edge); the
       button inside it is only the hit area. Two controls now live on this row,
       so they are not the same element any more. */
    const row = $("fill-row");
    const title = $("fill-title");
    const sub = $("fill-sub");
    if (!row) return;
    /* No answer is not "nothing left to download". The worker is MV3: it gets
       reclaimed, and archive-fill-state can walk a 25MB archive before it
       replies, so sendMessage resolves undefined. Painting that as zero hid
       this row for the life of the popup — start a download, close the popup,
       reopen, and the button was gone. Leave the row as it was and retry. */
    if (!state) return;
    const left = state.total || 0;
    const running = !!(state.running || state.resuming);

    const done = state.done || 0;
    const stopping = !!state.stopping;

    /* Withdrawn, not removed. `hidden` would collapse this row's third column,
       the title and sub-line would rewrap into the space, and a sub-line that
       rewraps changes the row's height — the one thing this panel must never do
       while somebody is reaching for it. */
    const choose = $("fill-choose");
    const offerChoice = !!(left && !running && !stopping);
    if (choose) {
      choose.hidden = false;
      choose.classList.toggle("is-off", !offerChoice);
      choose.tabIndex = offerChoice ? 0 : -1;
      choose.setAttribute("aria-hidden", offerChoice ? "false" : "true");
    }
    if (!left && !running && !stopping) {
      showRows([[row, true]]);
      hideBar();
      return;
    }
    showRows([[row, false]]);

    /* Asked to stop, and the last fetch is still unwinding. This state is the
       whole reason the row used to read as broken: it went on saying "tap to
       stop" after the tap, so the click looked like it had done nothing. */
    if (stopping) {
      row.classList.add("busy", "stopping");
      row.classList.remove("stalled");
      setLine(title, "Stopping…");
      setLine(sub, "Finishing the one already in flight. Nothing else will be fetched.");
      paintBar(done, done + left);
      return;
    }
    row.classList.remove("stopping");

    if (running) {
      const total = done + left;
      // The count belongs in the title: it is the thing being watched, and a
      // sub-line is where the eye goes last.
      setLine(title, `Adding text · ${done.toLocaleString()} of ${total.toLocaleString()} chats`);
      setLine(sub, state.running
        ? `${savedMessageLabel()} · tap to stop.`
        : `${savedMessageLabel()} · the browser will continue.`);
      row.classList.add("busy");
      paintBar(done, total);
      return;
    }
    row.classList.remove("busy");
    hideBar();
    setLine(title, `${left.toLocaleString()} chat${left === 1 ? "" : "s"} need message text`);
    /* The worker already worked out why it stopped, and it stopped PER
       PROVIDER — six download at once, so one platform refusing is not the run
       failing. Its own sentence carries its own remedy (fillWhy in bg/fill.js);
       this row used to append "Sign in, then tap to continue" to whatever it
       said, which told somebody being rate-limited to sign in to an account
       they were already signed into. Say what it said, and say how many. */
    const notes = state && state.notes && typeof state.notes === "object"
      ? Object.values(state.notes).filter(Boolean)
      : (state && state.note ? [String(state.note)] : []);
    if (notes.length) {
      setLine(sub, notes.length === 1 ? notes[0] : `${notes[0]} (+${notes.length - 1} more)`);
      row.classList.add("stalled");
      return;
    }
    row.classList.remove("stalled");
    if (state && state.failed) {
      setLine(sub, "Some chats are waiting for another pass. Tvara will continue automatically.");
      return;
    }
    /* An UPPER bound, and stated as one.
       The queue runs every provider at once and several chats at a time within
       each, so the wall-clock figure is the slowest single host's share of the
       work, not the sum of it. What is left is the paced interval the host has
       earned — half a second at the floor — plus the write. The old figure of
       1.5s each was measured when this ran one chat at a time with a second
       sleep on top, and it now overstates the wait by more than double. */
    const mins = Math.max(1, Math.round((left * 0.7) / 60));
    /* What it is FOR, in the reader's terms. "Download" was the wrong verb in
       the wrong place: this fills the archive, and the thing people came here
       looking for under that word is the backup file, one row below. */
    setLine(sub, `${savedMessageLabel()} · these title-only chats become searchable after this pass. About ${mins} min.`);
  }

  /* Set when we have asked the worker to start and have not yet seen it say so.
     ensureStubIndex() can walk a 25MB archive before `running` flips, and the
     single probe at +400ms landed inside that window: the chain never armed and
     the row read "Download the text of 2,300 chats" for the life of the popup
     while the download was in fact running. */
  let fillExpected = 0;

  let fillTries = 0;

  async function refreshFill() {
    const state = await send({ type: "archive-fill-state" });
    paintFill(state);
    clearTimeout(fillTimer);
    /* A cold worker's first reply is the one that gets dropped. Ask again,
       backing off, instead of leaving the row on nothing. */
    if (!state) {
      if (fillTries++ < 6) fillTimer = setTimeout(refreshFill, 600 * fillTries);
      return;
    }
    fillTries = 0;
    const waitingToStart = fillExpected && Date.now() < fillExpected;
    if (state.running) fillExpected = 0;
    /* Poll while it is working, while it is unwinding a stop, or while we are
       waiting for it to admit it started. Stopping has to be polled too, or the
       row would sit on "Stopping…" until the popup was reopened. */
    if (state.running || state.resuming || state.stopping || waitingToStart) {
      fillTimer = setTimeout(refreshFill, state.stopping ? 600 : 1200);
    }
  }

  /* The row is not a button element, so nothing disabled it: two clicks 150ms
     apart both asked the worker what it was doing, both were told "not
     running", and both asked it to start — or the second overtook the first and
     silently STOPPED the download the user had just asked for. The decision is
     made once, and the row ignores clicks until it has landed. */
  let fillBusy = false;

  $("fill-archive").addEventListener("click", async () => {
    if (fillBusy) return;
    fillBusy = true;
    $("fill-archive").classList.add("pending");
    try {
      const state = await send({ type: "archive-fill-state" });
      // Already unwinding a stop: the click has nothing left to ask for, and
      // asking again would read as a second control the row does not have.
      if (state && state.stopping) return;
      // Stopping a reclaimed run means clearing its watchdog, not just its loop.
      const stopping = !!(state && (state.running || state.resuming));
      await send({ type: stopping ? "archive-fill-stop" : "archive-fill-start" });
      // Paint the decision now rather than at the next poll: a control that
      // waits a second before admitting it heard you reads as a dead control.
      if (stopping) paintFill({ ...state, running: false, stopping: true });
      // Give the worker a window to admit it started before we stop polling.
      fillExpected = stopping ? 0 : Date.now() + 30000;
    } finally {
      fillBusy = false;
      $("fill-archive").classList.remove("pending");
    }
    setTimeout(refreshFill, 400);
  });

  /* ---------- the backup file ----------
     A different thing from the queue above, and the reason to say so in a
     different verb: that one fills the archive IN this browser, this one writes
     a copy OUT of it. It lived only on the Recall page, which is why the
     question "where do I set the password" had no answer in the popup — the
     row is the answer, and it opens the panel that owns it. */
  function paintBackup(auto, durable) {
    const button = $("backup-archive");
    if (!button) return;
    const marker = (durable && durable.marker) || null;
    button.classList.remove("needs-attention");
    button.textContent = "Back up";
    button.title = "Create an encrypted backup file";
    button.setAttribute("aria-label", "Back up your archive as an encrypted file");
    if (auto && auto.lastError) {
      button.classList.add("needs-attention");
      button.textContent = "Review backup";
      button.title = "Automatic backup needs attention";
      button.setAttribute("aria-label", "Review automatic backup issue");
      return;
    }
    if (auto && auto.awaitingKey) {
      button.classList.add("needs-attention");
      button.textContent = "Finish backup";
      button.title = "Enter the backup password to resume automatic backups";
      button.setAttribute("aria-label", "Finish setting up automatic backups");
      return;
    }
    if (auto && auto.enabled) {
      button.title = auto.lastAt
        ? `Automatic backup last ran ${agoLabel(auto.lastAt)}`
        : "Automatic backups are on";
      return;
    }
    if (marker && marker.createdAt) {
      button.title = `Last backup ${agoLabel(marker.createdAt)}`;
    }
  }

  async function refreshBackup() {
    const [auto, durable] = await Promise.all([
      send({ type: "recall-autobackup-state" }),
      send({ type: "recall-backup-state" })
    ]);
    paintBackup(auto, durable);
  }

  $("fill-choose").addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/fetch.html") });
    window.close();
  });

  $("backup-archive").addEventListener("click", () => {
    // Straight to the panel that owns the password, not the top of the page.
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/archive.html#backup-panel") });
    window.close();
  });
  refreshBackup();

  /* Opening the popup is not what starts the download — it starts itself, on
     install and after every sync pass. This only covers the case where nothing
     woke it; the worker declines on a queue the user stopped, and on an empty
     one. */
  send({ type: "archive-fill-auto", reason: "popup" }).then((res) => {
    if (res && res.status === "started") fillExpected = Date.now() + 30000;
  }).catch(() => {}).then(refreshFill);

  /* The allowance figures are only worth trusting if they can be checked, so the
     check is one click from the number itself. stopPropagation because the link
     sits inside the toggle's own <label> — without it, opening the page would
     also flip the switch. */
  $("quota-warn-link").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();     // the link lives inside the toggle's own <label>
    const next = !warnOn();
    paintWarnLink({ quotaWarn: next });
    await saveSettings();
  });

  $("quota-diag-link").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.tabs.create({ url: chrome.runtime.getURL("diag/quota.html") });
  });

  /* ---------- trial ---------- */

  // The worker owns the clock and refuses a second trial per identity.
  $("trial-start").addEventListener("click", async () => {
    /* An unverified week runs its seven days and unlocks nothing, so sending
       someone into one without saying so would be a trial that silently does
       not work. Sign in first. */
    if (!identityVerified) {
      const gbtn = $("identity-google");
      identityMsg(gbtn.hidden
        ? "The trial needs Chrome or Edge — Google sign-in cannot work in this browser."
        : "Sign in with Google first — it is what keeps your trial when you reinstall.", "warn");
      if (!gbtn.hidden) gbtn.focus();
      return;
    }
    const t = await send({ type: "trial-start" });
    /* The worker refuses an unanchored week outright. This popup can be holding
       a "signed in" from before a sign-out in another tab, so the refusal is
       answered here rather than assumed impossible. */
    if (t && t.branch === "unverified") {
      identityVerified = false;
      identityMsg("Sign in with Google first \u2014 it is what keeps your trial when you reinstall.", "warn");
      const g = $("identity-google");
      if (!g.hidden) g.focus();
      return;
    }
    // Same rule as the verdict paint above: a week that grants nothing is not
    // a trial as far as this UI is concerned.
    const until = (t && t.grants && t.until) || 0;
    planGen++;   // same race as activation: a load() in flight predates the trial
    paintPlan(false, null, until);
    saveCache({ trialUntil: until });
  });

  /* ---------- identity ----------
     The address is the anchor: the trial ledger and licence ownership hang off
     it, so reinstalling — or moving to another browser — brings both back. The
     extension never stores the address, only the token the issuer returns. */

  function identityMsg(text, cls = "") {
    const el = $("identity-status");
    el.textContent = text || "";
    el.className = cls;
  }

  function paintIdentity(state) {
    identityVerified = !!(state && state.verified);
    const google = !!(state && state.google);
    accountProfile = (state && state.profile) || null;
    saveCache({ profile: accountProfile });
    paintAccount();
    /* Cached so the next open paints the device entry during parse instead of
       popping it in a round trip later. */
    devicesAccount = identityVerified;
    googleReady = google;
    saveCache({ identity: identityVerified, noGoogle: !google });
    paintDevicesEntries();
    paintTrialBuy();
    /* Three full-width buttons of equal weight is what the card looked like:
       one decision, asked three times. While the sign-in is still the step in
       front of the other two, it is the only filled one. */
    $("pro-upsell").classList.toggle("needs-signin", !identityVerified && google);
    $("identity").hidden = false;
    $("identity-done").hidden = !identityVerified;
    // Every repaint lands on the links, never mid-confirm — a confirm asked
    // once should not still be standing after whatever caused this repaint.
    $("identity-signout-confirm").hidden = true;
    $("identity-links").hidden = false;
    // Firefox cannot register a redirect URL, so the button is absent there
    // rather than present and broken. bg.js decides; this only paints.
    $("identity-google").hidden = identityVerified || !google;
    // Sign-in is the only route now, so a browser that cannot do it needs a
    // reason on screen. An empty card reads as a bug.
    $("identity-nogoogle").hidden = identityVerified || google;
    /* Shown only when it is carrying something the button below does not.
       Signed OUT, "Sign in once — it follows your account" sat directly above a
       button reading "Continue with Google": a line of prose explaining the
       control under it, in a panel that was overflowing its 600px cap. Signed
       IN there is no button, and the sentence is the confirmation. */
    const why = $("identity-why");
    why.hidden = !identityVerified;
    if (identityVerified) {
      why.textContent = "Signed in. Your trial and your purchase follow this account.";
    }
  }

  async function refreshIdentity() {
    try { paintIdentity(await send({ type: "identity-state" })); }
    catch { /* the worker will be awake by the next open */ }
  }

  /** Everything a fresh verification unlocked, in one line. */
  function paintSettled(settled) {
    if (settled && settled.restored) {
      identityMsg("Pro restored on this device.", "ok");
      planGen++;
      location.reload();
      return;
    }
    if (settled && settled.trial) {
      identityMsg("Verified \u2014 your trial is back where it was.", "ok");
      planGen++;
      location.reload();
      return;
    }
    identityMsg("Verified.", "ok");
  }

  /* The window Google opens is the slow part and nothing here can change that.
     What can change is everything BEFORE it: the service worker is reclaimed
     constantly, so a click on a cold worker pays for the whole worker starting
     before Chrome is even asked for the window. Reaching the button is the
     signal — a pointer landing on it, or it taking focus, is a hundred
     milliseconds of warning, and that is enough to wake the worker and mint
     the nonce. Fire and forget, and never more than once every few seconds. */
  let warmedAt = 0;
  const warmSignIn = () => {
    if (Date.now() - warmedAt < 4000) return;
    warmedAt = Date.now();
    send({ type: "identity-google-prepare" }).catch(() => {});
  };
  $("identity-google").addEventListener("pointerenter", warmSignIn);
  $("identity-google").addEventListener("pointerdown", warmSignIn);
  $("identity-google").addEventListener("focus", warmSignIn);

  $("identity-google").addEventListener("click", async () => {
    const button = $("identity-google");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Opening Google\u2026";
    identityMsg("");
    const res = await send({ type: "identity-google" });
    button.disabled = false;
    button.textContent = label;
    if (!res || res.branch !== "ok") {
      identityMsg(res && res.branch === "cancelled"
        ? "Sign-in cancelled." : "Google sign-in did not complete. Try again in a moment.", "warn");
      return;
    }
    await refreshIdentity();
    paintSettled(res.settled);
  });

  $("identity-restore").addEventListener("click", async () => {
    identityMsg("Looking for your purchase\u2026");
    const res = await send({ type: "identity-restore" });
    if (res && res.ok && res.restored) { planGen++; location.reload(); return; }
    identityMsg(res && res.ok
      ? "No purchase found for this account."
      : "Could not check right now. Try again in a minute.", res && res.ok ? "" : "warn");
  });

  /* "Use a different account" asks once before it acts — it does sign the
     browser out, even though it deliberately leaves the licence and any spent
     trial untouched. Swaps the two links for a Sign out / Cancel pair in the
     same spot rather than opening anything new. */
  $("identity-signout").addEventListener("click", () => {
    $("identity-links").hidden = true;
    $("identity-signout-confirm").hidden = false;
  });
  $("identity-signout-no").addEventListener("click", () => {
    $("identity-signout-confirm").hidden = true;
    $("identity-links").hidden = false;
  });
  $("identity-signout-yes").addEventListener("click", async () => {
    $("identity-signout-confirm").hidden = true;
    paintIdentity(await send({ type: "identity-signout" }));
    identityMsg("");
  });

  refreshIdentity();

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
      note: "Your key is fine. Try again in a minute."
    },
    badrequest: {
      text: "The licence server refused that request.", cls: "warn",
      note: "Your key is fine. Try again, and contact support if it persists."
    },
    network: {
      text: "Couldn't reach the licence server.", cls: "warn",
      note: "Nothing is wrong with your key. Try again when you're back online."
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
        note: "Copy it again from your purchase email. Nothing was sent anywhere."
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
      const ent = await self.LCTEntitlement.refresh(record, res.deviceId,
        { force: true, activate: true });
      // The token is settled now, either way. Any load() still waiting on a
      // verdict fetched before this point is stale — see the guard in load().
      planGen++;
      if (!ent.ok) {
        /* The seat is already claimed by the time we get here, so everyone who
           sees one of these has paid AND been charged. "Didn't answer" used to
           cover all of them, including two that are not outages at all and that
           the user can fix in under a minute if told which. It stays the
           fallback; it is no longer the only answer. */
        const ENT_FAIL = {
          clockskew: {
            text: "Your device's clock is too far out to verify the licence.", cls: "err",
            note: "Set date and time to update automatically, then press Activate again. Your purchase is fine."
          },
          nodevice: {
            text: "This browser profile won't let Tvara create its device key.", cls: "err",
            note: "Storage may be blocked or the profile damaged. Try a normal window or another profile."
          },
          outdated: {
            text: "This copy of Tvara is older than the licence server.", cls: "err",
            note: "Update Tvara from the Chrome Web Store, then press Activate again."
          },
          proof: {
            text: "The licence server didn't accept this device.", cls: "err",
            note: "Press Activate again. If it keeps happening, email support with your key."
          },
          throttled: {
            text: "Too many attempts just now.", cls: "warn",
            note: "Wait a minute and press Activate again. Nothing is wrong with your purchase."
          }
        };
        paintLicenseState(ent.revoked
          ? { text: "That licence is not active.", cls: "err",
              note: "The payment provider does not recognise it. Contact support with your order id." }
          : ENT_FAIL[ent.branch] ||
            { text: "Activated, but the entitlement server didn't answer.", cls: "warn",
              note: "Pro unlocks by itself once you're back online. Nothing to redo." });
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
    const shown = id === selfId ? (dmSelfName || dmSelfPlat || seat.label) : seat.label;
    name.textContent = id === selfId ? shown + " (this device)" : shown;
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
      : `This licence works on ${self.LCTDodo.SEAT_LIMIT} devices. Release one any time; you can always activate it again.`;
    $("license-retry-activate").hidden = mode !== "limit";
  }

  /* ---------- the account's devices ----------
     The list above is this browser's own registry, kept in chrome.storage.sync
     and therefore blind to a device signed into another profile. This one is
     the issuer's, which is the copy that decides — so it can show a machine
     this browser has never heard of, and sign it out. */

  let dmVersion = 0;
  let dmDevices = [];
  /* What this machine calls itself, computed HERE rather than read back from
     the issuer: a row that has never checked in still has to say something
     true, and "Unknown device" about the machine you are holding is the bug
     this screen was reported for. */
  let dmSelfPlat = "";
  let dmSelfName = "";
  let dmRenaming = false;
  let dmPicked = new Set();
  let dmOpId = "";
  let dmPending = "";
  let dmPendingIds = [];

  /* One key per user action, reused across retries of THAT action. A retry
     that mints a fresh one is a second sign-out, which is the bug the issuer's
     op ledger exists to make impossible. */
  const newOpId = () => [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  function seenWhen(ms) {
    if (!ms) return "never used";
    const age = Date.now() - ms;
    if (age < 6 * 60e3) return "active now";
    if (age < 36e5) return Math.round(age / 60e3) + " min ago";
    if (age < 864e5) return Math.round(age / 36e5) + "h ago";
    return "last active " + new Date(ms).toLocaleDateString();
  }

  function sessionRow(d) {
    const row = document.createElement("div");
    row.className = "device-row" + (d.self ? " is-self" : "") +
      (dmPicked.has(d.device) ? " picked" : "");
    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.className = "device-pick";
    pick.checked = dmPicked.has(d.device);
    pick.setAttribute("aria-label", "Select " + deviceTitle(d));
    // A row the issuer has no id for. Sign out would have nothing to send.
    if (d.local) { pick.disabled = true; pick.setAttribute("aria-label", "Not registered yet \u2014 nothing to sign out."); }
    /* Only this row and the buttons. Re-rendering the whole list on a tick
       throws away the checkbox the person is still on — it detaches the very
       element they clicked, which loses focus and breaks a keyboard pass down
       the list. */
    pick.addEventListener("change", () => {
      if (pick.checked) dmPicked.add(d.device); else dmPicked.delete(d.device);
      row.classList.toggle("picked", pick.checked);
      syncActions();
    });
    const text = document.createElement("span");
    text.className = "device-text";
    /* The name IS the rename control, and only on this device's own row: the
       issuer keys a label on the dev_fp the request proved, so no device can
       name another one. */
    const name = document.createElement(d.self ? "button" : "span");
    name.className = "device-name" + (d.self ? " device-name-edit" : "");
    if (d.self) {
      name.type = "button";
      name.setAttribute("aria-label", "Rename this device");
      name.addEventListener("click", () => startRename(row, d));
    }
    // textContent only: a label is written by another device — untrusted input.
    name.textContent = deviceTitle(d) + (d.self ? " (this device)" : "");
    const meta = document.createElement("span");
    meta.className = "device-meta";
    // The machine under the name. Dropped when it IS the name, so the row does
    // not print "Windows 11 · Chrome" twice.
    const machine = d.self ? (d.plat || dmSelfPlat) : d.plat;
    meta.textContent = [deviceTitle(d) === machine ? "" : machine, d.geo, seenWhen(d.lastSeen)]
      .filter(Boolean).join(" \u00b7 ");
    text.append(name, meta);
    row.append(pick, text);
    // Sign this one out without touching the checkboxes — a row action, so it
    // arms the same confirm step as the bulk button rather than acting at once.
    const out = document.createElement("button");
    out.type = "button";
    out.className = "ghost device-signout-one";
    out.textContent = "Sign out";
    if (d.local) { out.disabled = true; out.setAttribute("aria-label", "Not registered yet \u2014 nothing to sign out."); }
    else out.addEventListener("click", () => armConfirm("picked", [d.device]));
    row.append(out);
    return row;
  }

  /**
   * The machine in front of the person is always on this list.
   *
   * The issuer writes the row at sign-in, so `self` is normally already there.
   * When it is not — a sign-in that predates that write, a row swept by the
   * free-device cap, a list served from behind a stale edge — the honest thing
   * on screen is still this device, not "0 devices". It carries no id, because
   * an id is what a Sign out acts on and the issuer has no row to act on yet.
   *
   * Never called on the answer to a terminate: signing this device out is a
   * list that is CORRECTLY missing it, and re-adding it there would undo on
   * screen what the person just did.
   */
  function ensureSelfRow(devices) {
    const list = Array.isArray(devices) ? devices.slice() : [];
    if (list.some((d) => d && d.self)) return list;
    list.unshift({
      device: "", label: dmSelfName || "", plat: dmSelfPlat || "", geo: "",
      lastSeen: Date.now(), createdAt: Date.now(), pro: false, self: true, local: true
    });
    return list;
  }

  /** One answer for the name on a row, used by the row, its checkbox label and
   *  its meta line so the three can never disagree. */
  function deviceTitle(d) {
    const own = d.self ? (d.label || dmSelfName) : d.label;
    return own || d.plat || (d.self ? dmSelfPlat : "") || "Unknown device";
  }

  /** Rename this device, in place. */
  function startRename(row, d) {
    if (dmRenaming) return;
    dmRenaming = true;
    const form = document.createElement("form");
    form.className = "device-rename-row";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "device-rename-input";
    input.maxLength = self.LCTEntitlement.DEVICE_NAME_MAX;
    input.value = d.label || dmSelfName || "";
    input.placeholder = dmSelfPlat || "This device";
    input.setAttribute("aria-label", "Name for this device");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "device-rename-save";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "identity-link device-rename-cancel";
    cancel.textContent = "Cancel";
    const err = document.createElement("span");
    err.className = "device-rename-err";
    err.id = "device-rename-err";
    err.setAttribute("role", "status");
    form.append(input, save, cancel, err);
    row.replaceChildren(form);
    input.focus();
    input.select();
    cancel.addEventListener("click", () => { dmRenaming = false; renderSessions(); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      const res = await self.LCTEntitlement.setDeviceName(input.value);
      if (!res || !res.ok) {
        save.disabled = false;
        err.textContent = res && res.reason === "empty"
          ? "Give it a name first." : "Could not save that name.";
        input.focus();
        return;
      }
      dmSelfName = res.name;
      // Shown immediately, then overwritten by whatever the issuer confirms —
      // the local copy is what this device knows, not what the account holds.
      for (const dev of dmDevices) if (dev.self) dev.label = res.name;
      dmRenaming = false;
      /* The issuer learns a label on a session touch, and listing IS one. So
         re-list rather than patching the row and trusting the two to agree. */
      const listed = await self.LCTEntitlement.listSessions();
      if (listed && listed.branch === "ok" && listed.data && Array.isArray(listed.data.devices)) {
        dmVersion = Number(listed.data.version) || dmVersion;
        dmDevices = ensureSelfRow(listed.data.devices);
        renderSessions("Renamed. Every device on the account sees it.");
        return;
      }
      // Saved here, not confirmed there. Saying "renamed" would promise the
      // other devices something that has not happened yet.
      renderSessions("Saved on this device. The others see it at its next check-in.");
    });
  }

  function syncActions() {
    $("device-signout").disabled = !dmPicked.size;
    $("device-signout").textContent = dmPicked.size ? `Sign out (${dmPicked.size})` : "Sign out";
    $("device-signout-all").hidden = dmDevices.length < 2;
  }

  function renderSessions(note) {
    $("device-list").replaceChildren(...dmDevices.map(sessionRow));
    // "of 5" is a seat cap. A trial device holds no seat, so counting it
    // against one states a limit that is not being applied to them.
    $("device-count").textContent = devicesPro
      ? `${dmDevices.length} of ${self.LCTDodo.SEAT_LIMIT}`
      : `${dmDevices.length} device${dmDevices.length === 1 ? "" : "s"}`;
    $("device-manager-title").textContent = "Your devices";
    $("device-manager-note").textContent = note ||
      "Every device signed in to your account. Pick any, then sign them out.";
    // A trial holds no seat, so the seat-recovery link is the wrong question.
    $("device-help-link").textContent = devicesPro
      ? "Slots held by a device you no longer have?"
      : "See a device you don't recognise?";
    $("device-actions").hidden = false;
    $("device-confirm").hidden = true;
    syncActions();
  }

  /* Click one. The second is the Confirm button below — signing a machine out
     is not something to do on a mis-tap, and it is not undoable from here. */
  function armConfirm(kind, ids) {
    dmPending = kind;
    // Frozen here, not read from dmPicked at confirm time: a row button acts on
    // its own device, and the checkboxes must survive it untouched.
    dmPendingIds = kind === "all" ? [] : (ids || [...dmPicked]);
    dmOpId = newOpId();
    const others = dmDevices.filter((d) => !d.self).length;
    const n = kind === "all" ? others : dmPendingIds.length;
    const self1 = kind !== "all" && dmPendingIds.includes((dmDevices.find((d) => d.self) || {}).device);
    $("device-confirm-text").textContent =
      `Sign out ${n} device${n === 1 ? "" : "s"}? ` +
      (self1 ? "That includes this one, so Pro stops here too."
             : "They lose Pro until they are activated again. Their archives stay where they are.");
    $("device-confirm").hidden = false;
    $("device-actions").hidden = true;
  }

  async function runTerminate() {
    const yes = $("device-confirm-yes");
    yes.disabled = true;
    yes.textContent = "Signing out\u2026";
    const opts = { opId: dmOpId, ifVersion: dmVersion };
    const picked = dmPendingIds;
    const res = dmPending === "all"
      ? await self.LCTEntitlement.terminateAllSessions(opts)
      : await self.LCTEntitlement.terminateSessions(picked, opts);
    yes.disabled = false;
    yes.textContent = "Sign out";

    /* The list moved while they were deciding — another device signed one out,
       or this popup was open a long time. Show what is actually there rather
       than acting on what was. */
    if (res.branch === "stale" && res.data) {
      dmVersion = Number(res.data.version) || 0;
      dmDevices = Array.isArray(res.data.devices) ? res.data.devices : dmDevices;
      const live = new Set(dmDevices.map((d) => d.device));
      dmPicked = new Set([...dmPicked].filter((id) => live.has(id)));
      dmPendingIds = dmPendingIds.filter((id) => live.has(id));
      renderSessions("This list changed on another device. Here it is again — check it and sign out.");
      return;
    }
    if (res.branch === "reauth") {
      renderSessions("Sign in again first. Signing out every device asks for a fresh sign-in, so a token left in an old profile cannot do it.");
      return;
    }
    if (res.branch === "unverified") {
      renderSessions("Sign in to manage the devices on your account.");
      return;
    }
    if (res.branch !== "ok" || !res.data) {
      renderSessions("Couldn't reach the licence server. Nothing changed, so try again when you're back online.");
      return;
    }

    const gone = Array.isArray(res.data.terminated) ? res.data.terminated : [];
    dmVersion = Number(res.data.version) || dmVersion;
    dmDevices = Array.isArray(res.data.devices) ? res.data.devices : [];
    dmPicked = new Set();

    /* Signing out the device you are standing on gives up Pro here, exactly
       like the per-device Release does. */
    const selfFp = await self.LCTEntitlement.deviceFpFor(await self.LCTDodo.ensureDeviceId());
    if (gone.includes(selfFp)) {
      await chrome.storage.local.remove(["license", "lct-license-state-v1"]);
      paintPlan(false, null, (cache && cache.trialUntil) || 0);
      saveCache({ pro: false, masked: null, licenseKind: null, seatCount: 0 });
    }
    renderSessions(gone.length
      ? `Signed out ${gone.length} device${gone.length === 1 ? "" : "s"}.`
      : "Nothing to sign out.");
    saveCache({ seatCount: dmDevices.length });
  }


  /* Somebody signed a device out somewhere else while this list is on screen.
     The worker hears it on the account socket and forwards it here; without
     this the popup goes on offering Sign out on a row that has already gone,
     and the click comes back 412 "stale" for no reason the user can see.

     Registered once. The message carries no device fingerprints — it says only
     that the list moved — so the list is re-read rather than patched. */
  let dmWatching = false;
  function watchSessionChanges() {
    if (dmWatching) return;
    dmWatching = true;
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== "sessions-changed") return;
        if ($("device-manager").hidden) return;
        self.LCTEntitlement.listSessions().then((res) => {
          if (!res || res.branch !== "ok" || !res.data || !Array.isArray(res.data.devices)) return;
          dmVersion = Number(res.data.version) || dmVersion;
          dmDevices = ensureSelfRow(res.data.devices);
          dmPicked = new Set();
          renderSessions("This list just changed on another device.");
        }).catch(() => { /* the next open re-reads it */ });
      });
    } catch { /* no runtime messaging: the list is still correct when reopened */ }
  }

  async function openDeviceManager(mode, unknownDevices) {
    dmRenaming = false;
    [dmSelfPlat, dmSelfName] = await Promise.all([
      self.LCTEntitlement.describePlatform(), self.LCTEntitlement.currentDeviceName()
    ]);
    watchSessionChanges();
    document.body.classList.add("dm-open");
    $("device-manager").hidden = false;
    $("device-confirm").hidden = true;

    const res = await self.LCTEntitlement.listSessions();
    if (res && res.branch === "ok" && res.data && Array.isArray(res.data.devices)) {
      dmVersion = Number(res.data.version) || 0;
      dmDevices = ensureSelfRow(res.data.devices);
      dmPicked = new Set();
      renderSessions(mode === "limit"
        ? "All slots are in use. Sign one out here to finish activating on this device." : "");
      $("license-retry-activate").hidden = mode !== "limit";
      return;
    }

    /* No verified identity, or the issuer is unreachable. Fall back to the
       registry screen: it only knows devices from this browser, and it says so
       rather than presenting a short list as if it were the whole account. */
    const [reg, selfId] = await Promise.all([
      self.LCTDodo.readSeats(), self.LCTDodo.ensureDeviceId()
    ]);
    $("device-actions").hidden = true;
    renderDevices(reg, selfId, mode, unknownDevices);
    if (res && res.branch === "unverified") {
      $("device-manager-note").textContent =
        "Sign in to see every device on your account. This list is only the ones this browser knows about.";
    } else if (res && res.branch === "notenrolled") {
      // SESSION_SCOPE = "paid" on the issuer. Not an error, and not something
      // to retry — say what it takes to get the list.
      $("device-manager-note").textContent =
        "The device list comes with Pro. This is only what this browser knows about.";
    }
  }

  function closeDeviceManager() {
    document.body.classList.remove("dm-open");
    $("device-manager").hidden = true;
    $("device-confirm").hidden = true;
    dmPicked = new Set();
    dmPending = "";
    dmPendingIds = [];
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
        "Couldn't reach the licence server. Nothing changed, so try again when you're back online.";
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
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/recall.html") });
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
  /* Layout is fractional and this measurement feeds back into the thing being
     measured — size the list, the body grows, the room was computed against the
     old height. Landing within a pixel of the ceiling therefore sometimes lands
     a pixel over it, which is a scrollbar the whole design exists to avoid.
     Two pixels of slack costs nothing anyone can see. */
  const POPUP_GUARD = 6;
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
    const asIs = POPUP_CEILING - POPUP_GUARD - document.body.getBoundingClientRect().height;
    // The rows below only give up their room when the list actually needs it. A
    // single hit asking the whole panel to clear out would shrink the popup for
    // nothing, so a list that already fits is simply left where it is.
    const borrow = want > asIs;
    document.body.classList.toggle("searching", borrow);
    const room = borrow ? POPUP_CEILING - POPUP_GUARD - document.body.getBoundingClientRect().height : asIs;
    let px = Math.max(RECALL_MIN_ROOM, Math.floor(room));
    box.style.setProperty("--recall-room", `${px}px`);

    /* Then CHECK, rather than trust the arithmetic. Predicting this height is a
       feedback loop — sizing the list changes the body it was measured against
       — and every fudge factor added to the prediction was another number that
       happened to work on one machine. Two correction passes settle it on any
       of them: measure the overflow that actually happened and give back
       exactly that many pixels. */
    const settle = () => {
      for (let pass = 0; pass < 2; pass++) {
        const over = document.body.scrollHeight - document.body.clientHeight;
        if (over <= 0 || px <= RECALL_MIN_ROOM) break;
        px = Math.max(RECALL_MIN_ROOM, px - over - 1);
        box.style.setProperty("--recall-room", `${px}px`);
      }
    };
    settle();
    /* Again after a frame. The rows are still being laid out when the first
       pass runs, so the overflow it measures can be zero and then grow — which
       is exactly how a correction loop convinces itself it has converged. */
    requestAnimationFrame(settle);
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
      // Same guard as pages/pages.js: refuse to navigate rather than drop
      // the record — the click just does nothing for an unrecognised host.
      // Host and path resolved together — see chatUrl() in lib/product.js.
      const url = self.LCTProduct.chatUrl(res.host, res.path);
      if (!url) return;
      const q = $("recall-query").value.trim();
      await chrome.storage.local.set({
        "recall-jump": { host: res.host, path: res.path, q, at: Date.now() }
      });
      chrome.tabs.create({ url });
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
    const res = await send({ type: "recall-search", q });
    $("recall-results").removeAttribute("aria-busy");
    /* The allowance ran out. Say what it was rather than what is missing:
       they have just seen this work on their own conversations three times,
       so the sentence can point at that instead of describing a feature. */
    if (res && res.err === "locked") {
      tasteSpent = true;
      $("recall-results").replaceChildren();
      sizeRecallResults(false);
      $("recall-query-meta").textContent = "";
      $("recall-locked").textContent =
        "That was your own archive. Start the 7-day trial, or unlock it for good below.";
      paintRecallAccess(false);
      return;
    }
    if (!res || res.err || q !== $("recall-query").value.trim()) return;
    const results = res.results || [];
    // Every match the archive returned, not a preview of the top two: the count
    // beside the box and the list under it now say the same thing, and anything
    // past the visible edge is a scroll away. Back to the top on each new query
    // — a refined search that lands you halfway down its own results is a bug.
    $("recall-results").replaceChildren(...results.map(recallResult));
    $("recall-results").scrollTop = 0;
    sizeRecallResults(results.length > 0);
    const found = results.length
      ? `${results.length} chat${results.length === 1 ? "" : "s"}`
      : "no matches";
    /* A free search says so, and says how many are left, because a taste
       nobody knows is a taste reads as the product simply being free. */
    const t = res.taste;
    $("recall-query-meta").textContent = t
      ? `${found} · ${t.left} free search${t.left === 1 ? "" : "es"} left`
      : found;
    if (t) {
      $("recall-locked").textContent = results.length
        ? `Those are your own conversations, searched on this device. ${t.left} free ${t.left === 1 ? "search" : "searches"} left.`
        : `Searched archived chats on this device. ${t.left} free ${t.left === 1 ? "search" : "searches"} left.`;
      $("recall-locked").hidden = false;
    }
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

  /* ---------- where am I, and can I be shown around ----------
     tab.url is only readable for a tab we hold a host permission on, which is
     exactly the set of chat sites — so an undefined url IS the answer, and no
     "tabs" permission is needed to get it. */
  const activeChatTab = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return null;
      return KNOWN_CHAT_HOSTS.has(new URL(tab.url).hostname) ? tab : null;
    } catch { return null; }
  };


  /* ---------- popup tour ---------- */

  /* One card per control, not one per group. The rows ARE the settings — a
     card covering three switches at once is how "Archive" and "Load full
     history on open" went unexplained: named in a sentence about something
     else, anchored to a neighbour. */
  const ALL_POPUP_STEPS = [
    {
      id: "plan",
      // The pill it used to point at is visually hidden now; the ring around
      // the account circle is what says which plan is running.
      anchor: () => $("account-ring"),
      title: "Your plan, around your face",
      body: "Free, Trial or Pro — the ring around your account circle says which: dim, dashed amber, or solid ember. Everything in a chat page is free; the archive search and the tools built on it are Pro, after a 7-day trial that needs no card."
    },
    {
      id: "pulse",
      anchor: () => document.querySelector(".pulse"),
      title: "Proof the engine is working",
      body: "The number is how many messages are asleep in the chat you have open right now. They are not deleted and not removed from your archive — they wake the moment you scroll back to them."
    },
    {
      id: "usage",
      anchor: () => $("usage-bars"),
      title: "What each account has left",
      body: "One reading per platform you are signed into, taken from the figure that platform's own responses carry. A provider that publishes nothing is shown as not reported rather than estimated."
    },
    {
      id: "settings",
      anchor: () => $("toggle-enabled")?.closest(".row"),
      title: "Speed engine",
      body: "Puts off-screen messages to sleep so the browser stops paying for what you cannot see, keeping huge chats fast. A screen and a half either side of your view stays awake, so scrolling never shows a blank. Off means the page behaves exactly as the site built it."
    },
    {
      id: "minimap",
      anchor: () => $("toggle-minimap")?.closest(".row"),
      title: "Minimap",
      body: "The thin strip on the right edge of a chat: one bar per message, hover for a preview, click to jump anywhere in the conversation. Its toolbar is where the outline, search, backups and the Pro tools live, so turning this off takes those with it."
    },
    {
      id: "times",
      anchor: () => $("toggle-time")?.closest(".row"),
      title: "Timestamps",
      body: "Hover a message to see when it was said. On ChatGPT that is the real send time. Everywhere else a browser was never told, so it says first seen on this device — and a first-seen time is never presented as a send time."
    },
    {
      id: "history",
      anchor: () => $("toggle-history")?.closest(".row"),
      title: "Load full history on open",
      body: "Puts every older message back on the page, which is what the site's own Ctrl+F needs. It reads them from the copy already on this machine — the same one the archive and the map come from — and renders them above the conversation. Nothing is scrolled and the page never moves. Off is fine: the map is complete either way."
    },
    {
      id: "temp",
      anchor: () => $("toggle-temp")?.closest(".row"),
      title: "Archive temporary chats",
      body: "A temporary or signed-out chat is you telling that platform not to keep it, so this is off by default. On, those chats are archived here too, labelled temporary, with a badge on the page the whole time one is being archived — never silently."
    },
    {
      id: "quota",
      anchor: () => $("toggle-quota")?.closest(".row"),
      title: "Allowance tracking",
      body: "Warns you at 20% and again at 10% instead of letting the site cut you off. Warn at 20% changes that threshold; accuracy shows what the last reading was taken from. Switched off, the reader disables itself entirely."
    },
    {
      id: "archive",
      anchor: () => $("open-recall")?.closest(".row"),
      title: "Total Recall",
      body: "One search box across chats archived on supported sites. Type here for the quick answer, or open the full page for the archive itself — deletions, encrypted backups and what has been downloaded so far."
    },
    {
      id: "deletions",
      anchor: () => $("deletion-alert"),
      title: "Chats deleted on the site",
      body: "Deleted there is not deleted here. When a chat you had archived disappears from the provider, this appears and you decide what to keep. Nothing is removed without your answer."
    },
    {
      id: "core",
      anchor: () => $("sync-history")?.closest(".row"),
      title: "Archive",
      body: "The archive keeping itself current: it checks for new chats roughly every three hours and when you open a chat site, and writes only what is missing. The line under it is what has been saved, what is left, and how far the current pass has got — it resumes by itself after a browser restart."
    },
    {
      id: "fill",
      anchor: () => $("fill-archive"),
      title: "Make chats searchable",
      body: "A listing gives up every title in one request; message text takes one request per chat. This adds the text Total Recall needs to search inside those chats, and shows its progress."
    },
    {
      id: "backup",
      anchor: () => $("backup-archive"),
      title: "Back up your archive",
      body: "Creates one encrypted file in Downloads that restores this archive after a reinstall or on another supported browser. Your chat data stays on your device. Keep the password safe: Tvara cannot recover it."
    },
    {
      id: "account",
      anchor: () => [$("pro-upsell"), $("trial-active"), $("pro-active")].find((el) => el && !el.hidden),
      title: "Your trial, and Pro",
      body: "Signing in is what lets a trial or a purchase follow you through a reinstall or onto another browser, rather than being stuck to this one. Pro is one payment, five devices, every future update — and if it ever ends, your archive stays here and stays exportable."
    },
    {
      id: "footer",
      anchor: () => $("shortcuts-link")?.closest("span") || $("shortcuts-link"),
      title: "The row along the bottom",
      body: "Shortcuts opens your browser's own key bindings, where every Tvara shortcut can be changed or reassigned. Health reports whether each site's adapter is running normally or degraded — that is what tells you a platform redesign broke something, rather than you finding out later."
    },
    {
      id: "chat",
      anchor: () => $("tour-link"),
      title: "Now let's see it working",
      body: "The rest of Tvara lives inside your chats, so the tour continues there — it will point at the real map, the buttons and the search as you go. Pick where you chat and we will open it for you.",
      chips: true
    }
  ];

  /* A card pointing at a row that is not on screen — no deletions to review,
     no archive left to fetch — teaches nothing and cannot be positioned. */
  const popupStepVisible = (step) => {
    const el = step.anchor();
    return !!(el && el.isConnected && !el.hidden && el.getClientRects().length);
  };
  let popupTourSteps = ALL_POPUP_STEPS;
  let popupTourAt = 0;

  function closePopupTour() {
    $("popup-tour").hidden = true;
  }

  function positionPopupTour() {
    const target = popupTourSteps[popupTourAt].anchor();
    const ring = $("popup-tour-ring");
    const card = document.querySelector(".popup-tour-card");
    if (!target || !target.isConnected) {
      ring.hidden = true;
      card.style.top = "12px";
      card.style.bottom = "auto";
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 4;
    ring.hidden = false;
    ring.style.left = `${Math.max(4, r.left - pad)}px`;
    ring.style.top = `${Math.max(4, r.top - pad)}px`;
    ring.style.width = `${Math.min(innerWidth - 8, r.width + pad * 2)}px`;
    ring.style.height = `${r.height + pad * 2}px`;
    const topHalf = r.top + r.height / 2 < innerHeight / 2;
    card.style.top = topHalf ? "auto" : "12px";
    card.style.bottom = topHalf ? "12px" : "auto";
  }

  function renderPopupTour() {
    const step = popupTourSteps[popupTourAt];
    $("popup-tour").hidden = false;
    $("popup-tour").dataset.step = step.id;
    $("popup-tour-count").textContent = `${popupTourAt + 1} of ${popupTourSteps.length}`;
    $("popup-tour-title").textContent = step.title;
    $("popup-tour-body").textContent = step.body;
    $("popup-tour-back").hidden = popupTourAt === 0;
    $("popup-tour-chips").hidden = !step.chips;
    $("popup-tour-next").textContent = popupTourAt === popupTourSteps.length - 1 ? "Continue in a chat" : "Next";
    positionPopupTour();
    requestAnimationFrame(positionPopupTour);
  }

  async function showChatTour() {
    try { await chrome.storage.local.remove("lct-tour-v1"); } catch { /* full or gone */ }
    const tab = await activeChatTab();
    if (!tab) return noChatYet();
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "lct-tour" });
      window.close();
    } catch {
      noChatYet();
    }
  }

  /* The walkthrough runs inside a chat page, so there has to be one. Said on
     the card that offered it — an instruction written into the statistics
     header above is an instruction nobody is looking at. */
  /* Arming before the tab opens, not after: the content script asks for this
     flag as it loads, and a write that lands afterwards is a write the page
     that needed it never saw. */
  async function openChatAndContinue(url) {
    try {
      await chrome.storage.local.remove("lct-tour-v1");
      await chrome.storage.local.set({ "lct-tour-armed-v1": Date.now() });
    } catch { /* storage full or gone — the tour is still reachable by hand */ }
    try { await chrome.tabs.create({ url }); } catch { /* managed browser */ }
    window.close();
  }

  for (const chip of document.querySelectorAll(".tour-chip")) {
    chip.addEventListener("click", () => openChatAndContinue(chip.dataset.url));
  }

  function noChatYet() {
    $("popup-tour-title").textContent = "Pick one and we will open it";
    $("popup-tour-body").textContent =
      "The rest of the tour runs inside a chat page, and there is not one open right now. Choose where you chat — the walkthrough starts by itself when the page loads.";
    $("popup-tour-chips").hidden = false;
    $("popup-tour-next").hidden = true;
  }

  $("popup-tour-skip").addEventListener("click", closePopupTour);
  $("popup-tour-back").addEventListener("click", () => {
    popupTourAt--;
    renderPopupTour();
  });
  $("popup-tour-next").addEventListener("click", () => {
    if (popupTourAt === popupTourSteps.length - 1) { showChatTour(); return; }
    popupTourAt++;
    renderPopupTour();
  });
  window.addEventListener("resize", positionPopupTour, { passive: true });

  // Starts in the window that owns the settings, then offers the in-chat tour
  // as its last step.
  $("tour-link").addEventListener("click", (e) => {
    popupTourSteps = ALL_POPUP_STEPS.filter(popupStepVisible);
    e.preventDefault();
    $("popup-tour-next").hidden = false;
    $("popup-tour-chips").hidden = true;
    popupTourAt = 0;
    renderPopupTour();
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

  /* ---------- buying ----------

     No payment link, no pricing page in the middle. The button asks the issuer
     to open a checkout session and the background opens it, owns the wait, and
     activates the licence when it lands. The popup is closed a second after the
     click and paying takes a minute, so nothing that matters can live here.

     A card is still typed in a full tab, not in a 380px panel — that part of
     the old comment was right and is unchanged.

     The paste box below stays. It is how a buyer moves their licence to a
     second machine, and how they recover if every webhook in one delivery
     window is lost. */
  const CHECKOUT_COPY = {
    unverified: {
      text: "Verify your email before buying.", cls: "warn",
      note: "It is what brings Pro back if you reinstall, without a key to find."
    },
    closed: {
      text: "The store isn't open yet.", cls: "warn",
      note: "Nothing to pay for right now — every free tool still works."
    },
    throttled: {
      text: "Too many checkouts started just now.", cls: "warn",
      note: "Wait a minute and press it again. Nothing was charged."
    },
    nodevice: {
      text: "This browser profile won't let Tvara create its device key.", cls: "err",
      note: "Storage may be blocked or the profile damaged. Try a normal window or another profile."
    },
    outdated: {
      text: "This copy of Tvara is older than the licence server.", cls: "err",
      note: "Update Tvara from the store, then try again."
    },
    network: {
      text: "Couldn't reach the licence server.", cls: "warn",
      note: "Nothing was charged. Try again when you're back online."
    }
  };
  // Everything else — service, proof, replay, badrequest, forbidden — is ours,
  // not the user's, and the only thing they need told is that no money moved.
  const CHECKOUT_FALLBACK = {
    text: "Couldn't open the checkout.", cls: "warn",
    note: "Nothing was charged. Try again in a minute."
  };

  /** Repaint after a licence arrives without the popup having typed anything. */
  async function paintProFromStorage() {
    const { license } = await chrome.storage.local.get("license");
    const masked = maskEmail((license && license.email) || "");
    planGen++;
    paintPlan(true, masked, (cache && cache.trialUntil) || 0);
    const seatCount = Object.keys((await self.LCTDodo.readSeats()).seats).length;
    saveCache({ pro: true, masked, licenseKind: (license && license.kind) || "dodo", seatCount });
  }

  /* ---------- buying ----------
     #buy-pro lives in the upsell card, hidden for the whole trial week — which
     is when people decide to pay. #trial-buy is the same purchase from the
     trial card. One path, so the sign-in gate and error copy cannot drift. */

  /** Trial card's own status line; the upsell's is off screen there. */
  function trialSay(text, cls = "") {
    const el = $("trial-buy-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "pro-note" + (cls ? " " + cls : "");
    el.hidden = !text;
  }

  function paintTrialBuy() {
    const btn = $("trial-buy");
    if (!btn) return;
    // An open order is not a second thing to buy — a second session is a
    // second chance to be charged.
    btn.disabled = checkoutPending;
    if (checkoutPending) btn.textContent = "Finishing…";
    else if (!devicesAccount) btn.textContent = self.LCTProduct.PRICE + " · sign in & buy";
    else btn.textContent = "Get Pro · " + self.LCTProduct.PRICE;
  }

  /**
   * Sign in if needed, then open the hosted checkout. Returns only on failure —
   * success closes the popup; the tab is open and the worker waits on it.
   *
   * @param {HTMLButtonElement} btn pressed button
   * @param {(text: string, cls?: string) => void} say status sink
   * @param {(copy: object) => void} [fail] renders a refusal with its note line
   */
  async function startPurchase(btn, say, fail) {
    if (!btn || btn.disabled) return;
    if (checkoutPending) {
      say("A purchase is already going through. Give it a moment.", "warn");
      return;
    }
    const label = btn.textContent;
    const done = (text, cls) => {
      btn.disabled = false;
      btn.textContent = label;
      if (text) say(text, cls);
      paintTrialBuy();
    };
    btn.disabled = true;

    /* The issuer refuses an anonymous checkout, and being told that after the
       round trip is worse than being asked first: the address is what makes
       the purchase findable again after a reinstall, so it is part of buying,
       not an extra step bolted onto it. */
    if (!identityVerified) {
      if (!googleReady) {
        done("Buying needs Chrome or Edge — Google sign-in cannot work in this browser.", "err");
        return;
      }
      btn.textContent = "Opening Google…";
      say("Signing in first — it is what brings Pro back if you reinstall.");
      const who = await send({ type: "identity-google" });
      if (!who || who.branch !== "ok") {
        done(who && who.branch === "cancelled"
          ? "Sign-in cancelled. Nothing was charged."
          : "Google sign-in did not complete. Try again in a moment.", "warn");
        return;
      }
      await refreshIdentity();
      /* Sign-in can settle it: the account already owns a licence, or a trial.
         paintSettled() reloads, so never open a checkout for what they have. */
      const settled = who.settled;
      if (settled && (settled.restored || settled.trial)) {
        paintSettled(settled);
        say("");
        return;
      }
      if (!identityVerified) {
        done("Sign-in didn't finish. Try once more.", "warn");
        return;
      }
    }

    btn.textContent = "Opening checkout…";
    say("");
    const res = await send({ type: "checkout-start" });
    // The tab is open and the background is waiting on it; there is nothing
    // left for a 380px panel to do.
    if (res && res.ok) { window.close(); return; }
    const copy = CHECKOUT_COPY[res && res.reason] || CHECKOUT_FALLBACK;
    done("", "");
    if (fail) fail(copy);
    else say(copy.note ? copy.text + " " + copy.note : copy.text, copy.cls);
  }

  $("buy-pro").addEventListener("click", () =>
    startPurchase($("buy-pro"),
      (text, cls) => (text ? identityMsg(text, cls) : identityMsg("")),
      (copy) => paintLicenseState(copy)));

  $("trial-buy").addEventListener("click", () => startPurchase($("trial-buy"), trialSay));

  /* A purchase already in flight — from an earlier popup, or from before the
     browser was last closed. Says so instead of showing a Buy button to
     somebody who has already paid, and nudges the claim along while it is open. */
  (async () => {
    const state = await send({ type: "checkout-state" });
    if (!state || !state.pending) return;
    // Also reaches the trial card, whose Buy button must not open a second one.
    checkoutPending = true;
    paintTrialBuy();
    trialSay(state.held
      ? "Your key arrived — finishing your activation."
      : "Waiting for your payment to clear. You can close this.", "warn");
    if (state.held) revealLicenseBox(false);
    paintLicenseState(state.held
      ? { text: "Finishing your activation…", cls: "warn",
          note: "Your key arrived. This retries on its own." }
      : { text: "Waiting for your payment to clear…", cls: "warn",
          note: "You can close this — it finishes on its own, and your key is emailed to you as well." });

    const done = await send({ type: "checkout-poll" });
    if (!done) return;
    checkoutPending = false;
    paintTrialBuy();
    if (done.state === "active") {
      trialSay("");
      paintLicenseState(null);
      await paintProFromStorage();
    } else if (done.state === "refunded") {
      trialSay("That purchase was refunded. Nothing to activate.", "err");
      paintLicenseState({ text: "That purchase was refunded.", cls: "err",
        note: "Nothing to activate. Reply to your purchase email if this is wrong." });
    }
  })();
  $("help-link").addEventListener("click", (e) => {
    e.preventDefault();
    const supportUrl = self.LCTProduct.supportMailUrl("Tvara help");
    chrome.tabs.create({ url: supportUrl });
  });

  // "Is it still working on the site itself?" — answerable in one click rather
  // than by a support thread of screenshots.
  $("health-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("diag/health.html") });
  });

  // Shown only on a store-installed copy — an unpacked build has no store page,
  // and a "Rate it" link that lands on a 404 is worse than no link.
  {
    const store = self.LCTProduct.storeUrl();
    if (store) {
      const link = $("rate-link");
      link.hidden = false;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: store });
      });
    }
  }

  self.LCTProduct.applyTo(document);

  /* The paste box is a recovery path, not a way in: signing in is. It stays
     folded away so the card has one obvious action, and opens for the two
     people who need it — a pre-Dodo LCT1 key, or a buyer whose Google account
     is not the address they paid with. */
  function revealLicenseBox(focus) {
    const row = $("license-row");
    if (row.hidden) {
      row.hidden = false;
      $("license-toggle").setAttribute("aria-expanded", "true");
    }
    if (focus) $("license-input").focus();
  }

  $("license-toggle").addEventListener("click", () => revealLicenseBox(true));
  $("license-activate").addEventListener("click", activate);
  $("license-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") activate();
  });

  $("license-devices").addEventListener("click", () => openDeviceManager("manage"));
  $("trial-devices").addEventListener("click", () => openDeviceManager("manage"));
  $("identity-devices").addEventListener("click", () => openDeviceManager("manage"));
  $("device-manager-back").addEventListener("click", closeDeviceManager);
  $("device-signout").addEventListener("click", () => { if (dmPicked.size) armConfirm("picked"); });
  $("device-signout-all").addEventListener("click", () => armConfirm("all"));
  $("device-confirm-yes").addEventListener("click", () => { runTerminate(); });
  $("device-confirm-no").addEventListener("click", () => renderSessions());
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
    return /rate[- ]?limit|waiting briefly before continuing/i.test(value)
      ? "Archive updates will continue automatically."
      : /unexpected token\s*['"]?<?|doctype|valid json|unexpected provider response|invalid provider response/i.test(value)
      ? "A provider returned an unexpected page. Open it, then retry."
      : value;
  }

  function paintArchiveCount(chats) {
    const el = $("archive-count");
    if (!el) return;
    const count = Math.max(0, Number(chats) || 0);
    const text = `${count.toLocaleString()} chat${count === 1 ? "" : "s"} saved`;
    if (el.textContent !== text) el.textContent = text;
  }

  function updateSyncStatus(text, cls) {
    const el = $("sync-status");
    // The line changes while a pass runs — "Capturing 35 of 498" — and a
    // sentence that swaps under the eye without a beat reads as a flicker.
    setLine(el, readableSyncMessage(text));
    el.className = "row-sub" + (cls ? " sync-status-" + cls : "") +
      (el.classList.contains("swap") ? " swap" : "");
  }

  function setSyncBusy(busy) {
    const button = $("sync-history");
    button.disabled = busy;
    button.closest(".row-archive")?.classList.toggle("syncing", busy);
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
        updateSyncStatus(summary.message || "Checking…");
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
    showRows([[$("deletion-alert"), !count]]);
    if (!count) return;
    $("deletion-alert-title").textContent = count === 1
      ? "1 chat was deleted on the site" : `${count} chats were deleted on the site`;
  }

  /* A reinstall keeps the ledger (storage.sync) and loses the archive
     (IndexedDB), so the pass captures only new chats until the backup is
     restored. The Recall page has always said so; the popup is where the
     person actually is when they notice the count. */
  function paintRestoreAlert(recovery) {
    const offered = !!(recovery && recovery.state === "restore-offered");
    showRows([[$("restore-alert"), !offered]]);
    if (!offered) return;
    const chats = Number(recovery.backup && recovery.backup.chats) || 0;
    $("restore-alert-title").textContent = chats
      ? `Restore your ${chats.toLocaleString()} archived chats`
      : "Restore your previous archive";
  }

  $("restore-alert").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/archive.html#recovery") });
    window.close();
  });

  /* The row opens the decision, it does not delegate it. Built with
     createElement/textContent: a chat title is somebody else's text. */
  const fmtAgo = (ms) => {
    const mins = Math.max(0, Math.round((Date.now() - (ms || 0)) / 60000));
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? hrs + "h ago" : Math.round(hrs / 24) + "d ago";
  };

  function undoLine(answer) {
    const line = $("deletion-undo");
    if (!answer || !answer.undo) { line.hidden = true; return; }
    line.replaceChildren();
    line.hidden = false;
    line.append(document.createTextNode(
      (answer.count > 1 ? answer.count + " copies deleted. " : "Deleted. ")));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "deletion-undo-btn";
    btn.textContent = "Undo";
    btn.addEventListener("click", async () => {
      const back = await send({ type: "recall-deletions-undo", token: answer.undo });
      line.replaceChildren(document.createTextNode(
        back && back.ok ? "Restored to your backup." : "That copy has already gone."));
      paintDeletions();
    });
    line.appendChild(btn);
    // Five seconds, then the offer stops claiming to be available.
    setTimeout(() => { if (!line.hidden) line.hidden = true; }, 5000);
  }

  async function resolveAnd(ids, action) {
    const answer = await send({ type: "recall-deletions-resolve", ids, action });
    if (action === "delete") undoLine(answer);
    await paintDeletions();
    return answer;
  }

  async function paintDeletions() {
    const list = await send({ type: "recall-deletions" });
    const items = (list && list.items) || [];
    const host = $("deletion-items");
    host.replaceChildren();
    $("deletion-policy").value = (list && list.policy) || "ask";
    /* Answering the last one empties the list — but the undo offer lives in
       this panel, so closing it here took away the way back. */
    /* One chat already carries its own Keep and Delete on its row. A second
       pair underneath, asking the same question about the same chat, is not a
       bulk action — it is the same two options twice. */
    const bulk = document.querySelector(".deletion-actions");
    if (bulk) bulk.hidden = items.length < 2;
    if (!items.length) { showRows([[$("deletion-panel"), $("deletion-undo").hidden]]); return; }
    for (const item of items.slice(0, 25)) {
      const row = document.createElement("div");
      row.className = "deletion-item";
      const text = document.createElement("span");
      text.className = "deletion-text";
      const title = document.createElement("span");
      title.className = "deletion-title";
      title.textContent = item.title || "Untitled chat";
      const meta = document.createElement("span");
      meta.className = "deletion-meta";
      meta.textContent = [item.platform, item.messages ? item.messages + " messages" : "",
        "noticed " + fmtAgo(item.detectedAt)].filter(Boolean).join(" · ");
      text.append(title, meta);
      const keep = document.createElement("button");
      keep.type = "button"; keep.className = "deletion-keep"; keep.textContent = "Keep";
      keep.addEventListener("click", () => resolveAnd([item.id], "keep"));
      const drop = document.createElement("button");
      drop.type = "button"; drop.className = "deletion-drop"; drop.textContent = "Delete";
      drop.addEventListener("click", () => resolveAnd([item.id], "delete"));
      row.append(text, keep, drop);
      host.appendChild(row);
    }
  }

  $("deletion-alert").addEventListener("click", async () => {
    const panel = $("deletion-panel");
    showRows([[panel, !panel.hidden]]);
    if (!panel.hidden) await paintDeletions();
  });
  $("deletion-policy").addEventListener("change", async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...(settings || {}), deletionPolicy: $("deletion-policy").value }
    });
  });
  $("deletion-keep-all").addEventListener("click", () => resolveAnd([], "keep"));
  $("deletion-delete-all").addEventListener("click", () => resolveAnd([], "delete"));

  async function checkFreshness(retry = true) {
    const status = await send({ type: "recall-sync-status" });
    // A cold service worker can drop the very first message of a session.
    if (!status && retry) return setTimeout(() => checkFreshness(false), 350);
    paintSummary(status && status.summary);
    if (status && status.fill) paintFill(status.fill);
    paintDeletionAlert(status && status.deletions);
    paintRestoreAlert(status && status.recovery);
  }

  async function triggerSync() {
    if (isSyncing) return;
    /* `isSyncing` is a popup-local flag, so it only knows about syncs THIS
       popup started — not one the background alarm started, or one begun in a
       second window. The worker's own status is the honest answer, and it was
       already being fetched here and then thrown away. The Recall page has
       always used it this way (see collectSnapshot); the popup now agrees. */
    const status = await send({ type: "recall-sync-status" });
    if (status && status.running) {
      setSyncBusy(true);
      updateSyncStatus("A check is already running…");
      checkFreshness();
      return;
    }
    isSyncing = true;
    setSyncBusy(true);
    updateSyncStatus("Checking for new chats…");
    send({ type: "recall-bg-sync" }).then(() => checkFreshness());
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

  /* Five seconds, for as long as the panel is open. The storage signals below
     cover a tab reporting its own numbers; they do NOT cover the worker
     archiving in the background, which writes to IndexedDB and nothing else. */
  /* ---------- did the worker start at all? ----------
     Asked once, first, and answered by bg.js itself rather than by a module —
     it is the one question a half-loaded worker can still answer. Silence is
     an answer too: a worker that cannot reply to this did not start. */
  async function checkWorker() {
    let health;
    try { health = await send({ type: "worker-health" }); } catch { /* silence is an answer */ }
    const banner = $("worker-dead");
    if (!banner) return;
    if (health && health.ok) { showRows([[banner, true]]); return; }
    const failed = (health && Array.isArray(health.failed) ? health.failed : []).filter(Boolean);
    // This one lands ABOVE everything, so it moves the whole panel. Let the
    // panel travel rather than teleport.
    if (showRows([[banner, false]]) && M) M.enter(banner, { y: -6, dur: 340 });
    const sub = $("worker-dead-sub");
    if (sub) {
      sub.textContent = failed.length
        // Name the files. "It didn't load" is not something anybody can act on;
        // "bg/store.js could not be read" tells them where to look.
        ? `${failed.length} of its background files could not be read — ${failed.slice(0, 3).join(", ")}` +
          (failed.length > 3 ? ", and more." : ".")
        : "The background worker did not answer. Nothing is being archived or measured.";
    }
  }
  checkWorker();
  $("worker-dead-reload").addEventListener("click", () => {
    // Reloading is the fix for a half-installed unpacked build, and it is the
    // one thing this panel can still do without the worker.
    try { chrome.runtime.reload(); } catch { /* nothing more we can do here */ }
    window.close();
  });

  setInterval(refreshPulse, 5000);
  /* The backup row is a live reading like every other number on this panel: an
     automatic backup can land, or a password can be set in the tab this row
     just opened, while the popup is still on screen. Painted once at load it
     would go on describing the state it opened in. Slower than the headline —
     a backup is an hourly event, not a per-second one. */
  setInterval(refreshBackup, 15000);

  /* And the allowances, while the panel is open. The user is chatting in
     another tab while this sits there, so a percentage read when the popup
     opened is a figure from before the last three questions.
     Deliberately narrow: only platforms this browser already has a reading for
     — asking about one nobody is signed into costs a handshake to be told so —
     and only when that reading is over five minutes old. The reply lands as a
     storage change and repaints itself. */
  setInterval(() => {
    const records = (lastQuota && lastQuota.records) || [];
    for (const rec of records) {
      if (!rec || !rec.id) continue;
      if (rec.observedAt && Date.now() - rec.observedAt < 5 * 60e3) continue;
      send({ type: "quota-refresh", platform: rec.id, reason: "watch" });
    }
  }, 60000);

  // Live repaint
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      // `quota:` is what makes the panel live: a reading landing while the popup
      // is open — from a send in another tab, or the refresh we asked for on
      // open — repaints the dial instead of waiting for the next open.
      if (area === "local" && Object.keys(changes).some((k) =>
        k.startsWith("stats:") || k.startsWith("quota:") || k === "settings" || k === "license" || k === "trial"
        /* A heartbeat landing while the popup is open must repaint it, or the
           screen keeps showing Pro on a device that was just signed out. The
           marker only — NOT the token key. load() calls maybeRevalidate(), and
           a routine 12-hourly renewal writes that token, so watching it turns
           one revalidation round into two upstream calls. A sign-out writes
           both keys, so this still repaints at the moment that matters. */
        || k === "lct-signed-out-v1")) {
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
