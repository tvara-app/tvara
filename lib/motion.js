/**
 * Tvara — the motion engine the extension pages share.
 *
 * There is no library here and there cannot be: `script-src 'self'` blocks
 * every CDN, and vendoring an animation runtime would put tens of kilobytes in
 * front of a panel whose whole promise is that it is fast. So this is the small
 * set of things a motion library is actually used for, done once:
 *
 *   - ONE requestAnimationFrame loop for every value in flight. A loop per
 *     tween is the usual way this gets written and it is why panels judder:
 *     each one wakes the compositor on its own schedule.
 *   - Transform and opacity only. Nothing here animates width, height, top or
 *     left — those are layout, and layout during motion is what drops frames.
 *   - Retargeting instead of restarting. `quickTo` keeps one tween per property
 *     and moves its destination, so a value that changes every 200 ms does not
 *     allocate a tween every 200 ms.
 *   - The Web Animations API for enter/exit and FLIP, because a transform
 *     animation declared through it can be handed to the compositor whole.
 *
 * Two rules the callers cannot break: `prefers-reduced-motion` turns every
 * entry point into a plain assignment, and a hidden document runs nothing at
 * all — a popup that is closed, or a tab in the background, must not hold a
 * frame callback open.
 */
(() => {
  "use strict";
  if (self.LCTMotion) return;                     // one instance per page

  /* ---------- the one ticker ---------- */

  const jobs = new Set();
  let raf = 0;

  function frame(now) {
    raf = 0;
    /* Copied before iterating: a job that finishes removes itself, and a job
       that starts another one during its own step would otherwise be visited
       in the same frame with a start time in the future. */
    for (const job of [...jobs]) {
      if (job.step(now) === false) jobs.delete(job);
    }
    if (jobs.size) raf = requestAnimationFrame(frame);
  }

  function run(job) {
    jobs.add(job);
    if (!raf) raf = requestAnimationFrame(frame);
    return job;
  }

  /* A hidden document still fires rAF in some engines and never in others.
     Finish everything on the spot instead: the values are correct either way,
     and nothing is on screen to see them arrive. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    for (const job of [...jobs]) job.finish();
    jobs.clear();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  });

  /* ---------- reduced motion ---------- */

  let reduced = false;
  try {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    reduced = mq.matches;
    // addEventListener over the deprecated addListener, with a fallback for
    // engines that still only have the old one.
    if (mq.addEventListener) mq.addEventListener("change", (e) => { reduced = e.matches; });
    else if (mq.addListener) mq.addListener((e) => { reduced = e.matches; });
  } catch (_) { /* no matchMedia: assume motion is welcome */ }

  /* ---------- easing ----------
     One curve family, matching --ease in the stylesheets, so JS-driven and
     CSS-driven motion in the same panel cannot disagree about how things move. */

  const ease = {
    out: (p) => 1 - Math.pow(1 - p, 3),                       // cubic, the default
    outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    /* A settle with a little overshoot, for things that ARRIVE. Closed form,
       not a physics step: a spring integrated per frame is stateful, and two
       elements started in different frames then settle differently. */
    overshoot: (p) => {
      const c = 1.70158 * 1.1;
      const q = p - 1;
      return 1 + (c + 1) * q * q * q + c * q * q;
    }
  };

  /* ---------- values in flight ---------- */

  /**
   * Move a number from where it is to where it should be.
   * @returns a handle with .cancel() and .finish(); the tween also stops on
   *          its own if the element it belongs to leaves the document.
   */
  function tween({ from, to, dur = 420, curve = ease.out, onUpdate, onDone, el }) {
    if (typeof onUpdate !== "function") return null;
    if (reduced || dur <= 0 || from === to) {
      onUpdate(to, 1);
      if (onDone) onDone();
      return { cancel() {}, finish() {} };
    }
    const started = performance.now();
    const job = {
      step(now) {
        // An element removed mid-tween is a panel that repainted. Stop, and do
        // not write the final value: it would resurrect a detached node.
        if (el && !el.isConnected) return false;
        const p = Math.min(1, (now - started) / dur);
        onUpdate(from + (to - from) * curve(p), p);
        if (p < 1) return true;
        if (onDone) onDone();
        return false;
      },
      finish() { onUpdate(to, 1); if (onDone) onDone(); },
      cancel() { jobs.delete(job); }
    };
    onUpdate(from, 0);
    return run(job);
  }

  /**
   * A setter that retargets one long-lived tween instead of starting a new one.
   * This is the difference between a value that is written often — a progress
   * bar polled every 600 ms, a dial that repaints on a timer — costing one
   * tween and costing one tween per write.
   */
  function quickTo(apply, { dur = 420, curve = ease.out, el } = {}) {
    let current = null, target = null, from = 0, started = 0, job = null;
    const write = (v) => { current = v; apply(v); };
    return (value) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      if (current === null || reduced) { write(v); target = v; return; }
      if (v === target) return;
      target = v;
      from = current;
      started = performance.now();
      if (job) return;                       // already ticking: it will retarget
      job = {
        step(now) {
          if (el && !el.isConnected) { job = null; return false; }
          const p = Math.min(1, (now - started) / dur);
          write(from + (target - from) * curve(p));
          if (p < 1) return true;
          job = null;
          return false;
        },
        finish() { write(target); job = null; },
        cancel() { if (job) jobs.delete(job); job = null; }
      };
      run(job);
    };
  }

  /* ---------- text that changes ---------- */

  const seen = new Map();          // key -> the number this reader last saw

  /**
   * A number counts to its new value. A number the reader has never seen does
   * not animate — there is nothing to travel from, and a count-up from zero on
   * first paint is decoration pretending to be information.
   *
   * THE FORMATTER ALWAYS RECEIVES A WHOLE NUMBER. Every figure this panel
   * shows is a count or a percentage, and the reader was never offered a
   * fraction of one: rounding inside the formatter instead would mean each
   * caller had to remember, and the one that forgot counted a percentage up
   * through 62.4177%, which reads as a readout glitching rather than a value
   * arriving.
   *
   * @returns true when the value the reader was already looking at changed.
   */
  function number(el, key, to, format) {
    if (!el) return false;
    const fmt = format || ((n) => n.toLocaleString());
    const from = seen.has(key) ? seen.get(key) : null;
    seen.set(key, to);
    if (from === null || from === to || !Number.isFinite(from) || reduced) {
      el.textContent = fmt(Math.round(to));
      return from !== null && from !== to;
    }
    let last = null;
    tween({ from, to, dur: 420, el, onUpdate: (v) => {
      const n = Math.round(v);
      // Only when the whole number actually moved: at 420 ms most frames land
      // on the same integer, and rewriting the same text is layout for nothing.
      if (n === last) return;
      last = n;
      el.textContent = fmt(n);
    } });
    return true;
  }

  /** Forget what a reader last saw, so the next paint is a first paint. */
  function forget(key) { seen.delete(key); }

  /* ---------- enter, exit, and moving without shifting ---------- */

  const CURVE_CSS = "cubic-bezier(.22, 1, .36, 1)";

  /** Play a keyframe list on the compositor, or do nothing under reduced
   *  motion. Never rejects: a cancelled animation is a normal outcome. */
  function play(el, frames, opts = {}) {
    if (!el || reduced || typeof el.animate !== "function") return null;
    const a = el.animate(frames, {
      duration: opts.dur == null ? 320 : opts.dur,
      easing: opts.easing || CURVE_CSS,
      delay: opts.delay || 0,
      fill: opts.fill || "none",
      composite: opts.composite || "replace"
    });
    if (a.finished) a.finished.catch(() => {});
    return a;
  }

  /** Something appeared where there was already room for it. */
  function enter(el, opts = {}) {
    return play(el, [
      { opacity: 0, transform: `translateY(${opts.y == null ? 4 : opts.y}px)` },
      { opacity: 1, transform: "none" }
    ], { dur: 280, ...opts });
  }

  /**
   * FLIP: let the layout change, then animate the difference away.
   *
   * The elements end where the browser put them — this only replaces the JUMP
   * with a travel, using transforms, so nothing reflows during the motion. Pass
   * the nodes whose position matters and a function that performs the change.
   */
  function flip(nodes, mutate, opts = {}) {
    const list = [...nodes].filter(Boolean);
    if (reduced || !list.length) { mutate(); return; }
    const before = new Map();
    for (const el of list) before.set(el, el.getBoundingClientRect());
    mutate();
    for (const el of list) {
      const a = before.get(el);
      if (!a || !el.isConnected) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      // Sub-pixel movement is not motion; animating it costs a layer for nothing.
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { dur: opts.dur == null ? 360 : opts.dur });
    }
  }

  /**
   * Reveal a list in sequence rather than all at once. The delay is written as
   * a custom property and the stylesheet owns the animation, so N elements cost
   * N CSS animations on the compositor instead of N timers here.
   */
  function stagger(nodes, cls, each = 26, max = 10) {
    const list = [...nodes].filter(Boolean);
    if (reduced) return list.length;
    list.forEach((el, i) => {
      el.style.setProperty("--stagger", (Math.min(i, max) * each) + "ms");
      el.classList.add(cls);
    });
    return list.length;
  }

  /**
   * Restart a CSS animation that is already on the element. Reading offsetWidth
   * is the documented way to force the style flush between remove and add; it
   * is a layout read, so it is done once here rather than at every call site.
   */
  function replay(el, cls) {
    if (!el || reduced) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  self.LCTMotion = {
    get reduced() { return reduced; },
    ease, tween, quickTo, number, forget, play, enter, flip, stagger, replay,
    CURVE_CSS
  };
})();
