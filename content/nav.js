/**
 * Long Chat Toolkit — one reliable "go to this message".
 *
 * Every jump crosses windowed regions whose heights are estimates until they
 * wake, so the first scroll always lands short and the page keeps shifting
 * underneath. One implementation, shared by the minimap and the outline:
 * wake the target, then re-aim on a time budget until two consecutive frames
 * agree we are there.
 */
(() => {
  "use strict";

  const AWAKE = "lct-awake";     // engine.js refuses to window a pinned element
  const SETTLE_MS = 1400;
  const PIN_MS = 6000;           // the landing zone stays awake while you read it
  const pins = new WeakMap();    // el -> timer

  function pin(el) {
    if (!el) return;
    clearTimeout(pins.get(el));
    el.classList.add(AWAKE);
    el.classList.remove("lct-cv");
    pins.set(el, setTimeout(() => el.classList.remove(AWAKE), PIN_MS));
  }

  const isRoot = (s) => !s || s === document.scrollingElement || s === document.documentElement;

  /** Viewport band of whatever actually scrolls, in client coordinates. */
  function band(scroller) {
    if (isRoot(scroller)) return { top: 0, bottom: innerHeight };
    const r = scroller.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }

  const hits = new WeakMap();

  /**
   * Mark the landing. Fired on the FIRST aim, not on arrival: settling across
   * a windowed transcript can take a second, and a pulse that starts after the
   * page has stopped moving is a pulse nobody sees. Re-firing on arrival just
   * extends it, so the mark is still up when the scroll finishes.
   */
  function highlight(el) {
    clearTimeout(hits.get(el));
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

  self.LCTNav = { jumpTo, pin, band, isRoot, highlight };
})();
