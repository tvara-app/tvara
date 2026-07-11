/**
 * Long Chat Toolkit — ChatGPT exact-times reader (runs in the page's MAIN
 * JS world; everything else in this extension runs isolated).
 *
 * ChatGPT keeps each message's real create_time in React internal props but
 * never renders it. This file reads that value locally and hands it to the
 * extension via a DOM event. READ-ONLY by design: no network calls, no
 * fetch/XHR hooks, no writes to page state. If ChatGPT's internals change,
 * this finds nothing and the extension falls back to its local
 * first-seen clock (content/timeline.js).
 */
(() => {
  "use strict";

  function createTimeOf(el) {
    try {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (!key) return null;
      let node = el[key];
      for (let i = 0; i < 15 && node; i++, node = node.return) {
        const msgs = node.memoizedProps && node.memoizedProps.messages;
        if (msgs && msgs[0] && typeof msgs[0].create_time === "number") {
          return msgs[0].create_time;
        }
      }
    } catch (_) {
      /* private React internals moved — degrade to first-seen */
    }
    return null;
  }

  document.addEventListener("lct-times-request", () => {
    const out = {};
    document.querySelectorAll("div[data-message-id]").forEach((el) => {
      const t = createTimeOf(el);
      if (t) out[el.getAttribute("data-message-id")] = t;
    });
    // detail is a JSON string: plain strings cross the world boundary safely
    // in both Chrome and Firefox.
    document.dispatchEvent(
      new CustomEvent("lct-times-response", { detail: JSON.stringify(out) })
    );
  });
})();
