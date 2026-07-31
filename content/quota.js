/**
 * Long Chat Toolkit — quota bridge (isolated world).
 *
 * Receives the numbers content/inject/quota-probe.js reads out of the host
 * app's own responses and hands them to the worker, which owns the store.
 *
 * The worker owns it rather than this script because a user can have the same
 * provider open in four tabs. Four content scripts merging into one storage key
 * is a lost-update race, and the value being raced over is the number on the
 * dial. One writer, in the worker, with the account already resolved there.
 *
 * Two throttles, for two different reasons:
 *   - Observations coalesce (OBSERVE_MS) because a single page load can produce
 *     a dozen quota-bearing responses and each one is a storage write.
 *   - The refresh request the send path triggers is debounced harder
 *     (REFRESH_MS) because it costs an authenticated call to the provider, and
 *     a burst of sends is still one allowance to look up.
 */
(() => {
  "use strict";

  const EVENT = "lct-quota-observed";
  const READY = "lct-quota-ready";
  const FLAG = "data-lct-quota";
  const OBSERVE_MS = 1200;
  const REFRESH_MS = 8000;
  // The send response's own headers are the freshest possible reading, so a
  // refresh right on the send is usually redundant. Wait long enough for the
  // provider to have settled the charge, then ask.
  const REFRESH_DELAY_MS = 2500;

  const store = self.LCTStore;
  let enabled = true;
  let dead = false;

  let pending = [];
  let observeTimer = null;
  let refreshTimer = null;
  let lastRefreshAt = 0;

  /** Turning the observer off has to reach the page's world, where the hooks
   *  live. The attribute is the whole kill switch: the probe checks it before
   *  every emit and goes quiet permanently once it sees "off". */
  function applyFlag() {
    try {
      document.documentElement.setAttribute(FLAG, enabled ? "on" : "off");
    } catch (_) { /* document gone */ }
  }

  function send(message) {
    if (dead) return;
    try {
      chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
    } catch (_) {
      // Orphaned content script after an extension reload — stop trying.
      dead = true;
    }
  }

  /* Which of several logins on this host the reading belongs to.
     On Gemini the provider endpoints cannot name the signed-in account, but the
     page can — the account switcher and the /u/N seat are right there — and two
     Google accounts open side by side really do have separate allowances. The
     worker salts this into the same account tag the archive uses, so a quota row
     and a synced account are the same account rather than two that look alike. */
  function accountHint() {
    try {
      const adapters = self.LCTAdapters;
      if (!adapters || typeof adapters.accountHint !== "function") return "";
      const adapter = adapters.detect();
      return adapter ? String(adapters.accountHint(adapter) || "").slice(0, 120) : "";
    } catch (_) { return ""; }
  }

  function flush() {
    observeTimer = null;
    if (!pending.length || !enabled) { pending = []; return; }
    const batch = pending;
    pending = [];
    send({
      type: "quota-observed", host: location.hostname,
      hint: accountHint(), observations: batch
    });
  }

  /** Ask the worker to read the provider's own allowance endpoint. Debounced,
   *  and never more than once per REFRESH_MS however many sends land. */
  function requestRefresh() {
    if (!enabled || dead) return;
    if (refreshTimer) return;
    const since = Date.now() - lastRefreshAt;
    const wait = Math.max(REFRESH_DELAY_MS, REFRESH_MS - since);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      lastRefreshAt = Date.now();
      send({ type: "quota-refresh", host: location.hostname, reason: "sent" });
    }, wait);
  }

  document.addEventListener(EVENT, (event) => {
    if (!enabled || dead) return;
    let payload;
    try { payload = JSON.parse(event.detail); } catch (_) { return; }
    if (!payload || typeof payload !== "object") return;

    if (payload.sent) requestRefresh();

    // A bare send notification with no numbers is a trigger, not an
    // observation — forwarding it would be a storage write with nothing in it.
    const hasHeaders = payload.kind === "headers"
      && payload.headers && Object.keys(payload.headers).length > 0;
    const hasBody = payload.kind === "body" && payload.json;
    if (!hasHeaders && !hasBody) return;

    // Bound the batch: a pathological page cannot make us hold megabytes.
    if (pending.length < 24) pending.push(payload);
    if (!observeTimer) observeTimer = setTimeout(flush, OBSERVE_MS);
  }, false);

  /* ---------- settings ---------- */

  let handshaken = false;

  /* The probe runs at document_start and this bridge at document_idle, so the
     app's startup responses — often the ones carrying the limits payload — are
     read before there is anyone to receive them. The probe holds those and
     flushes on this handshake.

     It is deliberately downstream of the settings read, and it is what makes
     switching the observer on mid-session work: firing it before settings are
     known would release buffered readings on an install where the user has the
     observer off, and never firing it again would leave a newly-enabled probe
     buffering into a void. */
  function handshake() {
    if (handshaken || !enabled || dead) return;
    handshaken = true;
    try { document.dispatchEvent(new CustomEvent(READY)); } catch (_) { /* no page */ }
    // Opening the popup is the other moment a fresh number matters, but the
    // popup cannot reach the page's session — it asks the worker directly. This
    // is only the on-load reading, which covers the allowance having moved on
    // another device while this tab was closed.
    send({ type: "quota-refresh", host: location.hostname, reason: "load" });
  }

  async function readSettings() {
    const { settings } = await store.get(["settings"]);
    // Default on: the panel is worthless without it, and it is the mechanism
    // that makes the panel truthful rather than decorative.
    enabled = !settings || settings.quota !== false;
    applyFlag();
    if (enabled) handshake();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) readSettings();
    });
  } catch (_) { /* orphaned */ }

  applyFlag();
  readSettings();
})();
