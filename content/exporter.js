/**
 * Long Chat Toolkit — one-click backup/export.
 * Extracts the conversation to Markdown or JSON and downloads it locally.
 * Honest contract: exports every message element currently loaded in the
 * page — platforms that virtualize very long chats (ChatGPT) unload old
 * messages, so the caller surfaces a "currently loaded" caveat to the user.
 */
(() => {
  "use strict";

  const BLOCK_RE = /^(p|div|section|article|li|ul|ol|h[1-6]|blockquote|table|tr|hr)$/;

  function extract(adapter, timeFn) {
    const els = adapter.messages();
    return els.map((el) => {
      let role = "assistant";
      try {
        role = adapter.role(el);
      } catch (_) {}
      const rec = { role, text: elementToText(el) };
      if (timeFn) {
        try {
          const inf = timeFn(el);
          if (inf) {
            rec.time = new Date(inf.t * 1000).toISOString();
            rec.timeSource = inf.kind === "exact" ? "platform" : "first-seen-local";
          }
        } catch (_) {}
      }
      return rec;
    });
  }

  /**
   * Structure-preserving text extraction. `innerText` on a detached clone
   * degrades to textContent (no line breaks), so we walk the live element
   * and insert breaks at block boundaries; <pre> becomes a fenced code block.
   */
  function elementToText(el) {
    const out = [];
    serialize(el, out);
    return out
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function serialize(node, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.id && String(node.id).startsWith("lct-")) return; // our own UI

    const tag = node.tagName.toLowerCase();
    if (tag === "pre") {
      out.push("\n\n```\n" + (node.textContent || "").replace(/\n$/, "") + "\n```\n\n");
      return;
    }
    if (tag === "br") {
      out.push("\n");
      return;
    }
    /* An image IS content. A message that is nothing but a screenshot came out
       of here as an empty string — so it exported as a blank line, previewed as
       nothing, and matched no search. On a live 591-message conversation, 122
       of the user's turns were exactly that: a pasted screenshot with no
       caption. The alt text these hosts write is the file name, which is the
       most useful handle a person has on their own screenshots. */
    if (tag === "img") {
      const name = (node.getAttribute("alt") || "").trim() ||
        (node.closest("[aria-label]")?.getAttribute("aria-label") || "")
          .replace(/^Open image:\s*/i, "").trim();
      out.push(name ? `[image: ${name}]` : "[image]");
      return;
    }
    const isBlock = BLOCK_RE.test(tag);
    if (isBlock) out.push("\n");
    if (tag === "li") out.push("- ");
    for (const child of node.childNodes) serialize(child, out);
    if (isBlock) out.push("\n");
  }

  function fmtLocal(iso) {
    const d = new Date(iso);
    const opts = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    return d.toLocaleString(undefined, opts);
  }

  function toMarkdown(messages) {
    const title = document.title || "AI Conversation";
    const lines = [
      `# ${title}`,
      ``,
      `> Exported by Long Chat Toolkit — ${new Date().toISOString()} — ${location.href}`,
      `> Contains the ${messages.length} messages loaded in the page at export time.`,
      ``
    ];
    for (const m of messages) {
      let head = m.role === "user" ? `## 🧑 You` : `## 🤖 AI`;
      if (m.time) {
        head +=
          m.timeSource === "platform"
            ? ` — ${fmtLocal(m.time)}`
            : ` — first seen ${fmtLocal(m.time)}`;
      }
      lines.push(head, "", m.text, "");
    }
    return lines.join("\n");
  }

  function toJSON(messages) {
    return JSON.stringify(
      {
        exportedBy: "Long Chat Toolkit",
        exportedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        messageCount: messages.length,
        note: "Contains the messages loaded in the page at export time.",
        messages
      },
      null,
      2
    );
  }

  function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function slugTitle() {
    return (document.title || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  }

  /**
   * The archived copy of THIS conversation, when it has more of it than the
   * page does. A host that mounts its recent tail hands the exporter 197 of
   * 1,471 messages, and a backup that is 13% of a conversation is not a backup.
   */
  function archived(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => finish(null), timeoutMs || 2500);
      try {
        chrome.runtime.sendMessage({
          type: "chat-archive", host: location.hostname, path: location.pathname
        }, (res) => {
          void chrome.runtime.lastError;
          finish(res && res.status === "ok" ? res : null);
        });
      } catch { finish(null); }
    });
  }

  async function exportChat(adapter, format, timeFn) {
    const live = extract(adapter, timeFn);
    let messages = live;
    let whole = false;

    const arch = await archived();
    if (arch && arch.msgs.length > live.length) {
      /* The archive is the spine because it is the complete one. Where a
         message is also on screen the page's text wins: it is the fresher of
         the two, and the one the reader can actually see. */
      const byText = new Map();
      for (const m of live) byText.set((m.text || "").slice(0, 120), m);
      messages = arch.msgs.map((m) => {
        const hit = byText.get((m.t || "").slice(0, 120));
        if (hit) return hit;
        const rec = { role: m.r === "user" ? "user" : "assistant", text: m.t || "" };
        if (m.ts) {
          rec.time = new Date(m.ts * (m.ts > 1e12 ? 1 : 1000)).toISOString();
          rec.timeSource = "platform";
        }
        return rec;
      });
      whole = true;
    }

    if (!messages.length) return { ok: false, reason: "no-messages" };
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "json") {
      download(toJSON(messages), `${slugTitle()}-${stamp}.json`, "application/json");
    } else {
      download(toMarkdown(messages), `${slugTitle()}-${stamp}.md`, "text/markdown");
    }
    return { ok: true, count: messages.length, whole, loaded: live.length };
  }

  /* extract() and elementToText() are the only correct way to get readable
     text out of these hosts — innerText on a clone loses every line break, and
     a plain textContent welds paragraphs together. "Continue in a new chat"
     needs the same reading, so it borrows this one rather than growing a
     second, worse copy. */
  self.LCTExporter = { exportChat, extract, elementToText };
})();
