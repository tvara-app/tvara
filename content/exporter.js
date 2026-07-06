/**
 * Long Chat Toolkit — one-click backup/export (Pro).
 * Extracts the full conversation to Markdown or JSON and downloads it locally.
 * Zero-data-loss contract: every message element the adapter can see is exported.
 */
(() => {
  "use strict";

  function extract(adapter) {
    const els = adapter.messages();
    return els.map((el) => {
      let role = "assistant";
      try { role = adapter.role(el); } catch (_) {}
      return { role, text: elementToText(el) };
    });
  }

  /** innerText, but with code blocks preserved as fenced markdown. */
  function elementToText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("pre").forEach((pre) => {
      const code = pre.textContent || "";
      const fence = document.createTextNode("\n```\n" + code.replace(/\n$/, "") + "\n```\n");
      pre.replaceWith(fence);
    });
    // strip our own UI if any leaked into the clone
    clone.querySelectorAll("#lct-minimap, #lct-mm-tooltip").forEach((n) => n.remove());
    return (clone.innerText || clone.textContent || "").trim();
  }

  function toMarkdown(messages) {
    const title = document.title || "AI Conversation";
    const lines = [
      `# ${title}`,
      ``,
      `> Exported by Long Chat Toolkit — ${new Date().toISOString()} — ${location.href}`,
      ``
    ];
    for (const m of messages) {
      lines.push(m.role === "user" ? `## 🧑 You` : `## 🤖 AI`);
      lines.push("");
      lines.push(m.text);
      lines.push("");
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

  function exportChat(adapter, format) {
    const messages = extract(adapter);
    if (!messages.length) return { ok: false, reason: "no-messages" };
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "json") {
      download(toJSON(messages), `${slugTitle()}-${stamp}.json`, "application/json");
    } else {
      download(toMarkdown(messages), `${slugTitle()}-${stamp}.md`, "text/markdown");
    }
    return { ok: true, count: messages.length };
  }

  self.LCTExporter = { exportChat };
})();
