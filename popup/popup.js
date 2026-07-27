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
    }
  }

  function paintToggles(s) {
    $("toggle-enabled").checked = !s || s.enabled !== false;
    $("toggle-minimap").checked = !s || s.minimap !== false;
    $("toggle-time").checked = !s || s.time !== false;
    $("toggle-history").checked = !!(s && s.history === true);
  }

  /* ---------- usage circles ----------
     Per-provider circular progress rings showing messages sent in a rolling
     window. Always visible for every platform the user has synced with.
     Each ring shows: count in centre, platform name below, plan tier below. */

  const USAGE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours
  const SVG_NS = "http://www.w3.org/2000/svg";
  const RING_R = 15;                           // radius
  const RING_C = 2 * Math.PI * RING_R;        // circumference ≈ 94.25

  // Provider configuration: color, default limit, default plan label.
  const PROVIDERS = {
    chatgpt:    { color: "#10a37f", limit: 80,   plan: "Plus" },
    claude:     { color: "#d97757", limit: 45,   plan: "Pro" },
    gemini:     { color: "#4285f4", limit: null,  plan: "Free" },
    deepseek:   { color: "#4d6bfe", limit: null,  plan: "Free" },
    grok:       { color: "#c8c8c8", limit: null,  plan: "Free" },
    perplexity: { color: "#20808d", limit: null,  plan: "Free" }
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
    { id: "chatgpt", label: "ChatGPT" },
    { id: "claude",  label: "Claude" },
    { id: "gemini",  label: "Gemini" }
  ];

  function usageCircleEl(providerId, platformLabel, sent, limit, plan) {
    const info = PROVIDERS[providerId] || PROVIDERS.chatgpt;
    const color = info.color;

    const wrap = document.createElement("div");
    wrap.className = "usage-circle";

    // Percentage for the ring arc
    const raw = limit ? sent / limit : (sent > 0 ? 0.15 : 0);
    const pct = Math.max(raw, 0.04); // always show a sliver
    if (limit && raw >= 0.9) wrap.classList.add("over90");

    // SVG ring
    const ring = document.createElement("div");
    ring.className = "usage-ring";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 36 36");

    // Track circle (background)
    const track = document.createElementNS(SVG_NS, "circle");
    track.setAttribute("cx", "18"); track.setAttribute("cy", "18");
    track.setAttribute("r", String(RING_R));
    track.setAttribute("class", "usage-ring-track");

    // Fill circle (progress arc)
    const fill = document.createElementNS(SVG_NS, "circle");
    fill.setAttribute("cx", "18"); fill.setAttribute("cy", "18");
    fill.setAttribute("r", String(RING_R));
    fill.setAttribute("class", "usage-ring-fill");
    fill.style.stroke = color;
    fill.style.strokeDasharray = String(RING_C);
    fill.style.strokeDashoffset = String(RING_C * (1 - Math.min(pct, 1)));
    // Rotate -90° so the arc starts from the top
    fill.setAttribute("transform", "rotate(-90 18 18)");

    svg.append(track, fill);

    // Count text inside the ring
    const countEl = document.createElement("span");
    countEl.className = "usage-ring-count";
    countEl.textContent = limit ? `${sent}` : `${sent}`;
    ring.append(svg, countEl);

    // Platform name
    const nameEl = document.createElement("span");
    nameEl.className = "usage-circle-name";
    nameEl.textContent = platformLabel;
    nameEl.style.color = color;

    // Plan label (e.g. "0/80 · Plus")
    const planEl = document.createElement("span");
    planEl.className = "usage-circle-plan";
    const planParts = [];
    if (limit) planParts.push(`${sent}/${limit}`);
    planParts.push(plan || "Free");
    planEl.textContent = planParts.join(" · ");

    wrap.append(ring, nameEl, planEl);
    return wrap;
  }

  /**
   * Paint the usage circles and the windowed total.
   * @param {number} windowedTotal
   * @param {Array} statRows — [[platform, windowed, total], ...]
   * @param {Object} usageMap — { hostname: { sent, platform, id } }
   * @param {string[]} syncedPlatforms — platform ids from recall-sync checkpoints
   */
  function paintUsageBars(windowedTotal, statRows, usageMap, syncedPlatforms) {
    $("stat-windowed").textContent = (windowedTotal || 0).toLocaleString();

    const cutoff = Date.now() - USAGE_WINDOW_MS;
    const barMap = new Map();

    // 1. Seed from usage data (sent timestamps)
    if (usageMap) {
      for (const [host, rec] of Object.entries(usageMap)) {
        const id = rec.id || HOST_TO_ID[host] || host;
        const label = rec.platform || ID_TO_LABEL[id] || id;
        const sent = Array.isArray(rec.sent) ? rec.sent.filter((ts) => ts > cutoff).length : 0;
        const info = PROVIDERS[id] || {};
        barMap.set(id, { id, label, sent, limit: info.limit ?? null,
          plan: info.plan || "Free",
          lastSent: sent > 0 ? Math.max(...rec.sent) : 0 });
      }
    }

    // 2. Merge stats-only platforms
    for (const [label] of (statRows || [])) {
      const entry = Object.entries(HOST_TO_ID).find(([, v]) =>
        v === label.toLowerCase() || label.toLowerCase().startsWith(v));
      const pid = entry ? entry[1] : label.toLowerCase();
      if (barMap.has(pid)) continue;
      const info = PROVIDERS[pid] || {};
      barMap.set(pid, { id: pid, label, sent: 0, limit: info.limit ?? null,
        plan: info.plan || "Free", lastSent: 0 });
    }

    // 3. Seed from synced platforms
    for (const pid of (syncedPlatforms || [])) {
      if (barMap.has(pid)) continue;
      const info = PROVIDERS[pid] || {};
      barMap.set(pid, { id: pid, label: ID_TO_LABEL[pid] || pid, sent: 0,
        limit: info.limit ?? null, plan: info.plan || "Free", lastSent: 0 });
    }

    // 4. Fallback: show default platforms
    if (barMap.size === 0) {
      for (const p of KNOWN_PLATFORMS) {
        const info = PROVIDERS[p.id] || {};
        barMap.set(p.id, { id: p.id, label: p.label, sent: 0,
          limit: info.limit ?? null, plan: info.plan || "Free", lastSent: 0 });
      }
    }

    const items = [...barMap.values()].sort((a, b) =>
      b.lastSent - a.lastSent || a.label.localeCompare(b.label));

    $("usage-bars").replaceChildren(
      ...items.map((b) => usageCircleEl(b.id, b.label, b.sent, b.limit, b.plan))
    );
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
  // Always paint usage bars — the fallback inside paintUsageBars shows default
  // platforms even without data so the bars are never invisible on first open.
  paintUsageBars(
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

    paintUsageBars(total, rows, usageMap, syncedPlatforms);

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
    // The popup is a command surface, and it must stay inside Chrome's popup
    // height. It previews the two strongest matches; the adjacent open button
    // leads to the full archive workspace.
    $("recall-results").replaceChildren(...results.slice(0, 2).map(recallResult));
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
