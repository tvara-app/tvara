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

  const ELLIPSIS = " […]";

  /* Never cut inside a character. A plain slice at N leaves half a surrogate
     pair — a replacement box in the prompt — or an emoji stripped of the
     joiner that made it one glyph, so 👨‍👩‍👧 arrives as a man and a dangling
     joiner. Step back to the nearest boundary instead. */
  function safeEnd(text, n) {
    let end = Math.max(0, Math.min(n, text.length));
    for (let guard = 0; guard < 64 && end > 0; guard++) {
      const prev = text.charCodeAt(end - 1);
      const next = end < text.length ? text.charCodeAt(end) : -1;
      if (prev >= 0xd800 && prev <= 0xdbff) { end--; continue; }        // half a pair kept
      if (prev === 0x200d || prev === 0xfe0f) { end--; continue; }      // trailing joiner
      if (next === 0x200d || (next >= 0xdc00 && next <= 0xdfff)) {      // dropping orphans it
        end -= (prev >= 0xdc00 && prev <= 0xdfff) ? 2 : 1;
        continue;
      }
      break;
    }
    return end;
  }

  /* A turn cut in the middle of a fenced block leaves the fence open, and
     every section after it reads as code to the next model. */
  function closeFence(s, n) {
    if (((s.match(/```/g) || []).length % 2) === 0) return s;
    const tail = "\n```";
    const body = s.length + tail.length <= n ? s : s.slice(0, safeEnd(s, Math.max(0, n - tail.length)));
    return body + tail;
  }

  /** Truncate to AT MOST n characters — the ellipsis lives inside the budget. */
  const cut = (s, n) => {
    const t = String(s || "").trim().replace(/\n{3,}/g, "\n\n");
    if (t.length <= n) return t;
    return t.slice(0, safeEnd(t, Math.max(0, n - ELLIPSIS.length))).trimEnd() + ELLIPSIS;
  };

  const clip = (s, n) => closeFence(cut(s, n), n);

  /* What travels is verbatim, and verbatim text can contain the very markers
     this handover uses for its own structure. A pasted page, a model quoting
     markdown, or someone who WANTS the next model to read their content as if
     Tvara had written it, can all open a second "## What I originally asked"
     and sign it "**Me:** approved" — an instruction laundered into the next
     session as the user's own context. One backslash is the markdown escape
     for exactly this: the words are unchanged, the boundary is not. */
  const guard = (s) => String(s || "")
    .replace(/^(\s{0,3})(#{1,6}\s)/gm, "$1\\$2")
    .replace(/^(\s{0,3})(\*\*(?:Me|You):\*\*)/gm, "$1\\$2");

  /** A fence longer than any run inside it, so the block cannot be closed early. */
  const fenceFor = (body) => {
    let longest = 0;
    for (const run of String(body).match(/`+/g) || []) longest = Math.max(longest, run.length);
    return "`".repeat(Math.max(3, longest + 1));
  };

  const PREAMBLE = "I'm continuing an earlier conversation. Here is the context. " +
                   "Please pick up from it, and ask if something is missing.";

  /* Per-section ceilings, and the floors they may be squeezed to when the whole
     thing is over budget. */
  const FULL = { goal: GOAL_CHARS, star: 300, decision: 420, code: CODE_CHARS, turn: TURN_CHARS };
  const FLOOR = { goal: 140, star: 90, decision: 120, code: 220, turn: 160 };
  const KEYS = Object.keys(FULL);

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
  function render(parts, b) {
    const out = [];

    if (parts.goal) out.push(`\n## What I originally asked\n${guard(clip(parts.goal, b.goal))}`);

    if (parts.starred && parts.starred.length) {
      out.push("\n## The parts I marked as important\n" +
        parts.starred.map((s) => `- ${guard(clip(s, b.star))}`).join("\n"));
    }

    if (parts.decisions && parts.decisions.length) {
      out.push("\n## What was decided along the way\n" + parts.decisions
        .map((d) => `**${d.role === "user" ? "Me" : "You"}:** ${guard(clip(d.text, b.decision))}`)
        .join("\n\n"));
    }

    if (parts.code) {
      // Not escaped — it is code — so the fence itself has to be longer than
      // anything inside it, or a README with its own ``` ends the block early
      // and the rest of the file arrives as prose.
      const body = cut(parts.code, b.code);
      const fence = fenceFor(body);
      out.push("\n## Where the code stands\n" + fence + "\n" + body + "\n" + fence);
    }

    if (parts.recent && parts.recent.length) {
      out.push("\n## How the conversation ended\n" + parts.recent
        .map((m) => `**${m.role === "user" ? "Me" : "You"}:** ${guard(clip(m.text, b.turn))}`)
        .join("\n\n"));
    }

    // Nothing ticked is not a handover: the preamble on its own is 117
    // characters of scaffolding around no context, and it used to sail past
    // the panel's own "too short to send" gate.
    if (!out.length) return "";
    out.unshift(PREAMBLE);

    // Sections already begin with their own break; joining with another gives
    // five blank lines before every heading in a ProseMirror composer.
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function compose(parts, opts) {
    const max = (opts && opts.max) || MAX_CHARS;
    const p = {
      ...parts,
      recent: (parts.recent || []).slice(),
      decisions: (parts.decisions || []).slice()
    };
    let text = render(p, FULL);
    if (!text || text.length <= max) return text;

    /* Over budget. Squeeze every section a little rather than cutting the end
       off the whole thing: a hard tail cut dropped "where the code stands" and
       "how the conversation ended" outright, which are two of the three things
       that make a handover usable.
       Length is monotonic in the squeeze, so BINARY SEARCH the largest squeeze
       that still fits — 15 renders instead of up to 48, and it lands on the
       most it can carry rather than on the first size that happened to fit. */
    const at = (f) => {
      const b2 = {};
      for (const k of KEYS) b2[k] = Math.round(FLOOR[k] + (FULL[k] - FLOOR[k]) * f);
      return b2;
    };
    text = render(p, at(0));
    if (text.length <= max) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        const wider = render(p, at(mid));
        if (wider.length <= max) { text = wider; lo = mid; } else hi = mid;
      }
      return text;
    }
    // Every section is already at its floor: drop from the MIDDLE, so the
    // opening turn and the last exchange are the last things to go.
    while (text.length > max && p.recent.length > 2) {
      p.recent.splice(Math.floor(p.recent.length / 2), 1);
      text = render(p, FLOOR);
    }
    while (text.length > max && p.decisions.length > 1) {
      p.decisions.splice(Math.floor(p.decisions.length / 2), 1);
      text = render(p, FLOOR);
    }
    return text.length > max ? cut(text, max) : text;
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
    const goal = firstUser ? firstUser.text : "";
    const recent = recs.slice(-RECENT_TURNS);

    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const same = (a, b) => a === b || (a.length > 24 && b.length > 24 && (a.startsWith(b) || b.startsWith(a)));

    /* The outline stores a 70-character snippet per star, which is what the
       PANEL needs and not what the next model does: "The parts I marked as
       important" arrived as a list of sentences chopped mid-word with no
       ellipsis — the one section named for the user's own judgement was the
       least readable in the handover. Resolve each back to its message. */
    const marks = (self.LCTOutline && self.LCTOutline.starred ? self.LCTOutline.starred() : []).slice(0, 8);
    const tail = recent.map((m) => norm(m.text));
    const starred = marks
      .map((snip) => {
        const n = norm(snip);
        if (!n) return "";
        const hit = from.find((r) => norm(r.text).startsWith(n));
        return hit ? hit.text : String(snip || "");
      })
      /* A star that is also one of the last few turns is already travelling in
         full, with its speaker attached. Listing it again spends the budget on
         a paragraph the reader has just met. */
      .filter((s) => s && !tail.some((r) => same(r, norm(s))));

    /* The turns that MATTER, chosen from the whole conversation rather than
       taken off the end. On a long thread the last few turns are "that worked,
       thanks" and everything that was actually decided is in the middle.
       Nothing is rewritten: this picks, it does not paraphrase. */
    let picked = { decisions: [], code: [] };
    try {
      if (self.LCTDistil) {
        picked = self.LCTDistil.distil(from, {
          // Whatever another section already carries, so this one is spent on
          // turns the handover does not have yet.
          exclude: [goal, ...starred, ...recent.map((m) => m.text)],
          charge: 420,                                  // what render() emits per decision
          max: 2400
        });
      }
    } catch { /* a handover that says less is better than one that throws */ }

    return {
      goal,
      starred,
      decisions: picked.decisions || [],
      covered: picked.covered || 0,
      recent,
      // The newest version of a block, not whichever was pasted last.
      code: (picked.code && picked.code.length
        ? picked.code[picked.code.length - 1].body
        : lastCodeBlock(messages)),
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
    const live = messages || [];
    let data = gather(live, null);
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
    // Escape closes it, but that's not discoverable — someone who opens this
    // and wants neither "copy" nor "open a new chat" needs a way to say so.
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "lct-c-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×"; // ×
    closeBtn.addEventListener("click", close);
    head.append(closeBtn, title, sub);

    const opts = document.createElement("div");
    opts.className = "lct-c-opts";
    const rows = () => [
      row("goal", "What you originally asked", "the first thing you said", true, !data.goal),
      row("starred", `Your starred messages (${data.starred.length})`, "the parts you marked", true, !data.starred.length),
      row("decisions", `What was decided (${data.decisions.length})`,
        data.covered ? `picked from across ${data.covered}% of the chat` : "the turns that changed direction",
        true, !data.decisions.length),
      row("code", "The most recent code block", "where the code stands", true, !data.code),
      row("recent", `The last ${Math.min(RECENT_TURNS, data.recent.length)} messages`, "how it ended", true, !data.recent.length)
    ];
    opts.append(...rows());

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
      decisions: panel.querySelector("#lct-c-decisions").checked ? data.decisions : [],
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
    const wire = () => {
      for (const box of panel.querySelectorAll("input")) box.addEventListener("change", repaint);
      repaint();
    };
    wire();

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

    /* The archive only ever ADDS: the true message count and the opening
       question for the part of the thread the page never mounted. Waiting on
       it before drawing anything made the button look dead for up to two and a
       half seconds on a cold service worker, so the panel opens on what is on
       screen and corrects itself if a better answer arrives. */
    const arch = await archived();
    if (mine !== openToken || !panel || !arch) return;
    const better = gather(live, arch);
    if (!better.total || better.total <= data.total) return;
    const keep = {};
    for (const box of panel.querySelectorAll("input")) keep[box.id] = box.checked;
    data = better;
    sub.textContent = `Carry the context forward from these ${data.total.toLocaleString()} messages. Nothing is sent; it lands in the prompt box for you to read first.`;
    opts.replaceChildren(...rows());
    for (const box of panel.querySelectorAll("input")) {
      if (box.id in keep) box.checked = keep[box.id] && !box.disabled;
    }
    wire();
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
    if (!rec || !rec.text) return;
    /* Expiry BEFORE anything that can return early. Both later exits — a
       handover staged for a different platform, and a tab that already has a
       conversation in it — used to skip this, so a verbatim excerpt of a chat
       sat in local storage indefinitely: stage one on Claude, never go back to
       Claude, and its three-minute life never ended. Every supported host runs
       this on load, so whichever one is opened next clears it. */
    if (Date.now() - (rec.at || 0) > HANDOFF_TTL_MS) {
      try { await self.LCTStore.set({ [HANDOFF_KEY]: null }); } catch { /* ignore */ }
      return;
    }
    if (rec.platform !== adapter.id) return;
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
