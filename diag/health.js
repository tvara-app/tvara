/**
 * Tvara — health check page.
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
        ? { cls: "idle", text: "no conversation open in this tab, open a chat and re-run" }
        : { cls: "bad", text: "a conversation is open but no messages were found" };
    }
    if (/DEGRADED/.test(h.selectors)) return { cls: "bad", text: "running on a fallback layer, this platform has changed" };
    if (/mixed/.test(h.selectors)) return { cls: "warn", text: "partly matching, worth a look" };
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
    title.textContent = (h && (h.platform || h.adapter)) || new URL(tab.url || "https://?").hostname;
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = v.text;
    head.append(title, pill);
    el.append(head);

    // "no answer" is nearly always one thing: the tab was open before the
    // extension was loaded or reloaded, and Chrome does not inject into tabs
    // that already exist. Telling someone to reload it is not as good as
    // reloading it, so offer the button and re-ask afterwards.
    if (!h) {
      const why = document.createElement("p");
      why.className = "consequence";
      why.textContent =
        "Chrome only injects into pages opened AFTER the extension was loaded. " +
        "A tab that predates the last reload has none of Tvara in it. " +
        "including the part that answers this page.";
      const fix = document.createElement("button");
      fix.className = "ghost fix";
      fix.type = "button";
      fix.textContent = "Reload that tab and check again";
      fix.addEventListener("click", async () => {
        fix.disabled = true;
        fix.textContent = "Reloading…";
        try {
          await chrome.tabs.reload(tab.id);
          // The content script mounts at document_idle; these sites take a
          // moment more to paint a conversation worth reporting on.
          await new Promise((r) => setTimeout(r, 3500));
        } catch { /* the re-run reports whatever is true now */ }
        run();
      });
      el.append(why, fix);
      return el;
    }

    if (v.cls !== "bad" || (h && typeof h.messages === "number" && h.roles)) {
      const yn = (x) => x === null ? "n/a" : x === "threw" ? "the lookup failed" : x ? "yes" : "no";
      el.append(
        row("messages seen", String(h.messages)),
        row("the provider's own count for this chat",
          typeof h.providerCount === "number"
            ? `${h.providerCount}${h.providerCount === h.messages ? " · agrees" : ` · we see ${h.messages}`}`
            : "this platform publishes no index"),
        row("elements matched, before empty turns were dropped",
          h.matched === undefined ? "n/a"
            : h.dropped ? `${h.matched} · ${h.dropped} dropped as unmounted placeholders`
            : String(h.matched)),
        row("matching the platform's own attributes", `${h.canonical} of ${h.messages}`),
        row("roles read", `${h.roles.user} yours · ${h.roles.assistant} the model's`),
        row("roles taken from the page itself",
          h.roleRead === null || h.roleRead === undefined
            ? "not available on this platform, inferred"
            : `${h.roleRead} of ${h.messages}`),
        row("where that role was found",
          h.roleFrom
            ? `${h.roleFrom.self} on the message · ${h.roleFrom.ancestor} on a wrapper · ` +
              `${h.roleFrom.descendant} inside it · ${h.roleFrom.none} nowhere`
            : "n/a"),
        row("distinct messages behind those elements",
          h.distinctIds ? `${h.distinctIds.distinct} ids for ${h.distinctIds.of} elements`
                        : "this platform assigns no ids"),
        row("counted twice (a message inside a message)", String(h.nested ?? 0)),
        row("what those elements contain",
          h.substance
            ? `${h.substance.real} text · ${h.substance.image || 0} image-only · ` +
              `${h.substance.tiny} near-empty · ${h.substance.empty} nothing at all` +
              (h.substance.sampled < h.messages ? ` (of the first ${h.substance.sampled})` : "")
            : "n/a"),
        row("elements the host is not rendering at all",
          h.substance ? String(h.substance.unrendered) : "n/a"),
        row("asleep right now", String(h.sleeping)),
        row("prompt box found", yn(h.composer)),
        row("scroll container found", yn(h.scroller)),
        row("speed engine", h.engine ? "running" : "off"),
        row("minimap", h.minimap ? "on screen" : "not drawn"),
        row("plan", h.plan),
        row("version", "v" + h.version)
      );
      // Two failures the headline verdict cannot see: the messages still match,
      // so the check says "primary", while the roles behind them are guesses or
      // the same turn is being counted twice.
      if (typeof h.roleRead === "number" && h.roleRead < h.messages) {
        const n = document.createElement("p");
        n.className = "consequence";
        n.textContent = `${h.messages - h.roleRead} message(s) had no role marker where we look for one, ` +
          "so their side of the conversation was guessed. The minimap, the outline and the " +
          "export all read that guess.";
        el.append(n);
      }
      /* The disagreement that settles every argument about a count. The DOM is
         whatever the host felt like rendering; the provider's index is what the
         conversation actually contains. */
      if (typeof h.providerCount === "number" && h.providerCount !== h.messages) {
        const n = document.createElement("p");
        n.className = "consequence";
        const extra = h.messages - h.providerCount;
        n.textContent = extra > 0
          ? `We are showing ${extra} more message(s) than the provider says this chat has. ` +
            "Those are the host's own empty blocks, and they should not be counted."
          : `The provider lists ${-extra} message(s) this page has not mounted yet. ` +
            "normal on a long chat that has only rendered its tail.";
        el.append(n);
      }

      // The shapes that were matched, in plain sight. When a count or a split
      // makes no sense, this is the line that says what the page is actually
      // made of — structural attributes only, no text and no ids.
      if (Array.isArray(h.shapes) && h.shapes.length) {
        const wrap = document.createElement("details");
        wrap.className = "shapes";
        const sum = document.createElement("summary");
        sum.textContent = "what was matched";
        wrap.append(sum);
        for (const [shape, n] of h.shapes) {
          const line = document.createElement("div");
          line.className = "shape";
          line.textContent = `${String(n).padStart(4, " ")} × ${shape}`;
          wrap.append(line);
        }
        el.append(wrap);
      }
      // An element with no text is not a message anyone can read. If a host
      // leaves placeholders behind for turns it has not mounted, every count we
      // show — the minimap, "N asleep", the outline — is counting ghosts.
      // Only genuine hollows are placeholders. An image-only turn is a message
      // someone actually sent, and calling it scaffolding was the report being
      // wrong about the user's own conversation.
      if (h.substance && h.substance.empty) {
        const n = document.createElement("p");
        n.className = "consequence";
        n.textContent = `${h.substance.empty} matched element(s) contain nothing at all. ` +
          "no text and no image. Those are the host's own unmounted turns, and they are not counted as messages.";
        el.append(n);
      }
      if (h.substance && h.substance.image) {
        const n = document.createElement("p");
        n.className = "consequence ok";
        n.textContent = `${h.substance.image} message(s) are an image with no caption. A pasted ` +
          "screenshot is still a message. They are counted, and the minimap and export name them by file.";
        el.append(n);
      }
      if (h.distinctIds && h.distinctIds.distinct < h.distinctIds.of) {
        const n = document.createElement("p");
        n.className = "consequence";
        n.textContent = `${h.distinctIds.of - h.distinctIds.distinct} element(s) repeat a message id another ` +
          "element already claimed. The same turn is being counted more than once, as siblings rather " +
          "than as one inside the other.";
        el.append(n);
      }
      if (h.nested) {
        const n = document.createElement("p");
        n.className = "consequence";
        n.textContent = `${h.nested} matched element(s) sit inside another matched element. ` +
          "this platform's turns are being counted more than once.";
        el.append(n);
      }
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

    let tabs;
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
      /* `h.roles` is absent whenever the content script replied `{error}` —
         which is precisely what a redesigned host produces, and precisely when
         this page is the one thing the user needs. verdict() has guarded that
         shape since it was written; this line did not, and threw, leaving Run
         disabled and Copy hidden on the report that mattered. */
      lines.push(h && h.roles
        ? `${h.adapter}: ${h.selectors}; ${h.messages} messages (${h.canonical} canonical), ` +
          `roles ${h.roles.user}/${h.roles.assistant}, asleep ${h.sleeping}, ` +
          `composer ${h.composer ? "y" : "n"}, scroller ${h.scroller ? "y" : "n"}, ` +
          `engine ${h.engine ? "on" : "off"}, path ${h.path}`
        : `${new URL(tab.url || "https://?").hostname}: ${h && h.error
            ? "the adapter threw: " + h.error
            : "no answer (content script not running, reload that tab)"}`);
    }

    lastReport = `Tvara health · v${(chrome.runtime.getManifest().version)}\n` +
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
      $("status").textContent = "Could not reach the clipboard. Select the cards and copy by hand.";
    }
  });

  run();
})();
