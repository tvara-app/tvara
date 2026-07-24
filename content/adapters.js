/**
 * Long Chat Toolkit — platform adapters.
 * Each adapter knows how to find message elements on one AI chat platform.
 * Defensive by design: multiple selector candidates, graceful null returns.
 * If nothing matches, the toolkit does NOTHING (never break the host page).
 */
(() => {
  "use strict";

  const dedupe = (els) => Array.from(new Set(els.filter(Boolean)));

  /** Recursively search through open shadow roots for matching elements. */
  function queryShadowAll(root, selector) {
    const results = [];
    try { results.push(...root.querySelectorAll(selector)); } catch {}
    const walk = (node) => {
      if (node.shadowRoot) {
        try { results.push(...node.shadowRoot.querySelectorAll(selector)); } catch {}
        node.shadowRoot.querySelectorAll("*").forEach(walk);
      }
    };
    root.querySelectorAll("*").forEach(walk);
    return dedupe(results);
  }

  /**
   * Shared fallback for platforms with build-hashed class names (DeepSeek,
   * Grok, Perplexity): the message list is the element with the most
   * text-bearing children. Lowered threshold to 6 children with a stricter
   * text-length filter (>20 chars) to avoid false positives on nav/sidebar
   * elements while still catching shorter conversations.
   */
  function heuristicMessages() {
    let best = null;
    for (const el of document.querySelectorAll("div, section, ol, ul")) {
      const n = el.childElementCount;
      if (n < 6 || n > 2000) continue;
      if (el.closest("nav, aside, header, footer")) continue;
      if (!best || n > best.childElementCount) best = el;
    }
    if (!best) return [];
    const kids = Array.from(best.children).filter(
      (c) => (c.textContent || "").trim().length > 20
    );
    return kids.length >= 4 ? kids : [];
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

  /** Find the nearest scrollable ancestor of an element. */
  function findScroller(el) {
    let node = el;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 100) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  const ADAPTERS = [
    {
      id: "chatgpt",
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

        // Layer 5: structural — largest child-list with text content
        const root = document.querySelector("main") || document.body;
        let best = null, bestN = 0;
        for (const el of root.querySelectorAll("div")) {
          const n = el.childElementCount;
          if (n < 4 || n > 2000) continue;
          if (el.closest("nav, aside, header, footer")) continue;
          const textKids = Array.from(el.children).filter(
            (c) => (c.textContent || "").trim().length > 20
          );
          if (textKids.length > bestN && textKids.length >= 4) {
            bestN = textKids.length;
            best = el;
          }
        }
        if (best) {
          els = Array.from(best.children).filter(
            (c) => (c.textContent || "").trim().length > 20
          );
          if (els.length >= 4) return els;
        }

        // Layer 6: shared heuristic (last resort)
        return heuristicMessages();
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

  // adapters without an explicit composer() use the generic resolver
  for (const a of ADAPTERS) if (!a.composer) a.composer = () => pickComposer([]);

  self.LCTAdapters = { detect, findScroller, pickComposer };
})();
