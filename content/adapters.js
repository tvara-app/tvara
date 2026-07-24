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
   * Shared fallback for platforms with build-hashed class names (DeepSeek,
   * Grok): the message list is the element with the most text-bearing
   * children. Conservative: under 25 children we return nothing — the engine
   * ignores short chats anyway, and guessing wrong on someone's app is worse
   * than doing nothing.
   */
  function heuristicMessages() {
    let best = null;
    for (const el of document.querySelectorAll("div, section, ol, ul")) {
      const n = el.childElementCount;
      if (n < 25 || n > 2000) continue;
      if (el.closest("nav, aside, header, footer")) continue;
      if (!best || n > best.childElementCount) best = el;
    }
    if (!best) return [];
    const kids = Array.from(best.children).filter(
      (c) => (c.textContent || "").trim().length > 0
    );
    return kids.length >= 25 ? kids : [];
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
        let els = Array.from(
          document.querySelectorAll('article[data-testid^="conversation-turn"]')
        );
        if (!els.length) {
          els = Array.from(document.querySelectorAll("main [data-message-author-role]"))
            .map((el) => el.closest("article") || el.parentElement || el);
        }
        return dedupe(els);
      },
      role(el) {
        const r = el.querySelector("[data-message-author-role]");
        return r && r.getAttribute("data-message-author-role") === "user" ? "user" : "assistant";
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
      messages() {
        return dedupe(Array.from(document.querySelectorAll("user-query, model-response")));
      },
      role(el) {
        return el.tagName.toLowerCase() === "user-query" ? "user" : "assistant";
      },
      composer() { return pickComposer(['.ql-editor[contenteditable="true"]', 'rich-textarea .textarea', 'div[contenteditable="true"]']); }
    },
    {
      id: "perplexity",
      convPath: /^\/search\/./,
      label: "Perplexity",
      hostRe: /(^|\.)perplexity\.ai$/,
      // Best-effort: Perplexity's DOM shifts often; degrade gracefully to nothing.
      messages() {
        return dedupe(Array.from(document.querySelectorAll('[data-lct-message], div[class*="PromptBlock"], div[class*="AnswerBlock"]')));
      },
      role(el) {
        if (el.hasAttribute("data-lct-message")) return el.getAttribute("data-lct-role") || "assistant";
        return /Prompt/i.test(el.className) ? "user" : "assistant";
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
      // Experimental: Grok's standalone app. Bubble selectors first, shared
      // heuristic second, nothing third.
      messages() {
        let els = dedupe(
          Array.from(document.querySelectorAll('[class*="message-bubble"], [class*="message-row"]')).map(
            (el) => el.closest('[class*="message-row"]') || el
          )
        );
        return els.length >= 10 ? els : heuristicMessages();
      },
      role(el) {
        return /user|items-end|justify-end/i.test(String(el.className)) ? "user" : "assistant";
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
