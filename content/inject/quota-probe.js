/**
 * Long Chat Toolkit — provider quota observer (runs in the page's MAIN JS
 * world; everything else in this extension except fiber-times.js runs isolated).
 *
 * WHAT THIS IS FOR. Every one of these apps renders its own "you have X left,
 * resets at Y" from data it fetches. That response is the only figure that can
 * agree with what the user sees on the site, because it IS what the site sees.
 * This file reads it as it goes past and hands the numbers to the extension.
 *
 * WHY IT HAD TO BE A HOOK. The alternative we shipped before — counting user
 * message elements in the DOM — cannot work. On a virtualising host, scrolling
 * up mounts old turns and the count jumps; and providers meter tokens over a
 * rolling window, not messages, so no message count converts to an allowance.
 *
 * THE CONSTRAINT THIS FILE BREAKS, AND THE TERMS. Until now this extension
 * declared "no fetch/XHR hooks" (see content/inject/fiber-times.js). That rule
 * is relaxed here and only here, under limits that keep the original promise
 * intact:
 *
 *   1. PASSIVE. Requests are never altered, blocked, delayed, retried or
 *      replayed. The value the page receives is the value the network gave it;
 *      the original promise/handler is returned untouched.
 *   2. NO BODY READS ON CHAT TRAFFIC. Bodies are only cloned for URLs whose
 *      own path says they are about limits, and never for streaming responses.
 *      Conversation content is not read here, at all.
 *   3. NUMBERS ONLY LEAVE. What crosses to the extension is a list of
 *      {pctLeft, resetAt, limit, remaining} — never a body, never a header
 *      bearing a token, never a URL query.
 *   4. FAILS SILENT AND FAILS OPEN. Every touch point is wrapped; a throw
 *      inside our code can never propagate into the host app. If the shape
 *      changes we find nothing and the popup says "not reported".
 *   5. KILLABLE. The page sets data-lct-quota="off" and the hooks self-remove.
 *
 * Response headers do most of the work: `anthropic-ratelimit-*` style headers
 * ride along on the send request itself, which is the instant the number
 * changes. No body is needed to read those, so the common case touches nothing.
 */
