/**
 * Long Chat Toolkit — virtual-history backfill.
 *
 * ChatGPT mounts only the recent tail of a long conversation. This walks its
 * native scroller to the oldest available turn so every turn the host exposes
 * is mounted, then returns to the reader's exact anchor.
 *
 * It does NOT run on its own any more. Paging a 1,500-turn conversation is
 * sixty round trips of the host yanking its own scroller to the top, and doing
 * that unannounced while someone is reading is indistinguishable from the page
 * being broken — which is exactly how it read. Full-text history now comes
 * from the background sync, which never touches the page; this walk is a
 * deliberate act (the ⤒ button on the minimap, or settings.history) for people
 * who want the in-page map complete right now.
 */
(() => {
  "use strict";

  const TOP_EPSILON = 3;
  const STALL_LIMIT = 5;
  const STEP_TIMEOUT = 900;
  /* After the host has answered once we know roughly what a page costs, and
     STEP_TIMEOUT stops being a timeout and starts being dead air — STALL_LIMIT
     × 900ms is 4.5s of nothing at the end of every walk. Track the real latency
     and give the host three times its own median before calling it stalled. */
  const STEP_FLOOR = 150;
  /* Not a budget — a safety net. The crawl ends when the host stops handing us
     pages (STALL_LIMIT), because that is the only honest signal that we reached
     the first turn. A wall clock here just abandons long conversations halfway:
     1,500 turns at ~25/page is 60 round trips, which outruns any short cap. */
  const CEILING_MS = 240000;
  const IDLE_RESUME_MS = 2500;
  const MAX_RESUMES = 5;
  const INPUT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

  let active = null;
  let autoAllowed = false;             // settings.history — off unless asked for
  const startedRoutes = new Set();     // auto-start fires once per route
  const completedRoutes = new Set();   // reached the oldest turn — never redo
  const resumeCounts = new Map();

  function testVirtualHost() {
    return document.documentElement.hasAttribute("data-lct-virtual-history");
  }

  /* Which hosts mount only a window of a long conversation. Declared by the
     adapter rather than tested by id here: ChatGPT was never special, it was
     just the one that had been checked. Claude, Gemini and Grok virtualize too,
     and on those the minimap, the in-chat search and the outline were quietly
     describing the recent tail as if it were the whole conversation. */
  function supported(adapter) {
    return !!adapter && (adapter.virtualizes === true || testVirtualHost());
  }

  function rootScroller(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement;
  }

  function scrollTopOf(scroller) {
    return rootScroller(scroller) ? window.scrollY || scroller.scrollTop : scroller.scrollTop;
  }

  function maxScrollTop(scroller) {
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function moveTo(scroller, top) {
    const next = Math.max(0, top);
    if (rootScroller(scroller)) window.scrollTo({ top: next, left: 0, behavior: "auto" });
    else scroller.scrollTop = next;
  }

  function viewportTop(scroller) {
    return rootScroller(scroller) ? 0 : scroller.getBoundingClientRect().top;
  }

  /* Identify one message. A provider id when the host assigns one, and only
     then a text prefix — which is a real key for the OLDEST message (settled
     long ago) and a poor one for the newest (it moves while an answer
     streams). Both callers below are built around that asymmetry. */
  function messageKey(adapter, el) {
    if (!el) return "";
    const stable = adapter && adapter.stableKey ? adapter.stableKey(el) : "";
    return stable ||
      el.getAttribute("data-testid") ||
      el.id ||
      ((el.textContent || "").trim().slice(0, 160));
  }

  /**
   * "Is this the same mounted window as a moment ago?" — the one test that
   * decides whether the host answered our request for another page.
   *
   * The tail is keyed by provider id ONLY, never by text. Paging up is proved
   * by the count and the FIRST message — the last one contributes nothing to
   * that, and on a host with no ids its key would be its own text. An answer
   * arriving underneath the crawl rewrites that key on every token, the walk
   * reads each rewrite as another page, and the stall counter it needs in order
   * to stop can never fill. It is not a permanent hang: messageKey only reads
   * the first 160 characters, so the walk frees itself once the answer outgrows
   * them. It is worse than a hang would be — a walk that ends when an unrelated
   * message happens to get long enough, having spent the interval asking a host
   * for pages it ran out of at the start. ChatGPT never had the problem, which
   * is the only reason it went unnoticed: data-message-id is always there.
   */
  function signature(adapter, messages) {
    if (!messages.length) return "0";
    const tail = adapter && adapter.stableKey ? adapter.stableKey(messages[messages.length - 1]) : "";
    return messages.length + "|" + messageKey(adapter, messages[0]) + "|" + tail;
  }

  function captureAnchor(adapter, messages, scroller) {
    const top = viewportTop(scroller);
    const bottom = rootScroller(scroller) ? innerHeight : scroller.getBoundingClientRect().bottom;
    const visible = messages.find((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > top && r.top < bottom;
    }) || messages[0];
    const r = visible.getBoundingClientRect();
    const max = maxScrollTop(scroller);
    return {
      key: messageKey(adapter, visible),
      text: (visible.textContent || "").trim().slice(0, 160),
      offset: r.top - top,
      ratio: max ? scrollTopOf(scroller) / max : 0,
      fallbackTop: scrollTopOf(scroller)
    };
  }

  function findAnchor(adapter, messages, anchor) {
    let match = messages.find((el) => messageKey(adapter, el) === anchor.key);
    if (!match && anchor.text) {
      match = messages.find((el) => (el.textContent || "").trim().slice(0, 160) === anchor.text);
    }
    return match || null;
  }

  /**
   * Wait for the host to hand over another page.
   *
   * Two things here are load-bearing. The observer is scoped to the message
   * container rather than body+subtree: these apps mutate constantly (timers,
   * tooltips, their own rails) and re-running a document-wide
   * querySelectorAll('[data-message-id]') on every one of those batches was the
   * bulk of the walk's cost. And the scroll position is re-pinned inside the
   * callback — a microtask, so on a host that anchors scroll when it prepends,
   * the correction lands before that frame is laid out instead of being
   * discovered on the next iteration as a full-viewport yank.
   */
  function waitForHistoryChange(adapter, before, task, scroller, budget) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (changed) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(changed);
      };
      const observer = new MutationObserver(() => {
        if (task.cancelled || task.route !== location.href) return finish(false);
        if (scroller && scrollTopOf(scroller) > TOP_EPSILON) moveTo(scroller, 0);
        let next = before;
        try { next = signature(adapter, adapter.messages()); } catch (_) {}
        if (next !== before) finish(true);
      });
      let container = null;
      try { container = (adapter.messages()[0] || {}).parentElement || null; } catch (_) {}
      if (container && container.isConnected) observer.observe(container, { childList: true });
      else observer.observe(document.body, { childList: true, subtree: true });
      const timeout = setTimeout(() => finish(false), budget || STEP_TIMEOUT);
    });
  }

  /** Median of the observed page latencies — one host's pace, not a constant. */
  function stepBudget(samples) {
    if (!samples.length) return STEP_TIMEOUT;
    const sorted = samples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    return Math.max(STEP_FLOOR, Math.min(STEP_TIMEOUT, Math.round(median * 3)));
  }

  /**
   * Ask the host for pages until `until()` says stop or it stops answering.
   * Shared by the full walk and by a targeted seek; the only difference between
   * them is where they stop and whether they put the reader back afterwards.
   *
   * @returns {"reached"|"exhausted"|"ceiling"|"cancelled"} — "exhausted" means
   *   the host stopped answering, which is the only honest proof we reached the
   *   first turn. "ceiling" means we ran out of time and there is more up there.
   */
  async function pageUp(adapter, task, scroller, opts) {
    const until = opts.until || (() => false);
    const onStep = opts.onStep || (() => {});
    let previous = "";
    try { previous = signature(adapter, adapter.messages()); } catch (_) {}
    let stalled = 0;
    let progressed = false;
    const samples = [];
    const deadline = Date.now() + CEILING_MS;

    while (!task.cancelled && task.route === location.href) {
      if (until()) return "reached";
      if (Date.now() >= deadline) return "ceiling";
      // Some virtualizers page only on an actual scroll event, and once a page
      // has been prepended we are already at zero. 1px, and NOT awaited: both
      // writes land in one task so both scroll events dispatch while nothing
      // intermediate is ever painted. The old 24px + await pause(16) guaranteed
      // a painted frame at the wrong position on every single iteration.
      if (scrollTopOf(scroller) <= TOP_EPSILON && maxScrollTop(scroller) > TOP_EPSILON) {
        moveTo(scroller, 1);
      }
      moveTo(scroller, 0);

      const startedAt = Date.now();
      const changed = await waitForHistoryChange(adapter, previous, task, scroller, stepBudget(samples));
      if (task.cancelled || task.route !== location.href) return "cancelled";

      let next = previous;
      try { next = signature(adapter, adapter.messages()); } catch (_) { return "exhausted"; }
      if (changed || next !== previous) {
        if (samples.length < 12) samples.push(Math.max(1, Date.now() - startedAt));
        previous = next;
        stalled = 0;
        progressed = true;
        onStep();
      } else if (++stalled >= (progressed ? STALL_LIMIT : 2) && scrollTopOf(scroller) <= TOP_EPSILON) {
        return until() ? "reached" : "exhausted";
      }
    }
    return task.cancelled ? "cancelled" : "exhausted";
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function setStatus(status) {
    document.documentElement.dataset.lctHistoryState = status;
  }

  function setSeekStatus(status) {
    document.documentElement.dataset.lctSeekState = status;
  }

  /* ---------- the progress pill ----------
     Paging a long conversation moves the page, and there is no way around that:
     a host only fetches older turns when its scroller is genuinely at the top,
     and the browser paints that. What we CAN do is never let it look like a
     malfunction — say what is happening, with a real number, and offer a stop. */

  let pill = null, pillCancel = null;

  function showPill(text, onCancel) {
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "lct-seek";
      pill.innerHTML = '<span class="lct-seek-text"></span><button type="button" class="lct-seek-stop">Stop</button>';
      pill.querySelector(".lct-seek-stop").addEventListener("click", () => {
        if (pillCancel) pillCancel();
      });
      document.documentElement.appendChild(pill);
    }
    if (!pill.isConnected) document.documentElement.appendChild(pill);
    pillCancel = onCancel || pillCancel;
    pill.querySelector(".lct-seek-text").textContent = text;
    pill.classList.add("lct-seek-show");
  }

  function hidePill() {
    pillCancel = null;
    if (pill) pill.classList.remove("lct-seek-show");
  }

  const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  function mountedCount(adapter) {
    try { return adapter.messages().length; } catch (_) { return 0; }
  }

  function walkLabel(adapter) {
    const total = self.LCTMinimap ? self.LCTMinimap.count : 0;
    const have = mountedCount(adapter);
    return total > have
      ? `Loading older messages… ${commas(have)} of ${commas(total)}`
      : `Loading older messages… ${commas(have)}`;
  }

  function attachCancellation(task) {
    // The minimap click that STARTS a seek is itself a pointerdown, and this
    // listens in capture phase — without the guard a seek cancels itself in the
    // same tick it began. Our own controls are never a reason to stand down.
    const cancel = (e) => {
      const t = e && e.target;
      if (t && t.closest && t.closest('[id^="lct-"]')) return;
      task.cancelled = true;
    };
    task.cancel = cancel;
    // Capture phase catches a wheel/touch on the host scroller before React
    // swallows it. Keyboard navigation is intentionally an immediate cancel.
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, cancel, { capture: true, passive: true });
    }
    task.detach = () => {
      for (const type of INPUT_EVENTS) {
        window.removeEventListener(type, cancel, true);
      }
    };
  }

  async function restoreAnchor(adapter, scroller, anchor, task) {
    // Ask the host to remount around the old reading position before resolving
    // the semantic anchor. This fallback matters when the virtualizer discarded
    // the original node while we were at the top.
    moveTo(scroller, maxScrollTop(scroller) * anchor.ratio || anchor.fallbackTop);
    for (let attempt = 0; attempt < 8 && !task.cancelled; attempt++) {
      await pause(90);
      let messages = [];
      try { messages = adapter.messages(); } catch (_) { return; }
      const el = findAnchor(adapter, messages, anchor);
      if (!el || !el.isConnected) continue;
      el.scrollIntoView({ behavior: "auto", block: "start" });
      const drift = el.getBoundingClientRect().top - viewportTop(scroller) - anchor.offset;
      if (Math.abs(drift) > 2) moveTo(scroller, scrollTopOf(scroller) + drift);
      return;
    }
  }

  async function run(adapter, route) {
    const task = active;
    if (!task || task.route !== route) return;
    if (task.cancelled) return finish(task, "cancelled");

    let messages = [];
    try { messages = adapter.messages(); } catch (_) { return finish(task, "idle"); }
    if (messages.length < 2) return finish(task, "idle");

    const scroller = self.LCTAdapters.findScroller(messages[0]);
    if (!scroller) return finish(task, "idle");
    if (maxScrollTop(scroller) <= TOP_EPSILON) {
      // The host can finish its first layout after document_idle. Probe a few
      // times before deciding this is a genuinely short, non-scrollable chat.
      if (++task.probes < 6 && !task.cancelled) {
        task.timer = setTimeout(() => run(adapter, route), 300);
        return;
      }
      completedRoutes.add(route);
      return finish(task, "complete");
    }
    /* Sitting at scrollTop 0 is NOT proof we reached the first turn — it is
       where the previous step left us, waiting on the host to prepend the next
       page. Treating it as "done" made an interrupted crawl resume, look at the
       0 it had parked on, and declare the conversation fully loaded. The loop
       below is what decides: it nudges, asks for another page, and only stops
       when the host stops answering. */

    task.scroller = scroller;
    task.anchor = captureAnchor(adapter, messages, scroller);
    setStatus("running");

    const outcome = await pageUp(adapter, task, scroller, {
      onStep: () => showPill(walkLabel(adapter))
    });
    const exhausted = outcome === "ceiling";
    hidePill();

    if (!task.cancelled && task.route === location.href) {
      await restoreAnchor(adapter, scroller, task.anchor, task);
      // Only a stall at the top proves we reached the first turn. Hitting the
      // ceiling means there is more history up there — leave the door open.
      if (exhausted) {
        finish(task, "partial");
        scheduleResume(adapter, route);
      } else {
        completedRoutes.add(route);
        finish(task, "complete");
      }
    } else {
      // A human chose the next scroll position. Never snap them back — but the
      // backfill is still unfinished, so try again once they settle.
      finish(task, "cancelled");
      scheduleResume(adapter, route);
    }
  }

  /**
   * A cancelled crawl used to be permanent: one stray scroll during the walk
   * and that conversation never backfilled again. Wait for the reader to go
   * quiet, then pick up from wherever the host is now.
   */
  function scheduleResume(adapter, route) {
    const used = resumeCounts.get(route) || 0;
    if (used >= MAX_RESUMES || completedRoutes.has(route)) return;
    resumeCounts.set(route, used + 1);

    let timer = null;
    const detach = () => {
      clearTimeout(timer);
      for (const type of INPUT_EVENTS) window.removeEventListener(type, arm, true);
    };
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(go, IDLE_RESUME_MS);
    }
    function go() {
      detach();
      if (active || completedRoutes.has(route) || location.href !== route) return;
      const task = { route, cancelled: false, detach: null, timer: null, probes: 0 };
      active = task;
      attachCancellation(task);
      run(adapter, route);
    }
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, arm, { capture: true, passive: true });
    }
    arm();
  }

  function finish(task, status) {
    clearTimeout(task.timer);
    if (task.detach) task.detach();
    if (active === task) active = null;
    setStatus(status);
  }

  function begin(adapter, delay) {
    const route = location.href;
    if (active && active.route === route) return false;
    if (active) {
      active.cancelled = true;
      finish(active, "cancelled");
    }
    startedRoutes.add(route);
    const task = { route, cancelled: false, detach: null, timer: null, probes: 0 };
    active = task;
    // Start listening immediately. If the reader touches the page during the
    // settling delay, respect that choice instead of starting a late crawl.
    attachCancellation(task);
    // Give the host's own route/open auto-scroll a chance to settle. There is
    // no visible animation here: the only movement is the host's native paging.
    task.timer = setTimeout(() => run(adapter, route), delay);
    return true;
  }

  /** Auto path. Off unless settings.history says otherwise — see the header. */
  function maybeStart(adapter, messages) {
    if (!autoAllowed) return;
    const route = location.href;
    if (!supported(adapter) || !messages || messages.length < 2 || startedRoutes.has(route)) return;
    begin(adapter, 700);
  }

  /** The reader asked for it. Redo even a route we already walked. */
  function start(adapter) {
    if (!supported(adapter)) return false;
    const route = location.href;
    completedRoutes.delete(route);
    resumeCounts.delete(route);
    return begin(adapter, 0);
  }

  function setAuto(on) { autoAllowed = !!on; }

  /**
   * Page the host upward until ONE specific message is mounted.
   *
   * Deliberately not `run()`: there is no anchor restore, because the reader
   * asked to go somewhere else and snapping them back is the bug. It stops the
   * moment the target appears rather than walking to the first turn, and it
   * says how far along it is — a number we only have because the provider index
   * told us how long the conversation actually is.
   *
   * @param {object} target { id, index, total, arrive() }
   */
  function seekTo(adapter, target) {
    if (!adapter || !target || !target.id) return false;
    if (active) { active.cancelled = true; finish(active, "cancelled"); }

    const route = location.href;
    const task = { route, cancelled: false, detach: null, timer: null, probes: 0 };
    active = task;
    attachCancellation(task);
    setSeekStatus("running");

    /* The seek target comes from the provider's own index, so it is a provider
       id — match it against the same id probe the walk uses rather than
       against data-message-id alone. That attribute is ChatGPT's spelling of
       an id, not every host's, and hardcoding it here is what confined seek to
       ChatGPT even once the walk itself was general. */
    const found = () => {
      try {
        const direct = document.querySelector('[data-message-id="' + CSS.escape(target.id) + '"]');
        if (direct) return direct;
        return adapter.messages().find((el) => adapter.stableKey(el) === target.id) || null;
      } catch (_) { return null; }
    };

    const label = () => {
      const have = mountedCount(adapter);
      const total = target.total || (self.LCTMinimap ? self.LCTMinimap.count : 0);
      return total > have
        ? `Loading older messages… ${commas(have)} of ${commas(total)}`
        : `Loading older messages… ${commas(have)}`;
    };

    (async () => {
      let messages = [];
      try { messages = adapter.messages(); } catch (_) { /* selector drift */ }
      const scroller = messages.length ? self.LCTAdapters.findScroller(messages[0]) : null;
      if (!scroller) { finish(task, "idle"); setSeekStatus("done"); return; }

      showPill(label(), () => { task.cancelled = true; });
      const outcome = await pageUp(adapter, task, scroller, {
        until: () => !!found(),
        onStep: () => showPill(label())
      });
      hidePill();
      if (active === task) finish(task, outcome === "cancelled" ? "cancelled" : "complete");
      setSeekStatus(outcome === "reached" ? "done" : outcome === "cancelled" ? "cancelled" : "exhausted");

      if (outcome === "cancelled") return;
      // Even when the host ran out of history, land on the oldest row it gave
      // us rather than leaving the reader parked at the top with nothing
      // selected — and say plainly that this is as far back as it goes.
      if (target.arrive) target.arrive(outcome === "reached");
    })();
    return true;
  }

  function stop() {
    if (!active) return;
    active.cancelled = true;
    clearTimeout(active.timer);
    finish(active, "cancelled");
  }

  self.LCTHistoryLoader = {
    maybeStart, start, stop, setAuto, supported, seekTo,
    get active() { return !!active; }
  };
})();
