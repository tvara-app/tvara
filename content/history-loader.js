/**
 * Tvara — virtual-history backfill.
 *
 * ChatGPT mounts only the recent tail of a long conversation. This walks its
 * native scroller to the oldest available turn so every turn the host exposes
 * is mounted, then returns to the reader's exact anchor.
 *
 * It never starts in front of a reader. Paging a 1,500-turn conversation is
 * sixty round trips of the host yanking its own scroller to the top, and doing
 * that unannounced while someone is reading is indistinguishable from the page
 * being broken — which is exactly how it read. Full-text history comes from
 * the background sync and the map from the provider index, neither of which
 * touches the page, so this walk is only ever for putting the messages
 * THEMSELVES back: the ⤒ button, or settings.history.
 *
 * The automatic path does both, and neither is something a reader watches.
 * mountArchive() renders the older turns straight from the copy already on this
 * machine, so nothing is scrolled at all. The walk is the fallback for a chat
 * the archive does not have, and it runs behind makeFreeze(): a still clone of
 * the scroller covers it, so the host is parked at the top while the reader
 * keeps seeing the exact pixels they were looking at. Any input stands it down.
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
  /* Let the host's own route/open auto-scroll land before walking on top of it.
     The arm path went straight to 0 and raced it. */
  const SETTLE_MS = 700;
  /* A background-only walk is chopped into tab-away stints, so a long
     conversation legitimately needs many. Only a reader interrupting spends
     one — the tab coming forward is the design working, not a fight. */
  const MAX_RESUMES = 40;
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

  function makeFreeze(scroller) {
    /* A transform that cancels the scroll out is the tidier idea and it does
       not survive contact with these hosts: parked at the top, ChatGPT
       UNMOUNTS the turns the reader was looking at, so there is nothing left
       to hold still. Measured on a real conversation, the anchor drifted 48,810
       pixels because for most of the walk it did not exist.

       So keep a copy instead. A still clone of the scroller sits exactly where
       the scroller is, the scroller itself goes visibility:hidden — still laid
       out, still scrollable, still measurable, just not painted — and the walk
       runs underneath it. The reader's screen is not merely stable, it is the
       same pixels. It is inert for the duration, which is why any input at all
       stands the walk down and hands the live page straight back. */
    if (!scroller || !scroller.getBoundingClientRect) return null;
    const box = scroller.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    let ghost;
    try { ghost = scroller.cloneNode(true); } catch (_) { return null; }
    const shell = document.createElement("div");
    const style = getComputedStyle(scroller);
    const ground = style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)"
      ? style.backgroundColor
      : getComputedStyle(document.body).backgroundColor || "";
    shell.id = "lct-freeze";
    shell.setAttribute("aria-hidden", "true");
    shell.style.cssText = "position:fixed;overflow:hidden;pointer-events:none;" +
      "z-index:2147483000;contain:strict;" +
      "left:" + box.left + "px;top:" + box.top + "px;" +
      "width:" + box.width + "px;height:" + box.height + "px;" +
      (ground ? "background:" + ground + ";" : "");
    ghost.removeAttribute("id");
    ghost.style.width = box.width + "px";
    ghost.style.height = box.height + "px";
    ghost.style.margin = "0";
    ghost.style.boxSizing = "border-box";
    /* Do NOT force overflow:hidden here. The clone keeps the original's classes
       so it keeps its overflow, and that matters: taking the scrollbar away
       hands the content ~15px more width, a centred message column reflows into
       it, and the freeze announces itself as a flash of re-wrapped text at both
       ends. The gutter has to be there for the copy to be a copy. */
    ghost.style.overflowX = "hidden";
    ghost.style.scrollbarGutter = getComputedStyle(scroller).scrollbarGutter || "";
    shell.appendChild(ghost);
    document.documentElement.appendChild(shell);
    // After insertion: a detached node has no scrollable extent to set.
    ghost.scrollTop = scrollTopOf(scroller);
    const previous = scroller.style.visibility;
    scroller.style.visibility = "hidden";
    let live = true;
    const release = () => {
      if (!live) return;
      live = false;
      clearTimeout(deadman);
      scroller.style.visibility = previous;
      shell.remove();
    };
    /* A scroller left visibility:hidden is a blank page, so nothing may be able
       to reach release() and fail to call it: not a thrown error, not a route
       change, not a walk that runs long. */
    const deadman = setTimeout(release, CEILING_MS + 15000);
    return { correct() {}, release };
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
  function waitForHistoryChange(adapter, before, task, scroller, budget, lock) {
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
        if (lock) lock.correct();
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
      if (opts.lock) opts.lock.correct();

      const startedAt = Date.now();
      const changed = await waitForHistoryChange(adapter, previous, task, scroller, stepBudget(samples), opts.lock);
      if (task.cancelled || task.route !== location.href) return "cancelled";

      let next;
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

  /* `(\d{3})+` inside a lookahead is the textbook catastrophic-backtracking
     regex. The input here is a message count so it can never be long enough to
     matter — but the platform does this correctly and for free, so there is no
     reason to keep a hand-rolled one that a reader has to reason about. */
  const commas = (n) => Number(n).toLocaleString("en-US");

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
      task.cancelledBy = "input";     // they chose a position; keep it
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
      let messages;
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

    let messages;
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

    /* Locked while anyone can see it. The walk itself is unchanged — the host
       still goes to the top sixty times — but the reader's screen holds still
       through all of it, so there is nothing to wait for a background tab for.
       A hidden tab needs no lock and pays no transform for one. */
    const lock = document.hidden ? null : makeFreeze(scroller);
    task.lock = lock;

    // Show the pill BEFORE the first page, and with a cancel — the only
    // showPill in this path used to come from onStep, which passes no handler,
    // so the Stop button sat there attached to nothing. The automatic walk gets
    // none: it does not move the page, so there is nothing to explain and
    // nothing for a Stop button to save them from.
    const announce = !task.auto;
    if (announce) {
      showPill(walkLabel(adapter), () => {
        task.cancelled = true;
        task.cancelledBy = "stop";
      });
    }
    const outcome = await pageUp(adapter, task, scroller, {
      onStep: () => { if (announce) showPill(walkLabel(adapter)); },
      lock
    });
    const exhausted = outcome === "ceiling";
    hidePill();
    /* Put them back BEFORE the copy comes down: every one of those attempts
       happens behind the freeze, so the only frame anyone sees is the last
       one, already correct. */
    if (lock) await restoreAnchor(adapter, scroller, task.anchor, { cancelled: false });
    if (lock) lock.release();
    task.lock = null;
    const held = !!lock;

    if (!task.cancelled && task.route === location.href) {
      if (!held) await restoreAnchor(adapter, scroller, task.anchor, task);
      // Only a stall at the top proves we reached the first turn. Hitting the
      // ceiling means there is more history up there — leave the door open.
      if (exhausted) {
        finish(task, "partial");
        scheduleResume(adapter, route, { auto: task.auto });
      } else {
        completedRoutes.add(route);
        finish(task, "complete");
      }
    } else {
      // A human chose the next scroll position. Never snap them back — unless
      // we are the reason the walk stopped (Stop, or the tab coming back into
      // view), in which case their old place is exactly what to hand back.
      if (!held && task.cancelledBy && task.cancelledBy !== "input" && task.route === location.href) {
        await restoreAnchor(adapter, scroller, task.anchor, { cancelled: false });
      }
      finish(task, "cancelled");
      // Coming back to the tab is not the reader fighting the walk, so it must
      // not spend one of their resumes — a long conversation is walked across
      // however many tab-away stints it takes.
      scheduleResume(adapter, route,
        { auto: task.auto, charge: task.cancelledBy !== "visible" });
    }
  }

  /**
   * A cancelled crawl used to be permanent: one stray scroll during the walk
   * and that conversation never backfilled again. Wait for the reader to go
   * quiet, then pick up from wherever the host is now.
   */
  function scheduleResume(adapter, route, opts) {
    const auto = !opts || opts.auto !== false;
    const charge = !opts || opts.charge !== false;
    const used = resumeCounts.get(route) || 0;
    if (used >= MAX_RESUMES || completedRoutes.has(route)) return;
    if (charge) resumeCounts.set(route, used + 1);

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
      // The resume is the same page-yank as the first attempt, so it waits for
      // the same quiet moment. Without this, scrolling away from a walk bought
      // 2.5s of reading before the page snapped back to the top — five times.
      /* Only the automatic walk owes anyone a hidden tab. A resume of the ⤒
         walk is finishing a job somebody asked for out loud, with the pill and
         its Stop button still on screen — making that one wait for a
         background tab abandons it silently instead. */
      /* `&& !canFreeze()` used to guard this and could never be true — it
         tested for ParentNode.append, which predates the oldest browser this
         extension loads on. So the auto resume walked a page somebody was
         looking at, with announce=false meaning no pill and no Stop. */
      if (auto && !backgrounded()) return armPending(adapter, route);
      const task = { route, cancelled: false, cancelledBy: "", auto, detach: null, timer: null, probes: 0 };
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
    /* visibilitychange is the only other thing that calls tryPending, and it has
       already fired by the time a task ends. A seek that started visible and
       finished hidden therefore left its arm with nothing to wake it, and a tab
       parked in the background — the whole point of a background-only walk —
       waited on it forever. Deferred a turn because begin() finishes the
       outgoing task BEFORE claiming `active`, and a synchronous call here would
       re-enter begin() underneath it. */
    if (!active) setTimeout(tryPending, 0);
  }

  function begin(adapter, delay, auto) {
    const route = location.href;
    if (active && active.route === route) return false;
    if (active) {
      active.cancelled = true;
      finish(active, "cancelled");
    }
    startedRoutes.add(route);
    const task = { route, cancelled: false, cancelledBy: "", auto: !!auto, detach: null, timer: null, probes: 0 };
    active = task;
    // Start listening immediately. If the reader touches the page during the
    // settling delay, respect that choice instead of starting a late crawl.
    attachCancellation(task);
    // Give the host's own route/open auto-scroll a chance to settle. There is
    // no visible animation here: the only movement is the host's native paging.
    task.timer = setTimeout(() => run(adapter, route), delay);
    return true;
  }

  /* ---------- never move a page somebody is looking at ----------
     A host hands over older turns only when its own scroller is genuinely at
     the top, and the browser paints that: there is no invisible version of
     this walk while the tab is on screen. So the automatic one runs only while
     the tab is hidden, and gives the page back inside the visibilitychange
     handler the moment it is not.

     "Already scrolled near the top" was the other half of this test and it was
     wrong: reading backwards through old turns is still reading, and the walk
     answered that by taking the scroller for sixty round trips.

     Opening a long chat therefore leaves the page where the site put it, and
     keeps it there for as long as anyone is watching. Nothing is lost by
     waiting: the map is seeded from the provider's own index and the full text
     comes from the background sync, and neither of those touches the page at
     all. The ⤒ button is unchanged — that one was asked for, out loud, by
     someone watching. */
  /* One arm per route, not one arm in total. A single slot survived only while
     every arm was consumed immediately: open chat A, then chat B, and B's arm
     overwrote A's — while maybeStart had already stamped A into startedRoutes on
     the way past, so nothing could ever arm it again. Going back to A then found
     a route marked handled, waiting on an arm that no longer existed, and the
     next tab-hide dropped B's too. Both chats stranded, permanently. */
  const pending = new Map();        // route -> adapter, waiting for the tab to go away

  function backgrounded() {
    return document.hidden;
  }

  /* Deliberately observable, on its own key rather than lctHistoryState — the
     arm is not a walk state, and B2c1 asserts that lctHistoryState never moves.
     Without this the arm is invisible from outside: a walk that correctly
     declined to run and a walk whose arm was silently dropped look identical,
     which is exactly how two regressions got past a suite that only ever
     asserted the refusal. */
  function noteArmed() {
    document.documentElement.dataset.lctHistoryArmed = String(pending.size);
  }

  function clearPending(route) {
    if (route === undefined) pending.clear();
    else pending.delete(route);
    noteArmed();
  }

  function armPending(adapter, route) {
    // Nothing to subscribe to: visibilitychange is the only event that can make
    // a pending route eligible, and it is already wired below.
    pending.set(route, adapter);
    noteArmed();
  }

  function tryPending() {
    if (active) return;
    const route = location.href;
    const adapter = pending.get(route);
    if (!adapter) return;
    /* Re-checked here, not just at arm time: an arm can outlive the setting that
       made it. applyState re-runs on an entitlement change as well as a settings
       one, and both land as setAuto(false) without touching this map. */
    if (!autoAllowed || completedRoutes.has(route)) return clearPending(route);
    if (!backgrounded()) return;
    clearPending(route);
    begin(adapter, SETTLE_MS, true);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { tryPending(); return; }
    const task = active;
    if (!task || !task.auto || task.cancelled) return;
    /* Back in front of somebody. Put the page where they left it HERE — a
       visibilitychange handler runs before the frame is painted, so the top
       the walk was parked on is never a thing they see. run() follows with the
       precise restore a moment later. */
    task.cancelled = true;
    task.cancelledBy = "visible";
    hidePill();
    // A walk that was running hidden has no lock, so the page really is at the
    // top and this is the only thing standing between them and seeing it.
    if (task.scroller && task.anchor) moveTo(task.scroller, task.anchor.fallbackTop);
    if (task.lock) { task.lock.release(); task.lock = null; }
  });

  /* ---------- putting the older turns back WITHOUT moving anything ----------
     The walk exists because the host mounts only its recent tail. But the whole
     conversation is already on this machine and was never scrolled for: bg.js
     pulls it from the provider's own /backend-api/conversation endpoint and the
     archive keeps it. So the older turns can simply be RENDERED — our own nodes,
     above the host's list, inserted with the scroll paid for in the same task so
     the reader's view does not shift by a pixel.

     This is what settings.history does now. No scroller is touched, so there is
     no movement to hide, no freeze, and no waiting for a background tab. The
     walk stays for the ⤒ button alone, where somebody asked for it. */
  const MOUNT_ID = "lct-old-turns";
  const mountedRoutes = new Set();

  /* Ids AND text, because the archive does not always have ids. Records written
     by the page-side path store an empty `i` for every message, and a cut that
     trusted ids alone read a 55-message conversation as having nothing older
     than the seven turns on screen. Text is the fallback the rest of this file
     already uses (see messageKey) and it is a good key here: these are settled
     messages, not one streaming in. */
  const textKey = (s) => String(s || "").trim().slice(0, 160);

  function mountedKeys(adapter, messages) {
    const ids = new Set(), texts = new Set();
    for (const el of messages) {
      let key = "";
      try { key = adapter.stableKey(el) || ""; } catch (_) { /* selector drift */ }
      if (key) ids.add(key);
      const t = textKey(el.textContent);
      if (t) texts.add(t);
    }
    return {
      has(m) {
        if (m.i && ids.has(m.i)) return true;
        const t = textKey(m.t);
        return !!t && texts.has(t);
      }
    };
  }

  /* Same contract as lctHistoryState: one attribute saying what happened, so a
     failure is legible from outside without a debugger attached. */
  function setMountStatus(status, route) {
    const tries = route ? mountTries.get(route) || 0 : 0;
    document.documentElement.dataset.lctMountState = tries ? status + "#" + tries : status;
  }

  const MOUNT_RETRIES = 6;
  const MOUNT_RETRY_MS = 5000;
  const mountTries = new Map();

  function retryMount(adapter, route, afterMs) {
    const used = mountTries.get(route) || 0;
    if (used >= MOUNT_RETRIES) return;
    mountTries.set(route, used + 1);
    // The provider's own Retry-After wins over our backoff when it says longer:
    // retrying inside a 429's window just spends the next one.
    const wait = Math.max(MOUNT_RETRY_MS * (used + 1), Number(afterMs) || 0);
    const again = () => {
      if (location.href !== route) return;
      mountedRoutes.delete(route);
      mountArchive(adapter);
    };
    setTimeout(again, Math.min(wait, 120000));
  }

  async function mountArchive(adapter) {
    const route = location.href;
    setMountStatus("working");
    const stale = document.getElementById(MOUNT_ID);
    if (stale && stale.dataset.lctRoute !== route) stale.remove();
    if (mountedRoutes.has(route)) return false;

    let messages;
    try { messages = adapter.messages(); } catch (_) { return setMountStatus("no-messages"), false; }
    if (!messages || !messages.length) return setMountStatus("no-messages"), false;
    const scroller = self.LCTAdapters.findScroller(messages[0]);
    if (!scroller) return setMountStatus("no-scroller"), false;

    /* The archive first, because it costs nothing and is usually already there.
       A conversation nobody has synced yet is NOT a dead end: chat-index fetches
       it from the provider's own endpoint and imports it, so asking twice with
       an index call in between turns "not archived" into "archived a moment
       ago". Neither call touches the page. */
    /* Bounded. A host in its rate-limit cooldown does not refuse the request,
       it PARKS it — bg.js sleeps the whole host until the window expires, which
       is up to fifteen minutes of a status that says "working" and a reader with
       no idea anything is wrong. Time it out, say so, and come back later. */
    const ASK_TIMEOUT_MS = 12000;
    const once = (type, extra) => Promise.race([
      chrome.runtime.sendMessage(
        Object.assign({ type, host: location.host, path: location.pathname }, extra)
      ).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve({ status: "slow" }), ASK_TIMEOUT_MS))
    ]);
    /* An MV3 worker is torn down between messages and a request that arrives
       mid-teardown rejects rather than waking it. One immediate retry is the
       difference between "no archive" and the archive that was there all along. */
    const ask = async (type, extra) => {
      const first = await once(type, extra);
      if (first) return first;
      await new Promise((r) => setTimeout(r, 400));
      return once(type, extra);
    };

    let reply = await ask("chat-mount");
    if (!reply || reply.status !== "ok" || !Array.isArray(reply.msgs) || !reply.msgs.length) {
      // foreground: this is the chat in front of them, not the bulk sync.
      const idx = await ask("chat-index", { force: false, foreground: true });
      if (!idx || (idx.status !== "ok" && idx.status !== "fresh")) {
        /* "rate" and the network kinds are the provider saying not now, not
           saying no. Giving up for the whole route on one of those is how a
           conversation ends up permanently missing its older turns over a
           refusal that expired seconds later. */
        setMountStatus("index:" + ((idx && idx.status) || "none"), route);
        retryMount(adapter, route, idx && idx.retryAfterMs);
        return false;
      }
      if (location.href !== route) return setMountStatus("route-changed"), false;
      reply = await ask("chat-mount");
    }
    if (!reply || reply.status !== "ok" || !Array.isArray(reply.msgs)) {
      setMountStatus("mount:" + ((reply && reply.status) || "none"), route);
      retryMount(adapter, route);
      return false;
    }
    if (location.href !== route || document.getElementById(MOUNT_ID)) {
      return setMountStatus("superseded"), false;
    }

    // Re-read after the await: the host may have mounted more in the meantime.
    try { messages = adapter.messages(); } catch (_) { return setMountStatus("no-messages"), false; }
    if (!messages.length) return setMountStatus("no-messages"), false;
    /* Everything before the EARLIEST turn the host currently holds. Breaking at
       the first mounted id looked equivalent and is not: the host does not
       always mount a clean tail, and one id landing early made the whole thing
       decide there was nothing older. Find where its window starts, take what
       is above it. */
    const have = mountedKeys(adapter, messages);
    let cut = reply.msgs.length;
    for (let n = 0; n < reply.msgs.length; n++) {
      if (reply.msgs[n] && have.has(reply.msgs[n])) { cut = n; break; }
    }
    const older = reply.msgs.slice(0, cut).filter((m) => m && (m.t || m.i) && !have.has(m));
    if (!older.length) { mountedRoutes.add(route); return setMountStatus("nothing-older"), false; }

    const block = document.createElement("div");
    block.id = MOUNT_ID;
    block.dataset.lctRoute = route;
    for (const m of older) {
      const row = document.createElement("article");
      row.className = "lct-old";
      row.dataset.lctOld = m.r === "user" ? "user" : "assistant";
      /* NOT data-message-id: every adapter selects on that, and claiming these
         are the host's own turns would have the minimap, the outline and the
         engine all counting rows the host has never heard of. */
      if (m.i) row.dataset.lctTurnId = m.i;
      const who = document.createElement("div");
      who.className = "lct-old-who";
      who.textContent = m.r === "user" ? "You" : "Assistant";
      const body = document.createElement("div");
      body.className = "lct-old-text";
      body.textContent = m.t || "";      // archived text is data, never markup
      row.append(who, body);
      block.appendChild(row);
    }

    /* Inserted as a child of the SCROLLER, not of the host's list: React
       reconciles its own container's children and has been known to throw on a
       foreign node inside it. And inserting above the reader is itself a page
       move unless it is paid for in the same task — the browser keeps scrollTop,
       so everything they were reading would drop by the height we just added. */
    const before = scrollTopOf(scroller);
    scroller.insertBefore(block, scroller.firstChild);
    const added = Math.round(block.getBoundingClientRect().height);
    if (added > 0) moveTo(scroller, before + added);
    mountedRoutes.add(route);
    setMountStatus("mounted:" + older.length);
    return true;
  }

  /** Auto path. Off unless settings.history says otherwise — see the header. */
  function maybeStart(adapter, messages) {
    if (!autoAllowed) return;
    const route = location.href;
    if (!supported(adapter) || !messages || messages.length < 2 || startedRoutes.has(route)) return;
    startedRoutes.add(route);
    /* Two ways up, both automatic, tried together.

       The archive: the whole conversation is already on this machine and was
       never scrolled for, so the older turns are rendered above the host's
       list. Nothing moves at all.

       And the walk, because the archive is not always there — a chat nobody has
       synced, a provider with no endpoint — and "sometimes" is not the feature.
       The walk parks the host's scroller at the top, which is the only way it
       hands over older turns, and there is no invisible version of that while
       the tab is on screen. So it is ARMED here, not started: it runs when the
       tab goes away, per "never move a page somebody is looking at" above.
       Calling begin() here instead took the scroller 700ms after a chat opened,
       which is the exact report that comment was written for. */
    const arm = () => {
      armPending(adapter, route);
      // A chat opened in a tab that is already hidden has no visibilitychange
      // coming to start it, and would otherwise wait for one forever.
      tryPending();
    };
    // Only a mount that actually rendered older turns makes the walk redundant;
    // every other outcome is the "sometimes" above and still needs the fallback.
    // Also the only .catch this call has ever had — an insertBefore that throws
    // was an unhandled rejection that took the arm down with it.
    mountArchive(adapter).then((mounted) => { if (!mounted) arm(); }, arm);
  }

  /** The reader asked for it. Redo even a route we already walked. */
  function start(adapter) {
    if (!supported(adapter)) return false;
    const route = location.href;
    completedRoutes.delete(route);
    resumeCounts.delete(route);
    clearPending();
    return begin(adapter, 0, false);
  }

  function setAuto(on) {
    autoAllowed = !!on;
    /* Assignment alone stranded live arms. applyState calls setAuto(false) when
       History is unticked or the entitlement lapses, but stop() — the only other
       thing that clears an arm — runs only when the WHOLE extension is switched
       off, so a switched-off feature still walked on the next tab-hide. */
    if (!autoAllowed) clearPending();
  }

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
    const task = { route, cancelled: false, cancelledBy: "", auto: false, detach: null, timer: null, probes: 0 };
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

      showPill(label(), () => { task.cancelled = true; task.cancelledBy = "stop"; });
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
    clearPending();
    if (!active) return;
    active.cancelled = true;
    clearTimeout(active.timer);
    finish(active, "cancelled");
  }

  self.LCTHistoryLoader = {
    maybeStart, start, stop, setAuto, supported, seekTo, mountArchive,
    get active() { return !!active; }
  };
})();
