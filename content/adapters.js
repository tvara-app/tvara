/**
 * Long Chat Toolkit — platform adapters.
 * Each adapter knows how to find message elements on one AI chat platform.
 * Defensive by design: multiple selector candidates, graceful null returns.
 * If nothing matches, the toolkit does NOTHING (never break the host page).
 */
(() => {
  "use strict";

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

  function stableKey(el) {
    if (!el || !el.getAttribute) return "";
    const withId = el.hasAttribute("data-message-id")
      ? el
      : (el.querySelector && el.querySelector("[data-message-id]"));
    if (withId) return withId.getAttribute("data-message-id") || "";
    if (el.id && R_ID.test(el.id)) return el.id;
    const rid = el.querySelector && el.querySelector('[id^="r_"], [id^="R_"]');
    if (rid && R_ID.test(rid.id)) return rid.id;
    return "";
  }

  const TEXTY = 20;   // chars that make a child look like a message, not chrome

  const textyChildren = (el) => {
    const out = [];
    for (const c of el.children) if ((c.textContent || "").trim().length > TEXTY) out.push(c);
    return out;
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
      if (kids.length >= 4) return kids;
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
      hostRe: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
      messages() {
        // Layer 1 (current, stable): div elements with data-message-id
        // As of 2025–2026, ChatGPT wraps each message in a div with
        // data-message-id and data-message-author-role attributes.
        let els = dedupe(Array.from(
          document.querySelectorAll('[data-message-id]')
        ));
        if (els.length) return els;

        // Layer 2: data-message-author-role without data-message-id
        // (in case the id attribute is dropped but role remains)
        els = dedupe(Array.from(
          document.querySelectorAll('[data-message-author-role]')
        ));
        if (els.length) return els;

        // Layer 3 (legacy): article-based conversation turns
        els = dedupe(Array.from(
          document.querySelectorAll('article[data-testid^="conversation-turn"]')
        ));
        if (els.length) return els;

        // Layer 4 (legacy variant): div-based conversation turns
        els = dedupe(Array.from(
          document.querySelectorAll('div[data-testid^="conversation-turn"]')
        ));
        if (els.length) return els;

        // Layer 5 (last resort): structural — densest child-list with text.
        // Shared with the other hosts rather than a second, costlier copy: the
        // copy that lived here serialized every div's children to rank them,
        // which on a redesign would have run over the whole document four
        // times a second. 4 children, not 6 — ChatGPT's threshold.
        return heuristicMessages(null, 4);
      },
      role(el) {
        // Check the element itself first (current ChatGPT puts role on the message div)
        if (el.hasAttribute("data-message-author-role")) {
          return el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant";
        }
        // Check descendants
        const r = el.querySelector("[data-message-author-role]");
        if (r) return r.getAttribute("data-message-author-role") === "user" ? "user" : "assistant";
        // data-testid may encode the role (legacy)
        const tid = el.getAttribute("data-testid") || "";
        if (/user/i.test(tid)) return "user";
        // Structural heuristics
        if (el.querySelector('.markdown, .prose, pre, code, [class*="markdown"]')) return "assistant";
        const text = (el.textContent || "").trim();
        if (text.length < 300 && !el.querySelector("pre, ol, ul, table")) return "user";
        return "assistant";
      },
      composer() { return pickComposer(["#prompt-textarea", 'textarea[data-id]', 'div[contenteditable="true"]']); }
    },
    {
      id: "claude",
      roleStable: true,   // the user-message testid, set at mount
      virtualizes: true,
      convPath: /^\/chat\//,
      label: "Claude",
      hostRe: /(^|\.)claude\.ai$/,
      messages() {
        let els = Array.from(document.querySelectorAll("[data-test-render-count]"));
        if (!els.length) {
          els = Array.from(
            document.querySelectorAll('[data-testid="user-message"], .font-claude-message, .font-user-message')
          ).map((el) => el.closest("[data-test-render-count]") || el.parentElement || el);
        }
        return dedupe(els);
      },
      role(el) {
        return el.querySelector('[data-testid="user-message"], .font-user-message') ? "user" : "assistant";
      },
      composer() { return pickComposer(['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][role="textbox"]']); }
    },
    {
      id: "gemini",
      roleStable: true,   // the custom element's own tag name
      virtualizes: true,
      convPath: /^\/app\/./,
      label: "Gemini",
      hostRe: /(^|\.)gemini\.google\.com$/,
      // Gemini uses Shadow DOM + custom elements that Google changes often.
      // Five fallback layers: custom elements → ARIA/data attrs → structural
      // class partials → shadow DOM piercing → shared heuristic.
      messages() {
        // Layer 1: original custom elements (still work on some builds)
        let els = dedupe(Array.from(document.querySelectorAll("user-query, model-response")));
        if (els.length) return els;

        // Layer 2: ARIA / data-attribute based selectors
        els = dedupe(Array.from(document.querySelectorAll(
          '[data-message-id], [role="listitem"][data-content-type], message-content'
        )));
        if (els.length) return els;

        // Layer 3: structural class-name partials for conversation turns
        els = dedupe(Array.from(document.querySelectorAll(
          '.conversation-container > div, [class*="turn-container"], [class*="response-container"]'
        )));
        if (els.length >= 2) return els;

        // Layer 4: shadow DOM piercing — search open shadow roots
        els = queryShadowAll(document.body, 'message-content, [data-message-id], model-response, user-query');
        if (els.length) return els;

        // Layer 5: shared heuristic (last resort)
        return heuristicMessages();
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
      hostRe: /(^|\.)perplexity\.ai$/,
      // Best-effort: Perplexity's React DOM shifts often with hashed class names.
      // Five fallback layers: data attrs → class partials → prose containers
      // → structural thread children → shared heuristic.
      messages() {
        // Layer 1: data attributes (stable if present)
        let els = dedupe(Array.from(document.querySelectorAll(
          '[data-lct-message], [data-testid*="message"], [data-testid*="answer"], [data-testid*="query"]'
        )));
        if (els.length) return els;

        // Layer 2: original class-name partials (may still work on some deploys)
        els = dedupe(Array.from(document.querySelectorAll(
          'div[class*="PromptBlock"], div[class*="AnswerBlock"], div[class*="ConversationBlock"]'
        )));
        if (els.length) return els;

        // Layer 3: prose/markdown container pattern
        els = dedupe(Array.from(document.querySelectorAll(
          '[class*="prose"], [class*="markdown"]'
        )).map(el => el.closest('[class*="Block"]') || el.parentElement || el));
        if (els.length >= 2) return els;

        // Layer 4: structural — thread area's direct children with substantial content
        const thread = document.querySelector('[class*="thread"], [class*="Thread"], main > div > div');
        if (thread) {
          els = Array.from(thread.children).filter(
            c => (c.textContent || "").trim().length > 20 && !c.closest("nav, aside, header, footer")
          );
          if (els.length >= 2) return els;
        }

        // Layer 5: shared heuristic (last resort)
        return heuristicMessages();
      },
      role(el) {
        if (el.hasAttribute("data-lct-message")) return el.getAttribute("data-lct-role") || "assistant";
        if (el.hasAttribute("data-testid")) {
          const tid = el.getAttribute("data-testid");
          if (/query|question|user|prompt/i.test(tid)) return "user";
        }
        if (/Prompt|Query|question|user/i.test(el.className)) return "user";
        // Heuristic: short text without prose structure is likely a user question
        const text = (el.textContent || "").trim();
        const hasProse = !!el.querySelector('[class*="prose"], [class*="markdown"], pre, ol, ul, table');
        if (!hasProse && text.length < 500) return "user";
        return "assistant";
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
      hostRe: /(^|\.)chat\.deepseek\.com$/,
      // Experimental: DeepSeek hashes its class names per deploy. Semantic
      // hooks first, shared heuristic second, nothing third.
      messages() {
        let els = Array.from(
          document.querySelectorAll('[class*="chat-message"], [class*="message-item"], .ds-markdown')
        ).map((el) => el.closest('[class*="chat-message"], [class*="message-item"]') || el.parentElement || el);
        els = dedupe(els);
        return els.length >= 10 ? els : heuristicMessages();
      },
      role(el) {
        return /user|human/i.test(String(el.className)) ? "user" : "assistant";
      }
    },
    {
      id: "grok",
      roleStable: true,   // data-role / alignment class, set at mount
      virtualizes: true,
      convPath: /^\/(c|chat)\/./,
      label: "Grok",
      hostRe: /(^|\.)grok\.com$/,
      // Experimental: Grok's React app with hashed/Tailwind classes.
      // Four fallback layers: data/ARIA attrs → class partials → semantic
      // HTML → shared heuristic.
      messages() {
        // Layer 1: data attributes / ARIA roles
        let els = dedupe(Array.from(document.querySelectorAll(
          '[data-testid*="message"], [role="listitem"], [data-message-id]'
        )));
        if (els.length >= 2) return els;

        // Layer 2: original class-name partials
        els = dedupe(
          Array.from(document.querySelectorAll(
            '[class*="message-bubble"], [class*="message-row"], [class*="chat-message"], [class*="MessageBubble"]'
          )).map(el => el.closest('[class*="message-row"], [class*="chat-message"]') || el)
        );
        if (els.length >= 2) return els;

        // Layer 3: semantic HTML elements inside main
        els = dedupe(Array.from(document.querySelectorAll('main article, main section > div > div')));
        if (els.length >= 2) return els;

        // Layer 4: shared heuristic (last resort)
        return heuristicMessages();
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
        return "assistant";
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
      convPath: /(synthetic|demo)\.html$/,
      label: "Test Page",
      hostRe: /^(localhost|127\.0\.0\.1)$/,
      messages() {
        return Array.from(document.querySelectorAll("[data-lct-message]"));
      },
      role(el) {
        return el.getAttribute("data-lct-role") || "assistant";
      },
      composer() { return pickComposer(["#t-composer", "#t-composer-ce"]); }
    }
  ];

  function detect() {
    const host = location.hostname;
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
  const roleMemo = new WeakMap();
  for (const a of ADAPTERS) {
    if (!a.roleStable) continue;
    const read = a.role;
    a.role = function (el) {
      let r = roleMemo.get(el);
      if (r === undefined) { r = read.call(this, el); roleMemo.set(el, r); }
      return r;
    };
  }

  self.LCTAdapters = { detect, findScroller, pickComposer, accountHint, stableKey };
})();
