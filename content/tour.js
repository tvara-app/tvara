/**
 * Tvara — the guided tour and the hover labels.
 *
 * The whole UI is 13px of colour docked to the right edge until someone hovers
 * it, so nothing here is discoverable by looking. This file is the only place
 * the extension explains itself: coach marks anchored to the real controls, on
 * the first real conversation, plus the instant labels the native `title`
 * tooltip is too slow and too clipped to provide.
 */
(() => {
  "use strict";

  const DONE_KEY = "lct-tour-v1";
  /* Set by the install listener. Its only job is to relax the wait below: a
     fresh install is usually opened on a NEW chat, where the map hides itself
     because there is nothing yet to map, and waiting for it meant the tour a
     new user was promised never appeared. */
  const ARM_KEY = "lct-tour-armed-v1";
  const store = self.LCTStore;

  let root = null, card = null, ring = null, pane = null, foot = null;
  let steps = [], at = 0, tick = null, onDone = null;
  /* Which step's demo is currently running. A card that opens a panel has to
     put it back before the next card points somewhere else, and finishing the
     tour has to put it back too. */
  let demoing = null;

  /* ---------- geometry ----------
     visualViewport, not innerWidth: a pinch-zoomed or address-bar-shrunk page
     moves the visible box out from under a position:fixed element, and every
     card here has to stay inside what the reader can actually see. */

  const M = 12;                                  // margin from every edge

  function view() {
    const v = window.visualViewport;
    return v ? { x: v.offsetLeft, y: v.offsetTop, w: v.width, h: v.height }
             : { x: 0, y: 0, w: innerWidth, h: innerHeight };
  }

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

  /* ---------- hover labels ---------- */

  let tip = null, tipTimer = null;

  function hideTip() {
    clearTimeout(tipTimer);
    if (tip) tip.classList.remove("lct-tip-show");
  }

  function showTip(btn) {
    const raw = btn.getAttribute("data-tip");
    if (!raw) return;
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "lct-tip";
      tip.setAttribute("role", "tooltip");
      document.documentElement.appendChild(tip);
    }
    const [head, sub] = raw.split("|");
    tip.replaceChildren();
    const b = document.createElement("b");
    b.textContent = head;
    tip.appendChild(b);
    if (sub) {
      const s = document.createElement("span");
      s.textContent = sub;
      tip.appendChild(s);
    }
    // Measured after the text lands: the label sits left of the strip, and its
    // width depends on the line it is carrying.
    tip.style.visibility = "hidden";
    tip.classList.add("lct-tip-show");
    const r = btn.getBoundingClientRect();
    const v = view();
    tip.style.maxWidth = Math.max(140, v.w - 20) + "px";
    const w = tip.offsetWidth, h = tip.offsetHeight;
    // Left of the control normally; right of it when the window is too narrow
    // to hold a label on that side at all.
    const left = r.left - w - 10 >= v.x + 8 ? r.left - w - 10 : Math.min(r.right + 10, v.x + v.w - w - 8);
    tip.style.left = clamp(left, v.x + 8, Math.max(v.x + 8, v.x + v.w - w - 8)) + "px";
    tip.style.top = clamp(r.top + r.height / 2 - h / 2, v.y + 8, Math.max(v.y + 8, v.y + v.h - h - 8)) + "px";
    tip.style.visibility = "";
  }

  /** Instant, styled labels for anything carrying data-tip inside `host`. */
  function attachTips(host) {
    if (!host || host.dataset.lctTipped) return;
    host.dataset.lctTipped = "1";
    host.addEventListener("pointerenter", (e) => {
      const btn = e.target.closest && e.target.closest("[data-tip]");
      if (!btn) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(btn), 60);
    }, true);
    host.addEventListener("pointerleave", hideTip, true);
    host.addEventListener("click", hideTip, true);
  }
  // Once, not per host: the bar and the strip both call attachTips.
  window.addEventListener("scroll", hideTip, { passive: true, capture: true });

  /* ---------- what the tour says ---------- */

  const TOOL_LABEL = {
    outline: ["Outline & stars", "Every topic in the chat, and anything you starred"],
    search: ["Search this chat", "Reaches messages the page has already unloaded"],
    bridge: ["Context Bridge", "Pull a past answer from any AI into the prompt you're typing"],
    carry: ["Continue in a new chat", "Starts a fresh one carrying this one's context"],
    history: ["Mount older messages", "Puts them back in the page so the site's own Ctrl+F finds them"],
    md: ["Back up as Markdown", "The whole conversation, readable"],
    json: ["Back up as JSON", "The whole conversation, re-importable"]
  };

  const el = (id) => document.getElementById(id);
  /* A control on the strip's toolbar. Some are absent by design — `history` is
     removed on sites that mount their own older messages — so every caller
     falls back rather than pointing at nothing. */
  const tool = (act) => document.querySelector('#lct-export-bar [data-act="' + act + '"]');

  /* ---------- the pin illustration ----------
     Drawn, not described: "the puzzle-piece menu" is a sentence nobody parses
     until they have seen the shape it means. Inline SVG so it costs no asset
     and inherits the theme's colours. */

  const NS = "http://www.w3.org/2000/svg";
  const sv = (name, attrs) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  const PUZZLE = "M6.5 1.5a2 2 0 0 1 4 0v.6h2.4a1 1 0 0 1 1 1v2.4h.6a2 2 0 1 1 0 4h-.6v2.4a1 1 0 0 1-1 1h-2.4v-.6a2 2 0 1 0-4 0v.6H3.6a1 1 0 0 1-1-1V9.9h.6a2 2 0 1 0 0-4h-.6V3.5a1 1 0 0 1 1-1h2.9v-1z";
  const PIN = "M5.6 1h4.8L9.3 2.1v3.6l2.6 2.6v1.4H8.6v4L8 15l-.6-1.3v-4H4.1V8.3l2.6-2.6V2.1L5.6 1z";
  const STAR = "M8 1.2l1.9 4.4 4.7.4-3.6 3.1 1.1 4.6L8 11.2l-4.1 2.5 1.1-4.6L1.4 6l4.7-.4z";
  const SPARK = "M11 1l1.7 4.6L17 7.3l-4.3 1.7L11 13.6 9.3 9 5 7.3l4.3-1.7z";
  const SPARK2 = "M4 12.4l.9 2.3 2.3.9-2.3.9L4 18.8l-.9-2.3-2.3-.9 2.3-.9z";

  function sparkle() {
    const svg = sv("svg", { viewBox: "0 0 18 20", class: "lct-tour-spark", "aria-hidden": "true", focusable: "false" });
    svg.appendChild(sv("path", { d: SPARK }));
    svg.appendChild(sv("path", { d: SPARK2, opacity: ".65" }));
    return svg;
  }

  /* One row of a browser toolbar with the pin lit and an arrow drawn at it.
     The reader matches the picture to the chrome above their own tab; a
     sentence naming "the puzzle-piece menu" only works after that. */
  function pinArt() {
    const box = document.createElement("div");
    box.className = "lct-tour-art";
    const svg = sv("svg", { viewBox: "0 0 268 100", "aria-hidden": "true", focusable: "false" });

    svg.appendChild(sv("rect", { x: 20, y: 12, width: 158, height: 26, rx: 13, class: "lct-art-face" }));
    const star = sv("g", { transform: "translate(32,17)", class: "lct-art-dim" });
    star.appendChild(sv("path", { d: STAR }));
    svg.appendChild(star);
    svg.appendChild(sv("rect", { x: 54, y: 22, width: 108, height: 6, rx: 3, class: "lct-art-dim" }));

    const puz = sv("g", { transform: "translate(192,17)", class: "lct-art-dim" });
    puz.appendChild(sv("path", { d: PUZZLE }));
    svg.appendChild(puz);

    svg.appendChild(sv("circle", { cx: 238, cy: 25, r: 16, class: "lct-art-halo lct-pin-pulse" }));
    const pin = sv("g", { transform: "translate(230,17)", class: "lct-art-ink" });
    pin.appendChild(sv("path", { d: PIN }));
    svg.appendChild(pin);

    // hand-drawn, from under the strip up to the pin
    svg.appendChild(sv("path", { d: "M150 90c36 10 70 0 82-18 5-8 7-17 6-26", class: "lct-art-lead" }));
    svg.appendChild(sv("path", { d: "M238 44l-6 12h12z", class: "lct-art-head" }));

    box.appendChild(svg);
    return box;
  }

  /* Built from the real toolbar rather than a copy of it, so a button the
     adapter removed — `history`, on sites that mount everything — never gets
     explained here. */
  function toolLegend() {
    const bar = el("lct-export-bar");
    const list = document.createElement("div");
    list.className = "lct-tour-legend";
    if (!bar) return list;
    for (const btn of bar.querySelectorAll("button")) {
      const key = btn.dataset.act || btn.dataset.fmt;
      const text = TOOL_LABEL[key];
      if (!text) continue;
      const row = document.createElement("div");
      row.className = "lct-tour-leg";
      const icon = document.createElement("span");
      icon.className = "lct-tour-leg-icon";
      const svg = btn.querySelector("svg");
      if (svg) icon.appendChild(svg.cloneNode(true));
      const words = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = text[0];
      const sp = document.createElement("span");
      sp.textContent = text[1];
      words.append(b, sp);
      row.append(icon, words);
      list.appendChild(row);
    }
    return list;
  }

  function keyRows(commands) {
    const mac = (() => {
      const d = (typeof navigator !== "undefined" && navigator.userAgentData) || null;
      if (d && typeof d.platform === "string") return /mac/i.test(d.platform);
      return /Mac|iPhone|iPad/i.test((typeof navigator !== "undefined" && navigator.userAgent) || "");
    })();
    const pretty = (s) => !s ? null : s
      .replace(/MacCtrl/g, mac ? "⌃" : "Ctrl")
      .replace(/Command/g, "⌘")
      .replace(/Ctrl/g, mac ? "⌃" : "Ctrl")
      .replace(/Shift/g, mac ? "⇧" : "Shift")
      .replace(/Alt/g, mac ? "⌥" : "Alt")
      .replace(/\+/g, mac ? "" : "+");
    const by = new Map((commands || []).map((c) => [c.name, pretty(c.shortcut)]));
    const wanted = [
      ["in-chat-search", "Search this conversation"],
      ["open-recall", "Search every chat, every platform"],
      ["open-bridge", "Context Bridge"]
    ];
    const box = document.createElement("div");
    box.className = "lct-tour-keys";
    let any = 0;
    for (const [cmd, what] of wanted) {
      const k = by.get(cmd);
      if (!k) continue;                     // an unbound key is not worth teaching
      any++;
      const row = document.createElement("div");
      row.className = "lct-tour-key";
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      const span = document.createElement("span");
      span.textContent = what;
      row.append(kbd, span);
      box.appendChild(row);
    }
    if (!any) {
      const p = document.createElement("p");
      p.className = "lct-tour-note";
      p.textContent = "Your browser gave these shortcuts to another extension — every one of them is also a button on the strip.";
      box.appendChild(p);
    }
    return box;
  }

  function plan(commands, pinned) {
    const countPill = el("lct-mm-count");
    const list = [];
    // Skipped outright once the icon is already on the toolbar — asking for
    // something that is already done is the fastest way to lose a reader.
    if (!pinned) list.push({
      id: "pin",
      place: "toolbar",
      hero: true,
      skipText: "Maybe later",
      anchor: () => null,
      title: "Pin Tvara",
      body: "Keep Tvara on your toolbar for quicker access — the icon is where your settings, your archive and your plan live.",
      extra: pinArt,
      foot: "Not there yet? Open the puzzle-piece menu at the top right and press the pin beside Tvara."
    });
    list.push(
      {
        id: "strip",
        /* Fallbacks, not one id: a card that cannot find its control falls to
           the middle of the screen and points at nothing, which is worse than
           pointing at the next thing along the same edge. */
        anchor: () => el("lct-minimap") || el("lct-export-bar"),
        title: "Everything lives on this one bar",
        body: "Tvara adds a slim bar down the right-hand edge of the page, and nothing else. Move your mouse onto it and it opens; move away and it shrinks back to a line. Your chat is not changed in any way.",
        foot: "This takes about a minute. You can stop at any point and pick it up later."
      },
      {
        id: "map",
        anchor: () => el("lct-mm-stage") || el("lct-mm-canvas") || el("lct-minimap"),
        title: "A map of the whole conversation",
        body: "Each little line is one message — yours and the AI's in different shades. Point at one to read it without moving, or click to jump straight there, even if it was hundreds of messages ago."
      },
      {
        id: "preview",
        anchor: () => el("lct-mm-stage") || el("lct-minimap"),
        title: "Even the old messages the page forgot",
        body: "Chat sites quietly drop older messages to stay fast, which is why scrolling back is so slow. Tvara keeps its own copy, so clicking one opens it instantly while the site catches up in the background.",
        foot: "A small bar at the bottom shows how far along that is, and you can stop it whenever you like."
      }
    );
    // Only shown when the engine actually has messages asleep — otherwise this
    // step points at an empty box and explains a number that is not there.
    if (countPill && countPill.style.display !== "none" && countPill.textContent) {
      list.push({
        id: "count",
        anchor: () => el("lct-mm-count") || el("lct-minimap"),
        title: "This is why the page feels quick",
        body: "That number is how many messages are resting. Nothing is deleted — they wake up the moment you scroll back to them. It is the same trick your eyes use: stop paying attention to what you are not looking at."
      });
    }
    list.push({
      id: "tools",
      anchor: () => el("lct-export-bar") || el("lct-minimap"),
      title: "The tools, top to bottom",
      body: "Each of these is one click, and each has a label when you hover it.",
      extra: toolLegend
    });
    list.push(
      {
        id: "stars",
        anchor: () => el("lct-minimap"),
        title: "Star the bits worth keeping",
        body: "Point at any message and a small star appears in its corner. Click it, and that message gets a gold edge and stays one click away — the answer that finally worked, in a chat with five hundred of them.",
        foot: "Your stars are remembered, and follow you to your other signed-in browsers."
      },
      {
        id: "outline",
        /* Opened for the reader rather than described to them. Nobody reads
           "it builds a table of contents" and pictures their own chat. */
        show: () => { if (self.LCTOutline && !self.LCTOutline.isOpen) self.LCTOutline.open(); },
        hide: () => { if (self.LCTOutline && self.LCTOutline.isOpen) self.LCTOutline.close(); },
        anchor: () => el("lct-outline") || tool("outline") || el("lct-export-bar"),
        title: "Here is your chat as a contents page",
        body: "This just opened for you. It is a list of everything you asked and every heading the AI wrote back — click any line to go straight to it. The Starred tab shows only what you marked.",
        foot: "Closing again when you press Next. The button that opened it is the one being pointed at."
      },
      {
        id: "search",
        show: () => { if (self.LCTSearch && !self.LCTSearch.isOpen) self.LCTSearch.open(); },
        hide: () => { if (self.LCTSearch && self.LCTSearch.isOpen) self.LCTSearch.close(); },
        anchor: () => el("lct-search") || tool("search") || el("lct-export-bar"),
        title: "And this is how you find a word in it",
        body: "This box just opened too. Type and it counts the matches as you go, jumping between them with Enter — including through the older messages the page itself has dropped, which its own search cannot reach."
      }
    );
    // Pro tools are absent from the bar on a free install, and a card pointing
    // at a control that is not there teaches nothing.
    if (tool("bridge")) list.push({
      id: "bridge",
      anchor: () => tool("bridge"),
      title: "Bring an answer over from another AI",
      body: "You worked something out with ChatGPT, and now Claude knows nothing about it. Press this while you are writing: Tvara finds the relevant bits of your old chats, shows them to you, and drops the ones you tick into what you are typing.",
      foot: "You always choose first — nothing is added behind your back, and nothing is sent anywhere."
    });
    if (tool("carry")) list.push({
      id: "carry",
      anchor: () => tool("carry"),
      title: "When a chat gets too long to carry on",
      body: "Opens a fresh conversation with the context already in the prompt box: what you originally asked, what you starred, and the turns where something was actually decided — not just the tail of the thread, which is usually \"yes, that worked\".",
      foot: "Quoted, never summarised, and never sent for you. You read it and press send."
    });
    if (tool("history")) list.push({
      id: "history",
      anchor: () => tool("history"),
      title: "Put every old message back on the page",
      body: "Some things need the messages really there — the site's own find-on-page, or saving the whole conversation. This walks back and loads them, tells you how far it has got, and stops the second you touch the page.",
      foot: "It is the only thing here that ever scrolls for you, and only when you ask it to."
    });
    list.push({
      id: "backup",
      anchor: () => document.querySelector('#lct-export-bar [data-fmt]') || el("lct-export-bar"),
      title: "Take the conversation with you",
      body: "Markdown keeps the headings, lists, code fences and times and drops into Obsidian or Notion. JSON is one record per message for your own scripts.",
      foot: "Exporting never needs a licence. Your own chats are never held behind a plan."
    });
    list.push({
      id: "recall",
      anchor: () => null,
      title: "\"I solved this before — but where?\"",
      body: "Total Recall searches every chat you have had, across all of these sites, from one box. Click a result and it opens that conversation with your words already highlighted.",
      foot: "The searching happens on your own computer. Your conversations are not kept anywhere else."
    });
    list.push({
      id: "times",
      anchor: () => null,
      title: "When was this actually said?",
      body: "Chat sites never tell you. Point at a message and Tvara does. On ChatGPT that is the real time it was sent; elsewhere the browser was simply never told, so it says when Tvara first saw it rather than inventing something.",
      foot: "You can switch times off from the Tvara icon if you would rather not see them."
    });
    list.push({
      id: "card",
      anchor: () => null,
      title: "Know a chat before you open it",
      body: "Hover a conversation in the site's own sidebar and a card shows its size, how many questions you asked, what you starred, and when you last opened it.",
      foot: "Only chats you have opened at least once. Anything else says not tracked yet rather than inventing a number."
    });
    list.push({
      id: "resume",
      anchor: () => null,
      title: "It remembers where you stopped reading",
      body: "Reopen a long chat and a chip offers to take you back to the exact message you were on — anchored to the message, so it survives reloads. Scroll away on purpose and the chip leaves."
    });
    list.push({
      id: "allowance",
      anchor: () => null,
      title: "Told before the wall, not after it",
      body: "These apps warn you about your limit by cutting you off. This reads the figure their own responses already carry and warns at 20%, then at 10%, on whichever model is running down.",
      foot: "It never alters, blocks or delays a request, and a provider that publishes no figure is reported as such rather than estimated."
    });
    list.push({
      id: "archive",
      anchor: () => null,
      title: "Your archive, and what guards it",
      body: "Chats are archived to this machine so Recall has something to search. If one is deleted at the provider, you are told and you decide — a deletion there is never a deletion here.",
      foot: "Encrypted backups are written with a passphrase you choose and that nobody can recover for you."
    });
    list.push({
      id: "temp",
      anchor: () => null,
      title: "Temporary chats stay out unless you say otherwise",
      body: "A temporary or incognito chat is you telling that platform not to keep it, so Tvara does not keep it either. Switch it on and those chats are archived here too — labelled as temporary, with a badge on the page the whole time one is being archived.",
      foot: "Never a silent recording, and they cannot be reopened on the platform: the original was never saved there."
    });
    list.push({
      id: "plan",
      anchor: () => null,
      title: "What is free, and what is not",
      body: "Everything you have just seen in the page is free and stays free. The archive search, the bridge and carrying a chat forward are Pro — a 7-day trial with no card, then a one-time purchase that covers five devices and every future update.",
      foot: "If a licence ever ends, your archive stays on this machine and stays exportable. Your own conversations are never held behind a plan."
    });
    list.push({
      id: "settings",
      anchor: () => null,
      title: "Your extension window has the defaults",
      body: "Open the Tvara icon in your browser toolbar to switch the speed engine, minimap, timestamps, full-history loading, temporary-chat archiving and allowance tracking on or off.",
      foot: "It also holds Total Recall, your archive, your plan, the adapter health report, and this walkthrough whenever you want it again."
    });
    list.push({
      id: "keys",
      // The only step with no control to point at: it is about the keyboard.
      anchor: () => null,
      title: "And from the keyboard",
      body: "Everything above also works without going near the strip.",
      extra: () => keyRows(commands),
      foot: "The Tvara icon in your browser's toolbar holds the settings, your archive and your plan."
    });
    list.push({
      id: "done",
      anchor: () => null,
      title: "That is the whole thing",
      body: "Nothing here needs setting up. Keep chatting and the map, the times and your archive fill in behind you.",
      foot: "Everything you have just seen is behind the Tvara icon in your toolbar — including this walkthrough, under Show me around, whenever you want it again.",
      skipText: ""
    });
    return list;
  }

  /* ---------- drawing ---------- */

  function build() {
    root = document.createElement("div");
    root.id = "lct-tour";

    ring = document.createElement("div");
    ring.id = "lct-tour-ring";

    card = document.createElement("div");
    card.id = "lct-tour-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    card.setAttribute("aria-label", "Tvara tour");
    // The beak hangs outside the card's box, so a short viewport scrolls an
    // inner pane instead — overflow on the card itself would clip it. The
    // buttons stay out of that pane: on a 360px-tall window they were the part
    // that scrolled away, leaving a card with no visible way to dismiss it.
    pane = document.createElement("div");
    pane.className = "lct-tour-pane";
    foot = document.createElement("div");
    foot.className = "lct-tour-foot";
    card.append(pane, foot);

    root.append(ring, card);
    document.documentElement.appendChild(root);
  }

  const place = (l, t) => { card.style.left = l + "px"; card.style.top = t + "px"; };

  const beak = (which) => {
    card.classList.toggle("lct-tour-flip", which === "left");
    card.classList.toggle("lct-tour-up", which === "up");
    card.classList.toggle("lct-tour-none", !which);
  };

  /* Docked across the short edge, for a window too narrow to hold a card
     beside anything. Sits opposite the ring so it never covers it. */
  function sheet(v, side) {
    card.classList.add("lct-tour-sheet");
    beak(null);
    card.style.width = Math.max(180, v.w - M * 2) + "px";
    const h = card.offsetHeight;
    place(v.x + M, side === "bottom" ? v.y + v.h - h - M : v.y + M);
  }

  function position() {
    if (!card) return;
    const step = steps[at];
    const v = view();
    // Measured against the visible box every time: a rotation, a split window
    // and a pinch zoom all land here, and none of them fire the same event.
    card.style.maxWidth = Math.max(180, v.w - M * 2) + "px";
    card.style.maxHeight = Math.max(140, v.h - M * 2) + "px";
    card.style.width = "";
    card.classList.remove("lct-tour-sheet");
    const w = card.offsetWidth;

    const target = step && step.anchor && step.anchor();
    const r = target && target.isConnected ? target.getBoundingClientRect() : null;

    // A step whose control has gone — the strip hides itself in a short chat —
    // still gets said, without a ring pointing at nothing.
    if (!r || !r.width || !r.height) {
      ring.style.display = "none";
      if (step && step.place === "toolbar") {
        // Under the browser's own toolbar, which is off-page: the card points
        // up at it rather than ringing something it cannot reach. Held clear of
        // the strip, which lives in exactly the same corner.
        beak("up");
        const mm = el("lct-minimap");
        const mr = mm && mm.isConnected ? mm.getBoundingClientRect() : null;
        const gapRight = mr && mr.width ? Math.max(M, v.x + v.w - mr.left + 8) : M;
        place(clamp(v.x + v.w - w - gapRight, v.x + M, v.x + Math.max(M, v.w - w - M)), v.y + M);
      } else {
        beak(null);
        const h = card.offsetHeight;
        place(v.x + Math.max(M, (v.w - w) / 2), v.y + Math.max(M, (v.h - h) / 2));
      }
      return;
    }

    ring.style.display = "";
    const pad = 6;
    // Armed after the first placement, so the ring does not slide in from the
    // top-left corner of the screen on the way to its first anchor.
    requestAnimationFrame(() => ring && ring.classList.add("lct-tour-armed"));
    ring.style.left = (r.left - pad) + "px";
    ring.style.top = (r.top - pad) + "px";
    ring.style.width = (r.width + pad * 2) + "px";
    ring.style.height = (r.height + pad * 2) + "px";

    const gap = 18;
    let left = null, side = null;
    if (r.left - w - gap >= v.x + M) { left = r.left - w - gap; side = "left"; }
    else if (r.right + gap + w <= v.x + v.w - M) { left = r.right + gap; side = "right"; }
    if (left === null) return sheet(v, r.top + r.height / 2 < v.y + v.h / 2 ? "bottom" : "top");

    const h = card.offsetHeight;
    const top = clamp(r.top + r.height / 2 - h / 2, v.y + M, Math.max(v.y + M, v.y + v.h - h - M));
    place(left, top);
    beak(side === "right" ? "left" : "right");
    card.style.setProperty("--lct-arrow-y",
      clamp(r.top + r.height / 2 - top, 18, Math.max(18, h - 18)) + "px");
  }

  /* Run this card's demonstration and undo the previous one. Both are wrapped:
     a panel that refuses to open is a card that reads a little thin, never a
     tour that stops halfway through with an error nobody can dismiss. */
  function runDemo(step) {
    if (demoing === step) return;
    try { if (demoing && demoing.hide) demoing.hide(); } catch { /* already gone */ }
    demoing = null;
    if (!step || !step.show) return;
    try { step.show(); demoing = step; } catch { /* the panel declined */ }
  }

  function render() {
    const step = steps[at];
    runDemo(step);
    card.dataset.step = step.id || String(at + 1);
    pane.replaceChildren();
    foot.replaceChildren();

    card.classList.toggle("lct-tour-hero", !!step.hero);
    if (step.hero) pane.appendChild(sparkle());

    const meta = document.createElement("div");
    meta.className = "lct-tour-meta";
    meta.textContent = `${at + 1} of ${steps.length}`;
    const title = document.createElement("div");
    title.className = "lct-tour-title";
    title.textContent = step.title;
    const body = document.createElement("p");
    body.className = "lct-tour-body";
    body.textContent = step.body;
    pane.append(meta, title, body);
    if (step.extra) pane.appendChild(step.extra());
    if (step.foot) {
      const f = document.createElement("p");
      f.className = "lct-tour-note";
      f.textContent = step.foot;
      pane.appendChild(f);
    }

    const actions = document.createElement("div");
    actions.className = "lct-tour-actions";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "lct-tour-skip";
    skip.textContent = at === steps.length - 1 ? "" : (step.skipText || "Skip");
    const spacer = document.createElement("span");
    spacer.className = "lct-tour-spacer";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "lct-tour-back";
    back.textContent = "Back";
    back.hidden = at === 0;
    const next = document.createElement("button");
    next.type = "button";
    next.className = "lct-tour-next";
    // One word, the same on every card: the counter above already says whether
    // there is more, and "Okay" is the only button nobody has to interpret.
    next.textContent = "Okay";
    actions.append(skip, spacer, back, next);
    foot.appendChild(actions);

    skip.addEventListener("click", finish);
    back.addEventListener("click", () => { at--; render(); });
    next.addEventListener("click", () => {
      if (at === steps.length - 1) return finish();
      at++; render();
    });

    position();
    requestAnimationFrame(position);   // fonts and the legend settle a frame late
    // Never out of the composer: someone mid-sentence when the tour opens
    // should keep their cursor. Keyboard users who are not typing get it.
    const on = document.activeElement;
    const typing = on && (on.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(on.tagName || ""));
    if (!typing) next.focus({ preventScroll: true });
  }

  function finish() {
    runDemo(null);
    clearInterval(tick);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", position);
    window.removeEventListener("orientationchange", position);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", position);
      window.visualViewport.removeEventListener("scroll", position);
    }
    if (root) root.remove();
    root = card = ring = pane = foot = null;
    if (self.LCTMinimap && self.LCTMinimap.hold) self.LCTMinimap.hold(false);
    if (onDone) { const f = onDone; onDone = null; f(); }
  }

  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); finish(); }
  }

  /** Runs the tour now. Safe to call twice — the second call is a no-op. */
  function start(commands, toolbar) {
    if (root) return;
    steps = plan(commands, !!(toolbar && toolbar.pinned));
    at = 0;
    build();
    // Pinned open for the duration: "hover the strip" means nothing while the
    // strip is a hairline the reader has not noticed yet.
    if (self.LCTMinimap && self.LCTMinimap.hold) self.LCTMinimap.hold(true);
    render();
    document.addEventListener("keydown", onKey, true);
    // The host reflows constantly (streaming answers, SPA route changes) and
    // the anchors move with it.
    tick = setInterval(position, 250);
    window.addEventListener("resize", position, { passive: true });
    window.addEventListener("orientationchange", position, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", position, { passive: true });
      window.visualViewport.addEventListener("scroll", position, { passive: true });
    }
  }

  const ask = (type) => new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type }, (r) => { void chrome.runtime.lastError; res(r); });
    } catch { res(null); }
  });
  // chrome.commands and chrome.action are both worker-only.
  const askWorker = () => Promise.all([ask("commands"), ask("toolbar-pinned")]);

  // One wait at a time: a chat switch re-arms this, and stacked waitForStrip
  // loops would race to spend the flag.
  let arming = false;

  /** First conversation only. Waits for the strip to exist before speaking. */
  async function maybeStart() {
    if (arming || root) return;
    arming = true;
    try { await armTour(); } finally { arming = false; }
  }

  async function armTour() {
    const got = await store.get([DONE_KEY, ARM_KEY]);
    // An orphaned content script reads {} from a dead context, which looks
    // exactly like a first run.
    if (!store.alive || (got && got[DONE_KEY])) return;
    const justInstalled = !!(got && got[ARM_KEY]);
    // The flag is spent only once there is something to point at. Claiming it
    // up front burns the one tour someone gets on a two-message conversation,
    // where the strip hides itself and every anchor is missing.
    const strip = await waitForStrip(justInstalled);
    if (!strip) return;
    const again = await store.get([DONE_KEY]);
    if (!store.alive || (again && again[DONE_KEY])) return;   // another tab got there
    // Written before anything is drawn, so two tabs finishing the wait together
    // cannot both decide they are the first.
    await store.set({ [DONE_KEY]: Date.now() });
    // Cleared the way every other flag here is: LCTStore has no remove().
    if (justInstalled) await store.set({ [ARM_KEY]: null });
    if (!store.alive) return;
    start(...await askWorker());
  }

  function waitForStrip(loose) {
    return new Promise((res) => {
      let waited = 0;
      const look = () => {
        const mm = el("lct-minimap");
        const bar = el("lct-export-bar");
        // display:none is the minimap's own "this chat is too short to map".
        // Right after an install the bar alone is enough: every card that wants
        // the map already falls back to the bar, and a first-run tour that
        // waits for a long conversation is a tour nobody is shown.
        if (loose && bar) return res(bar);
        if (mm && mm.style.display !== "none" && bar) return res(mm);
        if ((waited += 400) > 20000) return res(null);
        setTimeout(look, 400);
      };
      look();
    });
  }

  /** Re-run on demand, from the popup. */
  async function replay() {
    if (root) return;
    const strip = await waitForStrip();
    if (!strip) return;
    start(...await askWorker());
  }

  self.LCTTour = { maybeStart, replay, attachTips, get open() { return !!root; } };
})();
