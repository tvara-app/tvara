/**
 * Tvara — Continue in a new chat.
 *
 * The thing everyone does by hand, badly. A conversation gets long: it slows
 * down, or it runs into the model's context, or you hit your allowance and the
 * session ends. What people do next is scroll up, copy a few things they hope
 * are the important ones, open a new chat, and re-explain the project. The
 * copying is lossy, the re-explaining is slow, and both happen at the exact
 * moment you least want to break concentration.
 *
 * So: one button. It assembles a handover out of what this conversation
 * already told us — the goal it opened with, the messages you starred, the
 * last few turns, the most recent code — opens a fresh chat on the same
 * platform, and puts it in the prompt box. You read it before you send it;
 * nothing is sent for you.
 *
 * There is no summarising model here and there never will be: this extension
 * has no server and no API key, and a "summary" from a local heuristic would
 * be a paraphrase nobody asked for. Everything carried over is VERBATIM, and
 * the panel shows exactly what will travel.
 */
(() => {
  "use strict";

  const adapter = self.LCTAdapters.detect();
  if (!adapter) return;

  const HANDOFF_KEY = "lct-carry-v1";
  const HANDOFF_TTL_MS = 3 * 60 * 1000;   // a new tab that never opens is not a handoff
  const MAX_CHARS = 6000;                 // beyond this a prompt box starts to fight back
  const RECENT_TURNS = 6;
  const GOAL_CHARS = 700;
  const TURN_CHARS = 900;
  const CODE_CHARS = 1200;

  let panel = null;
  // Opening now waits on the archive, so a second click — or an Escape — while
  // that answer is in flight must not be overtaken by the first one's panel.
  let openToken = 0;

  /* ---------- what a fresh chat looks like on each host ---------- */

  const NEW_CHAT = {
    chatgpt: "https://chatgpt.com/",
    claude: "https://claude.ai/new",
    gemini: "https://gemini.google.com/app",
    deepseek: "https://chat.deepseek.com/",
    grok: "https://grok.com/",
    perplexity: "https://www.perplexity.ai/",
    synthetic: location.pathname          // the test page is its own new chat
  };

  const clip = (s, n) => {
    const t = String(s || "").trim().replace(/\n{3,}/g, "\n\n");
    return t.length <= n ? t : t.slice(0, n).trimEnd() + " […]";
  };

  /* ---------- assembly ----------
     Pure, and exported, because this is the part worth testing: what travels
     and what does not. */

  function collect(messages) {
    const recs = [];
    for (const el of messages) {
      let role = "assistant";
      try { role = adapter.role(el); } catch { /* default */ }
      let text = "";
      try { text = self.LCTExporter.elementToText(el); } catch { text = el.textContent || ""; }
      text = String(text || "").trim();
      if (text) recs.push({ role, text });
    }
    return recs;
  }

  function lastCodeBlock(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const pre = messages[i].querySelector && messages[i].querySelector("pre");
      if (pre) return (pre.textContent || "").trim();
    }
    return "";
  }

  /**
   * Build the handover text from parts the user chose.
   * @param {{goal?:string, starred?:string[], recent?:Array, code?:string}} parts
   */
  function compose(parts, opts) {
    const max = (opts && opts.max) || MAX_CHARS;
    const out = [];
    out.push("I'm continuing an earlier conversation. Here is the context. " +
             "please pick up from it, and ask if something is missing.");

    if (parts.goal) out.push(`\n## What I originally asked\n${clip(parts.goal, GOAL_CHARS)}`);

    if (parts.starred && parts.starred.length) {
      out.push("\n## The parts I marked as important\n" +
        parts.starred.map((s) => `- ${clip(s, 300)}`).join("\n"));
    }

    if (parts.code) out.push("\n## Where the code stands\n```\n" + clip(parts.code, CODE_CHARS) + "\n```");

    if (parts.recent && parts.recent.length) {
      out.push("\n## How the conversation ended\n" + parts.recent
        .map((m) => `**${m.role === "user" ? "Me" : "You"}:** ${clip(m.text, TURN_CHARS)}`)
        .join("\n\n"));
    }

    // Sections already begin with their own break; joining with another gives
    // five blank lines before every heading in a ProseMirror composer.
    let text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length <= max) return text;

    /* Over budget. Drop from the MIDDLE of the recent turns rather than
       truncating the end: the opening goal and the last exchange are the two
       things that make a handover usable, and a hard cut mid-sentence at the
       end loses the more important half. */
    const recent = (parts.recent || []).slice();
    while (recent.length > 2 && text.length > max) {
      recent.splice(Math.floor(recent.length / 2), 1);
      text = compose({ ...parts, recent }, { max: Infinity });
    }
    return text.length > max ? clip(text, max) : text;
  }

  const IMAGE_ONLY = /^(\[image:[^\]]*\]|\[image\]|\s)+$/;

  /* The page holds what the host mounted — on the 1,471-message thread this
     feature was built for, that is the last ~197 turns. "What I originally
     asked" taken from those is a mid-project follow-up handed to the next
     model as the opening question, and the panel offers to carry forward "197
     messages" for a conversation with 1,471. The archive knows better, and the
     exporter already asks it the same way. */
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

  function gather(messages, arch) {
    const recs = collect(messages);
    /* Only the opening goal and the message count come from the archive. The
       recent turns and the last code block must stay live: they are the newest
       part of the conversation and the part a background sync has not seen. */
    const deep = arch && Array.isArray(arch.msgs) && arch.msgs.length > recs.length
      ? arch.msgs.map((m) => ({ role: m.r === "user" ? "user" : "assistant", text: String(m.t || "") }))
      : null;
    /* "What you originally asked" has to be a QUESTION. On a real chat the
       first user turn was a pasted screenshot, so the handover opened with a
       file name and told the next model nothing. Take the first user message
       that actually says something, and fall back to the literal first only if
       there is nothing else. */
    const from = deep || recs;
    const firstUser = from.find((r) => r.role === "user" && !IMAGE_ONLY.test(r.text) && r.text.length > 12)
      || from.find((r) => r.role === "user");
    return {
      goal: firstUser ? firstUser.text : "",
      starred: (self.LCTOutline && self.LCTOutline.starred ? self.LCTOutline.starred() : []).slice(0, 8),
      recent: recs.slice(-RECENT_TURNS),
      code: lastCodeBlock(messages),
      total: (deep || recs).length
    };
  }

  /* ---------- the panel ---------- */

  function close() {
    openToken++;
    if (panel) { panel.remove(); panel = null; }
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (e.key === "Escape" && panel) { e.stopPropagation(); close(); }
  }

  function row(id, label, hint, checked, disabled) {
    const wrap = document.createElement("label");
    wrap.className = "lct-c-opt" + (disabled ? " lct-c-off" : "");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "lct-c-" + id;
    box.checked = checked && !disabled;
    box.disabled = !!disabled;
    const text = document.createElement("span");
    const strong = document.createElement("b");
    strong.textContent = label;
    const small = document.createElement("i");
    small.textContent = disabled ? "nothing to carry" : hint;
    text.append(strong, small);
    wrap.append(box, text);
    return wrap;
  }

  async function open(messages) {
    close();
    const mine = openToken;
    const arch = await archived();
    if (mine !== openToken) return;
    const data = gather(messages || [], arch);
    if (!data.total) return;

    panel = document.createElement("div");
    panel.id = "lct-carry";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Continue in a new chat");

    const head = document.createElement("div");
    head.className = "lct-c-head";
    const title = document.createElement("div");
    title.className = "lct-c-title";
    title.textContent = "Continue in a new chat";
    const sub = document.createElement("div");
    sub.className = "lct-c-sub";
    sub.textContent = `Carry the context forward from these ${data.total.toLocaleString()} messages. Nothing is sent; it lands in the prompt box for you to read first.`;
    head.append(title, sub);

    const opts = document.createElement("div");
    opts.className = "lct-c-opts";
    opts.append(
      row("goal", "What you originally asked", "the first thing you said", true, !data.goal),
      row("starred", `Your starred messages (${data.starred.length})`, "the parts you marked", true, !data.starred.length),
      row("code", "The most recent code block", "where the code stands", true, !data.code),
      row("recent", `The last ${Math.min(RECENT_TURNS, data.recent.length)} messages`, "how it ended", true, !data.recent.length)
    );

    const size = document.createElement("div");
    size.className = "lct-c-size";

    const foot = document.createElement("div");
    foot.className = "lct-c-foot";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "lct-c-ghost";
    preview.textContent = "Copy instead";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "lct-c-go";
    go.textContent = "Open a new chat";
    foot.append(size, preview, go);

    panel.append(head, opts, foot);
    document.documentElement.appendChild(panel);
    document.addEventListener("keydown", onKey, true);

    const chosen = () => ({
      goal: panel.querySelector("#lct-c-goal").checked ? data.goal : "",
      starred: panel.querySelector("#lct-c-starred").checked ? data.starred : [],
      code: panel.querySelector("#lct-c-code").checked ? data.code : "",
      recent: panel.querySelector("#lct-c-recent").checked ? data.recent : []
    });

    const repaint = () => {
      const text = compose(chosen());
      // Characters, not tokens: we cannot count tokens honestly without the
      // model's own tokenizer, and a made-up token number is exactly the kind
      // of confident wrong figure this project refuses to print.
      size.textContent = `${text.length.toLocaleString()} characters`;
      go.disabled = text.length < 40;
    };
    for (const box of panel.querySelectorAll("input")) box.addEventListener("change", repaint);
    repaint();

    preview.addEventListener("click", async () => {
      const ok = await self.LCTBridge.toClipboard(compose(chosen()));
      preview.textContent = ok ? "Copied" : "Couldn't copy";
      /* Close THIS panel, not whatever panel exists in 900ms. Reopening inside
         that window — which is exactly what someone does when they meant to
         open a new chat after all — had the old timer close the new panel, so
         the button appeared to do nothing. */
      const mine = panel;
      setTimeout(() => { if (panel === mine) close(); }, 900);
    });

    go.addEventListener("click", async () => {
      const text = compose(chosen());
      const url = NEW_CHAT[adapter.id];
      // The clipboard first, always: if the new tab cannot be reached — the
      // host redirects, the composer moves, the script is slow to mount —
      // the user still has the handover and one paste away from continuing.
      await self.LCTBridge.toClipboard(text);
      try {
        await self.LCTStore.set({
          [HANDOFF_KEY]: { platform: adapter.id, text, at: Date.now() }
        });
      } catch { /* storage gone: the clipboard copy still stands */ }
      close();
      if (url) window.open(url, "_blank", "noopener");
    });
  }

  /* ---------- delivery, in the new tab ---------- */

  /**
   * Runs on every page load. If a handover was staged for this platform in the
   * last few minutes and this looks like a fresh conversation, put it in the
   * prompt box and take it off the shelf.
   */
  async function deliver() {
    let rec = null;
    try {
      const got = await self.LCTStore.get([HANDOFF_KEY]);
      rec = got && got[HANDOFF_KEY];
    } catch { return; }
    if (!rec || rec.platform !== adapter.id || !rec.text) return;
    if (Date.now() - (rec.at || 0) > HANDOFF_TTL_MS) {
      try { await self.LCTStore.set({ [HANDOFF_KEY]: null }); } catch { /* ignore */ }
      return;
    }
    // Only into an EMPTY conversation. Dropping a handover into a chat already
    // in progress would be worse than not delivering it at all.
    let existing = [];
    try { existing = adapter.messages() || []; } catch { /* treat as empty */ }
    if (existing.length) return;

    // The composer is mounted late on every one of these hosts.
    const box = await waitForComposer(8000);
    // Claimed before insertion, so two tabs opening at once cannot both take it.
    try { await self.LCTStore.set({ [HANDOFF_KEY]: null }); } catch { /* ignore */ }
    if (!box) return;

    const ok = self.LCTBridge.injectInto(box, rec.text);
    if (self.LCTNote) {
      self.LCTNote(ok
        ? "Context carried over. Read it, then send when you're ready."
        : "Couldn't reach the prompt box. The context is on your clipboard, just paste it.");
    }
  }

  function waitForComposer(timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const box = self.LCTBridge.composer();
        if (box) return resolve(box);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  self.LCTCarry = { open, close, deliver, compose, gather, get isOpen() { return !!panel; } };
})();
