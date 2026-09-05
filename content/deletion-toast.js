/**
 * Tvara — "a chat was deleted where you use it", asked where the user is.
 *
 * The decision travels WITH the message: Keep and Delete are on the toast, so
 * answering costs no page visit. A delete is instant and reversible for five
 * seconds from a bar at the bottom of the screen.
 */
(() => {
  "use strict";

  const UNDO_MS = 5000;
  let toast = null;
  let undoBar = null;
  let undoTimer = 0;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res); });
    } catch (_) { resolve(null); }
  });

  function close() {
    if (!toast) return;
    toast.remove();
    toast = null;
  }

  function show(info) {
    close();
    toast = el("div");
    toast.id = "lct-del-toast";
    toast.setAttribute("role", "alertdialog");
    toast.setAttribute("aria-live", "polite");

    const head = el("div", "lct-del-head", "A chat was deleted on the site");
    const name = el("div", "lct-del-name", info.title || "Untitled chat");
    const sub = el("div", "lct-del-sub",
      (info.platform ? info.platform + " · " : "") +
      (info.messages ? info.messages + " messages · " : "") +
      "your backup still has every word");

    const row = el("div", "lct-del-row");
    const keep = el("button", "lct-del-keep", "Keep my copy");
    const drop = el("button", "lct-del-drop", "Delete it too");
    keep.type = "button";
    drop.type = "button";

    keep.addEventListener("click", async () => {
      close();
      await send({ type: "recall-deletions-resolve", ids: [info.id], action: "keep" });
    });
    drop.addEventListener("click", async () => {
      close();
      const answer = await send({ type: "recall-deletions-resolve", ids: [info.id], action: "delete" });
      if (answer && answer.undo) offerUndo(answer.undo, answer.count || 1);
    });

    row.append(keep, drop);
    toast.append(head, name, sub, row);
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => toast && toast.classList.add("lct-del-in"));
  }

  /* Five seconds, and a real restore behind it: the worker keeps the whole
     record aside, so this puts the chat back rather than re-fetching it from a
     provider that no longer has it. */
  function offerUndo(token, count) {
    if (undoBar) { undoBar.remove(); clearTimeout(undoTimer); }
    undoBar = el("div");
    undoBar.id = "lct-del-undo";
    undoBar.setAttribute("role", "status");
    const said = el("span", "lct-del-undo-text",
      count > 1 ? count + " copies deleted from your backup" : "Deleted from your backup");
    const btn = el("button", "lct-del-undo-btn", "Undo");
    btn.type = "button";
    const bar = el("span", "lct-del-undo-bar");
    btn.addEventListener("click", async () => {
      clearTimeout(undoTimer);
      const back = await send({ type: "recall-deletions-undo", token });
      undoBar.replaceChildren(el("span", "lct-del-undo-text",
        back && back.ok ? "Restored to your backup" : "That copy has already gone"));
      setTimeout(() => { if (undoBar) { undoBar.remove(); undoBar = null; } }, 2000);
    });
    undoBar.append(said, btn, bar);
    document.documentElement.appendChild(undoBar);
    requestAnimationFrame(() => undoBar && undoBar.classList.add("lct-del-in"));
    undoTimer = setTimeout(() => {
      if (undoBar) { undoBar.remove(); undoBar = null; }
    }, UNDO_MS);
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "lct-deletion-queued") show(msg);
      else if (msg.type === "lct-deletion-undo-offer") offerUndo(msg.token, msg.count || 1);
    });
  } catch (_) { /* no extension context in this frame */ }

  self.LCTDeletionToast = { show, offerUndo };
})();