(() => {
  "use strict";

  const EVENT = "lct-quota-observed";
  const FLAG = "data-lct-quota";
  const MAX_BODY_BYTES = 262144;      // 256KB — a limits payload is a few hundred bytes
  const SEND_HINT = /\b(conversation|completion|chat|message|append|stream|ask|responses)\b/;

  /* Paths whose own name says they are about allowance. A body is only ever
     read for one of these, so a chat payload never passes through here. */
  const LIMIT_PATH = /(limit|quota|usage|rate[-_]?limit|allowance|balance|entitlement|subscription|bootstrap|settings|account_status|capabilit)/i;

  /* Paths that are conversation traffic. If a URL matches this and does NOT
     name a limit, we take headers only — belt and braces over LIMIT_PATH. */
  const CHAT_PATH = /(conversation|\/messages?\b|\/chat\/|completion|stream)/i;

  const READY = "lct-quota-ready";
  const MAX_BUFFER = 24;

  let disabled = false;
  /* This file runs at document_start so the app's own startup calls — which is
     where a bootstrap/limits payload usually appears — are not missed. The
     isolated-world listener loads later, at document_idle, so anything emitted
     before then has nobody to hear it. Hold those readings and flush on the
     bridge's handshake rather than dropping the most interesting ones. */
  let ready = false;
  let buffer = [];

  function killed() {
    if (disabled) return true;
    try {
      if (document.documentElement.getAttribute(FLAG) === "off") { disabled = true; return true; }
    } catch (_) { /* document torn down */ }
    return false;
  }

  /** Numbers out, nothing else. A plain JSON string crosses the world boundary
   *  safely in both Chrome and Firefox — same channel style as fiber-times. */
  function emit(payload) {
    if (!ready) {
      // Bounded: a page that never loads our bridge cannot make this grow.
      if (buffer.length < MAX_BUFFER) buffer.push(payload);
      return;
    }
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(payload) }));
    } catch (_) { /* boundary closed — drop it */ }
  }

  document.addEventListener(READY, () => {
    ready = true;
    const held = buffer;
    buffer = [];
    for (const payload of held) emit(payload);
  }, false);

  /* ---------- extraction ----------
     Kept deliberately small and local. The real parsing lives in lib/quota.js
     on the extension side, because this file runs in the page's world where the
     page could have replaced Object.entries or RegExp.prototype.test. We match
     header names literally and forward raw name/value pairs for the extension
     to interpret; the page cannot make us mis-read what we never parse. */

  const HEADER_PREFIXES = [
    "anthropic-ratelimit-", "x-ratelimit-", "ratelimit-",
    "x-quota-", "openai-ratelimit-", "x-rate-limit-"
  ];

  function quotaHeaders(headers) {
    const out = {};
    let found = false;
    try {
      headers.forEach((value, name) => {
        const lower = String(name).toLowerCase();
        for (let i = 0; i < HEADER_PREFIXES.length; i++) {
          if (lower.indexOf(HEADER_PREFIXES[i]) === 0) {
            // Values here are scalars (counts, epochs, percentages). A token
            // never appears in a rate-limit header, and we take nothing else.
            out[lower] = String(value).slice(0, 64);
            found = true;
            return;
          }
        }
      });
    } catch (_) { /* exotic Headers implementation */ }
    return found ? out : null;
  }

  /** Same-origin only: we read the host app's own calls, nothing third-party. */
  function ownOrigin(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin;
    } catch (_) { return false; }
  }

  function pathOf(url) {
    try { return new URL(url, location.href).pathname; } catch (_) { return ""; }
  }

  function bodyWorthReading(path, response) {
    if (!LIMIT_PATH.test(path)) return false;
    // A limits endpoint that is also conversation traffic is conversation
    // traffic. Headers only.
    if (CHAT_PATH.test(path) && !/(limit|quota|allowance|usage)/i.test(path)) return false;
    try {
      const type = String(response.headers.get("content-type") || "").toLowerCase();
      if (type.indexOf("json") < 0) return false;           // never a stream, never HTML
      const len = Number(response.headers.get("content-length") || 0);
      if (len > MAX_BODY_BYTES) return false;
    } catch (_) { return false; }
    return true;
  }

  /**
   * Report one observed response.
   *
   * Header extraction is synchronous and free. A body read is deferred to a
   * clone so the page's own consumption of the response is never touched — and
   * only for the narrow allowlist above.
   */
  function observe(url, response, method) {
    if (killed()) return;
    let path = "";
    try {
      if (!ownOrigin(url)) return;
      path = pathOf(url);
    } catch (_) { return; }

    let headers = null;
    try { headers = quotaHeaders(response.headers); } catch (_) { /* ignore */ }

    // A POST to the send path is the moment the allowance moves, so it is worth
    // telling the extension even when this particular response carried no
    // quota headers: that is its cue to refresh from the provider directly.
    const sent = method === "POST" && SEND_HINT.test(path);

    if (headers || sent) {
      emit({ kind: "headers", host: location.hostname, path, headers: headers || {}, sent, at: Date.now() });
    }

    if (!bodyWorthReading(path, response)) return;

    // clone() before anyone reads it; if the body was already consumed this
    // throws and we simply do not report a body for this response.
    let clone;
    try { clone = response.clone(); } catch (_) { return; }
    clone.json().then(
      (json) => { if (!killed()) emit({ kind: "body", host: location.hostname, path, json, at: Date.now() }); },
      () => { /* not JSON after all */ }
    );
  }

  /* ---------- fetch ---------- */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    const wrapped = function (input, init) {
      // The call itself is forwarded first and unmodified. Nothing we do can
      // change what the page requested or what it receives.
      const promise = nativeFetch.apply(this, arguments);
      if (killed()) return promise;
      try {
        const url = typeof input === "string" ? input
          : (input && typeof input.url === "string" ? input.url : String(input || ""));
        const method = String(
          (init && init.method) || (input && input.method) || "GET"
        ).toUpperCase();
        // A separate then() on the same promise: the page's own chain is
        // untouched, and a rejection here cannot become an unhandled rejection
        // in the page because we attach a handler to both sides.
        promise.then(
          (response) => { try { observe(url, response, method); } catch (_) { /* never surface */ } },
          () => { /* the page's failure, not ours to report */ }
        );
      } catch (_) { /* observation is best-effort */ }
      return promise;
    };
    // Some apps feature-detect by stringifying fetch. Keep it looking native.
    try {
      Object.defineProperty(wrapped, "name", { value: "fetch" });
      Object.defineProperty(wrapped, "length", { value: nativeFetch.length });
      wrapped.toString = () => nativeFetch.toString();
    } catch (_) { /* cosmetic only */ }
    try { window.fetch = wrapped; } catch (_) { /* frozen — nothing to do */ }
  }

  /* ---------- XMLHttpRequest ----------
     Still used by parts of these apps, and by their analytics. Only the
     response HEADERS are read here: XHR has no clone(), so reading a body
     would mean touching responseText on the page's own object. We do not. */

  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try {
          this.__lctMethod = String(method || "GET").toUpperCase();
          this.__lctUrl = String(url || "");
        } catch (_) { /* sealed instance */ }
        return open.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        try {
          if (!killed()) {
            this.addEventListener("load", () => {
              try {
                const raw = this.getAllResponseHeaders ? this.getAllResponseHeaders() : "";
                const headers = {};
                let found = false;
                for (const line of String(raw).split(/\r?\n/)) {
                  const idx = line.indexOf(":");
                  if (idx < 0) continue;
                  const name = line.slice(0, idx).trim().toLowerCase();
                  for (let i = 0; i < HEADER_PREFIXES.length; i++) {
                    if (name.indexOf(HEADER_PREFIXES[i]) === 0) {
                      headers[name] = line.slice(idx + 1).trim().slice(0, 64);
                      found = true;
                      break;
                    }
                  }
                }
                const url = this.__lctUrl || "";
                if (!ownOrigin(url)) return;
                const path = pathOf(url);
                const sent = this.__lctMethod === "POST" && SEND_HINT.test(path);
                if (found || sent) {
                  emit({ kind: "headers", host: location.hostname, path, headers, sent, at: Date.now() });
                }
              } catch (_) { /* never surface into the page */ }
            });
          }
        } catch (_) { /* listener rejected — skip observation */ }
        return send.apply(this, arguments);
      };
    }
  } catch (_) { /* XHR locked down — fetch path still covers us */ }
})();
