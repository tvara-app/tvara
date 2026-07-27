/**
 * Long Chat Toolkit — conversation minimap.
 * A compact conversation navigator: one bar per message
 * (accent = you, muted = AI, marker = contains code). Click or use the
 * keyboard to jump. The map stays intentionally quiet so it reads as a tool,
 * not another competing sidebar.
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
  // Resting = nobody is looking at it. The map spends most of its life here, so
  // it costs one hairline of screen and draws as a gradient rail; the waveform
  // is what you get when you actually go to it.
  let resting = true;
  let raf = 0;
  let onResize = null;     // kept so destroy() can remove it
  let ro = null;           // ResizeObserver on the strip
  let hoverIdx = -1;
  const metaCache = new WeakMap(); // el -> {role, hasCode, snippet}
  const rows = new WeakMap();      // el -> projected row (hosts with no stable ids)
  let projectDirty = true;         // the projection is stale — see project()
  // ChatGPT replaces old DOM rows while you scroll. Keep a lightweight catalog
  // keyed by its stable message IDs so the map reflects the full conversation
  // we have already seen, not just the virtualizer's current window.
  let catalogRoute = "";
  let catalogAdapter = null;
  let catalogOrder = [];
  let catalogPositions = new Map();
  const catalog = new Map();
  // Seeded = the provider told us the whole conversation up front, so the
  // catalog is the truth and the mounted window is just what happens to be
  // rendered right now. Un-seeded, it is the other way round.
  let seeded = false;
  let onStale = null;      // main.js hands us a "the seed looks wrong" callback

  // Canvas can't inherit CSS — read the same --lct-* tokens the panels use.
  let palette = null, paletteKey = "";
  const FALLBACK = {
    user: "#ff5d8a",
    ai: "rgba(226,198,208,.38)",
    code: "#ffc2d4",
    lens: "rgba(255,93,138,.13)",
    "lens-edge": "rgba(255,93,138,.55)",
    track: "rgba(255,220,230,.07)",
    // resting rail — a scrollbar's worth of colour, nothing else
    "rest-a": "rgba(255,93,138,.16)",
    "rest-b": "rgba(255,93,138,.34)",
    "thumb-a": "#ff7ea4",
    "thumb-b": "#e0396c"
  };

  function colors() {
    const theme = document.documentElement.dataset.lctTheme || "";
    if (palette && paletteKey === theme) return palette;
    paletteKey = theme;
    const cs = getComputedStyle(root);
    palette = {};
    for (const k in FALLBACK) {
      palette[k] = (cs.getPropertyValue("--lct-mm-" + k) || "").trim() || FALLBACK[k];
    }
    return palette;
  }

  function build() {
    if (root && root.isConnected) return;
    if (root && !root.isConnected) {
      // The host app tore our node out during its own re-render. Re-attach the
      // SAME element (listeners intact) instead of leaving the minimap gone.
      document.documentElement.appendChild(root);
      if (tooltip && !tooltip.isConnected) document.documentElement.appendChild(tooltip);
      return;
    }
    root = document.createElement("div");
    root.id = "lct-minimap";
    root.setAttribute("role", "navigation");
    root.setAttribute("aria-label", "Conversation navigator");
    root.innerHTML = `
      <button id="lct-mm-toggle" type="button" title="Collapse conversation navigator" aria-label="Collapse conversation navigator" aria-expanded="true">‹</button>
      <div id="lct-mm-stage">
        <canvas id="lct-mm-canvas" tabindex="0" role="slider" aria-label="Conversation position" aria-orientation="vertical"></canvas>
      </div>
    `;
    document.documentElement.appendChild(root);
    canvas = root.querySelector("#lct-mm-canvas");
    ctx = canvas.getContext("2d");

    tooltip = document.createElement("div");
    tooltip.id = "lct-mm-tooltip";
    document.documentElement.appendChild(tooltip);

    // Rest ⇄ open. CSS owns the width transition; JS only needs to know which
    // picture to paint, and to keep painting while the box is still moving.
    const setResting = (next) => {
      if (resting === next) return;
      resting = next;
      root.classList.toggle("lct-mm-rest", resting);
      if (resting) { hoverIdx = -1; motion.hoverY = -1; tooltip.style.display = "none"; }
      scheduleDraw();
    };
    root.classList.add("lct-mm-rest");
    root.addEventListener("pointerenter", () => setResting(false));
    root.addEventListener("pointerleave", () => setResting(true));
    root.addEventListener("focusin", () => setResting(false));
    root.addEventListener("focusout", () => {
      if (!root.matches(":hover")) setResting(true);
    });
    root.addEventListener("transitionrun", scheduleDraw);

    root.querySelector("#lct-mm-toggle").addEventListener("click", () => {
      collapsed = !collapsed;
      root.classList.toggle("lct-collapsed", collapsed);
      const toggle = root.querySelector("#lct-mm-toggle");
      toggle.textContent = collapsed ? "›" : "‹";
      toggle.title = collapsed ? "Expand conversation navigator" : "Collapse conversation navigator";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      scheduleDraw();
    });

    canvas.addEventListener("click", (e) => {
      const idx = yToIndex(e.offsetY);
      if (idx >= 0) jumpToIndex(idx);
    });
    canvas.addEventListener("mousemove", (e) => {
      const idx = yToIndex(e.offsetY);
      motion.hoverY = e.offsetY;
      if (idx !== hoverIdx) hoverIdx = idx;
      scheduleDraw();          // the magnifier follows the cursor, not the index
      if (idx >= 0 && messages[idx]) {
        const m = messages[idx];
        // A seeded entry has no element yet — its snippet came from the
        // provider, and there is no DOM node to read a timestamp off.
        const time = m.el && self.LCTTimeline ? self.LCTTimeline.label(m.el) : "";
        tooltip.textContent =
          (m.role === "user" ? "You: " : "AI: ") + m.snippet + (time ? "  ·  " + time : "");
        tooltip.style.display = "block";
        tooltip.style.top = Math.max(8, e.clientY - 14) + "px";
      } else {
        tooltip.style.display = "none";
      }
    });
    canvas.addEventListener("mouseleave", () => {
      tooltip.style.display = "none";
      hoverIdx = -1;
      motion.hoverY = -1;
      scheduleDraw();
    });
    canvas.addEventListener("keydown", (e) => {
      if (!messages.length) return;
      const vis = visibleRange();
      const current = vis ? vis.first : 0;
      let next = current;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = messages.length - 1;
      else if (e.key === "ArrowUp") next = current - 1;
      else if (e.key === "ArrowDown") next = current + 1;
      else if (e.key === "PageUp") next = current - Math.max(1, Math.round(messages.length * 0.12));
      else if (e.key === "PageDown") next = current + Math.max(1, Math.round(messages.length * 0.12));
      else return;
      e.preventDefault();
      jumpToIndex(Math.max(0, Math.min(messages.length - 1, next)));
    });

    // Zoom changes fire `resize` (not DOM mutations) — re-validate the
    // scroller here too, then redraw.
    onResize = () => {
      palette = null;
      if (messages.length) bindScroller([messages[0].el]);
      scheduleDraw();
    };
    window.addEventListener("resize", onResize, { passive: true });

    // Any box change (hover width, pill appearing, host chrome moving) redraws
    // at the new size — the strip never renders against a stale geometry.
    if (self.ResizeObserver) {
      ro = new ResizeObserver(scheduleDraw);
      ro.observe(canvas);
    }
  }

  // At 1,500 messages one pixel row covers three of them, so the ends of the
  // rail cannot address the first or last message by arithmetic alone. Snap
  // them: the top of a scrollbar has always meant "the beginning".
  const END_SNAP = 4;

  function yToIndex(y) {
    if (!messages.length) return -1;
    const h = canvas.clientHeight;
    if (y <= END_SNAP) return 0;
    if (y >= h - END_SNAP) return messages.length - 1;
    return Math.min(messages.length - 1, Math.max(0, Math.floor((y / h) * messages.length)));
  }

  // Cached for good: an id never changes, and the fallback branch is a subtree
  // query that was otherwise paid for every message on every engine tick — on
  // hosts that have no ids at all it never found anything to show for it.
  const keyCache = new WeakMap();

  function keyOf(el) {
    if (!el) return "";
    let k = keyCache.get(el);
    if (k !== undefined) return k;
    const id = el.getAttribute("data-message-id") ||
      el.querySelector?.("[data-message-id]")?.getAttribute("data-message-id");
    k = id ? "id:" + id : "";
    keyCache.set(el, k);
    return k;
  }

  function clearCatalog(route) {
    catalogRoute = route || "";
    catalogAdapter = null;
    catalogOrder = [];
    catalogPositions = new Map();
    catalog.clear();
    seeded = false;
    projectDirty = true;
    // A new conversation is a new map: replay the entrance and let the lens
    // land where it lands instead of sliding in from the last chat's position.
    motion.intro = 0;
    motion.lensY = null;
  }

  function reindexCatalog() {
    catalogPositions = new Map();
    for (let i = 0; i < catalogOrder.length; i++) catalogPositions.set(catalogOrder[i], i);
    projectDirty = true;
  }

  function isAtTop(msgEls) {
    if (!msgEls.length) return false;
    const activeScroller = self.LCTAdapters.findScroller(msgEls[0]);
    return activeScroller === document.scrollingElement || activeScroller === document.documentElement
      ? (window.scrollY || activeScroller.scrollTop) <= 4
      : activeScroller.scrollTop <= 4;
  }

  /** Merge a newly mounted virtual window into the stable conversation order. */
  function mergeCatalogOrder(keys, msgEls) {
    if (!catalogOrder.length) {
      catalogOrder = keys.slice();
      reindexCatalog();
      return;
    }

    let hasKnown = false;
    for (const key of keys) if (catalogPositions.has(key)) { hasKnown = true; break; }
    if (!hasKnown) {
      // A few virtualizers replace a whole page without retaining an overlap.
      // During the initial crawl a top window precedes what we already know.
      catalogOrder = isAtTop(msgEls) ? keys.concat(catalogOrder) : catalogOrder.concat(keys);
      reindexCatalog();
      return;
    }

    let i = 0;
    let previous = null;
    let changed = false;
    while (i < keys.length) {
      const key = keys[i];
      if (catalogPositions.has(key)) {
        previous = key;
        i++;
        continue;
      }
      const start = i;
      while (i < keys.length && !catalogPositions.has(keys[i])) i++;
      const additions = keys.slice(start, i);
      const next = i < keys.length ? keys[i] : null;
      if (next) {
        const at = catalogPositions.get(next);
        catalogOrder.splice(at, 0, ...additions);
      } else if (previous) {
        const at = catalogPositions.get(previous);
        catalogOrder.splice(at + 1, 0, ...additions);
      } else {
        catalogOrder.push(...additions);
      }
      reindexCatalog();
      changed = true;
    }
    if (changed) reindexCatalog();
  }

  function metaFor(el, adapter, isTail) {
    let meta = metaCache.get(el);
    if (!meta || isTail) {
      const text = (el.textContent || "").trim();
      meta = {
        role: safeRole(adapter, el),
        hasCode: !!el.querySelector("pre"),
        snippet: text.slice(0, 80) || "Image / attachment",
        len: text.length      // drives tick width — see norm()
      };
      metaCache.set(el, meta);
    }
    return meta;
  }

  function updateMessages(msgEls, adapter) {
    // The CONVERSATION, not location.href. The hosts rewrite their own query
    // string and hash constantly (model pickers, scroll anchors, share flags);
    // keying on href threw the whole catalog away several times a minute and
    // replayed the entrance sweep, which is what read as a flickering map.
    const route = location.hostname + location.pathname;
    if (catalogRoute !== route) clearCatalog(route);
    catalogAdapter = adapter;
    const keys = msgEls.map(keyOf);
    const allStable = keys.length > 0 && keys.every(Boolean);

    if (!allStable) {
      // Other platforms often keep their whole transcript mounted. Do not risk
      // merging identical text-only prompts into a false history there.
      // Rows are reused per element rather than rebuilt: this path runs on
      // every engine tick, and a fresh object per message was the map's
      // steady-state garbage on Claude and Gemini.
      messages = msgEls.map((el, i) => {
        const meta = metaFor(el, adapter, i >= msgEls.length - 3);
        let row = rows.get(el);
        if (!row) { row = { el, key: "" }; rows.set(el, row); }
        row.role = meta.role;
        row.hasCode = meta.hasCode;
        row.snippet = meta.snippet;
        row.len = meta.len;
        return row;
      });
      return;
    }

    if (seeded) mergeIntoSeed(keys);
    else mergeCatalogOrder(keys, msgEls);

    for (let i = 0; i < msgEls.length; i++) {
      const el = msgEls[i];
      const key = keys[i];
      const meta = metaFor(el, adapter, i >= msgEls.length - 3);
      let entry = catalog.get(key);
      if (!entry) { entry = { key }; projectDirty = true; }
      entry.el = el;
      entry.role = meta.role;
      // The index guesses at code from a ``` in the text; a mounted row has the
      // actual <pre>. The mark can therefore appear or vanish on mount — the
      // DOM is what the reader can see, so it wins.
      entry.hasCode = meta.hasCode;
      entry.snippet = meta.snippet;
      entry.len = meta.len;
      catalog.set(key, entry);
    }
    project();
  }

  // The projection only changes when the ORDER does. Entries are mutated in
  // place, so rebuilding this array on every tick allocated a fresh n-slot copy
  // of a list that was already correct.
  const project = () => {
    if (!projectDirty) return;
    projectDirty = false;
    messages = catalogOrder.map((key) => catalog.get(key)).filter(Boolean);
  };

  /**
   * Reconcile a freshly mounted window against a provider seed.
   *
   * mergeCatalogOrder's "is the scroller at the top?" guess exists for hosts
   * with no stable ids. Under a seed it can only ever be wrong: we already know
   * the whole order, so an unknown key means the conversation changed under us.
   */
  function mergeIntoSeed(keys) {
    const unknown = keys.filter((k) => !catalogPositions.has(k));
    if (!unknown.length) return;

    if (unknown.length === keys.length) {
      // Not one message in common: an edit or regenerate moved the reader onto
      // a different branch. The seed describes a conversation that is no longer
      // on screen — drop it rather than splice fiction into it.
      const route = catalogRoute;
      clearCatalog(route);
      if (onStale) onStale();
      return;
    }
    if (!catalogPositions.has(keys[keys.length - 1])) {
      catalogOrder.push(...unknown);      // a reply streaming in after the fetch
      reindexCatalog();
      return;
    }
    mergeCatalogOrder(keys, []);          // an edit mid-conversation
    if (onStale) onStale();
  }

  /**
   * Seed the catalog from the provider's index: the whole conversation, before
   * the host has mounted any of it. Entries carry no element — they bind to one
   * in updateMessages() as the host gets round to rendering them.
   */
  function seed(entries, route) {
    if (!Array.isArray(entries) || entries.length < 4) return false;
    if (catalogRoute !== route) clearCatalog(route);

    const order = [];
    const known = new Set();
    for (const e of entries) {
      if (!e || !e.i) continue;
      const key = "id:" + e.i;
      if (known.has(key)) continue;       // a provider that repeats an id must not double a tick
      known.add(key);
      order.push(key);
      const entry = catalog.get(key) || { key, el: null };
      // Whatever is mounted beats the index — it is what the reader can see.
      if (!entry.el) {
        entry.role = e.r === "user" ? "user" : "assistant";
        entry.hasCode = !!e.c;
        entry.snippet = e.s || "Image / attachment";
        entry.len = e.n || 0;
      }
      catalog.set(key, entry);
    }
    if (order.length < 4) return false;
    // Anything already mounted that the index has never heard of is real and
    // newer than the fetch — a reply that streamed in while we were asking.
    for (const key of catalogOrder) {
      if (known.has(key)) continue;
      const entry = catalog.get(key);
      if (entry && entry.el && entry.el.isConnected) order.push(key);
    }
    catalogOrder = order;
    reindexCatalog();
    seeded = true;
    project();

    build();                              // paint before the engine's first tick
    canvas.setAttribute("aria-valuemin", "1");
    canvas.setAttribute("aria-valuemax", String(messages.length));
    if (messages.length >= 4) root.style.display = "flex";
    scheduleDraw();
    return true;
  }

  const setStaleHandler = (fn) => { onStale = typeof fn === "function" ? fn : null; };

  function update(msgEls, adapter) {
    build();
    // Serializing textContent of every message on every update is exactly the
    // jank we sell against. Cache per element, and for ChatGPT retain metadata
    // across virtualized windows so loaded history remains represented.
    updateMessages(msgEls, adapter);
    canvas.setAttribute("aria-valuemin", "1");
    canvas.setAttribute("aria-valuemax", String(messages.length));

    if (msgEls.length) bindScroller(msgEls);

    // Stay out of the way: hide under the host's own modal dialogs and in
    // windows too small to give up 24px of edge space.
    const dlg = document.querySelector('dialog[open], [aria-modal="true"]');
    const modalOpen = !!(dlg && dlg.getBoundingClientRect().width > 0);
    const roomy = innerWidth > 640 && innerHeight > 320;
    root.style.display = !modalOpen && roomy && messages.length >= 4 ? "flex" : "none";
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

  /* ---------- motion ----------
     One rAF loop that stops the instant nothing is easing. A navigator holding
     a frame timer open across a 5,000-message chat would be exactly the lag
     this extension exists to remove. draw() returns whether it still owes a
     frame; nothing else schedules one. */
  const motion = {
    lensY: null, lensH: 0,   // eased lens geometry; null = snap on first paint
    hoverY: -1, hoverK: 0,   // cursor position in canvas px + magnifier strength
    intro: 0                 // 0..1 entrance sweep
  };
  let reduceMotion = false;
  try { reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}

  const ease = (cur, target, k) => cur + (target - cur) * k;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smoothstep = (t) => t * t * (3 - 2 * t);

  function scheduleDraw() {
    if (raf) return;             // a frame is already owed — never stack them
    raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (draw()) scheduleDraw();
  }

  /** Rounded rect, falling back to a plain one on old engines. */
  function box(x, y, w, h, r) {
    if (r > 0.6 && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
    else ctx.fillRect(x, y, w, h);
  }

  /**
   * Visible message indices, by binary search over document order (~log2(n)
   * rect reads). scrollHeight lies here — content-visibility makes it an
   * estimate that shifts as messages wake, swelling the old indicator.
   *
   * `live` is refilled in place rather than rebuilt. This runs on every scroll
   * event and every eased frame, and a 5,000-entry array of fresh objects per
   * frame is collector pressure during exactly the scroll we are selling as
   * smooth. Indices only — the element is one lookup away.
   */
  const live = [];

  function visibleRange() {
    live.length = 0;
    for (let i = 0; i < messages.length; i++) {
      const el = messages[i].el;
      if (el && el.isConnected) live.push(i);
    }
    const n = live.length;
    if (!n) return null;
    let top = 0, bottom = innerHeight;
    if (scroller && scroller !== document.scrollingElement && scroller !== document.documentElement) {
      const r = scroller.getBoundingClientRect();
      top = r.top; bottom = r.bottom;
    }
    const search = (test) => {
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (test(messages[live[mid]].el.getBoundingClientRect())) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const first = search((r) => r.bottom > top);
    const last = search((r) => r.top >= bottom) - 1;
    return last < first ? null : { first: live[first], last: live[last] };
  }

  /**
   * The conversation as a rhythm of fine ticks, not a stack of slabs.
   *
   * Three rules carry the whole design:
   *   · a tick is never taller than TICK_MAX — a ten-message chat reads as ten
   *     hairlines with air between them, not ten fat blocks;
   *   · length encodes who spoke (you run the full width, the AI runs short),
   *     so the right edge becomes a silhouette of the conversation's shape;
   *   · everything outside the viewport lens dims, so the map concentrates
   *     around where you actually are.
   *
   * @returns {boolean} true when an eased value still owes another frame.
   */
  const TICK_MAX = 4.5;
  const GUTTER = 3.5;      // right-hand column reserved for code marks
  const CODE_W = 1.5;      // narrow on purpose: a landmark, not a second bar
  const MAG_REACH = 26;    // px of cursor falloff for the magnifier
  const LEN_REF = 900;     // chars that read as a full-width tick

  /**
   * Tick width, 0..1, from message length.
   *
   * Role was the obvious thing to encode here and it turned out to be the wrong
   * one: turns alternate, so at any real density the user/AI split averages to a
   * flat two-tone column that says nothing. Length actually varies — long
   * answers bulge, quick prompts pinch — so the strip becomes a waveform of the
   * conversation's shape. sqrt keeps one enormous message from flattening the rest.
   */
  // Memoized on the row: at 5,000 messages this is called once per message per
  // frame, and a row's length only moves while it streams.
  const norm = (m) => {
    if (m.w === undefined || m.wLen !== m.len) {
      m.wLen = m.len;
      m.w = Math.min(1, Math.sqrt((m.len || 0) / LEN_REF));
    }
    return m.w;
  };

  /**
   * The resting rail: what the map looks like when nobody is reading it.
   *
   * At 6px of width a waveform is noise, so it stops pretending to be one and
   * becomes the thing it is at that size — a scrollbar. A gradient track for
   * the conversation, a bright thumb for where you are. The information
   * survives the collapse; only the detail is spent.
   */
  function drawRest(w, h, c, vis, n) {
    const railW = Math.min(w, 4.5);
    const x = (w - railW) / 2;
    const r = railW / 2;

    const track = ctx.createLinearGradient(0, 0, 0, h);
    track.addColorStop(0, c["rest-a"]);
    track.addColorStop(.5, c["rest-b"]);
    track.addColorStop(1, c["rest-a"]);
    ctx.globalAlpha = motion.intro;
    ctx.fillStyle = track;
    box(x, 0, railW, h, r);

    if (vis) {
      // Same floor as the lens: a true-to-scale thumb in a 1,500-turn chat is
      // three pixels of nothing.
      const th = Math.max(18, Math.min(h, motion.lensH));
      const ty = Math.max(0, Math.min(h - th, motion.lensY + (motion.lensH - th) / 2));
      const thumb = ctx.createLinearGradient(0, ty, 0, ty + th);
      thumb.addColorStop(0, c["thumb-a"]);
      thumb.addColorStop(1, c["thumb-b"]);
      ctx.fillStyle = thumb;
      box(x, ty, railW, th, r);
    }
    ctx.globalAlpha = 1;

    canvas.setAttribute("aria-valuenow", String(vis ? vis.first + 1 : 1));
    canvas.setAttribute("aria-valuetext", vis
      ? "Viewing messages " + (vis.first + 1) + " through " + (vis.last + 1) + " of " + n
      : n + " messages in this conversation");
  }

  function draw() {
    if (!canvas || collapsed || !messages.length) return false;
    // dpr capped at 2: beyond that the backing store costs more than it shows
    const dpr = Math.min(2, devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w < 4 || h < 8) return false;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;              // resets the context transform
      canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);

    const c = colors();
    const n = messages.length;
    const padX = 1.5;
    const full = w - padX * 2;
    const trackW = Math.max(3, full - GUTTER);
    const step = h / n;
    let owed = false;

    /* ---- eased state ---- */
    if (reduceMotion) motion.intro = 1;
    else if (motion.intro < 1) { motion.intro = Math.min(1, motion.intro + 0.07); owed = true; }

    const vis = visibleRange();
    const lensToY = vis ? vis.first * step : 0;
    // Floor of 15px: in a 1,500-turn chat a true-to-scale lens is 3px tall and
    // simply cannot be found. Slightly generous beats invisible.
    const lensToH = vis ? Math.max(15, (vis.last - vis.first + 1) * step) : h;
    if (motion.lensY === null || reduceMotion) {
      motion.lensY = lensToY; motion.lensH = lensToH;
    } else {
      motion.lensY = ease(motion.lensY, lensToY, .26);
      motion.lensH = ease(motion.lensH, lensToH, .26);
      if (Math.abs(motion.lensY - lensToY) > .4 || Math.abs(motion.lensH - lensToH) > .4) owed = true;
      else { motion.lensY = lensToY; motion.lensH = lensToH; }
    }

    const hoverTo = hoverIdx >= 0 ? 1 : 0;
    if (reduceMotion) motion.hoverK = hoverTo;
    else {
      motion.hoverK = ease(motion.hoverK, hoverTo, .24);
      if (Math.abs(motion.hoverK - hoverTo) > .01) owed = true;
      else motion.hoverK = hoverTo;
    }

    if (resting) { drawRest(w, h, c, vis, n); return owed; }

    const lensTop = motion.lensY, lensBot = motion.lensY + motion.lensH;
    const falloff = h * .28;
    /** Attention, as a number: full inside the lens, easing away outside it. */
    const focus = (y) => {
      if (y >= lensTop && y <= lensBot) return 1;
      const d = y < lensTop ? lensTop - y : y - lensBot;
      return .3 + .5 * Math.exp(-d / falloff);
    };
    /** Dock-style swell around the cursor. */
    const magnify = (y) => {
      if (motion.hoverK < .01 || motion.hoverY < 0) return 0;
      const d = Math.abs(y - motion.hoverY);
      return d > MAG_REACH ? 0 : motion.hoverK * smoothstep(1 - d / MAG_REACH);
    };
    /** Entrance sweep, top to bottom, each tick trailing the one above it. */
    const reveal = (i) => (motion.intro >= 1 ? 1 : clamp01((motion.intro - (i / n) * .55) / .45));

    /* ---- the thread: a hairline the ticks hang from ---- */
    ctx.fillStyle = c.track;
    ctx.globalAlpha = motion.intro;
    ctx.fillRect(padX, 0, 1, h);
    ctx.globalAlpha = 1;

    /* ---- the lens: a soft band with two caps, never a boxed outline ---- */
    const lh = Math.min(motion.lensH, h - motion.lensY);
    const showLens = vis && vis.last - vis.first + 1 < n;
    if (showLens) {
      ctx.globalAlpha = motion.intro;
      ctx.fillStyle = c.lens;
      box(0, motion.lensY, w, lh, 4);
      // Caps, not a border. Two bright rules spanning the full width read as a
      // film-strip selection; a rectangle outline reads as a form field.
      ctx.fillStyle = c["lens-edge"];
      ctx.fillRect(0, motion.lensY, w, 1.5);
      ctx.fillRect(0, motion.lensY + lh - 1.5, w, 1.5);
      ctx.globalAlpha = 1;
    }

    if (step < 1.4) {
      // Below ~1px per message the ticks fuse, so each pixel row reports the
      // longest turn it covers — the waveform survives the compression. Plain
      // fillRect here: at this density rounded paths cost more than they show.
      const rows = Math.max(1, Math.round(h));
      const per = n / rows;
      for (let y = 0; y < rows; y++) {
        const a = Math.floor(y * per);
        const b = Math.min(n, Math.max(a + 1, Math.floor((y + 1) * per)));
        let wide = 0, code = false;
        for (let i = a; i < b; i++) {
          const m = messages[i];
          const v = norm(m);
          if (v > wide) wide = v;
          if (m.hasCode) code = true;
        }
        const alpha = reveal(a) * Math.min(1, focus(y) + magnify(y) * .5);
        if (alpha <= 0) continue;
        // No role colouring here, deliberately. Turns alternate, so every pixel
        // row covers both speakers and any two-tone split floods to a solid
        // accent bar that claims a distinction it cannot actually resolve. The
        // accent is spent on something it can still say honestly at this scale:
        // where you are.
        ctx.globalAlpha = alpha;
        ctx.fillStyle = (y >= lensTop && y <= lensBot) ? c.user : c.ai;
        ctx.fillRect(padX, y, trackW * (.2 + .8 * wide), 1);
        if (code) {
          ctx.fillStyle = c.code;
          ctx.fillRect(padX + trackW + 1.5, y, CODE_W, 1);
        }
      }
      ctx.globalAlpha = 1;
    } else {
      const gap = step > 6 ? 2.2 : step > 3 ? 1.1 : step > 1.8 ? .6 : 0;
      const barH = Math.max(1.4, Math.min(TICK_MAX, step - gap));
      const r = Math.min(barH / 2, 2);
      for (let i = 0; i < n; i++) {
        const m = messages[i];
        // Centred in its slot, so sparse chats stay evenly spaced hairlines.
        const y = i * step + (step - barH) / 2;
        const mid = y + barH / 2;
        const shown = reveal(i);
        if (shown <= 0) continue;
        const mag = magnify(mid);
        const user = m.role === "user";
        // A prompt never shrinks below a readable stub, however terse it was.
        const base = trackW * (user ? .3 + .7 * norm(m) : .2 + .8 * norm(m));
        ctx.globalAlpha = shown * Math.min(1, focus(mid) + mag * .5);
        ctx.fillStyle = user ? c.user : c.ai;
        box(padX, y, Math.min(trackW, base + mag * 3.5), barH, r);
        if (m.hasCode) {
          ctx.fillStyle = c.code;
          box(padX + trackW + 1.5, y, CODE_W, barH, .75);
        }
      }
      ctx.globalAlpha = 1;
    }

    if (showLens) {
      canvas.setAttribute("aria-valuenow", String(vis.first + 1));
      canvas.setAttribute("aria-valuetext", "Viewing messages " + (vis.first + 1) + " through " + (vis.last + 1) + " of " + n);
    } else {
      canvas.setAttribute("aria-valuenow", "1");
      canvas.setAttribute("aria-valuetext", n + " messages in this conversation");
    }
    return owed;
  }

  function destroy() {
    cancelAnimationFrame(raf); raf = 0;
    motion.intro = 0; motion.lensY = null; motion.hoverK = 0; motion.hoverY = -1;
    if (scrollTarget) { scrollTarget.removeEventListener("scroll", scheduleDraw); scrollTarget = null; }
    if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
    if (ro) { ro.disconnect(); ro = null; }
    if (root) { root.remove(); root = null; canvas = null; ctx = null; }
    if (tooltip) { tooltip.remove(); tooltip = null; }
    messages = []; scroller = null; palette = null; hoverIdx = -1; resting = true;
    clearCatalog();
  }

  /* ---------- seeking to a row the host has unmounted ----------
     The old version scrolled to index/total × scrollHeight. That is only true
     when every message is the same height, which is never: one click landed
     hundreds of turns away and the map looked broken. Instead, bracket the
     target between the nearest rows that ARE mounted and interpolate inside
     that bracket — geometry we can actually measure. Each round re-brackets,
     because the host pages in more history as we approach. */

  const rootScroller = (s) => s === document.scrollingElement || s === document.documentElement;

  function scrollTopOf(s) {
    return rootScroller(s) ? (window.scrollY || s.scrollTop || 0) : s.scrollTop;
  }

  function setScrollTop(s, top) {
    const max = Math.max(0, s.scrollHeight - s.clientHeight);
    const next = Math.max(0, Math.min(max, top));
    if (rootScroller(s)) window.scrollTo({ top: next, left: 0, behavior: "auto" });
    else s.scrollTop = next;
  }

  /** Position of `el` inside the scroller's own content box. */
  function offsetIn(s, el) {
    const r = el.getBoundingClientRect();
    const base = rootScroller(s) ? 0 : s.getBoundingClientRect().top;
    return r.top - base + scrollTopOf(s);
  }

  const mounted = (entry) => !!(entry && entry.el && entry.el.isConnected && entry.el.getBoundingClientRect().height > 0);

  /** Average mounted message height — the only honest ruler for unmounted gaps. */
  function averageHeight() {
    let sum = 0, seen = 0;
    for (let i = 0; i < messages.length && seen < 24; i++) {
      const m = messages[i];
      if (!m.el || !m.el.isConnected) continue;
      const h = m.el.getBoundingClientRect().height;
      if (h > 0) { sum += h; seen++; }
    }
    return seen ? sum / seen : 320;
  }

  /** Re-resolve a catalog entry against the live DOM (the row may have remounted). */
  function remount(entry) {
    if (!entry || !entry.key) return null;
    const id = entry.key.slice(3);            // "id:<message-id>"
    let el = null;
    try {
      el = document.querySelector('[data-message-id="' + CSS.escape(id) + '"]');
      if (!el && catalogAdapter) {
        el = catalogAdapter.messages().find((n) => keyOf(n) === entry.key) || null;
      }
    } catch (_) {}
    if (el) entry.el = el;
    return el;
  }

  /** One step of the search: move the scroller toward where `index` must live. */
  function stepToward(index) {
    if (!scroller) return;
    let lo = -1, hi = -1;
    for (let i = index - 1; i >= 0; i--) if (mounted(messages[i])) { lo = i; break; }
    for (let i = index + 1; i < messages.length; i++) if (mounted(messages[i])) { hi = i; break; }

    const centre = scroller.clientHeight / 2;
    let top;
    if (lo >= 0 && hi >= 0) {
      const a = offsetIn(scroller, messages[lo].el);
      const b = offsetIn(scroller, messages[hi].el);
      top = a + (b - a) * ((index - lo) / (hi - lo));
    } else if (lo >= 0) {
      top = offsetIn(scroller, messages[lo].el) + (index - lo) * averageHeight();
    } else if (hi >= 0) {
      top = offsetIn(scroller, messages[hi].el) - (hi - index) * averageHeight();
    } else {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      top = max * (index / Math.max(1, messages.length - 1)) + centre;
    }
    setScrollTop(scroller, top - centre);
  }

  const ROUNDS = 16;

  function jumpToIndex(index) {
    const entry = messages[index];
    if (!entry) return;
    if (mounted(entry) || remount(entry)) return jump(entry.el);
    if (!entry.key || !scroller) return;      // no stable id — nothing to seek to

    // Reading it should not have to wait for the host to render it. The index
    // already carries the text, so the message is on screen immediately and the
    // real navigation happens behind the preview.
    self.LCTPreview.open(entry, index, messages.length);

    let above = -1;
    for (let i = index - 1; i >= 0; i--) if (mounted(messages[i])) { above = i; break; }

    // Nothing mounted above it means there is nothing to interpolate BETWEEN:
    // the rows simply are not there, and only the host's own upward paging
    // produces them. The old code extrapolated a negative offset, clamped it to
    // zero and slammed into the top sixteen times — which is exactly why
    // clicking the top of the map did nothing.
    if (above < 0) {
      const began = self.LCTHistoryLoader.seekTo(catalogAdapter, {
        id: entry.key.slice(3),
        index,
        total: messages.length,
        arrive: (reached) => {
          if (mounted(entry) || remount(entry)) { self.LCTPreview.close(); return jump(entry.el); }
          if (!reached) self.LCTPreview.note("This is as far back as the site will load.");
        }
      });
      if (began) return;
    }

    let rounds = 0;
    const seek = () => {
      if (mounted(entry) || remount(entry)) { self.LCTPreview.close(); return jump(entry.el); }
      if (++rounds > ROUNDS) return;          // host has no more history to give
      stepToward(index);
      setTimeout(seek, 110);
    };
    seek();
  }

  /** Jump by stable message key — the outline's starred rows enter here. */
  function jumpToKey(key) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].key === key) { jumpToIndex(i); return true; }
    }
    return false;
  }

  const jump = (el) => self.LCTNav.jumpTo(el, { scroller, block: "center" });

  self.LCTMinimap = {
    update, destroy, jumpToKey, seed, setStaleHandler,
    get count() { return messages.length; }
  };
})();
