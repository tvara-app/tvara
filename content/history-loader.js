/**
 * Tvara — virtual-history backfill.
 *
 * ChatGPT mounts only the recent tail of a long conversation. This walks its
 * native scroller to the oldest available turn so every turn the host exposes
 * is mounted, then returns to the reader's exact anchor.
 *
 * It never lets a reader SEE it happen. Paging a 1,500-turn conversation is
 * sixty round trips of the host yanking its own scroller to the top, and doing
 * that unannounced while someone is reading is indistinguishable from the page
 * being broken — which is exactly how it read. So it runs behind a freeze, and
 * never in the open. Full-text history comes from the background sync and the
 * map from the provider index, neither of which touches the page, so this walk
 * is only ever for putting the messages THEMSELVES back: the ⤒ button, or
 * settings.history.
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
  /* NO WALL CLOCK. There used to be one — four minutes, then fifteen — and
     every value of it was wrong for somebody: a 1,500-turn conversation at ~25
     turns a page is sixty round trips, and a host that answers slowly spends
     any budget you name. Worse, the stop was reported as "partial", which is
     the whole conversation minus exactly the part somebody scrolled back for.

     The crawl now ends on one signal and one only: the host stopped handing
     over pages (STALL_LIMIT). That is the sole honest proof there is nothing
     older, and it is what "loaded, no matter the size" has to mean. */
  /* Long enough to coalesce one scroll gesture, and nothing more. This is not a
     schedule — it is the debounce that stops a resume from firing between two
     wheel events of the same flick and fighting the reader for the scroller. */
  const IDLE_RESUME_MS = 350;
  /* The host's own open scroll has to land before we walk on top of it, and one
     frame is enough for that: pageUp() re-pins the scroller inside a mutation
     observer callback anyway, so losing the race costs a correction and not a
     page. It used to be 700ms of doing nothing at the exact moment the reader
     is waiting for their conversation. */
  const SETTLE_MS = 0;
  /* How many times a seek re-asks a host that went quiet. High, because each
     round is free unless the page actually grew — the loop below stops on the
     first round that adds nothing. */
  const SEEK_ROUNDS = 40;
  /* No cap. A reader scrolling through a long conversation interrupts the walk
     dozens of times and every one of those is legitimate; a ceiling on it just
     means the conversation stops loading for whoever reads while it works.
     completedRoutes is the only thing that ends a route's resumes, and it is
     set when the host says there is nothing older. */
  const INPUT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

  let active = null;
  let autoAllowed = false;             // settings.history — off unless asked for
  const startedRoutes = new Set();     // auto-start fires once per route
  const completedRoutes = new Set();   // reached the oldest turn — never redo

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
    /* WHICH element gets hidden, and which one gets copied.

       findScroller() falls back to document.scrollingElement whenever a chat
       has no scrollable ancestor of its own, and on that path the naive answer
       is catastrophic: the element to hide is <html>, the freeze shell is a
       CHILD of <html>, so hiding one hides the other and the reader gets a
       blank page for the length of the walk — the exact failure the freeze
       exists to prevent. Cloning <html> also duplicates the entire document,
       our own UI included.

       So on those hosts hide and copy <body> instead. The shell is body's
       sibling, which is what makes it survive, and one viewport of the copy is
       positioned by hand below. */
    const root = rootScroller(scroller);
    const subject = root ? document.body : scroller;
    if (!subject) return null;
    const view = document.documentElement;
    const box = root
      ? { left: 0, top: 0, width: view.clientWidth, height: view.clientHeight }
      : scroller.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    let ghost;
    try { ghost = subject.cloneNode(true); } catch (_) { return null; }
    /* Every id in the copy is a second element answering to a name the page
       already uses, ours included. getElementById returns whichever comes
       first in the document, so a cloned minimap can take over from the real
       one for the length of the walk. */
    try { for (const n of ghost.querySelectorAll("[id]")) n.removeAttribute("id"); }
    catch (_) { /* a copy we cannot walk is still worth showing */ }
    /* A clone of <body> brings whatever it contains back to life: cloned
       scripts run again and cloned iframes load again — grok.com's sandboxed
       about:blank frames logged a blocked-script error for every one. A freeze
       is a picture. Nothing in it needs to run, fetch, or hold a socket. */
    try {
      for (const n of ghost.querySelectorAll("script, iframe, frame, object, embed, noscript, audio, video")) n.remove();
    } catch (_) { /* a copy we cannot walk is still worth showing */ }
    const shell = document.createElement("div");
    const style = getComputedStyle(subject);
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
    ghost.style.margin = "0";
    ghost.style.boxSizing = "border-box";
    if (root) {
      /* The document's own scroll offset has to be paid by hand: the copy is a
         whole page and exactly one viewport of it is meant to show. */
      ghost.style.position = "absolute";
      ghost.style.left = "0";
      ghost.style.top = "-" + scrollTopOf(scroller) + "px";
      ghost.style.height = "auto";
    } else {
      ghost.style.height = box.height + "px";
    }
    /* Do NOT force overflow:hidden here. The clone keeps the original's classes
       so it keeps its overflow, and that matters: taking the scrollbar away
       hands the content ~15px more width, a centred message column reflows into
       it, and the freeze announces itself as a flash of re-wrapped text at both
       ends. The gutter has to be there for the copy to be a copy. */
    ghost.style.overflowX = "hidden";
    ghost.style.scrollbarGutter = style.scrollbarGutter || "";
    shell.appendChild(ghost);
    view.appendChild(shell);
    // After insertion: a detached node has no scrollable extent to set.
    if (!root) ghost.scrollTop = scrollTopOf(scroller);
    const previous = subject.style.visibility;
    subject.style.visibility = "hidden";
    let live = true;
    const release = () => {
      if (!live) return;
      live = false;
      subject.style.visibility = previous;
      shell.remove();
    };
    /* No deadman. It existed because a throw could skip release() and leave a
       blank page; run() now releases in a `finally`, so the only thing a timer
       could still do is fire in the MIDDLE of an honest long walk and hand back
       a page parked at the top — the exact yank the freeze is here to prevent. */
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

    while (!task.cancelled && task.route === location.href) {
      if (until()) return "reached";
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
  /* A hidden tab gets no animation frames, and the fallback walk exists FOR
     hidden tabs: waiting on rAF there parked it until the reader came back —
     the one path that had to work while hidden was the one that could not. */
  const frame = () => new Promise((resolve) => {
    if (document.hidden) { setTimeout(resolve, 16); return; }
    let done = false;
    const settle = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(settle);
    setTimeout(settle, 250);            // …and a tab hidden mid-wait still moves
  });

  /**
   * Wait for the host's own open-scroll to land — by watching it, not by
   * guessing how long it takes.
   *
   * A flat 700ms delay used to sit in begin() for this, and it was wrong in
   * both directions: dead air on a fast host, and still a race on a slow one,
   * which is how the anchor came to be captured mid-scroll and the reader was
   * put back a viewport and a half from where they had been.
   *
   * Bounded in FRAMES, never on a clock. A scroller that will not settle is one
   * somebody is driving, and attachCancellation has already stood us down.
   */
  async function settle(scroller, task) {
    let last = scrollTopOf(scroller);
    let still = 0;
    for (let i = 0; i < 120 && still < 2 && !task.cancelled; i++) {
      await frame();
      const now = scrollTopOf(scroller);
      still = now === last ? still + 1 : 0;
      last = now;
    }
  }

  function setStatus(status) {
    document.documentElement.dataset.lctHistoryState = status;
  }

  function setSeekStatus(status) {
    document.documentElement.dataset.lctSeekState = status;
  }

  /* WHICH message a seek is heading for. Same contract as lctSeekState: one
     attribute, legible from outside without a debugger. It used to be readable
     only from the preview panel's title, so removing that panel took the only
     evidence that clicking the top of the rail really means message #1 —
     at 1,500 messages one pixel row spans three of them, and the snap to the
     first is the whole reason that click works. */
  function setSeekTarget(id) {
    if (id) document.documentElement.dataset.lctSeekTarget = String(id);
    else delete document.documentElement.dataset.lctSeekTarget;
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

    await settle(scroller, task);
    if (task.cancelled || task.route !== location.href) return finish(task, "cancelled");
    // Re-read: the host may have mounted more while its own scroll landed.
    try { messages = adapter.messages(); } catch (_) { return finish(task, "idle"); }
    if (messages.length < 2) return finish(task, "idle");

    task.scroller = scroller;
    task.anchor = captureAnchor(adapter, messages, scroller);

    /* Locked while anyone can see it. The walk itself is unchanged — the host
       still goes to the top sixty times — but the reader's screen holds still
       through all of it, so there is nothing to wait for a background tab for.
       A hidden tab needs no lock and pays no transform for one. */
    const lock = document.hidden ? null : makeFreeze(scroller);
    /* No freeze, and somebody is watching. THE one case the automatic walk may
       not run in: it must never be the reason a page moves under a reader. It
       arms for the next tab-hide instead. The ⤒ walk still goes — that one was
       asked for out loud and carries the pill and its Stop button. */
    if (!lock && !document.hidden && task.auto) {
      armPending(adapter, route);
      return finish(task, "idle");
    }
    setStatus("running");
    task.lock = lock;

    // Show the pill BEFORE the first page, and with a cancel — the only
    // showPill in this path used to come from onStep, which passes no handler,
    // so the Stop button sat there attached to nothing. The automatic walk gets
    // none: it does not move the page, so there is nothing to explain and
    // nothing for a Stop button to save them from.
    // What the page held before we asked for anything — the baseline the
    // index has to beat before its number means anything.
    const startMounted = messages.length;
    const announce = !task.auto;
    if (announce) {
      showPill(walkLabel(adapter), () => {
        task.cancelled = true;
        task.cancelledBy = "stop";
      });
    }
    let failed = false;
    try {
      // The result is not read: a stall at the top is the only way a walk ends
      // now, and both endings take the same path below.
      await pageUp(adapter, task, scroller, {
        /* WE KNOW THE ANSWER. The provider's own index says how many messages
           this conversation has, so the walk does not have to discover the end
           by failing to make progress five times over — which is five step
           budgets of dead air, up to four and a half seconds, on every single
           walk. The moment the page holds as many turns as the index says
           exist, there is nothing above and we stop on the spot. The stall
           detector stays underneath as the answer for hosts with no index. */
        until: () => {
          /* Only when the index actually KNOWS more than the page does.
             LCTMinimap.count falls back to the mounted count on a host with no
             provider index, and "mounted >= mounted" is true on the first tick
             — which ended every walk before it made a single request. The
             comparison is only evidence when the total is bigger than what the
             page held when we started. */
          const total = self.LCTMinimap ? self.LCTMinimap.count : 0;
          return total > startMounted && mountedCount(adapter) >= total;
        },
        onStep: () => { if (announce) showPill(walkLabel(adapter)); },
        lock
      });
      /* Put them back BEFORE the copy comes down: every one of those attempts
         happens behind the freeze, so the only frame anyone sees is the last
         one, already correct. */
      /* …unless a reader has taken the wheel. standDown() drops the freeze the
         instant they click the map, so from here on the page they are looking
         at is the live one and putting it back where the walk started would be
         undoing the very jump they asked for. */
      if (lock && !task.readerMoved) await restoreAnchor(adapter, scroller, task.anchor, { cancelled: false });
    } catch (_) {
      failed = true;
    } finally {
      /* The page is hidden under the copy until this runs. A throw anywhere
         above would otherwise leave the reader looking at a still image of a
         conversation that has stopped being true, until the deadman fires four
         minutes later. Nothing between makeFreeze() and here may skip it. */
      hidePill();
      if (lock) lock.release();
      task.lock = null;
    }
    if (failed) {
      finish(task, "error");
      return scheduleResume(adapter, route, { auto: task.auto });
    }
    const held = !!lock;

    if (!task.cancelled && task.route === location.href) {
      if (!held) await restoreAnchor(adapter, scroller, task.anchor, task);
      /* Only a stall at the top proves we reached the first turn — and since
         the time ceiling went, a stall is the only way a walk ends. */
      completedRoutes.add(route);
      finish(task, "complete");
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
    if (completedRoutes.has(route)) return;

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
      /* The resume waits for the reader to go quiet — arm() below — and then
         goes, freeze and all. Whether a VISIBLE walk may run is run()'s call,
         not this one's: run() is the only place holding the scroller, so it is
         the only place that knows whether the freeze can actually be built. */
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

  /* ---------- never let a reader SEE the page move ----------
     A host hands over older turns only when its own scroller is genuinely at
     the top, and the browser paints that. What makes the automatic walk safe is
     not a hidden tab, it is makeFreeze(): a still clone of the scroller sits
     over it, the scroller goes visibility:hidden, and the walk runs underneath.
     The reader's screen is not merely stable, it is the same pixels — and any
     input at all stands the walk down and hands the live page straight back.

     A hidden tab was the rule here for one release and it was the wrong one. It
     reads as the safer choice and is not: a long chat that is opened, read and
     closed is never hidden, so the walk it was waiting for never ran and the
     older turns never arrived. Refusing to work is not a safe default.

     What is left of it is the arm below, and it is now the FALLBACK for the one
     case a freeze cannot cover — a scroller with no box to clone. Those routes
     wait for the tab to go away, because there is nothing else honest to do.

     One arm per route, not one arm in total. A single slot survived only while
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

  /* ---------- rendering an archived turn ----------
     The archive holds what the model actually sent: markdown source. Painting
     it with textContent is safe and it is also unreadable — a wall of ###,
     ** and ``` where the host shows headings, bold and a code block. So it is
     rendered, and rendered the only way that stays safe: every node is BUILT,
     with createElement and textContent. There is no innerHTML on this path and
     there must never be one — this text came off the network and the whole
     promise of the archive is that it is data, never markup.

     Deliberately a small subset. Headings, bold, italic, inline code, fenced
     code, lists, quotes and rules cover what these models emit; anything not
     recognised stays as the characters it is, which is the honest failure. */

  /* ChatGPT threads its own citation markers through answer text using
     private-use codepoints — they arrive in the transcript and render as ▤▤▤.
     They are the host's plumbing, not the message. */
  const PRIVATE_USE = /[\uE000-\uF8FF]/g;
  const clean = (t) => String(t || "").replace(PRIVATE_USE, "");

  /* http(s), blob and data only. Never a scheme that can run something. */
  const IMG_OK = /^(https?:|blob:|data:image\/)/i;
  const LINK_OK = /^(https?:|mailto:)/i;

  /** A picture, or an honest note saying one was here. */
  function appendImage(host, alt, src) {
    if (IMG_OK.test(src)) {
      const img = document.createElement("img");
      img.className = "lct-hp-img";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = alt || "";
      img.src = src;
      host.appendChild(img);
      return img;
    }
    const note = document.createElement("span");
    note.className = "lct-hp-note";
    note.textContent = "\u{1F5BC} " + (alt || "image");
    host.appendChild(note);
    return note;
  }

  function appendLink(host, label, url) {
    if (!LINK_OK.test(url)) { host.appendChild(document.createTextNode(label || url)); return; }
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.textContent = label || url;
    host.appendChild(a);
  }

  /* An image or a link written INSIDE a sentence. The block path only catches
     one alone on its own line, so a picture in the middle of a paragraph — and
     every link in an answer — reached the panel as its own source: the literal
     characters "![shot](blob:...)" in front of the reader. */
  const INLINE_LINK = /(!?)\[([^\]]*)\]\(\s*([^)\s]*)\s*\)/g;

  function inlineLinks(parent, text) {
    const src = String(text || "");
    let at = 0, m;
    INLINE_LINK.lastIndex = 0;
    while ((m = INLINE_LINK.exec(src))) {
      if (m.index > at) inlineMarkers(parent, src.slice(at, m.index));
      const url = m[3];
      if (m[1] === "!") appendImage(parent, m[2], url);
      else appendLink(parent, m[2], url);
      at = m.index + m[0].length;
    }
    if (at < src.length) inlineMarkers(parent, src.slice(at));
  }

  /** Inline markdown into `parent`: **bold**, *italic*, `code`, images, links. */
  function inline(parent, text) {
    if (!rich()) { inlineLinks(parent, text); return; }
    for (const part of self.LCTRichText.splitInlineMath(text)) {
      if (part.tex !== undefined) self.LCTRichText.math(parent, part.tex, false);
      else inlineLinks(parent, part.text);
    }
  }

  function inlineMarkers(parent, text) {
    const src = clean(text);
    // One pass, longest markers first, so ** is never read as two *.
    /* `_` only at a word boundary. It used to match anywhere, so every
       identifier in a code-shaped message — step_type, is_attachment, tab_id —
       came out with its middle in italics and its underscores eaten. That is
       not a cosmetic loss: the reader cannot tell what the text actually said.
       Markdown's own rule is intraword underscores are literal; asterisks keep
       working everywhere, which is what emphasis in prose actually uses. */
    const re = /(\*\*)(.+?)\1|(?<![A-Za-z0-9_])__(.+?)__(?![A-Za-z0-9_])|(\*)(.+?)\4|(?<![A-Za-z0-9_])_(.+?)_(?![A-Za-z0-9_])|`([^`]+)`/g;
    let at = 0, m;
    while ((m = re.exec(src))) {
      if (m.index > at) parent.appendChild(document.createTextNode(src.slice(at, m.index)));
      let node;
      const strong = m[2] !== undefined ? m[2] : m[3];
      const em = m[5] !== undefined ? m[5] : m[6];
      if (strong !== undefined) { node = document.createElement("strong"); node.textContent = strong; }
      else if (em !== undefined) { node = document.createElement("em"); node.textContent = em; }
      else { node = document.createElement("code"); node.textContent = m[7]; }
      parent.appendChild(node);
      at = m.index + m[0].length;
    }
    if (at < src.length) parent.appendChild(document.createTextNode(src.slice(at)));
  }

  /* ---------- borrowing the host's own markup ----------
     Rendering archived turns with our own markup and our own CSS produces a
     lookalike, and a lookalike sitting above the real messages reads as a
     different page — which is exactly the complaint. There is a better source
     of truth available and it is already on the screen: the host's OWN message
     elements. Clone one, empty it, put the archived content where its text was,
     and the result carries every class the site uses. Not an approximation of
     their UI. Their UI, with our text in it.

     It also generalises for free: no per-provider stylesheet, no guessing at
     bubble radii, and it keeps working when they restyle, because the template
     is whatever is mounted at that moment.

     cloneNode copies markup and not listeners, so the copy is inert — which is
     what we want. Ids and provider ids come off: two elements answering to one
     id breaks getElementById for the host as well as for us, and every adapter
     selects on data-message-id, so leaving it would have the minimap, the
     outline and the engine all counting rows the host has never heard of. */
  const CONTROL_SEL = "button, [role=button], input, textarea, select, svg, img, video, canvas, form";
  const TEXT_SEL = ".markdown, [class*='markdown'], .prose, [class*='prose']";

  function findTemplates(adapter, messages) {
    const out = { user: null, assistant: null };
    for (const el of messages) {
      let r;
      try { r = adapter.role(el) || ""; } catch (_) { r = ""; }
      if ((r === "user" || r === "assistant") && !out[r]) out[r] = el;
      if (out.user && out.assistant) break;
    }
    return out;
  }

  /** The node inside a cloned turn that held the message text. */
  function textHost(clone) {
    const marked = clone.querySelector(TEXT_SEL);
    if (marked) return marked;
    // No marker class: the deepest element that carried most of the text.
    let best = null, bestLen = 0;
    for (const el of clone.querySelectorAll("*")) {
      if (el.children.length) continue;
      const len = (el.textContent || "").trim().length;
      if (len > bestLen) { bestLen = len; best = el; }
    }
    return (best && best.parentElement) || clone;
  }

  /**
   * One archived turn, wearing the host's own clothes.
   * Returns null when there is no template to borrow — the caller falls back.
   */
  function hostRow(template, m) {
    if (!template) return null;
    let clone;
    try { clone = template.cloneNode(true); } catch (_) { return null; }
    try {
      for (const n of clone.querySelectorAll("[id]")) n.removeAttribute("id");
      clone.removeAttribute("id");
      for (const n of clone.querySelectorAll("[data-message-id]")) n.removeAttribute("data-message-id");
      clone.removeAttribute("data-message-id");
      // Copy buttons, regenerate, feedback, avatars: inert here and misleading.
      for (const n of clone.querySelectorAll(CONTROL_SEL)) n.remove();
      const host = textHost(clone);
      host.replaceChildren();
      renderMarkdown(host, m.t || "");
    } catch (_) { return null; }
    return clone;
  }

  /** Block markdown into `host`. Never returns markup; only appends nodes. */
  /* A record written before the archive knew better.

     Perplexity's transcript sometimes carries the whole reasoning TRACE where
     the answer should be — a JSON array of INITIAL_QUERY, SEARCH_WEB,
     SEARCH_RESULTS, FINAL, with the real answer buried in the last one and
     encoded a second time inside it. bg.js unwraps that now, but only for
     conversations fetched SINCE; everything already on disk still holds the
     raw trace, and re-fetching an entire archive to repair a display bug is
     not a trade worth making. So it is unwrapped here too, on the way to the
     screen. Cheap: the test is one character, and a message that does not
     start with "[" never parses anything. */
  function unwrapTrace(text) {
    const raw = String(text || "");
    if (raw.charCodeAt(0) !== 91) return raw;      // 91 = "["
    let steps;
    try { steps = JSON.parse(raw); } catch (_) { return raw; }
    if (!Array.isArray(steps) || !steps.length) return raw;
    for (let i = steps.length - 1; i >= 0; i--) {
      const answer = steps[i] && steps[i].content && steps[i].content.answer;
      if (typeof answer !== "string" || !answer) continue;
      try {
        const inner = JSON.parse(answer);
        const found = String((inner && inner.answer) || "").trim();
        if (found) return found;
      } catch (_) { /* singly encoded */ }
      if (answer.trim()) return answer.trim();
    }
    return raw;
  }

  // richtext.js is a sibling content script; a page where it failed to load
  // must still render, just without colour or MathML.
  const rich = () => !!(self.LCTRichText && self.LCTRichText.looksLikeCode);

  function codeInto(host, body, lang) {
    if (rich()) { self.LCTRichText.codeBlock(host, body, lang); return; }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (lang) code.dataset.lctLang = String(lang).slice(0, 24);
    code.textContent = body;
    pre.appendChild(code);
    host.appendChild(pre);
  }

  function blockMath(host, tex) {
    if (rich()) { self.LCTRichText.math(host, tex, true); return; }
    const pre = document.createElement("pre");
    pre.textContent = tex;
    host.appendChild(pre);
  }

  function renderMarkdown(host, text) {
    const lines = clean(unwrapTrace(text)).split("\n");
    let list = null, listTag = "";
    const endList = () => { list = null; listTag = ""; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      /* An opening fence, and what follows it.

         Two things used to turn a whole answer into one wide scrolling code
         box of PROSE. The opener demanded nothing after the language, so
         ```js title="x" was not a fence at all — and the CLOSING ``` then
         opened one, swallowing every paragraph to the end of the message. And
         a fence the model never closed (a truncated answer, a stray ``` in a
         sentence) did the same on its own.

         So: the language is the first word and trailing text is ignored, the
         closer is any line starting ```, and with no closer in the message the
         remainder has to EARN the block — one line prose could not have
         produced. Otherwise the ``` is text and the paragraphs stay
         paragraphs, which is the honest failure. */
      const fence = /^\s*```\s*([A-Za-z0-9+#_.-]*)/.exec(line);
      if (fence) {
        let close = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*```/.test(lines[j])) { close = j; break; }
        }
        const body = lines.slice(i + 1, close < 0 ? lines.length : close);
        if (close >= 0 || (rich() && body.some((l) => self.LCTRichText.strongCode(l)))) {
          endList();
          codeInto(host, body.join("\n"), fence[1]);
          i = close < 0 ? lines.length : close;
          continue;
        }
      }
      /* A picture on its own line. The archive stores one as ![alt](src) — a
         message that IS an image had no text at all before, so it arrived in
         the panel as an empty row. */
      const pic = /^\s*!\[([^\]]*)\]\(\s*([^)\s]*)\s*\)\s*$/.exec(line);
      if (pic) {
        endList();
        appendImage(host, pic[1], pic[2]);
        continue;
      }
      /* $$…$$ on its own, one or more lines — and \[…\], which is what MathJax
         emits by default and what half the models write. */
      const openMath = /^\s*(\$\$|\\\[)\s*(.*)$/.exec(line);
      if (openMath) {
        endList();
        const square = openMath[1] === "\\[";
        const closer = square ? /\\\]\s*$/ : /\$\$\s*$/;
        const body = [];
        const first = openMath[2] || "";
        if (first && closer.test(first)) body.push(first.replace(closer, ""));
        else {
          if (first) body.push(first);
          for (i++; i < lines.length && !closer.test(lines[i]); i++) body.push(lines[i]);
          if (i < lines.length) body.push(lines[i].replace(closer, ""));
        }
        blockMath(host, body.join(" ").trim());
        continue;
      }
      /* An environment on its own, with or without dollars around it.
         `$\begin{aligned} … \end{aligned}$` is written at least as often as
         `$$…$$`, and NOTHING caught it: the block openers above want `$$` or
         `\[`, and the inline scanner stops at a newline. So a multi-line
         derivation arrived in the panel as its own source — "$\begin{aligned}"
         and every backslash after it, in front of the reader, which is what
         this whole renderer exists to prevent.

         The closer has to be in reach or this is not an environment at all:
         with no `\end` ahead, fall through and render the line as the text it
         is, rather than swallowing the rest of the message. */
      const openEnv = /^\s*\$?\s*(\\begin\{[a-zA-Z*]+\}.*)$/.exec(line);
      if (openEnv) {
        const closes = /\\end\{[a-zA-Z*]+\}\s*\$?\s*$/;
        let end = closes.test(line) ? i : -1;
        for (let j = i + 1; end < 0 && j < lines.length && j - i <= 200; j++) {
          if (closes.test(lines[j])) end = j;
        }
        if (end >= 0) {
          endList();
          const body = [openEnv[1], ...lines.slice(i + 1, end + 1)];
          blockMath(host, body.join(" ").replace(/\$\s*$/, "").trim());
          i = end;
          continue;
        }
      }
      /* Code pasted without fences — the usual way it arrives in a chat, and
         what turned one program into forty one-line paragraphs. */
      if (rich() && self.LCTRichText.looksLikeCode(line)) {
        const body = [line];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const nxt = lines[j];
          if (!nxt.trim()) {
            // one blank line inside a block is normal; two ends it
            if (j + 1 < lines.length && self.LCTRichText.looksLikeCode(lines[j + 1])) { body.push(""); continue; }
            break;
          }
          if (!self.LCTRichText.looksLikeCode(nxt)) break;
          body.push(nxt);
        }
        if (body.length >= 2 && body.some((l) => self.LCTRichText.strongCode(l))) {
          endList();
          codeInto(host, body.join("\n").replace(/\s+$/, ""), "");
          i = j - 1;
          continue;
        }
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { endList(); host.appendChild(document.createElement("hr")); continue; }
      const head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        endList();
        const h = document.createElement("h" + head[1].length);
        inline(h, head[2]);
        host.appendChild(h);
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || number) {
        const tag = bullet ? "ul" : "ol";
        if (!list || listTag !== tag) { list = document.createElement(tag); listTag = tag; host.appendChild(list); }
        const li = document.createElement("li");
        inline(li, (bullet || number)[1]);
        list.appendChild(li);
        continue;
      }
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        endList();
        const bq = document.createElement("blockquote");
        inline(bq, quote[1]);
        host.appendChild(bq);
        continue;
      }
      if (!line.trim()) { endList(); continue; }
      endList();
      const p = document.createElement("p");
      inline(p, line);
      host.appendChild(p);
    }
  }

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

  /* No retry ceiling. This is the path that puts the whole conversation on
     screen in one call and without scrolling anything, so giving up on it is
     giving up on the feature — a chat the background sync has not reached yet
     would stay half-loaded forever. The backoff below still climbs, so a host
     that is refusing is asked less often, never nothing. */
  const MOUNT_RETRY_MS = 5000;
  const MOUNT_RETRY_MAX_MS = 60000;
  /* A host that has not finished its first render is milliseconds away, not
     seconds. Waiting out the provider-refusal backoff for that is the reader
     watching four messages of a hundred for no reason. */
  const MOUNT_SOON_MS = 250;
  const mountTries = new Map();

  function retryMount(adapter, route, afterMs) {
    const used = mountTries.get(route) || 0;
    mountTries.set(route, used + 1);
    // The provider's own Retry-After wins over our backoff when it says longer:
    // retrying inside a 429's window just spends the next one.
    /* `afterMs` is a FLOOR when the provider named one and the whole wait when
       the caller knows better — a host mid-render is not a host refusing us. */
    const wait = afterMs === MOUNT_SOON_MS
      ? MOUNT_SOON_MS
      : Math.max(Math.min(MOUNT_RETRY_MS * (used + 1), MOUNT_RETRY_MAX_MS), Number(afterMs) || 0);
    const again = () => {
      // Nothing to retry against once the context is gone — see send().
      if (contextGone || location.href !== route) return;
      mountedRoutes.delete(route);
      mountArchive(adapter);
    };
    setTimeout(again, Math.min(wait, 120000));
  }

  /* ---------- take the fetch off the critical path ----------
     mountArchive() is the instant path — one call to the provider's own
     transcript endpoint, every older turn rendered at once, nothing scrolled.
     Its whole latency is that call, and it used to start only after the host
     had mounted its tail AND the engine had ticked AND maybeStart had run.

     This fires it on the route change instead, so by the time anything below
     asks for the transcript the worker is usually already holding it. Same one
     request either way — earlier, not extra. */
  /* The extension was reloaded or updated while this page kept running, so the
     script talking is from a build that no longer exists. Every chrome.* call
     from here on throws; there is nothing to retry against and nothing to fix
     but a page reload, which is the reader's to make. Stop asking. */
  let contextGone = false;

  /**
   * chrome.runtime.sendMessage, without the sharp edge.
   *
   * It THROWS SYNCHRONOUSLY when the extension context has been invalidated —
   * it does not return a rejected promise — so a `.catch()` on its result never
   * runs and the error escapes as an unhandled rejection. Observed in the field
   * as "Uncaught (in promise) Error: Extension context invalidated" out of
   * mountArchive's retry loop, once per retry, forever.
   */
  function send(msg) {
    if (contextGone) return Promise.resolve(null);
    try {
      const p = chrome.runtime.sendMessage(msg);
      return p && p.catch ? p.catch(() => null) : Promise.resolve(null);
    } catch (e) {
      if (/context invalidated|Extension context/i.test(String(e && e.message))) contextGone = true;
      return Promise.resolve(null);
    }
  }

  /* A conversation just went into the archive.

     Anything drawn from the archive before this moment was drawn from nothing —
     the hover card in particular, which says "not tracked yet" and then has no
     reason to ask again. A DOM event rather than a direct call: the card is a
     separate module that may not be loaded, and the loader has no business
     knowing who is listening. */
  function announceArchived(path) {
    try {
      document.dispatchEvent(new CustomEvent("lct-archived", {
        detail: { host: location.host, path: String(path || "") }
      }));
    } catch (_) { /* CustomEvent unavailable: nothing depends on this */ }
  }

  const warmed = new Set();
  /* Hosts whose transcript cannot be fetched in one request. Gemini and
     Perplexity have no history endpoint at all, and they are the only ones the
     page ever has to be scrolled for. Assumed EMPTY until a probe says
     otherwise, because the safe default is "do not touch the reader's page". */
  const endpointless = new Set();
  /* Routes that wanted the walk before we knew whether this host needs one.
     The probe answers a moment later and flushes them; without this the gate
     below was decided ONCE, on the way past, and a host that publishes nothing
     never got its fallback at all. */
  const pendingWalk = new Map();

  /* WHY THIS DOES NOT WAIT FOR THE HOST.

     It did, briefly. Opening a chat makes chatgpt.com fetch
     /backend-api/conversation/<id> for itself, and asking for the same thing at
     the same instant is one more concurrent request at the moment the site is
     building its interface. Queueing behind it is the polite shape.

     It is also the wrong trade, and the numbers say so: waiting costs the
     host's whole load — one to three seconds — before we even ask, on top of
     our own round trip. The requirement is the entire conversation on screen in
     three to five seconds, and there is no version of "wait, then fetch, then
     render" that fits inside that reliably.

     So it fires immediately, and it is ONE request: chatIndex() collapses
     concurrent callers for the same conversation through idxInflight, and
     hover prefetch usually means the answer is already archived before the
     click lands, in which case nothing goes over the network at all. One
     request beside the host's is not what earns a 429 — thousands from the
     backfill is, and that is now paced, yielded and capped. */
  function warm(adapter, path) {
    const route = location.href;
    const here = { host: location.host, path: path || location.pathname };
    /* Keyed on the CONVERSATION, not the current URL — a prefetch and the later
       visit to the same chat are the same request and must not be made twice. */
    const key = here.host + here.path;
    if (warmed.has(key)) return false;
    warmed.add(key);
    /* A prefetch is for a chat somebody has not opened yet. It archives, and
       nothing more: chat-mount is refused for any path but the sender's own
       (deliberately — see bg.js), and there is no page of theirs to mount into
       anyway. The mount happens on arrival, from the copy this just wrote. */
    const ahead = !!path && path !== location.pathname;
    (async () => {
      try {
        /* THE ARCHIVE FIRST, ALWAYS. This used to fire chat-index — a real
           request to the provider — on every single route change, including
           for conversations already sitting in the archive. Clicking down a
           sidebar therefore spent one provider request per click, on top of
           the background pass, and that is what "Too many requests" is made
           of. chat-mount is a local IndexedDB read: free, instant, and the
           answer for almost every chat. */
        if (!ahead) {
          /* Ahead of the archive read, not the network one: chat-mount is a
             local database lookup and costs the host nothing, so it can happen
             while the site is still loading. It is only the FETCH below that
             has to wait, and only when the archive came back empty. */
          const held = await send(Object.assign({ type: "chat-mount" }, here));
          if (held && held.status === "ok" && Array.isArray(held.msgs) && held.msgs.length) return;
          if (location.href !== route) return;   // they moved on; do not fetch
        }
        const idx = await send(
          Object.assign({ type: "chat-index", force: false, foreground: true }, here));
        /* Mount it HERE, the moment the transcript lands.

           maybeStart() is the other caller and it runs exactly once per route,
           stamped into startedRoutes on the way past. So it raced this import
           and usually lost: it asked while the archive was still empty, got
           nothing, and could never ask again — which left the walk as the only
           path on the very conversations the archive was about to be able to
           serve instantly. */
        if (idx && idx.status === "unsupported") endpointless.add(here.host);
        // Prefetch done: it is in the archive, which is the whole job.
        /* A prefetch that failed archived nothing. Announcing it anyway made
           the card drop its cached answer and ask the worker again for a chat
           that is still not there — a round trip per failed hover. */
        if (ahead) {
          if (idx && (idx.status === "ok" || idx.status === "fresh")) announceArchived(here.path);
          return;
        }
        if (!idx || (idx.status !== "ok" && idx.status !== "fresh")) {
          /* The archive could not deliver, and the REASON does not matter here.
             No endpoint, a refusal, a cooling host, an error — the reader is
             still looking at four messages out of a hundred, and the walk is
             the only way up that is left. Gating the fallback on "this host has
             an endpoint" was wrong: having one is not the same as it having
             answered. */
          const waiting = pendingWalk.get(route);
          pendingWalk.delete(route);
          // Same idiom as every other route check here: they may have moved on.
          if (location.href !== route) return;
          if (waiting) begin(waiting, SETTLE_MS, true);
          return;
        }
        if (location.href !== route || !adapter) return;
        mountedRoutes.delete(route);
        announceArchived(here.path);
        const mounted = await mountArchive(adapter).catch(() => false);
        /* The archive won the race. Whatever the walk is still doing is now
           sixty round trips for rows already on the page — stand it down. stop()
           cancels through run()'s own path, so the freeze comes off and the
           reader is put back where they were, exactly as any other cancel. */
        if (mounted && active && active.route === route) stop();
      } catch (_) { warmed.delete(key); }
    })();
    return true;
  }

  /* ---------- hover is intent ----------
     Somebody hovers a conversation in the sidebar a few hundred milliseconds
     before they click it. Spending that gap on the one request the click is
     going to need turns "open a chat and wait for a round trip" into "open a
     chat and read it" — the transcript is already in the archive, so the mount
     is a local database read and nothing goes over the network at all.

     Guarded, because a hover handler is the easiest way in the world to build
     a burst: firing on every mouseover down a long sidebar is one request per
     row. A dwell proves intent, and the per-minute cap means a pointer dragged
     across fifty rows still costs at most twelve. */
  const PREFETCH_DWELL_MS = 220;
  const PREFETCH_MAX_PER_MIN = 12;
  let prefetchTimer = null;
  let prefetchUsed = 0;
  let prefetchWindowAt = 0;

  function prefetch(path) {
    clearTimeout(prefetchTimer);
    const want = String(path || "");
    if (!want || want === location.pathname) return false;
    if (warmed.has(location.host + want)) return false;
    prefetchTimer = setTimeout(() => {
      const now = Date.now();
      if (now - prefetchWindowAt > 60000) { prefetchWindowAt = now; prefetchUsed = 0; }
      if (prefetchUsed >= PREFETCH_MAX_PER_MIN) return;
      prefetchUsed++;
      warm(null, want);
    }, PREFETCH_DWELL_MS);
    return true;
  }

  async function mountArchive(adapter) {
    const route = location.href;
    setMountStatus("working");
    const stale = document.getElementById(MOUNT_ID);
    if (stale && stale.dataset.lctRoute !== route) stale.remove();
    /* "Mounted" has to mean STILL mounted. The block lives inside the host's
       own scroll container, which is React's to reconcile — it can take our
       node out with it on any re-render, and when it did, this set still said
       the route was done. The older turns vanished and could never come back.
       Ask the DOM, not the bookkeeping. */
    if (mountedRoutes.has(route)) {
      const held = document.getElementById(MOUNT_ID);
      if (held && held.isConnected && held.dataset.lctRoute === route) return false;
      mountedRoutes.delete(route);
    }

    /* "Not yet" is not "no".

       warm() fires on the route change, which is BEFORE the host has rendered
       its list — so this ran against an empty page, answered no-messages, and
       scheduled nothing. One badly-timed call and that conversation never got
       its older turns at all until the reader reloaded by hand. Both of these
       are transient by definition: the host is still mounting. Ask again. */
    let messages;
    try { messages = adapter.messages(); } catch (_) { messages = null; }
    if (!messages || !messages.length) {
      setMountStatus("no-messages", route);
      retryMount(adapter, route, MOUNT_SOON_MS);
      return false;
    }
    const scroller = self.LCTAdapters.findScroller(messages[0]);
    if (!scroller) {
      setMountStatus("no-scroller", route);
      retryMount(adapter, route, MOUNT_SOON_MS);
      return false;
    }

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
      send(Object.assign({ type, host: location.host, path: location.pathname }, extra)),
      new Promise((resolve) => setTimeout(() => resolve({ status: "slow" }), ASK_TIMEOUT_MS))
    ]);
    /* An MV3 worker is torn down between messages and a request that arrives
       mid-teardown rejects rather than waking it. One immediate retry is the
       difference between "no archive" and the archive that was there all along.

       Immediate, with no pause between the two: the send itself is what wakes
       the worker, so the 400ms that used to sit here bought nothing and spent
       it out of the reader's own wait. */
    const ask = async (type, extra) => {
      const first = await once(type, extra);
      return first || once(type, extra);
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
    const templates = findTemplates(adapter, messages);
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
    /* This node is a guest in the host's scroll container, and the host is
       measuring that container continuously to decide what to mount. `contain`
       keeps our subtree's layout and paint to ourselves, so the rows inside it
       cannot participate in the host's own measurements beyond the one box it
       can see. Cheap, and it is the difference between adding a block and
       adding a block that the virtualizer has to reason about. */
    block.style.contain = "layout style paint";
    block.setAttribute("data-lct-own", "1");
    for (const m of older) {
      const role = m.r === "user" ? "user" : "assistant";
      // The host's own markup first; our own only where there is none to copy.
      let row = hostRow(templates[role], m);
      if (row) {
        row.classList.add("lct-old", "lct-old-native");
      } else {
        row = document.createElement("article");
        row.className = "lct-old";
        const who = document.createElement("div");
        who.className = "lct-old-who";
        who.textContent = role === "user" ? "You" : "Assistant";
        const body = document.createElement("div");
        body.className = "lct-old-text";
        // Built node by node — see renderMarkdown(). Never innerHTML.
        renderMarkdown(body, m.t || "");
        row.append(who, body);
      }
      row.dataset.lctOld = role;
      /* NOT data-message-id — stripped above for the same reason it is not set
         here: every adapter selects on it, and claiming these are the host's
         own turns would have the minimap, the outline and the engine all
         counting rows the host has never heard of. lctTurnId is ours, and it is
         what the map's click and the seek both match on. */
      if (m.i) row.dataset.lctTurnId = m.i;
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
    /* Idempotent per route, and needed here as well as on the route change:
       a first page load is not a route change, so nothing had probed this host
       and the gate below had no answer to read. */
    warm(adapter);
    /* Two ways up, both automatic, tried together.

       The archive: the whole conversation is already on this machine and was
       never scrolled for, so the older turns are rendered above the host's
       list. Nothing moves at all.

       And the walk, because the archive is not always there — a chat nobody has
       synced, a provider with no endpoint — and "sometimes" is not the feature.
       The walk parks the host's scroller at the top, which is the only way it
       hands over older turns, and it does that behind makeFreeze(): a still
       copy of the scroller covers it, so the reader keeps the exact pixels they
       were looking at while the host is driven to the first turn.

       Waiting for a hidden tab instead of freezing was tried here and it cost
       the feature outright: a chat that is opened, read and closed is never
       hidden, so the older turns never arrived at all. run() arms for a
       tab-hide only when the freeze cannot be built. */
    const walk = () => {
      /* ONLY where there is no transcript endpoint.

         On a host that has one — which is the one this is reported on — the
         whole conversation is a SINGLE request and the walk is sixty, each of
         which moves the host's own scroller. Sixty of those is the page
         scrolling itself in front of the reader, and it is also sixty times the
         rate budget of the call that would have done the job outright. Every
         serious tool in this space reads /backend-api/conversation/<id> for
         exactly this reason; so does mountArchive(). The walk is the fallback
         for hosts that publish nothing, and nothing else.

         retryMount() keeps asking on its own backoff, so a mount that failed
         because the transcript had not landed yet is not a dead end. */
      if (endpointless.has(location.host)) return begin(adapter, SETTLE_MS, true);
      /* Not known to publish nothing — so assume it does publish, because the
         cost of being wrong in the other direction is scrolling the reader's
         page sixty times for something one request would have fetched.
         retryMount keeps asking on its own backoff, and warm()'s probe starts
         the walk here the moment it comes back saying otherwise. */
      pendingWalk.set(route, adapter);
      retryMount(adapter, route);
    };
    // Only a mount that actually rendered older turns makes the walk redundant;
    // every other outcome is the "sometimes" above and still needs the fallback.
    // Also the only .catch this call has ever had — an insertBefore that throws
    // was an unhandled rejection that took the walk down with it.
    mountArchive(adapter).then((mounted) => { if (!mounted) walk(); }, walk);
  }

  /**
   * A reader is driving. Give the live page back NOW.
   *
   * The automatic walk runs behind makeFreeze(), which hides the host scroller
   * under a static copy — and attachCancellation deliberately ignores input
   * inside our own UI so that a minimap click cannot cancel the seek it is
   * about to start. The two together made clicking the map the one gesture
   * that could not release the freeze: the map answered, the page underneath
   * stayed a picture, and every jump scrolled a scroller nobody could see.
   *
   * Releasing the lock here rather than waiting for pageUp's current step to
   * expire is the whole point — a click has to land in this frame, not in the
   * up-to-a-second it takes the crawl to notice. release() is idempotent, so
   * run()'s own `finally` is unaffected.
   */
  function standDown() {
    const task = active;
    if (!task || !task.auto || task.cancelled) return false;
    task.cancelled = true;
    task.cancelledBy = "input";
    task.readerMoved = true;
    if (task.lock) { task.lock.release(); task.lock = null; }
    return true;
  }

  /** The reader asked for it. Redo even a route we already walked. */
  function start(adapter) {
    if (!supported(adapter)) return false;
    const route = location.href;
    completedRoutes.delete(route);
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
    setSeekTarget(target.id);

    /* The seek target comes from the provider's own index, so it is a provider
       id — match it against the same id probe the walk uses rather than
       against data-message-id alone. That attribute is ChatGPT's spelling of
       an id, not every host's, and hardcoding it here is what confined seek to
       ChatGPT even once the walk itself was general. */
    const found = () => {
      try {
        const direct = document.querySelector('[data-message-id="' + CSS.escape(target.id) + '"]');
        if (direct) return direct;
        /* Rows mountArchive() rendered from the copy already on this machine.
           They deliberately carry data-lct-turn-id and NOT data-message-id —
           every adapter selects on that attribute and these are not the host's
           turns — which meant the seek could not see them. Clicking the first
           message in the minimap then paged the host sixty times for a row that
           was already on the screen, and those sixty requests are what "Too
           many requests" is made of. */
        const ours = document.querySelector('[data-lct-turn-id="' + CSS.escape(target.id) + '"]');
        if (ours) return ours;
        return adapter.messages().find((el) => adapter.stableKey(el) === target.id) || null;
      } catch (_) { return null; }
    };

    /* Land on a row that is already here. No paging, no pill, no request. */
    const land = () => {
      finish(task, "complete");
      setSeekStatus("done");
      if (target.arrive) target.arrive(true);
    };

    const label = () => {
      const have = mountedCount(adapter);
      const total = target.total || (self.LCTMinimap ? self.LCTMinimap.count : 0);
      return total > have
        ? `Loading older messages… ${commas(have)} of ${commas(total)}`
        : `Loading older messages… ${commas(have)}`;
    };

    (async () => {
      // Cheapest first: it may simply be mounted already.
      if (found()) return land();
      /* Then the local copy. Rendering the older turns out of the archive is
         instant and asks the provider for nothing; paging the host for them is
         sixty round trips against a rate limit. Try the free one first — this
         is the whole reason the archive exists. */
      try { if (await mountArchive(adapter) && found()) return land(); }
      catch (_) { /* fall through to the walk */ }
      /* A bare `return` here left lctSeekState reading "running" forever. The
         reader can cancel DURING the archive lookup above — the listeners are
         attached before it — and a seek that stops without saying so is one
         nothing downstream can ever clear. Every exit from this function
         reports. */
      if (task.cancelled || task.route !== location.href) {
        if (active === task) finish(task, "cancelled");
        setSeekStatus("cancelled");
        return;
      }

      let messages = [];
      try { messages = adapter.messages(); } catch (_) { /* selector drift */ }
      const scroller = messages.length ? self.LCTAdapters.findScroller(messages[0]) : null;
      if (!scroller) { finish(task, "idle"); setSeekStatus("done"); return; }

      /* BEHIND THE FREEZE, like every other walk in this file.

         This one was not, and it was the only path in the extension that paged
         a host in front of a reader: run() builds the freeze, and seekTo() does
         not go through run(). So clicking the map took the page to the top and
         back, visibly, once per page of history — the exact thing the freeze
         exists to make impossible, on the one gesture most likely to trigger it.

         Nothing else here changes. The walk still drives the host's scroller;
         the reader still sees the pixels they were looking at, and then the
         message they asked for. Never the journey between the two. */
      const lock = document.hidden ? null : makeFreeze(scroller);
      let outcome;
      try {
        showPill(label(), () => { task.cancelled = true; task.cancelledBy = "stop"; });
        outcome = await pageUp(adapter, task, scroller, {
          until: () => !!found(),
          onStep: () => showPill(label()),
          lock
        });
        /* Land while the copy is still up, so the only frame anyone sees is the
           last one — already on the message they asked for. Even when the host
           ran out of history, land on the oldest row it gave us rather than
           leaving them parked at the top with nothing selected. */
        /* KEEP GOING until the host truly has nothing older.

           pageUp() concludes "exhausted" after a handful of quiet steps, and on
           these hosts quiet is not the same as finished — a virtualizer that is
           busy, mid-fetch or briefly throttled goes quiet and then hands over
           another page if you ask again. Stopping on the first silence is what
           left a click on the top of the map short of the message it named.

           So it asks again, and the ONLY thing that ends it is the page not
           growing: if a whole pass added no turns, there is nothing up there.
           That is the honest end, and it is the same test the stall detector
           uses, applied to the pass rather than to one step. */
        if (outcome !== "cancelled" && outcome !== "reached" && !found()) {
          let before = mountedCount(adapter);
          for (let round = 0; round < SEEK_ROUNDS; round++) {
            if (task.cancelled || task.route !== location.href) break;
            const again = await pageUp(adapter, task, scroller, {
              until: () => !!found(),
              onStep: () => showPill(label()),
              lock
            }).catch(() => "cancelled");
            if (again === "reached") { outcome = "reached"; break; }
            if (again === "cancelled") { outcome = "cancelled"; break; }
            const now = mountedCount(adapter);
            if (now <= before) break;      // the host gave nothing: really the end
            before = now;
          }
        }
        /* Arrive once, after the retries: announcing "not found" and then
           finding it two rounds later is two different answers to one click. */
        if (outcome !== "cancelled" && target.arrive) target.arrive(outcome === "reached" || !!found());
      } finally {
        /* The page is under a still copy until this runs. Nothing above may
           skip it — not a throw, not a route change, not a cancel. */
        hidePill();
        if (lock) lock.release();
      }

      if (active === task) finish(task, outcome === "cancelled" ? "cancelled" : "complete");
      setSeekStatus(outcome === "reached" ? "done" : outcome === "cancelled" ? "cancelled" : "exhausted");
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
    maybeStart, start, stop, standDown, setAuto, supported, seekTo, mountArchive, warm, prefetch,
    renderMarkdown,
    get active() { return !!active; }
  };
})();
