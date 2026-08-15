/**
 * Long Chat Toolkit — health check page.
 *
 * Asks every open chat tab for a self-description and renders the answers.
 * Deliberately does not need the "tabs" permission: chrome.tabs.query returns
 * ids without it, and we already hold host permission for the sites we ask.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // The sites we run on, taken from the manifest rather than repeated here: a
  // second list is a list that goes stale the first time a platform is added.
  const MATCHES = (() => {
    try {
      const cs = chrome.runtime.getManifest().content_scripts || [];
      return [...new Set(cs.flatMap((c) => c.matches || []))];
    } catch { return []; }
  })();

  let lastReport = "";

  const ask = (tabId) => new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    // A tab that has not run our content script never answers; do not hang.
    setTimeout(() => finish(null), 3000);
    try {
      chrome.tabs.sendMessage(tabId, { type: "lct-health" }, (r) => {
        void chrome.runtime.lastError;
        finish(r || null);
      });
    } catch { finish(null); }
  });

  function verdict(h) {
    if (!h) return { cls: "bad", text: "no answer" };
    if (h.error) return { cls: "bad", text: "the adapter threw: " + h.error };
    // A shape we do not recognise is a bug in us, and saying so is better than
    // rendering half a card and throwing on the other half.
    if (typeof h.messages !== "number" || !h.roles) {
      return { cls: "bad", text: "unreadable report" };
    }
    if (!h.messages) {
      return h.inConversation === false
        ? { cls: "idle", text: "no conversation open in this tab — open a chat and re-run" }
        : { cls: "bad", text: "a conversation is open but no messages were found" };
    }
    if (/DEGRADED/.test(h.selectors)) return { cls: "bad", text: "running on a fallback layer — this platform has changed" };
    if (/mixed/.test(h.selectors)) return { cls: "warn", text: "partly matching — worth a look" };
    return { cls: "good", text: "matching this platform's own markup" };
  }

  function row(label, value) {
    const d = document.createElement("div");
    d.className = "kv";
    const k = document.createElement("span"); k.className = "k"; k.textContent = label;
    const v = document.createElement("span"); v.className = "v"; v.textContent = value;
    d.append(k, v);
    return d;
  }

  function card(tab, h) {
    const v = verdict(h);
    const el = document.createElement("section");
    el.className = "card " + v.cls;

    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("h2");
    title.textContent = (h && h.adapter) || new URL(tab.url || "https://?").hostname;
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = v.text;
    head.append(title, pill);
    el.append(head);

    if (v.cls !== "bad" || (h && typeof h.messages === "number" && h.roles)) {
      const yn = (x) => x === null ? "n/a" : x === "threw" ? "the lookup failed" : x ? "yes" : "no";
      el.append(
        row("messages seen", String(h.messages)),
        row("matching the platform's own attributes", `${h.canonical} of ${h.messages}`),
        row("roles read", `${h.roles.user} yours · ${h.roles.assistant} the model's`),
        row("asleep right now", String(h.sleeping)),
        row("prompt box found", yn(h.composer)),
        row("scroll container found", yn(h.scroller)),
        row("speed engine", h.engine ? "running" : "off"),
        row("minimap", h.minimap ? "on screen" : "not drawn"),
        row("plan", h.plan),
        row("version", "v" + h.version)
      );
      if (h.composer === false) {
        const n = document.createElement("p");
        n.className = "consequence";
        n.textContent = "Without the prompt box, Context Bridge falls back to the clipboard.";
        el.append(n);
      }
      if (h.scroller === false) {
        const n = document.createElement("p");
        n.className = "consequence";
        n.textContent = "Without the scroll container, resume and history loading stand down.";
        el.append(n);
      }
    }
    return el;
  }

  async function run() {
    $("run").disabled = true;
    $("status").textContent = "asking your open chat tabs…";
    $("out").replaceChildren();
    $("copy").hidden = true;

    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: MATCHES }); }
    catch { tabs = []; }

    if (!tabs.length) {
      $("status").textContent = "";
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No chat tabs are open. Open a conversation on ChatGPT, Claude, Gemini, DeepSeek, Grok or Perplexity, then run this again.";
      $("out").append(p);
      $("run").disabled = false;
      return;
    }

    const lines = [];
    for (const tab of tabs) {
      const h = await ask(tab.id);
      $("out").append(card(tab, h));
      lines.push(h
        ? `${h.adapter}: ${h.selectors}; ${h.messages} messages (${h.canonical} canonical), ` +
          `roles ${h.roles.user}/${h.roles.assistant}, asleep ${h.sleeping}, ` +
          `composer ${h.composer ? "y" : "n"}, scroller ${h.scroller ? "y" : "n"}, ` +
          `engine ${h.engine ? "on" : "off"}, path ${h.path}`
        : `${new URL(tab.url || "https://?").hostname}: no answer (content script not running — reload that tab)`);
    }

    lastReport = `Long Chat Toolkit health — v${(chrome.runtime.getManifest().version)}\n` +
      new Date().toISOString() + "\n" + lines.map((l) => "- " + l).join("\n");
    $("status").textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"} checked.`;
    $("copy").hidden = false;
    $("run").disabled = false;
  }

  $("run").addEventListener("click", run);
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(lastReport);
      $("copy").textContent = "Copied";
      setTimeout(() => ($("copy").textContent = "Copy report"), 1600);
    } catch {
      $("status").textContent = "Could not reach the clipboard — select the cards and copy by hand.";
    }
  });

  run();
})();
