/**
 * Long Chat Toolkit — Context Bridge (Pro).
 *
 * The memory layer for all your AI tools. While composing a prompt in ANY
 * app, press ⌘⇧U / Ctrl+Shift+U: Recall searches your entire cross-platform
 * local archive, you pick the relevant passages, and it injects them into
 * your prompt — so the model you're already using answers WITH your
 * accumulated knowledge from every other tool.
 *
 * No servers, no API keys, no local model: it feeds context to the model the
 * user is already signed into. Extension network permissions remain ZERO.
 *
 * Fail-safe by design:
 *  - You pick passages before anything is inserted (no silent noise).
 *  - If the prompt box can't be found or injection doesn't take, it copies
 *    the context to the clipboard instead — the Bridge never breaks the page.
 */
(() => {
  "use strict";

  const MAX_PASSAGES = 6;

  let adapter = null;
  let unlocked = () => false;

  let panel = null, input = null, list = null, meta = null, insertBtn = null, note = null;
  let isOpen = false;
  let results = [];
  const chosen = new Set(); // indexes into results

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); }
    catch { res(null); }
  });

  /* ---------- composer read / inject ---------- */

  function composer() {
    try { return adapter.composer ? adapter.composer() : null; } catch { return null; }
  }

  function readDraft(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    return el.textContent || "";
  }

  // Prepend `text` into the prompt box, preserving the user's existing draft.
  // Returns true only if the box visibly received it.
  function injectInto(el, text) {
    if (!el) return false;
    try {
      el.focus();
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        const before = el.value || "";
        setter.call(el, text + before);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return (el.value || "").startsWith(text.slice(0, 24));
      }
      if (el.isContentEditable) {
        // caret to the very start, insert through the editor's own pipeline
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand("insertText", false, text);
        return ok || (el.textContent || "").includes(text.slice(0, 24));
      }
    } catch { /* fall through to clipboard */ }
    return false;
  }

  async function toClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { return false; }
  }

  /* ---------- context block formatting ---------- */

  function fmtWhen(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function buildBlock(picked) {
    const lines = ["Context from my earlier AI chats:"];
    for (const r of picked) {
      const when = fmtWhen(r.updatedAt);
      const tag = "[" + (r.platform || r.host) + (when ? " · " + when : "") + "]";
      lines.push(tag + " " + r.excerpt.replace(/\s+/g, " ").trim());
    }
    lines.push(""); // blank line before the user's own prompt
    lines.push("");
    return lines.join("\n");
  }

  /* ---------- panel ---------- */

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "lct-bridge";
    const head = document.createElement("div");
    head.className = "lct-b-head";
    input = document.createElement("input");
    input.type = "text";
    input.placeholder = "What do you need context on? (searches every past chat)";
    input.autocomplete = "off";
    input.spellcheck = false;
    meta = document.createElement("span");
    meta.className = "lct-b-meta";
    head.append(input, meta);
    list = document.createElement("div");
    list.className = "lct-b-list";
    const foot = document.createElement("div");
    foot.className = "lct-b-foot";
    insertBtn = document.createElement("button");
    insertBtn.className = "lct-b-insert";
    insertBtn.textContent = "Insert into prompt";
    insertBtn.disabled = true;
    insertBtn.addEventListener("click", doInsert);
    note = document.createElement("span");
    note.className = "lct-b-note";
    note.textContent = "Pick passages — they're added to your prompt, answered by the model you're already using.";
    foot.append(note, insertBtn);
    panel.append(head, list, foot);
    document.documentElement.appendChild(panel);

    input.addEventListener("input", debounced(runQuery, 200));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (!insertBtn.disabled) doInsert(); }
    });
    panel.addEventListener("mousedown", (e) => e.stopPropagation());
    document.addEventListener("mousedown", () => { if (isOpen) close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) { e.stopPropagation(); close(); }
    }, true);
  }

  function debounced(fn, ms) {
    let t = null;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function rowEl(r, i) {
    const row = document.createElement("label");
    row.className = "lct-b-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (chosen.size >= MAX_PASSAGES) { cb.checked = false; return; }
        chosen.add(i);
      } else chosen.delete(i);
      insertBtn.disabled = chosen.size === 0;
      insertBtn.textContent = chosen.size ? `Insert ${chosen.size} into prompt` : "Insert into prompt";
    });
    const body = document.createElement("div");
    body.className = "lct-b-body";
    const top = document.createElement("div");
    top.className = "lct-b-title";
    const badge = document.createElement("b");
    badge.textContent = r.platform || r.host;
    const title = document.createElement("span");
    title.textContent = r.title || "Untitled chat";
    top.append(badge, title);
    const ex = document.createElement("div");
    ex.className = "lct-b-ex";
    ex.textContent = r.excerpt; // archive data, never markup
    body.append(top, ex);
    row.append(cb, body);
    return row;
  }

  async function runQuery() {
    const q = input.value.trim();
    chosen.clear();
    insertBtn.disabled = true;
    insertBtn.textContent = "Insert into prompt";
    if (q.length < 2) { list.replaceChildren(); meta.textContent = ""; results = []; return; }
    const res = await send({ type: "recall-search", q, long: true });
    if (!res || res.err) { meta.textContent = "search unavailable"; return; }
    results = (res.results || []).slice(0, 40).map((r) => ({
      ...r, excerpt: (r.snippet || "").slice(0, 600)
    }));
    list.replaceChildren(...results.map(rowEl));
    meta.textContent = results.length
      ? `${results.length} chat${results.length === 1 ? "" : "s"}`
      : `nothing in ${res.scanned} archived chats`;
  }

  async function doInsert() {
    const picked = [...chosen].map((i) => results[i]).filter(Boolean);
    if (!picked.length) return;
    const box = composer();
    const block = buildBlock(picked);
    close();
    const injected = injectInto(box, block);
    if (injected) {
      flash(`Added ${picked.length} passage${picked.length === 1 ? "" : "s"} to your prompt.`);
    } else {
      const copied = await toClipboard(block);
      flash(copied
        ? "Couldn't reach the prompt box — context copied, just paste it."
        : "Couldn't insert — open your prompt box and try again.");
    }
  }

  /* ---------- toast ---------- */

  let toast = null, toastTimer = null;
  function flash(text) {
    if (!toast || !toast.isConnected) { // re-create if removed from the DOM
      toast = document.createElement("div");
      toast.id = "lct-b-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("lct-b-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("lct-b-toast-show"), 4000);
  }

  /* ---------- open / close ---------- */

  function open() {
    ensurePanel();
    // seed the search with whatever the user has already typed
    const draft = readDraft(composer()).trim();
    panel.classList.add("lct-b-open");
    isOpen = true;
    input.value = draft.slice(0, 200);
    input.focus();
    input.select();
    if (input.value.trim().length >= 2) runQuery();
    else { list.replaceChildren(); meta.textContent = ""; }
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("lct-b-open");
    isOpen = false;
    input.blur();
  }

  function onKey(e) {
    const k = (e.key || "").toLowerCase();
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "u") {
      if (!unlocked()) return; // locked: the popup sells the Bridge
      e.preventDefault();
      e.stopPropagation();
      isOpen ? close() : open();
    }
  }

  function init(theAdapter, isUnlocked) {
    adapter = theAdapter;
    unlocked = isUnlocked || (() => false);
    addEventListener("keydown", onKey, true);
  }

  self.LCTBridge = { init, open, close, get isOpen() { return isOpen; } };
})();
