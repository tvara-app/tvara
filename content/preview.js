/**
 * Long Chat Toolkit — message preview.
 *
 * Clicking a message the host has not rendered used to mean waiting while the
 * site paged its way back to it, watching the page move and hoping it landed.
 * We already hold that message's text, so it opens instantly and the real
 * navigation runs behind it: read now, arrive when the site catches up.
 *
 * The panel is not a reader — it is the wait, made useful. It closes itself the
 * moment the real message is on screen.
 */
(() => {
  "use strict";

  let panel = null, titleEl = null, bodyEl = null, noteEl = null;
  let open = false;
  let token = 0;

  function build() {
    if (panel && panel.isConnected) return;
    panel = document.createElement("div");
    panel.id = "lct-preview";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Message preview");
    // static markup only — message text is set via textContent below
    panel.innerHTML = `
      <div class="lct-p-head">
        <span class="lct-p-title"></span>
        <button type="button" class="lct-p-close" title="Close (Esc)" aria-label="Close preview">✕</button>
      </div>
      <div class="lct-p-body"></div>
      <div class="lct-p-note"></div>
    `;
    document.documentElement.appendChild(panel);
    titleEl = panel.querySelector(".lct-p-title");
    bodyEl = panel.querySelector(".lct-p-body");
    noteEl = panel.querySelector(".lct-p-note");
    panel.querySelector(".lct-p-close").addEventListener("click", close);
    window.addEventListener("keydown", (e) => {
      if (open && e.key === "Escape") { e.stopPropagation(); close(); }
    }, true);
  }

  /**
   * @param {{key: string, role: string, snippet: string}} entry catalog entry
   * @param {number} index 0-based position in the conversation
   * @param {number} total
   */
  function show(entry, index, total) {
    if (!entry) return;
    build();
    const mine = ++token;
    open = true;
    panel.classList.add("lct-p-open");
    titleEl.textContent = `#${index + 1} of ${total} · ${entry.role === "user" ? "You" : "AI"}`;
    // The snippet is what we have this instant; the full text is one IndexedDB
    // read away and replaces it a frame or two later.
    bodyEl.textContent = entry.snippet || "";
    bodyEl.classList.add("lct-p-partial");
    bodyEl.scrollTop = 0;
    noteEl.textContent = "Loading it in the chat…";

    const id = entry.key && entry.key.startsWith("id:") ? entry.key.slice(3) : "";
    if (!id) return;
    try {
      chrome.runtime.sendMessage(
        { type: "chat-message", host: location.hostname, path: location.pathname, id },
        (r) => {
          void chrome.runtime.lastError;
          if (mine !== token || !open) return;      // they closed it, or clicked another tick
          if (r && r.status === "ok" && r.text) {
            bodyEl.textContent = r.text;
            bodyEl.classList.remove("lct-p-partial");
          }
        }
      );
    } catch (_) { /* extension context gone — the snippet stands */ }
  }

  function note(text) {
    if (!open || !noteEl) return;
    noteEl.textContent = text;
  }

  function close() {
    token++;
    open = false;
    if (panel) panel.classList.remove("lct-p-open");
  }

  self.LCTPreview = { open: show, close, note, get isOpen() { return open; } };
})();
