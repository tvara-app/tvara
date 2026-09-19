/**
 * Tvara — speed engine (v2).
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

  // Before a message sleeps, freeze its REAL height into contain-intrinsic-size.
  // The stylesheet's 320px guess makes scroll math drift on long chats — jumps
  // land short and the scrollbar lies. Measured heights make both exact.
  // A message the reader was just sent to stays awake regardless of distance —
  // re-windowing the landing zone mid-jump is what made one click land short.
  //
  // Two phases, deliberately. `content-visibility` is a layout-affecting
  // property, so reading offsetHeight right after writing the class on the
  // previous element forces a synchronous reflow — once per message. Reading
  // the whole batch first, then writing the whole batch, costs one layout for
  // however many messages are going to sleep.
  const pending = [];

  function queueSleep(el) {
    if (el.classList.contains("lct-awake") || el.classList.contains(CLASS)) return;
    pending.push(el);
  }

  function flushSleep() {
    const n = pending.length;
    if (!n) return;
    const heights = new Array(n);
    for (let i = 0; i < n; i++) heights[i] = pending[i].offsetHeight;   // read pass
    for (let i = 0; i < n; i++) {                                       // write pass
      const el = pending[i];
      // A zero height is the host mid-render, not a message worth nothing.
      // Sleeping it anyway swaps a real height for the stylesheet's 320px
      // guess, and every such swap ABOVE the reader shoves the page under
      // them — which is what "it scrolled by itself while the chat loaded"
      // was. Leave it live; the next tick measures it.
      if (heights[i] <= 0) continue;
      el.style.containIntrinsicSize = "auto " + heights[i] + "px";
      el.classList.add(CLASS);
    }
    pending.length = 0;
  }

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
            if (!tailSet.has(en.target) && enabled) queueSleep(en.target);
          }
        }
        flushSleep();
        // newly classified messages change the windowed count — refresh it
        if (firstClassifications) scheduleRescan();
      },
      { root: null, rootMargin: NEAR_MARGIN }
    );
  }

  function rescan() {
    if (!enabled || !adapter) return;
    let messages;
    try {
      messages = adapter.messages();
    } catch (_) {
      return; // selector drift → degrade to doing nothing
    }

    /* Our own rows too. On a host that mounts only its last few turns (ChatGPT
       holds six of a 106-message chat), history-loader.js puts the rest back
       from the archive — a hundred rows this engine never saw, so every one of
       them was painted and the count read 0 on the longest chat there is.
       They are older than anything the host mounted, so they go first. The
       minimap still gets the host's rows alone: ours are not the host's turns. */
    let own;
    try { own = Array.from(document.querySelectorAll("#lct-old-turns [data-lct-turn-id]")); } catch (_) { own = []; }
    const managed = own.length ? own.concat(messages) : messages;

    if (managed.length < MIN_MESSAGES) {
      unwindowAll();
      windowedCount = 0;
      if (onUpdate) onUpdate(messages, 0);
      return;
    }

    ensureIO();

    // rebuild tail set (newest messages stay live for streaming)
    tailSet = new WeakSet();
    for (let i = Math.max(0, managed.length - KEEP_TAIL); i < managed.length; i++) {
      tailSet.add(managed[i]);
    }

    let count = 0;
    for (const el of managed) {
      if (!observedSet.has(el)) {
        observedSet.add(el);
        io.observe(el); // initial IO callback will classify it
      }
      if (tailSet.has(el) || nearSet.has(el) || el.classList.contains("lct-awake")) {
        el.classList.remove(CLASS);
      } else if (classifiedSet.has(el)) {
        queueSleep(el);
        count++;
      }
      // not yet classified by the IO → leave it live. Windowing a message the
      // user might be looking at (first scan, chat switch) causes a visible
      // collapse-to-skeleton flash; waiting one IO tick costs nothing.
    }
    flushSleep();
    windowedCount = count;
    if (onUpdate) onUpdate(messages, count);
  }

  // Trailing debounce on ONE reused timer. A streaming answer mutates the DOM
  // continuously, and re-arming a timeout per mutation batch churned hundreds
  // of timer allocations a second to schedule a single rescan.
  let rescanDue = 0;

  function scheduleRescan() {
    rescanDue = Date.now() + RESCAN_MS;
    if (rescanTimer) return;
    rescanTimer = setTimeout(fireRescan, RESCAN_MS);
  }

  function fireRescan() {
    const left = rescanDue - Date.now();
    if (left > 0) { rescanTimer = setTimeout(fireRescan, left); return; }
    rescanTimer = null;
    rescan();
  }

  // Only an element joining or leaving the page can change what adapter
  // .messages() returns — every adapter selector matches elements. Text-node
  // churn is most of what streaming emits, and rescanning on it walked the
  // whole conversation to rebuild a list that could not have changed. Text
  // EDITED in place never reached us anyway: characterData is not observed.
  function hasElement(nodes) {
    for (let i = 0; i < nodes.length; i++) if (nodes[i].nodeType === 1) return true;
    return false;
  }

  function onMutations(records) {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (hasElement(r.addedNodes) || hasElement(r.removedNodes)) return scheduleRescan();
    }
  }

  function unwindowAll() {
    pending.length = 0;   // anything queued was queued for a page we just left
    const asleep = document.getElementsByClassName(CLASS);
    while (asleep.length) asleep[0].classList.remove(CLASS);   // live collection
  }

  function checkRoute() {
    if (document.hidden || location.href === lastHref) return;
    lastHref = location.href;
    unwindowAll();
    nearSet = new WeakSet();
    observedSet = new WeakSet();
    classifiedSet = new WeakSet();
    if (io) { io.disconnect(); io = null; }
    scheduleRescan();
  }

  function start(a, updateCb) {
    adapter = a;
    onUpdate = updateCb || null;
    enabled = true;

    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });

    // SPA route changes (new chat opened without a page load). Polled because a
    // content script cannot see the page's own history calls from its isolated
    // world. A hidden tab has nobody navigating it, so the poll idles there and
    // the visibility flip catches anything that moved while it was away.
    clearInterval(spaTimer);
    spaTimer = setInterval(checkRoute, 1000);
    document.addEventListener("visibilitychange", checkRoute);

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
    document.removeEventListener("visibilitychange", checkRoute);
    clearTimeout(rescanTimer);
    rescanTimer = null;
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
