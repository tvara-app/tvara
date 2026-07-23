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
      }
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
      }
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
      }
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
      }
    }
  ];

  function detect() {
    const host = location.hostname;
    return ADAPTERS.find((a) => a.hostRe.test(host)) || null;
  }

  self.LCTAdapters = { detect, findScroller };
})();
