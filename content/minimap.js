/**
 * Long Chat Toolkit — conversation minimap.
 * A slim canvas strip on the right edge: one bar per message
 * (accent = you, muted = AI, dot = contains code). Click to jump.
 * Canvas rendering: even a 5,000-message chat costs one draw call — we will
 * not fight lag by adding lag.
 */
(() => {
  "use strict";

  let root = null, canvas = null, ctx = null, tooltip = null;
  let messages = [];       // [{el, role, hasCode, snippet}]
  let scroller = null;
  let scrollTarget = null; // what we bound the scroll listener to (element or window)
  let collapsed = false;
  let raf = 0;

  const W = 18;            // strip width (px)
  const COLORS = () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    return {
      user: dark ? "#7aa2ff" : "#3b6cff",
      assistant: dark ? "#4a4f5a" : "#c9cdd6",
      code: dark ? "#ffb454" : "#e08700",
      viewport: dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"
    };
  };

  function build() {
    if (root) return;
    root = document.createElement("div");
    root.id = "lct-minimap";
    root.innerHTML = `
      <button id="lct-mm-toggle" title="Toggle minimap (Long Chat Toolkit)">‹</button>
      <canvas id="lct-mm-canvas"></canvas>
    `;
    document.documentElement.appendChild(root);
    canvas = root.querySelector("#lct-mm-canvas");
    ctx = canvas.getContext("2d");

    tooltip = document.createElement("div");
    tooltip.id = "lct-mm-tooltip";
    document.documentElement.appendChild(tooltip);

    root.querySelector("#lct-mm-toggle").addEventListener("click", () => {
      collapsed = !collapsed;
      root.classList.toggle("lct-collapsed", collapsed);
      root.querySelector("#lct-mm-toggle").textContent = collapsed ? "›" : "‹";
    });

    canvas.addEventListener("click", (e) => {
      const idx = yToIndex(e.offsetY);
      if (idx >= 0 && messages[idx]) {
        messages[idx].el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    canvas.addEventListener("mousemove", (e) => {
      const idx = yToIndex(e.offsetY);
      if (idx >= 0 && messages[idx]) {
        tooltip.textContent = (messages[idx].role === "user" ? "You: " : "AI: ") + messages[idx].snippet;
        tooltip.style.display = "block";
        tooltip.style.top = Math.max(8, e.clientY - 14) + "px";
      } else {
        tooltip.style.display = "none";
      }
    });
    canvas.addEventListener("mouseleave", () => (tooltip.style.display = "none"));

    // Zoom changes fire `resize` (not DOM mutations) — re-validate the
    // scroller here too, then redraw.
    window.addEventListener(
      "resize",
      () => {
        if (messages.length) bindScroller([messages[0].el]);
        scheduleDraw();
      },
      { passive: true }
    );
  }

  function yToIndex(y) {
    if (!messages.length) return -1;
    return Math.min(messages.length - 1, Math.max(0, Math.floor((y / canvas.clientHeight) * messages.length)));
  }

  function update(msgEls, adapter) {
    build();
    messages = msgEls.map((el) => ({
      el,
      role: safeRole(adapter, el),
      hasCode: !!el.querySelector("pre"),
      snippet: (el.textContent || "").trim().slice(0, 80) || "📷 image / attachment"
    }));

    if (msgEls.length) bindScroller(msgEls);
    root.style.display = messages.length >= 10 ? "flex" : "none";
    scheduleDraw();
  }

  function safeRole(adapter, el) {
    try { return adapter.role(el); } catch (_) { return "assistant"; }
  }

  /**
   * (Re)bind the scroll listener. The host app rebuilds its scroll container
   * on zoom, resize and chat switches — a cached scroller goes stale and the
   * viewport indicator floods the whole strip. Re-validate on every update.
   */
  function bindScroller(msgEls) {
    const found = self.LCTAdapters.findScroller(msgEls[0]);
    if (found === scroller && scroller && scroller.isConnected) return;
    if (scrollTarget) scrollTarget.removeEventListener("scroll", scheduleDraw);
    scroller = found;
    scrollTarget =
      scroller === document.scrollingElement || scroller === document.documentElement
        ? window
        : scroller;
    scrollTarget.addEventListener("scroll", scheduleDraw, { passive: true });
  }

  function scheduleDraw() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  }

  function draw() {
    if (!canvas || collapsed || !messages.length) return;
    const dpr = devicePixelRatio || 1;
    const h = canvas.clientHeight, w = canvas.clientWidth;
    if (!w || !h) return;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;              // resets the context transform
      canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);

    const c = COLORS();
    const n = messages.length;
    const barH = Math.max(1.5, (h / n) * 0.72);
    const step = h / n;

    for (let i = 0; i < n; i++) {
      const m = messages[i];
      ctx.fillStyle = m.role === "user" ? c.user : c.assistant;
      const bw = m.role === "user" ? w - 6 : w - 9;
      ctx.fillRect(3, i * step, bw, barH);
      if (m.hasCode) {
        ctx.fillStyle = c.code;
        ctx.fillRect(w - 5, i * step, 2.5, barH);
      }
    }

    // viewport indicator — only when it's meaningful. If the scroller is
    // stale/non-scrolling the indicator would flood the whole strip; skip it.
    if (scroller && scroller.isConnected) {
      const total = scroller.scrollHeight || 1;
      const vh = Math.max(14, (scroller.clientHeight / total) * h);
      if (vh < h * 0.9) {
        const top = (scroller.scrollTop / total) * h;
        ctx.fillStyle = c.viewport;
        ctx.fillRect(0, top, w, vh);
      }
    }
  }

  function destroy() {
    if (scrollTarget) { scrollTarget.removeEventListener("scroll", scheduleDraw); scrollTarget = null; }
    if (root) { root.remove(); root = null; canvas = null; ctx = null; }
    if (tooltip) { tooltip.remove(); tooltip = null; }
    messages = []; scroller = null;
  }

  self.LCTMinimap = { update, destroy };
})();
