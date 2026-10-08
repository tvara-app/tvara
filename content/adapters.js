/**
 * Tvara — platform adapters.
 * Each adapter knows how to find message elements on one AI chat platform.
 * Defensive by design: multiple selector candidates, graceful null returns.
 * If nothing matches, the toolkit does NOTHING (never break the host page).
 */
(() => {
  "use strict";

  // Only for lists that can repeat/hold nulls: .closest()/.parentElement maps,
  // concatenations. Raw querySelectorAll is already unique + document order —
  // passing one here allocated the message list 4× on the hottest path.
  const dedupe = (els) => Array.from(new Set(els.filter(Boolean)));

  /**
   * Recursively search through open shadow roots for matching elements.
   *
   * Finding shadow hosts means visiting every element — there is no selector
   * for "has a shadow root" — so this is budgeted. It is a deep fallback that
   * reruns at rescan frequency, and an unbounded document-wide walk on a host
   * that has drifted would cost more than the drift.
   */
  const SHADOW_BUDGET = 20000;

  function queryShadowAll(root, selector) {
    const results = [];
    let budget = SHADOW_BUDGET;
    const scan = (node) => {
      try { results.push(...node.querySelectorAll(selector)); } catch {}
      const all = node.querySelectorAll("*");
      for (const el of all) {
        if (--budget < 0) return;
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    scan(root);
    return dedupe(results);
  }

  /* ---------- provider-assigned message ids ----------
     The backfill walker and the minimap's seek both have to say "this is the
     same message as before" across a remount, and a provider id is the only
     key that survives one. A text-derived key moves while an answer streams —
     and a walker whose "did the host hand us a page?" test reads a moving key
     never stops asking for pages.

     Two id shapes cover every host that assigns one: ChatGPT's
     data-message-id, and Gemini's r_<hex> response ids. A host with neither
     returns "" and the callers fall back deliberately, rather than being handed
     a key that only looks stable. Same probe timeline.js keyOf() runs; the two
     are meant to stay in step. */
  const R_ID = /^r_[0-9a-f]+$/i;

  // Two subtree queries per miss, spent on every mounted message each page the
  // walker pulls. An id cannot change, so cache a hit for good. A MISS is not
  // cached — a message mounting before its id lands would stay keyless.
  const keyMemo = new WeakMap();

  function stableKey(el) {
    if (!el || !el.getAttribute) return "";
    const hit = keyMemo.get(el);
    if (hit !== undefined) return hit;

    const withId = (el.hasAttribute("data-message-id") || el.hasAttribute("data-lct-mid"))
      ? el
      : (el.querySelector && el.querySelector("[data-message-id], [data-lct-mid]"));
    let key = "";
    if (withId) key = withId.getAttribute("data-message-id") || withId.getAttribute("data-lct-mid") || "";
    else if (el.id && R_ID.test(el.id)) key = el.id;
    else {
      const rid = el.querySelector && el.querySelector('[id^="r_"], [id^="R_"]');
      if (rid && R_ID.test(rid.id)) key = rid.id;
    }
    if (key) keyMemo.set(el, key);
    return key;
  }

  const TEXTY = 20;   // chars that make a child look like a message, not chrome

  const textyChildren = (el) => {
    const out = [];
    for (const c of el.children) {
      const text = (c.textContent || "").trim();
      if (text.length > TEXTY) { out.push(c); continue; }
      /* A turn that is a picture carries no text at all, and counting text
         alone dropped it — one tick short, which is worse than no map because
         it looks right. substantive() owns what counts as content. */
      if (!text && substantive(c)) out.push(c);
    }
    return out;
  };

  /* Tags a conversation never uses for its ROWS. They are what ONE message is
     made of — a paragraph, a heading, a code block, a table — so a container
     whose texty children are mostly these is one answer's body, not the thread.
     On a short chat that body is the densest container on the page, which is
     how two messages came back as eight ticks, "parts of a long response".
     Structure only: nothing about the text says what a node is. */
  const PROSE_TAG = /^(P|H[1-6]|UL|OL|DL|PRE|CODE|BLOCKQUOTE|TABLE|FIGURE|FIGCAPTION|HR|BR|SPAN|EM|STRONG|B|I|A|IMG|SVG)$/;
  const mostlyProse = (els) => {
    if (!els.length) return false;
    let prose = 0;
    for (const el of els) if (PROSE_TAG.test(el.tagName)) prose++;
    return prose * 2 > els.length;
  };
  /* …and the other half of the same question, for a body whose parts are all
     <div>: a message list's SIBLINGS are chrome — a header, a composer. Sitting
     next to a paragraph is what being inside an answer looks like. */
  const insideProse = (el) => {
    const parent = el && el.parentElement;
    if (!parent) return false;
    for (const sib of parent.children) {
      if (sib !== el && PROSE_TAG.test(sib.tagName) && (sib.textContent || "").trim().length > TEXTY) return true;
    }
    return false;
  };

  /**
   * Shared fallback for platforms with build-hashed class names (DeepSeek,
   * Grok, Perplexity): the message list is the element with the most
   * text-bearing children. 6+ children, each over TEXTY chars, so nav and
   * sidebar lists don't win while short conversations still do.
   *
   * Scoped to <main> where there is one, and the text test is spent only on
   * the shortlist. This is a rescan-frequency path on the experimental hosts,
   * and serializing every candidate's subtree to rank it made a selector miss
   * cost more than the lag the engine removes.
   */
  const SHORTLIST = 8;

  /**
   * The last-resort structural layer, but ONLY where a conversation can exist.
   *
   * Found live on chatgpt.com/: with no conversation open, layers 1 to 4
   * correctly matched nothing, so this ran on the landing page and returned 39
   * ordinary <p> elements as "messages" — roles guessed 36 user to 3 assistant
   * from prose that was neither. Every adapter already declares the path shape
   * a conversation lives at; the precise layers above are safe anywhere, and
   * this one is not, so this one is the only one that has to ask.
   *
   * Called with `this`, which is always the adapter: every call site in the
   * codebase is `<adapter>.messages()`.
   */
  function heuristicInConversation(adapter, scope, minKids) {
    const p = adapter && adapter.convPath;
    if (!p || p.test(location.pathname)) return heuristicMessages(scope, minKids);
    /* The path does not match the shape we know conversations take. That is
       either a landing page (where this layer invented 39 paragraphs as
       messages) or a provider that has changed its URLs — and refusing outright
       would turn "degraded but working" into "nothing" the day that happens.
       Depth tells them apart: a conversation is /c/<id>, /chat/<id>,
       /search/<id>, always two segments or more; a landing page is "/" or
       "/recents". So an unknown deep path still gets the fallback, and a
       shallow one never does. */
    const depth = location.pathname.split("/").filter(Boolean).length;
    return depth >= 2 ? heuristicMessages(scope, minKids) : [];
  }

  /* A Claude Code transcript renders tool calls, tool results and thinking
     next to the turns. Those are not messages and must never become ticks.
     Structure and ARIA only: text says nothing about what a node is. */
  /* Scaffolding, named precisely. "*=tool" also matched Toolbar and Tooltip,
     and one such ancestor anywhere above the transcript emptied the whole
     message list. Anchored prefixes only, and the element itself — a turn
     wrapper is never itself a tool block. */
  const CLAUDE_TOOL = [
    '[data-testid^="tool-"]', '[data-testid$="-tool"]',
    '[data-testid*="tool-use" i]', '[data-testid*="tool-result" i]',
    '[data-testid*="thinking" i]',
    '[aria-label^="Tool call" i]', '[aria-label^="Tool result" i]', '[aria-label^="Thinking" i]'
  ].join(",");
  const CLAUDE_BODY = '[data-testid="user-message"], .font-user-message, .font-claude-message, .font-claude-response';

  /* ChatGPT, since 2026-10: no data-message-id, no data-message-author-role,
     no conversation-turn article. Each message is a "search unit" whose key
     ends in its role — "<turn>:<n>:user" / "<turn>:<n>:assistant" — inside a
     [data-turn-key] holding the USER message's id; the answer's id sits on
     [data-chatgpt-selection-message-id] inside the unit. Verified against the
     conversation API on a real 237-message chat: turn-key = the user node,
     selection id = the assistant node, so archive ids and page ids agree.
     The id is copied onto data-lct-mid — an attribute that is ours, never the
     host's own data-message-id, which ChatGPT's code could still be reading. */
  const GPT_UNIT = "[data-content-search-unit-key]";
  function chatgptUnitRole(el) {
    const key = (el.getAttribute && el.getAttribute("data-content-search-unit-key")) || "";
    const m = /:(user|assistant)$/.exec(key);
    return m ? m[1] : "";
  }
  function chatgptUnitId(el) {
    if (chatgptUnitRole(el) === "user") {
      const turn = el.closest("[data-turn-key]");
      return (turn && turn.getAttribute("data-turn-key")) || "";
    }
    const sel = el.querySelector("[data-chatgpt-selection-message-id]");
    if (sel) return sel.getAttribute("data-chatgpt-selection-message-id") || "";
    const ids = (el.getAttribute("data-chatgpt-search-message-ids") || "").trim().split(/\s+/);
    return ids[ids.length - 1] || "";
  }
  function chatgptUnits() {
    const els = [];
    for (const el of document.querySelectorAll(GPT_UNIT)) {
      if (el.closest("#lct-freeze, #lct-old-turns")) continue;
      if (!chatgptUnitRole(el)) continue;
      const id = chatgptUnitId(el);
      if (id && el.getAttribute("data-lct-mid") !== id) el.setAttribute("data-lct-mid", id);
      els.push(el);
    }
    return els;
  }

  /* One turn is one message. ChatGPT keys its DOM nodes by TRANSCRIPT message
     id, and one visible answer can hold several of them — a reasoning summary,
     a browsing block, the answer — each carrying data-message-id and each
     drawing its own tick, so a two-message chat mapped as four. The <article>
     is the turn; keep one node per turn, the one holding the most of it. */
  function chatgptTurns(els) {
    if (els.length < 2) return els;
    const stated = (el) => {
      const n = el.closest && el.closest("[data-message-author-role]");
      return (n && n.getAttribute("data-message-author-role")) || chatgptUnitRole(el);
    };
    const seen = new Map();               // turn element -> role -> the node kept
    const out = [];
    for (const el of els) {
      // An <article> until 2026-09; a <section> since, with the same testid.
      const turn = el.closest && el.closest('article[data-testid^="conversation-turn"], article[data-turn], section[data-testid^="conversation-turn"], section[data-turn], [data-turn-key]');
      if (!turn) { out.push(el); continue; }
      // Keyed by role as well as by turn: two speakers under one container are
      // two messages whatever the container is called, and a build that grouped
      // them would otherwise lose one of them here.
      let roles = seen.get(turn);
      if (!roles) { roles = new Map(); seen.set(turn, roles); }
      const role = stated(el);
      const prev = roles.get(role);
      if (!prev) { roles.set(role, el); out.push(el); continue; }
      if ((el.textContent || "").length > (prev.textContent || "").length) {
        out[out.indexOf(prev)] = el;
        roles.set(role, el);
      }
    }
    /* A build that wrapped the whole thread in one article would collapse the
       map to a single tick. Refuse the answer rather than report it. */
    return (els.length >= 4 && out.length < 2) ? els : out;
  }

  function claudeTurns(els) {
    return els.filter((el) => {
      if (!el || !el.matches) return true;
      if (!el.matches(CLAUDE_TOOL)) return true;
      // A turn that USED a tool still holds a message body; a bare block does not.
      return !!(el.querySelector && el.querySelector(CLAUDE_BODY));
    });
  }

  function heuristicMessages(scope, minKids) {
    const root = scope || document.querySelector("main") || document.body;
    const floor = minKids || 6;
    const shortlist = [];
    for (const el of root.querySelectorAll("div, section, ol, ul")) {
      const n = el.childElementCount;
      if (n < floor || n > 2000) continue;
      if (el.closest("nav, aside, header, footer")) continue;
      // keep the densest few by child count alone — no text read yet
      if (shortlist.length < SHORTLIST) shortlist.push(el);
      else {
        let worst = 0;
        for (let i = 1; i < shortlist.length; i++) {
          if (shortlist[i].childElementCount < shortlist[worst].childElementCount) worst = i;
        }
        if (n > shortlist[worst].childElementCount) shortlist[worst] = el;
      }
    }
    shortlist.sort((a, b) => b.childElementCount - a.childElementCount);
    for (const el of shortlist) {
      const kids = textyChildren(el);
      if (kids.length < 4) continue;
      // The densest container is the one answer with the most paragraphs at
      // least as often as it is the thread. Say no rather than say eight.
      if (mostlyProse(kids) || insideProse(el)) continue;
      return kids;
    }
    return [];
  }

  /* ---------- composer resolution (Context Bridge) ----------
     Finding the prompt input is inherently per-platform DOM, so this is
     defensive in three layers: explicit selector hints, then the focused
     editable, then the largest editable box in the lower viewport. If all
     three miss, the caller falls back to the clipboard — the Bridge never
     depends on a selector staying valid. */
  const isEditable = (el) =>
    !!el && (el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && /text|search/i.test(el.type || "text")) ||
      el.isContentEditable);
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 12 && getComputedStyle(el).visibility !== "hidden";
  };
  // never target the toolkit's OWN inputs (the Bridge/search boxes)
  const ours = (el) => !!(el && el.closest && el.closest('[id^="lct-"]'));
  const usable = (el) => isEditable(el) && !ours(el) && visible(el);
  // Prompt composers are ALWAYS a textarea or contenteditable — never a plain
  // <input>. The focus/generic fallbacks require that, so a stray focused
  // search box can't get hijacked with a context block. Explicit per-platform
  // hints may still match an <input> if some app ever needs it.
  const composerLike = (el) =>
    !!el && (el.tagName === "TEXTAREA" || el.isContentEditable) && !ours(el) && visible(el);

  function pickComposer(hints) {
    for (const sel of hints || []) {
      let el;
      try { el = document.querySelector(sel); } catch { el = null; }
      if (usable(el)) return el;
    }
    const a = document.activeElement;
    if (composerLike(a)) return a;
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')) {
      if (!composerLike(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < innerHeight * 0.3) continue; // composers sit low on the page
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return best;
  }

  /**
   * Find the nearest scrollable ancestor of an element.
   *
   * Memoized. The walk costs a getComputedStyle AND a scrollHeight read per
   * ancestor — style plus layout, a dozen levels deep — and the minimap and the
   * resume tracker each ask on every engine tick. Hosts really do rebuild their
   * scroller (chat switch, zoom), so the answer is held briefly rather than for
   * good, and a resize drops it outright.
   */
  const scrollerMemo = new WeakMap();   // el -> { at, gen, scroller }
  const SCROLLER_TTL = 1000;
  let scrollerGen = 0;
  addEventListener("resize", () => { scrollerGen++; }, { passive: true });

  function findScroller(el) {
    const memo = el && scrollerMemo.get(el);
    if (memo && memo.gen === scrollerGen && Date.now() - memo.at < SCROLLER_TTL &&
        memo.scroller.isConnected) {
      return memo.scroller;
    }

    let found = null;
    let node = el;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 100) {
        found = node;
        break;
      }
      node = node.parentElement;
    }
    if (!found) found = document.scrollingElement || document.documentElement;
    if (el) scrollerMemo.set(el, { at: Date.now(), gen: scrollerGen, scroller: found });
    return found;
  }

  const ADAPTERS = [
    {
      id: "chatgpt",
      roleStable: true,   // data-message-author-role, set at mount
      virtualizes: true,  // mounts only the recent tail — see history-loader.js
      convPath: /^\/c\//,
      label: "ChatGPT",
      // The layer-1 selector, quoted for the health check: matched messages that
      // do NOT satisfy it mean this platform has drifted and we are running on
      // a fallback layer — working, but on borrowed time.
      canon: "[data-message-id], [data-message-author-role], [data-content-search-unit-key$=':user'], [data-content-search-unit-key$=':assistant']",
      // Where a POSITIVE role marker exists for both sides, so the health
      // report can say whether roles were read or guessed.
      roleCanon: "[data-message-author-role], [data-content-search-unit-key$=':user'], [data-content-search-unit-key$=':assistant']",
      hostRe: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
      messages() {
        // Layer 0 (2026-10 onward): role-suffixed search units. See chatgptUnits().
        let els = chatgptUnits();
        if (els.length) return chatgptTurns(els);

        // Layer 1 (2025 – 2026-09): div elements with data-message-id and
        // data-message-author-role attributes.
        els = Array.from(document.querySelectorAll('[data-message-id]'));
        if (els.length) return chatgptTurns(els);

        // Layer 2: data-message-author-role without data-message-id
        // (in case the id attribute is dropped but role remains)
        // Not our own archive rows: they carry the role attribute too.
        els = Array.from(document.querySelectorAll('[data-message-author-role]')).filter((el) => !el.closest("#lct-old-turns"));
        if (els.length) return chatgptTurns(els);

        // Layer 3 (legacy): article-based conversation turns
        els = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
        if (els.length) return els;

        // Layer 4 (legacy variant): div-based conversation turns
        els = Array.from(document.querySelectorAll('div[data-testid^="conversation-turn"]'));
        if (els.length) return els;

        // Layer 5 (last resort): structural — densest child-list with text.
        // Shared with the other hosts rather than a second, costlier copy: the
        // copy that lived here serialized every div's children to rank them,
        // which on a redesign would have run over the whole document four
        // times a second. 4 children, not 6 — ChatGPT's threshold.
        return heuristicInConversation(this, null, 4);
      },
      role(el) {
        // Self, then ANCESTORS, then descendants. The middle step was missing:
        // when the matched node carried data-message-id but the author role sat
        // on a wrapper above it, every message fell through to the heuristics
        // below — and "short and no code block" reads as a user turn, so a real
        // conversation came back 188 mine to 12 the model's.
        const own = el.closest && el.closest("[data-message-author-role]");
        if (own) return own.getAttribute("data-message-author-role") === "user" ? "user" : "assistant";
        const r = el.querySelector("[data-message-author-role]");
        if (r) return r.getAttribute("data-message-author-role") === "user" ? "user" : "assistant";
        // 2026-10 DOM: the role is the suffix of the unit's key.
        const unit = el.closest && el.closest(GPT_UNIT);
        const ur = unit && chatgptUnitRole(unit);
        if (ur) return ur;
        // data-testid may encode the role (legacy)
        const tid = el.getAttribute("data-testid") || "";
        if (/user/i.test(tid)) return "user";
        /* No marker anywhere. What used to happen here was a guess from the
           CONTENT — ".markdown or a code block means the model wrote it", then
           "short and no list means the person did". Both are wrong about the
           same message: somebody who writes their prompt as a numbered list is
           rendered in the same markdown container as an answer, so a real user
           turn was reported as the assistant's, and the card's "You asked"
           counted the wrong half of the conversation.

           Nothing about a message's text says who typed it. Answer "" —
           unknown — and let resolveRoles() settle it from the one thing that
           does hold: a thread alternates. */
        return "";
      },
      composer() { return pickComposer(["#prompt-textarea", 'textarea[data-id]', 'div[contenteditable="true"]']); }
    },
    {
      id: "claude",
      roleStable: true,   // the user-message testid, set at mount
      virtualizes: true,
      /* /chat/ is a conversation; /code/ is a Claude Code session, which is
         also one. convPath gates every per-chat feature, so leaving it out was
         why no card appeared on a Code link. */
      convPath: /^\/(chat|code)\//,
      label: "Claude",
      // The layer-1 selector, quoted for the health check: matched messages that
      // do NOT satisfy it mean this platform has drifted and we are running on
      // a fallback layer — working, but on borrowed time.
      canon: '[role="group"][aria-label="Message actions"], [data-test-render-count], [data-testid="transcript-row"], [data-testid="user-message"], .font-claude-message, .font-claude-response',
      roleCanon: '[data-testid="user-message"], .font-user-message, .font-claude-message, .font-claude-response',
      hostRe: /(^|\.)claude\.ai$/,
      /* Found on the live site, 2026-08: Claude rebuilt the transcript. The turn
         wrapper is no longer [data-test-render-count] but a row inside a
         transcript list, and the assistant body class was renamed from
         .font-claude-message to .font-claude-response. Both old selectors
         matched nothing, and with no heuristic layer beneath them this adapter
         returned zero messages on a real conversation: no minimap, no search,
         no archive, on the platform Pro is sold for.
         The old selectors are kept above the new ones rather than replaced,
         because an older Claude build is still a Claude build. */
      messages() {
        /* Layer 0: the action bar. One per rendered turn whatever the turn
           holds — nine code blocks and four tool calls still have one — so it
           is the only selector here that counts turns rather than bodies. */
        let els = Array.from(document.querySelectorAll('[role="group"][aria-label="Message actions"]'))
          .map((bar) => bar.closest('[data-test-render-count], [data-testid="transcript-row"], article') ||
            bar.parentElement || bar);
        els = claudeTurns(dedupe(els));
        if (els.length) return els;

        // Layer 1: the historical turn wrapper.
        els = Array.from(document.querySelectorAll("[data-test-render-count]"));
        els = claudeTurns(dedupe(els));
        if (els.length) return els;

        // Layer 2: the current transcript row.
        els = Array.from(document.querySelectorAll('[data-testid="transcript-row"]'));
        els = claudeTurns(dedupe(els));
        if (els.length) return els;

        // Layer 3: the message bodies, lifted to whichever wrapper exists.
        els = Array.from(document.querySelectorAll(
          '[data-testid="user-message"], .font-user-message, .font-claude-message, .font-claude-response'
        )).map((el) =>
          el.closest('[data-test-render-count], [data-testid="transcript-row"]') ||
          el.parentElement || el);
        els = claudeTurns(dedupe(els));
        if (els.length) return els;

        // Layer 4: structural, and only inside a conversation.
        return claudeTurns(heuristicInConversation(this));
      },
      role(el) {
        // A positive marker on either side, checked on the element and below it.
        if (el.matches && el.matches('[data-testid="user-message"], .font-user-message')) return "user";
        if (el.querySelector('[data-testid="user-message"], .font-user-message')) return "user";
        if (el.matches && el.matches('.font-claude-message, .font-claude-response')) return "assistant";
        if (el.querySelector && el.querySelector('.font-claude-message, .font-claude-response')) return "assistant";
        /* Neither marker. A Code session states no role on either side, and
           "assistant" here writes every turn down as the model's — the coercion
           the archive must never make. resolveRoles() alternates instead. */
        return "";
      },
      composer() { return pickComposer(['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][role="textbox"]']); }
    },
    {
      id: "gemini",
      roleStable: true,   // the custom element's own tag name
      virtualizes: true,
      convPath: /^\/app\/./,
      label: "Gemini",
      // The layer-1 selector, quoted for the health check: matched messages that
      // do NOT satisfy it mean this platform has drifted and we are running on
      // a fallback layer — working, but on borrowed time.
      canon: "user-query, model-response",
      /* What a turn IS on this host. A fallback layer matches message-content,
         and one answer holds several of them — see oncePerTurn(). */
      turnSel: 'user-query, model-response, [class*="turn-container"], ' +
        '[class*="response-container"], [class*="query-container"]',
      // Where a POSITIVE role marker exists for both sides, so the health
      // report can say whether roles were read or guessed.
      roleCanon: "user-query, model-response",
      hostRe: /(^|\.)gemini\.google\.com$/,
      // Gemini uses Shadow DOM + custom elements that Google changes often.
      // Five fallback layers: custom elements → ARIA/data attrs → structural
      // class partials → shadow DOM piercing → shared heuristic.
      messages() {
        // Layer 1: original custom elements (still work on some builds)
        let els = Array.from(document.querySelectorAll("user-query, model-response"));
        if (els.length) return els;

        // Layer 2: ARIA / data-attribute based selectors
        els = Array.from(document.querySelectorAll(
          '[data-message-id], [role="listitem"][data-content-type], message-content'
        ));
        if (els.length) return els;

        // Layer 3: structural class-name partials for conversation turns
        els = Array.from(document.querySelectorAll(
          '.conversation-container > div, [class*="turn-container"], [class*="response-container"]'
        ));
        if (els.length >= 2) return els;

        // Layer 4: shadow DOM piercing — search open shadow roots
        els = queryShadowAll(document.body, 'message-content, [data-message-id], model-response, user-query');
        if (els.length) return els;

        // Layer 5: shared heuristic (last resort)
        return heuristicInConversation(this);
      },
      role(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === "user-query") return "user";
        if (tag === "model-response") return "assistant";
        // Check for common user-message indicators
        if (el.querySelector('[data-message-author="user"]') ||
            /user|human|query/i.test(el.className) ||
            el.closest('[data-content-type="user"]')) return "user";
        return "assistant";
      },
      composer() {
        return pickComposer([
          '.ql-editor[contenteditable="true"]',
          'rich-textarea .textarea',
          '.text-input-field_input-box [contenteditable="true"]',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]'
        ]);
      }
    },
    {
      id: "perplexity",
      convPath: /^\/(search|thread)\//, // Perplexity uses both /search/ and /thread/
      label: "Perplexity",
      // The layer-1 selector, quoted for the health check: matched messages that
      // do NOT satisfy it mean this platform has drifted and we are running on
      // a fallback layer — working, but on borrowed time.
      canon: '[data-testid*=message], [data-testid*=answer], [data-testid*=query], [id^="markdown-content-"], .prose[data-renderer="lm"], [data-lct-pplx]',
      hostRe: /(^|\.)perplexity\.ai$/,
      // Best-effort: Perplexity's React DOM shifts often with hashed class names.
      // Five fallback layers: data attrs → class partials → prose containers
      // → structural thread children → shared heuristic.
      messages() {
        // Layer 1: data attributes (stable if present)
        let els = Array.from(document.querySelectorAll(
          '[data-lct-message], [data-testid*="message"], [data-testid*="answer"], [data-testid*="query"]'
        ));
        if (els.length) return els;

        /* Layer 1a (live, 2026-09): the markdown-content ids are gone. An answer
           body is .prose[data-renderer="lm"], and the thread is ONE list whose
           children alternate question, answer — ten exchanges are twenty
           children, the older ones empty placeholders until scrolled to. The
           children holding text are the messages. Marked so role() and the
           health check can say so without guessing. */
        // Never the seek's still copy or our own archive rows: anchored there,
        // the list found was a clone, and every row of it is dropped as one.
        const lm = Array.from(document.querySelectorAll('.prose[data-renderer="lm"]'))
          .find((e) => !e.closest("#lct-freeze, #lct-old-turns"));
        if (lm) {
          let turn = lm;
          while (turn.parentElement && turn.parentElement.querySelectorAll('.prose[data-renderer="lm"]').length === 1) turn = turn.parentElement;
          const list = turn.parentElement;
          if (list && !list.closest("nav, aside, header, footer")) {
            const kids = Array.from(list.children).filter((c) =>
              (c.textContent || "").trim().length > 0 || (c.querySelector && c.querySelector("img")));
            if (kids.length >= 2) {
              for (const c of kids) {
                const says = c.querySelector('.prose[data-renderer="lm"]') ? "assistant" : "user";
                if (c.dataset.lctPplx !== says) c.dataset.lctPplx = says;
              }
              return kids;
            }
          }
        }

        /* Layer 1b: the answer's own id. Perplexity numbers them —
           markdown-content-0, -1, -2 — one per answer, which is the only hook
           on this host that is neither a hashed class nor a guess. Lifted to
           the turn it sits in when that turn holds exactly one of them, so the
           question above it is counted with it rather than lost. */
        const bodies = Array.from(document.querySelectorAll('[id^="markdown-content-"]'));
        if (bodies.length) {
          const turns = bodies.map((body) => {
            let up = body;
            for (let i = 0; i < 6 && up.parentElement; i++) {
              const parent = up.parentElement;
              if (parent.querySelectorAll('[id^="markdown-content-"]').length !== 1) break;
              if (parent.closest("nav, aside, header, footer")) break;
              up = parent;
            }
            return up;
          });
          /* A turn here is a question AND an answer. Returned whole, the map
             draws one tick for both and the split reads "0 asked" — so split
             them: inside the turn, the child holding the answer body is the
             answer, and the one before it is what was asked. */
          const split = [];
          for (const turn of dedupe(turns)) {
            const holder = Array.from(turn.children)
              .find((c) => c.querySelector && c.querySelector('[id^="markdown-content-"]'));
            const asked = holder && Array.from(turn.children)
              .filter((c) => c !== holder && (c.textContent || "").trim().length > 2);
            if (holder && asked && asked.length) split.push(asked[0], holder);
            else split.push(turn);
          }
          if (split.length) return dedupe(split);
        }

        // Layer 2: original class-name partials (may still work on some deploys)
        els = Array.from(document.querySelectorAll(
          'div[class*="PromptBlock"], div[class*="AnswerBlock"], div[class*="ConversationBlock"]'
        ));
        if (els.length) return els;

        /* Layer 3: the turn row, found by walking up from real answer content.
           Perplexity ships pure Tailwind utility classes and no semantic hook
           for a turn, so there is nothing to select — but the SHAPE is stable:
           one container whose direct children are the turns, alternating a
           short question with a long answer. Verified live: 15 children, the
           ones holding a `prose` block being the answers.
           Mapping each prose block to its parent (the old layer) returned 22
           answer bodies and no questions at all, which is why every message on
           this platform was reported as the assistant's. */
        /* `id^="markdown-content-"` is what the app itself keys an answer by —
           an ID, not a class, so the class probes above and below never saw it
           and this whole host fell through to nothing: no map at all. */
        const anchor = document.querySelector(
          '[id^="markdown-content-"], [class*="prose"], [class*="markdown"]');
        let node = anchor;
        for (let depth = 0; node && node.parentElement && depth < 10; depth++) {
          const sibs = Array.from(node.parentElement.children)
            .filter((c) => (c.textContent || "").trim().length > 25);
          /* Two, not four. A thread that has been asked ONE question has a
             question and an answer, and demanding four children meant the map
             never appeared until the third exchange. The guards below are what
             make a low floor safe: mostlyProse() refuses one answer's own
             paragraphs, insideProse() refuses a body sitting beside a
             paragraph. */
          if (sibs.length >= 2 && !node.parentElement.closest("nav, aside, header, footer") &&
              !mostlyProse(sibs) && !insideProse(node.parentElement)) {
            return dedupe(sibs);
          }
          node = node.parentElement;
        }

        // Layer 4: structural — thread area's direct children with substantial content
        const thread = document.querySelector('[class*="thread"], [class*="Thread"], main > div > div');
        if (thread) {
          els = Array.from(thread.children).filter(
            c => (c.textContent || "").trim().length > 20 && !c.closest("nav, aside, header, footer")
          );
          if (els.length >= 2) return els;
        }

        // Layer 5: shared heuristic (last resort)
        return heuristicInConversation(this);
      },
      /* Every exchange keeps its place in the thread list before it is drawn —
         an empty question and an empty answer, filled in when scrolled near.
         When the list holds exactly as many places as the transcript has
         messages, place k IS message k, and a jump can go there before it has
         any text to be recognised by. */
      slotFor(index, total) {
        const lm = Array.from(document.querySelectorAll('.prose[data-renderer="lm"]'))
          .find((e) => !e.closest("#lct-freeze, #lct-old-turns"));
        if (!lm) return null;
        let turn = lm;
        while (turn.parentElement && turn.parentElement.querySelectorAll('.prose[data-renderer="lm"]').length === 1) turn = turn.parentElement;
        const kids = turn.parentElement ? Array.from(turn.parentElement.children) : [];
        return kids.length === total ? kids[index] || null : null;
      },
      role(el) {
        if (el.hasAttribute("data-lct-message")) return el.getAttribute("data-lct-role") || "assistant";
        if (el.dataset && el.dataset.lctPplx) return el.dataset.lctPplx;   // see layer 1a
        // The answer's own id, and the only role marker this host really gives.
        if (el.id && el.id.startsWith("markdown-content-")) return "assistant";
        if (el.querySelector && el.querySelector('[id^="markdown-content-"]')) return "assistant";
        if (el.hasAttribute("data-testid")) {
          const tid = el.getAttribute("data-testid");
          if (/query|question|user|prompt/i.test(tid)) return "user";
        }
        if (/Prompt|Query|question|user/i.test(el.className)) return "user";
        /* Was a content guess: "no prose structure and under 500 characters is
           a question". A user who pastes a bulleted brief has prose structure
           and is still the user. Unknown, and alternation decides — see
           resolveRoles(). */
        return "";
      },
      composer() {
        return pickComposer([
          'textarea[placeholder*="Ask"]',
          'textarea[placeholder*="follow"]',
          'textarea',
          'div[contenteditable="true"][role="textbox"]'
        ]);
      }
    },
    {
      id: "deepseek",
      roleStable: true,   // the class name the app renders it with
      convPath: /^\/(a\/)?chat\/./,
      label: "DeepSeek",
      // The layer-1 selector, quoted for the health check: matched messages that
      // do NOT satisfy it mean this platform has drifted and we are running on
      // a fallback layer — working, but on borrowed time.
      canon: ".ds-message, [class*=chat-message], [class*=message-item]",
      roleCanon: ".ds-assistant-message-main-content",
      virtualizes: true,   // ds-virtual-list mounts only the visible turns
      hostRe: /(^|\.)chat\.deepseek\.com$/,
      /* Found on the live site, 2026-08. `.ds-markdown` is the assistant's BODY,
         not a turn: on a real 6-turn conversation it matched 3 answer bodies,
         `closest()` found no turn wrapper, and the parentElement fallback landed
         on <p>/<ol>/<ul> — so the health report read 9 "messages", every one of
         them assistant, and the user's turns were never matched at all.
         The turn container is `.ds-message`. Its hashed sibling class changes
         per deploy and is deliberately not used. */
      messages() {
        // Layer 1: the turn container.
        let els = dedupe(Array.from(document.querySelectorAll(".ds-message")));
        if (els.length) return els;

        // Layer 2: older class partials.
        els = dedupe(Array.from(document.querySelectorAll(
          '[class*="chat-message"], [class*="message-item"]'
        )));
        if (els.length) return els;

        // Layer 3: message bodies, lifted to whatever turn wrapper exists.
        els = dedupe(Array.from(document.querySelectorAll(".ds-markdown"))
          .map((el) => el.closest('.ds-message, [class*="chat-message"], [class*="message-item"]') || el));
        if (els.length) return els;

        // Layer 4: structural, and only inside a conversation.
        return heuristicInConversation(this);
      },
      role(el) {
        /* The assistant's body carries a marker; the user's turn carries none,
           so "no assistant marker" IS the user signal here. Defaulting to
           assistant (the old behaviour) reported a conversation as 0 user
           messages, which is not a conversation. */
        if (el.querySelector && el.querySelector(
          '.ds-assistant-message-main-content, [class*="assistant"], .ds-markdown')) return "assistant";
        if (/assistant|bot|model/i.test(String(el.className))) return "assistant";
        return "user";
      }
    },
    {
      id: "grok",
      roleStable: true,   // data-role / alignment class, set at mount
      virtualizes: true,
      convPath: /^\/(c|chat)\/./,
      label: "Grok",
      // The layer-1 selector, quoted for the health check: matched messages that
      // do NOT satisfy it mean this platform has drifted and we are running on
      // a fallback layer — working, but on borrowed time.
      canon: "[data-testid*=message], [data-message-id]",
      hostRe: /(^|\.)grok\.com$/,
      // Experimental: Grok's React app with hashed/Tailwind classes.
      // Four fallback layers: data/ARIA attrs → class partials → semantic
      // HTML → shared heuristic.
      messages() {
        // Layer 1: data attributes / ARIA roles
        let els = Array.from(document.querySelectorAll(
          '[data-testid*="message"], [role="listitem"], [data-message-id]'
        )).filter((el) => {
          /* A bulleted list inside an ANSWER is a list of listitems, and this
             layer matched every one of them as a turn — which is a long answer
             arriving as eight ticks. A row of a virtualized thread is not the
             child of a <ul>. */
          const p = el.parentElement;
          return !(el.getAttribute("role") === "listitem" && p &&
            (p.tagName === "UL" || p.tagName === "OL" || p.getAttribute("role") === "list"));
        });
        if (els.length >= 2) return els;

        // Layer 2: original class-name partials
        els = dedupe(
          Array.from(document.querySelectorAll(
            '[class*="message-bubble"], [class*="message-row"], [class*="chat-message"], [class*="MessageBubble"]'
          )).map(el => el.closest('[class*="message-row"], [class*="chat-message"]') || el)
        );
        if (els.length >= 2) return els;

        // Layer 3: semantic HTML elements inside main
        els = Array.from(document.querySelectorAll('main article, main section > div > div'));
        if (els.length >= 2) return els;

        // Layer 4: shared heuristic (last resort)
        return heuristicInConversation(this);
      },
      role(el) {
        // Check for data attributes first
        const role = el.getAttribute("data-role") || el.getAttribute("data-message-role") || "";
        if (/user/i.test(role)) return "user";
        // Class-based detection
        if (/user|items-end|justify-end|human/i.test(String(el.className))) return "user";
        // Structural: user messages are typically right-aligned
        try {
          const style = getComputedStyle(el);
          if (style.justifyContent === "flex-end" || style.alignSelf === "flex-end") return "user";
        } catch {}
        /* Right-alignment is the only reliable signal this host gives, and it
           is absent on plenty of rows. Unknown rather than "assistant": a
           default here is a guess wearing a fact's clothes. */
        return "";
      },
      composer() {
        return pickComposer([
          'textarea[placeholder*="Ask"]',
          'textarea[placeholder*="message"]',
          'textarea',
          'div[contenteditable="true"]'
        ]);
      }
    },
    {
      id: "synthetic",
      roleStable: true,   // an explicit data-lct-role attribute
      /* Every page the suite drives, not just two of them. The heuristic layer
         is now gated on this pattern (a landing page must not invent messages),
         so a test page missing from it reads as a conversation with nothing in
         it — which is exactly how virtual-history.html broke when the gate
         landed. */
      convPath: /(synthetic|demo|virtual-history|claude-code)\.html$/,
      label: "Test Page",
      // The layer-1 selector, quoted for the health check: matched messages that
      // do NOT satisfy it mean this platform has drifted and we are running on
      // a fallback layer — working, but on borrowed time.
      canon: "[data-lct-message]",
      // Where a POSITIVE role marker exists for both sides, so the health
      // report can say whether roles were read or guessed.
      roleCanon: "[data-lct-role]",
      hostRe: /^(localhost|127\.0\.0\.1)$/,
      messages() {
        // Layer 1, and a class-based layer 2 beneath it — the same shape every
        // real adapter has, so the fallback path is exercised by the tests
        // rather than only by a live redesign.
        const els = Array.from(document.querySelectorAll("[data-lct-message]"));
        return els.length ? els : Array.from(document.querySelectorAll(".msg"));
      },
      role(el) {
        return el.getAttribute("data-lct-role") ||
          (el.classList && el.classList.contains("user") ? "user" : "assistant");
      },
      composer() { return pickComposer(["#t-composer", "#t-composer-ce"]); }
    }
  ];

  const byId = (id) => ADAPTERS.find((a) => a.id === String(id)) || null;

  function detect() {
    const host = location.hostname;
    /* Test hook, guarded by the host rather than by a flag: the suite drives
       fixture pages on localhost and has to point a REAL provider adapter at
       them. A query parameter, not a global — content scripts run in an
       isolated world, where a page-set global is not visible. It cannot exist
       on a provider page. */
    if (/^(localhost|127\.0\.0\.1)$/.test(host)) {
      let wanted;
      try { wanted = new URLSearchParams(location.search).get("lctAdapter") || ""; } catch (_) { wanted = ""; }
      const forced = wanted && byId(wanted);
      if (forced) return forced;
    }
    return ADAPTERS.find((a) => a.hostRe.test(host)) || null;
  }

  /* ---------- which account is this page? ----------
     Only for hosts the worker cannot ask a provider about. Perplexity used to
     be one of them and no longer is — it has a sync adapter now, and its
     /api/auth/session names the signed-in user outright, so a hint from here
     would be a second, competing answer to a question the provider already
     answers. The hint never leaves the extension raw: the worker
     salts and hashes it exactly like a provider account id, and the result is
     the same opaque tag everything else is keyed by. It only has to be STABLE
     per account — it is never shown, parsed, or sent anywhere.

     Google multi-login is the case that matters: two Gemini accounts really are
     open side by side in one profile, distinguished by /u/N in the path. */
  const ACCOUNT_HINTS = {
    gemini() {
      const seat = location.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
      if (seat) return "u" + seat[1];
      // Signed-in Google pages carry the account in the switcher's label. The
      // first email-shaped string is the active account.
      for (const el of document.querySelectorAll('a[aria-label*="@"], [aria-label*="Google Account"]')) {
        const found = String(el.getAttribute("aria-label") || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
        if (found) return found[0];
      }
      return "";
    }
  };

  function accountHint(adapter) {
    const read = adapter && ACCOUNT_HINTS[adapter.id];
    if (!read) return "";
    try { return String(read() || "").slice(0, 120); } catch { return ""; }
  }

  /* ---------- empty turns are not messages ----------
     Measured on a live ChatGPT conversation: 195 elements carried a role and a
     message id, and 122 of them contained nothing at all. These hosts mount
     only the tail of a conversation and leave a node behind for every turn they
     have not rendered — a node that is a promise of a message, not a message.

     Counting them put 122 phantom ticks on the minimap (each one hovering as
     "Image / attachment", because there was no text to preview), listed them in
     the outline, inflated "N asleep", and carried them into exports.

     Applied here, once, rather than in seven adapters: an element with nothing
     in it is not a message on any platform. A turn that is merely UNMOUNTED
     rejoins the moment the host puts content in it, and one that is genuinely
     mid-stream rejoins on its first token — neither needs to be guessed about.

     The media test is the reason this is not just a text check: a message whose
     whole content is an image or an audio clip has no text either, and dropping
     those would trade one wrong count for another. */
  /* Media that is actually CARRYING something. The first version of this list
     accepted a bare <img> or <iframe>, which is how 121 empty placeholders on a
     live ChatGPT conversation walked straight through a filter written to catch
     them: an element with no text and a sourceless child is not a message with
     a picture in it, it is scaffolding.

     Attribute presence only — no getBoundingClientRect, no getComputedStyle.
     This runs inside messages(), which the engine calls on every tick; a layout
     read per element per tick would cost more than the lag the engine removes. */
  const MEDIA = [
    "img[src]", "img[srcset]", "img[alt]:not([alt=''])",
    "video[src]", "video source[src]", "audio[src]", "audio source[src]",
    "canvas", "object[data]", "embed[src]", "iframe[src]",
    'svg[role="img"]',
    '[data-testid*="attachment" i]', '[class*="attachment" i]'
  ].join(",");

  /**
   * One tick per turn, however many selectors matched inside it.
   *
   * A layer that matches both a turn and something within it counts that turn
   * twice — and the nested match is never a message the ancestor does not
   * already contain, so dropping it can only ever remove an over-count. This
   * is the last thing every adapter's list goes through, so no future selector
   * can reintroduce the oldest bug in the map: one answer, several ticks.
   *
   * One comparison per element, not one per pair: querySelectorAll answers in
   * document order and nothing kept is inside anything else kept, so the only
   * element that can contain the next one is the last one kept. This runs on
   * every engine tick over the whole message list, and a pairwise sweep of
   * 1,500 messages is a million contains() calls a second.
   */
  function outermost(els) {
    if (els.length < 2) return els;
    const out = [];
    for (const el of els) {
      const prev = out[out.length - 1];
      if (prev && prev.contains && prev !== el && prev.contains(el)) continue;
      out.push(el);
    }
    return out;
  }

  function substantive(el) {
    if (!el || !el.nodeType) return false;
    if ((el.textContent || "").trim()) return true;
    try { return !!el.querySelector(MEDIA); } catch { return false; }
  }

  for (const a of ADAPTERS) {
    const raw = a.messages.bind(a);
    a.rawMessages = raw;             // what the selectors matched, before judgement
    // No "if nothing survives, show everything" escape hatch. An element with
    // neither text nor media has nothing for any feature here to use: its
    // minimap tick is blank, its search entry is empty, its export line is a
    // heading with no body. A chat still mounting its first turns would flash
    // a full map of nothing and then collapse to the real count — which is the
    // phantom bug again, briefly. Nothing to show means show nothing.
    /* …and never the freeze copy. makeFreeze() clones the whole scroller to hold a
       still picture during a walk, and that copy carries every marker the
       selectors match on — so for the length of the walk the count doubled,
       the archive flush wrote each message twice, and the walk's own
       "have we reached the total?" test passed before a single request.
       Scoped to that one id on purpose: an id-prefix test would also drop a
       host element that happens to be named lct-something. */
    a.messages = () => {
      const kept = (raw() || []).filter((el) =>
        substantive(el) && !(el.closest && el.closest("#lct-freeze")));
      /* …and never the model thinking out loud. It is not a turn: nobody wrote
         it and nobody read it as a message, so a tick for it is a tick for
         something that is not there. Dropped only when something survives —
         a host that names its turn wrapper "reasoning-turn" would otherwise
         empty the whole list, which is the mistake the tool filter made once. */
      /* `closest`, not `matches`: the thinking block is a CONTAINER, and on a
         fallback layer what the selector matches is the body inside it. Gemini
         renders one answer as several <message-content> — the thoughts, then
         the reply — so matching the element alone kept both and one message
         drew two ticks, the whole answer painted as though the working were a
         turn of its own. */
      let list = kept;
      try {
        const think = self.LCTRichText.THINK_SEL;
        const real = kept.filter((el) => !(el.closest && el.closest(think)));
        if (real.length) list = real;
      } catch (_) { /* richtext not up yet — the list stands */ }
      return oncePerTurn(a, outermost(list));
    };
  }

  /* One tick per TURN, not per body.
   *
   * A primary layer matches turn containers and needs none of this. A fallback
   * matches whatever is left — a body, a content block — and a single answer
   * can hold several of those: Gemini's <model-response> carries one
   * <message-content> for its working and another for the reply, so the day
   * the custom element names change, every answer starts counting twice.
   *
   * So when an adapter names the containers a turn IS (`turnSel`), each match
   * is lifted to the one that holds it and duplicates collapse. Structure
   * only, and it can never REMOVE a turn: an element with no such ancestor is
   * kept exactly where it is.
   */
  function oncePerTurn(adapter, list) {
    const sel = adapter && adapter.turnSel;
    if (!sel || list.length < 2) return list;
    const out = [];
    const seen = new Set();
    for (const el of list) {
      let turn;
      try { turn = el.closest && el.closest(sel); } catch (_) { /* bad selector */ }
      const key = turn || el;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  // adapters without an explicit composer() use the generic resolver
  for (const a of ADAPTERS) if (!a.composer) a.composer = () => pickComposer([]);
  // …and without an explicit stableKey() use the shared id probe. A host that
  // assigns ids in some third shape overrides this; one that assigns none at
  // all needs no override, because the shared probe already returns "".
  for (const a of ADAPTERS) if (!a.stableKey) a.stableKey = stableKey;

  /* role() is a subtree query on most hosts, and four callers ask for every
     message on a timer — the minimap's meta, the chat card's record, the
     outline's render and the archive flush. A message's role never changes, so
     memoize it once at the boundary and every caller gets it.

     Only for adapters flagged roleStable: those read a marker that is present
     the moment the element mounts. Perplexity is deliberately not one — its
     role() decides from text length, so a streaming answer reads as "user"
     until it grows, and caching that would make the guess permanent. */
/**
   * Who wrote each message, for a whole list at once.
   *
   * `role(el)` answers for one element and is allowed to say "" — unknown —
   * when the host gives it no marker. That is the honest answer, and it used to
   * be a guess from the message's own text: markdown or a code block meant the
   * model, short and plain meant the person. Both are wrong about the same
   * message, because a prompt written as a numbered list looks exactly like an
   * answer written as one. That is what reported somebody's own point-wise
   * prompts as the assistant's replies.
   *
   * What actually holds on every one of these hosts is that a thread
   * ALTERNATES. So: keep every role the host stated, and fill the gaps by
   * walking out from the nearest stated one. A single marker anywhere in the
   * list pins the whole parity; with none at all, the first message is the
   * person's, which is true of every conversation that exists — somebody had
   * to start it.
   *
   * Returns an array parallel to `els`. Never throws: a broken adapter costs a
   * guess, not a render.
   */
  function resolveRoles(adapter, els) {
    const list = Array.isArray(els) ? els : [];
    const out = new Array(list.length).fill("");
    for (let i = 0; i < list.length; i++) {
      let r;
      try { r = adapter && typeof adapter.role === "function" ? adapter.role(list[i]) : ""; }
      catch { r = ""; }
      out[i] = r === "user" || r === "assistant" ? r : "";
    }
    let anchorAt = -1;
    for (let i = 0; i < out.length; i++) if (out[i]) { anchorAt = i; break; }
    if (anchorAt === -1) {
      // Nothing stated anywhere. Somebody started the conversation.
      for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? "user" : "assistant";
      return out;
    }
    // Backwards from the first stated role, then forwards from every gap.
    for (let i = anchorAt - 1; i >= 0; i--) out[i] = out[i + 1] === "user" ? "assistant" : "user";
    for (let i = anchorAt + 1; i < out.length; i++) {
      if (!out[i]) out[i] = out[i - 1] === "user" ? "assistant" : "user";
    }
    return out;
  }

  const roleMemo = new WeakMap();
  for (const a of ADAPTERS) {
    if (!a.roleStable) continue;
    const read = a.role;
    a.role = function (el) {
      let r = roleMemo.get(el);
      /* Only a STATED role is cached. "" means the host had not painted its
         marker yet, and remembering that would make a temporary gap permanent
         — the element mounts, we look too early, and it is unknown forever. */
      if (r === undefined) {
        r = read.call(this, el);
        if (r === "user" || r === "assistant") roleMemo.set(el, r);
      }
      return r;
    };
  }

  /* ---------- ephemeral conversations (temporary / private / signed out) ----------
   *
   * Temporary chat, private chat, incognito, signed-out: one shared fact — the
   * provider never persists the conversation, so no id, so the URL stays on the
   * landing path. That is why convPath disables every per-chat feature at once,
   * on all six hosts.
   *
   * Structural, not branded. A "Temporary chat" badge is six selectors, six
   * wordings, dead on the next redesign and absent in any other language. The
   * structure is the same everywhere: real messages, on a URL no saved chat
   * lives at. A query flag confirms where a host sets one; nothing depends on it.
   *
   * Id derived, not random. Every temporary chat on a host shares one URL, so a
   * URL-derived id collides and they overwrite each other. The first message
   * hashes to an id stable for the life of the chat and different for the next.
   *
   * null for anything that is not an unpersisted conversation.
   */
  const EPHEMERAL_FLAG = /[?&](temporary-chat|temporary|private|incognito)=(1|true)\b/i;

  /* FNV-1a, 32 bits. Not a security hash: only has to differ between two
     conversations, and runs on an engine tick. */
  function shortHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(36);
  }

  function ephemeral(adapter, msgs) {
    if (!adapter || !adapter.convPath || adapter.id === "synthetic") return null;
    if (adapter.convPath.test(location.pathname)) return null;   // a saved chat
    const list = msgs || [];
    // The floor used elsewhere in this file: below it, landing-page prose
    // reads as a conversation.
    if (list.length < 2) return null;
    /* Provider id AND opening text, not one or the other. The id alone assumes
       it is unique across conversations — true for ChatGPT's UUIDs, false for
       any host numbering messages per chat, where two temporary chats would
       collide and silently overwrite each other in the archive. The text alone
       collides whenever two chats open with the same prompt. Together they do
       not, and neither costs anything. */
    let id = "";
    try { id = adapter.stableKey(list[0]) || ""; } catch { /* text still stands */ }
    const text = String(list[0].textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!id && !text) return null;
    const seed = id + "|" + text;
    return {
      id: location.hostname + location.pathname + "#temp-" + shortHash(seed),
      flagged: EPHEMERAL_FLAG.test(location.search)
    };
  }

  self.LCTAdapters = { detect, byId, findScroller, pickComposer, accountHint, stableKey, ephemeral, resolveRoles };
})();
