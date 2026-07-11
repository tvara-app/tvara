/**
 * Long Chat Toolkit — speed engine (v2).
 *
 * Strategy: CSS `content-visibility` windowing with a viewport safety zone.
 *
 *  - An IntersectionObserver (rootMargin 150%) tracks which messages are near
 *    the viewport. Near messages are NEVER windowed — normal scrolling stays
 *    seamless with no pop-in.
 *  - Distant messages get `.lct-cv`: the browser skips their layout/paint and
 *    a subtle skeleton block (styles.css) keeps visual continuity instead of
 *    a black void when jumping across the chat.
 *  - The newest KEEP_TAIL messages are never windowed (streaming safety).
 *
 * Nothing in the host DOM is removed or mutated beyond our class; worst case
 * is the page's normal behavior.
 */
(() => {
  "use strict";

  const CLASS = "lct-cv";
  const KEEP_TAIL = 6;          // never window the newest N messages
  const MIN_MESSAGES = 25;      // do nothing on short chats — zero overhead
  const RESCAN_MS = 400;        // debounce for DOM mutations
  const NEAR_MARGIN = "150% 0px 150% 0px"; // safety zone: ±1.5 screens

  let adapter = null;
  let enabled = false;
  let observer = null;          // MutationObserver
  let io = null;                // IntersectionObserver
  let rescanTimer = null;
  let spaTimer = null;
  let lastHref = location.href;
  let windowedCount = 0;
  let onUpdate = null;          // callback(messages, windowedCount)

  let nearSet = new WeakSet();       // messages near the viewport (never window)
  let tailSet = new WeakSet();       // newest messages (never window)
  let observedSet = new WeakSet();   // messages already registered with the IO
  let classifiedSet = new WeakSet(); // messages the IO has classified at least once

  function ensureIO() {
    if (io) return;
    io = new IntersectionObserver(
      (entries) => {
        let firstClassifications = false;
        for (const en of entries) {
          if (!classifiedSet.has(en.target)) {
            classifiedSet.add(en.target);
            firstClassifications = true;
          }
          if (en.isIntersecting) {
            nearSet.add(en.target);
            en.target.classList.remove(CLASS);
          } else {
            nearSet.delete(en.target);
            if (!tailSet.has(en.target) && enabled) en.target.classList.add(CLASS);
          }
        }
        // newly classified messages change the windowed count — refresh it
        if (firstClassifications) scheduleRescan();
      },
      { root: null, rootMargin: NEAR_MARGIN }
    );
  }

  function rescan() {
    if (!enabled || !adapter) return;
    let messages = [];
    try {
      messages = adapter.messages();
    } catch (_) {
      return; // selector drift → degrade to doing nothing
    }

    if (messages.length < MIN_MESSAGES) {
      unwindowAll();
      windowedCount = 0;
      if (onUpdate) onUpdate(messages, 0);
      return;
    }

    ensureIO();

    // rebuild tail set (newest messages stay live for streaming)
    tailSet = new WeakSet();
    for (let i = Math.max(0, messages.length - KEEP_TAIL); i < messages.length; i++) {
      tailSet.add(messages[i]);
    }

    let count = 0;
    for (const el of messages) {
      if (!observedSet.has(el)) {
        observedSet.add(el);
        io.observe(el); // initial IO callback will classify it
      }
      if (tailSet.has(el) || nearSet.has(el)) {
        el.classList.remove(CLASS);
      } else if (classifiedSet.has(el)) {
        el.classList.add(CLASS);
        count++;
      }
      // not yet classified by the IO → leave it live. Windowing a message the
      // user might be looking at (first scan, chat switch) causes a visible
      // collapse-to-skeleton flash; waiting one IO tick costs nothing.
    }
    windowedCount = count;
    if (onUpdate) onUpdate(messages, count);
  }

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescan, RESCAN_MS);
  }

  function unwindowAll() {
    document.querySelectorAll("." + CLASS).forEach((el) => el.classList.remove(CLASS));
  }

  function start(a, updateCb) {
    adapter = a;
    onUpdate = updateCb || null;
    enabled = true;

    observer = new MutationObserver(scheduleRescan);
    observer.observe(document.body, { childList: true, subtree: true });

    // SPA route changes (new chat opened without a page load)
    clearInterval(spaTimer);
    spaTimer = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        unwindowAll();
        nearSet = new WeakSet();
        observedSet = new WeakSet();
        classifiedSet = new WeakSet();
        if (io) { io.disconnect(); io = null; }
        scheduleRescan();
      }
    }, 1000);

    rescan();
  }

  function stop() {
    enabled = false;
    if (observer) observer.disconnect();
    observer = null;
    if (io) io.disconnect();
    io = null;
    clearInterval(spaTimer);
    spaTimer = null;
    clearTimeout(rescanTimer);
    nearSet = new WeakSet();
    tailSet = new WeakSet();
    observedSet = new WeakSet();
    classifiedSet = new WeakSet();
    unwindowAll();
    windowedCount = 0;
    if (onUpdate) onUpdate([], 0);
  }

  self.LCTEngine = {
    start,
    stop,
    rescan,
    get windowedCount() { return windowedCount; },
    get enabled() { return enabled; }
  };
})();
