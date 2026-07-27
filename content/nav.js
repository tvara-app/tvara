/**
 * Long Chat Toolkit — one reliable "go to this message".
 *
 * Every jump crosses windowed regions whose heights are estimates until they
 * wake, so a naive scroll lands short and the page keeps shifting underneath.
 * One implementation, shared by the minimap, the outline and search: wake the
 * landing zone AND its neighbours first so the aim is measured against real
 * heights, then re-aim on a time budget until two consecutive frames agree.
 */
(() => {
  "use strict";

  const AWAKE = "lct-awake";     // engine.js refuses to window a pinned element
  const SETTLE_MS = 1400;
  const PIN_MS = 6000;           // the landing zone stays awake while you read it
  const BAND_MS = SETTLE_MS + 600;  // neighbours only hold still for the jump
  const BAND_SCREENS = 1.5;      // matches engine.js NEAR_MARGIN
  const BAND_MAX = 80;           // ceiling on how much layout one jump may force
  const pins = new WeakMap();    // el -> timer

  function pin(el, ms) {
    if (!el) return;
    clearTimeout(pins.get(el));
    el.classList.add(AWAKE);
    el.classList.remove("lct-cv");
    pins.set(el, setTimeout(() => el.classList.remove(AWAKE), ms || PIN_MS));
  }

  const isRoot = (s) => !s || s === document.scrollingElement || s === document.documentElement;

  /** Viewport band of whatever actually scrolls, in client coordinates. */
  function band(scroller) {
    if (isRoot(scroller)) return { top: 0, bottom: innerHeight };
    const r = scroller.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }

  /**
   * Wake the neighbours we are about to land among, before the first aim.
   *
   * A sleeping message is a contain-intrinsic-size guess, not a measurement.
   * The browser wakes the ones around the landing spot only AFTER the scroll
   * lands, and their real heights then shove the target off the mark — that is
   * the visible land-wrong-then-snap. Waking them first makes the first aim the
   * only one needed. They stay pinned for the jump so a rescan cannot re-window
   * them mid-flight and move the floor again.
   */
  function wakeBand(el, scroller) {
    const asleep = document.getElementsByClassName("lct-cv");
    const n = asleep.length;
    if (!n) return;

    const v = band(scroller);
    const reach = Math.max(600, (v.bottom - v.top) * BAND_SCREENS);
    const r = el.getBoundingClientRect();
    const top = r.top - reach;
    const bottom = r.bottom + reach;

    // One column in document order, so rects rise monotonically and the band
    // has a binary-searchable edge. Scanning instead costs a rect read per
    // sleeping message, and long chats have thousands.
    let lo = 0, hi = n - 1, first = n;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (asleep[mid].getBoundingClientRect().bottom >= top) { first = mid; hi = mid - 1; }
      else lo = mid + 1;
    }

    const wake = [];
    let at = -1;                 // where the target sits inside the band
    for (let i = first; i < n; i++) {
      const b = asleep[i].getBoundingClientRect();
      if (b.top > bottom) break;
      if (at < 0 && b.top >= r.top) at = wake.length;
      wake.push(asleep[i]);
    }

    // A dense band can blow the layout budget. Keep the ones nearest the
    // target: those are what the aim is measured against.
    if (wake.length > BAND_MAX) {
      if (at < 0) at = wake.length - 1;
      const from = Math.max(0, Math.min(wake.length - BAND_MAX, at - (BAND_MAX >> 1)));
      wake.splice(0, from);
      wake.length = BAND_MAX;
    }

    // collect first: the collection is live and pin() drops the class
    for (const m of wake) pin(m, BAND_MS);
  }

  const hits = new WeakMap();

  // Mark the landing. Fired on first aim and again on arrival, so a long
  // settle still ends in a pulse the reader sees.
  // remove/reflow/add is load-bearing: lct-pulse is one-shot, and re-adding a
  // class the element already has will not restart it. Without this the
  // arrival call did nothing and the pulse burned down off-screen.
  function highlight(el) {
    clearTimeout(hits.get(el));
    el.classList.remove("lct-hit");
    void el.offsetWidth;
    el.classList.add("lct-hit");
    hits.set(el, setTimeout(() => el.classList.remove("lct-hit"), 1500));
  }

  /**
   * Scroll `el` into view and stay on it until the layout stops moving.
   * @param {Element} el
   * @param {{block?: "center"|"start", scroller?: Element, mark?: boolean}} [opts]
   */
  function jumpTo(el, opts) {
    if (!el || !el.isConnected) return false;
    const o = opts || {};
    const block = o.block === "start" ? "start" : "center";
    const scroller = o.scroller || null;
    const mark = o.mark !== false;
    wakeBand(el, scroller);      // before pin(el): the target's own pin must outlast the band
    pin(el);
    if (mark) highlight(el);

    const deadline = performance.now() + SETTLE_MS;
    let agreed = 0;

    const step = () => {
      if (!el.isConnected) return;
      const v = band(scroller);
      const r = el.getBoundingClientRect();
      const want = block === "center" ? (v.top + v.bottom) / 2 : v.top + 8;
      const have = block === "center" ? r.top + r.height / 2 : r.top;
      // Tall answers cannot be centred to the pixel — anywhere inside the
      // message counts as arrived, or the loop chases itself for a full budget.
      const tol = block === "center" ? Math.max(48, Math.min(180, r.height / 2)) : 48;

      if (r.height > 0 && Math.abs(have - want) <= tol) {
        if (++agreed >= 2) return mark ? highlight(el) : undefined;
      } else {
        agreed = 0;
        el.scrollIntoView({ behavior: "auto", block });
      }
      if (performance.now() >= deadline) return mark ? highlight(el) : undefined;
      requestAnimationFrame(step);
    };
    step();
    return true;
  }

  self.LCTNav = { jumpTo, pin, band, isRoot, highlight, wakeBand };
})();
