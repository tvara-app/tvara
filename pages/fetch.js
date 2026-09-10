/**
 * Tvara — choosing what message text to fetch.
 *
 * Its own page, not a panel on Total Recall. Recall is the SEARCH feature and
 * it is gated; deciding what the archive should hold is neither, and burying a
 * free control inside a paid page is how a thing that works comes to look like
 * a thing you have not bought.
 *
 * The list is built ONCE and edited afterwards. Rebuilding it on every tick —
 * which is what this did — throws away the row the pointer is over, the
 * checkbox that has focus and the reader's place in a list of a thousand
 * titles, and it moves everything below whatever was clicked. A checkbox is
 * the smallest interaction there is; it must not cost the page.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const M = self.LCTMotion;
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (reply) => { void chrome.runtime.lastError; res(reply); }); }
    catch { res(undefined); }
  });

  /* ---------- choosing what to fetch ----------
     The queue is per chat, so the choice is per chat. Providers are the outer
     level because that is the choice most people actually want; a provider
     opens into its own chats for the one who wants more. Nothing is preselected
     beyond "everything", which is what the popup's own button does — this panel
     exists to narrow it, not to make the common case take more clicks. */
  const pickState = { platforms: [], chosen: new Map(), open: new Set() };

  /* id -> the nodes already on the page for that provider. Holding them is what
     makes an edit an edit rather than a rebuild. */
  const built = new Map();

  /* What ticking the PROVIDER means. Where chats are still waiting it means
     those; where none are, it means the chats it holds — fetching them again,
     which is the only thing left to ask for and the reason the row is here. */
  const wholeOf = (p) => (p.total ? p.total : (p.chats ? p.chats.length : 0));

  function pickCount() {
    let n = 0;
    for (const p of pickState.platforms) {
      const sel = pickState.chosen.get(p.id);
      if (!sel) continue;
      n += sel === true ? wholeOf(p) : sel.size;
    }
    return n;
  }

  function selectedFor(p) {
    const sel = pickState.chosen.get(p.id);
    if (sel === true) return wholeOf(p);
    return sel ? sel.size : 0;
  }

  function paintPickActions() {
    const n = pickCount();
    const go = $("fill-pick-go");
    if (!go) return;
    go.disabled = n === 0;
    /* The number counts rather than jumps: ticking a provider with nine hundred
       chats in it should look like nine hundred arriving. The label is only
       rewritten when it actually changes, or the tween restarts on every tick. */
    const label = n ? `Add text to ${n.toLocaleString()} chats` : "Add text to selected chats";
    if (!n || !M) { if (go.textContent !== label) go.textContent = label; return; }
    M.number(go, "pick-total", n, (v) => `Add text to ${v.toLocaleString()} chats`);
  }

  /* ---------- one provider's row, made once ---------- */

  function countLabel(p) {
    /* A provider with nothing waiting is FINISHED, and saying so is the whole
       reason its row is here: leaving it off the list made a fetched provider
       look like one that was never archived. */
    const picked = selectedFor(p);
    const whole = wholeOf(p);
    if (picked && picked < whole) {
      return `${picked.toLocaleString()} of ${whole.toLocaleString()}`;
    }
    /* Nothing waiting is a STATE, not an absence: the provider is here, its
       chats are here, and they can be fetched again. Saying "all 29 fetched"
       and then refusing the row is what made five of six look broken. */
    if (!p.total) {
      return p.archived
        ? `all ${p.archived.toLocaleString()} fetched · re-fetch`
        : "nothing archived yet";
    }
    return `${p.total.toLocaleString()} waiting`;
  }

  function syncRow(p, node) {
    const picked = selectedFor(p);
    /* Dimmed, never disabled. A provider whose text is all here still has
       something to offer — fetching it again — and the only row that takes no
       input is one with no chats at all. */
    const empty = !wholeOf(p);
    node.row.classList.toggle("pick-done", !p.total && !empty);
    node.box.disabled = empty;
    node.open.hidden = empty;
    node.box.checked = picked > 0;
    // Some but not all: the box says so rather than lying in either direction.
    node.box.indeterminate = picked > 0 && picked < wholeOf(p);
    const label = countLabel(p);
    if (node.count.textContent !== label) {
      node.count.textContent = label;
      if (M) M.replay(node.count, "pick-count-swap");
    }
    const isOpen = pickState.open.has(p.id);
    node.open.textContent = isOpen ? "Hide chats" : "Choose chats";
    node.open.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (node.chats) node.chats.hidden = !isOpen;
    if (node.more) node.more.hidden = !isOpen;
    // Only the open provider's boxes can be out of date, and only it is walked.
    if (isOpen && node.chatBoxes) {
      const sel = pickState.chosen.get(p.id);
      for (const [id, cb] of node.chatBoxes) {
        const on = sel === true || (sel instanceof Set && sel.has(id));
        if (cb.checked !== on) cb.checked = on;
      }
    }
  }

  /** The chat list for one provider. Built on first open, kept afterwards. */
  function buildChats(p, node) {
    const list = document.createElement("div");
    list.className = "pick-chats";
    node.chatBoxes = new Map();
    const frag = document.createDocumentFragment();
    for (const chat of p.chats) {
      const line = document.createElement("label");
      line.className = "pick-chat";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", () => {
        // "All" becomes an explicit set the moment one chat is unticked, or
        // the choice could not say which one was dropped.
        let now = pickState.chosen.get(p.id);
        if (now === true) now = new Set(p.chats.map((c) => c.id));
        if (!(now instanceof Set)) now = new Set();
        if (cb.checked) now.add(chat.id); else now.delete(chat.id);
        if (now.size) pickState.chosen.set(p.id, now);
        else pickState.chosen.delete(p.id);
        syncRow(p, node);
        paintPickActions();
      });
      node.chatBoxes.set(chat.id, cb);
      const text = document.createElement("span");
      if (chat.title) text.textContent = chat.title;
      else { text.className = "untitled"; text.textContent = "Untitled chat"; }
      line.append(cb, text);
      /* Which of these still need their text, and which would be fetched
         again. Without it a list of a thousand titles says nothing about the
         only thing that separates them. */
      if (chat.held) {
        line.classList.add("pick-chat-held");
        const mark = document.createElement("span");
        mark.className = "pick-chat-mark";
        mark.textContent = "fetched";
        line.append(mark);
      }
      frag.append(line);
    }
    list.append(frag);
    node.chats = list;
    node.row.after(list);
    // Measured once, here, rather than on every scroll: whether this list is
    // taller than the box it lives in cannot change without a rebuild.
    if (list.scrollHeight > list.clientHeight + 1) list.classList.add("scrolls");

    /* The listing is capped, and a cap that is not stated is a lie about how
       much is there. Ticking the provider still takes all of them. */
    if (p.total > p.chats.length) {
      const more = document.createElement("p");
      more.className = "pick-more";
      more.textContent = `${(p.total - p.chats.length).toLocaleString()} more not listed here — ` +
        "tick the provider to include every one of them.";
      node.more = more;
      list.after(more);
    }
  }

  function buildRow(p, host) {
    const row = document.createElement("div");
    row.className = "pick-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "pick-" + p.id;

    const name = document.createElement("label");
    name.className = "pick-name";
    name.htmlFor = box.id;
    name.textContent = p.label;

    const count = document.createElement("span");
    count.className = "pick-count";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "pick-open";

    row.append(box, name, count, open);
    host.append(row);

    const node = { row, box, count, open, chats: null, more: null, chatBoxes: null };
    built.set(p.id, node);

    box.addEventListener("change", () => {
      /* A half-ticked box means "some of these". Clicking it reads as "make it
         all of them" — but the browser's own rule is that a checked box
         unchecks, so ticking three chats and then reaching for the provider
         threw the three away and left nothing selected. The prior selection is
         what decides, not the state the click just wrote. */
      const picked = selectedFor(p);
      const partial = picked > 0 && picked < wholeOf(p);
      if (partial || box.checked) pickState.chosen.set(p.id, true);
      else pickState.chosen.delete(p.id);
      syncRow(p, node);
      paintPickActions();
    });

    open.addEventListener("click", () => {
      const opening = !pickState.open.has(p.id);
      if (opening) pickState.open.add(p.id); else pickState.open.delete(p.id);
      /* Opening a provider pushes every provider under it down the page. FLIP
         measures first, lets the layout happen, then animates the difference
         away with transforms — the rows below travel to where they were going
         anyway instead of appearing there. */
      const movers = document.querySelectorAll(".pick-row, .pick-chats, .pick-more, .pick-actions");
      const change = () => {
        if (opening && !node.chats) buildChats(p, node);
        syncRow(p, node);
      };
      if (M) M.flip(movers, change); else change();
      if (opening && M && node.chats) {
        M.stagger(node.chats.querySelectorAll(".pick-chat"), "pick-chat-in", 14, 12);
      }
    });

    return node;
  }

  /* ---------- states the page can be in ---------- */

  function setStatus(text, kind) {
    const el = $("fill-pick-status");
    if (!el) return;
    el.className = "status-copy" + (kind ? " " + kind : "");
    if (el.textContent === text) return;
    el.textContent = text;
    if (M) M.replay(el, "swap-line");
  }

  /** Rows the reader can look at while the worker is counting. Reserved at the
   *  same geometry as a real row, so nothing moves when the answer lands. */
  function paintSkeleton() {
    const host = $("fill-picker-list");
    if (!host || host.dataset.state === "loading") return;
    host.dataset.state = "loading";
    host.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 4; i++) {
      const row = document.createElement("div");
      /* NOT .pick-row. A placeholder wearing the class that means "a provider
         you can choose" is counted as one by everything that asks how many
         there are. */
      row.className = "pick-skeleton";
      row.style.setProperty("--stagger", (i * 90) + "ms");
      row.append(document.createElement("span"), document.createElement("span"));
      frag.append(row);
    }
    host.append(frag);
  }

  function paintPicker() {
    const host = $("fill-picker-list");
    const panel = $("fill-picker");
    const empty = $("fill-picker-empty");
    if (!host || !panel) return;
    /* Every platform the archive holds, waiting or not — see fillQueue. The
       filter used to be `p.total > 0`, which is why five providers were missing
       from a list whose job is to say what is there. */
    const live = pickState.platforms;
    panel.hidden = false;
    /* Only when there is genuinely nothing to show. It used to appear whenever
       no chat was WAITING, so a list of 28 selectable chats sat directly above
       "nothing is waiting" — two statements about the same thing, one of them
       wrong. */
    if (empty) empty.hidden = live.length > 0;

    if (host.dataset.state !== "list") {
      host.dataset.state = "list";
      host.replaceChildren();
      built.clear();
    }

    // Providers that are no longer waiting on anything leave; the rest are
    // edited in place. Neither case rebuilds a row that is already right.
    const wanted = new Set(live.map((p) => p.id));
    for (const [id, node] of built) {
      if (wanted.has(id)) continue;
      node.row.remove();
      if (node.chats) node.chats.remove();
      if (node.more) node.more.remove();
      built.delete(id);
    }

    for (const p of live) {
      const node = built.get(p.id) || buildRow(p, host);
      syncRow(p, node);
    }
    if (M) M.stagger(host.querySelectorAll(".pick-row"), "pick-row-in", 40, 8);
    paintPickActions();
  }

  async function loadPicker() {
    paintSkeleton();
    const q = await send({ type: "archive-fill-queue" });
    /* Silence is not "nothing is waiting". A reclaimed worker answers nothing
       and this page used to read that as an empty queue — telling somebody with
       two thousand un-fetched chats that every one of them already had its
       text. Say which of the two it is. */
    if (!q || !Array.isArray(q.platforms)) {
      const host = $("fill-picker-list");
      if (host) { host.dataset.state = "error"; host.replaceChildren(); }
      const empty = $("fill-picker-empty");
      if (empty) empty.hidden = true;
      setStatus("The background worker did not answer, so there is nothing to show yet. " +
        "Reload this page in a moment.", "err");
      return;
    }
    setStatus("", "");
    pickState.platforms = q.platforms;
    paintPicker();
  }

  if ($("fill-picker")) {
    $("fill-pick-all").addEventListener("click", () => {
      for (const p of pickState.platforms) if (p.total) pickState.chosen.set(p.id, true);
      for (const p of pickState.platforms) {
        const node = built.get(p.id);
        if (node) syncRow(p, node);
      }
      paintPickActions();
    });
    $("fill-pick-none").addEventListener("click", () => {
      pickState.chosen.clear();
      for (const [id, node] of built) {
        const p = pickState.platforms.find((x) => x.id === id);
        if (p) syncRow(p, node);
      }
      paintPickActions();
    });
    $("fill-pick-go").addEventListener("click", async () => {
      const go = $("fill-pick-go");
      const pick = {};
      for (const [id, sel] of pickState.chosen) {
        if (sel !== true) { pick[id] = [...sel]; continue; }
        /* `null` means "everything still waiting", which is nothing at all for
           a provider that is finished — so name the chats instead. */
        const p = pickState.platforms.find((x) => x.id === id);
        pick[id] = p && !p.total ? (p.chats || []).map((c) => c.id) : null;
      }
      if (!Object.keys(pick).length) return;
      const asked = pickCount();
      go.disabled = true;
      go.classList.add("busy");
      setStatus("Starting…", "");
      try {
        const reply = await send({ type: "archive-fill-start", pick });
        if (reply && reply.err) throw new Error(String(reply.err));
        /* Say what happened, not what was asked for. A queue that was still
           unwinding a previous run took the choice and did nothing with it,
           and this line claimed otherwise. */
        if (reply && reply.how === "busy") {
          setStatus("The previous fetch is still finishing. Your choice is saved — " +
            "try again shortly.", "warn");
          go.disabled = false;
          return;
        }
        setStatus(`Adding message text to ${asked.toLocaleString()} chats. ` +
          "This continues with the page closed; the popup shows progress.", "ok");
      } catch {
        setStatus("Could not start. Reload the page and try again.", "err");
        go.disabled = false;
      } finally {
        go.classList.remove("busy");
      }
    });
    loadPicker();
  }
})();
