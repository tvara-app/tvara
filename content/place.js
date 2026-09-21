/**
 * Tvara — where a floating control may sit.
 *
 * The star and the time label float over the host page, and a host keeps its
 * own controls exactly where they would land: a code block's Copy at the top
 * right of an answer, a sticky header across the top, an action bar under it.
 * Covering one hides it; a hit area over one steals its click (1.0.0 starred
 * the message on every press of ChatGPT's Copy code). So a spot is chosen from
 * a short list and only taken when nothing a person could press is under it.
 */
(() => {
  "use strict";

  const CONTROL =
    'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], ' +
    '[role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [contenteditable="true"], [contenteditable=""]';
  const OURS = "#lct-star, #lct-time-tag";
  const ALL_OURS = '[id^="lct-"]';   // our map and bar: covered only when nothing else is free
  const EDGE = 4;
  const PAD = 3;   // breathing room, and a box edge sampled exactly misses a touching button

  /** Topmost host element at a point; our own floating nodes are see-through. */
  function hostAt(x, y) {
    let stack;
    try { stack = document.elementsFromPoint(x, y); } catch (_) { return null; }
    for (const el of stack) if (!el.closest(ALL_OURS)) return el;
    return null;
  }

  function isControl(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    if (el.closest(CONTROL)) return true;
    // div-and-onclick buttons state themselves only through the cursor
    try { return getComputedStyle(el).cursor === "pointer"; } catch (_) { return false; }
  }

  /** A host control under the point — looked for BENEATH our map and bar too,
      which would otherwise hide one — or, when `strict`, any of our own UI. */
  function blocked(x, y, strict) {
    let stack;
    try { stack = document.elementsFromPoint(x, y); } catch (_) { return true; }
    for (const el of stack) {
      if (el.closest(OURS)) continue;
      if (el.closest(ALL_OURS)) { if (strict) return true; continue; }
      return isControl(el);
    }
    return false;
  }

  /** On screen, and nothing pressable within PAD of the box. */
  function clear(x, y, w, h, strict = true) {
    if (x < EDGE || y < EDGE || x + w > innerWidth - EDGE || y + h > innerHeight - EDGE) return false;
    const x0 = x - PAD, y0 = y - PAD, W = w + 2 * PAD, H = h + 2 * PAD;
    const cols = Math.ceil(W / 10) + 1, rows = Math.ceil(H / 10) + 1;   // finer than any control
    for (let i = 0; i < rows; i++) {
      const py = y0 + (H * i) / (rows - 1);
      for (let j = 0; j < cols; j++) {
        if (blocked(x0 + (W * j) / (cols - 1), py, strict)) return false;
      }
    }
    return true;
  }

  /**
   * First y at which the message itself shows at column `x`. A host header
   * pinned over the top of the viewport covers a message scrolled under it,
   * and a spot clamped to the viewport's top edge lands on that header.
   */
  function visibleTop(m, r, x) {
    const top = Math.max(0, r.top);
    if (top > 200) return top;
    const end = Math.min(r.bottom, innerHeight, top + 240);
    for (let y = top + 1; y < end; y += 8) {
      const el = hostAt(x, y);
      if (el && (el === m || m.contains(el))) return y;
    }
    return top;
  }

  /**
   * First clear spot of `spots` ([x, y] pairs) for a w×h box; failing that,
   * the first where only our own UI is under it; else null — no spot beats a
   * spot on somebody's button.
   */
  function pick(spots, w, h) {
    for (const strict of [true, false]) {
      for (const s of spots) if (s && clear(s[0], s[1], w, h, strict)) return s;
    }
    return null;
  }

  self.LCTPlace = { clear, pick, visibleTop, hostAt, isControl };
})();
