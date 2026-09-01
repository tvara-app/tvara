/**
 * Tvara — quota channel handshake (isolated world, document_start).
 *
 * WHY THIS FILE EXISTS. The probe runs in the page's own JS world, so the only
 * way back to the extension is a DOM event — and a DOM event any page script
 * can dispatch is an allowance reading any page script can forge, straight into
 * the worker's storage. It could also be silenced: the kill switch used to be
 * an attribute on <html>, which the page is free to write.
 *
 * WHAT FIXES IT. A 128-bit token minted here, in the isolated world, and used
 * as the EVENT NAME rather than as a field inside one. Listening for an event
 * requires naming it exactly, and dispatching one does too, so a page that does
 * not hold the token can neither forge an observation nor read one — and it
 * never sees the token, because the whole exchange happens at document_start,
 * before the first page script runs. The control channel is named the same way,
 * which is what takes the off switch out of the page's hands.
 *
 * The announcement is made ONCE, synchronously, at injection — and never in
 * answer to a request. Answering a request would hand the token to any page
 * script that asked for it, which is the hole this file exists to close. That
 * makes injection order load-bearing: this entry sits AFTER the probe in
 * manifest.json, so the probe's listener is already installed. If that ever
 * stops holding, the probe simply never gets a channel and reports nothing —
 * the failure is a lost reading, never a forgeable one.
 *
 * It also owns the receiving end until content/quota.js loads at document_idle.
 * Readings from the app's startup — often the ones carrying the limits payload
 * — arrive long before then, and are held here rather than dropped.
 */
(() => {
  "use strict";

  const KEY = "lct-quota-key";
  const OBSERVED = "lct-quota-observed";
  const MAX_HELD = 48;

  let token;
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    token = Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
  } catch (_) { return; }        // no randomness, no channel: stay silent

  self.__lctQuotaChannel = token;
  const held = self.__lctQuotaHeld = [];

  document.addEventListener(OBSERVED + ":" + token, (event) => {
    const detail = typeof event.detail === "string" ? event.detail : "";
    if (!detail) return;
    const sink = self.__lctQuotaSink;
    if (typeof sink === "function") { sink(detail); return; }
    // Bounded: a chatty page cannot make this grow before the bridge loads.
    if (held.length < MAX_HELD) held.push(detail);
  }, false);

  // Once, now, before the first page script exists to overhear it.
  try { document.dispatchEvent(new CustomEvent(KEY, { detail: token })); } catch (_) { /* no page */ }
})();
