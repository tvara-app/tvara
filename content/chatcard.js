/**
 * Tvara — Chat Card.
 * Hover a conversation link in the site's sidebar → a small card shows what
 * we KNOW about that chat: message count, questions asked, stars, when it was
 * created (real time on ChatGPT via the app's own state) or first seen here,
 * last opened, and whether it's your longest visited chat on this site.
 *
 * Honesty rules:
 *  - We only know chats that were OPENED while the extension is installed —
 *    the platforms don't expose other chats' data in the page, and we have no
 *    network access to ask for it. Unknown chats say so, plainly.
 *  - "Created" is shown ONLY when the platform recorded it (ChatGPT exact
 *    times). Everywhere else the card says "First seen · this device".
 *  - "Longest" always means "longest of your visited chats", never "longest
 *    chat you have".
 */
(() => {
  "use strict";

  const SHOW_DELAY = 320;   // ms of steady hover before the card appears
  const WRITE_EVERY = 2000; // record-write throttle
  const MAX_RECORDS = 200;  // per host — oldest last-opened pruned beyond this

  let adapter = null;
  let store = null;
  let enabled = false;

  let records = {};         // pathname -> {c,u,f,o,e} (count, user msgs, firstSeen, lastOpened, earliestExact)
  let recordsLoaded = false;
  let card = null;
  let hoverTimer = null;
  let writeTimer = null;
  let latestMessages = null;
  let shownFor = null;      // pathname the visible card belongs to
  let lastRect = null;      // …and what it was drawn against, so it can redraw
  let lastName = "";
  let titleAnchor = null;   // anchor whose native title we've suppressed
  let savedTitle = null;

  const KEY = () => "chats:" + location.hostname;

  /* ---------- record keeping (always on: it's how the card knows anything) */

  async function loadRecords() {
    const { [KEY()]: r } = await store.get(KEY());
    records = r || {};
    recordsLoaded = true;
  }

  function update(messages) {
    latestMessages = messages;
    if (writeTimer) return;
    writeTimer = setTimeout(writeRecord, WRITE_EVERY);
  }

  /* The provider's own transcript for the open chat, when the background has
     fetched it. GROUND TRUTH, and the only thing here that is: everything else
     counts nodes the host has chosen to mount, and these hosts mount a tail.
     That is why a 400-message chat reported seven — not a counting bug, a
     question asked of the wrong source. */
  let seeded = null;          // { path, c, u }

  function seed(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    let users = 0;
    for (const e of entries) if (e && e.r === "user") users++;
    seeded = { path: location.pathname, c: entries.length, u: users };
    /* Schedule the write WITHOUT touching latestMessages. Going through
       update() passed `latestMessages || []`, which on a seed that arrives
       before the first DOM tick assigned the empty array — so a later flush for
       a different path found nothing to write. */
    if (!writeTimer) writeTimer = setTimeout(writeRecord, WRITE_EVERY);
  }

  async function writeRecord() {
    writeTimer = null;
    const msgs = Array.isArray(latestMessages) ? latestMessages : [];
    const path = location.pathname;
    const truth = seeded && seeded.path === path ? seeded : null;
    /* One message is a chat. The floor here was two, so a conversation somebody
       opened, asked once and left was never recorded at all — and then the card
       said "not tracked yet" about a chat they had plainly just been in. */
    if (!truth && !msgs.length) return;
    if (!recordsLoaded) await loadRecords();

    let count = msgs.length, users = 0;
    if (truth) {
      count = truth.c; users = truth.u;
    } else {
      /* Resolved for the whole list at once. Asked one element at a time, a
         host that paints no marker got a guess from the message's own text —
         which reads a prompt written as a numbered list as the model's answer.
         See resolveRoles(). */
      let roles;
      try { roles = self.LCTAdapters.resolveRoles(adapter, msgs); } catch { roles = []; }
      for (let i = 0; i < msgs.length; i++) if (roles[i] === "user") users++;
    }

    const prev = records[path];
    const now = Date.now();
    /* Never shrinks. Without the provider's transcript the count is whatever
       the host had mounted at that instant, and scrolling away unmounts it — so
       a chat that once read 120 would report 8 the next time it was opened. */
    if (!truth && prev && typeof prev.c === "number" && prev.c > count) {
      count = prev.c; users = Math.max(users, Number(prev.u) || 0);
    }
    records[path] = {
      c: count,
      u: users,
      f: prev ? prev.f : now,
      o: now,
      e: self.LCTTimeline.earliest() || (prev ? prev.e : 0) || 0
    };

    // prune: keep the MAX_RECORDS most recently opened
    const paths = Object.keys(records);
    if (paths.length > MAX_RECORDS) {
      paths.sort((a, b) => (records[a].o || 0) - (records[b].o || 0));
      for (const p of paths.slice(0, paths.length - MAX_RECORDS)) delete records[p];
    }
    store.set({ [KEY()]: records });
  }

  /* ---------- what the archive knows ----------
     The card used to know only what THIS browser had watched happen. A chat the
     archive holds in full still hovered as "Not tracked yet", and an opened one
     was counted off the mounted DOM — a tail on every one of these hosts. The
     archive has the provider's own transcript, with the provider's own roles,
     so it answers both. Cached per path, misses included, or hovering a
     genuinely unknown chat would ask the worker on every mouseover — but only
     for ARCHIVE_TTL, because a sync can land while the page stays open and a
     card that never re-asks would report the count from before it. */
  const archived = new Map();        // path -> stats | { found: false }

  const ARCHIVE_TTL = 60e3;          // a sync can land while the page is open

  /* The archive just gained the chat under the pointer. The answer cached
     below is now stale in the one direction that matters — it says "not
     tracked yet" about something that IS tracked — so drop it and draw again.
     Without this the card is only ever right on the NEXT hover, which is a
     strange thing to ask of somebody who is already looking at it. */
  document.addEventListener("lct-archived", (e) => {
    const path = e && e.detail && e.detail.path;
    if (!path) return;
    archived.delete(path);
    if (shownFor === path && lastRect) renderCard(path, lastRect, lastName);
  });

  function askArchive(path, then) {
    const held = archived.get(path);
    /* Answered already and still fresh. `then` is NOT called: its only job is
       to repaint a card drawn before the answer arrived, and calling it here
       re-entered renderCard, which asked again, which answered from this same
       cache — a card that recursed until the stack ran out the second time it
       was hovered. */
    if (held && !held.pending && Date.now() - held.at < ARCHIVE_TTL) return;
    if (held && held.pending) return;   // one request in flight per path
    /* A refresh keeps the answer it is refreshing. Replaced outright, the card
       fell back to the page's own counts for as long as the round trip took and
       then jumped back — a number that visibly changes twice on one hover reads
       as a bug whichever of the two is right. */
    archived.set(path, held && held.found
      ? { ...held, pending: true }
      : { found: false, pending: true, at: Date.now() });
    try {
      chrome.runtime.sendMessage(
        { type: "chat-stats", host: location.hostname, path },
        (res) => {
          /* A worker that never answered must not leave "not in the archive"
             cached for the life of the page — drop the entry so the next hover
             asks again. */
          if (chrome.runtime.lastError || !res || typeof res !== "object") {
            archived.delete(path);
            return;
          }
          const got = { ...res, at: Date.now() };
          archived.set(path, got);
          then(got);
        }
      );
    } catch { archived.delete(path); }
  }

  /* One record for the card to read, best source first: the archive's counts
     beat anything read off the page, and the locally observed dates beat the
     archive's, which only knows when IT last wrote. */
  function viewFor(path) {
    const rec = records[path] || null;
    const arc = archived.get(path);
    // `pending` is not checked: a refresh in flight still carries its last
    // answer, and that answer is better than the page's tail.
    if (!arc || !arc.found) return rec;
    /* A record with no messages is a TITLE the sync brought back, not a chat
       with nothing in it. Reporting "0 messages" about a real conversation is
       worse than reporting nothing, so the counts stay null and the card falls
       into the state it already has for this: real dates, unknown size, and a
       footer saying to open it once. */
    const known = Number(arc.n) > 0;
    /* The archive is the truthful source but not always the CURRENT one: the
       chat on screen can be several messages ahead of the last sync. Whichever
       knows about more messages wins, and the role split travels with it —
       taking counts from one and the split from the other is how a card reports
       nine messages of which eleven were yours. */
    const local = rec && typeof rec.c === "number" ? rec : null;
    if (known && local && local.c > arc.n) return local;
    /* The record can claim more messages than it HOLDS — capped at the archive's
       per-chat ceiling, or counted from the provider's listing before the body
       landed. The split is only ever of what is here, so it is reported against
       that number and never against `c`; "You asked 40" under "Messages 1,471"
       is not a rounding error to the person reading it. */
    const held = Number(arc.held);
    const split = Number.isFinite(held) && held > 0 ? held : 0;
    return {
      c: known ? arc.n : null,
      u: known ? arc.users : 0,
      a: known ? arc.assistants : 0,
      split,
      ti: String(arc.title || ""),
      topN: Number(arc.topN) || 0,
      hostChats: Number(arc.hostChats) || 0,
      f: rec ? rec.f : 0,
      o: rec ? rec.o : 0,
      // rec.e is seconds (the render multiplies); the archive keeps ms.
      e: (rec && rec.e) || (arc.createdAt ? Math.round(arc.createdAt / 1000) : 0),
      lastSaved: arc.updatedAt || 0,
      fromArchive: true
    };
  }

  /* ---------- the card ---------- */

  const DASH = "\u2014"; // stands in for every value we genuinely do not have

  // Glanceable date for the value column: "today", "yesterday", "3 Aug",
  // "3 Aug 2025". The column is narrow — a clock time would not fit.
  function shortDate(ms) {
    const d = new Date(ms);
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= midnight) return "today";
    if (ms >= midnight - 864e5) return "yesterday";
    const opts = { day: "numeric", month: "short" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function ensureCard() {
    if (card) return;
    card = document.createElement("div");
    card.id = "lct-chatcard";
    document.documentElement.appendChild(card);
  }

  function line(text, cls) {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text; // records are data, never markup
    return div;
  }

  function row(label, value, empty) {
    const r = document.createElement("div");
    r.className = "lct-cc-row";
    const k = document.createElement("div");
    k.className = "lct-cc-k";
    k.textContent = label;
    const v = document.createElement("div");
    v.className = "lct-cc-v" + (empty ? " lct-cc-v-empty" : "");
    v.textContent = value; // records are data, never markup
    r.append(k, v);
    return r;
  }

  function hideCard() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    shownFor = null;
    if (card) card.style.display = "none";
    restoreTitle();
  }

  // Sites often put the full (untruncated) name in a native `title` attribute
  // for accessibility. Left alone, the browser's own tooltip pops up on top
  // of our card (native tooltips paint above all page content, unstylable)
  // and visually collides with it. Suppress it for as long as our card owns
  // this anchor, then restore it so accessibility isn't affected otherwise.
  function suppressTitle(anchor) {
    if (anchor === titleAnchor) return;
    restoreTitle();
    if (anchor && anchor.hasAttribute("title")) {
      savedTitle = anchor.getAttribute("title");
      anchor.removeAttribute("title");
      titleAnchor = anchor;
    }
  }

  function restoreTitle() {
    if (titleAnchor && savedTitle != null) titleAnchor.setAttribute("title", savedTitle);
    titleAnchor = null;
    savedTitle = null;
  }

  /* Takes the size it is comparing, because the card's size no longer has to
     come from `records`. Read as `records[path].c`, a chat known only to the
     archive — which is now most of them — threw on the undefined record and
     took the whole card render down with it. */
  /* Measured against the ARCHIVE when the archive answered, and only against
     this browser's own records when it did not.
     Compared to `records` alone, the superlative was a claim about a handful of
     chats this browser had watched, counted off whatever the host had mounted
     at the time — which is how a seven-message reading was announced as the
     longest chat on ChatGPT next to conversations of two hundred. Mixing the
     two is worse still: an archive count beats every DOM count by construction,
     so every archive-backed card would win the badge. */
  function isLongest(path, mine, view) {
    if (mine == null) return false;
    /* Both sources, because the reader has one archive and one browser and the
       badge is a claim about their chats, not about whichever store answered.
       Taking only `records` made it a claim about the handful this browser had
       watched, counted off whatever the host had mounted — which is how a
       seven-message reading was announced as the longest chat on ChatGPT.
       Taking only the archive dropped the badge entirely for a chat the archive
       happens to be the sole record of. */
    let top = 0, population = 0;
    for (const p of Object.keys(records)) {
      const c = records[p] && records[p].c;
      if (typeof c !== "number") continue;
      population++;
      if (p !== path && c > top) top = c;
    }
    if (view && view.fromArchive) {
      // topN covers this host INCLUDING this chat, so `mine >= top` is exactly
      // "nothing on this host is bigger".
      top = Math.max(top, Number(view.topN) || 0);
      population = Math.max(population, Number(view.hostChats) || 0);
    }
    if (!records[path]) population++;   // the chat itself is one of the sizes
    // "longest of 1" is meaningless.
    if (population < 2) return false;
    return mine >= top;
  }


  function renderCard(path, anchorRect, name) {
    ensureCard();
    card.replaceChildren();
    /* Fired before the first paint so a card that opens on an unknown chat is
       corrected the moment the worker answers, rather than sitting on "not
       tracked" until the next hover. */
    askArchive(path, (got) => {
      if (shownFor !== path) return;
      /* NOT in the archive, and this card is open, which is as much intent as
         anybody ever gives us. Fetch the transcript for it.

         The backfill works newest-first and is deliberately slow, so a chat
         from three months ago has not been reached and will not be for hours —
         yet it is one request away, and the reader is looking at the card right
         now. prefetch() owns the dwell and the per-minute cap, so hovering down
         a long sidebar still cannot turn into a burst, and warm() dedupes per
         conversation so this and the hover path are never two requests.

         The lct-archived listener above redraws this same card when it lands. */
      if (!got || !got.found) {
        try { self.LCTHistoryLoader.prefetch(path); } catch (_) { /* loader not up */ }
        return;
      }
      renderCard(path, anchorRect, name);
    });
    const rec = viewFor(path);

    /* The archive's title beats the anchor's text: the sidebar clips its labels
       and some hosts render the clipped form into the DOM, so the card was
       headed with an ellipsis for a chat whose full name it had on disk. */
    card.appendChild(line((rec && rec.ti) || name || "This chat", "lct-cc-name"));

    if (!rec) {
      // Nothing known. Every field says so rather than inventing a number.
      card.appendChild(row("Messages", DASH, true));
      card.appendChild(row("You asked", DASH, true));
      card.appendChild(row("Starred", DASH, true));
      card.appendChild(row("Created", DASH, true));
      card.appendChild(row("Last opened", "not tracked yet", true));
      card.appendChild(line(
        "Not tracked yet. Open this chat once and Tvara will remember its size and dates.",
        "lct-cc-foot"
      ));
    } else {
      const synced = rec.c == null; // history-sync meta: real dates, size unknown
      card.appendChild(row("Messages", synced ? DASH : rec.c.toLocaleString(), synced));
      /* Both halves, always. "You asked 3" alone left the other side to be done
         in the reader's head against a total that does not always describe the
         same set of messages — and when the split came from a record capped
         below its own count, that subtraction was wrong. */
      const split = Number(rec.split) || 0;
      const partial = !synced && split > 0 && split < rec.c;
      const users = Number(rec.u) || 0;
      const bots = rec.a != null ? Number(rec.a) || 0 : Math.max(0, (split || rec.c) - users);
      const suffix = partial ? " of " + split.toLocaleString() : "";
      card.appendChild(row("You asked", synced ? DASH : users.toLocaleString() + suffix, synced));
      card.appendChild(row("Replies", synced ? DASH : bots.toLocaleString() + suffix, synced));

      // stars live under their own per-conversation key — the row is placed
      // now (so nothing below it jumps) and filled when the read lands
      const starRow = row("Starred", DASH, true);
      card.appendChild(starRow);
      const starKey = "stars:" + location.hostname + path;
      store.get(starKey).then((res) => {
        const stars = res[starKey];
        const n = stars ? Object.keys(stars).length : 0;
        if (shownFor !== path || !starRow.isConnected) return;
        const v = starRow.lastChild;
        v.textContent = n ? n.toLocaleString() : "0";
        v.className = "lct-cc-v" + (n ? " lct-cc-v-star" : " lct-cc-v-empty");
      });

      if (rec.e) card.appendChild(row("Created", shortDate(rec.e * 1000)));
      else if (rec.f) card.appendChild(row("First seen", shortDate(rec.f)));
      else card.appendChild(row("Created", DASH, true));
      /* "Last opened" is a claim about the READER, and the archive cannot make
         it — it knows when it last wrote the chat down, which is a different
         fact. A chat this browser has never opened says the true one. */
      if (rec.o) card.appendChild(row("Last opened", shortDate(rec.o)));
      else if (rec.lastSaved) card.appendChild(row("Last saved", shortDate(rec.lastSaved)));
      else card.appendChild(row("Last opened", "not tracked yet", true));

      if (synced) {
        card.appendChild(line("Synced from your history. Open once for message counts.", "lct-cc-foot"));
      } else if (rec.fromArchive && !rec.o) {
        card.appendChild(line("Counted from your archive \u2014 this browser has not opened it.", "lct-cc-foot"));
      } else if (!rec.e) {
        card.appendChild(line("First seen is when this device met the chat, not when you started it.", "lct-cc-foot"));
      }
      if (!synced && isLongest(path, rec.c, rec)) {
        card.appendChild(line("Your longest visited chat on " + adapter.label, "lct-cc-badge"));
      }
    }

    // position beside the link, clamped to the viewport
    card.style.display = "block";
    card.style.visibility = "hidden";
    card.style.left = "0px";
    card.style.top = "0px";
    const w = card.offsetWidth, h = card.offsetHeight;
    let left = anchorRect.right + 10;
    if (left + w > innerWidth - 8) left = Math.max(8, anchorRect.left - w - 10);
    let top = anchorRect.top;
    if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
    card.style.left = left + "px";
    card.style.top = top + "px";
    card.style.visibility = "visible";
    shownFor = path;
    // Kept so the lct-archived listener above can redraw the same card.
    lastRect = anchorRect;
    lastName = name;
  }

  /* ---------- hover detection (event delegation — no sidebar selectors) */

  function convPathOf(node) {
    // closest same-origin <a> whose pathname looks like a conversation URL.
    // href-shape matching survives site redesigns far better than classnames.
    const a = node && node.closest ? node.closest("a[href]") : null;
    if (!a) return null;
    if (a.closest('[id^="lct-"]')) return null; // never our own UI
    let url;
    try { url = new URL(a.href, location.href); } catch { return null; }
    if (url.origin !== location.origin) return null;
    if (!adapter.convPath || !adapter.convPath.test(url.pathname)) return null;
    return url.pathname;
  }

  /* Gemini's history rows are not links and carry no id, so there is no path to
     ask about. The row's own text is the only handle; the worker answers only
     when exactly one archived chat on this host has that title. */
  const titlePaths = new Map();   // row text -> archived path ("" = no match)

  function sidebarRowOf(node) {
    if (!node || !node.closest) return null;
    if (node.closest('[id^="lct-"]')) return null;
    if (!node.closest("nav, aside, [role='navigation']")) return null;
    for (let el = node, i = 0; el && i < 5; el = el.parentElement, i++) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length >= 3 && t.length <= 120) return { el, title: t };
    }
    return null;
  }

  function onOver(e) {
    if (!enabled) return;
    const path = convPathOf(e.target);
    if (!path) {
      const row = sidebarRowOf(e.target);
      const known = row ? titlePaths.get(row.title) : "";
      // Hide FIRST, as before this fallback existed: a hover that resolves to
      // nothing must drop the open card immediately, not hold it while we ask.
      if (shownFor && known !== shownFor) hideCard();
      if (!row || known === "") return;
      if (known) { showFor(known, row.el, row.title); return; }
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        try {
          chrome.runtime.sendMessage(
            { type: "chat-stats-by-title", host: location.hostname, title: row.title },
            (res) => {
              if (chrome.runtime.lastError) return;
              const p = (res && res.path) || "";
              titlePaths.set(row.title, p);
              if (p) showFor(p, row.el, row.title);
            }
          );
        } catch (_) { /* context gone */ }
      }, SHOW_DELAY);
      return;
    }
    showFor(path, e.target.closest("a[href]"));
  }

  function showFor(path, anchorEl, nameOverride) {
    if (path === shownFor) return;
    clearTimeout(hoverTimer);
    /* The same hover, spent twice. This card is one reason to resolve a
       conversation link under the pointer; the other is that somebody is about
       to click it, and the transcript they will need is one request away. Doing
       it now makes that click a local database read instead of a round trip.
       The loader owns the dwell and the cap — see prefetch(). */
    try { self.LCTHistoryLoader.prefetch(path); } catch (_) { /* loader not up */ }
    const anchor = anchorEl;
    if (!anchor) return;
    suppressTitle(anchor);
    const rect = anchor.getBoundingClientRect();
    // prefer the native title (untruncated) over the visibly clipped label
    const name = (nameOverride ||
      (savedTitle != null && titleAnchor === anchor ? savedTitle : anchor.textContent || ""))
      .replace(/\s+/g, " ").trim().slice(0, 80);
    hoverTimer = setTimeout(async () => {
      if (!recordsLoaded) await loadRecords();
      renderCard(path, rect, name);
    }, SHOW_DELAY);
  }

  function init(theAdapter, theStore) {
    adapter = theAdapter;
    store = theStore;
    document.addEventListener("mouseover", onOver, { passive: true });
    addEventListener("scroll", hideCard, { passive: true, capture: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCard(); }, true);
    // another tab may update records for this host — stay fresh
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes[KEY()]) records = changes[KEY()].newValue || {};
      });
    } catch { /* storage API unavailable — records just stay session-local */ }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!on) hideCard();
  }

  self.LCTChatCard = { init, update, seed, setEnabled };
})();
